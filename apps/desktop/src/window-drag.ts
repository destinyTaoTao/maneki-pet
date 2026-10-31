// 手动窗口拖拽与甩抛：startDragging 进入系统拖拽循环后收不到指针事件，
// 因此自行按指针增量 setPosition，并在释放时按采样速度甩抛。
import {
  availableMonitors,
  getCurrentWindow,
  PhysicalPosition,
  type PhysicalSize,
} from "@tauri-apps/api/window";

import {
  clampToMonitors,
  stepFling,
  velocityFromSamples,
  type DragSample,
  type Point,
  type Rect,
} from "./fling.js";

const CLICK_SLOP_PX = 4;
const FLING_MIN_SPEED_PX_PER_MS = 0.25;
const SAMPLE_LIMIT = 8;
// 帧间隔上限：避免失焦等导致的超长 dt 一次跳出国界。
const MAX_FRAME_DT_MS = 64;

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface WindowDragHandle {
  /** 消费一次“刚结束的是拖拽而非点击”标记；用于抑制拖拽后的 click。 */
  consumeRecentDrag: () => boolean;
  detach: () => void;
}

export function attachWindowDrag(element: HTMLElement): WindowDragHandle {
  const appWindow = getCurrentWindow();
  let pointerId = -1;
  let pendingStart = false;
  let dragging = false;
  let moved = false;
  let recentDrag = false;
  let flingFrame = 0;
  let start: { clientX: number; clientY: number; origin: Point; scale: number } | undefined;
  let samples: DragSample[] = [];

  const stopFling = (): void => {
    if (flingFrame) {
      window.cancelAnimationFrame(flingFrame);
      flingFrame = 0;
    }
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    stopFling();
    pointerId = event.pointerId;
    pendingStart = true;
    dragging = false;
    moved = false;
    samples = [];
    element.setPointerCapture(event.pointerId);
    const clientX = event.clientX;
    const clientY = event.clientY;
    Promise.all([appWindow.outerPosition(), appWindow.scaleFactor()])
      .then(([origin, scale]) => {
        if (!pendingStart) return;
        start = {
          clientX,
          clientY,
          origin: { x: origin.x, y: origin.y },
          scale,
        };
        samples = [{ x: origin.x, y: origin.y, timeMs: performance.now() }];
        dragging = true;
      })
      .catch(() => {
        // 窗口 API 不可用时退回系统拖拽，不中断交互。
        pendingStart = false;
        void appWindow.startDragging().catch(() => undefined);
      });
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging || !start || event.pointerId !== pointerId) return;
    const clientDeltaX = event.clientX - start.clientX;
    const clientDeltaY = event.clientY - start.clientY;
    const position = {
      x: Math.round(start.origin.x + clientDeltaX * start.scale),
      y: Math.round(start.origin.y + clientDeltaY * start.scale),
    };
    moved =
      moved ||
      Math.abs(clientDeltaX) + Math.abs(clientDeltaY) > CLICK_SLOP_PX;
    pushSample({ x: position.x, y: position.y, timeMs: performance.now() });
    void appWindow
      .setPosition(new PhysicalPosition(position.x, position.y))
      .catch(() => undefined);
  };

  const onPointerEnd = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId) return;
    pendingStart = false;
    pointerId = -1;
    if (!dragging || !start) return;
    dragging = false;
    if (!moved) return;
    recentDrag = true;
    const velocity = velocityFromSamples(samples);
    if (Math.hypot(velocity.x, velocity.y) < FLING_MIN_SPEED_PX_PER_MS) return;
    const lastSample = samples[samples.length - 1];
    if (!lastSample) return;
    void startFling({ x: lastSample.x, y: lastSample.y }, velocity);
  };

  const startFling = (position: Point, velocity: Point): void => {
    void (async () => {
      const monitors = await loadMonitorRects();
      const size = await appWindow
        .outerSize()
        .then((value: PhysicalSize) => ({ width: value.width, height: value.height }))
        .catch(() => ({ width: 0, height: 0 }));
      let current = monitors.length > 0 ? clampToMonitors(position, size, monitors) : position;
      let currentVelocity = velocity;
      let previous = performance.now();
      const tick = (now: number): void => {
        const dt = Math.min(now - previous, MAX_FRAME_DT_MS);
        previous = now;
        const step = stepFling(current, currentVelocity, dt);
        current = step.position;
        currentVelocity = step.velocity;
        if (monitors.length > 0) {
          const clamped = clampToMonitors(current, size, monitors);
          if (clamped.x !== Math.round(current.x) || clamped.y !== Math.round(current.y)) {
            // 撞到边界即停止，不沿边滑动。
            currentVelocity = { x: 0, y: 0 };
          }
          current = clamped;
        }
        void appWindow
          .setPosition(new PhysicalPosition(Math.round(current.x), Math.round(current.y)))
          .catch(() => undefined);
        if (step.stopped || (currentVelocity.x === 0 && currentVelocity.y === 0)) {
          flingFrame = 0;
          return;
        }
        flingFrame = window.requestAnimationFrame(tick);
      };
      flingFrame = window.requestAnimationFrame(tick);
    })();
  };

  const loadMonitorRects = async (): Promise<Rect[]> => {
    try {
      return (await availableMonitors()).map((monitor) => ({
        x: monitor.position.x,
        y: monitor.position.y,
        width: monitor.size.width,
        height: monitor.size.height,
      }));
    } catch {
      return [];
    }
  };

  const pushSample = (sample: DragSample): void => {
    samples.push(sample);
    if (samples.length > SAMPLE_LIMIT) samples = samples.slice(-SAMPLE_LIMIT);
  };

  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", onPointerEnd);
  element.addEventListener("pointercancel", onPointerEnd);

  return {
    consumeRecentDrag: () => {
      const value = recentDrag;
      recentDrag = false;
      return value;
    },
    detach: () => {
      stopFling();
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", onPointerEnd);
      element.removeEventListener("pointercancel", onPointerEnd);
    },
  };
}
