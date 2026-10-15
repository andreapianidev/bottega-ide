//
//  Cielo.metal
//  Bottega per iPhone
//
//  Il cielo dietro Moony AI per iPhone (16/10/2026, Andrea: «sfondo nero nero che risalta il buio, animazioni di
//  sfondo in Metal come la schermata di caricamento del Mac, ma con l'app aperta»). E' il LaunchSky di Moony AI
//  sul Mac (Features/Launch/LaunchView.swift) rifatto in una sola passata di GPU:
//  - il fondo e' nero vero (0, 0, 0): la luce la fanno solo stelle, comete e la luna sopra;
//  - due strati di stelle su griglie di celle, una stella al piu' per cella, che tremolano piano; all'apertura
//    compaiono a poco a poco (`comparsa` da 0 a 1), come sul Mac mentre l'app si prepara;
//  - sei comete con la coda e sei stelle cadenti su una coreografia fissa di 36 secondi che si ripete, da fuori
//    schermo a fuori schermo, quindi niente compare o sparisce di colpo.
//  Con "Riduci movimento" restano le stelle ferme e la vista disegna un fotogramma solo.
//

#include <metal_stdlib>
using namespace metal;

struct CieloOut { float4 pos [[position]]; float2 uv; };

/// a = (larghezza in punti, altezza in punti, tempo in secondi, comparsa 0...1)
/// b = (moto 0/1, luminosita' 0...1, riservato, riservato)
struct CieloU { float4 a; float4 b; };

vertex CieloOut cielo_vertex(uint vid [[vertex_id]]) {
    float2 p = float2((vid << 1) & 2, vid & 2);
    CieloOut o;
    o.pos = float4(p * 2.0 - 1.0, 0.0, 1.0);
    o.uv  = float2(p.x, 1.0 - p.y);                        // in alto a sinistra, y in giu'
    return o;
}

static inline float cielo_hash(float2 p) {
    float3 q = fract(float3(p.xyx) * float3(0.1031, 0.1030, 0.0973));
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
}

/// Uno strato di stelle: celle di `cella` punti, in una parte di esse una stella. Il punto della stella sta nel
/// 70% centrale della cella, cosi' il suo bagliore non viene tagliato dal bordo.
static inline float3 cielo_stelle(float2 p, float t, float cella, float seme, float densita, float forza,
                                  float comparsa, float moto) {
    float2 c = floor(p / cella);
    float  h = cielo_hash(c + seme);
    if (h > densita) return float3(0.0);
    float2 dove = (c + 0.15 + 0.70 * float2(cielo_hash(c + seme + 1.7), cielo_hash(c + seme + 4.3))) * cella;
    float  grande = pow(cielo_hash(c + seme + 7.1), 5.0);  // poche stelle grandi, molte piccole
    float  r = 0.35 + grande * 1.25;
    float  d = length(p - dove);
    float  nucleo = exp(-(d * d) / (r * r));
    float  bagliore = exp(-d / (r * 3.2)) * 0.12 * grande;
    float  velocita = 0.5 + 1.5 * cielo_hash(c + seme + 9.9);
    float  tremolio = mix(1.0, 0.55 + 0.45 * sin(t * velocita + h * 40.0), moto);
    float  soglia = cielo_hash(c + seme + 2.9) * 0.85;
    float  visibile = saturate((comparsa - soglia) / 0.15);
    // dal bianco azzurro al bianco caldo, come le stelle vere
    float3 colore = mix(float3(0.78, 0.85, 1.00), float3(1.00, 0.93, 0.82), cielo_hash(c + seme + 5.5));
    return colore * (nucleo + bagliore) * tremolio * visibile * forza * (0.55 + 0.45 * grande);
}

/// Una scia (cometa o stella cadente): da `a` a `b` (frazioni della vista) fra `da` e `da + durata` nel ciclo.
/// `forma` = (coda in frazione di larghezza, mezza larghezza in punti, luce, testa 0/1).
static inline float3 cielo_scia(float2 p, float2 vista, float tc, float da, float durata, float4 ab, float4 forma) {
    float k = (tc - da) / durata;
    if (k <= 0.0 || k >= 1.0) return float3(0.0);
    float2 a = ab.xy * vista, b = ab.zw * vista;
    float2 testa = mix(a, b, k);
    float2 u = normalize(b - a);
    float2 n = float2(-u.y, u.x);
    float2 v = p - testa;
    float  dietro = -dot(v, u);                            // positivo dietro la testa
    float  lato = abs(dot(v, n));
    float  coda = forma.x * vista.x * min(1.0, k * 4.0);   // la coda si allunga entrando
    float  dissolvenza = min(1.0, k / 0.12) * min(1.0, (1.0 - k) / 0.22);
    float  luce = forma.z * dissolvenza;
    float  mezza = forma.y;
    float  o = 0.0;
    if (dietro > 0.0 && dietro < coda) {
        float s = dietro / coda;
        float largo = mezza * (1.0 - 0.75 * s);
        o += pow(1.0 - s, 1.6) * exp(-(lato * lato) / (largo * largo + 1e-3)) * 0.85;
    }
    if (forma.w > 0.5) {
        float d2 = dot(v, v);
        o += exp(-d2 / pow(mezza * 6.0, 2.0)) * 0.35 + exp(-d2 / pow(mezza * 1.2, 2.0));
    }
    return float3(0.86, 0.89, 0.95) * o * luce;
}

// Comete: lente (3-4 s), coda lunga, una ogni 5-7 secondi da direzioni diverse. (da, durata) e (ax, ay, bx, by).
constant float2 COMETE_T[6] = { {1.5, 3.6}, {7.5, 3.2}, {13.0, 4.0}, {19.5, 3.4}, {25.0, 3.8}, {30.5, 3.6} };
constant float4 COMETE_P[6] = { {-0.10, 0.12, 0.62, 0.34}, {1.10, 0.08, 0.30, 0.30}, {0.70, -0.10, 1.10, 0.55},
                                {-0.10, 0.70, 0.45, 0.95}, {0.20, -0.10, -0.10, 0.45}, {1.10, 0.62, 0.55, 1.08} };
constant float3 COMETE_F[6] = { {0.22, 2.2, 0.95}, {0.18, 1.8, 0.80}, {0.20, 2.0, 0.85},
                                {0.16, 1.6, 0.70}, {0.20, 2.0, 0.85}, {0.18, 1.8, 0.75} };
// Stelle cadenti: rapidissime e corte, fra una cometa e l'altra.
constant float2 CADENTI_T[6] = { {5.0, 0.7}, {11.0, 0.6}, {17.2, 0.7}, {23.0, 0.6}, {28.6, 0.7}, {34.0, 0.6} };
constant float4 CADENTI_P[6] = { {0.82, 0.18, 0.68, 0.30}, {0.15, 0.40, 0.27, 0.50}, {0.90, 0.72, 0.78, 0.84},
                                 {0.08, 0.10, 0.20, 0.20}, {0.60, 0.06, 0.74, 0.16}, {0.32, 0.80, 0.20, 0.90} };

fragment float4 cielo_fragment(CieloOut in [[stage_in]], constant CieloU& u [[buffer(0)]]) {
    float2 vista = u.a.xy;
    float2 p = in.uv * vista;                              // in punti
    float  t = u.a.z;
    float  comparsa = u.a.w;
    float  moto = u.b.x;

    float3 c = cielo_stelle(p, t, 46.0, 3.0, 0.50, 1.00, comparsa, moto)
             + cielo_stelle(p, t * 0.8, 19.0, 17.0, 0.42, 0.55, comparsa, moto);

    if (moto > 0.5) {
        float tc = fmod(t, 36.0);
        for (int i = 0; i < 6; i++) {
            c += cielo_scia(p, vista, tc, COMETE_T[i].x, COMETE_T[i].y, COMETE_P[i], float4(COMETE_F[i], 1.0));
            c += cielo_scia(p, vista, tc, CADENTI_T[i].x, CADENTI_T[i].y, CADENTI_P[i], float4(0.07, 1.0, 0.65, 0.0));
        }
    }
    return float4(c * u.b.y, 1.0);
}
