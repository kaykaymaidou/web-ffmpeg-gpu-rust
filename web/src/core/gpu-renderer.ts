import type { FilterSettings, FilterMode } from './types';
import filtersShaderCode from '../shaders/filters.wgsl?raw';

const FILTER_MODE_MAP: Record<FilterMode, number> = {
  none: 0,
  grayscale: 1,
  invert: 2,
  brightness_contrast: 3,
  sepia: 4,
  vignette: 5,
};

export class WebGpuVideoRenderer {
  private canvas: HTMLCanvasElement;
  private adapter: GPUAdapter | null = null;
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private sampler: GPUSampler | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private deviceName: string = 'Unknown WebGPU Device';

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  public async initialize(): Promise<void> {
    if (!navigator.gpu) {
      throw new Error('WebGPU is not supported in this browser. Please use Chrome 113+, Edge 113+ or enable WebGPU flags.');
    }

    this.adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
    });

    if (!this.adapter) {
      throw new Error('Failed to find a suitable WebGPU adapter (GPU may be disabled or unsupported).');
    }

    // Capture device name
    // @ts-ignore - info may be available on modern browsers
    const info = await this.adapter.requestAdapterInfo?.();
    if (info?.device) {
      this.deviceName = `${info.vendor || ''} ${info.device} (${info.architecture || ''})`.trim();
    } else {
      this.deviceName = 'Hardware Accelerated GPU Adapter';
    }

    this.device = await this.adapter.requestDevice();
    this.context = this.canvas.getContext('webgpu') as GPUCanvasContext;

    const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: presentationFormat,
      alphaMode: 'opaque',
    });

    // Create uniform buffer for filter settings
    // 4 floats / uint32 = 16 bytes aligned
    this.uniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Initial default filter uniforms
    this.updateFilterUniforms({
      mode: 'none',
      brightness: 0.0,
      contrast: 1.0,
      saturation: 1.0,
    });

    // Create linear clamp sampler
    this.sampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    // Create shader module
    const shaderModule = this.device.createShaderModule({
      label: 'Video Filter WGSL Module',
      code: filtersShaderCode,
    });

    // Define bind group layout
    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          externalTexture: {},
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: presentationFormat }],
      },
      primitive: {
        topology: 'triangle-list',
      },
    });
  }

  public updateFilterUniforms(settings: FilterSettings): void {
    if (!this.device || !this.uniformBuffer) return;

    const bufferData = new ArrayBuffer(16);
    const u32View = new Uint32Array(bufferData);
    const f32View = new Float32Array(bufferData);

    u32View[0] = FILTER_MODE_MAP[settings.mode] ?? 0;
    f32View[1] = settings.brightness;
    f32View[2] = settings.contrast;
    f32View[3] = settings.saturation;

    this.device.queue.writeBuffer(this.uniformBuffer, 0, bufferData);
  }

  public render(frame: VideoFrame): void {
    if (!this.device || !this.context || !this.pipeline || !this.sampler || !this.uniformBuffer || !this.bindGroupLayout) {
      return;
    }

    // Zero-copy import of the VideoFrame directly into WebGPU
    const externalTexture = this.device.importExternalTexture({
      source: frame,
    });

    const bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: externalTexture },
        { binding: 2, resource: { buffer: this.uniformBuffer } },
      ],
    });

    const commandEncoder = this.device.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();

    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: textureView,
          clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });

    renderPass.setPipeline(this.pipeline);
    renderPass.setBindGroup(0, bindGroup);
    renderPass.draw(6); // 2 triangles
    renderPass.end();

    this.device.queue.submit([commandEncoder.finish()]);
  }

  public getDeviceName(): string {
    return this.deviceName;
  }

  public destroy(): void {
    this.uniformBuffer?.destroy();
    this.device?.destroy();
  }
}
