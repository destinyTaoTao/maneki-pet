// 手动窗口拖拽与甩抛：startDragging 进入系统拖拽循环后收不到指针事件，
// 因此按屏幕坐标计算位移，合并每帧的位置更新，并在释放时按采样速度甩抛。
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
  let moveFrame = 0;
  let moveInFlight: Promise<void> | undefined;
  let queuedPosition: Point | undefined;
  let generation = 0;
  let detached = false;
  let latestPointer: { screenX: number; screenY: number; timeMs: number } | undefined;
  let start: { screenX: number; screenY: number; origin: Point; scale: number } | undefined;
  let samples: DragSample[] = [];

  // 高频输入只保留最新位置；慢 IPC 不积压过期位置，也不与甩抛并发写窗口。
  const flushMove = (): Promise<void> | undefined => {
    if (moveInFlight || !queuedPosition || detached) return moveInFlight;
    const position = queuedPosition;
    queuedPosition = undefined;
    moveInFlight = appWindow
      .setPosition(new PhysicalPosition(position.x, position.y))
      .catch(() => undefined)
      .finally(() => {
        moveInFlight = undefined;
        scheduleMove();
      });
    return moveInFlight;
  };
  const scheduleMove = (): void => {
    if (moveFrame || moveInFlight || !queuedPosition || detached) return;
    moveFrame = window.requestAnimationFrame(() => {
      moveFrame = 0;
      void flushMove();
    });
  };
  const queueMove = (position: Point): void => {
    queuedPosition = position;
    scheduleMove();
  };

  const stopFling = (): void => {
    generation += 1;
    if (flingFrame) {
      window.cancelAnimationFrame(flingFrame);
      flingFrame = 0;
    }
    if (moveFrame) window.cancelAnimationFrame(moveFrame);
    moveFrame = 0;
    queuedPosition = undefined;
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || pendingStart || detached) return;
    stopFling();
    const session = generation;
    pointerId = event.pointerId;
    pendingStart = true;
    dragging = false;
    moved = false;
    samples = [];
    start = undefined;
    latestPointer = undefined;
    element.setPointerCapture(event.pointerId);
    const screenX = event.screenX;
    const screenY = event.screenY;
    void Promise.resolve(moveInFlight)
      .then(() => Promise.all([appWindow.outerPosition(), appWindow.scaleFactor()]))
      .then(([origin, scale]) => {
        if (!pendingStart || session !== generation || detached) return;
        start = {
          screenX,
          screenY,
          origin: { x: origin.x, y: origin.y },
          scale,
        };
        samples = [{ x: origin.x, y: origin.y, timeMs: performance.now() }];
        dragging = true;
        if (latestPointer) updatePosition(latestPointer);
      })
      .catch(() => {
        if (!pendingStart || session !== generation || detached) return;
        // 窗口 API 不可用时退回系统拖拽，不中断交互。
        pendingStart = false;
        pointerId = -1;
        if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
        void appWindow.startDragging().catch(() => undefined);
      });
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!pendingStart || event.pointerId !== pointerId) return;
    latestPointer = { screenX: event.screenX, screenY: event.screenY, timeMs: performance.now() };
    updatePosition(latestPointer);
  };

  const updatePosition = (pointer: { screenX: number; screenY: number; timeMs: number }): void => {
    if (!dragging || !start) return;
    const deltaX = pointer.screenX - start.screenX;
    const deltaY = pointer.screenY - start.screenY;
    const position = {
      x: Math.round(start.origin.x + deltaX * start.scale),
      y: Math.round(start.origin.y + deltaY * start.scale),
    };
    moved =
      moved ||
      Math.abs(deltaX) + Math.abs(deltaY) > CLICK_SLOP_PX;
    if (!moved) return;
    pushSample({ x: position.x, y: position.y, timeMs: pointer.timeMs });
    queueMove(position);
  };

  const onPointerEnd = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId) return;
    // 正常释放计入最后一个屏幕坐标；取消/失去捕获只停止，不能启动甩抛。
    if (event.type === "pointerup") onPointerMove(event);
    pendingStart = false;
    pointerId = -1;
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    if (!dragging || !start) return;
    dragging = false;
    if (!moved) return;
    recentDrag = true;
    if (event.type !== "pointerup") { stopFling(); return; }
    const velocity = velocityFromSamples(samples);
    if (Math.hypot(velocity.x, velocity.y) < FLING_MIN_SPEED_PX_PER_MS) return;
    const lastSample = samples[samples.length - 1];
    if (!lastSample) return;
    void startFling({ x: lastSample.x, y: lastSample.y }, velocity);
  };

  const startFling = (position: Point, velocity: Point): void => {
    const session = generation;
    void (async () => {
      // 松手前的最后一次移动必须先落地，避免甩抛与拖拽位置交错。
      while (moveInFlight || queuedPosition) {
        if (moveFrame) window.cancelAnimationFrame(moveFrame);
        moveFrame = 0;
        await flushMove();
        if (session !== generation || detached) return;
      }
      const monitors = await loadMonitorRects();
      const size = await appWindow
        .outerSize()
        .then((value: PhysicalSize) => ({ width: value.width, height: value.height }))
        .catch(() => ({ width: 0, height: 0 }));
      if (session !== generation || detached) return;
      let current = monitors.length > 0 ? clampToMonitors(position, size, monitors) : position;
      let currentVelocity = velocity;
      let previous = performance.now();
      const tick = (now: number): void => {
        flingFrame = 0;
        if (session !== generation || detached) return;
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
        queuedPosition = { x: Math.round(current.x), y: Math.round(current.y) };
        const movement = flushMove();
        if (step.stopped || (currentVelocity.x === 0 && currentVelocity.y === 0)) {
          flingFrame = 0;
          return;
        }
        void movement?.then(() => {
          if (session === generation && !detached) flingFrame = window.requestAnimationFrame(tick);
        });
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
  element.addEventListener("lostpointercapture", onPointerEnd);

  return {
    consumeRecentDrag: () => {
      const value = recentDrag;
      recentDrag = false;
      return value;
    },
    detach: () => {
      detached = true;
      stopFling();
      pendingStart = false;
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
      pointerId = -1;
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", onPointerEnd);
      element.removeEventListener("pointercancel", onPointerEnd);
      element.removeEventListener("lostpointercapture", onPointerEnd);
    },
  };
}
