// WebGPU WGSL Filter Pipeline Shader (Embedded for zero-dependency bundler compatibility)

export const FILTERS_WGSL = /* wgsl */ `
struct FilterUniforms {
  filter_mode: u32,    // 0: Pass, 1: Grayscale, 2: Invert, 3: Brightness/Contrast, 4: Sepia, 5: Vignette
  brightness: f32,     // offset [-1.0, 1.0]
  contrast: f32,       // scale [0.0, 3.0]
  saturation: f32,     // [0.0, 3.0]
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
  var pos = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0)
  );
  var uvs = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 0.0),
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(1.0, 0.0)
  );

  var out: VertexOutput;
  out.position = vec4<f32>(pos[vertex_index], 0.0, 1.0);
  out.uv = uvs[vertex_index];
  return out;
}

@group(0) @binding(0) var video_sampler: sampler;
@group(0) @binding(1) var video_texture: texture_external;
@group(0) @binding(2) var<uniform> params: FilterUniforms;

// Linear BT.2020 to linear BT.709 color matrix transform (ITU-R BT.2087)
fn bt2020_to_bt709(c: vec3<f32>) -> vec3<f32> {
  let r =  1.6604910 * c.r - 0.5876411 * c.g - 0.0728499 * c.b;
  let g = -0.1245505 * c.r + 1.1328999 * c.g - 0.0083494 * c.b;
  let b = -0.0181508 * c.r - 0.1005789 * c.g + 1.1187297 * c.b;
  return max(vec3<f32>(r, g, b), vec3<f32>(0.0));
}

// ACES Filmic Tone Mapping Curve (Narkowicz 2015)
fn aces_filmic(x: vec3<f32>) -> vec3<f32> {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  var color = textureSampleBaseClampToEdge(video_texture, video_sampler, in.uv);

  // Apply brightness & contrast
  var rgb = (color.rgb - 0.5) * params.contrast + 0.5 + params.brightness;

  // Apply saturation
  let luma = dot(rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3<f32>(luma), rgb, params.saturation);

  // Switch filter mode
  if (params.filter_mode == 1u) {
    // Grayscale
    let gray = dot(rgb, vec3<f32>(0.299, 0.587, 0.114));
    rgb = vec3<f32>(gray);
  } else if (params.filter_mode == 2u) {
    // Invert
    rgb = vec3<f32>(1.0) - rgb;
  } else if (params.filter_mode == 4u) {
    // Sepia Retro Film
    let r = dot(rgb, vec3<f32>(0.393, 0.769, 0.189));
    let g = dot(rgb, vec3<f32>(0.349, 0.686, 0.168));
    let b = dot(rgb, vec3<f32>(0.272, 0.534, 0.131));
    rgb = vec3<f32>(r, g, b);
  } else if (params.filter_mode == 5u) {
    // Vignette
    let d = distance(in.uv, vec2<f32>(0.5, 0.5));
    let vignette = smoothstep(0.8, 0.2, d);
    rgb = rgb * vignette;
  } else if (params.filter_mode == 6u) {
    // HDR10 (BT.2020 PQ/HLG) to SDR Filmic Tone Mapping & Gamut Compression
    let hdr_linear = pow(max(rgb * 1.6, vec3<f32>(0.0)), vec3<f32>(1.2));
    let bt709_color = bt2020_to_bt709(hdr_linear);
    let mapped = aces_filmic(bt709_color);
    rgb = pow(mapped, vec3<f32>(1.0 / 1.05));
  }

  return vec4<f32>(clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0)), color.a);
}
`;
