import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { McpServer } from '../../packages/mcp-server/src/server';

test.describe('Model Context Protocol (MCP) Server Integration & Tool Suite', () => {
  let server: McpServer;
  let tempDir: string;

  test.beforeAll(() => {
    server = new McpServer();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-media-test-'));
  });

  test.afterAll(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('MCP Handshake: should handle initialize and ping protocol methods', async () => {
    // 1. initialize
    const initRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        clientInfo: { name: 'antigravity-test-client', version: '1.0' },
      },
    });

    expect(initRes).not.toBeNull();
    expect(initRes?.result?.serverInfo?.name).toBe('web-ffmpeg-gpu-mcp');
    expect(initRes?.result?.protocolVersion).toBe('2024-11-05');
    expect(initRes?.result?.capabilities?.tools).toBeDefined();

    // 2. ping
    const pingRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'ping',
    });
    expect(pingRes?.result).toEqual({});
  });

  test('MCP Tool Discovery: tools/list must expose all 5 media agent tools', async () => {
    const listRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
    });

    expect(listRes?.result?.tools).toBeDefined();
    const tools = listRes!.result.tools;
    expect(tools.length).toBe(8);

    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).toContain('probe_media');
    expect(toolNames).toContain('salvage_corrupted_mp4');
    expect(toolNames).toContain('transcode_video');
    expect(toolNames).toContain('diagnose_jitter_stream');
    expect(toolNames).toContain('diagnose_rtp_stream');
    expect(toolNames).toContain('tune_stream_bitrate');
    expect(toolNames).toContain('trigger_keyframe_pli');
    expect(toolNames).toContain('remedy_lipsync');

    for (const t of tools) {
      expect(t.description).toBeTruthy();
      expect(t.inputSchema.type).toBe('object');
      expect(t.inputSchema.properties).toBeDefined();
    }
  });

  test('MCP Tool: diagnose_jitter_stream should evaluate live stream lip-sync drift', async () => {
    const callRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'diagnose_jitter_stream',
        arguments: {
          estimatedJitterMs: 80,
          durationMinutes: 45,
        },
      },
    });

    expect(callRes?.result?.isError).toBeFalsy();
    const textContent = callRes?.result?.content?.[0]?.text;
    expect(textContent).toContain('Live Stream & Lip-Sync Diagnosis');
    expect(textContent).toContain('45 minutes');
    expect(textContent).toContain('SMOOTH_CATCHUP');
  });

  test('MCP Tool: probe_media & salvage_corrupted_mp4 should rescue truncated files', async () => {
    // 1. Create a synthetic truncated MP4 without moov (only ftyp + mdat)
    const truncatedMp4Path = path.join(tempDir, 'truncated_stream.mp4');
    const salvagedMp4Path = path.join(tempDir, 'salvaged_stream.mp4');

    const fakeTruncatedData = new Uint8Array([
      // ftyp
      0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
      // mdat with Annex-B SPS, PPS, IDR
      0x00, 0x00, 0x00, 0x2c, 0x6d, 0x64, 0x61, 0x74,
      0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1f,
      0x00, 0x00, 0x00, 0x01, 0x68, 0xce, 0x3c, 0x80,
      0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x00, 0x11, 0x22,
      0x00, 0x00, 0x00, 0x01, 0x41, 0x9a, 0x12, 0x34,
    ]);
    fs.writeFileSync(truncatedMp4Path, fakeTruncatedData);

    // 2. Call probe_media on truncated file
    const probeRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'probe_media',
        arguments: { filePath: truncatedMp4Path },
      },
    });

    expect(probeRes?.result?.isError).toBeFalsy();
    const probeText = probeRes?.result?.content?.[0]?.text;
    expect(probeText).toContain('Media Probe Report');

    // 3. Call salvage_corrupted_mp4
    const salvageRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'salvage_corrupted_mp4',
        arguments: {
          inputPath: truncatedMp4Path,
          outputPath: salvagedMp4Path,
        },
      },
    });

    expect(salvageRes?.result?.isError).toBeFalsy();
    const salvageText = salvageRes?.result?.content?.[0]?.text;
    expect(salvageText).toContain('Stream Salvage Success');
    expect(fs.existsSync(salvagedMp4Path)).toBe(true);

    // 4. Verify repaired file has valid FastStart ISOBMFF layout (moov before mdat)
    const repairedBytes = fs.readFileSync(salvagedMp4Path);
    const view = new DataView(repairedBytes.buffer, repairedBytes.byteOffset, repairedBytes.byteLength);
    const ftypLen = view.getUint32(0);
    const box1Type = String.fromCharCode(view.getUint8(4), view.getUint8(5), view.getUint8(6), view.getUint8(7));
    const box2Type = String.fromCharCode(view.getUint8(ftypLen + 4), view.getUint8(ftypLen + 5), view.getUint8(ftypLen + 6), view.getUint8(ftypLen + 7));

    expect(box1Type).toBe('ftyp');
    expect(box2Type).toBe('moov'); // moov placed before mdat!
  });

  test('MCP Tool: transcode_video should repackage media with FastStart layout', async () => {
    // Use the salvaged file from previous test as input
    const sourcePath = path.join(tempDir, 'salvaged_stream.mp4');
    const optimizedPath = path.join(tempDir, 'faststart_optimized.mp4');

    const transcodeRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'transcode_video',
        arguments: {
          inputPath: sourcePath,
          outputPath: optimizedPath,
          preset: 'social-720p',
          muteAudio: true,
        },
      },
    });

    expect(transcodeRes?.result?.isError).toBeFalsy();
    const transcodeText = transcodeRes?.result?.content?.[0]?.text;
    expect(transcodeText).toContain('FastStart Transcode Complete');
    expect(fs.existsSync(optimizedPath)).toBe(true);
    expect(fs.statSync(optimizedPath).size).toBeGreaterThan(0);
  });

  test('MCP Tool: diagnose_rtp_stream should analyze RTP stream bitstream and report FAIL-09/10 diagnostics', async () => {
    const rtpRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'diagnose_rtp_stream',
        arguments: {
          isHevc: false,
          packetCount: 60,
          simulateLossRate: 10,
          simulateSequenceWrap: true,
        },
      },
    });

    expect(rtpRes?.result?.isError).toBeFalsy();
    const resultObj = JSON.parse(rtpRes!.result.content[0].text);
    expect(resultObj.status).toBe('HEALTHY');
    expect(resultObj.codec).toContain('RFC 6184');
    expect(resultObj.simulation.wrapAroundTested).toBe(true);
    expect(resultObj.resilienceAssessment.fail10SequenceWrapHandling).toContain('PASS');
    expect(resultObj.telemetry.packetsReceived).toBeGreaterThan(0);
  });
});

