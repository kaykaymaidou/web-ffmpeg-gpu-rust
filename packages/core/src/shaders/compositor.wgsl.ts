// WebGPU WGSL Multi-Stream Video Compositor Shader
// Supports hardware-accelerated viewport rendering, SDF rounded corners, anti-aliasing, borders, and alpha blending.

export const COMPOSITOR_WGSL = /* wgsl */ `
struct ChannelUniforms {
  opacity: f32,          // [0.0, 1.0] alpha opacity
  border_radius: f32,    // [0.0, 0.5] normalized corner radius
  border_width: f32,     // [0.0, 0.1] normalized border thickness
  pad0: f32,
  border_color: vec4<f32>, // RGBA border highlight (e.g. golden active speaker)
  aspect_mode: u32,      // 0: fill, 1: contain (letterbox), 2: cover (crop)
  src_aspect: f32,       // Source video aspect ratio (width / height)
  dst_aspect: f32,       // Destination viewport aspect ratio (width / height)
  pad1: f32,
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
@group(0) @binding(2) var<uniform> params: ChannelUniforms;

// 2D Signed Distance Field (SDF) of a rounded rectangle centered at origin
fn rounded_box_sdf(p: vec2<f32>, b: vec2<f32>, r: f32) -> f32 {
  let q = abs(p) - b + vec2<f32>(r, r);
  return length(max(q, vec2<f32>(0.0, 0.0))) + min(max(q.x, q.y), 0.0) - r;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  // Center UV coordinates to [-0.5, 0.5]
  let p = in.uv - vec2<f32>(0.5, 0.5);
  let half_size = vec2<f32>(0.5, 0.5);
  let r = clamp(params.border_radius, 0.0, 0.5);

  let d = rounded_box_sdf(p, half_size, r);

  // Anti-aliased outer edge mask (smoothing over ~1.5 screen pixels)
  let edge_width = 0.005;
  let alpha_mask = smoothstep(edge_width, -edge_width, d);

  if (alpha_mask <= 0.001) {
    discard;
  }

  // Adjust UV according to aspect mode
  var sample_uv = in.uv;
  if (params.aspect_mode == 1u) {
    // Contain (letterbox / pillarbox)
    if (params.src_aspect > params.dst_aspect) {
      let scale = params.dst_aspect / params.src_aspect;
      sample_uv.y = (sample_uv.y - 0.5) / scale + 0.5;
      if (sample_uv.y < 0.0 || sample_uv.y > 1.0) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.8 * params.opacity * alpha_mask);
      }
    } else if (params.src_aspect < params.dst_aspect) {
      let scale = params.src_aspect / params.dst_aspect;
      sample_uv.x = (sample_uv.x - 0.5) / scale + 0.5;
      if (sample_uv.x < 0.0 || sample_uv.x > 1.0) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.8 * params.opacity * alpha_mask);
      }
    }
  } else if (params.aspect_mode == 2u) {
    // Cover (center crop)
    if (params.src_aspect > params.dst_aspect) {
      let scale = params.src_aspect / params.dst_aspect;
      sample_uv.x = (sample_uv.x - 0.5) * scale + 0.5;
    } else if (params.src_aspect < params.dst_aspect) {
      let scale = params.dst_aspect / params.src_aspect;
      sample_uv.y = (sample_uv.y - 0.5) * scale + 0.5;
    }
  }

  // Sample video frame texture
  let video_color = textureSampleLevel(video_texture, video_sampler, sample_uv);

  // Render border if defined
  var final_rgb = video_color.rgb;
  let bw = params.border_width;
  if (bw > 0.001 && params.border_color.a > 0.001) {
    let border_factor = smoothstep(-bw - edge_width, -bw + edge_width, d);
    final_rgb = mix(video_color.rgb, params.border_color.rgb, border_factor * params.border_color.a);
  }

  let final_alpha = alpha_mask * params.opacity;
  return vec4<f32>(final_rgb, final_alpha);
}
`;
