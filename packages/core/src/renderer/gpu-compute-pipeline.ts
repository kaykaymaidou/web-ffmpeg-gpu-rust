import {
  BILATERAL_DENOISE_COMPUTE_WGSL,
  LANCZOS_UPSAMPLE_COMPUTE_WGSL,
  HISTOGRAM_COMPUTE_WGSL,
} from '../shaders/compute-filters.wgsl';

export class WebGpuComputeEngine {
  private device: GPUDevice;

  private denoisePipeline: GPUComputePipeline;
  private upsamplePipeline: GPUComputePipeline;
  private histogramPipeline: GPUComputePipeline;

  private denoiseUniformBuffer: GPUBuffer;
  private upsampleUniformBuffer: GPUBuffer;
  private histogramUniformBuffer: GPUBuffer;

  private histogramBuffer: GPUBuffer;
  private histogramStagingBuffer: GPUBuffer;

  private constructor(
    device: GPUDevice,
    denoisePipeline: GPUComputePipeline,
    upsamplePipeline: GPUComputePipeline,
    histogramPipeline: GPUComputePipeline,
    denoiseUniformBuffer: GPUBuffer,
    upsampleUniformBuffer: GPUBuffer,
    histogramUniformBuffer: GPUBuffer,
    histogramBuffer: GPUBuffer,
    histogramStagingBuffer: GPUBuffer
  ) {
    this.device = device;
    this.denoisePipeline = denoisePipeline;
    this.upsamplePipeline = upsamplePipeline;
    this.histogramPipeline = histogramPipeline;
    this.denoiseUniformBuffer = denoiseUniformBuffer;
    this.upsampleUniformBuffer = upsampleUniformBuffer;
    this.histogramUniformBuffer = histogramUniformBuffer;
    this.histogramBuffer = histogramBuffer;
    this.histogramStagingBuffer = histogramStagingBuffer;
  }

  public static create(device: GPUDevice): WebGpuComputeEngine {
    // 1. Bilateral Denoise Pipeline
    const denoiseModule = device.createShaderModule({
      label: 'Bilateral Denoise Compute Module',
      code: BILATERAL_DENOISE_COMPUTE_WGSL,
    });
    const denoisePipeline = device.createComputePipeline({
      label: 'Bilateral Denoise Pipeline',
      layout: 'auto',
      compute: {
        module: denoiseModule,
        entryPoint: 'main',
      },
    });

    // 2. Lanczos Upsample Pipeline
    const upsampleModule = device.createShaderModule({
      label: 'Lanczos Upsample Compute Module',
      code: LANCZOS_UPSAMPLE_COMPUTE_WGSL,
    });
    const upsamplePipeline = device.createComputePipeline({
      label: 'Lanczos Upsample Pipeline',
      layout: 'auto',
      compute: {
        module: upsampleModule,
        entryPoint: 'main',
      },
    });

    // 3. 256-Bin Histogram Pipeline
    const histogramModule = device.createShaderModule({
      label: 'Histogram Compute Module',
      code: HISTOGRAM_COMPUTE_WGSL,
    });
    const histogramPipeline = device.createComputePipeline({
      label: 'Histogram Pipeline',
      layout: 'auto',
      compute: {
        module: histogramModule,
        entryPoint: 'main',
      },
    });

    // Create 16-byte uniform buffers
    const denoiseUniformBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const upsampleUniformBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const histogramUniformBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Histogram storage: 256 bins * 4 bytes = 1024 bytes
    const histogramBuffer = device.createBuffer({
      size: 1024,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    const histogramStagingBuffer = device.createBuffer({
      size: 1024,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    return new WebGpuComputeEngine(
      device,
      denoisePipeline,
      upsamplePipeline,
      histogramPipeline,
      denoiseUniformBuffer,
      upsampleUniformBuffer,
      histogramUniformBuffer,
      histogramBuffer,
      histogramStagingBuffer
    );
  }

  /**
   * Dispatch Bilateral Denoising Compute Pass (@compute @workgroup_size(16, 16)).
   * Includes FAIL-11 boundary protection.
   */
  public dispatchBilateralDenoise(
    commandEncoder: GPUCommandEncoder,
    inputTexture: GPUTexture,
    outputTexture: GPUTexture,
    width: number,
    height: number,
    sigmaSpatial: number = 2.0,
    sigmaRange: number = 0.15
  ): void {
    // Update uniform buffer: [width: u32, height: u32, sigmaSpatial: f32, sigmaRange: f32]
    const u32Buf = new Uint32Array(4);
    const f32Buf = new Float32Array(u32Buf.buffer);
    u32Buf[0] = width;
    u32Buf[1] = height;
    f32Buf[2] = sigmaSpatial;
    f32Buf[3] = sigmaRange;

    this.device.queue.writeBuffer(this.denoiseUniformBuffer, 0, u32Buf.buffer);

    const bindGroup = this.device.createBindGroup({
      layout: this.denoisePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: inputTexture.createView() },
        { binding: 1, resource: outputTexture.createView() },
        { binding: 2, resource: { buffer: this.denoiseUniformBuffer } },
      ],
    });

    const pass = commandEncoder.beginComputePass({
      label: 'Bilateral Denoise Pass',
    });
    pass.setPipeline(this.denoisePipeline);
    pass.setBindGroup(0, bindGroup);

    // FAIL-11 Defense: ceil(width / 16), ceil(height / 16)
    const workgroupsX = Math.ceil(width / 16);
    const workgroupsY = Math.ceil(height / 16);
    pass.dispatchWorkgroups(workgroupsX, workgroupsY);
    pass.end();
  }

  /**
   * Dispatch Lanczos2/3 Super-Resolution Spatial Upsampling (@compute @workgroup_size(16, 16)).
   */
  public dispatchLanczosUpsample(
    commandEncoder: GPUCommandEncoder,
    inputTexture: GPUTexture,
    outputTexture: GPUTexture,
    inWidth: number,
    inHeight: number,
    outWidth: number,
    outHeight: number
  ): void {
    const u32Buf = new Uint32Array([inWidth, inHeight, outWidth, outHeight]);
    this.device.queue.writeBuffer(this.upsampleUniformBuffer, 0, u32Buf.buffer);

    const bindGroup = this.device.createBindGroup({
      layout: this.upsamplePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: inputTexture.createView() },
        { binding: 1, resource: outputTexture.createView() },
        { binding: 2, resource: { buffer: this.upsampleUniformBuffer } },
      ],
    });

    const pass = commandEncoder.beginComputePass({
      label: 'Lanczos Upsample Pass',
    });
    pass.setPipeline(this.upsamplePipeline);
    pass.setBindGroup(0, bindGroup);

    const workgroupsX = Math.ceil(outWidth / 16);
    const workgroupsY = Math.ceil(outHeight / 16);
    pass.dispatchWorkgroups(workgroupsX, workgroupsY);
    pass.end();
  }

  /**
   * Dispatch 256-Bin Luminance Histogram calculation in parallel.
   */
  public dispatchHistogram(
    commandEncoder: GPUCommandEncoder,
    inputTexture: GPUTexture,
    width: number,
    height: number
  ): void {
    // Clear the 1024-byte atomic histogram buffer
    commandEncoder.clearBuffer(this.histogramBuffer, 0, 1024);

    const u32Buf = new Uint32Array([width, height, 0, 0]);
    this.device.queue.writeBuffer(this.histogramUniformBuffer, 0, u32Buf.buffer);

    const bindGroup = this.device.createBindGroup({
      layout: this.histogramPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: inputTexture.createView() },
        { binding: 1, resource: { buffer: this.histogramBuffer } },
        { binding: 2, resource: { buffer: this.histogramUniformBuffer } },
      ],
    });

    const pass = commandEncoder.beginComputePass({
      label: 'Histogram Compute Pass',
    });
    pass.setPipeline(this.histogramPipeline);
    pass.setBindGroup(0, bindGroup);

    const workgroupsX = Math.ceil(width / 16);
    const workgroupsY = Math.ceil(height / 16);
    pass.dispatchWorkgroups(workgroupsX, workgroupsY);
    pass.end();

    // Copy to staging buffer for CPU readback
    commandEncoder.copyBufferToBuffer(this.histogramBuffer, 0, this.histogramStagingBuffer, 0, 1024);
  }

  /**
   * Read back the calculated 256-bin histogram from GPU staging memory.
   */
  public async readHistogramAsync(): Promise<Uint32Array> {
    await this.histogramStagingBuffer.mapAsync(GPUMapMode.READ);
    const copy = new Uint32Array(this.histogramStagingBuffer.getMappedRange().slice(0));
    this.histogramStagingBuffer.unmap();
    return copy;
  }

  public destroy(): void {
    this.denoiseUniformBuffer.destroy();
    this.upsampleUniformBuffer.destroy();
    this.histogramUniformBuffer.destroy();
    this.histogramBuffer.destroy();
    this.histogramStagingBuffer.destroy();
  }
}
