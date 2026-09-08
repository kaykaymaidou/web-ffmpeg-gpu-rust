import { COMPOSITOR_WGSL } from '../shaders/compositor.wgsl';

export type CompositorLayoutPreset =
  | 'single'
  | 'pip_br'
  | 'pip_tr'
  | 'pip_bl'
  | 'pip_tl'
  | 'split_horizontal'
  | 'split_vertical'
  | 'grid_2x2'
  | 'custom';

export type AspectRatioMode = 'fill' | 'contain' | 'cover';

export interface ChannelLayout {
  channelId: string;
  x: number;              // [0.0, 1.0] normalized left
  y: number;              // [0.0, 1.0] normalized top
  width: number;          // [0.0, 1.0] normalized width
  height: number;         // [0.0, 1.0] normalized height
  zIndex?: number;        // Stacking order (higher renders on top)
  opacity?: number;       // [0.0, 1.0] alpha
  borderRadius?: number;  // [0.0, 0.5] corner radius
  borderWidth?: number;   // [0.0, 0.1] border thickness
  borderColor?: [number, number, number, number]; // RGBA [0..1]
  aspectMode?: AspectRatioMode;
  visible?: boolean;
}

export interface ChannelState {
  channelId: string;
  layout: ChannelLayout;
  currentFrame: VideoFrame | null;
  lastFrameTimestamp: number;
  totalFramesIngested: number;
  uniformBuffer: GPUBuffer | null;
}

export interface MultiCompositorOptions {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  clearColor?: { r: number; g: number; b: number; a: number };
  initialPreset?: CompositorLayoutPreset;
}

export class WebGpuMultiStreamCompositor {
  private canvas: HTMLCanvasElement | OffscreenCanvas;
  private clearColor = { r: 0.04, g: 0.06, b: 0.1, a: 1.0 };
  private adapter: GPUAdapter | null = null;
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private sampler: GPUSampler | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private channels = new Map<string, ChannelState>();
  private currentPreset: CompositorLayoutPreset = 'single';
  private initialized = false;

  constructor(options: MultiCompositorOptions) {
    this.canvas = options.canvas;
    if (options.clearColor) {
      this.clearColor = options.clearColor;
    }
    if (options.initialPreset) {
      this.currentPreset = options.initialPreset;
    }
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;

    if (!navigator.gpu) {
      throw new Error('WebGPU is not supported in this environment.');
    }

    this.adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
    });

    if (!this.adapter) {
      throw new Error('Failed to find a suitable WebGPU adapter.');
    }

    this.device = await this.adapter.requestDevice();
    this.context = this.canvas.getContext('webgpu') as GPUCanvasContext;

    const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: presentationFormat,
      alphaMode: 'opaque',
    });

    this.sampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    const shaderModule = this.device.createShaderModule({
      label: 'Multi-Stream Compositor WGSL Module',
      code: COMPOSITOR_WGSL,
    });

    this.bindGroupLayout = this.device.createBindGroupLayout({
      label: 'Compositor Bind Group Layout',
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
      label: 'Compositor Render Pipeline',
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [
          {
            format: presentationFormat,
            blend: {
              color: {
                srcFactor: 'src-alpha',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
              alpha: {
                srcFactor: 'one',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
            },
          },
        ],
      },
      primitive: {
        topology: 'triangle-list',
      },
    });

    this.initialized = true;
  }

  /**
   * Register a new video stream channel.
   */
  public addChannel(channelId: string, initialLayout?: Partial<ChannelLayout>): void {
    if (this.channels.has(channelId)) return;

    const defaultLayout: ChannelLayout = {
      channelId,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      zIndex: 0,
      opacity: 1.0,
      borderRadius: 0.0,
      borderWidth: 0.0,
      borderColor: [1.0, 0.84, 0.0, 0.0],
      aspectMode: 'cover',
      visible: true,
      ...initialLayout,
    };

    let uniformBuffer: GPUBuffer | null = null;
    if (this.device) {
      // 48 bytes uniform buffer for ChannelUniforms struct
      uniformBuffer = this.device.createBuffer({
        size: 48,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }

    this.channels.set(channelId, {
      channelId,
      layout: defaultLayout,
      currentFrame: null,
      lastFrameTimestamp: 0,
      totalFramesIngested: 0,
      uniformBuffer,
    });

    // Reapply current layout preset to include new channel
    this.recomputePresetLayouts();
  }

  /**
   * Remove a channel and close its active VideoFrame immediately.
   */
  public removeChannel(channelId: string): void {
    const ch = this.channels.get(channelId);
    if (!ch) return;

    if (ch.currentFrame) {
      ch.currentFrame.close();
      ch.currentFrame = null;
    }
    ch.uniformBuffer?.destroy();
    this.channels.delete(channelId);
    this.recomputePresetLayouts();
  }

  /**
   * Ingest a VideoFrame for a specific channel.
   * Strict RAII: Closes the previous frame immediately to ensure Zero VRAM Leak!
   */
  public pushFrame(channelId: string, frame: VideoFrame): void {
    const ch = this.channels.get(channelId);
    if (!ch) {
      // Channel unknown: close immediately to prevent unbounded VRAM leak!
      frame.close();
      return;
    }

    // Zero VRAM Leak invariant: synchronize closure
    if (ch.currentFrame) {
      ch.currentFrame.close();
      ch.currentFrame = null;
    }

    ch.currentFrame = frame;
    ch.lastFrameTimestamp = frame.timestamp;
    ch.totalFramesIngested++;
  }

  /**
   * Change layout mode to a preset or custom layouts.
   */
  public setLayoutPreset(preset: CompositorLayoutPreset): void {
    this.currentPreset = preset;
    this.recomputePresetLayouts();
  }

  /**
   * Set explicit custom layouts for channels.
   */
  public setCustomLayouts(layouts: ChannelLayout[]): void {
    this.currentPreset = 'custom';
    for (const layout of layouts) {
      const ch = this.channels.get(layout.channelId);
      if (ch) {
        ch.layout = { ...ch.layout, ...layout };
      }
    }
  }

  /**
   * Recompute layouts based on the current preset mode and registered channels.
   */
  private recomputePresetLayouts(): void {
    if (this.currentPreset === 'custom') return;

    const channelIds = Array.from(this.channels.keys());
    if (channelIds.length === 0) return;

    switch (this.currentPreset) {
      case 'single': {
        // First channel is fullscreen, others hidden
        channelIds.forEach((id, idx) => {
          const ch = this.channels.get(id)!;
          ch.layout = {
            ...ch.layout,
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            zIndex: 0,
            opacity: 1.0,
            borderRadius: 0,
            borderWidth: 0,
            visible: idx === 0,
          };
        });
        break;
      }

      case 'pip_br': {
        // Main channel fullscreen, 2nd channel PIP at bottom-right, 3rd at top-right, etc.
        channelIds.forEach((id, idx) => {
          const ch = this.channels.get(id)!;
          if (idx === 0) {
            ch.layout = {
              ...ch.layout,
              x: 0,
              y: 0,
              width: 1,
              height: 1,
              zIndex: 0,
              opacity: 1.0,
              borderRadius: 0,
              borderWidth: 0,
              visible: true,
            };
          } else if (idx === 1) {
            ch.layout = {
              ...ch.layout,
              x: 0.68,
              y: 0.68,
              width: 0.29,
              height: 0.29,
              zIndex: 10,
              opacity: 1.0,
              borderRadius: 0.08,
              borderWidth: 0.02,
              borderColor: [1.0, 0.84, 0.0, 0.9], // Golden border
              visible: true,
            };
          } else if (idx === 2) {
            ch.layout = {
              ...ch.layout,
              x: 0.68,
              y: 0.36,
              width: 0.29,
              height: 0.29,
              zIndex: 9,
              opacity: 1.0,
              borderRadius: 0.08,
              borderWidth: 0.02,
              borderColor: [0.22, 0.74, 0.97, 0.9], // Cyan border
              visible: true,
            };
          } else {
            ch.layout.visible = false;
          }
        });
        break;
      }

      case 'pip_tr': {
        channelIds.forEach((id, idx) => {
          const ch = this.channels.get(id)!;
          if (idx === 0) {
            ch.layout = { ...ch.layout, x: 0, y: 0, width: 1, height: 1, zIndex: 0, visible: true, borderRadius: 0 };
          } else if (idx === 1) {
            ch.layout = {
              ...ch.layout,
              x: 0.68,
              y: 0.03,
              width: 0.29,
              height: 0.29,
              zIndex: 10,
              opacity: 1.0,
              borderRadius: 0.08,
              borderWidth: 0.02,
              borderColor: [1.0, 0.84, 0.0, 0.9],
              visible: true,
            };
          } else {
            ch.layout.visible = false;
          }
        });
        break;
      }

      case 'split_horizontal': {
        // Left / Right 50% / 50% split
        channelIds.forEach((id, idx) => {
          const ch = this.channels.get(id)!;
          if (idx === 0) {
            ch.layout = { ...ch.layout, x: 0, y: 0, width: 0.5, height: 1, zIndex: 0, visible: true, borderRadius: 0 };
          } else if (idx === 1) {
            ch.layout = { ...ch.layout, x: 0.5, y: 0, width: 0.5, height: 1, zIndex: 0, visible: true, borderRadius: 0 };
          } else {
            ch.layout.visible = false;
          }
        });
        break;
      }

      case 'split_vertical': {
        channelIds.forEach((id, idx) => {
          const ch = this.channels.get(id)!;
          if (idx === 0) {
            ch.layout = { ...ch.layout, x: 0, y: 0, width: 1, height: 0.5, zIndex: 0, visible: true, borderRadius: 0 };
          } else if (idx === 1) {
            ch.layout = { ...ch.layout, x: 0, y: 0.5, width: 1, height: 0.5, zIndex: 0, visible: true, borderRadius: 0 };
          } else {
            ch.layout.visible = false;
          }
        });
        break;
      }

      case 'grid_2x2': {
        const quadrantLayouts = [
          { x: 0.0, y: 0.0, width: 0.5, height: 0.5 },
          { x: 0.5, y: 0.0, width: 0.5, height: 0.5 },
          { x: 0.0, y: 0.5, width: 0.5, height: 0.5 },
          { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
        ];
        channelIds.forEach((id, idx) => {
          const ch = this.channels.get(id)!;
          if (idx < 4) {
            ch.layout = {
              ...ch.layout,
              ...quadrantLayouts[idx],
              zIndex: 0,
              borderRadius: 0.02,
              borderWidth: 0.005,
              borderColor: [0.3, 0.35, 0.45, 0.5],
              visible: true,
            };
          } else {
            ch.layout.visible = false;
          }
        });
        break;
      }
    }
  }

  /**
   * Execute multi-channel hardware composition onto target canvas.
   */
  public composite(targetView?: GPUTextureView): void {
    if (!this.initialized || !this.device || !this.context || !this.pipeline || !this.sampler || !this.bindGroupLayout) {
      return;
    }

    const commandEncoder = this.device.createCommandEncoder();
    const destinationView = targetView || this.context.getCurrentTexture().createView();

    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: destinationView,
          clearValue: this.clearColor,
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });

    renderPass.setPipeline(this.pipeline);

    const canvasWidth = this.canvas.width;
    const canvasHeight = this.canvas.height;

    // Sort visible channels by zIndex ascending so higher zIndex draws over lower
    const visibleChannels = Array.from(this.channels.values())
      .filter((ch) => ch.layout.visible !== false && ch.currentFrame !== null)
      .sort((a, b) => (a.layout.zIndex || 0) - (b.layout.zIndex || 0));

    for (const ch of visibleChannels) {
      const frame = ch.currentFrame!;
      const layout = ch.layout;

      const vx = Math.max(0, Math.floor(layout.x * canvasWidth));
      const vy = Math.max(0, Math.floor(layout.y * canvasHeight));
      const vw = Math.min(canvasWidth - vx, Math.floor(layout.width * canvasWidth));
      const vh = Math.min(canvasHeight - vy, Math.floor(layout.height * canvasHeight));

      if (vw <= 0 || vh <= 0) continue;

      // Update channel uniform buffer
      if (!ch.uniformBuffer) {
        ch.uniformBuffer = this.device.createBuffer({
          size: 48,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
      }

      const aspectModeMap: Record<AspectRatioMode, number> = {
        fill: 0,
        contain: 1,
        cover: 2,
      };

      const bufferData = new ArrayBuffer(48);
      const f32 = new Float32Array(bufferData);
      const u32 = new Uint32Array(bufferData);

      f32[0] = layout.opacity ?? 1.0;
      f32[1] = layout.borderRadius ?? 0.0;
      f32[2] = layout.borderWidth ?? 0.0;
      f32[3] = 0.0; // pad0

      const bc = layout.borderColor || [0, 0, 0, 0];
      f32[4] = bc[0];
      f32[5] = bc[1];
      f32[6] = bc[2];
      f32[7] = bc[3];

      u32[8] = aspectModeMap[layout.aspectMode || 'cover'];
      f32[9] = frame.displayWidth / Math.max(1, frame.displayHeight); // src aspect
      f32[10] = vw / Math.max(1, vh); // dst aspect
      f32[11] = 0.0; // pad1

      this.device.queue.writeBuffer(ch.uniformBuffer, 0, bufferData);

      const externalTexture = this.device.importExternalTexture({
        source: frame,
      });

      const bindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: externalTexture },
          { binding: 2, resource: { buffer: ch.uniformBuffer } },
        ],
      });

      renderPass.setViewport(vx, vy, vw, vh, 0, 1);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.draw(6);
    }

    renderPass.end();
    this.device.queue.submit([commandEncoder.finish()]);
  }

  /**
   * Diagnostic helper: returns the count of active VideoFrame handles in memory.
   * In continuous streaming, this should strictly be <= number of channels!
   */
  public getActiveFrameCount(): number {
    let count = 0;
    for (const ch of this.channels.values()) {
      if (ch.currentFrame) {
        count++;
      }
    }
    return count;
  }

  /**
   * Get all registered channel IDs.
   */
  public getChannelIds(): string[] {
    return Array.from(this.channels.keys());
  }

  /**
   * Get layout preset mode.
   */
  public getLayoutPreset(): CompositorLayoutPreset {
    return this.currentPreset;
  }

  /**
   * Destroy compositor and release all held GPU/VideoFrame handles.
   */
  public destroy(): void {
    for (const ch of this.channels.values()) {
      if (ch.currentFrame) {
        ch.currentFrame.close();
        ch.currentFrame = null;
      }
      ch.uniformBuffer?.destroy();
      ch.uniformBuffer = null;
    }
    this.channels.clear();
    this.device?.destroy();
    this.initialized = false;
  }
}
