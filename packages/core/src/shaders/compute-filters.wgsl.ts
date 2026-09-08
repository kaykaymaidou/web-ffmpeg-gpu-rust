// WebGPU Compute Shader Suite for Media Processing (@compute @workgroup_size(16, 16))

export const BILATERAL_DENOISE_COMPUTE_WGSL = /* wgsl */ `
struct ComputeParams {
  width: u32,
  height: u32,
  sigma_spatial: f32, // Spatial distance sigma (default ~2.0)
  sigma_range: f32,   // Color difference sigma (default ~0.15)
};

@group(0) @binding(0) var input_tex: texture_2d<f32>;
@group(0) @binding(1) var output_tex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params: ComputeParams;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  // FAIL-11 Defense: Boundary check for non-multiple-of-16 dimensions
  if (global_id.x >= params.width || global_id.y >= params.height) {
    return;
  }

  let center_pos = vec2<i32>(global_id.xy);
  let center_col = textureLoad(input_tex, center_pos, 0);

  let two_sigma_s_sq = 2.0 * params.sigma_spatial * params.sigma_spatial;
  let two_sigma_r_sq = 2.0 * params.sigma_range * params.sigma_range;

  var color_sum = vec3<f32>(0.0);
  var weight_sum = 0.0;

  let radius: i32 = 2; // 5x5 neighborhood window

  for (var dy = -radius; dy <= radius; dy = dy + 1) {
    for (var dx = -radius; dx <= radius; dx = dx + 1) {
      let sample_pos = clamp(
        center_pos + vec2<i32>(dx, dy),
        vec2<i32>(0),
        vec2<i32>(i32(params.width) - 1, i32(params.height) - 1)
      );

      let sample_col = textureLoad(input_tex, sample_pos, 0);

      // Spatial Euclidean distance Gaussian weight
      let dist_sq = f32(dx * dx + dy * dy);
      let spatial_w = exp(-dist_sq / two_sigma_s_sq);

      // Photometric color difference Gaussian weight
      let color_diff = sample_col.rgb - center_col.rgb;
      let range_dist_sq = dot(color_diff, color_diff);
      let range_w = exp(-range_dist_sq / two_sigma_r_sq);

      let w = spatial_w * range_w;
      color_sum = color_sum + sample_col.rgb * w;
      weight_sum = weight_sum + w;
    }
  }

  let filtered_rgb = color_sum / max(weight_sum, 0.00001);
  textureStore(output_tex, center_pos, vec4<f32>(filtered_rgb, center_col.a));
}
`;

export const LANCZOS_UPSAMPLE_COMPUTE_WGSL = /* wgsl */ `
struct UpsampleParams {
  in_width: u32,
  in_height: u32,
  out_width: u32,
  out_height: u32,
};

@group(0) @binding(0) var input_tex: texture_2d<f32>;
@group(0) @binding(1) var output_tex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params: UpsampleParams;

const PI: f32 = 3.141592653589793;

fn sinc(x: f32) -> f32 {
  if (abs(x) < 0.0001) {
    return 1.0;
  }
  let px = x * PI;
  return sin(px) / px;
}

fn lanczos2(x: f32) -> f32 {
  if (abs(x) >= 2.0) {
    return 0.0;
  }
  return sinc(x) * sinc(x * 0.5);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  // FAIL-11 Defense: Boundary check
  if (global_id.x >= params.out_width || global_id.y >= params.out_height) {
    return;
  }

  // Continuous source coordinates
  let u = (f32(global_id.x) + 0.5) * f32(params.in_width) / f32(params.out_width) - 0.5;
  let v = (f32(global_id.y) + 0.5) * f32(params.in_height) / f32(params.out_height) - 0.5;

  let base_x = i32(floor(u));
  let base_y = i32(floor(v));

  var color_sum = vec3<f32>(0.0);
  var weight_sum = 0.0;

  // 4x4 Lanczos reconstruction kernel
  for (var j: i32 = -1; j <= 2; j = j + 1) {
    let py = base_y + j;
    let wy = lanczos2(v - f32(py));
    let clamped_y = clamp(py, 0, i32(params.in_height) - 1);

    for (var i: i32 = -1; i <= 2; i = i + 1) {
      let px = base_x + i;
      let wx = lanczos2(u - f32(px));
      let clamped_x = clamp(px, 0, i32(params.in_width) - 1);

      let w = wx * wy;
      let sample = textureLoad(input_tex, vec2<i32>(clamped_x, clamped_y), 0);
      color_sum = color_sum + sample.rgb * w;
      weight_sum = weight_sum + w;
    }
  }

  let final_rgb = clamp(color_sum / max(weight_sum, 0.00001), vec3<f32>(0.0), vec3<f32>(1.0));
  textureStore(output_tex, vec2<i32>(global_id.xy), vec4<f32>(final_rgb, 1.0));
}
`;

export const HISTOGRAM_COMPUTE_WGSL = /* wgsl */ `
struct HistogramParams {
  width: u32,
  height: u32,
  pad0: u32,
  pad1: u32,
};

@group(0) @binding(0) var input_tex: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> histogram: array<atomic<u32>, 256>;
@group(0) @binding(2) var<uniform> params: HistogramParams;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  // FAIL-11 Defense: Boundary check
  if (global_id.x >= params.width || global_id.y >= params.height) {
    return;
  }

  let col = textureLoad(input_tex, vec2<i32>(global_id.xy), 0);

  // Rec.709 Luma calculation
  let luma = dot(col.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
  let bin = u32(clamp(luma * 255.0, 0.0, 255.0));

  atomicAdd(&histogram[bin], 1u);
}
`;
