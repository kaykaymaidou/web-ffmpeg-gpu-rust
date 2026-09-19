export function copyBytes(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.byteLength);
  out.set(src);
  return out;
}

export function toArrayBuffer(part: Uint8Array): ArrayBuffer {
  return copyBytes(part).buffer as ArrayBuffer;
}

export function videoCodecFamily(codec: string): 'avc' | 'hevc' | 'other' {
  const c = codec.toLowerCase();
  if (c.startsWith('avc')) {
    return 'avc';
  }
  if (c.startsWith('hvc') || c.startsWith('hev')) {
    return 'hevc';
  }
  return 'other';
}

export function bytesEqual(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (!a && !b) {
    return true;
  }
  if (!a || !b || a.byteLength !== b.byteLength) {
    return false;
  }
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}
