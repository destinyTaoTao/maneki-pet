import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachPetInteraction } from "./pet-interaction.js";
import { MASK_SIZE } from "./interaction-mask.js";

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));

class Element extends EventTarget {
  contains(target: unknown): boolean { return target === this; }
  getBoundingClientRect(): DOMRect {
    return { left: 10, top: 20, right: 234, bottom: 244, width: 224, height: 224 } as DOMRect;
  }
  querySelector(): null { return null; }
}

async function settle(): Promise<void> { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }

describe("pet interaction native bridge", () => {
  let pet: Element;
  let documentEvents: EventTarget;
  let windowEvents: EventTarget;
  let timer: () => void;
  let stop: (() => void) | undefined;
  let context: { clearRect: ReturnType<typeof vi.fn>; getImageData: ReturnType<typeof vi.fn> };
  let canvas: { width: number; height: number; getContext: ReturnType<typeof vi.fn> };
  let unavailable: ReturnType<typeof vi.fn>;
  let unsubscribes: Array<ReturnType<typeof vi.fn>>;
  let controls: HTMLElement[];
  const attach = (): Promise<() => void> => attachPetInteraction(pet as unknown as HTMLElement, () => controls, vi.fn(), vi.fn(), unavailable);
  const pointer = (type: string, pointerId: number): void => {
    const event = new Event(type);
    Object.defineProperties(event, { target: { value: pet }, button: { value: 0 }, pointerId: { value: pointerId } });
    documentEvents.dispatchEvent(event);
  };
  const lastMap = (): { pressed: boolean; mask: number[] } => native.invoke.mock.calls.at(-1)![1].map;

  beforeEach(() => {
    vi.resetAllMocks();
    pet = new Element(); documentEvents = new EventTarget(); windowEvents = new EventTarget();
    context = { clearRect: vi.fn(), getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(MASK_SIZE * MASK_SIZE * 4) })) };
    canvas = { width: 0, height: 0, getContext: vi.fn(() => context) };
    vi.stubGlobal("Node", Element);
    vi.stubGlobal("innerWidth", 300); vi.stubGlobal("innerHeight", 360);
    vi.stubGlobal("getComputedStyle", () => ({ borderTopLeftRadius: "0px" }));
    vi.stubGlobal("document", Object.assign(documentEvents, { createElement: () => canvas }));
    vi.stubGlobal("window", Object.assign(windowEvents, { setInterval: (callback: () => void) => { timer = callback; return 42; } }));
    vi.stubGlobal("clearInterval", vi.fn());
    native.invoke.mockResolvedValue(undefined);
    unsubscribes = [];
    native.listen.mockImplementation(async () => { const unsubscribe = vi.fn(); unsubscribes.push(unsubscribe); return unsubscribe; });
    unavailable = vi.fn(); controls = [];
  });
  afterEach(() => { stop?.(); stop = undefined; vi.unstubAllGlobals(); });

  it("releases a lost pointer capture and ignores a different pointer release", async () => {
    stop = await attach(); await settle();
    pointer("pointerdown", 7); await settle(); expect(lastMap().pressed).toBe(true);
    pointer("lostpointercapture", 8); await settle(); expect(lastMap().pressed).toBe(true);
    pointer("lostpointercapture", 7); await settle(); expect(lastMap().pressed).toBe(false);
  });

  it("sends only the latest map while slow IPC is in flight", async () => {
    let finish!: () => void;
    native.invoke.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    stop = await attach();
    pointer("pointerdown", 7);
    pointer("lostpointercapture", 7);
    timer();
    expect(native.invoke).toHaveBeenCalledTimes(1);
    finish(); await settle();
    expect(native.invoke).toHaveBeenCalledTimes(1);
    pointer("pointerdown", 7); await settle();
    expect(lastMap().pressed).toBe(true);
    expect(native.invoke).toHaveBeenCalledTimes(2);
  });

  it("clears stale alpha after an unreadable frame and allows the next frame to recover", async () => {
    context.getImageData.mockImplementationOnce(() => { throw new Error("unreadable alpha"); });
    stop = await attach(); await settle();
    expect(lastMap().mask).toHaveLength(MASK_SIZE * MASK_SIZE / 8);
    expect(lastMap().mask.every((value) => value === 0)).toBe(true);
    expect(unavailable).toHaveBeenCalledTimes(1);
    const data = new Uint8ClampedArray(MASK_SIZE * MASK_SIZE * 4); data[3] = 255;
    context.getImageData.mockReturnValue({ data }); timer(); await settle();
    expect(lastMap().mask[0]).toBe(1);
  });

  it("keeps tray recovery and control hit maps available without a canvas context", async () => {
    canvas.getContext.mockReturnValue(null);
    stop = await attach(); await settle();
    expect(unavailable).toHaveBeenCalledOnce();
    expect(native.listen).toHaveBeenCalledWith("maneki://show-controls", expect.any(Function));
    controls = [pet as unknown as HTMLElement]; timer(); await settle();
    expect(native.invoke).toHaveBeenLastCalledWith("update_hit_map", expect.objectContaining({
      map: expect.objectContaining({ controls: [expect.objectContaining({ left: 10, top: 20, width: 224, height: 224 })] }),
    }));
    expect(lastMap().mask.every((value) => value === 0)).toBe(true);
  });

  it("removes subscriptions and listeners and never drains queued maps after disposal", async () => {
    let finish!: () => void;
    native.invoke.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    stop = await attach(); pointer("pointerdown", 7);
    stop(); stop = undefined; finish(); await settle();
    pointer("lostpointercapture", 7); timer(); await settle();
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(unsubscribes.every((unsubscribe) => unsubscribe.mock.calls.length === 1)).toBe(true);
    expect(clearInterval).toHaveBeenCalledWith(42);
    expect(canvas.width).toBe(0);
  });

  it("removes the first subscription when the second subscription fails", async () => {
    native.listen.mockRejectedValueOnce(new Error("listen unavailable"));
    await expect(attach()).rejects.toThrow("listen unavailable");
    expect(native.invoke).not.toHaveBeenCalled();
    // 第一项成功、第二项失败时也不遗留第一项订阅。
    native.listen.mockImplementationOnce(async () => { const unsubscribe = vi.fn(); unsubscribes.push(unsubscribe); return unsubscribe; });
    native.listen.mockRejectedValueOnce(new Error("show unavailable"));
    await expect(attach()).rejects.toThrow("show unavailable");
    expect(unsubscribes[0]).toHaveBeenCalledOnce();
  });
});
