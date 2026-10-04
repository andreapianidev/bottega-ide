#include <metal_stdlib>
using namespace metal;

// An invented volcanic island, seen obliquely as a night cartographic relief.
// Positions are screen-normalized, top-left origin, shared with the SwiftUI caller.

struct IslandUniforms {
    float4 view;
    float4 ocean;
    float4 basalt;
    float4 shore;
    float4 contour;
    float4 capes;
};

struct IslandBeacon {
    float4 position;
    float4 color;
};

struct IslandVertexOut {
    float4 position [[position]];
    float2 uv;
};

vertex IslandVertexOut vedetta_island_vertex(uint vertexID [[vertex_id]]) {
    float2 clip = float2(vertexID == 1 ? 3.0 : -1.0,
                         vertexID == 2 ? 3.0 : -1.0);
    IslandVertexOut out;
    out.position = float4(clip, 0.0, 1.0);
    out.uv = float2(clip.x * 0.5 + 0.5, 0.5 - clip.y * 0.5);
    return out;
}

static float island_height(float2 uv) {
    float2 a = (uv - float2(0.34, 0.43)) / float2(0.23, 0.29);
    float2 b = (uv - float2(0.66, 0.53)) / float2(0.24, 0.27);
    float2 c = (uv - float2(0.51, 0.39)) / float2(0.12, 0.17);
    float ridge = 0.60 * exp(-1.9 * dot(a, a)) + 0.75 * exp(-1.7 * dot(b, b));
    float summit = 0.24 * exp(-2.8 * dot(c, c));
    return clamp(0.15 + ridge + summit, 0.0, 1.0);
}

static float island_distance(float2 uv, float4 capes) {
    float2 q = (uv - float2(0.50, 0.51)) / float2(0.49, 0.42);
    // Between an ellipse and a volcanic plateau; capes face the two outermost
    // projects in the upper and lower halves of the map.
    float superellipse = pow(pow(abs(q.x), 2.8) + pow(abs(q.y), 2.8), 1.0 / 2.8);
    float angle = atan2(q.y, q.x);
    float2 direction = normalize(q + float2(0.0001));
    float projectCapes = 0.090 * pow(max(dot(direction, capes.xy), 0.0), 18.0)
                       + 0.075 * pow(max(dot(direction, capes.zw), 0.0), 17.0);
    float inlet = 0.095 * pow(max(dot(direction, normalize(float2(-0.93, 0.37))), 0.0), 22.0);
    float coast = 0.035 * sin(angle * 3.0 + 0.8) + 0.024 * sin(angle * 5.0 - 1.2)
                + 0.015 * sin(angle * 9.0 + 2.8) + inlet - projectCapes;
    return superellipse + coast;
}

fragment float4 vedetta_island_fragment(IslandVertexOut in [[stage_in]],
                                        constant IslandUniforms &u [[buffer(0)]]) {
    float2 uv = in.uv;
    float2 aspect = float2(u.view.x / max(u.view.y, 1.0), 1.0);
    float distanceToCoast = island_distance(uv, u.capes);
    float land = 1.0 - smoothstep(0.986, 1.014, distanceToCoast);
    float shelf = 1.0 - smoothstep(1.012, 1.095, distanceToCoast);
    float shadow = 1.0 - smoothstep(0.99, 1.065, island_distance(uv - float2(0.007, 0.020), u.capes));

    float2 waterUV = uv * aspect;
    float current = sin(waterUV.x * 47.0 + waterUV.y * 12.0 + sin(waterUV.y * 18.0));
    float longWave = sin(waterUV.x * 18.0 - waterUV.y * 29.0);
    float gridX = 1.0 - smoothstep(0.0, 0.006, abs(fract(uv.x * 11.0) - 0.5));
    float gridY = 1.0 - smoothstep(0.0, 0.006, abs(fract(uv.y * 8.0) - 0.5));
    float3 ocean = u.ocean.rgb + float3(0.008, 0.014, 0.028)
                 + float3(0.004, 0.009, 0.018) * (0.5 + 0.5 * current) * (0.55 + 0.45 * longWave);
    ocean += float3(0.006, 0.009, 0.018) * (gridX + gridY);
    ocean *= 1.0 - 0.38 * shadow * (1.0 - land);

    float height = island_height(uv);
    float3 normal = normalize(float3((island_height(uv + float2(0.003, 0.0)) - height) * -65.0,
                                     (island_height(uv + float2(0.0, 0.003)) - height) * -65.0,
                                     1.0));
    float light = 0.58 + 0.35 * max(0.0, dot(normal, normalize(float3(-0.47, -0.66, 0.62))));
    float strata = sin(uv.x * 77.0 + height * 26.0) * sin(uv.y * 57.0 - height * 18.0);
    float3 high = float3(0.048, 0.078, 0.110);
    float3 basalt = mix(u.basalt.rgb * 0.60, high, smoothstep(0.18, 0.94, height));
    basalt *= light + 0.16;
    basalt += float3(0.002, 0.003, 0.005) * (0.5 + 0.5 * strata);

    float level = height * 14.0;
    float contourDistance = abs(fract(level) - 0.5);
    float contourWidth = max(0.019, fwidth(level) * 0.55);
    float contour = 1.0 - smoothstep(contourWidth, contourWidth * 2.1, contourDistance);
    basalt += u.contour.rgb * contour * 0.045;

    // A thin warm shore reads as the map's edge, with a cooler outer shelf.
    float shore = exp(-pow((distanceToCoast - 0.998) / 0.0045, 2.0));
    float3 color = mix(ocean, basalt, land);
    color += float3(0.025, 0.055, 0.080) * shelf * (1.0 - land);
    color += u.shore.rgb * shore * 0.13;
    float vignette = 1.0 - 0.24 * dot((uv - 0.5) * float2(0.88, 1.0), (uv - 0.5) * float2(0.88, 1.0));
    return float4(max(color * vignette, 0.0), 1.0);
}

struct BeaconOut {
    float4 position [[position]];
    float2 local;
    float4 color;
    float focus;
};

vertex BeaconOut vedetta_beacon_vertex(uint vertexID [[vertex_id]],
                                       uint instanceID [[instance_id]],
                                       constant IslandBeacon *beacons [[buffer(0)]],
                                       constant IslandUniforms &u [[buffer(1)]]) {
    IslandBeacon beacon = beacons[instanceID];
    float2 corner = float2(vertexID & 1 ? 1.0 : -1.0, vertexID & 2 ? 1.0 : -1.0);
    float2 center = float2(beacon.position.x * 2.0 - 1.0, 1.0 - beacon.position.y * 2.0);
    float2 offset = corner * beacon.position.z / u.view.xy;
    BeaconOut out;
    out.position = float4(center + float2(offset.x, -offset.y), 0.0, 1.0);
    out.local = corner;
    out.color = beacon.color;
    out.focus = beacon.position.w;
    return out;
}

fragment float4 vedetta_beacon_fragment(BeaconOut in [[stage_in]],
                                        constant IslandUniforms &u [[buffer(0)]]) {
    float radius = length(in.local);
    float pulse = in.color.a;
    float breath = u.view.w > 0.5 ? 0.0 : 0.5 + 0.5 * sin(u.view.z * 2.1);
    float halo = exp(-radius * radius * 8.0) * (0.28 + pulse * 0.22);
    float outerRing = exp(-pow((radius - (0.69 + 0.045 * breath)) / 0.035, 2.0));
    float focusRing = exp(-pow((radius - 0.88) / 0.020, 2.0)) * in.focus;
    float core = 1.0 - smoothstep(0.13, 0.23, radius);
    float glint = exp(-pow(in.local.x / 0.045, 2.0)) * exp(-pow(in.local.y / 0.34, 2.0)) * 0.23;
    float alpha = clamp(core + halo + outerRing * 0.29 + focusRing * 0.46 + glint, 0.0, 1.0);
    float3 light = in.color.rgb * (core * 2.1 + halo * 1.8 + outerRing * 0.44 + focusRing * 0.8)
                 + float3(0.25, 0.29, 0.33) * core;
    return float4(light * alpha, alpha);
}
