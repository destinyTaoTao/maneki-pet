import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  assistantCall,
  assistantToken,
  AssistantClientError,
  type AssistantMessage,
  type AssistantSettingsView,
  type AssistantSnapshot,
} from "./assistant-client.js";
import { assistantText as t } from "./assistant-text.js";
import * as runtime from "./runtime-client.js";
import "./assistant.css";
import { defaultVoiceSettings, defaultBailianSettings, describeObservedSessions, sessionPhaseText, type CompanionUtterance, type CompanionReplyTo } from "@maneki-pet/core";
import { VoiceController, type VoicePhase } from "./voice-controller.js";
import { BrowserVoiceCapture, BrowserVoicePlayer } from "./voice-media.js";

type Tab = "chat" | "sessions" | "todos" | "reminders" | "appearance" | "settings";
type RequestState = {
  requestId: string;
  status: string;
  code: string | null;
  message?: AssistantMessage | null;
};
const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};
function button(text: string, action: () => void): HTMLButtonElement {
  const node = el("button", text);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}
function input(
  label: string,
  type = "text",
  value = "",
): { label: HTMLLabelElement; input: HTMLInputElement } {
  const node = el("input");
  node.type = type;
  node.value = value;
  const wrapper = el("label", label);
  wrapper.append(node);
  return { label: wrapper, input: node };
}
function check(label: string, checked: boolean) {
  const field = input(label, "checkbox");
  field.input.checked = checked;
  return field;
}

export function petVariantForPack(packId: string): "orange" | "white" | "black" | "custom" {
  if (packId === "xiaozhao-default") return "orange";
  if (packId === "xiaozhao-white") return "white";
  if (packId === "xiaozhao-black") return "black";
  return "custom";
}

/** 单 WebView 面板：所有返回内容通过 textContent 渲染，提交只走明确操作。 */
export function createAssistantPanel(
  host: HTMLElement,
  onClose: () => void,
  onReminder: (text: string) => void,
  onVoicePhase: (phase: VoicePhase) => void = () => undefined,
  appearance?: HTMLElement,
  companion?: { onEvent:(event:runtime.RuntimeEvent)=>void; onReady:(ready:runtime.WsReady)=>void; onDisconnected:()=>void },
) {
  let token: string | undefined,
    snapshot: AssistantSnapshot | undefined,
    tab: Tab = "chat",
    disposed = false;
  let eventGeneration = 0;
  let stopEvents: (() => void) | undefined,
    connecting: Promise<void> | undefined,
    ownRequest: string | undefined;
  let pendingSubmit: { requestId: string; text: string; companionReplyTo?: CompanionReplyTo } | undefined,
    refreshing: Promise<void> | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined,
    epoch: number | undefined;
  let older: AssistantMessage[] = [],
    renderedChatKey = "",
    settingsDirty = false,
    settingsVersion: number | undefined;
  let companionAvailability:string|null=null;
  let heldPointer: number | undefined, heldKey: string | undefined;
  const header = el("header"),
    heading = el("strong", t.title),
    close = button(t.close, onClose);
  header.append(
    heading,
    button(t.reload, () => void perform(() => connect(true, true))),
    close,
  );
  const tabs = el("nav"),
    content = el("main"),
    notice = el("p");
  notice.className = "assistant-notice";
  notice.setAttribute("role", "status");
  const railMark = el("div", t.railMark);
  railMark.className = "assistant-rail-mark";
  railMark.setAttribute("aria-hidden", "true");
  tabs.append(railMark);
  const confirmation = el("section");
  confirmation.hidden = true;
  confirmation.className = "assistant-confirm";
  const views = new Map<Tab, HTMLElement>(),
    tabButtons = new Map<Tab, HTMLButtonElement>();
  const selectTab = (name: Tab): void => {
    tab = name;
    heading.textContent = name === "settings" ? t.settingsTitle : name === "appearance" ? t.appearanceTitle : t.title;
    for (const [key, value] of views) value.hidden = key !== name;
    for (const [key, value] of tabButtons)
      value.setAttribute("aria-pressed", String(key === name));
    if (appearance) appearance.hidden = name !== "appearance";
    if (name === "settings" && !settingsDirty) renderSettings();
  };
  for (const name of ["chat", "sessions", "todos", "reminders", "appearance", "settings"] as const) {
    const node = el("section");
    node.className = `assistant-${name}`;
    node.hidden = name !== tab;
    views.set(name, node);
    content.append(node);
    const btn = button(t[name], () => selectTab(name));
    btn.className = `assistant-tab-${name}`;
    btn.setAttribute("aria-pressed", String(name === tab));
    tabs.append(btn);
    tabButtons.set(name, btn);
  }
  if (appearance) {
    const intro = el("p", t.appearanceHint);
    intro.className = "settings-intro";
    views.get("appearance")!.append(intro, appearance);
    appearance.hidden = true;
  }
  const drawer = el("div");
  drawer.className = "assistant-drawer";
  drawer.append(header, tabs, notice, confirmation, content);
  host.append(drawer);
  const setPetAppearance = (packId: string): void => {
    const variant = petVariantForPack(packId);
    host.dataset.petVariant = variant;
    if (variant === "custom") {
      railMark.textContent = t.railMark;
      return;
    }
    const avatar = el("img");
    avatar.className = "assistant-rail-avatar";
    avatar.alt = "";
    avatar.draggable = false;
    avatar.src = `/variants/${variant}.png`;
    avatar.onerror = () => { railMark.textContent = t.railMark; };
    railMark.replaceChildren(avatar);
  };
  const showError = (error: unknown) => {
    const code =
      error instanceof AssistantClientError
        ? error.code
        : "runtime_unavailable";
    notice.textContent = t.errors[code] ?? `${t.unknown}（${code}）`;
  };
  const perform = async (action: () => Promise<void>) => {
    try {
      notice.textContent = "";
      await action();
    } catch (error) {
      showError(error);
    }
  };
  const mutate = async (body: Record<string, unknown>) => {
    await assistantCall(token!, "/mutations", {
      requestId: crypto.randomUUID(),
      ...body,
    });
    await refresh();
  };
  const voiceHint = el("p"),
    voiceTranscript = el("p"),
    hold = button(t.voiceHold, () => undefined),
    readReply = button(t.voiceRead, () => {
      const message = [...(snapshot?.messages ?? [])]
        .reverse()
        .find((m) => m.role === "assistant");
      if (message) void voice.speak(message.seq);
    });
  voiceHint.setAttribute("role", "status");
  voiceTranscript.className = "voice-transcript";
  const voice = new VoiceController({
    transport: {
      call: (path, body, signal) =>
        assistantCall(token!, path, body, body === undefined ? "GET" : "POST", {
          ...(signal ? { signal } : {}),
          timeoutMs:
            path === "/voice/transcribe"
              ? 50000
              : path === "/voice/synthesize"
                ? 20000
                : 3000,
        }),
    },
    capture: () => new BrowserVoiceCapture(),
    player: new BrowserVoicePlayer(),
    changed: (phase) => {
      onVoicePhase(phase);
      voiceHint.textContent = t.voicePhases[phase] ?? "";
      hold.setAttribute(
        "aria-pressed",
        String(phase === "starting" || phase === "recording"),
      );
      if (typeof cancel !== "undefined")
        cancel.disabled = phase === "idle" && !ownRequest;
      if (["transcribing", "waiting", "speaking"].includes(phase)) {
        heldPointer = undefined;
        heldKey = undefined;
      }
      updateVoice();
    },
    error: (code) => {
      notice.textContent = t.errors[code] ?? `${t.unknown}（${code}）`;
    },
    submitted: (result) => {
      voiceTranscript.textContent = `${t.voiceRecognized}：${result.transcript ?? ""}`;
      ownRequest = result.requestId;
      void perform(refresh);
    },
    recognized: (text) => {
      voiceTranscript.textContent = `${t.voiceRecognized}：${text}`;
    },
  });
  hold.disabled = true;
  readReply.disabled = true;
  voiceHint.textContent = t.voicePhases.idle ?? "";
  hold.addEventListener("pointerdown", (event) => {
    if (
      event.button !== 0 ||
      hold.disabled ||
      heldPointer !== undefined ||
      heldKey !== undefined
    )
      return;
    heldPointer = event.pointerId;
    event.preventDefault();
    hold.setPointerCapture(event.pointerId);
    void voice.start();
  });
  hold.addEventListener("pointerup", (event) => {
    if (heldPointer !== event.pointerId) return;
    heldPointer = undefined;
    event.preventDefault();
    void voice.finish();
  });
  hold.addEventListener("pointercancel", () => {
    heldPointer = undefined;
    void voice.cancel(false);
  });
  hold.addEventListener("keydown", (event) => {
    if (
      (event.code === "Space" || event.code === "Enter") &&
      !event.repeat &&
      !hold.disabled &&
      heldPointer === undefined &&
      heldKey === undefined
    ) {
      heldKey = event.code;
      event.preventDefault();
      void voice.start();
    }
  });
  hold.addEventListener("keyup", (event) => {
    if (event.code === heldKey) {
      heldKey = undefined;
      event.preventDefault();
      void voice.finish();
    }
  });
  hold.addEventListener("blur", () => {
    heldKey = undefined;
    if (["starting", "recording"].includes(voice.state()))
      void voice.cancel(false);
  });
  const onWindowBlur = () => {
    heldPointer = undefined;
    heldKey = undefined;
    if (["starting", "recording", "transcribing"].includes(voice.state()))
      void voice.cancel(false);
  };
  const onVisibility = () => {
    if (document.hidden) void voice.cancel(false);
  };
  window.addEventListener("blur", onWindowBlur);
  document.addEventListener("visibilitychange", onVisibility);
  function updateVoice() {
    const settings = snapshot?.settings?.voice ?? defaultVoiceSettings();
    hold.disabled =
      !token ||
      !settings.microphoneEnabled ||
      !settings.asr.enabled ||
      ["transcribing", "waiting"].includes(voice.state());
    readReply.disabled =
      !settings.tts.enabled ||
      ["starting", "recording", "transcribing"].includes(voice.state()) ||
      !snapshot?.messages.some((m) => m.role === "assistant");
    if (voice.state() === "idle")
      voiceHint.textContent = hold.disabled
        ? t.voiceSetupHint
        : (t.voicePhases.idle ?? "");
  }
  let replyDraft:CompanionUtterance|undefined;
  const quote=el("div");quote.hidden=true;quote.className="assistant-companion-quote";
  const clearReply=()=>{replyDraft=undefined;pendingSubmit=undefined;quote.replaceChildren();quote.hidden=true;};
  const clear = async (scope: "history" | "todos") =>
    perform(async () => {
      const preview = await assistantCall<{
        confirmationId: string;
        count: number;
      }>(token!, "/clear-preview", { scope });
      confirmation.replaceChildren(
        el(
          "p",
          `${scope === "history" ? t.clearChat : t.clearTodos}：${preview.count} ${t.itemUnit}。${scope === "todos" ? t.clearTodosHint : t.clearHistoryHint}`,
        ),
        button(
          t.confirm,
          () =>
            void perform(async () => {
              await voice.cancel(false);
              await assistantCall(token!, "/clear", {
                confirmationId: preview.confirmationId,
              });
              confirmation.hidden = true;
              older = [];
              historyStatus.textContent = "";
              newerHistory.hidden = true;
              await refresh();
            }),
        ),
        button(t.back, () => {
          confirmation.hidden = true;
        }),
      );
      confirmation.hidden = false;
    });
  const chat = views.get("chat")!,
    chatTools = el("div"),
    messages = el("div"),
    form = el("form"),
    composer = el("textarea"),
    send = el("button", t.send),
    requestStatus = el("p"),
    historyStatus = el("p");
  historyStatus.setAttribute("role", "status");
  const newerHistory = button(t.historyNewer, () => void perform(() => connect(true, true)));
  newerHistory.hidden = true;
  composer.maxLength = 4000;
  composer.rows = 3;
  composer.placeholder = t.placeholder;
  composer.setAttribute("aria-label", t.chat);
  const earlier = button(
    t.history,
    () =>
      void perform(async () => {
        const first = [...older, ...(snapshot?.messages ?? [])][0];
        if (!first) return;
        const page = await assistantCall<{
          epoch: number;
          messages: AssistantMessage[];
        }>(token!, `/history?before=${first.seq}`);
        if (page.epoch !== snapshot?.epoch) return;
        const loaded = [...page.messages, ...older];
        if (loaded.length > 200) {
          historyStatus.textContent = t.historyOlderGap;
          newerHistory.hidden = false;
        }
        older = loaded.slice(0, 200);
        earlier.disabled = page.messages.length < 50;
        renderChat(false);
      }),
  );
  const cancel = button(
    t.cancel,
    () =>
      void perform(async () => {
        const request = ownRequest;
        ownRequest = undefined;
        await voice.cancel(true);
        if (request) await assistantCall(token!, `/chat/${request}/cancel`, {});
        await refresh();
      }),
  );
  chatTools.append(
    earlier,
    button(t.clearChat, () => void clear("history")),
    newerHistory,
    historyStatus,
  );
  messages.className = "assistant-messages";
  messages.setAttribute("aria-live", "polite");
  send.type = "submit";
  form.append(
    quote,
    composer,
    send,
    cancel,
    hold,
    readReply,
    voiceHint,
    voiceTranscript,
  );
  chat.append(
    chatTools,
    messages,
    requestStatus,
    form,
    el("small", t.dataOnly),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit();
  });
  async function submit() {
    if (!token || !composer.value.trim()) return;
    const text = composer.value.trim();
    const replyTo=replyDraft?{runtimeEpoch:replyDraft.runtimeEpoch,displayInstanceId:replyDraft.displayInstanceId,utteranceId:replyDraft.utteranceId}:undefined;
    if (!pendingSubmit || pendingSubmit.text !== text || JSON.stringify(pendingSubmit.companionReplyTo)!==JSON.stringify(replyTo))
      pendingSubmit = { requestId: crypto.randomUUID(), text, ...(replyTo ? {companionReplyTo:replyTo} : {}) };
    const request = pendingSubmit;
    send.disabled = true;
    try {
      await voice.cancel(false);
      const state = await assistantCall<RequestState>(token, "/chat", request);
      ownRequest = state.requestId;
      pendingSubmit = undefined;
      composer.value = "";
      clearReply();
      await refresh();
    } catch (error) {
      showError(error);
    } finally {
      send.disabled = false;
    }
  }
  function renderChat(scroll = true) {
    if (!snapshot) return;
    const combined = new Map(
      [...older, ...snapshot.messages].map((item) => [item.seq, item]),
    );
    const key = JSON.stringify([snapshot.epoch, [...combined.values()].map(message =>
      [message.seq, message.companionReference ?? null, message.companionReferenceUnavailable ?? false])]);
    requestStatus.textContent = snapshot.activeRequest ? t.requestPending : "";
    cancel.disabled =
      voice.state() === "idle" &&
      (!ownRequest || snapshot.activeRequest?.requestId !== ownRequest);
    if (key === renderedChatKey) return;
    renderedChatKey = key;
    const oldHeight = messages.scrollHeight,
      oldTop = messages.scrollTop;
    const atBottom = oldHeight - oldTop - messages.clientHeight < 48;
    messages.replaceChildren();
    if (!combined.size) messages.append(el("p", t.emptyChat));
    for (const message of [...combined.values()].sort(
      (a, b) => a.seq - b.seq,
    )) {
      const entry = el("article");
      entry.className = message.role;
      entry.append(
        el("small", message.role === "user" ? t.you : t.assistant),
        ...(message.companionReference ? [el("blockquote", `${t.companionQuote}${message.companionReference.text}`)] : []),
        ...(message.companionReferenceUnavailable ? [el("blockquote", t.companionQuoteUnavailable)] : []),
        el("p", message.text),
      );
      messages.append(entry);
    }
    requestStatus.textContent = snapshot.activeRequest ? t.requestPending : "";
    cancel.disabled =
      voice.state() === "idle" &&
      (!ownRequest || snapshot.activeRequest?.requestId !== ownRequest);
    messages.scrollTop = scroll
      ? atBottom
        ? messages.scrollHeight
        : oldTop
      : oldTop + messages.scrollHeight - oldHeight;
  }
  const todos = views.get("todos")!,
    todoList = el("div"),
    todoForm = el("form");
  const title = input(t.titleLabel),
    notes = input(t.notes),
    deadline = input(t.deadline, "date");
  title.input.required = true;
  title.input.maxLength = 200;
  notes.input.maxLength = 2000;
  let editingTodo: { id: string; version: number } | undefined;
  const todoSave = el("button", t.add);
  todoSave.type = "submit";
  const resetTodo = () => {
    editingTodo = undefined;
    todoForm.reset();
    todoSave.textContent = t.add;
  };
  todoForm.append(
    title.label,
    notes.label,
    deadline.label,
    todoSave,
    button(t.back, resetTodo),
  );
  todoForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void perform(async () => {
      await mutate({
        action: editingTodo ? "todo.update" : "todo.create",
        ...editingTodo,
        title: title.input.value,
        notes: notes.input.value,
        dueDate: deadline.input.value,
      });
      resetTodo();
    });
  });
  todos.append(
    todoForm,
    button(t.clearTodos, () => void clear("todos")),
    todoList,
  );
  function renderSessions() {
    const view = views.get("sessions")!;
    view.replaceChildren();
    const sources = snapshot?.observations ?? [];
    if (!sources.length) { view.append(el("p", describeObservedSessions(sources))); return; }
    let shown = 0;
    let omitted = false;
    for (const source of sources) {
      const section = el("section");
      const origin = el("strong", `dsh · ${source.profileId}`);
      origin.title = `来源 ${source.sourceId}，客户端 ${source.clientId}`;
      section.append(origin, el("p", source.connected ? "已连接" : "来源已失联，当前进度不可用"));
      if (!source.sessions.length) section.append(el("p", "尚未观察到会话"));
      for (const row of source.sessions) {
        if (shown >= 20) { omitted = true; break; }
        shown += 1;
        const item = el("article");
        item.append(el("strong", row.projectName || "目录未知"), el("p", row.sessionId),
          el("p", source.connected ? sessionPhaseText[row.phase] : `上次为${sessionPhaseText[row.phase]}，当前状态未知`),
          el("small", `最后观测 ${new Date(row.observedAt).toLocaleString("zh-CN")}`));
        section.append(item);
      }
      if (source.truncated) section.append(el("p", "来源会话超过观察上限，部分未展示"));
      view.append(section);
    }
    if (omitted) view.append(el("p", "仅显示前 20 项，请在 dsh 核查其余会话"));
  }
  function renderTodos() {
    todoList.replaceChildren();
    if (!snapshot?.todos.length) todoList.append(el("p", t.noTodos));
    for (const item of snapshot?.todos ?? []) {
      const card = el("article");
      card.append(el("strong", `${item.completed ? "✓ " : ""}${item.title}`));
      if (item.notes) card.append(el("p", item.notes));
      if (item.dueDate)
        card.append(el("small", `${t.deadlinePrefix} ${item.dueDate}`));
      card.append(
        button(
          item.completed ? t.reopen : t.complete,
          () =>
            void perform(() =>
              mutate({
                action: "todo.update",
                id: item.id,
                version: item.version,
                completed: !item.completed,
              }),
            ),
        ),
        button(t.edit, () => {
          editingTodo = { id: item.id, version: item.version };
          title.input.value = item.title;
          notes.input.value = item.notes;
          deadline.input.value = item.dueDate ?? "";
          todoSave.textContent = t.save;
          title.input.focus();
        }),
        button(
          t.remove,
          () =>
            void perform(() =>
              mutate({
                action: "todo.delete",
                id: item.id,
                version: item.version,
              }),
            ),
        ),
      );
      todoList.append(card);
    }
  }
  const reminders = views.get("reminders")!,
    reminderList = el("div"),
    reminderForm = el("form");
  const remindBody = input(t.remindBody),
    remindTime = input(t.remindTime, "datetime-local"),
    linkLabel = el("label", t.link),
    link = el("select"),
    zone = el("small");
  remindBody.input.required = true;
  remindBody.input.maxLength = 512;
  remindTime.input.required = true;
  linkLabel.append(link);
  let editingReminder: { id: string; version: number } | undefined;
  const reminderSave = el("button", t.add);
  reminderSave.type = "submit";
  const resetReminder = () => {
    editingReminder = undefined;
    reminderForm.reset();
    link.disabled = false;
    reminderSave.textContent = t.add;
  };
  reminderForm.append(
    remindBody.label,
    remindTime.label,
    zone,
    linkLabel,
    reminderSave,
    button(t.back, resetReminder),
  );
  reminderForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void perform(async () => {
      await mutate({
        action: editingReminder ? "reminder.update" : "reminder.create",
        ...editingReminder,
        message: remindBody.input.value,
        remindLocal: remindTime.input.value,
        ...(!editingReminder && link.value ? { todoId: link.value } : {}),
      });
      resetReminder();
    });
  });
  reminders.append(reminderForm, el("p", t.reminderRetryHint), reminderList);
  function renderReminders() {
    zone.textContent = `${t.timeZone}：${snapshot?.settings?.timeZone ?? "—"}`;
    const selected = link.value;
    link.replaceChildren(new Option(t.independent, ""));
    for (const item of snapshot?.todos ?? [])
      if (!item.completed) link.append(new Option(item.title, item.id));
    link.value = selected;
    reminderList.replaceChildren();
    if (!snapshot?.reminders.length)
      reminderList.append(el("p", t.noReminders));
    for (const item of snapshot?.reminders ?? []) {
      const card = el("article");
      card.append(
        el("strong", item.message),
        el(
          "p",
          `${new Date(item.remindAt).toLocaleString("zh-CN", { timeZone: item.timeZone })} · ${item.timeZone}`,
        ),
        el("small", t.notificationStatus[item.status] ?? item.status),
      );
      if (item.todoId)
        card.append(
          el(
            "small",
            `${t.linkPrefix}：${snapshot?.todos.find((todo) => todo.id === item.todoId)?.title ?? t.missingTodo}`,
          ),
        );
      if (item.code) card.append(el("small", t.errors[item.code] ?? item.code));
      if (item.seenAt != null)
        card.append(
          el(
            "small",
            `${t.reminderSeen}：${new Date(item.seenAt).toLocaleString("zh-CN", { timeZone: snapshot?.settings?.timeZone ?? item.timeZone })}`,
          ),
        );
      else if (["accepted", "failed"].includes(item.status))
        card.append(
          button(
            t.reminderAck,
            () =>
              void perform(() =>
                mutate({
                  action: "reminder.ack",
                  id: item.id,
                  version: item.version,
                }),
              ),
          ),
        );
      if (item.status === "failed")
        card.append(
          button(
            t.reminderRetry,
            () =>
              void perform(() =>
                mutate({
                  action: "reminder.retry",
                  id: item.id,
                  version: item.version,
                }),
              ),
          ),
        );
      if (item.status === "pending")
        card.append(
          button(t.edit, () => {
            editingReminder = { id: item.id, version: item.version };
            remindBody.input.value = item.message;
            // datetime-local 显示 Runtime 设置时区，不使用浏览器时区偏移。
            const parts = new Intl.DateTimeFormat("sv-SE", {
              timeZone: snapshot?.settings?.timeZone ?? item.timeZone,
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              hourCycle: "h23",
            }).format(item.remindAt);
            remindTime.input.value = parts.replace(" ", "T");
            link.value = item.todoId ?? "";
            link.disabled = true;
            reminderSave.textContent = t.save;
          }),
        );
      card.append(
        button(
          t.remove,
          () =>
            void perform(() =>
              mutate({
                action: "reminder.delete",
                id: item.id,
                version: item.version,
              }),
            ),
        ),
      );
      reminderList.append(card);
    }
  }
  const settingsPane = views.get("settings")!;
  function renderSettings() {
    const settings = snapshot?.settings;
    if (!settings) {
      settingsPane.replaceChildren(el("p", t.errors.settings_invalid));
      return;
    }
    settingsVersion = settings.version;
    settingsDirty = false;
    const fields = el("form"),
      timeZone = input(t.timeZone, "text", settings.timeZone),
      persona = input(t.persona, "text", settings.persona);
    const companionEnabled = settings.companion ? check(t.companionEnabled,settings.companion.murmurEnabled) : undefined;
    const memory = settings.memory ? {
      write: check(t.memoryWrite, settings.memory.writeEnabled),
      recall: check(t.memoryRecall, settings.memory.recallEnabled),
      python: input(t.memoryPython, "text", settings.memory.pythonPath),
      config: input(t.memoryConfig, "text", settings.memory.configPath),
      access: input(t.memoryAccess, "text", settings.memory.accessPath),
      tokenizer: input(t.memoryTokenizer, "text", settings.memory.tokenizerDataDir),
    } : undefined;
    const enabled = check(t.enableModel, settings.chat.enabled),
      cloud = check(t.cloud, settings.cloudEnabled),
      locality = el("select"),
      localityLabel = el("label", t.locality);
    const voiceSettings = settings.voice ?? defaultVoiceSettings(),
      microphone = check(t.microphoneEnable, voiceSettings.microphoneEnabled),
      asr = check(t.asrEnable, voiceSettings.asr.enabled),
      tts = check(t.ttsEnable, voiceSettings.tts.enabled),
      languageLabel = el("label", t.voiceLanguage),
      language = el("select"),
      voiceId = input(t.voiceId, "text", voiceSettings.tts.voiceId),
      availability = el("p");
    const online = voiceSettings.bailian ?? defaultBailianSettings();
    const asrProvider = el("select"),
      ttsProvider = el("select"),
      asrProviderLabel = el("label", t.asrProvider),
      ttsProviderLabel = el("label", t.ttsProvider);
    for (const select of [asrProvider, ttsProvider])
      select.append(
        new Option(t.voiceLocal, "local"),
        new Option(t.voiceBailian, "bailian"),
      );
    asrProvider.append(new Option(t.voiceDsh, "dsh"));
    const hostLabel = el("label", t.voiceHost), hostSelect = el("select");
    hostSelect.append(new Option(t.voiceHostEmpty, ""));
    const savedHost = voiceSettings.asr.hostClientId && voiceSettings.asr.hostSourceId
      ? JSON.stringify([voiceSettings.asr.hostClientId, voiceSettings.asr.hostSourceId]) : "";
    if (savedHost) hostSelect.append(new Option(`${voiceSettings.asr.hostClientId} / ${voiceSettings.asr.hostSourceId}（上次选择）`, savedHost));
    hostSelect.value = savedHost;
    hostLabel.append(hostSelect);
    void assistantCall<{ hosts?: Array<{ clientId: string; sourceId: string; providerId: string; locality: string }> }>(token!, "/voice/hosts").then((status) => {
      for (const host of status.hosts ?? []) {
        const value = JSON.stringify([host.clientId, host.sourceId]);
        if (value !== savedHost) hostSelect.append(new Option(`${host.providerId} · 宿主声明本地 · ${host.clientId} / ${host.sourceId}`, value));
      }
    }).catch(() => undefined);
    asrProvider.value = voiceSettings.asr.provider ?? "local";
    ttsProvider.value = voiceSettings.tts.provider ?? "local";
    asrProviderLabel.append(asrProvider);
    ttsProviderLabel.append(ttsProvider);
    const workspace = input(t.voiceWorkspace, "text", online.workspaceId),
      asrModel = input(t.voiceAsrModel, "text", online.asrModel),
      ttsModel = input(t.voiceTtsModel, "text", online.ttsModel),
      onlineVoice = input(t.voiceOnlineVoice, "text", online.voiceId),
      speechKey = input(t.voiceApiKey, "password"),
      removeSpeechKey = check(t.voiceRemoveKey, false);
    workspace.input.maxLength = 64;
    asrModel.input.maxLength = 120;
    ttsModel.input.maxLength = 120;
    onlineVoice.input.maxLength = 80;
    speechKey.input.maxLength = 1000;
    speechKey.input.autocomplete = "new-password";
    language.append(
      new Option("中文", "zh"),
      new Option("English", "en"),
      new Option(t.voiceAuto, "auto"),
    );
    language.value = voiceSettings.asr.language;
    languageLabel.append(language);
    voiceId.input.maxLength = 150;
    const detect = button(
      t.voiceCheck,
      () =>
        void perform(async () => {
          const status = await assistantCall<{
            asrAvailable: boolean;
            ttsAvailable: boolean;
            voices: Array<{ id: string; culture: string }>;
            configurationOnly?: boolean;
          }>(token!, "/voice/status");
          availability.textContent = `ASR ${status.asrAvailable ? (status.configurationOnly ? t.voiceConfigured : t.voiceReady) : t.voiceMissing} · TTS ${status.ttsAvailable ? (status.configurationOnly ? t.voiceConfigured : t.voiceReady) : t.voiceMissing}\n${status.voices.map((v) => `${v.id} (${v.culture})`).join("\n")}${status.configurationOnly ? `\n${t.voiceNoProbe}` : ""}`;
        }),
    );
    locality.append(
      new Option(t.local, "local"),
      new Option(t.remote, "cloud"),
    );
    locality.value = settings.chat.locality;
    localityLabel.append(locality);
    const url = input(t.baseUrl, "url", settings.chat.baseUrl),
      model = input(t.model, "text", settings.chat.model),
      key = input(t.apiKey, "password"),
      removeKey = check(t.removeKey, false);
    key.input.autocomplete = "new-password";
    key.input.maxLength = 1000;
    persona.input.maxLength = 500;
    const inputLimit = input(
        t.inputLimit,
        "number",
        String(settings.chat.maxInputTokens),
      ),
      outputLimit = input(
        t.outputLimit,
        "number",
        String(settings.chat.maxOutputTokens),
      );
    inputLimit.input.min = "512";
    inputLimit.input.max = "32768";
    outputLimit.input.min = "64";
    outputLimit.input.max = "4096";
    const save = el("button", t.saveSettings);
    save.type = "submit";
    fields.className = "settings-form";
    availability.className = "settings-availability";
    const grid = (...children: HTMLElement[]) => {
      const node = el("div");
      node.className = "settings-grid";
      node.append(...children);
      return node;
    };
    const section = (title: string, hint: string, ...children: HTMLElement[]) => {
      const card = el("section"), heading = el("div"), body = el("div");
      card.className = "settings-section";
      heading.className = "settings-section-heading";
      body.className = "settings-section-body";
      heading.append(el("h3", title), el("p", hint));
      body.append(...children);
      card.append(heading, body);
      return card;
    };
    const note = (text: string) => {
      const node = el("p", text);
      node.className = "settings-note";
      return node;
    };
    const companionSnoozeStatus = note(settings.companion?.murmurSnoozedUntil
      ? `${t.companionSnoozedUntil} ${new Date(settings.companion.murmurSnoozedUntil).toLocaleString()}`
      : "");
    const credentialRow = (configured: boolean, removal: HTMLLabelElement) => {
      const row = el("div"), status = el("span", configured ? t.keySaved : t.keyEmpty);
      row.className = "credential-row";
      status.className = configured ? "credential-status is-configured" : "credential-status";
      row.append(status, removal);
      return row;
    };
    const voiceInput = el("div"), voiceOutput = el("div");
    voiceInput.className = "settings-subsection";
    voiceOutput.className = "settings-subsection";
    voiceInput.append(el("h4", t.voiceInput), asr.label, asrProviderLabel, hostLabel, languageLabel);
    voiceOutput.append(el("h4", t.voiceOutput), tts.label, ttsProviderLabel, voiceId.label);
    const localVoiceNote = note(t.voiceInstall);
    const diagnostics = el("div");
    diagnostics.className = "settings-diagnostics";
    diagnostics.append(detect, availability);
    const recovery = el("div");
    recovery.className = "settings-recovery";
    recovery.append(
      note(t.voiceRecoveryHint),
      button(t.voiceRecovery, () => {
        void invoke("recover_speech").then(() => {
          availability.textContent = t.voiceRecovered;
        }).catch((error: unknown) => {
          availability.textContent = error === "user_denied" ? t.voiceRecoveryCancelled : t.voiceRecoveryFailed;
        });
      }),
    );
    const onlineSection = section(
      t.voiceBailian,
      t.voiceBailianHint,
      note(t.voiceCloudDisclosure),
      workspace.label,
      grid(asrModel.label, ttsModel.label),
      onlineVoice.label,
      speechKey.label,
      credentialRow(settings.voice?.apiKeyConfigured ?? false, removeSpeechKey.label),
    );
    const intro = el("p", t.settingsIntro);
    intro.className = "settings-intro";
    const actions = el("div");
    actions.className = "settings-actions";
    actions.append(
      save,
      button(
        t.reload,
        () =>
          void perform(async () => {
            settingsDirty = false;
            await refresh();
            renderSettings();
          }),
      ),
    );
    const voiceSection = section(
      t.voiceSettings,
      t.voiceSettingsHint,
      microphone.label,
      voiceInput,
      voiceOutput,
      localVoiceNote,
      diagnostics,
      ...(isTauri() ? [recovery] : []),
    );
    voiceSection.className += " settings-voice";
    fields.append(
      intro,
      section(t.generalSettings, t.generalSettingsHint, timeZone.label, persona.label, cloud.label,
        ...(companionAvailability ? [note(companionAvailability)] : []),
        ...(companionEnabled ? [companionEnabled.label, companionSnoozeStatus,button(t.companionSnooze,()=>void (async()=>{
          await mutate({action:"companion.snooze",version:settingsVersion});
          const until=snapshot?.settings?.companion?.murmurSnoozedUntil;
          companionSnoozeStatus.textContent=until ? `${t.companionSnoozedUntil} ${new Date(until).toLocaleString()}` : "";
          notice.textContent=companionSnoozeStatus.textContent || t.stored;
        })().catch(showError))] : [])) ,
      section(
        t.chatSettings,
        t.chatSettingsHint,
        enabled.label,
        grid(localityLabel, model.label),
        url.label,
        key.label,
        credentialRow(settings.chat.apiKeyConfigured, removeKey.label),
        grid(inputLimit.label, outputLimit.label),
        note(t.usage),
      ),
      ...(memory ? [section(t.memorySettings, t.memoryHint,
        memory.write.label, memory.recall.label,
        memory.python.label, memory.config.label, memory.access.label, memory.tokenizer.label,
        note(t.memoryPrivacy),
        button(t.memoryPair, () => {
          // focusin 只保护编辑中的表单；配对只需判断记忆配置是否真的有未保存修改。
          const saved = settings.memory!;
          if (memory.write.input.checked !== saved.writeEnabled || memory.recall.input.checked !== saved.recallEnabled ||
              memory.python.input.value !== saved.pythonPath || memory.config.input.value !== saved.configPath ||
              memory.access.input.value !== saved.accessPath || memory.tokenizer.input.value !== saved.tokenizerDataDir) {
            notice.textContent = t.memorySaveFirst; return;
          }
          void perform(async () => {
            await assistantCall(token!, "/memory/pair", {});
            notice.textContent = t.memoryPaired;
          });
        }),
      )] : []),
      voiceSection,
      onlineSection,
      actions,
    );
    const updateProviderFields = () => {
      hostLabel.hidden = asrProvider.value !== "dsh";
      voiceId.label.hidden = ttsProvider.value !== "local";
      localVoiceNote.hidden = asrProvider.value !== "local" && ttsProvider.value !== "local";
      onlineSection.hidden = asrProvider.value !== "bailian" && ttsProvider.value !== "bailian";
    };
    for (const provider of [asrProvider, ttsProvider]) provider.addEventListener("change", () => {
      settingsDirty = true;
      updateProviderFields();
    });
    updateProviderFields();
    fields.addEventListener("input", () => {
      settingsDirty = true;
    });
    fields.addEventListener("focusin", () => {
      settingsDirty = true;
    });
    fields.addEventListener("submit", (event) => {
      event.preventDefault();
      void perform(async () => {
        const next = {
          version: settingsVersion,
          timeZone: timeZone.input.value,
          persona: persona.input.value,
          cloudEnabled: cloud.input.checked,
          ...(memory ? { memory: {
            writeEnabled: memory.write.input.checked,
            recallEnabled: memory.recall.input.checked,
            pythonPath: memory.python.input.value,
            configPath: memory.config.input.value,
            accessPath: memory.access.input.value,
            tokenizerDataDir: memory.tokenizer.input.value,
          } } : {}),
          ...(companionEnabled ? {companion:{murmurEnabled:companionEnabled.input.checked}} : {}),
          voice: {
            microphoneEnabled: microphone.input.checked,
            asr: {
              enabled: asr.input.checked,
              language: language.value,
              provider: asrProvider.value,
              ...(hostSelect.value ? { hostClientId: JSON.parse(hostSelect.value)[0] as string, hostSourceId: JSON.parse(hostSelect.value)[1] as string } : {}),
            },
            tts: {
              enabled: tts.input.checked,
              voiceId: voiceId.input.value,
              provider: ttsProvider.value,
            },
            bailian: {
              workspaceId: workspace.input.value,
              asrModel: asrModel.input.value,
              ttsModel: ttsModel.input.value,
              voiceId: onlineVoice.input.value,
            },
          },
          chat: {
            enabled: enabled.input.checked,
            locality: locality.value,
            baseUrl: url.input.value,
            model: model.input.value,
            maxInputTokens: Number(inputLimit.input.value),
            maxOutputTokens: Number(outputLimit.input.value),
          },
          ...(removeKey.input.checked
            ? { apiKey: "" }
            : key.input.value
              ? { apiKey: key.input.value }
              : {}),
          ...(removeSpeechKey.input.checked
            ? { speechApiKey: "" }
            : speechKey.input.value
              ? { speechApiKey: speechKey.input.value }
              : {}),
        };
        save.disabled = true;
        try {
          await voice.cancel(false);
          await assistantCall<AssistantSettingsView>(
            token!,
            "/settings",
            next,
            "PUT",
          );
          key.input.value = "";
          speechKey.input.value = "";
          settingsDirty = false;
          await refresh();
          renderSettings();
          notice.textContent = t.stored;
        } finally {
          save.disabled = false;
        }
      });
    });
    settingsPane.replaceChildren(fields);
  }
  async function refresh(reloadOlder = false) {
    if (!token || disposed) return;
    if (refreshing) {
      await refreshing;
      if (!reloadOlder || disposed) return;
    }
    refreshing = (async () => {
      const next = await assistantCall<AssistantSnapshot>(token!, "/snapshot");
      if (disposed) return;
      if (epoch !== undefined && epoch !== next.epoch) {
        void voice.cancel(false);
        older = [];
        historyStatus.textContent = "";
        newerHistory.hidden = true;
        pendingSubmit = undefined;
      }
      if (snapshot && epoch === next.epoch && next.messages.length && (reloadOlder || newerHistory.hidden)) {
        const prior = [...new Map([...older, ...snapshot.messages].map(message => [message.seq, message])).values()]
          .sort((a,b) => a.seq-b.seq);
        const nextSeqs = new Set(next.messages.map(message => message.seq));
        const firstNext = next.messages[0]!.seq;
        const priorFirst = prior[0]?.seq;
        const overlapping = snapshot.messages.some(message => nextSeqs.has(message.seq));
        const needsPages = reloadOlder || (priorFirst !== undefined && firstNext > priorFirst && !overlapping);
        if (priorFirst !== undefined && firstNext > priorFirst && needsPages) {
          let before = firstNext;
          let reloaded: AssistantMessage[] = [];
          let lastPageSize = 50;
          while (before > priorFirst && reloaded.length < 200) {
            const page = await assistantCall<{epoch:number;messages:AssistantMessage[]}>(token!, `/history?before=${before}`);
            if (disposed) return;
            if (page.epoch !== next.epoch) { reloaded = []; break; }
            lastPageSize = page.messages.length;
            if (!lastPageSize) break;
            const oldest = page.messages[0]!.seq;
            if (oldest >= before) break;
            reloaded = [...page.messages.filter(message => message.seq >= priorFirst), ...reloaded];
            before = oldest;
          }
          if (before > priorFirst || reloaded.length > 200) historyStatus.textContent = t.historyTrimmed;
          older = reloaded.slice(-200);
          earlier.disabled = lastPageSize < 50;
          newerHistory.hidden = true;
        } else {
          const retained = prior.filter(message => message.seq < firstNext);
          if (retained.length > 200) { historyStatus.textContent = t.historyTrimmed; earlier.disabled = false; }
          older = retained.slice(-200);
        }
      }
      epoch = next.epoch;
      if (
        snapshot?.settings?.version !== undefined &&
        snapshot.settings.version !== next.settings?.version
      )
        void voice.cancel(false);
      snapshot = next;
      renderSessions();
      updateVoice();
      renderChat();
      renderTodos();
      renderReminders();
      if (tab === "settings" && !settingsDirty) renderSettings();
      if (ownRequest) {
        const request = await assistantCall<RequestState>(
          token!,
          `/chat/${ownRequest}`,
        );
        if (request.status !== "pending") {
          if (request.code)
            notice.textContent = t.errors[request.code] ?? request.code;
          const requested = ownRequest;
          ownRequest = undefined;
          if (
            request.status === "completed" &&
            request.message &&
            snapshot.settings?.voice?.tts.enabled &&
            !host.hidden &&
            (voice.ownsRequest(requested) || voice.state() === "idle")
          )
            void voice.speak(request.message.seq);
          else if (voice.ownsRequest(requested)) void voice.complete();
          cancel.disabled = true;
        }
      }
      clearTimeout(poll);
      if (!host.hidden || snapshot.activeRequest)
        poll = setTimeout(
          () => void perform(refresh),
          snapshot.activeRequest ? 800 : 5000,
        );
    })().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }
  async function connect(create: boolean, reloadOlder = false) {
    if (connecting) {
      try { await connecting; }
      catch (error) { if (!create || token) throw error; }
      // 视图入口的复用失败不应吞掉随后明确打开助手的首次授权。
      if (create && !token) return connect(true, reloadOlder);
      if (reloadOlder) await refresh(true);
      return;
    }
    connecting = (async () => {
      token = await assistantToken(create);
      if (!stopEvents) {
        const generation=++eventGeneration;
        stopEvents = await runtime.connectEvents(
          token,
          (event) => {
            if(generation!==eventGeneration)return;
            companion?.onEvent(event);
            if (event.kind === "assistant.voice.stop")
              voice.stopIfOwned(event.payload.leaseId);
            if ((event.kind === "assistant.changed" || event.kind === "assistant.observations_changed") && !host.hidden)
              void perform(refresh);
            if (
              event.kind === "assistant.reminder" &&
              typeof event.payload.body === "string"
            )
              onReminder(event.payload.body);
          },
          (connected) => {
            if(generation!==eventGeneration)return;
            if (!connected) { companion?.onDisconnected(); void voice.cancel(false); }
            if (connected && !host.hidden) void perform(refresh);
          },
          (ready) => {if(generation===eventGeneration)companion?.onReady(ready);},
        );
      }
      await refresh(reloadOlder);
    })().finally(() => {
      connecting = undefined;
    });
    return connecting;
  }
  const showView = (view: Tab = "settings", anchor?: "voice"): void => {
    selectTab(view);
    if (anchor === "voice") settingsPane.querySelector(".settings-voice")?.scrollIntoView({ block: "start" });
  };
  return {
    show: showView,
    setPetAppearance,
    setCompanionAvailability(reason:string|null):void {companionAvailability=reason;if(tab==="settings"&&!settingsDirty)renderSettings();},
    async snoozeCompanion():Promise<void> {
      if(!token)throw new AssistantClientError("assistant_credential_pairing_required");
      const capability=await assistantCall<{protocolVersion:number}>(token,"/companion/status");
      if(capability.protocolVersion!==1)throw new AssistantClientError("companion_protocol_unsupported");
      const settings=await assistantCall<AssistantSettingsView>(token,"/settings");
      await mutate({action:"companion.snooze",version:settings.version});
    },
    async setCompanionEnabled(enabled:boolean):Promise<void> {
      if(!token)throw new AssistantClientError("assistant_credential_pairing_required");
      const settings=await assistantCall<AssistantSettingsView>(token,"/settings");
      if(!settings.companion)throw new AssistantClientError("companion_state_unavailable");
      const {apiKeyConfigured:_,...chat}=settings.chat;
      await assistantCall(token,"/settings",{version:settings.version,timeZone:settings.timeZone,persona:settings.persona,cloudEnabled:settings.cloudEnabled,chat,companion:{murmurEnabled:enabled}},"PUT");
      await refresh();
    },
    async companionCall(path:string, body?:unknown):Promise<unknown> {
      if(!token)throw new AssistantClientError("assistant_credential_pairing_required");
      return assistantCall(token,path,body);
    },
    reconnectCompanion():void {
      eventGeneration++;stopEvents?.();stopEvents=undefined;
      const previous=connecting;
      void (async()=>{if(previous)await previous.catch(()=>undefined);if(!disposed)await connect(false);})().catch(()=>undefined);
    },
    async openWithCompanionReply(utterance:CompanionUtterance):Promise<void> {
      if(!token)await connect(true);
      replyDraft=utterance;pendingSubmit=undefined;quote.hidden=false;
      quote.replaceChildren(el("span",`${t.companionQuote}${utterance.text}`),button(t.removeCompanionReply,clearReply));
      selectTab("chat");composer.focus();
    },
    async open(draft?: string, create = true) {
      host.hidden = false;
      if (appearance && tab === "appearance") appearance.hidden = false;
      if (draft) composer.value = draft;
      notice.textContent = t.loading;
      await perform(async () => {
        await connect(create, true);
        notice.textContent = "";
        composer.focus();
      });
    },
    async reuse() {
      try {
        await connect(false, true);
      } catch {
        /* 从未打开过的助理不自动授予个人数据权限。 */
      }
    },
    close() {
      void voice.cancel(false);
      host.hidden = true;
      if (appearance) appearance.hidden = true;
      clearTimeout(poll);
    },
    dispose() {
      void voice.cancel(false);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      disposed = true;
      eventGeneration++;
      clearTimeout(poll);
      stopEvents?.();
    },
    focusVoice() {
      const settings = snapshot?.settings?.voice ?? defaultVoiceSettings();
      if (!settings.microphoneEnabled || !settings.asr.enabled) {
        showView("settings", "voice");
        notice.textContent = t.voiceSetupHint;
      } else if (hold.disabled) cancel.focus();
      else hold.focus();
    },
  };
}
