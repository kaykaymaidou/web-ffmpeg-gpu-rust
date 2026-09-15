/** BT.601 luma, matches crates/core RustCpuFilter::grayscale_rgba */
export function grayscaleRgbaInPlace(data: Uint8Array): void {
  for (let i = 0; i + 3 < data.length; i += 4) {
    const gray = ((data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000) | 0;
    data[i] = gray;
    data[i + 1] = gray;
    data[i + 2] = gray;
  }
}
