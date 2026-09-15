import { SimpleMp4Demuxer } from '../demuxer/mp4-demuxer';
import { HardwareVideoDecoder } from '../decoder/hardware-decoder';
import { HardwareVideoEncoder } from '../encoder/hardware-encoder';
import { FastStartMp4Muxer } from '../muxer/mp4-muxer';

export type TranscodePreset = 'social-720p' | 'hd-1080p' | 'original-slim';

export interface TranscodeOptions {
  preset?: TranscodePreset;
  targetWidth?: number;
  targetHeight?: number;
  bitrate?: number;
  framerate?: number;
  muteAudio?: boolean;
  onProgress?: (progress: TranscodeProgress) => void;
}

export interface TranscodeProgress {
  percent: number;
  fps: number;
  xRealtime: number;
  processedFrames: number;
  totalFrames: number;
  originalSizeBytes: number;
  currentOutputBytes: number;
}

export interface TranscodeResult {
  mp4Buffer: Uint8Array;
  durationSec: number;
  originalSizeBytes: number;
  outputSizeBytes: number;
  compressionRatio: number; // e.g. 0.85 = 85% saved
  avgFps: number;
  avgRealtime: number;
  totalTimeMs: number;
  decodedFrames: number;
}

export class WebFfmpegTranscoder {
  /**
   * Run end-to-end client-side GPU transcoding with FastStart MP4 packaging and backpressure control.
   */
  public async transcode(
    inputBuffer: ArrayBuffer,
    options: TranscodeOptions = {}
  ): Promise<TranscodeResult> {
    const startTime = performance.now();
    const originalSizeBytes = inputBuffer.byteLength;

    // 1. Demux container
    const demuxer = new SimpleMp4Demuxer(inputBuffer);
    const tracks = demuxer.parse();

    const videoTrack = tracks.find((t) => t.codec.startsWith('avc1') || t.codec.startsWith('hvc1'));
    if (!videoTrack || videoTrack.samples.length === 0) {
      throw new Error('No valid video track found in MP4 container.');
    }

    // FAIL-01 Autocorrection: Dirty leading non-IDR frame dropper
    // If the stream was cut or joined midway, leading delta frames cause green screens or decode errors.
    // Drop leading delta frames until the first key frame is encountered.
    const firstKeyIndex = videoTrack.samples.findIndex((s) => s.type === 'key');
    if (firstKeyIndex > 0) {
      console.warn(`[Autocorrection FAIL-01] Dropped ${firstKeyIndex} leading dirty non-IDR frames before first keyframe.`);
      videoTrack.samples = videoTrack.samples.slice(firstKeyIndex);
    } else if (firstKeyIndex === -1 && videoTrack.samples.length > 0) {
      console.warn(`[Autocorrection FAIL-01] No keyframe marked; forcing first frame as keyframe for recovery.`);
      videoTrack.samples[0].type = 'key';
    }

    const audioTrack = tracks.find((t) => t.codec.startsWith('mp4a'));

    // 2. Resolve preset target dimensions and bitrate
    const { targetWidth, targetHeight, targetBitrate } = this.resolvePreset(
      videoTrack.width,
      videoTrack.height,
      options
    );

    // 3. Initialize FastStart MP4 Muxer
    const muxer = new FastStartMp4Muxer();

    // Default SPS/PPS fallback if not parsed in metadata
    let sps = new Uint8Array([0x67, 0x42, 0xc0, 0x1e, 0xd9, 0x00, 0xa0, 0x7b, 0x40]);
    let pps = new Uint8Array([0x68, 0xce, 0x38, 0x80]);

    // FAIL-02 Autocorrection: Safe SPS parsing with exception isolation
    if (videoTrack.description && videoTrack.description.byteLength > 10) {
      try {
        const avcc = videoTrack.description;
        const numSps = avcc[5] & 0x1f;
        if (numSps > 0) {
          const spsLen = (avcc[6] << 8) | avcc[7];
          if (8 + spsLen <= avcc.byteLength) {
            sps = avcc.slice(8, 8 + spsLen);
            const ppsOffset = 8 + spsLen;
            if (ppsOffset < avcc.byteLength) {
              const numPps = avcc[ppsOffset];
              if (numPps > 0 && ppsOffset + 3 <= avcc.byteLength) {
                const ppsLen = (avcc[ppsOffset + 1] << 8) | avcc[ppsOffset + 2];
                if (ppsOffset + 3 + ppsLen <= avcc.byteLength) {
                  pps = avcc.slice(ppsOffset + 3, ppsOffset + 3 + ppsLen);
                }
              }
            }
          }
        }
      } catch (err) {
        console.warn('[Autocorrection FAIL-02] Corrupted avcC description detected; safely defaulting to baseline SPS/PPS.', err);
      }
    }

    muxer.setVideoTrack({
      width: targetWidth,
      height: targetHeight,
      timescale: 30000,
      sps,
      pps,
    });

    // FAIL-04 Autocorrection: Audio Fault Isolation
    // If audio track is corrupted or empty, safely isolate audio and do not abort video transcoding
    if (audioTrack && !options.muteAudio) {
      try {
        muxer.setAudioTrack({
          timescale: audioTrack.timescale || 44100,
          sampleRate: audioTrack.timescale || 44100,
          channels: 2,
          config: audioTrack.description,
        });

        let audioCorruptCount = 0;
        for (const sample of audioTrack.samples) {
          if (!sample.data || sample.data.byteLength === 0) {
            audioCorruptCount++;
            continue; // Skip corrupted empty audio packet
          }
          const durationTicks = Math.max(1, Math.round((sample.duration * (audioTrack.timescale || 44100)) / 1_000_000));
          muxer.writeAudioSample(sample.data, durationTicks);
        }

        if (audioCorruptCount > 0) {
          console.warn(`[Autocorrection FAIL-04] Skipped ${audioCorruptCount} corrupted audio packets; video continues unaffected.`);
        }
      } catch (audioErr) {
        console.warn(`[Autocorrection FAIL-04] Audio track initialization failed; automatically degrading to mute video export.`, audioErr);
      }
    }

    // 4. Setup Hardware Video Encoder
    const encoder = new HardwareVideoEncoder(
      (chunk, metadata) => {
        // Update SPS/PPS if encoder metadata provides updated description
        if (metadata && metadata.decoderConfig && metadata.decoderConfig.description) {
          const desc = new Uint8Array(metadata.decoderConfig.description as ArrayBuffer);
          if (desc.byteLength > 10) {
            const numSps = desc[5] & 0x1f;
            if (numSps > 0) {
              const spsLen = (desc[6] << 8) | desc[7];
              sps = desc.slice(8, 8 + spsLen);
              const ppsOffset = 8 + spsLen;
              if (desc[ppsOffset] > 0) {
                const ppsLen = (desc[ppsOffset + 1] << 8) | desc[ppsOffset + 2];
                pps = desc.slice(ppsOffset + 3, ppsOffset + 3 + ppsLen);
                muxer.setVideoTrack({
                  width: targetWidth,
                  height: targetHeight,
                  timescale: 30000,
                  sps,
                  pps,
                });
              }
            }
          }
        }

        const chunkData = new Uint8Array(chunk.byteLength);
        chunk.copyTo(chunkData);

        const durationTicks = Math.max(1, Math.round((chunk.duration || 33333) * 30000 / 1_000_000));
        muxer.writeVideoSample(chunkData, durationTicks, chunk.type === 'key');
      }
    );

    await encoder.configure({
      codec: 'avc1.42001f', // Baseline profile for maximum web compatibility
      width: targetWidth,
      height: targetHeight,
      bitrate: targetBitrate,
      framerate: options.framerate || 30,
    });

    // 5. Setup Offscreen Canvas for scaling / color transfer if dimensions change
    const needsResize = videoTrack.width !== targetWidth || videoTrack.height !== targetHeight;
    let offscreenCanvas: OffscreenCanvas | null = null;
    let offscreenCtx: OffscreenCanvasRenderingContext2D | null = null;

    if (needsResize && typeof OffscreenCanvas !== 'undefined') {
      offscreenCanvas = new OffscreenCanvas(targetWidth, targetHeight);
      offscreenCtx = offscreenCanvas.getContext('2d');
    }

    // 6. Decode & Encode Loop with Backpressure
    const totalFrames = videoTrack.samples.length;
    let processedFrames = 0;
    let lastReportTime = startTime;
    let framesSinceLastReport = 0;

    const decoder = new HardwareVideoDecoder((frame, _meta) => {
      processedFrames++;
      framesSinceLastReport++;

      let frameToEncode = frame;
      let intermediateFrame: VideoFrame | null = null;

      try {
        if (needsResize && offscreenCanvas && offscreenCtx) {
          offscreenCtx.drawImage(frame, 0, 0, targetWidth, targetHeight);
          intermediateFrame = new VideoFrame(offscreenCanvas, {
            timestamp: frame.timestamp,
            duration: frame.duration || 33333,
          });
          frameToEncode = intermediateFrame;
        }

        const isKeyframeInterval = processedFrames % 60 === 1;
        encoder.encode(frameToEncode, { keyFrame: isKeyframeInterval });
      } finally {
        // Invariant 1: Synchronous RAII closure on all paths
        if (intermediateFrame) {
          try { intermediateFrame.close(); } catch {}
        }
        try { frame.close(); } catch {}
      }

      // Progress reporting
      const now = performance.now();
      if (now - lastReportTime >= 150 || processedFrames === totalFrames) {
        const deltaSec = (now - lastReportTime) / 1000;
        const currentFps = deltaSec > 0 ? framesSinceLastReport / deltaSec : 30;
        const xRealtime = currentFps / (options.framerate || 30);
        lastReportTime = now;
        framesSinceLastReport = 0;

        if (options.onProgress) {
          options.onProgress({
            percent: Math.round((processedFrames / totalFrames) * 100),
            fps: Math.round(currentFps),
            xRealtime: Math.round(xRealtime * 10) / 10,
            processedFrames,
            totalFrames,
            originalSizeBytes,
            currentOutputBytes: Math.round((originalSizeBytes * processedFrames) / totalFrames * 0.15),
          });
        }
      }
    });

    let isSupported = false;
    try {
      isSupported = await decoder.configure({
        codec: videoTrack.codec,
        description: videoTrack.description,
        codedWidth: videoTrack.width,
        codedHeight: videoTrack.height,
      });
    } catch {
      // Handled in fallback below
    }

    if (!isSupported) {
      console.warn(`[Autocorrection FAIL-02] Codec ${videoTrack.codec} unsupported; attempting fallback to avc1.42001f baseline.`);
      try {
        isSupported = await decoder.configure({ codec: 'avc1.42001f' });
      } catch {}
    }

    if (!isSupported) {
      throw new Error(`VideoDecoder does not support input codec: ${videoTrack.codec}`);
    }

    // Feed samples to decoder with dual backpressure (FAIL-06) and monotonic PTS clamping (FAIL-03)
    let lastSanitizedPts = -1;
    const initialOffset = videoTrack.samples[0]?.timestamp || 0;

    for (let i = 0; i < totalFrames; i++) {
      while (decoder.getQueueSize() >= 4 || encoder.encodeQueueSize >= 8) {
        await new Promise((resolve) => setTimeout(resolve, 4));
      }

      const sample = videoTrack.samples[i];
      let pts = sample.timestamp;
      if (initialOffset > 0) {
        pts = pts - initialOffset;
      }
      if (pts < 0) {
        pts = 0;
      }
      if (lastSanitizedPts >= 0 && pts <= lastSanitizedPts) {
        pts = lastSanitizedPts + Math.max(1000, sample.duration || 33333);
      }
      lastSanitizedPts = pts;

      const chunk = new EncodedVideoChunk({
        type: sample.type,
        timestamp: pts,
        duration: sample.duration || 33333,
        data: sample.data,
      });
      decoder.decodeChunk(chunk);
    }

    // Flush decoder and encoder
    await decoder.flush();
    decoder.close();

    await encoder.flush();
    encoder.close();

    // 7. Finalize FastStart MP4 file
    const mp4Buffer = muxer.finalize();
    const endTime = performance.now();
    const totalTimeMs = endTime - startTime;
    const outputSizeBytes = mp4Buffer.byteLength;
    const compressionRatio = Math.round((1 - outputSizeBytes / originalSizeBytes) * 100) / 100;

    const countedFrames = processedFrames > 0 ? processedFrames : totalFrames;
    const avgFps = Math.round((countedFrames / (totalTimeMs / 1000)) * 10) / 10;
    const avgRealtime = Math.round((avgFps / (options.framerate || 30)) * 10) / 10;

    return {
      mp4Buffer,
      durationSec: Math.round((countedFrames / (options.framerate || 30)) * 10) / 10,
      originalSizeBytes,
      outputSizeBytes,
      compressionRatio,
      avgFps,
      avgRealtime,
      totalTimeMs,
      decodedFrames: processedFrames,
    };
  }

  private resolvePreset(
    origW: number,
    origH: number,
    options: TranscodeOptions
  ): { targetWidth: number; targetHeight: number; targetBitrate: number } {
    const isPortrait = origH > origW;
    const preset = options.preset || 'social-720p';

    let targetWidth = options.targetWidth || origW;
    let targetHeight = options.targetHeight || origH;
    let targetBitrate = options.bitrate || 2_500_000;

    switch (preset) {
      case 'social-720p':
        if (isPortrait) {
          targetWidth = 720;
          targetHeight = Math.round((origH * 720) / origW);
        } else {
          targetHeight = 720;
          targetWidth = Math.round((origW * 720) / origH);
        }
        targetBitrate = 2_500_000;
        break;

      case 'hd-1080p':
        if (isPortrait) {
          targetWidth = 1080;
          targetHeight = Math.round((origH * 1080) / origW);
        } else {
          targetHeight = 1080;
          targetWidth = Math.round((origW * 1080) / origH);
        }
        targetBitrate = 5_000_000;
        break;

      case 'original-slim':
        targetWidth = origW;
        targetHeight = origH;
        targetBitrate = 8_000_000;
        break;
    }

    // Video dimensions must be even numbers
    targetWidth = targetWidth % 2 === 0 ? targetWidth : targetWidth - 1;
    targetHeight = targetHeight % 2 === 0 ? targetHeight : targetHeight - 1;

    return { targetWidth, targetHeight, targetBitrate };
  }
}
