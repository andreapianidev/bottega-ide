//
//  SkyShaders.metal
//  Bottega Nucleo
//
//  The sky of the projects (the Osservatorio). Three passes:
//   - background, cached in a texture and redrawn only when the size changes: the night
//     gradient, a low sodium glow over the horizon, a procedural Milky Way with dust lanes,
//     the caldera ridge and the silhouettes of the observatory domes (with a small red
//     work lamp, the only light an observatory allows);
//   - lines: the constellations, one instanced quad per pair of projects worked together;
//   - stars: ONE instanced draw for the faint background field and the project stars
//     (core, glow, diffraction spikes, live ring, pulse wave, selection reticle).
//  Output is linear extended Display P3 for an rgba16Float EDR drawable; star cores go
//  above 1.0 when the display has headroom. Lines and stars blend additively.
//
//  Everything is in namespace sky and prefixed sky_: all .metal files link into one
//  default.metallib, so names must not clash with the orb's.
//
//  Uniforms mirror SkyUniforms in SkyRenderer.swift.
//

#include <metal_stdlib>
using namespace metal;

namespace sky {

struct Uniforms {
    float4 view;      // drawable px w, h; px per point; time s (frozen under Reduce motion)
    float4 field;     // star field in normalized drawable coords: x0, y0 (from top), w, h
    float4 state;     // breath phase, EDR headroom, reduce motion 0/1, sparks on lines 0/1
    float4 focus;     // selected index, hover index (-1 none), horizon, aspect w/h
    float4 zenith;    // linear P3 colours, .a unused
    float4 horizonC;
    float4 sodium;
    float4 ink;
    float4 milky;
    float4 brace;
    float4 line;
    float4 reticle;
    float4 live;
};

struct Instance {
    float4 a;     // x, y (normalized: drawable for type 0, star field for type 1), size pt, type
    float4 col;   // linear rgb, brightness
    float4 b;     // twinkle rate, seed, pulse intensity 0..1, pulse age s
    float4 c;     // live 0/1, hollow 0/1, index, quad half extent pt
};

struct Line {
    float4 ab;     // x1, y1, x2, y2 in star field coords
    float4 style;  // width pt, alpha, index a, index b
    float4 extra;  // seed, strength, _, _
};

static inline float hash21(float2 p) {
    float3 p3 = fract(float3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

static inline float noise(float2 p) {
    float2 i = floor(p);
    float2 f = fract(p);
    float2 w = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + float2(1.0, 0.0));
    float c = hash21(i + float2(0.0, 1.0));
    float d = hash21(i + float2(1.0, 1.0));
    return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

static inline float fbm(float2 p) {
    float s = 0.0, amp = 0.5;
    for (int k = 0; k < 5; k++) {
        s += amp * noise(p);
        p = p * 2.03 + float2(17.1, 9.2);
        amp *= 0.5;
    }
    return s;
}

/// The caldera ridge: height (fraction of the view height, from the bottom) at x, where
/// x is in height units (so the mountains keep their shape at any aspect).
static inline float ridge(float x, float horizon) {
    return horizon - 0.035
         + 0.030 * fbm(float2(x * 2.1, 3.7))
         + 0.012 * sin(x * 1.3 + 0.8)
         + 0.010 * smoothstep(0.2, 1.6, x);   // the rim climbs a little to the right
}

/// Signed distance (height units) to a dome: a cylinder wall with a hemispherical cap.
static inline float dome(float2 p, float cx, float base, float wall, float r) {
    float box = max(abs(p.x - cx) - r, p.y - (base + wall));
    float cap = length(p - float2(cx, base + wall)) - r;
    return min(box, cap);
}

} // namespace sky

using namespace sky;

// MARK: - Full screen triangle

struct SkyFSOut {
    float4 pos [[position]];
    float2 uv;   // 0..1, y from the top
};

vertex SkyFSOut sky_fullscreen_vertex(uint vid [[vertex_id]]) {
    const float2 p[3] = { float2(-1.0, -1.0), float2(3.0, -1.0), float2(-1.0, 3.0) };
    SkyFSOut o;
    o.pos = float4(p[vid], 0.0, 1.0);
    o.uv = float2(p[vid].x * 0.5 + 0.5, 0.5 - p[vid].y * 0.5);
    return o;
}

// MARK: - Background (cached)

fragment float4 sky_background_fragment(SkyFSOut in [[stage_in]],
                                        constant Uniforms& u [[buffer(0)]]) {
    float aspect = u.focus.w;
    float2 uv = in.uv;
    float yUp = 1.0 - uv.y;
    float2 p = float2(uv.x * aspect, yUp);
    float px = 1.0 / max(u.view.y, 1.0);
    float horizon = u.focus.z;

    float rY = ridge(p.x, horizon);
    float h = clamp((yUp - rY) / max(1.0 - rY, 0.01), 0.0, 1.0);

    // Night gradient: deep at the zenith, basalt blue at the horizon.
    float3 col = mix(u.horizonC.rgb, u.zenith.rgb, smoothstep(0.0, 0.9, pow(h, 0.6)));

    // Sodium: the street lamps of the valley below, a low warm band over the ridge,
    // stronger towards the town on the left.
    float above = max(yUp - rY, 0.0);
    float town = 0.55 + 0.45 * exp(-pow((uv.x - 0.22) / 0.28, 2.0));
    col += u.sodium.rgb * exp(-above * 10.0) * 0.075 * town * (0.8 + 0.2 * noise(float2(p.x * 3.0, 1.3)));

    // Milky Way: a tilted band of soft clouds with dark dust lanes.
    float2 c = float2(0.52 * aspect, 0.56);
    float2 dir = normalize(float2(1.0, 0.45));
    float2 q = p - c;
    float along = dot(q, dir);
    float across = dot(q, float2(-dir.y, dir.x));
    float width = 0.12 + 0.035 * sin(along * 2.7 + 1.1);
    float band = exp(-(across * across) / (width * width));
    float clouds = fbm(float2(along * 3.2, across * 8.5) + 3.1);
    float lanes = smoothstep(0.48, 0.78, fbm(float2(along * 5.5, across * 15.0) + 11.0))
                * exp(-(across * across) / (0.045 * 0.045));
    float mw = band * (0.30 + 0.70 * clouds * clouds) * (1.0 - 0.75 * lanes) * smoothstep(0.02, 0.22, h);
    col += u.milky.rgb * mw * 0.10;
    // its grain: a dust of sub-pixel stars, denser in the band (static: it is cached)
    float2 cell = floor(uv * u.view.xy / 2.0);
    float g = hash21(cell + 7.0);
    if (g > 1.0 - (0.004 + 0.05 * mw)) {
        col += u.milky.rgb * (0.05 + 0.12 * hash21(cell + 19.0)) * smoothstep(0.0, 0.1, h);
    }

    // Silhouettes: the ridge, two domes, a mast.
    float ridgeMask = smoothstep(rY + px, rY - px, yUp);
    float cx1 = 0.70 * aspect;
    float base1 = ridge(cx1, horizon) - 0.006;
    float d1 = dome(p, cx1, base1, 0.022, 0.036);
    float cx2 = 0.835 * aspect;
    float base2 = ridge(cx2, horizon) - 0.004;
    float d2 = dome(p, cx2, base2, 0.012, 0.019);
    float mastX = 0.605 * aspect;
    float mastBase = ridge(mastX, horizon);
    float dm = max(abs(p.x - mastX) - 0.0016, p.y - (mastBase + 0.048));
    float domeMask = smoothstep(px, -px, min(min(d1, d2), dm));
    float sil = max(ridgeMask, domeMask);

    // rim light on the ridge from the sodium glow
    float3 ink = u.ink.rgb + u.sodium.rgb * 0.03 * exp(-max(rY - yUp, 0.0) / 0.008) * ridgeMask;
    // the open shutter of the big dome: a dim red work light inside
    float slit = step(abs(p.x - cx1 - 0.006), 0.0042) * step(base1 + 0.022 + 0.008, p.y) * smoothstep(px, -px, d1);
    ink += u.brace.rgb * 0.022 * slit;
    col = mix(col, ink, sil);

    // the red lamp by the door (the only light an observatory allows)
    float2 lamp = float2(cx1 - 0.020, base1 + 0.007);
    float ld = length(p - lamp);
    col += u.brace.rgb * (exp(-(ld * ld) / (0.0018 * 0.0018)) * 0.9 + exp(-ld / 0.012) * 0.025);

    // vignette
    float v = length((uv - 0.5) * float2(1.15, 1.0));
    col *= 1.0 - 0.22 * smoothstep(0.55, 1.05, v);
    return float4(col, 1.0);
}

fragment float4 sky_copy_fragment(SkyFSOut in [[stage_in]],
                                  texture2d<float, access::read> bg [[texture(0)]]) {
    uint2 xy = uint2(clamp(in.pos.xy, float2(0.0), float2(bg.get_width() - 1, bg.get_height() - 1)));
    return bg.read(xy);
}

// MARK: - Constellations

struct SkyLineOut {
    float4 pos [[position]];
    float2 uv;                    // along 0..1, across in points
    float lenPt [[flat]];
    float width [[flat]];
    float alpha [[flat]];
    float seed [[flat]];
};

vertex SkyLineOut sky_line_vertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                                  const device Line* lines [[buffer(0)]],
                                  constant Uniforms& u [[buffer(1)]]) {
    const float2 k[4] = { float2(-1.0, -1.0), float2(1.0, -1.0), float2(-1.0, 1.0), float2(1.0, 1.0) };
    Line l = lines[iid];
    float2 A = (u.field.xy + l.ab.xy * u.field.zw) * u.view.xy;
    float2 B = (u.field.xy + l.ab.zw * u.field.zw) * u.view.xy;
    float2 d = B - A;
    float len = max(length(d), 1e-3);
    float2 dir = d / len;
    float2 nor = float2(-dir.y, dir.x);
    float halfPt = l.style.x * 0.5 + 2.0;     // width plus room for the soft edge
    float2 kv = k[vid];
    float along = kv.x * 0.5 + 0.5;
    float2 pp = A + dir * (along * len) + nor * (kv.y * halfPt * u.view.z);

    float alpha = l.style.y;
    float sel = u.focus.x, hov = u.focus.y;
    bool lit = (sel >= 0.0 && (abs(l.style.z - sel) < 0.5 || abs(l.style.w - sel) < 0.5))
            || (hov >= 0.0 && (abs(l.style.z - hov) < 0.5 || abs(l.style.w - hov) < 0.5));
    if (lit) alpha = min(1.0, alpha * 2.4);

    SkyLineOut o;
    o.pos = float4(pp.x / u.view.x * 2.0 - 1.0, 1.0 - pp.y / u.view.y * 2.0, 0.0, 1.0);
    o.uv = float2(along, kv.y * halfPt);
    o.lenPt = len / u.view.z;
    o.width = l.style.x;
    o.alpha = alpha;
    o.seed = l.extra.x;
    return o;
}

fragment float4 sky_line_fragment(SkyLineOut in [[stage_in]],
                                  constant Uniforms& u [[buffer(0)]]) {
    float d = abs(in.uv.y);
    float w = max(in.width * 0.55, 0.45);
    float a = exp(-(d * d) / (w * w)) * in.alpha;
    // stop short of the stars, so a line never crosses a core
    float s = in.uv.x * in.lenPt;
    a *= smoothstep(6.0, 14.0, s) * smoothstep(6.0, 14.0, in.lenPt - s);
    // a spark travelling along the line while Claude is at work (never with Reduce motion)
    if (u.state.w > 0.5 && u.state.z < 0.5) {
        float f = fract(u.view.w / 5.0 + in.seed);
        float t = (in.uv.x - f) * in.lenPt / 5.0;
        a += exp(-t * t) * exp(-(d * d) / 1.5) * in.alpha * 1.6;
    }
    return float4(u.line.rgb * a, 0.0);
}

// MARK: - Stars

struct SkyStarOut {
    float4 pos [[position]];
    float2 local;                 // points from the centre
    float4 col [[flat]];
    float4 b [[flat]];
    float4 c [[flat]];
    float size [[flat]];
    float type [[flat]];
};

vertex SkyStarOut sky_star_vertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                                  const device Instance* inst [[buffer(0)]],
                                  constant Uniforms& u [[buffer(1)]]) {
    const float2 k[4] = { float2(-1.0, -1.0), float2(1.0, -1.0), float2(-1.0, 1.0), float2(1.0, 1.0) };
    Instance s = inst[iid];
    float2 n = s.a.xy;
    if (s.a.w > 0.5) n = u.field.xy + n * u.field.zw;
    float2 center = n * u.view.xy;
    float ext = s.c.w;
    float2 kv = k[vid];
    float2 pp = center + kv * ext * u.view.z;
    SkyStarOut o;
    o.pos = float4(pp.x / u.view.x * 2.0 - 1.0, 1.0 - pp.y / u.view.y * 2.0, 0.0, 1.0);
    o.local = kv * ext;
    o.col = s.col;
    o.b = s.b;
    o.c = s.c;
    o.size = s.a.z;
    o.type = s.a.w;
    return o;
}

fragment float4 sky_star_fragment(SkyStarOut in [[stage_in]],
                                  constant Uniforms& u [[buffer(0)]]) {
    float2 p = in.local;
    float r = length(p);
    float s = max(in.size, 0.3);
    float time = u.view.w;
    bool still = u.state.z > 0.5;

    if (in.type < 0.5) {
        // background field: tiny, faint, decoration only (never mistaken for a project)
        float tw = still ? 1.0 : 0.72 + 0.28 * sin(time * in.b.x + in.b.y);
        float a = exp(-(r * r) / (s * s)) * in.col.a * tw;
        return float4(in.col.rgb * a, 0.0);
    }

    float br = in.col.a;
    float pulse = in.b.z;
    float age = in.b.w;
    float idx = in.c.z;
    bool selected = abs(idx - u.focus.x) < 0.5;
    bool hovered = abs(idx - u.focus.y) < 0.5;
    float3 rgb = float3(0.0);

    float tw = still ? 1.0 : 1.0 + 0.09 * sin(time * in.b.x + in.b.y);
    // pulse: brighter for ~6 s (with Reduce motion the same glow, held still)
    float boost = 1.0 + 1.3 * pulse;
    // another star is in focus: this one steps back a little
    float dim = (u.focus.y >= 0.0 && !hovered && !selected) ? 0.62 : 1.0;

    if (in.c.y > 0.5) {
        // "fuori dai progetti": a hollow ring, no glow
        float ring = exp(-pow((r - s) / 0.8, 2.0)) * 0.75;
        rgb += in.col.rgb * ring * dim;
    } else {
        float core = exp(-(r * r) / pow(0.32 * s, 2.0));
        float glow = exp(-(r * r) / pow(1.15 * s, 2.0)) * 0.55;
        float halo = exp(-r / (2.4 * s)) * 0.09 * (0.5 + br);
        float spikes = 0.0;
        if (br > 0.55) {
            float reach = 4.6 * s;
            float sx = exp(-abs(p.y) * 1.5) * max(0.0, 1.0 - abs(p.x) / reach);
            float sy = exp(-abs(p.x) * 1.5) * max(0.0, 1.0 - abs(p.y) / reach);
            spikes = (sx * sx + sy * sy) * 0.45 * (br - 0.55) / 0.45;
        }
        float k = br * tw * boost * dim;
        float3 white = float3(1.0, 0.97, 0.90);
        rgb += mix(in.col.rgb, white, clamp(core * 0.85, 0.0, 1.0)) * (core * 1.5 + glow + halo + spikes) * k;
        // EDR: the core goes past SDR white where the display has headroom
        float head = clamp(u.state.y, 1.0, 3.0) - 1.0;
        rgb += white * core * head * 0.75 * br * boost;
    }

    // the wave of a pulse, widening from the star (motion only)
    if (pulse > 0.0 && !still) {
        float R = s * 1.6 + age * 24.0;
        float ring = exp(-pow((r - R) / 1.8, 2.0)) * pulse * 0.85;
        rgb += u.sodium.rgb * ring;
    }

    // a Claude session open on this project: a ring that breathes with the load
    if (in.c.x > 0.5) {
        float breath = still ? 0.0 : sin(u.state.x);
        float R = s * 2.3 + 2.0 + 1.3 * breath;
        float ring = exp(-pow((r - R) / 0.9, 2.0)) * (0.55 + 0.2 * breath);
        rgb += u.live.rgb * ring;
    }

    // the finder's reticle: four corners around the selected / hovered star
    if (selected || hovered) {
        float R = s * 2.6 + 8.0;
        float L = 5.0;
        float2 q = abs(p);
        float dv = max(abs(q.x - R), max(R - L - q.y, q.y - R));   // vertical arms
        float dh = max(abs(q.y - R), max(R - L - q.x, q.x - R));   // horizontal arms
        float d = min(dv, dh);
        float a = 1.0 - smoothstep(0.35, 1.0, d);
        rgb += u.reticle.rgb * a * (selected ? 0.95 : 0.55);
    }
    return float4(rgb, 0.0);
}
