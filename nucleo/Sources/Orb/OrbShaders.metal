//
//  OrbShaders.metal
//  Bottega Nucleo
//
//  Port of Melissa's voice orb (Avo Agency AI, VoiceOrbShaders.metal): a raymarched
//  living plasma sun with a volumetric core, a GPU spark field and a multi-scale bloom.
//  Dropped for the desktop panel: the voice-control slider chrome, the mood backdrop and
//  the place photo. Added: state 4 = error, tinted sodium amber.
//
//  States: 0 idle (aqua), 1 listening (teal), 2 thinking (violet), 3 speaking (spring
//  green), 4 error (sodium amber). Cross-faded with stateMix.
//
//  Uniforms mirror OrbUniforms in OrbRenderer.swift:
//    p0 = (resolution.x, resolution.y, time, level)
//    p1 = (state, prevState, stateMix, loudness)        loudness is spring-smoothed
//    p2 = (onset, cinematic 0/1, impulse, reveal 0..1)
//    p3 = (lightDir.xyz, warmth)
//    p4 = (ambientColor.rgb, nightFactor)
//    p5 = (zoom, docked, breath phase, 1 if the phase is set)   docked mini orb: zoom 0.6,
//         the sphere fills ~78% of the view; the breath phase comes from MetalEngine (it
//         speeds up with the Claude sessions at work)
//    spectrum[4] = 16 audio bands (0..1), low to high
//    p6 = (code, rhombus, star weights, tint)           who speaks (OrbAspetto.swift): code = Elliot's
//    p7 = (character colour rgb, agitation)             falling code, rhombus = Krista's Rorschach blot,
//    p8 = (0, colour light, 0, 0)                       star = Darlene's neon core and rings (the names
//                                                       are the file keys); tint 0.85 for a character,
//                                                       0 for Melissa
//    p9 = (phase, eclipse, harvest, halo ring)          Moony's mood (OrbMolla.luna, from UmoreLuna): 0 = silver
//    p10 = (still, listening, thinking, speaking)       Reduce motion and the voice states, eased (renderer)
//  With all three shape weights at 0 the sphere is Moony's moon (moony_*, October 2026): the
//  same super moon Avo draws (VoiceOrbShaders.metal, p7/p8 there are p9/p10 here), with the
//  mood choosing which moon it is tonight and the voice state moving its light. The
//  characters, and every effect around the disc, stay as they were.
//  Output is LINEAR EXTENDED for an EDR rgba16Float target, premultiplied alpha.
//

#include <metal_stdlib>
using namespace metal;

constant int   ORB_BANDS = 16;
constant float ORB_NOISE_INV = 1.0 / 64.0;

struct OrbUniforms {
    float4 p0;
    float4 p1;
    float4 p2;
    float4 p3;
    float4 p4;
    float4 p5;            // (zoom, docked 0/1, breath phase, phase set 0/1): zoom < 1 makes the sphere fill more of the view
    float4 spectrum[4];
    float4 p6;            // (code, rhombus, star, tint)
    float4 p7;            // (colour rgb, agitation)
    float4 p8;            // (0, light, 0, 0)
    float4 p9;            // (phase, eclipse, harvest, halo ring): Moony's mood, 0 = the silver moon
    float4 p10;           // (still, listening, thinking, speaking): Reduce motion and the eased voice states
};

struct OrbVSOut { float4 pos [[position]]; float2 uv; };

vertex OrbVSOut orb_vertex(uint vid [[vertex_id]]) {
    float2 p = float2((vid << 1) & 2, vid & 2);
    OrbVSOut o;
    o.pos = float4(p * 2.0 - 1.0, 0.0, 1.0);
    o.uv  = p;
    return o;
}

// ---------------------------------------------------------------------------
// noise
// ---------------------------------------------------------------------------
static inline float orb_vnoise3(float3 x, texture3d<float> tex, sampler s) {
    return tex.sample(s, x * ORB_NOISE_INV).r;
}

static inline float orb_fbm3(float3 p, texture3d<float> tex, sampler s) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * orb_vnoise3(p, tex, s); p *= 2.02; a *= 0.5; }
    return v;
}

static inline float orb_hash21(float2 p) {
    p = fract(p * float2(127.31, 311.7));
    p += dot(p, p + 34.12);
    return fract(p.x * p.y);
}

static inline float3 orb_rotY(float3 p, float a) {
    float s = sin(a), c = cos(a);
    return float3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}

struct OrbDrive {
    float time;
    float baseR;
    float amp;
    float swirl;
    float bass;
    float mid;
    float flowSign;
    float reveal;
    // the characters' weights (the sphere is what is left; the code is a sphere): rhombus = Krista, star = Darlene
    float romb;
    float star;
    float onde;   // how much the voice waves bend the surface: 1 for everyone, half on Moony's moon
};

static inline float orb_displacement(float3 dir, OrbDrive d, texture3d<float> tex, sampler s) {
    float3 sp = orb_rotY(dir, d.time * d.swirl);
    float3 q  = sp * 2.0 + d.flowSign * d.time * 0.18;
    float warp = orb_fbm3(q * 0.7 + d.time * 0.10, tex, s);
    float n    = orb_fbm3(q + warp, tex, s);
    float h    = (n - 0.5) * 2.0 * d.amp;
    float theta = acos(clamp(dir.y, -1.0, 1.0));
    float phi   = atan2(dir.z, dir.x);
    float wave  = d.flowSign * d.time * 1.6;
    h += d.bass * 0.11 * d.onde * sin(3.0 * phi + wave)                 * sin(2.0 * theta);
    h += d.mid  * 0.06 * d.onde * sin(6.0 * phi - wave * 1.3 + n * 4.0) * sin(4.0 * theta);
    return h * d.reveal;
}

static inline float orb_map(float3 pos, OrbDrive d, texture3d<float> tex, sampler s) {
    float3 dir = normalize(pos + float3(1e-5));
    float disp = orb_displacement(dir, d, tex, s);
    float ball = length(pos) - (d.baseR + disp);
    // Avo (VoiceOrbShaders.metal, orb_map): Elliot stays a sphere with the code drawn on top. Krista has no body:
    // the sphere shrinks almost to nothing and the Rorschach blot is drawn over it. Darlene is a smooth core at
    // 0.60R, with no displacement, so the neon rim drawn over it sits right on its edge.
    float w = d.romb + d.star;
    if (w < 0.002) return ball;                      // Melissa (and Elliot): the usual sphere, same cost
    float R = d.baseR;
    float shrunk = length(pos) - R * 0.02;
    float core = length(pos) - R * 0.60;
    return ball * (1.0 - w) + shrunk * d.romb + core * d.star;
}

static inline float3 orb_normal(float3 pos, OrbDrive d, texture3d<float> tex, sampler s) {
    const float e = 0.012;
    float2 k = float2(1.0, -1.0);
    return normalize(
        k.xyy * orb_map(pos + k.xyy * e, d, tex, s) +
        k.yyx * orb_map(pos + k.yyx * e, d, tex, s) +
        k.yxy * orb_map(pos + k.yxy * e, d, tex, s) +
        k.xxx * orb_map(pos + k.xxx * e, d, tex, s));
}

static inline float orb_band(constant OrbUniforms& u, int i) {
    return u.spectrum[i >> 2][i & 3];
}

// Melissa's palette, plus the error amber.
static inline float3 orb_palette(int state) {
    float3 aqua   = float3(0.26, 0.74, 1.00);   // idle / base
    float3 teal   = float3(0.16, 0.86, 0.86);   // listening
    float3 violet = float3(0.60, 0.38, 0.98);   // thinking
    float3 green  = float3(0.42, 0.88, 0.52);   // speaking
    float3 amber  = float3(0.96, 0.67, 0.24);   // error (sodium lamp)
    if (state == 1) return mix(aqua, teal, 0.60);
    if (state == 2) return mix(aqua, violet, 0.55);
    if (state == 3) return mix(green, aqua, 0.30);
    if (state == 4) return amber;
    return aqua;
}

static inline float3 orb_hueRotate(float3 c, float a) {
    const float3 k = float3(0.57735027);
    float ca = cos(a), sa = sin(a);
    return c * ca + cross(k, c) * sa + k * dot(k, c) * (1.0 - ca);
}

static inline float orb_halo(float pr, float R, float glowGain, float loud) {
    return (exp(-max(pr - R, 0.0) * 7.0) * 0.55 +
            exp(-max(pr - R, 0.0) * 2.6) * 0.28) * glowGain * (0.65 + 0.6 * loud);
}

static inline float orb_worley(float3 p, texture3d<float> tex, sampler s) {
    return tex.sample(s, p * ORB_NOISE_INV).g;
}

static inline float orb_plasmaDensity(float3 pos, float time, float flowSign,
                                      texture3d<float> tex, sampler s) {
    float3 q = orb_rotY(pos, time * 0.10 * flowSign);
    q.y -= time * 0.12 * flowSign;
    float3 w = float3(tex.sample(s, (q + 11.5) * ORB_NOISE_INV).a,
                      tex.sample(s, (q + 47.2) * ORB_NOISE_INV).a,
                      tex.sample(s, (q + 83.1) * ORB_NOISE_INV).a) - 0.5;
    float3 qq = q + w * 1.6;
    float dens = orb_fbm3(qq * 1.7 + time * 0.15 * flowSign, tex, s);
    float gran = tex.sample(s, qq * 2.3 * ORB_NOISE_INV).g;
    return clamp(dens * 0.75 + gran * 0.35, 0.0, 1.5);
}

static inline float3 orb_starEmission(float x, float3 baseCol) {
    x = clamp(x, 0.0, 1.0);
    float3 cool = baseCol * 0.5;
    float3 hot  = mix(baseCol, float3(1.0), 0.85);
    float3 c = mix(cool, baseCol, smoothstep(0.0, 0.5, x));
    return mix(c, hot, smoothstep(0.5, 1.0, x));
}

static inline float orb_potA(float3 q, float3 off, texture3d<float> tex, sampler s) {
    return tex.sample(s, (q + off) * ORB_NOISE_INV).a;
}

static inline float3 orb_curl(float3 p, texture3d<float> tex, sampler s) {
    const float e = 2.0;
    const float3 oX = float3( 0.0, 31.1,  0.0);
    const float3 oY = float3(17.3,  0.0, 11.7);
    const float3 oZ = float3( 5.2, 23.9, 41.3);
    float x0 = orb_potA(p, oX, tex, s);
    float y0 = orb_potA(p, oY, tex, s);
    float z0 = orb_potA(p, oZ, tex, s);
    float Pz_y = orb_potA(p + float3(0,e,0), oZ, tex, s);
    float Py_z = orb_potA(p + float3(0,0,e), oY, tex, s);
    float Px_z = orb_potA(p + float3(0,0,e), oX, tex, s);
    float Pz_x = orb_potA(p + float3(e,0,0), oZ, tex, s);
    float Py_x = orb_potA(p + float3(e,0,0), oY, tex, s);
    float Px_y = orb_potA(p + float3(0,e,0), oX, tex, s);
    return float3((Pz_y - z0) - (Py_z - y0),
                  (Px_z - x0) - (Pz_x - z0),
                  (Py_x - y0) - (Px_y - x0)) / e;
}

static inline float3 orb_bumpGrad(float3 p, float freq, texture3d<float> tex, sampler s) {
    const float e = 0.06;
    float dx = orb_vnoise3((p + float3(e,0,0)) * freq, tex, s) - orb_vnoise3((p - float3(e,0,0)) * freq, tex, s);
    float dy = orb_vnoise3((p + float3(0,e,0)) * freq, tex, s) - orb_vnoise3((p - float3(0,e,0)) * freq, tex, s);
    float dz = orb_vnoise3((p + float3(0,0,e)) * freq, tex, s) - orb_vnoise3((p - float3(0,0,e)) * freq, tex, s);
    return float3(dx, dy, dz) / (2.0 * e);
}

// ---------------------------------------------------------------------------
// MOONY: THE MOON (Andrea, 15/10/2026: the sphere is no longer blue, it has the face and the craters of the moon).
// Same surface as Avo (VoiceOrbShaders.metal, moony_*), so the two moons look alike. Only the sphere with no shape
// (Melissa before, Moony now) becomes the moon: `luna` is 1 when no shape weight is on and 0 for Darlene, Krista and
// Elliot, who do not change. Craters from a procedural 3D voronoi (no texture), seas from the noise already in use,
// all computed once per hit pixel: cheaper than the volumetric plasma it replaces.
// ---------------------------------------------------------------------------

// Moon palette per state: silver at rest, cold silver listening, lilac silver thinking, warm pearl speaking, and the
// sodium of the Bottega for the error. Low saturation on purpose: the moon stays a moon in every state.
static inline float3 moony_palette(int state) {
    if (state == 1) return float3(0.70, 0.74, 0.80);
    if (state == 2) return float3(0.76, 0.73, 0.82);
    if (state == 3) return float3(0.86, 0.80, 0.70);
    if (state == 4) return float3(0.92, 0.74, 0.48);
    return float3(0.74, 0.75, 0.78);
}

static inline float4 moony_hash43(float3 p) {
    float4 q = fract(float4(p.xyzx) * float4(0.1031, 0.1030, 0.0973, 0.1099));
    q += dot(q, q.wzxy + 33.33);
    return fract((q.xxyz + q.yzzw) * q.zywx);
}

struct MoonyCrateri {
    float3 grad;     // slope of the relief (moon space)
    float  fondo;    // 1 on the crater floors (the voice lights them)
    float  ombra;    // 1 where the rim towards the light casts a shadow on the floor
    float  raggiera; // bright rays around the young craters
};

// Craters: a 3D voronoi on the surface. Each cell may hold a crater: bowl, raised rim, a shadow cast from the rim
// towards the light that grows longer near the terminator. Neighbours add up, so craters overlap without seams.
static inline MoonyCrateri moony_crateri(float3 p, float3 nrm, float3 luce, float densita) {
    MoonyCrateri c;
    c.grad = float3(0.0); c.fondo = 0.0; c.ombra = 0.0; c.raggiera = 0.0;
    float3 ip = floor(p), fp = fract(p);
    float3 lt = luce - nrm * dot(luce, nrm);
    float  ltl = length(lt);
    float3 ld = ltl > 1e-4 ? lt / ltl : float3(1.0, 0.0, 0.0);
    float  alto = clamp(dot(nrm, luce), 0.0, 1.0);                 // height of the light over the local horizon
    float  lungaOmbra = 0.20 + 1.70 * (1.0 - alto);
    for (int z = -1; z <= 1; z++)
    for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
        float3 g = float3(x, y, z);
        float4 h = moony_hash43(ip + g);
        if (h.z > densita) continue;                                // a cell with no crater
        float3 off = fp - (g + 0.15 + 0.70 * h.xyz);
        float  r   = 0.12 + 0.30 * h.y * h.y;
        float3 ot  = off - nrm * dot(off, nrm);                     // on the tangent plane
        float  dd  = length(ot);
        float  q   = dd / r;
        if (q > 1.7) continue;
        float  bowl  = q < 1.0 ? 0.70 * q : 0.0;                    // derivative of the bowl 0.35 (q^2 - 1)
        float  e     = (q - 1.0) / 0.26;
        float  rim   = 0.11 * exp(-e * e);
        float  drim  = rim * (-2.0 * e / 0.26);
        c.grad += (bowl + drim) * (ot / max(dd, 1e-4));
        c.fondo = max(c.fondo, smoothstep(0.95, 0.45, q) * (0.5 + 0.5 * h.w));
        if (q < 1.0) {
            float2 v = float2(dot(ot, ld), length(ot - ld * dot(ot, ld))) / r;
            float  bordo = sqrt(max(1.0 - v.y * v.y, 0.0));         // where the rim towards the light is
            float  s = 1.0 - smoothstep(lungaOmbra * 0.65, lungaOmbra, bordo - v.x);
            c.ombra = max(c.ombra, s * smoothstep(1.0, 0.92, q));
        }
        if (h.w > 0.82) c.raggiera = max(c.raggiera, exp(-max(q - 1.0, 0.0) * 2.4) * (q > 0.85 ? 1.0 : 0.6));
    }
    return c;
}

// Copied verbatim from Avo (VoiceOrbShaders.metal, from «LA SUPERLUNA» to moony_aureola), only the uniform names
// change: Avo's p7/p8 are p9/p10 here. Keep it a plain copy, so a diff against Avo shows nothing else.

// LA SUPERLUNA (owner 15/10/2026: «grafica iper realistica, animazioni quando parla, pensa, stato d'animo: che si
// capisca quando cambia»). Due assi separati, cosi' si leggono anche sulla sfera piccola:
//   - l'UMORE decide che luna e' stanotte (fase e colore): argento, miele, raccolto dorato, falce fredda, mezza luna
//     radente, luna di sangue, aureola di ghiaccio. Arriva in p9 (p7 in Avo), gia' ammorbidito in OrbIdentita (secondi).
//   - lo STATO della voce decide come si muove la luce: ascolta = la luce le sale in faccia, pensa = le fasi passano
//     avanti e indietro, parla = alone e fondi dei crateri battono con le sillabe. Arriva in p10 (p8 in Avo), ammorbidito nel renderer.
// p9 = p10 = 0 (p7, p8 in Avo) e' la luna d'argento approvata, a riposo.
struct MoonyAspetto {
    float3 L;          // luce del sole nello spazio della vista (la fase)
    float  eclissi;    // 1 = luna di sangue (allarme)
    float  raccolto;   // 1 = luna del raccolto, dorata (gioia); ~0,5 miele (calore)
    float  freddo;     // 1 = argento freddo (malinconia); un poco anche la meraviglia
    float  cinerea;    // luce cinerea sul lato in ombra: cresce quando la luna e' una falce, come in cielo
    float  ascolta;    // 0..1: la luna si accende verso chi parla
    float  libra;      // dondolio lento dell'asse (librazione), 0 con «riduci movimento»
    float  falce;      // 0..1 quanto la luna e' ridotta a falce: il bordo in ombra si spegne
};

static inline float3 moony_rotX(float3 p, float a) {
    float s = sin(a), c = cos(a);
    return float3(p.x, c * p.y - s * p.z, s * p.y + c * p.z);
}

static inline MoonyAspetto moony_aspetto(constant OrbUniforms& u, float time) {
    MoonyAspetto a;
    float mossa   = 1.0 - clamp(u.p10.x, 0.0, 1.0);            // p10.x = 1 con «riduci movimento»
    a.ascolta     = clamp(u.p10.y, 0.0, 1.0);
    float pensa   = clamp(u.p10.z, 0.0, 1.0);
    float fase    = clamp(u.p9.x, -1.0, 1.2);                  // <0 verso la piena, >0 verso la falce
    a.eclissi     = clamp(u.p9.y, 0.0, 1.0);
    a.raccolto    = clamp(u.p9.z, 0.0, 1.0);
    float aureola = clamp(u.p9.w, 0.0, 1.0);
    // angolo fra il sole e chi guarda: 1,15 rad e' la luna approvata (gibbosa, luce da sinistra)
    float theta = 1.15 + 1.30 * fase
                - 0.55 * a.ascolta                                       // ascolta: si gira verso di te, si riempie
                + pensa * (0.35 + 0.55 * sin(time * 0.70) * mossa);      // pensa: il terminatore scorre avanti e indietro
    theta = clamp(theta, 0.10, 2.70);
    a.L = normalize(float3(-sin(theta) * 0.95, 0.30, cos(theta)));
    a.freddo  = clamp(smoothstep(0.45, 1.0, fase) + 0.35 * aureola, 0.0, 1.0);
    a.falce   = smoothstep(1.6, 2.4, theta);
    a.cinerea = 0.022 + 0.030 * a.falce;
    a.libra   = 0.07 * sin(time * 0.13) * mossa;
    return a;
}

// Un sistema di raggi (come Tycho e Copernico): strisce chiare che partono da un cratere giovane e corrono per
// centinaia di km, spezzate. Si vedono quando il sole e' alto e spariscono verso il terminatore, come in cielo.
static inline float moony_raggi(float3 mp, float3 c, float seme, texture3d<float> tex, sampler s) {
    float cd = dot(mp, c);
    if (cd < 0.15) return 0.0;
    float  d  = acos(min(cd, 1.0));                              // distanza angolare dal cratere
    float3 t1 = normalize(cross(c, float3(0.0, 1.0, 0.0)));
    float3 t2 = cross(c, t1);
    float  an = atan2(dot(mp, t2), dot(mp, t1));
    float3 giro = float3(cos(an), sin(an), 0.0);                 // sul cerchio: nessuna cucitura a +-pi
    float  r1 = orb_vnoise3(giro * 7.0 + float3(0.0, 0.0, seme), tex, s);
    float  r2 = orb_vnoise3(giro * 19.0 + float3(5.0, 3.0, seme), tex, s);
    float  raggi = smoothstep(0.60, 0.92, r1) * 0.85 + smoothstep(0.66, 0.95, r2) * 0.55;
    raggi *= smoothstep(0.30, 0.70, orb_vnoise3(mp * 13.0 + seme, tex, s));   // si spezzano lungo la strada
    float lungo  = exp(-d * 2.2) * smoothstep(0.04, 0.12, d);
    float nimbo  = exp(-(d * d) / 0.0045);                        // l'alone chiaro attorno al cratere
    return raggi * lungo + 0.75 * nimbo;
}

// La superficie della luna in un punto colpito dal raymarch. `N` e' la normale della forma (senza il rilievo della
// sfera); restituisce il colore lineare. Luce di Lommel-Seeliger (la luna non scurisce al bordo), mari dalle forme
// frastagliate, crateri con ombre che si allungano verso il terminatore, raggi, luce cinerea, e sopra gli effetti
// della voce in argento: bordo che segue lo spettro, filamenti sulle sillabe, fondi dei crateri che si accendono.
static inline float3 moony_superficie(float3 pos, float3 N, float pr, float time, int state, float flowSign,
                                      float loud, float onset, float heart, float flow, float glowGain,
                                      float treble, float3 baseCol, MoonyAspetto a, constant OrbUniforms& u,
                                      texture3d<float> tex, sampler s) {
    const float3 V = float3(0.0, 0.0, 1.0);
    const float3 L = a.L;
    float  giro = time * 0.025 + 0.8;                            // la luna gira piano su se stessa
    float3 sp = normalize(pos);
    float3 mp = moony_rotX(orb_rotY(sp, giro), a.libra);         // il punto sulla luna, che ruota e dondola con lei
    float3 Lm = moony_rotX(orb_rotY(L, giro), a.libra);
    float3 Vm = moony_rotX(orb_rotY(V, giro), a.libra);
    float3 Nm = moony_rotX(orb_rotY(N, giro), a.libra);

    // mari: i bacini da impatto della faccia visibile (Imbrium, Serenitatis, Tranquillitatis...), tondi e larghi, con
    // i bordi frastagliati dal rumore; la faccia nascosta, quando la luna gira, e' quasi tutta altipiano, come in cielo.
    // Il rumore MoonyNoise ha mediana ~0,40 (misurata): `bordo` e' centrato li'.
    float  grana = orb_vnoise3(mp * 22.0, tex, s);
    float  mare  = orb_fbm3(mp * 2.2 + float3(13.0, 5.0, 2.0), tex, s);
    float  bordo = (mare - 0.405) * 1.4 + 0.03 * (grana - 0.5);
    float  mari  = 0.0;
    mari = max(mari, smoothstep(0.42, 0.33, length(mp - float3(0.835, 0.530, 0.147)) + bordo));   // Imbrium
    mari = max(mari, smoothstep(0.25, 0.16, length(mp - float3(0.775, 0.407, -0.484)) + bordo));   // Serenitatis
    mari = max(mari, smoothstep(0.30, 0.21, length(mp - float3(0.705, 0.070, -0.705)) + bordo));   // Tranquillitatis
    mari = max(mari, smoothstep(0.16, 0.07, length(mp - float3(0.298, 0.259, -0.919)) + bordo));   // Crisium
    mari = max(mari, smoothstep(0.49, 0.40, length(mp - float3(0.811, 0.139, 0.568)) + bordo));   // Procellarum
    mari = max(mari, smoothstep(0.22, 0.13, length(mp - float3(0.933, -0.342, -0.115)) + bordo));   // Nubium
    mari = max(mari, smoothstep(0.18, 0.09, length(mp - float3(0.857, -0.242, -0.456)) + bordo));   // Nectaris

    // crateri: grandi e piccoli, lo stesso voronoi a due scale
    MoonyCrateri cg = moony_crateri(mp * 3.2, mp, Lm, 0.40);
    MoonyCrateri cp = moony_crateri(mp * 8.5 + 17.0, mp, Lm, 0.30);
    float3 g = (cg.grad * (1.0 - 0.45 * mari) + 0.7 * cp.grad * (1.0 - 0.6 * mari)  // i mari sono lisci
             + orb_bumpGrad(mp, 16.0, tex, s) * 0.03);
    g -= Nm * dot(g, Nm);
    float3 Nb = normalize(Nm - g * 0.9);

    // luce: Lommel-Seeliger con un terminatore morbido
    float ndl  = dot(Nb, Lm);
    float ndv  = clamp(dot(Nb, Vm), 0.0, 1.0);
    float ndlG = dot(Nm, Lm);
    float wrap = clamp((ndl + 0.10) / 1.10, 0.0, 1.0);
    float ls   = max(ndl, 0.0) / (max(ndl, 0.0) + ndv + 0.05);
    float diff = mix(wrap, 2.0 * ls, 0.5) * smoothstep(-0.25, 0.20, ndlG);
    diff *= 1.0 - 0.85 * max(cg.ombra, 0.8 * cp.ombra);

    // colore: altipiani appena caldi, mari fra il bluastro (titanio) e il bruno, grana, raggiere e raggi
    float  tipo   = orb_vnoise3(mp * 3.0 + 31.0, tex, s);
    float3 mareCol = mix(float3(0.135, 0.146, 0.172), float3(0.170, 0.160, 0.146), tipo);
    float3 alb = mix(float3(0.40, 0.395, 0.40), mareCol, mari) * (0.86 + 0.28 * grana);
    alb += float3(0.12) * max(cg.raggiera, 0.6 * cp.raggiera) * (1.0 - 0.5 * mari);
    float  sole   = clamp(ndlG, 0.0, 1.0);
    float  piena  = smoothstep(0.25, 0.95, dot(L, V));
    // tre crateri a raggiera a 120 gradi di longitudine: mentre la luna gira, uno e' quasi sempre in vista
    float  raggi  = moony_raggi(mp, float3(0.869, -0.469, -0.153), 3.0, tex, s)
                  + 0.7 * moony_raggi(mp, float3(-0.604, 0.342, -0.720), 11.0, tex, s)
                  + 0.6 * moony_raggi(mp, float3(-0.280, 0.574, 0.770), 23.0, tex, s);
    alb += float3(0.17) * raggi * smoothstep(0.05, 0.55, sole) * mix(0.45, 1.0, piena) * (1.0 - 0.25 * mari);
    float  lb = max(dot(baseCol, float3(0.2126, 0.7152, 0.0722)), 1e-3);
    alb *= mix(float3(1.0), baseCol / lb, 0.35);
    alb *= mix(float3(1.0), float3(1.20, 0.90, 0.58), a.raccolto);       // raccolto: oro e arancio, bassa sull'orizzonte
    alb *= mix(float3(1.0), float3(0.90, 0.96, 1.10), a.freddo);         // malinconia: argento freddo
    const float3 luceCol = float3(0.95, 0.98, 1.03);
    float3 col = alb * luceCol * diff * 1.30 * (1.0 + 0.18 * a.ascolta);
    col += alb * float3(0.78, 0.86, 1.0) * a.cinerea * (1.0 - clamp(diff, 0.0, 1.0));   // luce cinerea

    // eclissi: l'ombra della Terra tinge la luna di rame, piu' chiara verso il bordo dell'ombra, con il filo
    // turchese dell'ozono proprio sul bordo (si vede nelle foto vere delle eclissi)
    if (a.eclissi > 0.0) {
        float  bo   = dot(sp.xy, float2(-0.60, 0.80));
        float3 rame = mix(float3(0.10, 0.016, 0.010), float3(1.05, 0.30, 0.09), smoothstep(-0.95, 1.05, bo));
        float3 albE = mix(alb, float3(dot(alb, float3(0.3333))), 0.55);       // nell'ombra i mari si attenuano
        float3 sangue = albE * rame * (0.80 + 0.20 * clamp(diff, 0.0, 1.0));
        sangue += albE * float3(0.10, 0.30, 0.34) * smoothstep(0.82, 0.99, bo) * 0.30;
        col = mix(col, sangue, a.eclissi);
    }

    // la voce: a ogni sillaba tutta la luna si schiarisce un poco (come una nube sottile che passa via) e il fondo
    // dei crateri grandi si accende appena; il pensiero lo fa pulsare a onde che salgono
    col *= 1.0 + 0.22 * onset + 0.12 * loud;
    float fondo  = max(cg.fondo, 0.25 * cp.fondo);
    float accesa = 0.02 + 0.02 * heart + 0.45 * loud + 0.60 * onset;
    if (state == 2) accesa += 0.16 * smoothstep(0.55, 1.0, sin(time * 2.2 - mp.y * 5.0));
    float3 luceVoce = mix(baseCol, float3(1.0), 0.45);
    col += luceVoce * fondo * accesa * 0.28 * (1.0 - 0.6 * a.eclissi);

    // onde di luce che corrono sulla superficie (verso il centro in ascolto, verso fuori quando parla)
    float rip = 0.5 + 0.5 * sin(pr * 15.0 - flowSign * time * 5.0);
    col += baseCol * rip * flow * 0.06;

    // bordo d'argento che segue lo spettro, con un velo di madreperla
    float ang = atan2(sp.y, sp.x);
    int   bi  = int((ang / (2.0 * M_PI_F) + 0.5) * float(ORB_BANDS)) & (ORB_BANDS - 1);
    float eq  = orb_band(u, bi);
    float nz  = clamp(N.z, 0.0, 1.0);
    float fres = pow(1.0 - nz, 3.0);
    float3 rimCol = mix(baseCol, float3(1.0), 0.55 * (1.0 - 0.7 * a.eclissi));
    // il bordo si accende dalla parte del sole: sulla falce il lato in ombra quasi sparisce
    rimCol *= mix(0.45 * (1.0 - 0.75 * a.falce), 1.0, smoothstep(-0.35, 0.35, ndlG));
    col += rimCol * fres * (0.30 + 0.25 * glowGain) * (0.8 + 0.6 * eq + 0.35 * treble);
    float3 irid = 0.5 + 0.5 * cos(6.2831853 * (fres * 2.6 + time * 0.05 + float3(0.0, 0.33, 0.66)));
    irid = mix(float3(dot(irid, float3(0.3333))), irid, 0.35);
    col += irid * fres * 0.10;

    // filamenti di polvere al bordo sulle sillabe
    float fil  = orb_fbm3(sp * 6.0 + float3(0.0, time * 0.30, 0.0), tex, s);
    float prom = smoothstep(0.62, 0.92, fil) * pow(fres, 1.5);
    col += rimCol * prom * (0.20 + 1.2 * onset + 0.6 * loud);

    // scintille sul lato illuminato
    float spk   = orb_fbm3(pos * 26.0 - time * 0.6, tex, s);
    float twk   = 0.5 + 0.5 * sin(time * 3.0 + spk * 28.0);
    float glint = smoothstep(0.78, 0.93, spk) * (0.30 + 0.70 * twk * twk) * clamp(ndl, 0.0, 1.0);
    col += luceCol * glint * (0.25 + 0.25 * glowGain) * (1.0 - a.eclissi);

    // filo di luce sottile al limbo
    float chromo = smoothstep(0.16, 0.0, nz) * smoothstep(0.0, 0.05, nz);
    col += rimCol * chromo * (0.5 + 0.4 * glowGain);
    return col;
}

// Aureola di ghiaccio (meraviglia): l'anello di 22 gradi che si vede attorno alla luna con i cirri, rossiccio
// dentro e azzurro fuori, appena accennato. Solo fuori dal disco.
static inline float3 moony_aureola(float pr, float Rvis, float time) {
    float rr = pr / max(Rvis, 1e-3);
    float anello = exp(-pow((rr - 1.78) / 0.075, 2.0));
    float3 iride = mix(float3(1.0, 0.62, 0.45), float3(0.55, 0.78, 1.0), smoothstep(1.70, 1.88, rr));
    float velo = smoothstep(1.05, 1.70, rr) * smoothstep(2.10, 1.80, rr) * 0.10;
    return iride * (anello * 0.30 + velo * 0.25) * (0.92 + 0.08 * sin(time * 0.5));
}

fragment float4 orb_fragment(OrbVSOut in [[stage_in]],
                             constant OrbUniforms& u [[buffer(0)]],
                             texture3d<float> noiseTex [[texture(0)]],
                             sampler noiseSamp [[sampler(0)]]) {
    float2 res    = max(u.p0.xy, float2(1.0));
    float  time   = u.p0.z;
    int    state  = int(u.p1.x + 0.5);
    int    pstate = int(u.p1.y + 0.5);
    float  smix   = clamp(u.p1.z, 0.0, 1.0);
    float  loud   = clamp(u.p1.w, 0.0, 1.5);
    float  onset  = clamp(u.p2.x, 0.0, 1.0);
    float  cine   = u.p2.y;
    float  impulse = u.p2.z;
    float  reveal  = clamp(u.p2.w, 0.0, 1.0);

    float3 sunDir = normalize(u.p3.xyz);
    float  warmth = clamp(u.p3.w, 0.0, 1.0);
    float3 keyCol = mix(float3(0.80, 0.86, 1.00), float3(1.00, 0.74, 0.46), warmth);
    float3 ambCol = u.p4.xyz;
    float  night  = clamp(u.p4.w, 0.0, 1.0);

    float asp = res.x / res.y;
    float2 p  = in.uv * 2.0 - 1.0;
    p.x *= asp;
    float zoom = (u.p5.x > 0.0) ? u.p5.x : 1.0;
    // the docked orb (zoom < 1) frames the sphere; Darlene's rings reach 1.5R and Krista's blot about 1.3R, so with
    // them the view opens up (0.9 and 0.8), weighted like the morph
    zoom += (max(zoom, 0.9) - zoom) * clamp(u.p6.z, 0.0, 1.0) + (max(zoom, 0.8) - zoom) * clamp(u.p6.y, 0.0, 1.0);
    p *= zoom;
    float  agit = clamp(u.p7.w, 0.0, 1.0);

    // DARLENE, the glitch (Avo, 10/10/2026): horizontal strips torn sideways. The point we look from moves, so the
    // whole figure (core, rings, halo, rays) is sliced without a second raymarch. It JUMPS, in bursts, and grows
    // with the voice, the onsets and the agitation. Colours and scanlines further down.
    float darlene = clamp(u.p6.z, 0.0, 1.0);
    float tGlitch = fmod(time, 4096.0);                  // like Elliot's rain: float precision
    float snap    = floor(tGlitch * (7.0 + 9.0 * agit));
    float energyG = clamp(0.25 * agit + 0.9 * loud + 1.3 * onset, 0.0, 1.0);
    float torn = 0.0;                                    // 1 in the torn strips (for the colour)
    if (darlene > 0.002) {
        float burst  = step(0.55, orb_hash21(float2(floor(tGlitch * 1.7), 9.7)));
        float rowId  = floor(p.y * 9.0 + orb_hash21(float2(snap, 2.3)) * 3.0);    // wide strips
        float thresh = 0.97 - 0.12 * burst - 0.34 * energyG;
        torn = orb_hash21(float2(rowId, snap)) > thresh ? 1.0 : 0.0;
        float push  = (orb_hash21(float2(rowId * 3.1, snap + 0.5)) - 0.5) * (0.10 + 0.26 * energyG);
        float fineId = floor(p.y * 64.0);                                           // thin strips
        float fine   = orb_hash21(float2(fineId, snap * 1.3)) > (0.985 - 0.03 * energyG) ? 1.0 : 0.0;
        float pushF  = (orb_hash21(float2(fineId, snap + 4.1)) - 0.5) * 0.05;
        p.x += (push * torn + pushF * fine) * darlene;
        torn = max(torn, fine * 0.6);
    }

    // slow organic drift of the whole orb (more when calm)
    float wanderAmt = (state == 0 ? 0.030 : 0.014);
    float2 wander = float2(orb_fbm3(float3(time * 0.06, 3.0, 0.0), noiseTex, noiseSamp) - 0.5,
                           orb_fbm3(float3(0.0, time * 0.06, 7.0), noiseTex, noiseSamp) - 0.5);
    p -= wander * wanderAmt;
    float pr = length(p);

    float bass = 0.0, mid = 0.0, treble = 0.0;
    for (int i = 0;  i < 4;  i++) bass   += orb_band(u, i);
    for (int i = 4;  i < 10; i++) mid    += orb_band(u, i);
    for (int i = 10; i < ORB_BANDS; i++) treble += orb_band(u, i);
    bass /= 4.0; mid /= 6.0; treble /= 6.0;

    // subliminal heartbeat (always alive)
    float heart = pow(0.5 + 0.5 * sin(time * 6.3), 6.0) * 0.6
                + pow(0.5 + 0.5 * sin(time * 6.3 - 0.7), 6.0) * 0.3;

    float breath = 0.5 + 0.5 * sin(u.p5.w > 0.5 ? u.p5.z : time * 1.1);
    OrbDrive d;
    d.time = time; d.bass = bass; d.mid = mid;
    d.baseR = 0.46; d.amp = 0.05; d.swirl = 0.10; d.flowSign = 1.0;
    d.reveal = reveal;
    d.romb = u.p6.y; d.star = u.p6.z;
    float code = clamp(u.p6.x, 0.0, 1.0);
    // Moony: 1 when no shape is on (her moon), 0 for Darlene, Krista and Elliot. In the morph from one to the other it
    // moves with the weights, so the moon dissolves into the other's figure.
    float luna = clamp(1.0 - (u.p6.x + u.p6.y + u.p6.z), 0.0, 1.0);
    if (luna < 0.001) luna = 0.0;
    d.onde = 1.0 - 0.5 * luna;
    MoonyAspetto aspetto = moony_aspetto(u, time);
    float coreGain = 1.0, glowGain = 1.0;
    float flow = 0.0;

    if (state == 0) {                          // idle: calm breathing, still a living star
        d.baseR  += 0.018 * breath;
        d.amp     = 0.075 + 0.018 * breath;
        d.swirl   = 0.16;
        d.flowSign = 1.0;
        flow      = 0.50 + 0.14 * breath;
        glowGain  = 1.02 + 0.10 * breath;
        coreGain  = 1.09;
    } else if (state == 1) {                   // listening: absorb inward, cool
        d.baseR  += 0.020 + 0.050 * loud;
        d.amp     = 0.050 + 0.050 * loud + 0.04 * bass;
        d.swirl   = 0.16;
        d.flowSign = -1.0;
        flow      = 0.45 + 0.55 * loud;
        glowGain  = 0.90 + 0.50 * loud;
        coreGain  = 1.00 + 0.30 * loud;
    } else if (state == 2) {                   // thinking: vortex
        d.baseR  += 0.015 * sin(time * 2.0);
        d.amp     = 0.070;
        d.swirl   = 1.10;
        glowGain  = 1.00;
    } else if (state == 4) {                   // error: contracted, slow, uneasy flicker
        float flick = 0.5 + 0.5 * sin(time * 9.0 + 2.0 * sin(time * 3.1));
        d.baseR  += -0.012 + 0.008 * breath;
        d.amp     = 0.055;
        d.swirl   = 0.06;
        d.flowSign = 1.0;
        flow      = 0.30;
        glowGain  = 0.80 + 0.22 * flick;
        coreGain  = 0.95;
    } else {                                   // speaking: emit outward, warm/green
        float burst = pow(loud, 0.6);
        d.baseR  += 0.030 + 0.100 * burst + 0.020 * sin(time * 7.0) * burst;
        d.amp     = 0.060 + 0.050 * burst + 0.04 * mid;
        d.swirl   = 0.50;
        d.flowSign = 1.0;
        flow      = 0.40 + 0.60 * burst;
        glowGain  = 1.10 + 0.80 * burst;
        coreGain  = 1.10 + 0.50 * burst;
    }

    // the super moon: the halo of the mood (the harvest moon shines, the eclipse dims, the crescent pulls in) and the
    // light that rises while listening. With luna = 0 the factor is exactly 1: the characters do not change.
    if (luna > 0.0) {
        float aloneLuna = (1.0 + 0.40 * aspetto.raccolto) * (1.0 - 0.55 * aspetto.eclissi)
                        * (1.0 - 0.35 * smoothstep(0.6, 1.1, u.p9.x)) * (1.0 + 0.25 * aspetto.ascolta);
        glowGain *= mix(1.0, aloneLuna, luna);
    }

    // the agitation of the line deforms more, up to 60% (on the moon Avo's own rule, so the two moons match)
    d.amp    *= mix(1.0 + 0.6 * agit, 0.75 + 0.60 * agit, luna);
    d.amp    *= 1.0 - 0.80 * luna;                // the moon stays round: the craters make the relief
    d.baseR  += heart * 0.012 + impulse * 0.05;
    glowGain += heart * 0.08  + onset * 0.45;
    flow     += onset * 0.5;

    float3 baseCol = mix(orb_palette(pstate), orb_palette(state), smix);

    // slow living hue drift (held back while speaking, nearly off in error)
    float hueDrift = 0.42 * sin(time * 0.060) + 0.18 * sin(time * 0.017 + 2.1);
    float driftAmt = (state == 0) ? 1.00 : (state == 2 ? 0.85 : (state == 4 ? 0.12 : 0.55));
    baseCol = orb_hueRotate(baseCol, hueDrift * driftAmt);

    // the real energy of the voice lights the colour up while listening or speaking
    if (state == 1 || state == 3) {
        float energy = clamp(loud * 0.70 + mid * 0.55 + bass * 0.35, 0.0, 1.0);
        float luma   = dot(baseCol, float3(0.2126, 0.7152, 0.0722));
        baseCol = max(mix(float3(luma), baseCol, 1.0 + 0.45 * energy), 0.0);
        float warmDir = (state == 3) ? 1.0 : -1.0;
        baseCol = orb_hueRotate(baseCol, (energy - 0.30) * 0.55 * warmDir);
    }
    // Moony: the state palette becomes moon silver (no blue), brightened by the voice on its peaks
    if (luna > 0.0) {
        float3 lunaCol = mix(moony_palette(pstate), moony_palette(state), smix);
        if (state == 1 || state == 3) {
            float energiaL = clamp(loud * 0.70 + mid * 0.55 + bass * 0.35, 0.0, 1.0);
            lunaCol *= 1.0 + 0.22 * energiaL;
        }
        lunaCol *= mix(float3(1.0), float3(1.18, 0.92, 0.62), aspetto.raccolto);   // golden halo and rim
        lunaCol *= mix(float3(1.0), float3(0.88, 0.96, 1.12), aspetto.freddo);
        lunaCol *= mix(float3(1.0), float3(0.95, 0.34, 0.20), aspetto.eclissi);    // copper halo, dimmed
        baseCol = mix(baseCol, lunaCol, luna);
    }
    // the colour of who speaks, with the light of the emotion: of the palette's drift only a trace stays
    baseCol = mix(baseCol, u.p7.xyz * u.p8.y, clamp(u.p6.w, 0.0, 1.0));

    float3 ro = float3(p, 2.5);
    float3 rd = float3(0.0, 0.0, -1.0);
    float  R  = d.baseR;
    float  maxR = R + 0.24;
    // the edge that shows: Darlene's core is at 0.60R, Krista's blot grows from the centre; halo, corona and the
    // shockwave start from there (Avo)
    float  krista = clamp(d.romb, 0.0, 1.0);
    float  Rvis = R * (1.0 - 0.40 * clamp(d.star, 0.0, 1.0) - 0.50 * krista);
    float  pxWorld = 2.0 * zoom / res.y;
    // on the moon halo, corona and background field start from the edge: over the disc they would cover seas and craters
    float  fuoriDisco = luna > 0.0 ? mix(1.0, smoothstep(Rvis * 0.90, Rvis * 1.03, pr), luna) : 1.0;
    const float stepK = 0.72;
    const int outSteps = 80;

    float3 col   = float3(0.0);
    float  alpha = 0.0;

    if (pr < maxR) {
        float zEntry = sqrt(max(0.0, maxR * maxR - pr * pr));
        float t = 2.5 - zEntry;
        bool  hit = false;
        float minDist = 1e9;
        float3 pos = ro + rd * t;
        for (int i = 0; i < outSteps; i++) {
            pos = ro + rd * t;
            float dist = orb_map(pos, d, noiseTex, noiseSamp);
            minDist = min(minDist, dist);
            if (dist < 0.0009) { hit = true; break; }
            t += dist * stepK;
            if (pos.z < -maxR) break;
        }

        if (hit) {
            float3 N = orb_normal(pos, d, noiseTex, noiseSamp);
            float3 Ngeo = N;
            float3 body = float3(0.0);
            if (luna < 0.999) {                  // the usual sphere (Darlene, Krista, Elliot and the morphs)
            float3 flowField = orb_curl(pos * 5.5 + float3(0.0, time * 0.10, 0.0), noiseTex, noiseSamp);
            float3 flowPos   = pos + flowField * 0.12;

            float3 bump = orb_bumpGrad(flowPos, 9.0,  noiseTex, noiseSamp)
                        + orb_bumpGrad(flowPos, 22.0, noiseTex, noiseSamp) * 0.5;
            bump -= N * dot(bump, N);
            N = normalize(N - bump * (0.11 * reveal));

            float3 V = float3(0.0, 0.0, 1.0);
            float3 L = sunDir;
            float diff = clamp(dot(N, L), 0.0, 1.0);
            float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
            float3 H   = normalize(L + V);
            float ndh  = clamp(dot(N, H), 0.0, 1.0);
            float spec = pow(ndh, 64.0) + 0.20 * pow(ndh, 12.0);

            float3 dir = normalize(pos);
            float ripPhase = pr * 15.0 - d.flowSign * time * 5.0;
            float rip = 0.5 + 0.5 * sin(ripPhase);

            float ang = atan2(dir.y, dir.x);
            int   bi  = int((ang / (2.0 * M_PI_F) + 0.5) * float(ORB_BANDS)) & (ORB_BANDS - 1);
            float eq  = orb_band(u, bi);

            float central = smoothstep(R, 0.0, pr);

            float3 deep = baseCol * 0.22;
            body = mix(deep, baseCol, diff * 0.85 + 0.15);
            body *= mix(float3(1.0), keyCol, 0.45);
            body += baseCol * mix(ambCol, baseCol, 0.5) * (N.y * 0.5 + 0.5) * 0.10;
            body += baseCol * rip * flow * 0.22;
            body += baseCol * central * coreGain * 0.22;
            body += keyCol * spec * (0.45 + 0.25 * coreGain);

            // volumetric plasma core: an interior ray-march with sun-like convection
            float3 rdr = refract(rd, N, 0.86);
            if (dot(rdr, rdr) < 1e-4) rdr = rd;
            const int ORB_VSTEPS = 48;
            float vstep = (2.0 * R) / float(ORB_VSTEPS);
            float vjit = orb_hash21(in.uv * res + time * 60.0);
            float3 vp = pos + rdr * (0.02 + vjit * vstep);
            float3 plasma = float3(0.0);
            float  vtrans = 1.0;
            for (int j = 0; j < ORB_VSTEPS; j++) {
                vp += rdr * vstep;
                if (orb_map(vp, d, noiseTex, noiseSamp) > 0.015) break;
                float rr   = length(vp);
                float core = smoothstep(R, 0.0, rr);
                float dens = orb_plasmaDensity(vp, time, d.flowSign, noiseTex, noiseSamp);
                dens = pow(dens, 1.3) * (0.30 + 1.30 * core);
                float temp = clamp(dens * (0.55 + 0.9 * core) + 0.15 * heart, 0.0, 1.0);
                plasma += orb_starEmission(temp, baseCol) * dens * vtrans * vstep * 6.0;
                vtrans *= exp(-dens * vstep * 5.5);
                if (vtrans < 0.02) break;
            }
            body += plasma * (0.6 + 0.5 * coreGain);

            // thin-film iridescence on the rim
            float filmT = 2.4 + 1.7 * orb_vnoise3(flowPos * 5.0 + time * 0.08, noiseTex, noiseSamp);
            float3 irid = 0.5 + 0.5 * cos(6.2831853 * (fres * filmT + time * 0.05 + float3(0.0, 0.33, 0.66)));
            float3 rimCol = mix(baseCol, float3(1.0), 0.55);
            body += rimCol * fres * (1.0 + glowGain) * (0.85 + 0.6 * eq + 0.35 * treble);
            body += irid * fres * (0.30 + 0.18 * reveal);

            float skin = orb_fbm3(flowPos * 9.0 + time * 0.05, noiseTex, noiseSamp);
            body *= 0.92 + 0.16 * skin * reveal;
            float granC = orb_worley(flowPos * 3.0, noiseTex, noiseSamp);
            float granF = orb_worley(flowPos * 7.0 + float3(0.0, time * 0.04, 0.0), noiseTex, noiseSamp);
            float granule = mix(granC, granF, 0.4);
            body *= mix(1.0, 0.82 + 0.40 * granule, reveal);
            body += baseCol * smoothstep(0.6, 0.95, granule) * 0.12 * (0.6 + coreGain) * reveal;
            float fil  = orb_fbm3(dir * 6.0 + float3(0.0, time * 0.30, 0.0), noiseTex, noiseSamp);
            float prom = smoothstep(0.62, 0.92, fil) * pow(fres, 1.5);
            body += orb_starEmission(0.85, baseCol) * prom * (0.5 + 1.6 * onset + 0.8 * loud) * reveal;
            float spk   = orb_fbm3(pos * 26.0 - time * 0.6, noiseTex, noiseSamp);
            float twk   = 0.5 + 0.5 * sin(time * 3.0 + spk * 28.0);
            float glint = smoothstep(0.74, 0.9, spk) * (0.35 + 0.65 * fres) * (0.30 + 0.70 * twk * twk);
            body += keyCol * glint * (0.6 + 0.5 * glowGain) * reveal;
            float wrap = clamp((dot(N, L) + 0.35) / 1.35, 0.0, 1.0);
            float back = pow(clamp(dot(V, -L), 0.0, 1.0), 2.0);
            float thin = 1.0 - central;
            body += baseCol * (back + 0.45 * wrap) * thin * (0.18 + 0.12 * warmth);

            // limb darkening + chromosphere
            float ndv = clamp(dot(N, V), 0.0, 1.0);
            body *= mix(0.72, 1.0, pow(ndv, 0.55));
            float chromo = smoothstep(0.16, 0.0, ndv) * smoothstep(0.0, 0.05, ndv);
            body += orb_starEmission(0.92, baseCol) * chromo * (1.1 + 0.6 * glowGain);
            }
            if (luna > 0.0) {
                float3 lunaBody = moony_superficie(pos, Ngeo, pr, time, state, d.flowSign, loud, onset, heart,
                                                   flow, glowGain, treble, baseCol, aspetto, u, noiseTex, noiseSamp);
                body = luna >= 0.999 ? lunaBody : mix(body, lunaBody, luna);
            }

            col   = body;
            alpha = 1.0;
        } else {
            float cov = 1.0 - smoothstep(0.0, 1.6 * pxWorld, minDist);
            if (cov > 0.0) {
                float3 rimCol = mix(baseCol, float3(1.0), 0.55);
                col   = rimCol * (0.9 + glowGain) * (1.0 - 0.5 * luna);   // on the moon a silver thread
                alpha = cov;
            }
        }
    }

    // Elliot's falling code, in screen space inside the disc: dark glass, then green columns
    // of glyphs with a light head (CONTRATTI 9.11, «La sfera di chi parla»)
    if (code > 0.001) {
        float3 green = u.p7.xyz * u.p8.y;
        // the grid (columns, rows, glyph size) hangs on the base radius, not on the live R that beats
        // with the heart, the breath and the voice: on R the columns trembled at every beat. Only the
        // disc below follows the living sphere.
        const float gridR = 0.46;
        float2 m = p / (gridR * 2.3) + 0.5;
        // the clock of the rain wrapped at 4096 s: after hours of a running renderer the product
        // time x rate went past float precision and the glyphs stopped changing
        float tRain = fmod(time, 4096.0);
        const float cols = 26.0;
        float cw = 1.0 / cols, ch = cw * 1.45;
        float colId = floor(m.x / cw);
        float hc = orb_hash21(float2(colId, 17.3));
        float speed = (0.25 + 0.75 * hc) * (1.0 + 1.6 * loud + 0.8 * agit);
        float yDown = 1.0 - m.y;
        float len = 0.35 + 0.45 * orb_hash21(float2(colId, 3.1));
        float head = fract(tRain * speed * 0.45 + hc * 7.0);
        float behind = fract(head - yDown + 1.0);
        float trail = behind < len ? exp(-behind / len * 3.2) : 0.0;
        float head2 = fract(tRain * speed * 0.27 + hc * 13.0);
        float behind2 = fract(head2 - yDown + 1.0);
        trail = max(trail, behind2 < len * 0.6 ? 0.45 * exp(-behind2 / (len * 0.6) * 3.2) : 0.0);
        float rowId = floor(yDown / ch);
        float2 cell = float2(fract(m.x / cw), fract(yDown / ch));
        float2 inside = (cell - 0.14) / 0.72;
        float glyph = 0.0;
        if (all(inside >= 0.0) && all(inside < 1.0)) {
            float2 sub = floor(inside * float2(3.0, 5.0));
            float tick = fmod(floor(tRain * (1.5 + 5.0 * orb_hash21(float2(colId, rowId)))), 1024.0);
            float bit = orb_hash21(float2(colId * 7.0 + sub.x + tick * 0.37, rowId * 11.0 + sub.y * 3.0));
            glyph = bit > 0.42 ? 1.0 : 0.0;
        }
        float tip = behind < ch * 1.1 ? 1.0 : 0.0;
        float3 rain = mix(green * 1.4, float3(0.85, 1.0, 0.9) * 2.2, tip) * glyph * trail;
        float disc = smoothstep(R * 1.18, R * 1.02, pr);
        col = mix(col, col * 0.18 + green * 0.04, code * disc);
        col += rain * disc * code;
        alpha = max(alpha, code * disc * max(0.55, glyph * trail));
    }

    // soft outer halo
    {
        float halo = orb_halo(pr, Rvis, glowGain * (1.0 - 0.25 * night) * (1.0 - 0.55 * krista), loud);
        col   += baseCol * halo * fuoriDisco;
        alpha  = max(alpha, halo);
    }

    // Moony's wonder: the ice halo ring around the moon (outside the disc only)
    if (luna > 0.0 && u.p9.w > 0.002) {
        float3 aur = moony_aureola(pr, Rvis, time) * clamp(u.p9.w, 0.0, 1.0) * luna;
        col   += aur;
        alpha  = max(alpha, dot(aur, float3(0.3333)) * 0.8);
    }

    // corona + long rays, gated per angle by the matching spectrum band
    {
        float cang = atan2(p.y, p.x);
        float outR = max(pr - Rvis, 0.0);
        int   cbi = int((cang / (2.0 * M_PI_F) + 0.5) * float(ORB_BANDS)) & (ORB_BANDS - 1);
        float cEq = orb_band(u, cbi);
        float cn1 = orb_fbm3(float3(cang * 2.5, pr * 3.0,  time * 0.25), noiseTex, noiseSamp);
        float cn2 = orb_fbm3(float3(cang * 5.0, pr * 1.5, -time * 0.17), noiseTex, noiseSamp);
        float s1  = pow(0.5 + 0.5 * sin(cang * 18.0 + time * 0.80 + cn1 * 6.2831853), 3.0);
        float s2  = pow(0.5 + 0.5 * sin(cang * 41.0 - time * 0.55 + cn2 * 6.2831853), 5.0);
        float corona = (s1 + 0.6 * s2) * exp(-outR * 4.0) * (0.05 + 0.10 * loud + 0.18 * onset);
        corona *= 1.0 - 0.85 * krista;                   // Krista is calm: no sizzling corona
        corona *= fuoriDisco;
        col   += orb_starEmission(0.7, baseCol) * corona;
        alpha  = max(alpha, corona * 0.6);
        float rayN = pow(0.5 + 0.5 * sin(cang * 9.0 + cn1 * 4.0 + time * 0.22), 6.0);
        float rays = rayN * exp(-outR * 1.05)
                   * (0.020 + 0.075 * cEq + 0.26 * onset + 0.10 * loud)
                   * smoothstep(0.0, 0.05, outR);
        rays  *= 1.0 - 0.85 * krista;
        col   += orb_starEmission(0.80, baseCol) * rays * reveal;
        alpha  = max(alpha, rays * 0.5);
    }

    // shockwave ring on each speech onset
    if (onset > 0.01) {
        float age  = 1.0 - onset;
        float rad  = Rvis + age * 0.95;
        float wid  = 0.020 + 0.055 * age;
        float ring = exp(-pow((pr - rad) / wid, 2.0));
        float fade = onset * onset;
        col   += orb_starEmission(0.95, baseCol) * ring * fade * 0.85;
        alpha  = max(alpha, ring * fade * 0.5);
    }

    // DARLENE, cyberpunk (Avo, 10/10/2026): a dark glass core with pink plasma and a neon rim, and around it three
    // neon rings (pink, cyan, violet) turning like a gyroscope, with flashes of light running along them; the back
    // half of each ring passes behind the core. Over it the torn strips lose a channel and turn cyan, monitor
    // scanlines pass and, when she speaks, blocks of pixels pop out. All in screen space: no raymarch cost.
    if (darlene > 0.002) {
        float3 pink   = max(u.p7.xyz * u.p8.y, float3(0.0));
        float3 cyan   = float3(0.10, 0.95, 1.00);
        float3 violet = float3(0.62, 0.30, 1.00);
        float  rN     = R * 0.60;                                           // the core of orb_map
        float  luma   = dot(col, float3(0.2126, 0.7152, 0.0722));
        float  inCore = smoothstep(rN * 1.03, rN * 0.97, pr);
        col = mix(col, pink * luma * 0.55, inCore * darlene);               // dark glass, pink plasma
        float  rimX = (pr - rN) / 0.010;                                     // squared by hand: pow of a negative is undefined
        float  rim = exp(-rimX * rimX);
        col   += pink * rim * (1.4 + 1.2 * loud + 1.0 * onset) * darlene;
        alpha  = max(alpha, rim * darlene);

        for (int k = 0; k < 3; k++) {
            float fk   = float(k);
            float way  = k == 1 ? -1.0 : 1.0;
            float a    = R * (1.00 + 0.22 * fk) * (1.0 + 0.05 * loud);
            float tilt = 1.15 + 0.25 * sin(tGlitch * (0.21 + 0.07 * fk) + fk * 2.1);   // how edge-on it is
            float roll = fk * 2.094 + way * tGlitch * (0.12 + 0.05 * fk) + 0.6 * agit * sin(tGlitch * 0.8 + fk);
            float2 q   = float2(cos(roll) * p.x + sin(roll) * p.y, -sin(roll) * p.x + cos(roll) * p.y);
            float2 ab  = float2(a, a * cos(tilt));
            float  kq  = length(q / ab);
            float  dist = abs(kq - 1.0) * kq / max(length(q / (ab * ab)), 1e-4);    // distance from the ellipse
            float  theta = atan2(q.y / ab.y, q.x / ab.x);
            float  front = smoothstep(-0.15, 0.15, sin(theta));                    // the half towards us
            float  hidden = (1.0 - front) * smoothstep(rN * 1.02, rN * 0.95, pr);  // behind the core
            float  w    = 0.0045 + 0.004 * loud;
            float  line = exp(-pow(dist / w, 2.0));
            float  glow = exp(-dist / (w * 7.0)) * 0.35;
            float  run  = pow(0.5 + 0.5 * cos(theta - way * tGlitch * (1.4 + 0.6 * fk) * (1.0 + 1.5 * energyG)), 12.0);
            float3 tint = k == 0 ? pink : (k == 1 ? cyan : violet);
            float  light = (line * (1.6 + 2.2 * run) + glow * (0.6 + run))
                         * (0.55 + 0.45 * front) * (1.0 - 0.9 * hidden) * (1.0 + 0.8 * loud + 1.2 * onset);
            col   += mix(tint, float3(1.0), 0.35 * line * run) * light * darlene;
            alpha  = max(alpha, clamp(light, 0.0, 1.0) * darlene);
        }

        float  near = smoothstep(R * 2.0, R * 1.3, pr);
        col = mix(col, cyan * dot(col, float3(0.2126, 0.7152, 0.0722)) * 1.25, 0.80 * torn * darlene * near);
        float scan = 0.5 + 0.5 * sin(in.uv.y * res.y * 1.5707963);         // a line every 4 pixels
        col *= 1.0 - 0.22 * scan * darlene * near;
        float2 block = floor(in.uv * res / 7.0);
        float  bk    = orb_hash21(block + float2(snap * 13.0, snap * 7.0));
        float  data  = bk > (0.997 - 0.025 * energyG) ? 1.0 : 0.0;
        float3 pixel = bk > 0.9995 ? float3(1.6) : mix(cyan, pink, step(0.5, fract(bk * 977.0))) * 1.6;
        col   += pixel * data * near * darlene;
        alpha  = max(alpha, data * near * darlene);
    }

    // KRISTA, the Rorschach blot (Avo, 10/10/2026): an amber ink blot, mirrored on the vertical axis like the test,
    // that changes shape slowly and breathes on six seconds. Warm light on the edge, level lines inside: while
    // Andrea speaks they flow to the centre and slow waves come in with his voice; when she speaks they flow out
    // and the blot widens with her words. All in screen space; the sphere under it has shrunk (orb_map).
    if (krista > 0.002) {
        float3 amber  = max(u.p7.xyz * u.p8.y, float3(0.0));
        float  tK     = fmod(time, 4096.0);
        float  breathK = 0.5 + 0.5 * sin(tK * 1.0471976);                  // six seconds
        float  listen = state == 1 ? 1.0 : 0.0;
        float  speak  = state == 3 ? 1.0 : 0.0;
        float2 m  = p / 0.46;                                               // in base radii: it does not beat with the heart
        float2 sm = float2(abs(m.x), m.y);                                  // the mirror of the test
        float  field = orb_fbm3(float3(sm * 1.35, tK * 0.045), noiseTex, noiseSamp);
        float  fine  = orb_fbm3(float3(sm * 3.8 + 7.0, tK * 0.07), noiseTex, noiseSamp);
        float  rad   = length(sm * float2(0.78, 1.05));
        float  wide  = 0.06 * breathK + speak * (0.30 * pow(loud, 0.7) + 0.25 * onset) - 0.06 * listen;
        float  v = (field - 0.5) * 1.7 + (fine - 0.5) * 0.55 + (1.0 - rad) * 0.95 - 0.25 + wide;
        float  full  = smoothstep(0.0, 0.06, v);
        float  edgeX = v / 0.03;
        float  edgeK = exp(-edgeX * edgeX);
        float  out_  = exp(-max(-v, 0.0) / 0.10) * (1.0 - full);
        float  way   = listen > 0.5 ? 1.0 : -1.0;                           // listening: the lines go to the centre
        float  levels = pow(0.5 + 0.5 * sin(v * 38.0 + way * tK * 0.9), 6.0);
        float3 ink   = amber * (0.16 + 0.22 * fine) + amber * levels * 0.30 * full;
        float3 lightK = mix(amber, float3(1.0, 0.92, 0.78), 0.45) * edgeK * (1.2 + 0.6 * breathK + 1.2 * speak * loud)
                      + amber * out_ * (0.22 + 0.10 * breathK);
        float  waves = pow(0.5 + 0.5 * sin(pr * 22.0 + tK * 2.2), 8.0)      // listening: waves to the centre
                     * smoothstep(0.30, 0.70, pr) * exp(-max(pr - 0.70, 0.0) * 3.0)
                     * listen * (0.10 + 0.55 * loud) * (1.0 - full);
        float3 figure = ink * full + lightK + amber * waves;
        col   = mix(col, col * (1.0 - full) + figure, krista);
        alpha = max(alpha, clamp(max(full, max(edgeK, max(out_ * 0.6, waves))), 0.0, 1.0) * krista);
    }

    if (cine > 0.5) {
        float ring  = 0.5 + 0.5 * sin(pr * 10.0 - d.flowSign * time * 2.5);
        float field = exp(-pr * 1.3) * ring * (0.04 + 0.10 * loud + 0.22 * onset) * fuoriDisco;
        col   += baseCol * field;
        alpha  = max(alpha, field * 0.5);
    }

    // fade everything to zero before the panel edge, so the glow never shows a square
    float edge = 1.0 - smoothstep(0.80, 0.99, max(abs(in.uv.x * 2.0 - 1.0), abs(in.uv.y * 2.0 - 1.0)));
    col *= edge;
    alpha *= edge;

    // luminance-preserving extended Reinhard, EDR white point
    {
        float L  = max(dot(col, float3(0.2126, 0.7152, 0.0722)), 1e-4);
        float Lw = 2.6;
        float Lt = L * (1.0 + L / (Lw * Lw)) / (1.0 + L);
        col *= Lt / L;
    }
    col   = min(col, float3(5.0));
    col   += (orb_hash21(in.uv * res + time) - 0.5) * (1.0 / 255.0);
    alpha  = clamp(alpha, 0.0, 1.0);
    return float4(max(col, 0.0) * alpha, alpha);
}

// ===========================================================================
// GPU PARTICLES: the absorb / emit spark field
// ===========================================================================

struct OrbParticle {
    float4 posLife;   // xyz position, w life (0..1)
    float4 velSeed;   // xyz velocity, w seed (0..1)
};

struct ParticleUniforms {
    float4 q0;   // dt, time, state, level
    float4 q1;   // aspect, count, pulse 0..1, reserved
    float4 q2;   // colour of who speaks (with its light), tint
};

static inline float pr_rand(float s) { return fract(sin(s) * 43758.5453); }

static inline float3 pr_stateColor(int state) {
    if (state == 1) return float3(0.31, 0.86, 0.92);
    if (state == 2) return float3(0.66, 0.52, 0.98);
    if (state == 3) return float3(0.55, 0.88, 0.60);
    if (state == 4) return float3(0.98, 0.72, 0.30);
    return float3(0.60, 0.80, 0.95);
}

// the sparks take the colour of who speaks too. Moony (no character tint, tint.w = 0): silver dust; with a
// character's full tint (0.85) the colours are the old ones, so for them nothing changes. The error stays amber.
static inline float3 pr_color(int state, float4 tint) {
    float  ta   = clamp(tint.w, 0.0, 1.0);
    float  luna = state == 4 ? 0.0 : 1.0 - clamp(ta / 0.85, 0.0, 1.0);
    float3 argento = state == 1 ? float3(0.76, 0.80, 0.86) : (state == 3 ? float3(0.92, 0.87, 0.78)
                   : (state == 2 ? float3(0.82, 0.80, 0.88) : float3(0.84, 0.85, 0.88)));
    float3 col = mix(pr_stateColor(state), argento, luna);
    return mix(col, tint.xyz, ta);
}

kernel void orb_particle_update(device OrbParticle* parts [[buffer(0)]],
                                constant ParticleUniforms& pu [[buffer(1)]],
                                uint id [[thread_position_in_grid]]) {
    uint count = uint(pu.q1.y);
    if (id >= count) return;

    OrbParticle pt = parts[id];
    float dt    = pu.q0.x;
    float time  = pu.q0.y;
    int   state = int(pu.q0.z + 0.5);
    float level = pu.q0.w;

    float3 pos = pt.posLife.xyz;
    float  life = pt.posLife.w;
    float3 vel = pt.velSeed.xyz;
    float  seed = pt.velSeed.w;

    float r = length(pos) + 1e-5;
    float3 dir = pos / r;
    float pulse = pu.q1.z;

    if (state == 1) {                          // listening: absorb inward
        vel += -dir * (0.95 + 1.7 * level) * (1.0 + 0.85 * pulse) * dt;
        vel *= 0.978;
        life -= dt * (0.5 + level);
    } else if (state == 3) {                   // speaking: emit outward
        vel += dir * (0.85 + 2.0 * level) * (1.0 + 1.05 * pulse) * dt;
        vel *= 0.988;
        life -= dt * 0.6;
    } else {                                   // idle / thinking / error: breathing orbit
        float spin = (state == 2) ? 0.60 : (state == 4 ? 0.12 : 0.30);
        float3 tang = normalize(cross(dir, float3(0.0, 1.0, 0.0)) + 1e-4);
        vel = tang * spin + dir * (sin(time + seed * 6.2831853) * 0.05 + (pulse - 0.5) * 0.20);
        life -= dt * 0.25;
    }
    pos += vel * dt;
    r = length(pos);

    if (life <= 0.0 || r < 0.12 || r > 1.30) {
        float a = pr_rand(seed * 91.17 + time);
        float b = pr_rand(seed * 48.31 + time * 1.7);
        float c = pr_rand(seed * 12.79 + time * 0.3);
        float theta = a * 6.2831853;
        float phi   = acos(2.0 * b - 1.0);
        float3 sph  = float3(sin(phi) * cos(theta), cos(phi), sin(phi) * sin(theta));
        float spawnR = (state == 3) ? 0.55 : 1.15;
        pos  = sph * spawnR;
        vel  = float3(0.0);
        life = 0.6 + 0.6 * c;
        seed = fract(seed + 0.6180339887);
    }

    pt.posLife = float4(pos, life);
    pt.velSeed = float4(vel, seed);
    parts[id] = pt;
}

struct ParticleVSOut {
    float4 pos [[position]];
    float  psize [[point_size]];
    float  bright;
    int    state [[flat]];
    float4 tint [[flat]];
};

vertex ParticleVSOut orb_particle_vertex(const device OrbParticle* parts [[buffer(0)]],
                                         constant ParticleUniforms& pu [[buffer(1)]],
                                         uint vid [[vertex_id]]) {
    OrbParticle pt = parts[vid];
    float3 wp = pt.posLife.xyz;
    ParticleVSOut o;
    o.pos    = float4(wp.x, wp.y, 0.0, 1.0);
    float life = clamp(pt.posLife.w, 0.0, 1.0);
    float pulse = pu.q1.z;
    // fade out towards the panel edge (no square cut-off)
    float edge = 1.0 - smoothstep(0.80, 0.98, max(abs(wp.x), abs(wp.y)));
    o.bright = life * life * (1.0 + 0.40 * pulse) * edge;
    o.psize  = mix(2.0, 6.0, life) * (wp.z * 0.2 + 1.0) * (1.0 + 0.35 * pulse);
    o.state  = int(pu.q0.z + 0.5);
    o.tint   = pu.q2;
    return o;
}

fragment float4 orb_particle_fragment(ParticleVSOut in [[stage_in]],
                                      float2 pc [[point_coord]]) {
    float dd = length(pc - 0.5);
    float a  = smoothstep(0.5, 0.0, dd) * in.bright;
    float3 col = pr_color(in.state, in.tint) * 1.7;
    return float4(col * a, a);
}

struct ParticleTrailVSOut {
    float4 pos [[position]];
    float  bright;
    int    state [[flat]];
    float4 tint [[flat]];
};

vertex ParticleTrailVSOut orb_particle_trail_vertex(const device OrbParticle* parts [[buffer(0)]],
                                                    constant ParticleUniforms& pu [[buffer(1)]],
                                                    uint vid [[vertex_id]]) {
    uint pid  = vid >> 1;
    bool tail = (vid & 1u) != 0u;
    OrbParticle pt = parts[pid];
    float life  = clamp(pt.posLife.w, 0.0, 1.0);
    float pulse = pu.q1.z;
    float3 v  = pt.velSeed.xyz;
    float  sp = length(v);
    float3 back = (sp > 1e-4) ? (v / sp) * min(sp * 0.085, 0.16) : float3(0.0);
    float3 wp = pt.posLife.xyz - (tail ? back : float3(0.0));
    ParticleTrailVSOut o;
    o.pos    = float4(wp.x, wp.y, 0.0, 1.0);
    float edge = 1.0 - smoothstep(0.80, 0.98, max(abs(wp.x), abs(wp.y)));
    o.bright = tail ? 0.0 : life * life * (1.0 + 0.40 * pulse) * 0.85 * edge;
    o.state  = int(pu.q0.z + 0.5);
    o.tint   = pu.q2;
    return o;
}

fragment float4 orb_particle_trail_fragment(ParticleTrailVSOut in [[stage_in]]) {
    float a = clamp(in.bright, 0.0, 1.0);
    return float4(pr_color(in.state, in.tint) * 1.7 * a, a);
}

// ===========================================================================
// BLOOM: multi-scale pyramid + anamorphic streak, on an offscreen HDR target
// ===========================================================================

struct BloomUniforms {
    float4 b0;   // (texelW, texelH, dirX, dirY)
    float4 b1;   // (threshold, intensity, streakGain, moon weight for the composite)
};

struct FSOut { float4 pos [[position]]; float2 uv; };

vertex FSOut fs_vertex(uint vid [[vertex_id]]) {
    float2 p = float2((vid << 1) & 2, vid & 2);
    FSOut o;
    o.pos = float4(p * 2.0 - 1.0, 0.0, 1.0);
    o.uv  = float2(p.x, 1.0 - p.y);
    return o;
}

fragment float4 bloom_brightpass(FSOut in [[stage_in]],
                                 texture2d<float> src [[texture(0)]],
                                 sampler s [[sampler(0)]],
                                 constant BloomUniforms& u [[buffer(0)]]) {
    float4 c = src.sample(s, in.uv);
    float  l = max(max(c.r, c.g), c.b);
    float  k = max(l - u.b1.x, 0.0) / max(l, 1e-4);
    return float4(c.rgb * k, 1.0);
}

// 13-tap partial Karis downsample (stops HDR fireflies from strobing)
fragment float4 bloom_downsample(FSOut in [[stage_in]],
                                 texture2d<float> src [[texture(0)]],
                                 sampler s [[sampler(0)]],
                                 constant BloomUniforms& u [[buffer(0)]]) {
    float2 t  = u.b0.xy;
    float2 uv = in.uv;
    float3 a = src.sample(s, uv + float2(-2.0, -2.0) * t).rgb;
    float3 b = src.sample(s, uv + float2( 0.0, -2.0) * t).rgb;
    float3 c = src.sample(s, uv + float2( 2.0, -2.0) * t).rgb;
    float3 d = src.sample(s, uv + float2(-2.0,  0.0) * t).rgb;
    float3 e = src.sample(s, uv).rgb;
    float3 f = src.sample(s, uv + float2( 2.0,  0.0) * t).rgb;
    float3 g = src.sample(s, uv + float2(-2.0,  2.0) * t).rgb;
    float3 h = src.sample(s, uv + float2( 0.0,  2.0) * t).rgb;
    float3 i = src.sample(s, uv + float2( 2.0,  2.0) * t).rgb;
    float3 j = src.sample(s, uv + float2(-1.0, -1.0) * t).rgb;
    float3 k = src.sample(s, uv + float2( 1.0, -1.0) * t).rgb;
    float3 l = src.sample(s, uv + float2(-1.0,  1.0) * t).rgb;
    float3 m = src.sample(s, uv + float2( 1.0,  1.0) * t).rgb;
    float3 acc = (j + k + l + m) * 0.125;
    acc += (a + b + d + e) * 0.03125;
    acc += (b + c + e + f) * 0.03125;
    acc += (d + e + g + h) * 0.03125;
    acc += (e + f + h + i) * 0.03125;
    return float4(acc, 1.0);
}

// 9-tap tent upsample, run with additive blending
fragment float4 bloom_upsample(FSOut in [[stage_in]],
                               texture2d<float> src [[texture(0)]],
                               sampler s [[sampler(0)]],
                               constant BloomUniforms& u [[buffer(0)]]) {
    float2 r  = u.b0.xy * u.b1.x;
    float2 uv = in.uv;
    float3 acc = src.sample(s, uv + float2(-1.0,  1.0) * r).rgb * 1.0;
    acc       += src.sample(s, uv + float2( 0.0,  1.0) * r).rgb * 2.0;
    acc       += src.sample(s, uv + float2( 1.0,  1.0) * r).rgb * 1.0;
    acc       += src.sample(s, uv + float2(-1.0,  0.0) * r).rgb * 2.0;
    acc       += src.sample(s, uv).rgb                          * 4.0;
    acc       += src.sample(s, uv + float2( 1.0,  0.0) * r).rgb * 2.0;
    acc       += src.sample(s, uv + float2(-1.0, -1.0) * r).rgb * 1.0;
    acc       += src.sample(s, uv + float2( 0.0, -1.0) * r).rgb * 2.0;
    acc       += src.sample(s, uv + float2( 1.0, -1.0) * r).rgb * 1.0;
    return float4(acc * (1.0 / 16.0) * u.b1.y, 1.0);
}

fragment float4 bloom_streak(FSOut in [[stage_in]],
                             texture2d<float> src [[texture(0)]],
                             sampler s [[sampler(0)]],
                             constant BloomUniforms& u [[buffer(0)]]) {
    float2 step  = u.b0.zw * u.b0.xy * u.b1.x;
    float  atten = clamp(u.b1.y, 0.0, 0.999);
    float3 acc = src.sample(s, in.uv).rgb;
    float  wsum = 1.0;
    for (int i = 1; i <= 4; i++) {
        float w = pow(atten, float(i));
        acc += src.sample(s, in.uv + step * float(i)).rgb * w;
        acc += src.sample(s, in.uv - step * float(i)).rgb * w;
        wsum += 2.0 * w;
    }
    return float4(acc / wsum, 1.0);
}

// scene + bloom + streak. Alpha stays the scene coverage: the glow ADDS light over the
// desktop instead of dimming it. Faded at the panel border so it never shows a box.
fragment float4 bloom_composite(FSOut in [[stage_in]],
                                texture2d<float> scene [[texture(0)]],
                                texture2d<float> bloom [[texture(1)]],
                                texture2d<float> streak [[texture(2)]],
                                sampler s [[sampler(0)]],
                                constant BloomUniforms& u [[buffer(0)]]) {
    float4 sc = scene.sample(s, in.uv);
    float3 bl = bloom.sample(s, in.uv).rgb;
    float3 st = streak.sample(s, in.uv).rgb;
    // on Moony's moon (u.b1.w = moon weight, from the renderer) the streak is neutral silver, not blue
    const float3 streakTint = float3(0.40, 0.72, 1.30);
    float3 tintaScia = mix(streakTint, float3(0.92, 0.95, 1.02), clamp(u.b1.w, 0.0, 1.0));
    float2 q = abs(in.uv * 2.0 - 1.0);
    float edge = 1.0 - smoothstep(0.78, 0.99, max(q.x, q.y));
    float3 add = (bl * u.b1.y + st * tintaScia * u.b1.z) * edge;
    return float4(sc.rgb + add, sc.a);
}
