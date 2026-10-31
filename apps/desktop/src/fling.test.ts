import { describe, expect, it } from "vitest";

import {
  clampToMonitors,
  stepFling,
  velocityFromSamples,
  type DragSample,
  type Rect,
} from "./fling.js";

function samplesOf(points: [number, number, number][]): DragSample[] {
  return points.map(([x, y, timeMs]) => ({ x, y, timeMs }));
}

describe("velocityFromSamples", () => {
  it("computes velocity over the recent sampling window", () => {
    const velocity = velocityFromSamples(
      samplesOf([
        [0, 0, 0],
        [10, 5, 80],
      ]),
    );

    expect(velocity.x).toBeCloseTo(10 / 80);
    expect(velocity.y).toBeCloseTo(5 / 80);
  });

  it("ignores samples older than the window when newer ones exist", () => {
    const velocity = velocityFromSamples(
      samplesOf([
        [0, 0, 0],
        [500, 500, 1000],
        [510, 505, 1080],
      ]),
      90,
    );

    expect(velocity.x).toBeCloseTo(10 / 80);
    expect(velocity.y).toBeCloseTo(5 / 80);
  });

  it("returns zero for fewer than two samples or zero elapsed time", () => {
    expect(velocityFromSamples(samplesOf([[1, 2, 5]])).x).toBe(0);
    expect(velocityFromSamples(samplesOf([[1, 2, 5], [1, 2, 5]])).y).toBe(0);
  });
});

describe("stepFling", () => {
  it("advances the position with the decaying velocity", () => {
    const step = stepFling({ x: 0, y: 0 }, { x: 1, y: -0.5 }, 16, 0.002);

    const decay = Math.exp(-0.002 * 16);
    expect(step.velocity.x).toBeCloseTo(decay);
    expect(step.velocity.y).toBeCloseTo(-0.5 * decay);
    expect(step.position.x).toBeCloseTo(step.velocity.x * 16);
    expect(step.position.y).toBeCloseTo(step.velocity.y * 16);
    expect(step.stopped).toBe(false);
  });

  it("reports stopped once the speed falls below the threshold", () => {
    let position = { x: 0, y: 0 };
    let velocity = { x: 0.3, y: 0 };
    let stopped = false;
    for (let index = 0; index < 2000 && !stopped; index += 1) {
      const step = stepFling(position, velocity, 16, 0.002);
      position = step.position;
      velocity = step.velocity;
      stopped = step.stopped;
    }

    expect(stopped).toBe(true);
    expect(Math.hypot(velocity.x, velocity.y)).toBeLessThan(0.04);
  });

  it("stops immediately for a zero velocity", () => {
    const step = stepFling({ x: 5, y: 6 }, { x: 0, y: 0 }, 16);

    expect(step.stopped).toBe(true);
    expect(step.position).toEqual({ x: 5, y: 6 });
  });
});

describe("clampToMonitors", () => {
  const monitor: Rect = { x: 0, y: 0, width: 1920, height: 1080 };

  it("keeps an inside position unchanged", () => {
    const clamped = clampToMonitors({ x: 800, y: 400 }, { width: 300, height: 360 }, [monitor]);

    expect(clamped).toEqual({ x: 800, y: 400 });
  });

  it("pulls a window that flew past the right edge back into view", () => {
    const clamped = clampToMonitors({ x: 2400, y: 400 }, { width: 300, height: 360 }, [monitor], 48);

    expect(clamped.x).toBe(1920 - 48);
    expect(clamped.y).toBe(400);
  });

  it("allows the window to hang off the edge while keeping minVisible pixels visible", () => {
    const clamped = clampToMonitors({ x: 1850, y: -500 }, { width: 300, height: 360 }, [monitor], 48);

    expect(clamped.x).toBe(1850);
    expect(clamped.y).toBe(-360 + 48);
  });

  it("selects the monitor with the largest overlap", () => {
    const second: Rect = { x: 1920, y: 0, width: 1920, height: 1080 };

    const clamped = clampToMonitors({ x: 2000, y: 400 }, { width: 300, height: 360 }, [monitor, second]);

    expect(clamped).toEqual({ x: 2000, y: 400 });
  });

  it("returns the position unchanged without monitor information", () => {
    const clamped = clampToMonitors({ x: -9999, y: 9999 }, { width: 300, height: 360 }, []);

    expect(clamped).toEqual({ x: -9999, y: 9999 });
  });
});
