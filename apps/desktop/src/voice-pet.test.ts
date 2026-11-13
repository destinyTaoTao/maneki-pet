import { expect, it, vi } from "vitest";
import { VoicePetCoordinator } from "./voice-pet.js";
import { VoiceController } from "./voice-controller.js";
import { describeObservedSessions, sessionProgressReply, type SessionObservationSource } from "@maneki-pet/core";

it("录音中保持倾听，缓存宿主最新状态并抑制动作，结束后恢复", () => {
  const deps = { showListening: vi.fn(), setState: vi.fn(), playAction: vi.fn() };
  const pet = new VoicePetCoordinator(deps);
  pet.expressionChanged("waiting_input", false);
  pet.voiceChanged("recording");
  expect(deps.showListening).toHaveBeenLastCalledWith(true);
  expect(deps.setState).toHaveBeenLastCalledWith("thinking");
  expect(deps.playAction).toHaveBeenLastCalledWith("head-tilt");
  pet.expressionChanged("celebrating", true);
  pet.expressionChanged("waiting_input", true);
  pet.playAction("wave");
  expect(deps.playAction).toHaveBeenCalledTimes(1);
  expect(deps.setState).toHaveBeenLastCalledWith("thinking");
  pet.voiceChanged("transcribing");
  expect(deps.showListening).toHaveBeenLastCalledWith(false);
  expect(deps.setState).toHaveBeenLastCalledWith("waiting_input");
});

it("A 等待时按住说话，B 完成不打断倾听，语音查询与面板使用同一观察快照", async () => {
  const deps = { showListening: vi.fn(), setState: vi.fn(), playAction: vi.fn() };
  const pet = new VoicePetCoordinator(deps);
  const sources: SessionObservationSource[] = [{
    clientId: "client", sourceId: "source", profileId: "test", connected: true,
    truncated: false, lastSeenAt: 1,
    sessions: [
      { sessionId: "A", projectName: "project-a", phase: "waiting_input", sequence: 1, observedAt: 1 },
      { sessionId: "B", projectName: "project-b", phase: "working", sequence: 1, observedAt: 1 },
    ],
  }];
  const submitted = vi.fn();
  const controller = new VoiceController({
    capture: () => ({ start: async () => {}, finish: async () => new Uint8Array([1]), cancel: async () => {} }),
    player: { play: async () => {}, stop: () => {} },
    changed: (phase) => pet.voiceChanged(phase), error: vi.fn(), submitted,
    uuid: () => "request",
    transport: { call: async <T>(path: string): Promise<T> => {
      if (path === "/voice/acquire") return { leaseId: "lease", ttlMs: 8000 } as T;
      if (path === "/voice/transcribe") return { requestId: "request", status: "recognized", code: null, transcript: "查看会话进度" } as T;
      if (path === "/voice/submit") return { requestId: "request", status: "submitted", code: null, transcript: "查看会话进度" } as T;
      return {} as T;
    } },
  });
  pet.expressionChanged("waiting_input", false);
  await controller.start();
  sources[0]!.sessions[1]!.phase = "completed";
  pet.expressionChanged("celebrating", true);
  pet.expressionChanged("waiting_input", true);
  expect(controller.state()).toBe("recording");
  expect(deps.setState).toHaveBeenLastCalledWith("thinking");
  expect(deps.playAction).toHaveBeenCalledTimes(1);
  await controller.finish();
  const transcript = submitted.mock.calls[0]![0].transcript as string;
  const reply = sessionProgressReply(transcript, sources);
  expect(reply).toBe(describeObservedSessions(sources));
  expect(reply).toContain("project-a\" / A：等待你回应");
  expect(reply).toContain("project-b\" / B：已完成");
  expect(deps.setState).toHaveBeenLastCalledWith("waiting_input");
  await controller.complete();
});

it("等待只在实时首次出现且勿扰关闭时招手，快照与重复事件不重播", () => {
  const deps = { showListening: vi.fn(), setState: vi.fn(), playAction: vi.fn() };
  const pet = new VoicePetCoordinator(deps);
  pet.setDnd(false);
  pet.expressionChanged("waiting_input", false);
  pet.expressionChanged("waiting_input", true);
  expect(deps.playAction).not.toHaveBeenCalled();
  pet.expressionChanged("working", true);
  pet.expressionChanged("waiting_input", true);
  pet.expressionChanged("waiting_input", true);
  expect(deps.playAction).toHaveBeenCalledOnce();
  pet.setDnd(true);
  pet.expressionChanged("working", true);
  pet.expressionChanged("waiting_input", true);
  expect(deps.playAction).toHaveBeenCalledOnce();
});
