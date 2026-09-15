import type { FilterSettings, FilterMode } from '../types';
import { FILTERS_WGSL } from '../shaders/filters.wgsl';
import { WebGpuComputeEngine } from './gpu-compute-pipeline';

const FILTER_MODE_MAP: Record<FilterMode, number> = {
  none: 0,
  grayscale: 1,
  invert: 2,
  brightness_contrast: 3,
  sepia: 4,
  vignette: 5,
  hdr_tonemap: 6,
  bilateral_denoise: 7,
  lanczos_upsample: 8,
};

export class WebGpuVideoRenderer {
  private canvas: HTMLCanvasElement | OffscreenCanvas;
  private adapter: GPUAdapter | null = null;
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private sampler: GPUSampler | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private deviceName: string = 'Unknown WebGPU Device';
  private computeEngine: WebGpuComputeEngine | null = null;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
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

    // @ts-ignore - adapter info in modern browsers
    const info = await this.adapter.requestAdapterInfo?.();
    if (info?.device) {
      this.deviceName = `${info.vendor || ''} ${info.device} (${info.architecture || ''})`.trim();
    } else {
      this.deviceName = 'Hardware Accelerated GPU Adapter';
    }

    this.device = await this.adapter.requestDevice();
    this.configureContext();

    // Create 16-byte aligned uniform buffer
    this.uniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.updateFilterUniforms({
      mode: 'none',
      brightness: 0.0,
      contrast: 1.0,
      saturation: 1.0,
    });

    this.sampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    const shaderModule = this.device.createShaderModule({
      label: 'Video Filter WGSL Module',
      code: FILTERS_WGSL,
    });

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

    const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
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

    // Initialize WebGPU Compute Pipeline Engine (@compute @workgroup_size(16, 16))
    this.computeEngine = WebGpuComputeEngine.create(this.device);
  }

  public getComputeEngine(): WebGpuComputeEngine | null {
    return this.computeEngine;
  }

  private configureContext(): void {
    if (!this.device) {
      return;
    }
    this.context = this.canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!this.context) {
      throw new Error('Failed to acquire WebGPU canvas context');
    }
    this.context.configure({
      device: this.device,
      format: navigator.gpu.getPreferredCanvasFormat(),
      alphaMode: 'opaque',
    });
  }

  public ensureSize(width: number, height: number): void {
    if (this.canvas.width === width && this.canvas.height === height) {
      return;
    }
    this.canvas.width = width;
    this.canvas.height = height;
    this.configureContext();
  }

  /**
   * Render `source` through the WGSL filter pipeline and return a new VideoFrame.
   * Caller owns the returned frame and MUST close it.
   */
  public renderToVideoFrame(source: VideoFrame): VideoFrame {
    this.ensureSize(source.displayWidth || source.codedWidth, source.displayHeight || source.codedHeight);
    this.render(source);
    return new VideoFrame(this.canvas, {
      timestamp: source.timestamp,
      duration: source.duration ?? undefined,
      alpha: 'discard',
    });
  }

  /**
   * Compute 256-bin luminance histogram of a VideoFrame using GPU Compute Shader (<0.5ms).
   */
  public async getLuminanceHistogram(frame: VideoFrame): Promise<Uint32Array | null> {
    if (!this.device || !this.computeEngine) return null;

    const w = frame.displayWidth;
    const h = frame.displayHeight;

    const texture = this.device.createTexture({
      size: [w, h],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.STORAGE_BINDING,
    });

    this.device.queue.copyExternalImageToTexture({ source: frame }, { texture }, [w, h]);

    const commandEncoder = this.device.createCommandEncoder();
    this.computeEngine.dispatchHistogram(commandEncoder, texture, w, h);
    this.device.queue.submit([commandEncoder.finish()]);

    const result = await this.computeEngine.readHistogramAsync();
    texture.destroy();
    return result;
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
    renderPass.draw(6);
    renderPass.end();

    this.device.queue.submit([commandEncoder.finish()]);
  }

  public getDeviceName(): string {
    return this.deviceName;
  }

  public destroy(): void {
    this.computeEngine?.destroy();
    this.uniformBuffer?.destroy();
    this.device?.destroy();
  }
}
