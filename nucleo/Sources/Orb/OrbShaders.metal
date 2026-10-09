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
//    p6 = (code, rhombus, star weights, tint)           who speaks (OrbAspetto.swift): the sphere
//    p7 = (character colour rgb, agitation)             is 1 - rhombus - star (code keeps the sphere
//    p8 = (shape angle, colour light, spike length, 0)  and adds the falling code); tint 0.85 for a
//                                                       character, 0 for Melissa
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
    float4 p8;            // (angle, light, spike length, 0)
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

static inline float3 orb_rotX(float3 p, float a) {
    float s = sin(a), c = cos(a);
    return float3(p.x, c * p.y - s * p.z, s * p.y + c * p.z);
}

// the star's spikes: the 12 vertices of the icosahedron, six axes and their opposites
static inline float orb_spikes(float3 dir) {
    const float a = 0.5257311, b = 0.8506508;
    float m = abs(dot(dir, float3(a, b, 0.0)));
    m = max(m, abs(dot(dir, float3(a, -b, 0.0))));
    m = max(m, abs(dot(dir, float3(0.0, a, b))));
    m = max(m, abs(dot(dir, float3(0.0, a, -b))));
    m = max(m, abs(dot(dir, float3(b, 0.0, a))));
    m = max(m, abs(dot(dir, float3(-b, 0.0, a))));
    return pow(m, 28.0);
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
    // the characters' shapes (the sphere is what is left; the code is a sphere), the shape's angle, the spike length
    float romb;
    float star;
    float angle;
    float spike;
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
    h += d.bass * 0.11 * sin(3.0 * phi + wave)                 * sin(2.0 * theta);
    h += d.mid  * 0.06 * sin(6.0 * phi - wave * 1.3 + n * 4.0) * sin(4.0 * theta);
    return h * d.reveal;
}

static inline float orb_map(float3 pos, OrbDrive d, texture3d<float> tex, sampler s) {
    float3 dir = normalize(pos + float3(1e-5));
    float disp = orb_displacement(dir, d, tex, s);
    float ball = length(pos) - (d.baseR + disp);
    float others = d.romb + d.star;
    if (others < 0.001) return ball;
    // the characters' shapes turn slowly, tilted, so the rhombus reads in 3D
    float3 q = orb_rotX(orb_rotY(pos, d.angle), 0.45);
    float R = d.baseR;
    float dist = ball * (1.0 - others);
    if (d.romb > 0.001) dist += ((abs(q.x) + abs(q.y) + abs(q.z) - 1.32 * R) * 0.57735 - 0.06 * R - disp * 0.6) * d.romb;
    if (d.star > 0.001) dist += (length(pos) - (0.86 * R + 0.5 * disp + d.spike * R * orb_spikes(normalize(q + float3(1e-5))))) * d.star;
    return dist;
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
    p *= zoom;

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
    d.angle = u.p8.x; d.spike = u.p8.z;
    float agit = clamp(u.p7.w, 0.0, 1.0);
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

    // the agitation of the line deforms more, up to 60%
    d.amp    *= 1.0 + 0.6 * agit;
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
    // the colour of who speaks, with the light of the emotion: of the palette's drift only a trace stays
    baseCol = mix(baseCol, u.p7.xyz * u.p8.y, clamp(u.p6.w, 0.0, 1.0));

    float3 ro = float3(p, 2.5);
    float3 rd = float3(0.0, 0.0, -1.0);
    float  R  = d.baseR;
    // the star's spikes and the rhombus's vertices leave the sphere: the search sphere grows with them
    float  maxR = R + 0.24 + R * (0.4 * d.star + 0.1 * d.romb);
    float  pxWorld = 2.0 * zoom / res.y;
    // the spikes are not Lipschitz: with the star a more careful step, and more steps
    float  stepK = mix(0.72, 0.45, d.star);
    int    outSteps = d.star > 0.01 ? 120 : 80;

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
            float3 body = mix(deep, baseCol, diff * 0.85 + 0.15);
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

            col   = body;
            alpha = 1.0;
        } else {
            float cov = 1.0 - smoothstep(0.0, 1.6 * pxWorld, minDist);
            if (cov > 0.0) {
                float3 rimCol = mix(baseCol, float3(1.0), 0.55);
                col   = rimCol * (0.9 + glowGain);
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
        float halo = orb_halo(pr, R, glowGain * (1.0 - 0.25 * night), loud);
        col   += baseCol * halo;
        alpha  = max(alpha, halo);
    }

    // corona + long rays, gated per angle by the matching spectrum band
    {
        float cang = atan2(p.y, p.x);
        float outR = max(pr - R, 0.0);
        int   cbi = int((cang / (2.0 * M_PI_F) + 0.5) * float(ORB_BANDS)) & (ORB_BANDS - 1);
        float cEq = orb_band(u, cbi);
        float cn1 = orb_fbm3(float3(cang * 2.5, pr * 3.0,  time * 0.25), noiseTex, noiseSamp);
        float cn2 = orb_fbm3(float3(cang * 5.0, pr * 1.5, -time * 0.17), noiseTex, noiseSamp);
        float s1  = pow(0.5 + 0.5 * sin(cang * 18.0 + time * 0.80 + cn1 * 6.2831853), 3.0);
        float s2  = pow(0.5 + 0.5 * sin(cang * 41.0 - time * 0.55 + cn2 * 6.2831853), 5.0);
        float corona = (s1 + 0.6 * s2) * exp(-outR * 4.0) * (0.05 + 0.10 * loud + 0.18 * onset);
        col   += orb_starEmission(0.7, baseCol) * corona;
        alpha  = max(alpha, corona * 0.6);
        float rayN = pow(0.5 + 0.5 * sin(cang * 9.0 + cn1 * 4.0 + time * 0.22), 6.0);
        float rays = rayN * exp(-outR * 1.05)
                   * (0.020 + 0.075 * cEq + 0.26 * onset + 0.10 * loud)
                   * smoothstep(0.0, 0.05, outR);
        col   += orb_starEmission(0.80, baseCol) * rays * reveal;
        alpha  = max(alpha, rays * 0.5);
    }

    // shockwave ring on each speech onset
    if (onset > 0.01) {
        float age  = 1.0 - onset;
        float rad  = R + age * 0.95;
        float wid  = 0.020 + 0.055 * age;
        float ring = exp(-pow((pr - rad) / wid, 2.0));
        float fade = onset * onset;
        col   += orb_starEmission(0.95, baseCol) * ring * fade * 0.85;
        alpha  = max(alpha, ring * fade * 0.5);
    }

    if (cine > 0.5) {
        float ring  = 0.5 + 0.5 * sin(pr * 10.0 - d.flowSign * time * 2.5);
        float field = exp(-pr * 1.3) * ring * (0.04 + 0.10 * loud + 0.22 * onset);
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

// the sparks take the colour of who speaks too
static inline float3 pr_color(int state, float4 tint) {
    return mix(pr_stateColor(state), tint.xyz, clamp(tint.w, 0.0, 1.0));
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
    float4 b1;   // (threshold, intensity, streakGain, _)
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
    const float3 streakTint = float3(0.40, 0.72, 1.30);
    float2 q = abs(in.uv * 2.0 - 1.0);
    float edge = 1.0 - smoothstep(0.78, 0.99, max(q.x, q.y));
    float3 add = (bl * u.b1.y + st * streakTint * u.b1.z) * edge;
    return float4(sc.rgb + add, sc.a);
}
