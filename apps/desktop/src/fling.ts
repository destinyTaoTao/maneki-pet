// 甩抛几何与运动学：纯函数，接收显式时间与参数，方便单元测试与设备调参。
export interface Point {
  x: number;
  y: number;
}

export interface DragSample {
  x: number;
  y: number;
  timeMs: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 默认指数摩擦系数（每毫秒），决定甩抛滑行距离；设备验收后可再调。 */
export const FLING_FRICTION_PER_MS = 0.0022;
/** 速度低于该阈值（像素/毫秒）视为停止。 */
export const FLING_STOP_SPEED_PX_PER_MS = 0.04;

/** 取最近 windowMs 内的采样计算速度（像素/毫秒）；采样不足时退回最近两个采样。 */
export function velocityFromSamples(samples: DragSample[], windowMs = 90): Point {
  if (samples.length < 2) return { x: 0, y: 0 };
  const latest = samples[samples.length - 1]!;
  let oldest = samples[samples.length - 2]!;
  for (let index = samples.length - 2; index >= 0; index -= 1) {
    const candidate = samples[index]!;
    if (latest.timeMs - candidate.timeMs > windowMs) break;
    oldest = candidate;
  }
  const dt = latest.timeMs - oldest.timeMs;
  if (dt <= 0) return { x: 0, y: 0 };
  return { x: (latest.x - oldest.x) / dt, y: (latest.y - oldest.y) / dt };
}

/** 甩抛一步：位置按衰减后的速度推进；速度衰减到阈值以下即停止。 */
export function stepFling(
  position: Point,
  velocity: Point,
  dtMs: number,
  frictionPerMs = FLING_FRICTION_PER_MS,
  stopSpeed = FLING_STOP_SPEED_PX_PER_MS,
): { position: Point; velocity: Point; stopped: boolean } {
  const decay = Math.exp(-frictionPerMs * dtMs);
  const nextVelocity = { x: velocity.x * decay, y: velocity.y * decay };
  const nextPosition = {
    x: position.x + nextVelocity.x * dtMs,
    y: position.y + nextVelocity.y * dtMs,
  };
  const speed = Math.hypot(nextVelocity.x, nextVelocity.y);
  return { position: nextPosition, velocity: nextVelocity, stopped: speed < stopSpeed };
}

/**
 * 把窗口矩形夹回包含它最多部分的显示器，保证至少 minVisible 像素可见；
 * 没有显示器信息时原样返回。
 */
export function clampToMonitors(
  position: Point,
  size: { width: number; height: number },
  monitors: Rect[],
  minVisible = 48,
): Point {
  if (monitors.length === 0) return position;
  let best = monitors[0]!;
  let bestScore = -1;
  for (const monitor of monitors) {
    const overlapX =
      Math.min(position.x + size.width, monitor.x + monitor.width) -
      Math.max(position.x, monitor.x);
    const overlapY =
      Math.min(position.y + size.height, monitor.y + monitor.height) -
      Math.max(position.y, monitor.y);
    const score = Math.max(0, overlapX) * Math.max(0, overlapY);
    if (score > bestScore) {
      bestScore = score;
      best = monitor;
    }
  }
  // 窗口左/右边缘都需保证至少 minVisible 像素落在所选显示器内。
  const xLow = best.x - size.width + minVisible;
  const xHigh = best.x + best.width - minVisible;
  const yLow = best.y - size.height + minVisible;
  const yHigh = best.y + best.height - minVisible;
  return {
    x: Math.min(Math.max(position.x, Math.min(xLow, xHigh)), Math.max(xLow, xHigh)),
    y: Math.min(Math.max(position.y, Math.min(yLow, yHigh)), Math.max(yLow, yHigh)),
  };
}
