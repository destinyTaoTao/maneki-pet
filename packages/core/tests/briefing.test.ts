import { describe, expect, it } from "vitest";

import {
  ProactiveEngine,
  defaultProactiveConfig,
  type BriefingItem,
  type BriefingSource,
  type ProactiveChannelState,
} from "../src/index.js";

const fallbackCopy = { murmur: "喵", daily_briefing: "今日简报来了" };

function makeClockAt(startUtcMs: number) {
  let currentMs = startUtcMs;
  return {
    clock: () => new Date(currentMs),
    advanceMs: (ms: number) => {
      currentMs += ms;
    },
  };
}

const channelsOn: ProactiveChannelState = { bubble: true, notification: true, tts: false };

function briefingSource(items: BriefingItem[]): BriefingSource & { current: BriefingItem[] } {
  return {
    current: items,
    collect: () => items,
  };
}

const taskItems: BriefingItem[] = [
  { kind: "task_status", text: "README 翻译任务已完成" },
  { kind: "reminder", text: "今天 15:00 有评审提醒" },
];

describe("ProactiveEngine 每日简报触发", () => {
  const enabledConfig = {
    ...defaultProactiveConfig,
    daily_briefing: { enabled: true, scheduledHour: 9, scheduledMinute: 0, maxPerDay: 1 },
  };

  it("默认关闭时不触发", () => {
    const { clock } = makeClockAt(Date.UTC(2026, 9, 31, 10, 0));
    const engine = new ProactiveEngine({
      clock,
      channels: () => channelsOn,
      dnd: () => false,
      fallbackCopy,
    });
    expect(engine.evaluateBriefing(briefingSource(taskItems))).toEqual({
      fire: false,
      reason: "disabled",
    });
  });

  it("开启后未到配置时间点不触发", () => {
    const { clock } = makeClockAt(Date.UTC(2026, 9, 31, 8, 50));
    const engine = new ProactiveEngine({
      clock,
      config: enabledConfig,
      channels: () => channelsOn,
      dnd: () => false,
      fallbackCopy,
    });
    expect(engine.evaluateBriefing(briefingSource(taskItems))).toEqual({
      fire: false,
      reason: "not-due",
    });
  });

  it("到点且有内容时触发", () => {
    const { clock } = makeClockAt(Date.UTC(2026, 9, 31, 9, 0));
    const engine = new ProactiveEngine({
      clock,
      config: enabledConfig,
      channels: () => channelsOn,
      dnd: () => false,
      fallbackCopy,
    });
    expect(engine.evaluateBriefing(briefingSource(taskItems))).toEqual({ fire: true });
  });

  it("无料不发：到点但没有新内容时不硬凑，同日有内容后仍可触发", () => {
    const { clock } = makeClockAt(Date.UTC(2026, 9, 31, 9, 0));
    const engine = new ProactiveEngine({
      clock,
      config: enabledConfig,
      channels: () => channelsOn,
      dnd: () => false,
      fallbackCopy,
    });
    expect(engine.evaluateBriefing(briefingSource([]))).toEqual({ fire: false, reason: "no-content" });
    expect(engine.briefingStatus().sentToday).toBe(false);
    expect(engine.evaluateBriefing(briefingSource(taskItems))).toEqual({ fire: true });
  });

  it("当日已发后不再发；次日恢复可发（当日失效）", () => {
    const { clock, advanceMs } = makeClockAt(Date.UTC(2026, 9, 31, 9, 0));
    const engine = new ProactiveEngine({
      clock,
      config: enabledConfig,
      channels: () => channelsOn,
      dnd: () => false,
      fallbackCopy,
    });
    expect(engine.evaluateBriefing(briefingSource(taskItems))).toEqual({ fire: true });
    engine.markBriefingSent();
    expect(engine.briefingStatus().sentToday).toBe(true);
    expect(engine.evaluateBriefing(briefingSource(taskItems))).toEqual({
      fire: false,
      reason: "already-sent",
    });
    advanceMs(24 * 60 * 60 * 1000);
    expect(engine.briefingStatus().sentToday).toBe(false);
    expect(engine.evaluateBriefing(briefingSource(taskItems))).toEqual({ fire: true });
  });

  it("简报占用防打扰预算：maxPerDay 内可发，超过后当日拦截", () => {
    const { clock } = makeClockAt(Date.UTC(2026, 9, 31, 9, 0));
    const engine = new ProactiveEngine({
      clock,
      config: {
        ...defaultProactiveConfig,
        daily_briefing: { enabled: true, scheduledHour: 9, scheduledMinute: 0, maxPerDay: 2 },
      },
      channels: () => channelsOn,
      dnd: () => false,
      fallbackCopy,
    });
    expect(engine.evaluateBriefing(briefingSource(taskItems))).toEqual({ fire: true });
    engine.markBriefingSent();
    expect(engine.evaluateBriefing(briefingSource(taskItems))).toEqual({ fire: true });
    engine.markBriefingSent();
    expect(engine.evaluateBriefing(briefingSource(taskItems))).toEqual({
      fire: false,
      reason: "already-sent",
    });
  });

  it("勿扰内完全静默，通道全关不触发", () => {
    const { clock } = makeClockAt(Date.UTC(2026, 9, 31, 9, 0));
    const dndEngine = new ProactiveEngine({
      clock,
      config: enabledConfig,
      channels: () => channelsOn,
      dnd: () => true,
      fallbackCopy,
    });
    expect(dndEngine.evaluateBriefing(briefingSource(taskItems))).toEqual({ fire: false, reason: "dnd" });

    const noChannelEngine = new ProactiveEngine({
      clock,
      config: enabledConfig,
      channels: () => ({ bubble: false, notification: false, tts: false }),
      dnd: () => false,
      fallbackCopy,
    });
    expect(noChannelEngine.evaluateBriefing(briefingSource(taskItems))).toEqual({
      fire: false,
      reason: "no-channel",
    });
  });
});
