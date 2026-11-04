import { expect, it } from "vitest";
import { containRect, packAlphaMask } from "./interaction-mask.js";

it("透明留白不进入位图，人物像素与可见边缘进入位图", () => {
  expect(packAlphaMask(new Uint8ClampedArray([
    255, 255, 255, 0,
    255, 255, 255, 255,
    0, 0, 0, 16,
    0, 0, 0, 1,
  ]))).toEqual([6]);
});

it("非正方形素材保留 contain 留白，避免把透明边距拉成可点击区域", () => {
  expect(containRect(128, 128, 256, 128)).toEqual({ left: 0, top: 32, width: 128, height: 64 });
  expect(containRect(128, 128, 128, 256)).toEqual({ left: 32, top: 0, width: 64, height: 128 });
});
