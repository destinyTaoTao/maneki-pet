import { afterEach, expect, it, vi } from "vitest";
const { cancel, call, events } = vi.hoisted(() => ({
  cancel: vi.fn().mockResolvedValue(undefined),
  call: vi.fn(),
  events: { onEvent: undefined as undefined | ((event:any)=>void) },
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
  connectEvents: async (_token:string, onEvent:(event:any)=>void) => {events.onEvent=onEvent;return () => undefined;},
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
    companion: {murmurEnabled:true,murmurSnoozedUntil:1700},
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
    expect(save[2].companion).not.toHaveProperty("murmurSnoozedUntil");
    expect(save[2]).toMatchObject({
      speechApiKey: "fixture-speech-key",
      companion: {murmurEnabled:true},
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

it("回应仅创建可移除引用草稿，不自动发消息",async()=>{
  const nodes:PanelNode[]=[];const doc=new EventTarget();Object.assign(doc,{createElement:(tag:string)=>{const n=new PanelNode();n.tagName=tag;nodes.push(n);return n;}});
  vi.stubGlobal("document",doc);vi.stubGlobal("window",new EventTarget());vi.stubGlobal("Option",PanelNode);
  call.mockImplementation(async()=>({epoch:0,revision:0,messages:[],todos:[],reminders:[],settings:null,activeRequest:null}));
  const panel=createAssistantPanel(new PanelNode() as unknown as HTMLElement,()=>undefined,()=>undefined);
  try {await panel.open();await panel.openWithCompanionReply({runtimeEpoch:"e",displayInstanceId:"d",utteranceId:"u",text:"测试台词"} as never);
    expect(call.mock.calls.some(args=>args[1]==="/chat")).toBe(false);
    expect(nodes.some(n=>n.textContent.includes("测试台词"))).toBe(true);
    expect(nodes.some(n=>n.textContent===assistantText.removeCompanionReply)).toBe(true);
  }finally{panel.dispose();}
});

it("主动发送时附带服务端引用身份，过期保留文字直到用户移除引用",async()=>{
  const nodes:PanelNode[]=[];const doc=new EventTarget();Object.assign(doc,{createElement:(tag:string)=>{const n=new PanelNode();n.tagName=tag;nodes.push(n);return n;}});
  vi.stubGlobal("document",doc);vi.stubGlobal("window",new EventTarget());vi.stubGlobal("Option",PanelNode);
  const {AssistantClientError}=await import("./assistant-client.js");
  call.mockImplementation(async(_token,path)=>{if(path==="/chat")throw new AssistantClientError("companion_reference_expired");return {epoch:0,revision:0,messages:[],todos:[],reminders:[],settings:null,activeRequest:null};});
  const panel=createAssistantPanel(new PanelNode() as unknown as HTMLElement,()=>undefined,()=>undefined);
  try {await panel.open();await panel.openWithCompanionReply({runtimeEpoch:"e",displayInstanceId:"d",utteranceId:"u",text:"测试台词"} as never);
    const composer=nodes.find(n=>n.tagName==="textarea")!;composer.value="我的回复";
    const form=nodes.find(n=>n.tagName==="form"&&n.children.includes(composer))!;form.dispatchEvent(new Event("submit",{cancelable:true}));
    for(let i=0;i<15;i++)await Promise.resolve();
    const sent=call.mock.calls.find(a=>a[1]==="/chat")![2];expect(sent).toMatchObject({text:"我的回复",companionReplyTo:{runtimeEpoch:"e",displayInstanceId:"d",utteranceId:"u"}});expect(composer.value).toBe("我的回复");
    expect(nodes.some(n=>n.textContent===assistantText.errors.companion_reference_expired)).toBe(true);
    nodes.find(n=>n.textContent===assistantText.removeCompanionReply)!.dispatchEvent(new Event("click"));
    expect(composer.value).toBe("我的回复");expect(call.mock.calls.filter(a=>a[1]==="/chat")).toHaveLength(1);
  }finally{panel.dispose();}
});

it("预算损坏时已确认协议1仍允许暂停；旧 Runtime 不发送新命令",async()=>{
 const nodes:PanelNode[]=[];const doc=new EventTarget();Object.assign(doc,{createElement:(tag:string)=>{const n=new PanelNode();n.tagName=tag;nodes.push(n);return n;}});vi.stubGlobal("document",doc);vi.stubGlobal("window",new EventTarget());vi.stubGlobal("Option",PanelNode);
 const base={epoch:0,revision:0,messages:[],todos:[],reminders:[],settings:null,activeRequest:null};let supported=true;
 call.mockImplementation(async(_token,path)=>path==="/companion/status"?(supported?{protocolVersion:1,companion:null,automaticBlock:"storage_unavailable"}:Promise.reject(new Error("not_found"))):path==="/settings"?{version:7}:path==="/snapshot"?base:{});
 const panel=createAssistantPanel(new PanelNode() as unknown as HTMLElement,()=>undefined,()=>undefined);
 try {await panel.open();await panel.snoozeCompanion();expect(call.mock.calls.filter(a=>a[1]==="/mutations").at(-1)?.[2]).toMatchObject({action:"companion.snooze",version:7});
 supported=false;await expect(panel.snoozeCompanion()).rejects.toThrow();expect(call.mock.calls.filter(a=>a[1]==="/mutations")).toHaveLength(1);
 }finally{panel.dispose();}
});

it.each(["input","voice"])("assistant.reminder 在 %s 交互时不抢气泡，提醒仍保留在列表",async()=>{
 const {CompanionBubble}=await import("./companion-bubble.js");const render=vi.fn(),nodes:PanelNode[]=[];const doc=new EventTarget();Object.assign(doc,{createElement:(tag:string)=>{const n=new PanelNode();n.tagName=tag;nodes.push(n);return n;}});vi.stubGlobal("document",doc);vi.stubGlobal("window",new EventTarget());vi.stubGlobal("Option",PanelNode);
 const reminder={id:"fixture",todoId:null,message:"到点了",remindAt:100,timeZone:"UTC",status:"accepted",attempts:1,code:null,version:1,seenAt:null};
 call.mockImplementation(async(_token,path)=>path==="/snapshot"?{epoch:0,revision:0,messages:[],todos:[],reminders:[reminder],settings:null,activeRequest:null}:{});
 const bubble=new CompanionBubble({render,playAction:()=>undefined,restoreLatest:()=>undefined});bubble.setUserBusy(true);
 const panel=createAssistantPanel(new PanelNode() as unknown as HTMLElement,()=>undefined,text=>bubble.showImportant("notification",text));
 try{await panel.open();events.onEvent!({kind:"assistant.reminder",eventId:"1",occurredAt:"",payload:{body:"到点了"}});expect(render).not.toHaveBeenCalled();expect(nodes.some(n=>n.textContent==="到点了")).toBe(true);expect(call.mock.calls.some(a=>a[1]==="/mutations")).toBe(false);bubble.setUserBusy(false);expect(render).not.toHaveBeenCalled();}finally{panel.dispose();bubble.dispose();}
});

it("历史引用不可读时显示明确提示并保留用户正文",async()=>{
 const nodes:PanelNode[]=[];const doc=new EventTarget();Object.assign(doc,{createElement:(tag:string)=>{const n=new PanelNode();n.tagName=tag;nodes.push(n);return n;}});
 vi.stubGlobal("document",doc);vi.stubGlobal("window",new EventTarget());vi.stubGlobal("Option",PanelNode);
 call.mockImplementation(async()=>({epoch:0,revision:0,messages:[{seq:1,role:"user",text:"我的正文",createdAt:"2026-01-01",companionReferenceUnavailable:true}],todos:[],reminders:[],settings:null,activeRequest:null}));
 const panel=createAssistantPanel(new PanelNode() as unknown as HTMLElement,()=>undefined,()=>undefined);
 try{await panel.open();expect(nodes.some(n=>n.textContent==="引用内容不可用")).toBe(true);expect(nodes.some(n=>n.textContent==="我的正文")).toBe(true);}finally{panel.dispose();}
});

it("同一条历史引用修复后重新渲染原文",async()=>{
 const nodes:PanelNode[]=[];const doc=new EventTarget();Object.assign(doc,{createElement:(tag:string)=>{const n=new PanelNode();n.tagName=tag;nodes.push(n);return n;}});
 vi.stubGlobal("document",doc);vi.stubGlobal("window",new EventTarget());vi.stubGlobal("Option",PanelNode);
 let recovered=false;
 call.mockImplementation(async()=>({epoch:0,revision:0,messages:[{seq:1,role:"user",text:"我的正文",createdAt:"2026-01-01",...(recovered?{companionReference:{utteranceId:"u",text:"已恢复",mode:"manual",createdAt:100}}:{companionReferenceUnavailable:true})}],todos:[],reminders:[],settings:null,activeRequest:null}));
 const panel=createAssistantPanel(new PanelNode() as unknown as HTMLElement,()=>undefined,()=>undefined);
 try{await panel.open();expect(nodes.some(n=>n.textContent==="引用内容不可用")).toBe(true);recovered=true;await panel.reuse();expect(nodes.some(n=>n.textContent===assistantText.companionQuote+"已恢复")).toBe(true);}finally{panel.dispose();}
});

it("显式重新打开时刷新已加载的旧页并更新修复后的引用",async()=>{
 const nodes:PanelNode[]=[];const doc=new EventTarget();Object.assign(doc,{createElement:(tag:string)=>{const n=new PanelNode();n.tagName=tag;nodes.push(n);return n;}});
 vi.stubGlobal("document",doc);vi.stubGlobal("window",new EventTarget());vi.stubGlobal("Option",PanelNode);
 let recovered=false;const recent=Array.from({length:50},(_,i)=>({seq:i+51,role:"user",text:`新消息${i}`,createdAt:"2026-01-01"}));
 call.mockImplementation(async(_token,path)=>path.startsWith("/history?")?{epoch:0,messages:[{seq:1,role:"user",text:"旧正文",createdAt:"2026-01-01",...(recovered?{companionReference:{utteranceId:"u",text:"旧引用已恢复",mode:"manual",createdAt:100}}:{companionReferenceUnavailable:true})}]}:{epoch:0,revision:0,messages:recent,todos:[],reminders:[],settings:null,activeRequest:null});
 const panel=createAssistantPanel(new PanelNode() as unknown as HTMLElement,()=>undefined,()=>undefined);
 try{await panel.open();nodes.find(n=>n.textContent===assistantText.history)!.dispatchEvent(new Event("click"));await vi.waitFor(()=>expect(nodes.some(n=>n.textContent==="引用内容不可用")).toBe(true));recovered=true;await panel.reuse();expect(nodes.some(n=>n.textContent===assistantText.companionQuote+"旧引用已恢复")).toBe(true);}finally{panel.dispose();}
});

it("最新消息窗口前移后刷新仍保留已加载的旧页边界",async()=>{
 const nodes:PanelNode[]=[];const doc=new EventTarget();Object.assign(doc,{createElement:(tag:string)=>{const n=new PanelNode();n.tagName=tag;nodes.push(n);return n;}});vi.stubGlobal("document",doc);vi.stubGlobal("window",new EventTarget());vi.stubGlobal("Option",PanelNode);
 let moved=false;const make=(first:number)=>Array.from({length:50},(_,i)=>({seq:first+i,role:"user",text:`消息${first+i}`,createdAt:"2026-01-01"}));
 call.mockImplementation(async(_token,path)=>path.startsWith("/history?")?{epoch:0,messages:make(Math.max(1,Number(path.split("=")[1])-50))}:{epoch:0,revision:0,messages:make(moved?251:51),todos:[],reminders:[],settings:null,activeRequest:null});
 const panel=createAssistantPanel(new PanelNode() as unknown as HTMLElement,()=>undefined,()=>undefined);
 try{await panel.open();nodes.find(n=>n.textContent===assistantText.history)!.dispatchEvent(new Event("click"));await vi.waitFor(()=>expect(nodes.some(n=>n.textContent==="消息1")).toBe(true));
 const before=nodes.length;moved=true;await panel.reuse();expect(nodes.slice(before).some(n=>n.textContent==="消息51")).toBe(true);expect(nodes.slice(before).some(n=>n.textContent==="消息101")).toBe(true);expect(nodes.slice(before).some(n=>n.textContent==="消息200")).toBe(true);expect(nodes.slice(before).some(n=>n.textContent==="消息250")).toBe(true);expect(nodes.some(n=>n.textContent===assistantText.historyTrimmed)).toBe(true);
 }finally{panel.dispose();}
});

it("旧页和原快照超出200条时保留最近200条并明确提示",async()=>{
 const nodes:PanelNode[]=[];const doc=new EventTarget();Object.assign(doc,{createElement:(tag:string)=>{const n=new PanelNode();n.tagName=tag;nodes.push(n);return n;}});vi.stubGlobal("document",doc);vi.stubGlobal("window",new EventTarget());vi.stubGlobal("Option",PanelNode);
 let moved=false;const make=(first:number,count=50)=>Array.from({length:count},(_,i)=>({seq:first+i,role:"user",text:`消息${first+i}`,createdAt:"2026-01-01"}));
 call.mockImplementation(async(_token,path)=>{if(path.startsWith("/history?")){const before=Number(path.split("=")[1]);return {epoch:0,messages:make(Math.max(1,before-50),Math.min(50,before-1))};}return {epoch:0,revision:0,messages:make(moved?401:201),todos:[],reminders:[],settings:null,activeRequest:null};});
 const panel=createAssistantPanel(new PanelNode() as unknown as HTMLElement,()=>undefined,()=>undefined);
 try{await panel.open();for(const before of [201,151,101,51]){nodes.find(n=>n.textContent===assistantText.history)!.dispatchEvent(new Event("click"));await vi.waitFor(()=>expect(call.mock.calls.some(a=>a[1]===`/history?before=${before}`)).toBe(true));await new Promise(r=>setTimeout(r,5));}const offset=nodes.length;moved=true;await panel.reuse();expect(nodes.slice(offset).some(n=>n.textContent==="消息201")).toBe(true);expect(nodes.slice(offset).some(n=>n.textContent==="消息400")).toBe(true);expect(nodes.some(n=>n.textContent===assistantText.historyTrimmed)).toBe(true);
 }finally{panel.dispose();}
});

it("普通事件刷新导致新快照前移一条时不丢失衔接消息",async()=>{
 const nodes:PanelNode[]=[];const doc=new EventTarget();Object.assign(doc,{createElement:(tag:string)=>{const n=new PanelNode();n.tagName=tag;nodes.push(n);return n;}});vi.stubGlobal("document",doc);vi.stubGlobal("window",new EventTarget());vi.stubGlobal("Option",PanelNode);
 let moved=false;const make=(first:number,count=50)=>Array.from({length:count},(_,i)=>({seq:first+i,role:"user",text:`消息${first+i}`,createdAt:"2026-01-01"}));
 call.mockImplementation(async(_token,path)=>{if(path.startsWith("/history?")){const before=Number(path.split("=")[1]);return {epoch:0,messages:make(Math.max(1,before-50),Math.min(50,before-1))};}return {epoch:0,revision:moved?1:0,messages:make(moved?52:51),todos:[],reminders:[],settings:null,activeRequest:null};});
 const panel=createAssistantPanel(new PanelNode() as unknown as HTMLElement,()=>undefined,()=>undefined);
 try{await panel.open();nodes.find(n=>n.textContent===assistantText.history)!.dispatchEvent(new Event("click"));await vi.waitFor(()=>expect(nodes.some(n=>n.textContent==="消息1")).toBe(true));const offset=nodes.length;moved=true;events.onEvent!({kind:"assistant.changed",eventId:"1",occurredAt:"",payload:{}});await vi.waitFor(()=>expect(nodes.slice(offset).some(n=>n.textContent==="消息51")).toBe(true));expect(nodes.slice(offset).some(n=>n.textContent==="消息101")).toBe(true);
 }finally{panel.dispose();}
});

it("已到底后快照推进可重新翻回更早，满200条时保留新页并可回到较新历史",async()=>{
 const nodes:PanelNode[]=[];const doc=new EventTarget();Object.assign(doc,{createElement:(tag:string)=>{const n=new PanelNode();n.tagName=tag;nodes.push(n);return n;}});vi.stubGlobal("document",doc);vi.stubGlobal("window",new EventTarget());vi.stubGlobal("Option",PanelNode);
 let moved=false;const make=(first:number,count=50)=>Array.from({length:count},(_,i)=>({seq:first+i,role:"user",text:`消息${first+i}`,createdAt:"2026-01-01"}));
 call.mockImplementation(async(_token,path)=>{if(path.startsWith("/history?")){const before=Number(path.split("=")[1]);return {epoch:0,messages:make(Math.max(1,before-50),Math.min(50,Math.max(0,before-1)))};}return {epoch:0,revision:moved?1:0,messages:make(moved?401:51),todos:[],reminders:[],settings:null,activeRequest:null};});
 const panel=createAssistantPanel(new PanelNode() as unknown as HTMLElement,()=>undefined,()=>undefined);
 try{await panel.open();const earlier=nodes.find(n=>n.textContent===assistantText.history)! as PanelNode & {disabled:boolean};
 earlier.dispatchEvent(new Event("click"));await vi.waitFor(()=>expect(nodes.some(n=>n.textContent==="消息1")).toBe(true));
 earlier.dispatchEvent(new Event("click"));await vi.waitFor(()=>expect(earlier.disabled).toBe(true));
 moved=true;events.onEvent!({kind:"assistant.changed",eventId:"1",occurredAt:"",payload:{}});await vi.waitFor(()=>expect(earlier.disabled).toBe(false));
 const offset=nodes.length;earlier.dispatchEvent(new Event("click"));await vi.waitFor(()=>expect(nodes.slice(offset).some(n=>n.textContent==="消息151")).toBe(true));
 expect(nodes.some(n=>n.textContent==="当前显示较早历史，部分较新的旧消息未显示。" )).toBe(true);
 const newer=nodes.find(n=>n.textContent==="回到较新历史")!;expect(newer.hidden).toBe(false);const after=nodes.length;newer.dispatchEvent(new Event("click"));await vi.waitFor(()=>expect(nodes.slice(after).some(n=>n.textContent==="消息400")).toBe(true));expect(newer.hidden).toBe(true);
 }finally{panel.dispose();}
});

it("设置有未保存输入时暂停成功仍显示截止时间并保留输入",async()=>{
 const nodes:PanelNode[]=[];const doc=new EventTarget();Object.assign(doc,{createElement:(tag:string)=>{const n=new PanelNode();n.tagName=tag;nodes.push(n);return n;}});vi.stubGlobal("document",doc);vi.stubGlobal("window",new EventTarget());vi.stubGlobal("Option",PanelNode);
 const settings={schemaVersion:1,version:1,timeZone:"Asia/Shanghai",persona:"小招",cloudEnabled:false,companion:{murmurEnabled:true,murmurSnoozedUntil:null as number|null},voice:{microphoneEnabled:false,asr:{enabled:false,language:"zh"},tts:{enabled:false,voiceId:""},apiKeyConfigured:false},chat:{enabled:false,locality:"local",baseUrl:"",model:"",maxInputTokens:4096,maxOutputTokens:1024,apiKeyConfigured:false}};
 call.mockImplementation(async(_token,path)=>{if(path==="/mutations"){settings.companion.murmurSnoozedUntil=1794667192873;settings.version++;return {murmurSnoozedUntil:settings.companion.murmurSnoozedUntil,settingsVersion:settings.version};}return {epoch:0,revision:0,messages:[],todos:[],reminders:[],settings,activeRequest:null};});
 const panel=createAssistantPanel(new PanelNode() as unknown as HTMLElement,()=>undefined,()=>undefined);
 try{await panel.open();panel.show("settings");const form=nodes.find(n=>n.tagName==="form"&&n.className==="settings-form")!;const persona=nodes.find(n=>n.textContent===assistantText.persona)!.children[0]!;persona.value="尚未保存";form.dispatchEvent(new Event("input"));nodes.find(n=>n.textContent===assistantText.companionSnooze)!.dispatchEvent(new Event("click"));for(let i=0;i<40;i++)await Promise.resolve();expect(nodes.some(n=>n.className==="assistant-notice"&&n.textContent.includes(assistantText.companionSnoozedUntil))).toBe(true);expect(nodes.some(n=>n.className==="settings-note"&&n.textContent.includes(assistantText.companionSnoozedUntil))).toBe(true);expect(persona.value).toBe("尚未保存");}finally{panel.dispose();}
});
