import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  MediaAutopilotAgent,
  McpServer,
  handleProbeMedia,
  handleSalvageMp4,
  handleTranscodeVideo,
} from '../../packages/mcp-server/src';

test.describe('Media Autopilot Agent & DeepSeek ReAct Self-Healing Harness', () => {
  let tempDir: string;

  test.beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-harness-'));
  });

  test.afterAll(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('Tier 1 [Weak Network & Packet Loss]: Agent must autonomously diagnose RTP stream and dispatch PLI + Bitrate reduction', async () => {
    const agent = new MediaAutopilotAgent({ engineMode: 'rules-engine' });

    const report = await agent.diagnoseAlert({
      type: 'PACKET_LOSS',
      severity: 'critical',
      source: 'p2p-receiver',
      metrics: {
        packetLossRate: 25,
        rttMs: 60,
        bitrateKbps: 800,
        failCode: 'FAIL-09',
      },
      timestamp: Date.now(),
    });

    expect(report).toBeDefined();
    expect(report.engineMode).toBe('rules-engine');
    expect(report.resolved).toBe(true);
    expect(report.steps.length).toBeGreaterThanOrEqual(2);

    // Verify MCP tool steps
    const toolsCalled = report.steps.map((s) => s.action?.tool);
    expect(toolsCalled).toContain('diagnose_rtp_stream');
    expect(toolsCalled).toContain('trigger_keyframe_pli');
    expect(toolsCalled).toContain('tune_stream_bitrate');

    // Verify Directives
    const directiveTypes = report.directives.map((d) => d.type);
    expect(directiveTypes).toContain('TRIGGER_PLI');
    expect(directiveTypes).toContain('ADJUST_BITRATE');

    const bitrateDirective = report.directives.find((d) => d.type === 'ADJUST_BITRATE');
    expect(bitrateDirective?.targetBitrateKbps).toBeLessThan(800);
    expect(bitrateDirective?.targetBitrateKbps).toBeGreaterThanOrEqual(200);
  });

  test('Tier 2 [Lip-Sync Desync Remediation]: Agent must prescribe pitch-safe 1.05x catchup or video hold delay', async () => {
    const agent = new MediaAutopilotAgent({ engineMode: 'rules-engine' });

    // 1. Video lagging by -120ms
    const lagReport = await agent.diagnoseAlert({
      type: 'LIP_SYNC_DESYNC',
      severity: 'warning',
      source: 'p2p-receiver',
      metrics: {
        avDriftMs: -120,
      },
      timestamp: Date.now(),
    });

    expect(lagReport.resolved).toBe(true);
    const lagDirective = lagReport.directives.find((d) => d.type === 'REMEDY_LIPSYNC');
    expect(lagDirective).toBeDefined();
    expect(lagDirective?.playbackRate).toBe(1.05); // Smooth 1.05x pitch-safe catchup

    // 2. Video leading by +85ms
    const leadReport = await agent.diagnoseAlert({
      type: 'LIP_SYNC_DESYNC',
      severity: 'warning',
      source: 'p2p-receiver',
      metrics: {
        avDriftMs: 85,
      },
      timestamp: Date.now(),
    });

    expect(leadReport.resolved).toBe(true);
    const leadDirective = leadReport.directives.find((d) => d.type === 'REMEDY_LIPSYNC');
    expect(leadDirective).toBeDefined();
    expect(leadDirective?.delayMs).toBe(85); // Hold video frames by 85ms
  });

  test('Tier 3 [Corrupted Media Salvage Orchestration]: Agent must chain probe -> salvage -> FastStart transcode', async () => {
    // Synthesize corrupted MP4: ftyp + truncated mdat (missing moov)
    const brokenPath = path.join(tempDir, 'broken-stream.mp4');
    const salvagedPath = path.join(tempDir, 'salvaged.mp4');
    const fastStartPath = path.join(tempDir, 'output-faststart.mp4');

    const fakeTruncatedData = Buffer.from([
      // ftyp
      0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
      // mdat with Annex-B SPS, PPS, IDR, delta
      0x00, 0x00, 0x00, 0x2c, 0x6d, 0x64, 0x61, 0x74,
      0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1f,
      0x00, 0x00, 0x00, 0x01, 0x68, 0xce, 0x3c, 0x80,
      0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x00, 0x11, 0x22,
      0x00, 0x00, 0x00, 0x01, 0x41, 0x9a, 0x12, 0x34,
    ]);

    fs.writeFileSync(brokenPath, fakeTruncatedData);

    // 1. Probe
    const probeRes = await handleProbeMedia({ filePath: brokenPath });
    const probeText = probeRes.content[0].text || '';
    expect(probeRes.isError).toBeFalsy();
    expect(probeText).toContain('Media Probe Report');

    // 2. Salvage
    const salvageRes = await handleSalvageMp4({ inputPath: brokenPath, outputPath: salvagedPath });
    expect(salvageRes.isError).toBeFalsy();
    expect(fs.existsSync(salvagedPath)).toBe(true);

    // 3. Transcode to FastStart
    const transcodeRes = await handleTranscodeVideo({
      inputPath: salvagedPath,
      outputPath: fastStartPath,
      preset: 'social',
    });
    expect(transcodeRes.isError).toBeFalsy();
    expect(fs.existsSync(fastStartPath)).toBe(true);

    // Verify FastStart layout: moov must precede mdat
    const buf = fs.readFileSync(fastStartPath);
    const moovIdx = buf.indexOf(Buffer.from('moov'));
    const mdatIdx = buf.indexOf(Buffer.from('mdat'));
    expect(moovIdx).toBeGreaterThan(0);
    expect(mdatIdx).toBeGreaterThan(moovIdx);
  });

  test('Tier 4 [DeepSeek ReAct Agent CoT Loop]: Multi-iteration Thought -> Action -> Observation cycle', async () => {
    const thoughtsCaptured: string[] = [];
    const directivesCaptured: any[] = [];

    const agent = new MediaAutopilotAgent({
      engineMode: 'llm-react',
      onThought: (step) => thoughtsCaptured.push(step.thought),
      onDirective: (directive) => directivesCaptured.push(directive),
    });

    const report = await agent.diagnoseAlert({
      type: 'PACKET_LOSS',
      severity: 'critical',
      source: 'p2p-receiver',
      metrics: {
        packetLossRate: 18,
        rttMs: 80,
        bitrateKbps: 1000,
      },
      timestamp: Date.now(),
    });

    expect(report.engineMode).toBe('llm-react');
    expect(report.steps.length).toBeGreaterThanOrEqual(3);
    expect(thoughtsCaptured.length).toBeGreaterThanOrEqual(3);
    expect(directivesCaptured.length).toBeGreaterThanOrEqual(2);

    // Verify DeepSeek Chain-of-Thought
    expect(thoughtsCaptured[0]).toContain('[DeepSeek-R1 CoT]');
    expect(report.steps[0].action?.tool).toBe('diagnose_rtp_stream');
    expect(report.steps[0].observation).toBeDefined();

    expect(report.steps[1].action?.tool).toBe('trigger_keyframe_pli');
    expect(report.steps[1].observation).toBeDefined();

    expect(report.steps[2].action?.tool).toBe('tune_stream_bitrate');
    expect(report.steps[2].observation).toBeDefined();

    expect(report.resolved).toBe(true);
  });

  test('Tier 5 [Continuous Telemetry Ingest & Auto-Triggering]: Nominal metrics filtered, anomaly triggers self-healing', async () => {
    const agent = new MediaAutopilotAgent({ engineMode: 'rules-engine' });

    // 1. Nominal telemetry -> should NOT trigger alert (returns null)
    const nominalReport = await agent.feedTelemetry('p2p-receiver', {
      packetLossRate: 0.5,
      avDriftMs: 15,
      fps: 30,
    });
    expect(nominalReport).toBeNull();

    // 2. High packet loss anomaly -> should trigger alert and return self-healing report
    const anomalyReport = await agent.feedTelemetry('p2p-receiver', {
      packetLossRate: 16,
      avDriftMs: 20,
      fps: 22,
    });
    expect(anomalyReport).not.toBeNull();
    expect(anomalyReport?.resolved).toBe(true);
    expect(anomalyReport?.directives.some((d) => d.type === 'TRIGGER_PLI')).toBe(true);
  });

  test('Tier 6 [Playground AI Autopilot Cockpit UI]: User can toggle autopilot, switch decision engine, and trigger anomaly simulation in browser', async ({ page }) => {
    await page.goto('/');

    const enableCheckbox = page.locator('#checkbox-autopilot-enable');
    const engineSelect = page.locator('#select-autopilot-engine');
    const statusBadge = page.locator('#autopilot-status-badge');
    const directiveBadge = page.locator('#autopilot-directive-badge');
    const terminal = page.locator('#autopilot-terminal');
    const simulateBtn = page.locator('#btn-autopilot-simulate');

    await expect(enableCheckbox).toBeVisible();
    await expect(engineSelect).toBeVisible();
    await expect(statusBadge).toHaveText('巡检守护中 (Active)');
    await expect(directiveBadge).toHaveText('无异常 (Nominal)');
    await expect(terminal).toContainText('Autopilot Agent Initialized');

    // Switch engine to DeepSeek ReAct Agent
    await engineSelect.selectOption('llm-react');
    await expect(terminal).toContainText('[Engine Switched]');

    // Click simulate anomaly button
    await simulateBtn.click();

    // Verify thinking stream and directive dispatching
    await expect(terminal).toContainText('[Thought 1]');
    await expect(terminal).toContainText('Action: diagnose_rtp_stream');
    await expect(terminal).toContainText('Directive');
    await expect(terminal).toContainText('TRIGGER_PLI');
    await expect(terminal).toContainText('ADJUST_BITRATE');
    await expect(directiveBadge).toHaveText(/TRIGGER_PLI|ADJUST_BITRATE/);
  });
});
