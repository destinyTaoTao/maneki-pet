import { afterEach, expect, it, vi } from "vitest";
const { cancel } = vi.hoisted(() => ({
  cancel: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./voice-controller.js", () => ({
  VoiceController: class {
    cancel = cancel;
  },
}));
import { createAssistantPanel } from "./assistant-panel.js";
import { assistantText } from "./assistant-text.js";

class PanelNode extends EventTarget {
  textContent = "";
  children: PanelNode[] = [];
  hidden = false;
  append(...nodes: PanelNode[]) {
    this.children.push(...nodes);
  }
  setAttribute() {}
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
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
