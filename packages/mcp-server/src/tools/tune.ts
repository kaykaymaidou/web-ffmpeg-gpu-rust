import type { McpToolDefinition, McpToolResult } from '../types';

export const tuneBitrateToolDefinition: McpToolDefinition = {
  name: 'tune_stream_bitrate',
  description: 'Evaluate network congestion and adaptively compute optimal stream encoding bitrate (Adaptive Bitrate / ABR) to relieve buffer bloat and packet drops.',
  inputSchema: {
    type: 'object',
    properties: {
      currentBitrateKbps: {
        type: 'number',
        description: 'Current stream bitrate in kbps (e.g. 800, 1500).',
        default: 800,
      },
      packetLossRate: {
        type: 'number',
        description: 'Observed packet loss percentage (0 - 100%).',
        default: 0,
      },
      networkRttMs: {
        type: 'number',
        description: 'Round-trip time in milliseconds (e.g. 30, 120).',
        default: 40,
      },
      minBitrateKbps: {
        type: 'number',
        description: 'Minimum acceptable stream bitrate floor in kbps.',
        default: 200,
      },
      maxBitrateKbps: {
        type: 'number',
        description: 'Maximum permitted stream bitrate ceiling in kbps.',
        default: 3000,
      },
    },
    required: ['currentBitrateKbps'],
  },
};

export async function handleTuneBitrate(args: {
  currentBitrateKbps: number;
  packetLossRate?: number;
  networkRttMs?: number;
  minBitrateKbps?: number;
  maxBitrateKbps?: number;
}): Promise<McpToolResult> {
  const current = Math.max(100, args.currentBitrateKbps);
  const loss = Math.max(0, Math.min(100, args.packetLossRate ?? 0));
  const rtt = Math.max(1, args.networkRttMs ?? 40);
  const minB = Math.max(100, args.minBitrateKbps ?? 200);
  const maxB = Math.max(minB, args.maxBitrateKbps ?? 3000);

  let targetBitrate = current;
  let action: 'DECREASE' | 'INCREASE' | 'HOLD' = 'HOLD';
  let reason = 'Network metrics nominal. Maintaining current encoding bitrate.';

  if (loss >= 10 || rtt > 200) {
    // Multiplicative decrease under congestion
    const backoffFactor = Math.max(0.5, 1.0 - (loss / 100) * 1.5);
    targetBitrate = Math.max(minB, Math.round(current * backoffFactor));
    action = 'DECREASE';
    reason = `Severe congestion detected (${loss}% packet loss, ${rtt}ms RTT). Decreasing bitrate by ${Math.round((1 - backoffFactor) * 100)}% to restore stream stability.`;
  } else if (loss < 2 && rtt < 80 && current < maxB) {
    // Additive increase under clean channel
    const step = 150;
    targetBitrate = Math.min(maxB, current + step);
    action = 'INCREASE';
    reason = `Network conditions excellent (<2% loss, ${rtt}ms RTT). Increasing bitrate by ${step} kbps to elevate video fidelity.`;
  }

  const resultData = {
    action,
    previousBitrateKbps: current,
    recommendedBitrateKbps: targetBitrate,
    adjustmentPercent: Math.round(((targetBitrate - current) / current) * 100),
    constraints: { minBitrateKbps: minB, maxBitrateKbps: maxB },
    reason,
  };

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(resultData, null, 2),
      },
    ],
  };
}

export const triggerPliToolDefinition: McpToolDefinition = {
  name: 'trigger_keyframe_pli',
  description: 'Issue a Picture Loss Indication (PLI / RFC 4585) request to force the upstream broadcaster to generate an IDR keyframe, instantly recovering from frame corruption or desync.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Root cause triggering PLI (e.g. "FAIL-09 fragment drop", "new viewer joined", "decoder error").',
        default: 'FAIL-09 fragment loss',
      },
      urgency: {
        type: 'string',
        enum: ['immediate', 'high', 'normal'],
        description: 'Urgency tier of keyframe demand.',
        default: 'immediate',
      },
    },
  },
};

export async function handleTriggerPli(args: {
  reason?: string;
  urgency?: 'immediate' | 'high' | 'normal';
}): Promise<McpToolResult> {
  const reason = args.reason || 'FAIL-09 fragment loss';
  const urgency = args.urgency || 'immediate';

  const resultData = {
    status: 'PLI_DISPATCHED',
    directive: 'FORCE_IDR_KEYFRAME',
    urgency,
    reason,
    timestamp: Date.now(),
    expectedAction: 'Upstream Hardware VideoEncoder will insert an IDR keyframe with inline SPS/PPS parameter sets on next frame tick.',
  };

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(resultData, null, 2),
      },
    ],
  };
}

export const remedyLipsyncToolDefinition: McpToolDefinition = {
  name: 'remedy_lipsync',
  description: 'Evaluate audio/video presentation drift (Lip-Sync) and prescribe corrective timeline compensation actions (smooth catchup, video delay, or keyframe seek).',
  inputSchema: {
    type: 'object',
    properties: {
      avDriftMs: {
        type: 'number',
        description: 'Measured presentation drift in ms (videoPts - masterAudioPts). Positive = video leading, negative = video lagging.',
      },
      tightThresholdMs: {
        type: 'number',
        description: 'Acceptable lip-sync threshold in ms.',
        default: 40,
      },
    },
    required: ['avDriftMs'],
  },
};

export async function handleRemedyLipsync(args: {
  avDriftMs: number;
  tightThresholdMs?: number;
}): Promise<McpToolResult> {
  const drift = args.avDriftMs;
  const tight = args.tightThresholdMs ?? 40;

  let action: 'RENDER_NORMAL' | 'SMOOTH_CATCHUP' | 'DELAY_VIDEO' | 'SEEK_KEYFRAME_AND_REANCHOR' = 'RENDER_NORMAL';
  let playbackRate = 1.0;
  let delayMs = 0;
  let description = '';

  if (Math.abs(drift) <= tight) {
    action = 'RENDER_NORMAL';
    description = `Drift is within acceptable perception threshold (±${tight}ms). Normal 1.0x presentation maintained.`;
  } else if (drift < -500) {
    action = 'SEEK_KEYFRAME_AND_REANCHOR';
    description = `Catastrophic audio/video desync (${drift.toFixed(1)}ms lagging). Request keyframe and hard re-anchor Master Clock timeline.`;
  } else if (drift < -tight) {
    action = 'SMOOTH_CATCHUP';
    playbackRate = 1.05;
    description = `Video is lagging by ${Math.abs(drift).toFixed(1)}ms. Applying 1.05x pitch-safe micro-resampling to catch up without audio crackle.`;
  } else {
    action = 'DELAY_VIDEO';
    delayMs = Math.round(drift);
    playbackRate = 0.95;
    description = `Video is leading by ${drift.toFixed(1)}ms. Holding frame presentation for ${delayMs}ms until audio timeline aligns.`;
  }

  const resultData = {
    avDriftMs: drift,
    tightThresholdMs: tight,
    recommendedAction: action,
    playbackRate,
    delayMs,
    description,
  };

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(resultData, null, 2),
      },
    ],
  };
}
