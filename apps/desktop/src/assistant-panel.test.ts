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

class PanelNode extends EventTarget {
  constructor(
    public textContent = "",
    public value = "",
  ) {
    super();
  }
  tagName = "";
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
    field(assistantText.asrProvider).value = "bailian";
    field(assistantText.ttsProvider).value = "local";
    field(assistantText.voiceWorkspace).value = "workspace-1";
    const speechKey = field(assistantText.voiceApiKey);
    speechKey.value = "fixture-speech-key";
    const form = nodes.find(
      (node) =>
        node.tagName === "form" &&
        node.children.some(
          (child) => child.textContent === assistantText.voiceApiKey,
        ),
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
