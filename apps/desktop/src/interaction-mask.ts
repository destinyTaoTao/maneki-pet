export const MASK_SIZE = 128;

export interface InteractionRect {
  left: number;
  top: number;
  width: number;
  height: number;
  radius: number;
}

/** 只保存小尺寸 alpha 位图，不保存色彩或额外的媒体解码副本。 */
export function packAlphaMask(rgba: Uint8ClampedArray): number[] {
  const bits = new Array<number>(Math.ceil(rgba.length / 4 / 8)).fill(0);
  for (let index = 0; index < rgba.length / 4; index += 1) {
    if ((rgba[index * 4 + 3] ?? 0) >= 16) bits[index >> 3]! |= 1 << (index & 7);
  }
  return bits;
}

export function containRect(width: number, height: number, sourceWidth: number, sourceHeight: number): { left: number; top: number; width: number; height: number } {
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const fittedWidth = sourceWidth * scale;
  const fittedHeight = sourceHeight * scale;
  return { left: (width - fittedWidth) / 2, top: (height - fittedHeight) / 2, width: fittedWidth, height: fittedHeight };
}
