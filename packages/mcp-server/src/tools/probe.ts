import fs from 'node:fs';
import { SimpleMp4Demuxer } from '@web-ffmpeg-gpu/core';
import type { McpToolDefinition, McpToolResult } from '../types';

export const probeToolDefinition: McpToolDefinition = {
  name: 'probe_media',
  description: 'Inspect and diagnose an MP4 video file. Extracts track metadata, codec profiles, resolution, sample counts, and checks for corrupt headers, missing moov, dirty non-IDR prefixes, and negative PTS anomalies.',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Absolute or relative path to the MP4 file on the local filesystem.',
      },
    },
    required: ['filePath'],
  },
};

export async function handleProbeMedia(args: { filePath: string }): Promise<McpToolResult> {
  const { filePath } = args;

  if (!filePath || !fs.existsSync(filePath)) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `[ERROR] Video file not found at path: ${filePath}`,
        },
      ],
    };
  }

  try {
    const fileBuffer = fs.readFileSync(filePath);
    const arrayBuffer = fileBuffer.buffer.slice(
      fileBuffer.byteOffset,
      fileBuffer.byteOffset + fileBuffer.byteLength
    );

    const demuxer = new SimpleMp4Demuxer(arrayBuffer);
    const tracks = demuxer.parse();

    const videoTrack = tracks.find((t) => t.codec.startsWith('avc1') || t.codec.startsWith('hvc1'));
    const audioTrack = tracks.find((t) => t.codec.startsWith('mp4a'));

    // Diagnostics
    const issues: string[] = [];
    let isDirtyPrefix = false;
    let hasNegativePts = false;
    let hasRetrogradePts = false;

    if (!videoTrack) {
      issues.push('[FAIL-05] No valid video track or moov box found. File may be truncated; activate salvage mode to recover.');
    } else {
      // Check FAIL-01
      if (videoTrack.samples.length > 0 && videoTrack.samples[0].type !== 'key') {
        isDirtyPrefix = true;
        issues.push('[FAIL-01] Video stream starts with non-IDR delta frames (Dirty Prefix). Decoders may show green screens unless sanitized.');
      }

      // Check FAIL-03
      let lastPts = -1;
      for (const s of videoTrack.samples) {
        if (s.timestamp < 0) hasNegativePts = true;
        if (lastPts >= 0 && s.timestamp < lastPts) hasRetrogradePts = true;
        lastPts = s.timestamp;
      }

      if (hasNegativePts) {
        issues.push('[FAIL-03] Negative PTS detected in bitstream timestamps.');
      }
      if (hasRetrogradePts) {
        issues.push('[FAIL-03] Retrograde (backwards) timestamps detected in bitstream.');
      }
    }

    const durationSec = videoTrack && videoTrack.samples.length > 0
      ? (videoTrack.samples[videoTrack.samples.length - 1].timestamp / 1_000_000).toFixed(2)
      : '0.00';

    const report = {
      file: filePath,
      fileSizeBytes: fileBuffer.byteLength,
      trackCount: tracks.length,
      video: videoTrack
        ? {
            codec: videoTrack.codec,
            width: videoTrack.width,
            height: videoTrack.height,
            timescale: videoTrack.timescale,
            totalSamples: videoTrack.samples.length,
            durationSec: `${durationSec}s`,
            hasExtradataAvcC: !!videoTrack.description,
          }
        : null,
      audio: audioTrack
        ? {
            codec: audioTrack.codec,
            timescale: audioTrack.timescale,
            totalSamples: audioTrack.samples.length,
          }
        : null,
      health: {
        healthy: issues.length === 0,
        isDirtyPrefix,
        hasNegativePts,
        hasRetrogradePts,
        issues,
      },
    };

    return {
      content: [
        {
          type: 'text',
          text: `### Media Probe Report: \`${filePath}\`\n\n` +
            `\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n\n` +
            (issues.length > 0
              ? `**Detected Stream Anomalies:**\n${issues.map((i) => `- ${i}`).join('\n')}`
              : `**Stream Status**: Pristine container, 0 anomalies detected.`),
        },
      ],
    };
  } catch (err: any) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `[ERROR] Exception during media probe: ${err.message || err}`,
        },
      ],
    };
  }
}
