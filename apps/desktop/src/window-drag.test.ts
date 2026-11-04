import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  outerPosition: vi.fn(), scaleFactor: vi.fn(), setPosition: vi.fn(),
  outerSize: vi.fn(), startDragging: vi.fn(), availableMonitors: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => native,
  availableMonitors: native.availableMonitors,
  PhysicalPosition: class { constructor(public x: number, public y: number) {} },
}));
import { attachWindowDrag } from "./window-drag.js";

class Handle extends EventTarget {
  captured = new Set<number>();
  setPointerCapture(id: number): void { this.captured.add(id); }
  hasPointerCapture(id: number): boolean { return this.captured.has(id); }
  releasePointerCapture(id: number): void { this.captured.delete(id); }
}

const settle = async (): Promise<void> => { for (let i = 0; i < 32; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("window drag", () => {
  let element: Handle;
  let handle: ReturnType<typeof attachWindowDrag>;
  let frames: Map<number, FrameRequestCallback>;
  let now: number;
  let origin: { x: number; y: number };
  let scale: number;
  let frameId: number;
  const pointer = (type: string, screenX: number, screenY = 250, pointerId = 1): void => {
    const event = new Event(type);
    // 真实窗口每次移动后 client 坐标随之改变，屏幕上的光标轨迹保持连续。
    Object.assign(event, { button: 0, pointerId, screenX, screenY,
      clientX: screenX - origin.x / scale, clientY: screenY - origin.y / scale });
    element.dispatchEvent(event);
  };
  const frame = async (): Promise<void> => {
    now += 16;
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(now));
    await settle();
  };
  beforeEach(() => {
    vi.resetAllMocks();
    now = 0; frameId = 0; scale = 1.5; origin = { x: 300, y: 200 };
    frames = new Map();
    const window = Object.assign(new EventTarget(), {
      requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; },
      cancelAnimationFrame: (id: number) => { frames.delete(id); },
    });
    vi.stubGlobal("window", window);
    vi.spyOn(performance, "now").mockImplementation(() => now);
    native.outerPosition.mockImplementation(async () => ({ ...origin }));
    native.scaleFactor.mockImplementation(async () => scale);
    native.setPosition.mockImplementation(async (position: typeof origin) => { origin = { ...position }; });
    native.outerSize.mockResolvedValue({ width: 300, height: 360 });
    native.availableMonitors.mockResolvedValue([]);
    native.startDragging.mockResolvedValue(undefined);
    element = new Handle();
    handle = attachWindowDrag(element as unknown as HTMLElement);
  });
  afterEach(() => { handle.detach(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("follows screen movement without jumping back as the window moves", async () => {
    pointer("pointerdown", 250);
    await settle();
    for (const x of [270, 290, 310, 330]) {
      pointer("pointermove", x);
      await frame();
      expect(origin.x).toBe(300 + (x - 250) * scale);
    }
  });

  it("coalesces high frequency input and never overlaps native moves", async () => {
    const move = deferred<void>();
    native.setPosition.mockReturnValueOnce(move.promise);
    pointer("pointerdown", 250);
    await settle();
    for (const x of [260, 270, 280]) pointer("pointermove", x);
    expect(native.setPosition).not.toHaveBeenCalled();
    await frame();
    expect(native.setPosition).toHaveBeenCalledTimes(1);
    for (const x of [290, 300, 310]) pointer("pointermove", x);
    await frame();
    expect(native.setPosition).toHaveBeenCalledTimes(1);
    move.resolve(); await settle(); await frame();
    expect(native.setPosition).toHaveBeenCalledTimes(2);
    expect(native.setPosition).toHaveBeenLastCalledWith(expect.objectContaining({ x: 390, y: 200 }));
  });

  it("keeps a click still and suppresses only the click following a drag", async () => {
    pointer("pointerdown", 250); await settle();
    pointer("pointermove", 252); pointer("pointerup", 252); await frame();
    expect(native.setPosition).not.toHaveBeenCalled();
    expect(handle.consumeRecentDrag()).toBe(false);
    pointer("pointerdown", 250); await settle();
    now += 200;
    pointer("pointermove", 270); pointer("pointerup", 270); await frame();
    expect(origin.x).toBe(330);
    expect(element.captured.size).toBe(0);
    expect(handle.consumeRecentDrag()).toBe(true);
    expect(handle.consumeRecentDrag()).toBe(false);
  });

  it.each(["pointercancel", "lostpointercapture"])("stops queued movement without flinging after %s", async (type) => {
    pointer("pointerdown", 250); await settle();
    now += 16; pointer("pointermove", 300);
    pointer(type, 300); await settle(); await frame();
    expect(native.setPosition).not.toHaveBeenCalled();
    expect(native.availableMonitors).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it("ignores an old initialization resolving during a new gesture", async () => {
    const first = deferred<typeof origin>();
    native.outerPosition.mockReturnValueOnce(first.promise);
    pointer("pointerdown", 250); await settle();
    pointer("pointerup", 250);
    pointer("pointerdown", 300); await settle();
    first.resolve({ x: -999, y: -999 }); await settle();
    pointer("pointermove", 320); await frame();
    expect(origin).toEqual({ x: 330, y: 200 });
  });

  it.each(["new gesture", "detach"])("does not revive an old fling after %s", async (action) => {
    const monitors = deferred<never[]>();
    native.availableMonitors.mockReturnValueOnce(monitors.promise);
    pointer("pointerdown", 250); await settle();
    now += 16; pointer("pointermove", 300); pointer("pointerup", 300); await settle();
    expect(native.availableMonitors).toHaveBeenCalledTimes(1);
    if (action === "detach") handle.detach();
    else { pointer("pointerdown", 300); await settle(); }
    const count = native.setPosition.mock.calls.length;
    monitors.resolve([]); await settle(); await frame(); await frame();
    expect(native.setPosition).toHaveBeenCalledTimes(count);
    expect(frames.size).toBe(0);
  });

  it("serializes the last drag position and fling while native movement is slow", async () => {
    const movement = deferred<void>();
    native.setPosition.mockReturnValueOnce(movement.promise);
    pointer("pointerdown", 250); await settle();
    pointer("pointermove", 270); await frame();
    pointer("pointermove", 300); pointer("pointerup", 310); await settle();
    expect(native.setPosition).toHaveBeenCalledTimes(1);
    movement.resolve(); await settle();
    expect(native.setPosition).toHaveBeenCalledTimes(2);
    expect(origin.x).toBe(390);
    await frame();
    expect(origin.x).toBeGreaterThan(390);
  });
});
