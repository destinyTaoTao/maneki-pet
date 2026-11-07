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
import { defaultVoiceSettings, defaultBailianSettings } from "@maneki-pet/core";
import { VoiceController } from "./voice-controller.js";
import { BrowserVoiceCapture, BrowserVoicePlayer } from "./voice-media.js";

type Tab = "chat" | "todos" | "reminders" | "settings";
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

/** 单 WebView 面板：所有返回内容通过 textContent 渲染，提交只走明确操作。 */
export function createAssistantPanel(
  host: HTMLElement,
  onClose: () => void,
  onReminder: (text: string) => void,
) {
  let token: string | undefined,
    snapshot: AssistantSnapshot | undefined,
    tab: Tab = "chat",
    disposed = false;
  let stopEvents: (() => void) | undefined,
    connecting: Promise<void> | undefined,
    ownRequest: string | undefined;
  let pendingSubmit: { requestId: string; text: string } | undefined,
    refreshing: Promise<void> | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined,
    epoch: number | undefined;
  let older: AssistantMessage[] = [],
    renderedChatKey = "",
    settingsDirty = false,
    settingsVersion: number | undefined;
  let heldPointer: number | undefined, heldKey: string | undefined;
  const header = el("header"),
    heading = el("strong", t.title),
    close = button(t.close, onClose);
  header.append(
    heading,
    button(t.reload, () => void perform(() => connect(true))),
    close,
  );
  const tabs = el("nav"),
    content = el("main"),
    notice = el("p");
  notice.className = "assistant-notice";
  notice.setAttribute("role", "status");
  const confirmation = el("section");
  confirmation.hidden = true;
  confirmation.className = "assistant-confirm";
  const views = new Map<Tab, HTMLElement>(),
    tabButtons = new Map<Tab, HTMLButtonElement>();
  for (const name of ["chat", "todos", "reminders", "settings"] as const) {
    const node = el("section");
    node.className = `assistant-${name}`;
    node.hidden = name !== tab;
    views.set(name, node);
    content.append(node);
    const btn = button(t[name], () => {
      tab = name;
      for (const [key, value] of views) value.hidden = key !== name;
      for (const [key, value] of tabButtons)
        value.setAttribute("aria-pressed", String(key === name));
      if (name === "settings" && !settingsDirty) renderSettings();
    });
    btn.setAttribute("aria-pressed", String(name === tab));
    tabs.append(btn);
    tabButtons.set(name, btn);
  }
  host.append(header, tabs, notice, confirmation, content);
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
    requestStatus = el("p");
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
        older = [...page.messages, ...older].slice(-200);
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
  );
  messages.className = "assistant-messages";
  messages.setAttribute("aria-live", "polite");
  send.type = "submit";
  form.append(
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
    if (!pendingSubmit || pendingSubmit.text !== text)
      pendingSubmit = { requestId: crypto.randomUUID(), text };
    const request = pendingSubmit;
    send.disabled = true;
    try {
      await voice.cancel(false);
      const state = await assistantCall<RequestState>(token, "/chat", request);
      ownRequest = state.requestId;
      pendingSubmit = undefined;
      composer.value = "";
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
    const key = `${snapshot.epoch}:${[...combined.keys()].join(",")}`;
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
  reminders.append(reminderForm, reminderList);
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
    const save = el("button", t.save);
    save.type = "submit";
    fields.append(
      timeZone.label,
      persona.label,
      enabled.label,
      cloud.label,
      localityLabel,
      url.label,
      model.label,
      key.label,
      el("small", settings.chat.apiKeyConfigured ? t.keySaved : t.keyEmpty),
      removeKey.label,
      inputLimit.label,
      outputLimit.label,
      el("p", t.usage),
      el("h3", t.voiceSettings),
      microphone.label,
      asr.label,
      asrProviderLabel,
      languageLabel,
      tts.label,
      ttsProviderLabel,
      voiceId.label,
      el("p", t.voiceInstall),
      el("h3", t.voiceBailian),
      el("p", t.voiceCloudDisclosure),
      workspace.label,
      asrModel.label,
      ttsModel.label,
      onlineVoice.label,
      speechKey.label,
      el("small", settings.voice?.apiKeyConfigured ? t.keySaved : t.keyEmpty),
      removeSpeechKey.label,
      detect,
      availability,
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
          voice: {
            microphoneEnabled: microphone.input.checked,
            asr: {
              enabled: asr.input.checked,
              language: language.value,
              provider: asrProvider.value,
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
  async function refresh() {
    if (!token || disposed) return;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const next = await assistantCall<AssistantSnapshot>(token!, "/snapshot");
      if (disposed) return;
      if (epoch !== undefined && epoch !== next.epoch) {
        void voice.cancel(false);
        older = [];
        pendingSubmit = undefined;
      }
      epoch = next.epoch;
      if (
        snapshot?.settings?.version !== undefined &&
        snapshot.settings.version !== next.settings?.version
      )
        void voice.cancel(false);
      snapshot = next;
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
  async function connect(create: boolean) {
    if (connecting) return connecting;
    connecting = (async () => {
      token = await assistantToken(create);
      if (!stopEvents)
        stopEvents = await runtime.connectEvents(
          token,
          (event) => {
            if (event.kind === "assistant.voice.stop")
              voice.stopIfOwned(event.payload.leaseId);
            if (event.kind === "assistant.changed" && !host.hidden)
              void perform(refresh);
            if (
              event.kind === "assistant.reminder" &&
              typeof event.payload.body === "string"
            )
              onReminder(event.payload.body);
          },
          (connected) => {
            if (!connected) void voice.cancel(false);
            if (connected && !host.hidden) void perform(refresh);
          },
        );
      await refresh();
    })().finally(() => {
      connecting = undefined;
    });
    return connecting;
  }
  return {
    async open(draft?: string) {
      host.hidden = false;
      if (draft) composer.value = draft;
      notice.textContent = t.loading;
      await perform(async () => {
        await connect(true);
        notice.textContent = "";
        composer.focus();
      });
    },
    async reuse() {
      try {
        await connect(false);
      } catch {
        /* 从未打开过的助理不自动授予个人数据权限。 */
      }
    },
    close() {
      void voice.cancel(false);
      host.hidden = true;
      clearTimeout(poll);
    },
    dispose() {
      void voice.cancel(false);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      disposed = true;
      clearTimeout(poll);
      stopEvents?.();
    },
    focusVoice() {
      const settings = snapshot?.settings?.voice ?? defaultVoiceSettings();
      if (!settings.microphoneEnabled || !settings.asr.enabled) {
        tabButtons.get("settings")?.click();
        notice.textContent = t.voiceSetupHint;
      } else if (hold.disabled) cancel.focus();
      else hold.focus();
    },
  };
}
