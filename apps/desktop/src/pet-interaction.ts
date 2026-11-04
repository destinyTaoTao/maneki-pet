import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MASK_SIZE, containRect, packAlphaMask, type InteractionRect } from "./interaction-mask.js";

interface Hover { overPet: boolean; overControls: boolean; unavailable: boolean }

function rectOf(element: HTMLElement): InteractionRect {
  const rect = element.getBoundingClientRect();
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  return {
    left, top,
    width: Math.max(0, Math.min(innerWidth, rect.right) - left),
    height: Math.max(0, Math.min(innerHeight, rect.bottom) - top),
    radius: Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0,
  };
}

export async function attachPetInteraction(
  pet: HTMLElement,
  controls: () => HTMLElement[],
  onHover: (hover: Hover) => void,
  onShow: () => void,
  onUnavailable: () => void,
): Promise<() => void> {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = MASK_SIZE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) { onUnavailable(); return () => undefined; }
  let closed = false;
  let pressedPointer: number | undefined;
  let pending = false;
  let queued: string | undefined;
  let last = "";
  let lastSent = 0;
  let reported = false;
  const unavailable = (): void => { if (!reported) { reported = true; onUnavailable(); } };
  const send = (payload: string): void => {
    if (closed) return;
    if (pending) { queued = payload; return; }
    pending = true;
    last = payload;
    lastSent = performance.now();
    void invoke("update_hit_map", { map: JSON.parse(payload) as unknown }).catch(unavailable).finally(() => {
      pending = false;
      if (queued !== undefined && !closed) {
        const next = queued;
        queued = undefined;
        if (next !== last || performance.now() - lastSent >= 1_000) send(next);
      }
    });
  };
  const update = (): void => {
    if (closed) return;
    context.clearRect(0, 0, MASK_SIZE, MASK_SIZE);
    try {
      const video = pet.querySelector("video");
      const strip = pet.querySelector<HTMLImageElement>(".sprite-strip");
      const image = pet.querySelector<HTMLImageElement>("img.pet-media");
      if (video && video.readyState >= 2) {
        const fit = containRect(MASK_SIZE, MASK_SIZE, video.videoWidth, video.videoHeight);
        context.drawImage(video, fit.left, fit.top, fit.width, fit.height);
      } else if (strip?.complete && strip.naturalWidth > 0) {
        const frame = strip.parentElement!.getBoundingClientRect();
        const full = strip.getBoundingClientRect();
        const sourceX = (frame.left - full.left) / full.width * strip.naturalWidth;
        const sourceWidth = frame.width / full.width * strip.naturalWidth;
        context.drawImage(strip, sourceX, 0, sourceWidth, strip.naturalHeight, 0, 0, MASK_SIZE, MASK_SIZE);
      } else if (image?.complete && image.naturalWidth > 0) {
        const fit = containRect(MASK_SIZE, MASK_SIZE, image.naturalWidth, image.naturalHeight);
        context.drawImage(image, fit.left, fit.top, fit.width, fit.height);
      }
      const mask = packAlphaMask(context.getImageData(0, 0, MASK_SIZE, MASK_SIZE).data);
      const payload = JSON.stringify({ pet: { ...rectOf(pet), radius: 0 }, mask, controls: controls().map(rectOf), pressed: pressedPointer !== undefined });
      if (pending) queued = payload;
      else if (payload !== last || performance.now() - lastSent >= 1_000) send(payload);
    } catch {
      // 无法读取 alpha 时清除旧轮廓，控件仍可由托盘“显示”恢复。
      canvas.width = MASK_SIZE;
      const payload = JSON.stringify({ pet: rectOf(pet), mask: new Array<number>(MASK_SIZE * MASK_SIZE / 8).fill(0), controls: controls().map(rectOf), pressed: pressedPointer !== undefined });
      if (pending) queued = payload;
      else if (payload !== last || performance.now() - lastSent >= 1_000) send(payload);
      unavailable();
    }
  };
  const down = (event: PointerEvent): void => {
    if (event.button !== 0 || pressedPointer !== undefined || !(event.target instanceof Node)) return;
    if (pet.contains(event.target) || controls().some((element) => element.contains(event.target as Node))) {
      pressedPointer = event.pointerId;
      update();
    }
  };
  const release = (event: Event): void => {
    if ("pointerId" in event && event.pointerId !== pressedPointer) return;
    pressedPointer = undefined;
    update();
  };
  const stopHover = await listen<Hover>("maneki://pointer-region", (event) => {
    onHover(event.payload);
    if (event.payload.unavailable) unavailable();
  });
  let stopShow: () => void;
  try { stopShow = await listen("maneki://show-controls", onShow); }
  catch (error) { stopHover(); throw error; }
  const timer = window.setInterval(update, 80);
  document.addEventListener("pointerdown", down, true);
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
  document.addEventListener("lostpointercapture", release, true);
  window.addEventListener("blur", release);
  update();
  return () => {
    closed = true;
    clearInterval(timer);
    stopHover(); stopShow();
    document.removeEventListener("pointerdown", down, true);
    window.removeEventListener("pointerup", release);
    window.removeEventListener("pointercancel", release);
    document.removeEventListener("lostpointercapture", release, true);
    window.removeEventListener("blur", release);
    canvas.width = canvas.height = 0;
  };
}
