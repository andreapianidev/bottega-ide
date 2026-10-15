//
//  LunaAvvio.metal
//  Bottega per iPhone
//
//  La luna della schermata d'avvio di Moony AI (15/10/2026, Andrea: «durante il caricamento deve mostrare la
//  proiezione dell'ombra sulla luna in tempo reale, sia su iOS che su macOS»). Una sola passata, autonoma:
//  - la superficie e' procedurale: mari scuri e bassi, due ordini di crateri con conca e bordo rialzato;
//  - la luce e' quella del Sole vero di adesso (LunaVera): mentre l'app si prepara il Sole sorge sulla luna,
//    il terminatore scorre dal buio fino alla fase di stasera, dal lato in cui il lembo illuminato sta in cielo;
//  - lungo il terminatore il rilievo proietta ombre lunghe: dal punto si cammina sulla sfera verso il Sole e
//    si guarda se un bordo piu' alto lo copre. Le cime oltre il terminatore restano accese;
//  - il lato buio non e' nero: luce cinerea, appena azzurra (e' la Terra che lo illumina);
//  - la luce secondo Lommel-Seeliger, non Lambert: la luna piena e' un disco quasi uniforme, non una palla.
//  Uscita premoltiplicata su fondo trasparente (sotto c'e' il colore Notte).
//

#include <metal_stdlib>
using namespace metal;

struct LunaAvvioOut { float4 pos [[position]]; float2 uv; };

/// a = (larghezza, altezza, avanzamento 0...1 gia' addolcito, riservato)
/// b = (angolo di arrivo della luce in radianti: 0 nuova, pi piena; lembo x; lembo y, y in su; riservato)
struct LunaAvvioU { float4 a; float4 b; };

vertex LunaAvvioOut luna_avvio_vertex(uint vid [[vertex_id]]) {
    float2 p = float2((vid << 1) & 2, vid & 2);
    LunaAvvioOut o;
    o.pos = float4(p * 2.0 - 1.0, 0.0, 1.0);
    o.uv  = float2(p.x, 1.0 - p.y);
    return o;
}

static inline float luna_hash(float3 p) {
    p = fract(p * float3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.x + p.y) * p.z);
}

static inline float luna_rumore(float3 p) {
    float3 i = floor(p), f = fract(p);
    float3 w = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(luna_hash(i),                   luna_hash(i + float3(1, 0, 0)), w.x),
                   mix(luna_hash(i + float3(0, 1, 0)), luna_hash(i + float3(1, 1, 0)), w.x), w.y),
               mix(mix(luna_hash(i + float3(0, 0, 1)), luna_hash(i + float3(1, 0, 1)), w.x),
                   mix(luna_hash(i + float3(0, 1, 1)), luna_hash(i + float3(1, 1, 1)), w.x), w.y), w.z);
}

/// Un ordine di crateri: celle di una griglia 3D, in meta' delle celle un cratere con conca e bordo.
static inline float luna_crateri(float3 p, float scala, float seme) {
    float3 c = floor(p * scala);
    float h = 0.0;
    for (int x = -1; x <= 1; x++)
    for (int y = -1; y <= 1; y++)
    for (int z = -1; z <= 1; z++) {
        float3 cella = c + float3(x, y, z);
        float  k = luna_hash(cella + seme);
        if (k < 0.5) continue;
        float3 centro = (cella + float3(luna_hash(cella + seme + 1.7),
                                        luna_hash(cella + seme + 3.1),
                                        luna_hash(cella + seme + 5.3))) / scala;
        float  raggio = (0.20 + 0.30 * luna_hash(cella + seme + 7.9)) / scala;
        float  d = distance(p, centro) / raggio;
        if (d < 1.6) {
            float conca = d < 1.0 ? (d * d - 1.0) * 0.55 : 0.0;
            float bordo = 0.30 * exp(-pow((d - 1.0) / 0.22, 2.0));
            h += (conca + bordo) * raggio * scala;
        }
    }
    return h;
}

struct LunaSuolo { float quota; float mare; };

static inline LunaSuolo luna_suolo(float3 p) {
    float mare = smoothstep(0.50, 0.66, luna_rumore(p * 1.7 + 3.1) * 0.7 + luna_rumore(p * 3.9) * 0.3);
    float h = luna_crateri(p, 5.0, 11.0) * 1.0 + luna_crateri(p, 13.0, 23.0) * 0.45 - mare * 0.35;
    LunaSuolo s; s.quota = h; s.mare = mare;
    return s;
}

fragment float4 luna_avvio_fragment(LunaAvvioOut in [[stage_in]], constant LunaAvvioU& u [[buffer(0)]]) {
    const float R = 0.80;                                  // il disco nella vista; fuori c'e' l'alone
    float2 q = (in.uv - 0.5) * 2.0;                        // -1...1, y in giu'
    float  r = length(q);
    float  prog = clamp(u.a.z, 0.0, 1.0);

    // Il Sole: parte quasi da dietro la luna e gira fino alla fase vera (minimo 0,12 pi: sotto, una luna
    // nuova vera sarebbe un disco nero).
    float  meta = clamp(u.b.x, 0.12 * M_PI_F, M_PI_F);
    float  theta = mix(0.06 * M_PI_F, meta, prog);
    float2 dir = normalize(u.b.yz + float2(1e-5, 0.0));
    float3 l = float3(sin(theta) * dir, -cos(theta));
    float3 argento = float3(0.80, 0.84, 0.90);

    // Alone sottile attorno al disco, che cresce con la luce.
    float  illum = 0.5 + 0.5 * cos(M_PI_F - theta);
    float  alone = exp(-max(r - R, 0.0) * 9.0) * 0.22 * illum * (1.0 - smoothstep(0.92, 1.0, r));
    if (r > R) {
        return float4(argento * alone, alone);
    }

    float2 pd = q / R;
    float  z = sqrt(max(0.0, 1.0 - dot(pd, pd)));
    float3 n = float3(pd.x, -pd.y, z);

    LunaSuolo s0 = luna_suolo(n);
    float  e = dot(n, l);                                   // seno dell'altezza del Sole sul posto
    float  eRilievo = e + 0.10 * s0.quota;

    // Ombre proiettate: si cammina sulla sfera verso il Sole, solo dove il Sole e' basso.
    float  ombra = 0.0;
    if (e > -0.08 && e < 0.30) {
        float3 t = normalize(l - n * e + float3(1e-5, 0.0, 0.0));
        float  tanE = max(e, 0.0) / sqrt(max(1.0 - e * e, 1e-4));
        for (int k = 1; k <= 7; k++) {
            float passo = float(k) * 0.022;
            float hk = luna_suolo(normalize(n + t * passo)).quota;
            ombra = max(ombra, (hk - s0.quota) * 0.030 - passo * tanE);
        }
        ombra = saturate(ombra * 90.0);
    }

    // Luce: Lommel-Seeliger (mu0 / (mu0 + mu)), un disco quasi uniforme invece di una palla.
    float  mu0 = max(e, 0.0), mu = z;
    float  ls = mu0 / (mu0 + mu + 1e-4) * 2.0;
    float  terminatore = smoothstep(-0.012, 0.07, eRilievo);
    float  lume = mix(terminatore, terminatore * min(ls, 1.0), 0.35) * (1.0 - 0.88 * ombra);

    float  grana = 0.92 + 0.16 * luna_rumore(n * 40.0);
    float  albedo = mix(0.84, 0.50, s0.mare) * grana * (1.0 + 0.6 * max(s0.quota, 0.0));
    float3 colore = float3(0.93, 0.94, 0.97) * albedo * lume
                  + float3(0.42, 0.48, 0.60) * albedo * 0.10 * (1.0 - lume);   // luce cinerea

    float  bordo = 1.0 - smoothstep(0.985, 1.0, length(pd));
    float  a = bordo;
    return float4(colore * a + argento * alone * (1.0 - a), max(a, alone));
}
