#include <metal_stdlib>
using namespace metal;

struct RegiaVertexOut { float4 position [[position]]; float2 uv; };

vertex RegiaVertexOut regia_chart_vertex(uint id [[vertex_id]]) {
    float2 clip = float2(id == 1 ? 3.0 : -1.0, id == 2 ? 3.0 : -1.0);
    return { float4(clip, 0, 1), float2(clip.x * 0.5 + 0.5, 0.5 - clip.y * 0.5) };
}

fragment float4 regia_chart_fragment(RegiaVertexOut in [[stage_in]],
                                     constant float4 *rows [[buffer(0)]],
                                     constant float4 &info [[buffer(1)]]) {
    float2 uv = in.uv;
    float count = max(info.x, 1.0);
    float rowFloat = floor(uv.y * count);
    int row = clamp(int(rowFloat), 0, 13);
    float localY = fract(uv.y * count);
    float4 values = rows[row];
    float maxValue = max(info.y, 1.0);
    float x = (uv.x - 0.025) / 0.95;
    float3 base = float3(0.018, 0.031, 0.055);
    // Guide at 25/50/75/100%, aligned across every project.
    float guide = 1.0 - smoothstep(0.001, 0.003, abs(fract(x * 4.0) - 0.5));
    base += guide * float3(0.008, 0.014, 0.026);
    float track = smoothstep(0.20, 0.27, localY) * (1.0 - smoothstep(0.73, 0.80, localY));
    float rounded = smoothstep(0.025, 0.0, abs(localY - 0.5) - 0.25);
    base = mix(base, float3(0.040, 0.065, 0.104), track * 0.72);
    float total = values.x + values.y + values.z + values.w;
    float filled = total / maxValue;
    if (x >= 0.0 && x <= filled && filled > 0.0) {
        float px = x * maxValue;
        float3 color = float3(0.56, 0.28, 0.04); // sodio, attesa
        if (px >= values.x) color = float3(0.57, 0.075, 0.17); // brace, errore
        if (px >= values.x + values.y) color = float3(0.17, 0.49, 0.28); // laurisilva, in corso
        if (px >= values.x + values.y + values.z) color = float3(0.10, 0.21, 0.70); // stella, coda
        float edge = smoothstep(0.0, 0.007, x) * (1.0 - smoothstep(filled - 0.007, filled, x));
        base = mix(base, color, rounded * edge);
        base += color * 0.10 * exp(-30.0 * abs(localY - 0.5)) * edge;
    }
    float divider = 1.0 - smoothstep(0.0, 0.013, abs(localY));
    base += divider * float3(0.015, 0.022, 0.039);
    return float4(base, 1.0);
}
