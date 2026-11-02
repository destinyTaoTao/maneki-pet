/** 解码前的像素预算；不等同于浏览器实际内存占用。 */
export const MAX_MEDIA_PIXELS = 8 * 1024 * 1024;
export class MediaBudgetError extends Error {}

export function withinPixelBudget(width: number, height: number): boolean {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 && width * height <= MAX_MEDIA_PIXELS;
}

/** 在创建位图前读取 PNG/WebP 尺寸，未知或截断头部直接拒绝。 */
export function imageWithinPixelBudget(buffer: ArrayBuffer, mime: string): boolean {
  const dimensions = imageDimensions(buffer, mime);
  return !!dimensions && withinPixelBudget(dimensions.width, dimensions.height);
}

export function imageDimensions(buffer: ArrayBuffer, mime: string): { width: number; height: number } | undefined {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (mime === "image/png") {
    if (bytes.length < 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b) ||
        String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") return undefined;
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mime !== "image/webp" || bytes.length < 20 ||
      String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF" ||
      String.fromCharCode(...bytes.slice(8, 12)) !== "WEBP") return undefined;
  const type = String.fromCharCode(...bytes.slice(12, 16));
  if (type === "VP8X" && bytes.length >= 30) {
    const width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16);
    const height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
    return { width, height };
  }
  if (type === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (type === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return undefined;
}
