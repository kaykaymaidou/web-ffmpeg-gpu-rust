export type ConcatXfadeOptions = {
  durationSec?: number;
  height?: 720;
};

export type ExtractStillsOptions = {
  first?: boolean;
  last?: boolean;
};

export type ConcatTranscodeOptions = {
  preset?: 'social-720p' | 'hd-1080p' | 'original-slim';
};

function notImplemented(name: string): never {
  const err = new Error(
    `${name} needs WebCodecs pixel decode/encode (browser). Nest/Node has neither; do not spawn system ffmpeg.`
  );
  err.name = 'NotImplementedError';
  (err as Error & { code: string }).code = 'NOT_IMPLEMENTED';
  throw err;
}

function hasWebCodecs(): boolean {
  return typeof VideoDecoder !== 'undefined' && typeof VideoEncoder !== 'undefined';
}

/** Pixel-path splice. Not packet remux. */
export async function concatXfade(parts: Uint8Array[], opts?: ConcatXfadeOptions): Promise<Uint8Array> {
  if (!hasWebCodecs()) {
    return notImplemented('concatXfade');
  }
  const { decodeConcatXfade } = await import('./pixel-decode.js');
  return decodeConcatXfade(parts, opts);
}

/** Decode first/last stills to JPEG bytes. */
export async function extractStills(
  bytes: Uint8Array,
  opts?: ExtractStillsOptions
): Promise<{ first?: Uint8Array; last?: Uint8Array }> {
  if (typeof VideoDecoder === 'undefined') {
    return notImplemented('extractStills');
  }
  const { decodeExtractStills } = await import('./pixel-decode.js');
  return decodeExtractStills(bytes, opts);
}

/** Re-encode each part to a shared preset, then remux with concatCopy. */
export async function concatTranscode(
  parts: Uint8Array[],
  opts?: ConcatTranscodeOptions
): Promise<Uint8Array> {
  if (!hasWebCodecs()) {
    return notImplemented('concatTranscode');
  }
  const { decodeConcatTranscode } = await import('./pixel-decode.js');
  return decodeConcatTranscode(parts, opts);
}
