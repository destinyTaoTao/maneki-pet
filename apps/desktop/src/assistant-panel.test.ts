import { afterEach, expect, it, vi } from "vitest";
const { cancel, call } = vi.hoisted(() => ({
  cancel: vi.fn().mockResolvedValue(undefined),
  call: vi.fn(),
}));
vi.mock("./voice-controller.js", () => ({
  VoiceController: class {
    cancel = cancel;
    state() {
      return "idle";
    }
    ownsRequest() {
      return false;
    }
  },
}));
vi.mock("./assistant-client.js", async (original) => ({
  ...(await original<typeof import("./assistant-client.js")>()),
  assistantToken: async () => "fixture-token",
  assistantCall: call,
}));
vi.mock("./runtime-client.js", () => ({
  connectEvents: async () => () => undefined,
}));
import { createAssistantPanel } from "./assistant-panel.js";
import { assistantText } from "./assistant-text.js";
import type { SessionObservationSource } from "@maneki-pet/core";

class PanelNode extends EventTarget {
  constructor(
    public textContent = "",
    public value = "",
  ) {
    super();
  }
  tagName = "";
  className = "";
  dataset: Record<string, string> = {};
  children: PanelNode[] = [];
  hidden = false;
  append(...nodes: PanelNode[]) {
    this.children.push(...nodes);
  }
  setAttribute() {}
  focus() {}
  replaceChildren(...nodes: PanelNode[]) {
    this.children = nodes;
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("会话面板分别显示等待、完成和失联后的最后事实，来源标签按纯文本呈现", async () => {
  const nodes: PanelNode[] = [];
  const doc = new EventTarget();
  Object.assign(doc, { createElement: () => { const node = new PanelNode(); nodes.push(node); return node; } });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("Option", PanelNode);
  const source: SessionObservationSource = {
    clientId: "test-client", sourceId: "test-source", profileId: "web", connected: true, truncated: false, lastSeenAt: Date.now(),
    sessions: [
      { sessionId: "session-A", projectName: "<project-A>", phase: "waiting_input", sequence: 1, observedAt: Date.now() },
      { sessionId: "session-B", projectName: "project-B", phase: "completed", sequence: 2, observedAt: Date.now() },
    ],
  };
  call.mockImplementation(async () => ({ epoch: 0, revision: 0, messages: [], todos: [], reminders: [], settings: null, activeRequest: null, observations: [source] }));
  const panel = createAssistantPanel(new PanelNode() as unknown as HTMLElement, () => undefined, () => undefined);
  try {
    await panel.open();
    expect(nodes.some((node) => node.textContent === "session-A")).toBe(true);
    expect(nodes.some((node) => node.textContent === "<project-A>")).toBe(true);
    expect(nodes.some((node) => node.textContent === "等待你回应")).toBe(true);
    expect(nodes.some((node) => node.textContent === "已完成")).toBe(true);
    source.connected = false;
    await panel.reuse();
    expect(nodes.some((node) => node.textContent === "来源已失联，当前进度不可用")).toBe(true);
    expect(nodes.some((node) => node.textContent === "上次为等待你回应，当前状态未知")).toBe(true);
    expect(call.mock.calls.every((args) => args[1] === "/snapshot")).toBe(true);
  } finally { panel.dispose(); }
});
it("打开提醒不自动确认，已查看和系统受理分开，确认/重试仅提交当前项版本", async () => {
  const nodes: PanelNode[] = [],
    doc = new EventTarget();
  Object.assign(doc, {
    createElement: () => {
      const node = new PanelNode();
      nodes.push(node);
      return node;
    },
  });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("Option", PanelNode);
  const reminder = {
    id: "failed",
    todoId: null,
    message: "test",
    remindAt: Date.now(),
    timeZone: "Asia/Shanghai",
    status: "failed",
    attempts: 1,
    code: null,
    version: 3,
    seenAt: null,
  };
  call.mockImplementation(async (_token, path) =>
    path === "/snapshot"
      ? {
          epoch: 0,
          revision: 0,
          messages: [],
          todos: [],
          reminders: [
            reminder,
            {
              ...reminder,
              id: "accepted",
              status: "accepted",
              seenAt: Date.now(),
            },
            { ...reminder, id: "pending", status: "pending" },
          ],
          activeRequest: null,
          settings: null,
        }
      : {},
  );
  const panel = createAssistantPanel(
    new PanelNode() as unknown as HTMLElement,
    () => undefined,
    () => undefined,
  );
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  try {
    await panel.open();
    expect(
      call.mock.calls.filter((args) => args[1] === "/mutations"),
    ).toHaveLength(0);
    expect(
      nodes.some(
        (n) => n.textContent === assistantText.notificationStatus.accepted,
      ),
    ).toBe(true);
    expect(
      nodes.some((n) => n.textContent.startsWith(assistantText.reminderSeen)),
    ).toBe(true);
    const ack = nodes.filter(
        (n) => n.textContent === assistantText.reminderAck,
      ),
      retry = nodes.filter(
        (n) => n.textContent === assistantText.reminderRetry,
      );
    expect(ack).toHaveLength(1);
    expect(retry).toHaveLength(1);
    ack[0]!.dispatchEvent(new Event("click"));
    await flush();
    retry[0]!.dispatchEvent(new Event("click"));
    await flush();
    const mutations = call.mock.calls
      .filter((args) => args[1] === "/mutations")
      .map((args) => args[2]);
    expect(mutations).toEqual([
      expect.objectContaining({
        action: "reminder.ack",
        id: "failed",
        version: 3,
      }),
      expect.objectContaining({
        action: "reminder.retry",
        id: "failed",
        version: 3,
      }),
    ]);
    expect(mutations.every((body) => Object.keys(body).length === 4)).toBe(
      true,
    );
  } finally {
    panel.dispose();
  }
});
it("设置分别保存本地/百炼服务和独立密钥，组件检测只查询配置", async () => {
  const nodes: PanelNode[] = [],
    doc = new EventTarget();
  Object.assign(doc, {
    createElement: (tag: string) => {
      const node = new PanelNode();
      node.tagName = tag;
      nodes.push(node);
      return node;
    },
  });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("Option", PanelNode);
  const settings = {
    schemaVersion: 1,
    version: 0,
    timeZone: "Asia/Shanghai",
    persona: "小招",
    cloudEnabled: false,
    voice: {
      microphoneEnabled: false,
      asr: { enabled: false, language: "zh" },
      tts: { enabled: false, voiceId: "" },
      apiKeyConfigured: false,
    },
    chat: {
      enabled: false,
      locality: "local",
      baseUrl: "",
      model: "",
      maxInputTokens: 4096,
      maxOutputTokens: 1024,
      apiKeyConfigured: false,
    },
  };
  call.mockImplementation(async (_token, path) =>
    path === "/snapshot"
      ? {
          epoch: 0,
          revision: 0,
          messages: [],
          todos: [],
          reminders: [],
          activeRequest: null,
          settings,
        }
      : path === "/voice/status"
        ? {
            asrAvailable: true,
            ttsAvailable: true,
            voices: [],
            configurationOnly: true,
          }
        : {},
  );
  const panel = createAssistantPanel(
    new PanelNode() as unknown as HTMLElement,
    () => undefined,
    () => undefined,
  );
  const flush = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  const field = (label: string) =>
    nodes.find((node) => node.textContent === label)!.children[0]!;
  try {
    await panel.open();
    nodes
      .find((node) => node.textContent === assistantText.settings)!
      .dispatchEvent(new Event("click"));
    expect(nodes.some((node) => node.textContent === assistantText.generalSettings)).toBe(true);
    expect(nodes.some((node) => node.textContent === assistantText.chatSettings)).toBe(true);
    const onlineSection = nodes.find((node) =>
      node.className === "settings-section" &&
      node.children[0]?.children.some((child) => child.textContent === assistantText.voiceBailian),
    )!;
    expect(onlineSection.hidden).toBe(true);
    nodes
      .find((node) => node.textContent === assistantText.voiceCheck)!
      .dispatchEvent(new Event("click"));
    await flush();
    expect(call.mock.calls.some((args) => args[1] === "/voice/status")).toBe(
      true,
    );
    expect(
      nodes.some((node) =>
        node.textContent.includes(assistantText.voiceNoProbe),
      ),
    ).toBe(true);
    const asrField = field(assistantText.asrProvider);
    asrField.value = "bailian";
    asrField.dispatchEvent(new Event("change"));
    expect(onlineSection.hidden).toBe(false);
    field(assistantText.ttsProvider).value = "local";
    field(assistantText.voiceWorkspace).value = "workspace-1";
    const speechKey = field(assistantText.voiceApiKey);
    speechKey.value = "fixture-speech-key";
    const form = nodes.find(
      (node) => node.tagName === "form" && node.className === "settings-form",
    )!;
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    const save = call.mock.calls.find((args) => args[1] === "/settings")!;
    expect(save[2]).toMatchObject({
      speechApiKey: "fixture-speech-key",
      voice: {
        asr: { provider: "bailian" },
        tts: { provider: "local" },
        bailian: {
          workspaceId: "workspace-1",
          asrModel: "qwen3-asr-flash",
          ttsModel: "qwen3-tts-flash",
          voiceId: "Cherry",
        },
      },
    });
    expect(save[2]).not.toHaveProperty("apiKey");
    expect(speechKey.value).toBe("");
  } finally {
    panel.dispose();
  }
});
it("面板取消按钮停止当前语音，读取历史不会误取消当前任务", async () => {
  const nodes: PanelNode[] = [];
  const doc = new EventTarget();
  Object.assign(doc, {
    createElement: () => {
      const node = new PanelNode();
      nodes.push(node);
      return node;
    },
  });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("Option", PanelNode);
  const panel = createAssistantPanel(
    new PanelNode() as unknown as HTMLElement,
    () => undefined,
    () => undefined,
  );
  try {
    nodes
      .find((node) => node.textContent === assistantText.history)!
      .dispatchEvent(new Event("click"));
    await Promise.resolve();
    expect(cancel).not.toHaveBeenCalled();
    nodes
      .find((node) => node.textContent === assistantText.cancel)!
      .dispatchEvent(new Event("click"));
    expect(cancel).toHaveBeenCalledWith(true);
  } finally {
    panel.dispose();
  }
});

it("形象控件迁入侧栏并随视图显隐，不发起额外个人数据授权", async () => {
  const nodes: PanelNode[] = [];
  const doc = new EventTarget();
  Object.assign(doc, {
    createElement: () => {
      const node = new PanelNode();
      nodes.push(node);
      return node;
    },
  });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("Option", PanelNode);
  call.mockResolvedValue({ epoch: 0, revision: 0, messages: [], todos: [], reminders: [], activeRequest: null, settings: null });
  const appearance = new PanelNode();
  appearance.className = "settings-panel";
  const existingControl = new PanelNode("点播动作");
  appearance.append(existingControl);
  const host = new PanelNode();
  const panel = createAssistantPanel(
    host as unknown as HTMLElement,
    () => undefined,
    () => undefined,
    () => undefined,
    appearance as unknown as HTMLElement,
  );
  try {
    await panel.open();
    const appearanceView = nodes.find((node) => node.className === "assistant-appearance")!;
    expect(appearanceView.children).toContain(appearance);
    expect(appearance.hidden).toBe(true);
    panel.show("appearance");
    expect(appearance.hidden).toBe(false);
    expect(existingControl.textContent).toBe("点播动作");
    panel.show("settings");
    expect(appearance.hidden).toBe(true);
    panel.setPetAppearance("xiaozhao-white");
    expect(host.dataset.petVariant).toBe("white");
    const avatar = nodes.find((node) => node.className === "assistant-rail-avatar") as PanelNode & { src: string };
    expect(avatar.src).toBe("/variants/white.png");
    panel.setPetAppearance("mint-test");
    expect(host.dataset.petVariant).toBe("custom");
    expect(nodes.some((node) => node.textContent === assistantText.railMark)).toBe(true);
    expect(call.mock.calls.every((args) => args[1] === "/snapshot")).toBe(true);
  } finally {
    panel.dispose();
  }
});
