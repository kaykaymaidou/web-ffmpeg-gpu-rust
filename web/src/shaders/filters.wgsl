// WebGPU WGSL Filter Pipeline Shader (High Performance Video Post-Processing)

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
  }

  return vec4<f32>(clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0)), color.a);
}
