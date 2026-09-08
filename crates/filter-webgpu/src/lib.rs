use wasm_bindgen::prelude::*;

/// Filter type enumeration (analogous to FFmpeg's `libavfilter` nodes).
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpuFilterType {
    PassThrough = 0,
    Grayscale = 1,
    Invert = 2,
    BrightnessContrast = 3,
    ColorGradingLut = 4,
    GaussianBlur = 5,
    HdrToneMapping = 6,
    ComputeBilateralDenoise = 7,
    ComputeLanczosUpsample = 8,
    ComputeHistogram = 9,
}

/// GPU Filter parameter definition block.
#[wasm_bindgen]
#[derive(Debug, Clone)]
pub struct GpuFilterParams {
    pub filter_type: GpuFilterType,
    pub brightness: f32,
    pub contrast: f32,
    pub saturation: f32,
    pub blur_radius: f32,
    pub sigma_spatial: f32,
    pub sigma_range: f32,
}

#[wasm_bindgen]
impl GpuFilterParams {
    #[wasm_bindgen(constructor)]
    pub fn new(filter_type: GpuFilterType) -> Self {
        Self {
            filter_type,
            brightness: 0.0,
            contrast: 1.0,
            saturation: 1.0,
            blur_radius: 0.0,
            sigma_spatial: 2.0,
            sigma_range: 0.15,
        }
    }

    pub fn set_brightness(&mut self, val: f32) {
        self.brightness = val;
    }

    pub fn set_contrast(&mut self, val: f32) {
        self.contrast = val;
    }

    pub fn set_saturation(&mut self, val: f32) {
        self.saturation = val;
    }

    pub fn set_blur_radius(&mut self, val: f32) {
        self.blur_radius = val;
    }

    pub fn set_sigma_spatial(&mut self, val: f32) {
        self.sigma_spatial = val;
    }

    pub fn set_sigma_range(&mut self, val: f32) {
        self.sigma_range = val;
    }
}

