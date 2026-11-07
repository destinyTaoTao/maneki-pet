import {
  petStates,
  validatePetPack,
  type PetPack,
  type PetState,
  type ValidatedPetPack,
} from "@maneki-pet/core";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createAssistantPanel } from "./assistant-panel.js";
import { assistantText } from "./assistant-text.js";
import { PetPlayer } from "./player.js";
import { BoundedReadError, MEDIA_READ_TIMEOUT_MS, readBounded, readMedia } from "./bounded-fetch.js";
import { imageDimensions, MediaBudgetError, withinPixelBudget } from "./media-budget.js";
import { attachWindowDrag, isTauriRuntime } from "./window-drag.js";
import { attachPetInteraction } from "./pet-interaction.js";
import * as runtimeClient from "./runtime-client.js";
import { uiText } from "./ui-text.js";
import "./style.css";
import packIds from "../config/builtin-packs.json" with { type: "json" };

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App root missing");

const petButton = document.createElement("button");
petButton.className = "pet-button";
petButton.type = "button";
petButton.setAttribute("aria-label", uiText.petAction);
const playerRoot = document.createElement("div");
playerRoot.className = "player-root";
const placeholder = document.createElement("img");
placeholder.className = "pet-media";
placeholder.src = "/fallback.png";
placeholder.alt = "";
placeholder.draggable = false;
playerRoot.append(placeholder);
petButton.append(playerRoot);

const status = document.createElement("div");
status.className = "status-bubble";
status.setAttribute("role", "status");
status.textContent = uiText.loading;

function controlIcon(path: string): SVGSVGElement {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "1.8");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("aria-hidden", "true");
  const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
  line.setAttribute("d", path);
  icon.append(line);
  return icon;
}

const controls = document.createElement("div");
controls.className = "pet-controls";
controls.setAttribute("aria-label", uiText.petControls);
const textForm = document.createElement("form");
textForm.className = "draft-input";
const messageInput = document.createElement("input");
messageInput.type = "text";
messageInput.maxLength = 2000;
messageInput.autocomplete = "off";
messageInput.placeholder = uiText.messagePlaceholder;
messageInput.setAttribute("aria-label", uiText.messageInput);
messageInput.title = assistantText.openAssistant;
const draftNote = document.createElement("span");
draftNote.className = "draft-note";
draftNote.textContent = assistantText.shortcut;
textForm.append(messageInput, draftNote);
const voiceButton = document.createElement("button");
voiceButton.className = "control-button voice-button";
voiceButton.type = "button";
voiceButton.setAttribute("aria-label", assistantText.voiceOpen);
voiceButton.title = assistantText.voiceOpen;
voiceButton.append(controlIcon("M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5ZM5 11v1a7 7 0 0 0 14 0v-1M12 19v3M8 22h8"));
const settingsButton = document.createElement("button");
settingsButton.className = "control-button settings-button";
settingsButton.type = "button";
settingsButton.setAttribute("aria-label", uiText.settings);
settingsButton.setAttribute("aria-expanded", "false");
settingsButton.setAttribute("aria-controls", "pet-settings");
settingsButton.title = uiText.settings;
settingsButton.append(controlIcon("m6 9 6 6 6-6"));
controls.append(textForm, voiceButton, settingsButton);

const panel = document.createElement("section");
panel.className = "settings-panel";
panel.id = "pet-settings";
panel.setAttribute("aria-label", uiText.settings);
panel.hidden = true;
const packLabel = document.createElement("label");
packLabel.textContent = uiText.packLabel;
const packSelect = document.createElement("select");
packSelect.disabled = true;
packLabel.append(packSelect);
const stateLabel = document.createElement("label");
stateLabel.textContent = uiText.stateLabel;
const stateSelect = document.createElement("select");
for (const state of petStates) {
  const option = document.createElement("option");
  option.value = state;
  option.textContent = uiText.states[state];
  stateSelect.append(option);
}
stateLabel.append(stateSelect);
const actionLabel = document.createElement("label");
actionLabel.textContent = uiText.actionLabel;
const actionSelect = document.createElement("select");
actionSelect.disabled = true;
actionLabel.append(actionSelect);
const playActionButton = document.createElement("button");
playActionButton.type = "button";
playActionButton.textContent = uiText.playAction;
playActionButton.disabled = true;
const runtimeSectionLabel = document.createElement("label");
runtimeSectionLabel.textContent = uiText.runtimeSection;
const runtimeStateLine = document.createElement("div");
runtimeStateLine.className = "runtime-line";
runtimeStateLine.textContent = uiText.runtimeConnecting;
const runtimeLimitsLine = document.createElement("div");
runtimeLimitsLine.className = "runtime-line";
const runtimeDndLine = document.createElement("div");
runtimeDndLine.className = "runtime-line";
panel.append(packLabel, stateLabel, actionLabel, playActionButton, runtimeSectionLabel, runtimeStateLine, runtimeLimitsLine, runtimeDndLine);
app.append(status, petButton, controls, panel);
const assistantHost=document.createElement("section");
assistantHost.className="assistant-panel";
assistantHost.hidden=true;
assistantHost.setAttribute("aria-label",assistantText.title);
app.append(assistantHost);
const assistantPanel=createAssistantPanel(assistantHost,()=>{
  assistantPanel.close();
  for(const node of [status,petButton,controls,panel])node.inert=false;
  if(isTauriRuntime())void invoke("assistant_view",{open:false}).catch(()=>showBubble(uiText.interactionUnavailable));
},showBubble);
async function openAssistant(draft?:string):Promise<void>{
  setPanelOpen(false);
  if(isTauriRuntime()){
    await invoke("assistant_view",{open:true});
    if(!await runtimeClient.ensureRuntime())throw new Error(uiText.runtimeUnavailable);
  }
  await assistantPanel.open(draft);
  for(const node of [status,petButton,controls,panel])node.inert=true;
}
panel.append(Object.assign(document.createElement("button"),{type:"button",textContent:assistantText.openAssistant,onclick:()=>void openAssistant().catch(()=>showBubble(uiText.runtimeUnavailable))}));
window.addEventListener("pagehide",()=>assistantPanel.dispose(),{once:true});
if(isTauriRuntime()){
  void listen("maneki://assistant-open",()=>void openAssistant().catch(()=>showBubble(uiText.runtimeUnavailable)));
  void invoke<boolean>("assistant_entry").then(open=>{if(open)void openAssistant().catch(()=>showBubble(uiText.runtimeUnavailable));});
}

const player = new PetPlayer(playerRoot, () => {
  delete status.dataset.playbackRestricted;
  status.textContent = uiText.playbackFallback;
  status.dataset.visible = "true";
}, () => {
  status.dataset.playbackRestricted = "true";
  status.textContent = uiText.playbackRestricted;
  status.dataset.visible = "true";
}, () => {
  if (status.dataset.playbackRestricted !== "true") return;
  delete status.dataset.playbackRestricted;
  if (status.textContent !== uiText.playbackRestricted) return;
  status.textContent = uiText.playbackRecovered;
  window.setTimeout(() => {
    if (status.textContent === uiText.playbackRecovered) status.dataset.visible = "false";
  }, 4000);
});
window.addEventListener("pagehide", () => player.dispose(), { once: true });
const packs = new Map<string, ValidatedPetPack>();
const dragHandle = isTauriRuntime() ? attachWindowDrag(petButton) : undefined;

let hovered = false;
let hideControlsTimer: number | undefined;
let showControlsTimer: number | undefined;
let forceControls = false;
const refreshControls = (): void => {
  clearTimeout(hideControlsTimer);
  const active = document.activeElement;
  const editing = document.hasFocus() && (active === messageInput || (active instanceof HTMLElement && app.contains(active) && active.matches(":focus-visible")));
  if (hovered || editing || !panel.hidden || forceControls) app.dataset.controlsVisible = "true";
  else hideControlsTimer = window.setTimeout(() => { app.dataset.controlsVisible = "false"; }, 1000);
};
const setPanelOpen = (open: boolean): void => {
  panel.hidden = !open;
  settingsButton.setAttribute("aria-expanded", String(open));
  refreshControls();
};
const showControls = (): void => {
  clearTimeout(showControlsTimer);
  forceControls = true;
  refreshControls();
  showControlsTimer = window.setTimeout(() => { forceControls = false; refreshControls(); }, 2000);
};
let nativeHover = isTauriRuntime();
const observeDomHover = (): void => {
  if (nativeHover) return;
  hovered = petButton.matches(":hover") || controls.matches(":hover") || (!panel.hidden && panel.matches(":hover"));
  refreshControls();
};
for (const element of [petButton, controls, panel]) {
  element.addEventListener("pointerenter", observeDomHover);
  element.addEventListener("pointerleave", observeDomHover);
}
app.addEventListener("focusin", refreshControls);
app.addEventListener("focusout", () => queueMicrotask(refreshControls));
window.addEventListener("focus", refreshControls);
window.addEventListener("blur", () => { setPanelOpen(false); refreshControls(); });
app.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setPanelOpen(false);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }
});
textForm.addEventListener("submit", (event) => {event.preventDefault();void openAssistant(messageInput.value).then(()=>{messageInput.value="";}).catch(()=>showBubble(uiText.runtimeUnavailable));});
voiceButton.addEventListener("click", () => {void openAssistant().then(()=>assistantPanel.focusVoice()).catch(()=>showBubble(uiText.runtimeUnavailable));});
if (isTauriRuntime()) {
  let pageClosed = false;
  let stopInteraction: (() => void) | undefined;
  window.addEventListener("pagehide", () => {
    pageClosed = true;
    stopInteraction?.();
    clearTimeout(hideControlsTimer);
    clearTimeout(showControlsTimer);
    dragHandle?.detach();
  }, { once: true });
  void attachPetInteraction(petButton, () => !assistantHost.hidden ? [assistantHost] : app.dataset.controlsVisible === "true" ? [controls, ...(!panel.hidden ? [panel] : [])] : [],
    (hover) => {
      nativeHover = !hover.unavailable;
      const next = hover.overPet || hover.overControls;
      if (hovered !== next) {
        hovered = next;
        refreshControls();
      }
    }, showControls, () => { nativeHover = false; showBubble(uiText.interactionUnavailable); showControls(); },
  ).then((stop) => { if (pageClosed) stop(); else stopInteraction = stop; }).catch(() => { nativeHover = false; showControls(); showBubble(uiText.interactionUnavailable); });
}

settingsButton.addEventListener("click", () => {
  setPanelOpen(panel.hidden);
});
petButton.addEventListener("click", () => {
  if (dragHandle?.consumeRecentDrag()) return;
  player.playAction("wave");
});
stateSelect.addEventListener("change", () => {
  player.setState(stateSelect.value as PetState);
});
playActionButton.addEventListener("click", () => {
  if (!actionSelect.disabled) player.playAction(actionSelect.value);
});

function updateActions(pack: PetPack): void {
  actionSelect.replaceChildren();
  for (const action of pack.actions) {
    const option = document.createElement("option");
    option.value = action.id;
    option.textContent = Object.hasOwn(uiText.actions, action.id) ? uiText.actions[action.id]! : action.id;
    actionSelect.append(option);
  }
  const empty = pack.actions.length === 0;
  if (empty) {
    const option = document.createElement("option");
    option.textContent = uiText.noActions;
    actionSelect.append(option);
  }
  actionSelect.disabled = empty;
  playActionButton.disabled = empty;
}

packSelect.addEventListener("change", () => {
  const pack = packs.get(packSelect.value);
  if (!pack) return;
  player.loadPack(pack.pack, packSelect.value);
  updateActions(pack.pack);
  stateSelect.value = "idle";
  localStorage.setItem("maneki.selectedPack", packSelect.value);
});

function boundedMessage(error: unknown): string {
  return error instanceof BoundedReadError && error.reason === "limit"
    ? uiText.integrityFailure
    : uiText.loadFailure;
}

async function fetchJson(url: string): Promise<unknown> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(MEDIA_READ_TIMEOUT_MS) });
    const bytes = await readBounded(response, 1024 * 1024);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new Error(boundedMessage(error));
  }
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function validateMedia(pack: PetPack, path: string, bytes: ArrayBuffer): Promise<void> {
  const source = Object.values(pack.clips)
    .flatMap((clip) => clip.sources)
    .find((item) => item.path === path);
  if (!source) throw new Error(uiText.mediaFailure);
  const blob = new Blob([bytes], { type: source.mimeType });
  if (source.renderer === "spritesheet") {
    const dimensions = imageDimensions(bytes, source.mimeType);
    if (!dimensions || dimensions.width < 1 || dimensions.height < 1) throw new Error(uiText.mediaFailure);
    if (!withinPixelBudget(dimensions.width, dimensions.height)) throw new MediaBudgetError();
    const bitmap = await createImageBitmap(blob);
    const valid =
      bitmap.width === source.frameWidth * source.frameCount &&
      bitmap.height === source.frameHeight;
    bitmap.close();
    if (!valid) throw new Error(uiText.mediaFailure);
    return;
  }
  const probe = document.createElement("video");
  if (probe.canPlayType(source.mimeType) === "") return;
  const url = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (failed: boolean, overBudget = false) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        probe.onloadedmetadata = null;
        probe.onerror = null;
        if (failed) reject(overBudget ? new MediaBudgetError() : new Error(uiText.mediaFailure));
        else resolve();
      };
      const timeout = window.setTimeout(() => finish(true), 5000);
      probe.preload = "metadata";
      probe.muted = true;
      probe.onloadedmetadata = () => {
        if (probe.videoWidth > 0 && probe.videoHeight > 0 && !withinPixelBudget(probe.videoWidth, probe.videoHeight)) {
          finish(true, true);
          return;
        }
        finish(
          !(
            withinPixelBudget(probe.videoWidth, probe.videoHeight) &&
            Number.isFinite(probe.duration) &&
            probe.duration > 0
          ),
        );
      };
      probe.onerror = () => finish(true);
      probe.src = url;
    });
  } finally {
    probe.removeAttribute("src");
    probe.load();
    URL.revokeObjectURL(url);
  }
}

async function verifyAssets({ pack, manifest }: ValidatedPetPack, packId: string): Promise<void> {
  for (const entry of manifest.files) {
    let bytes: ArrayBuffer;
    try {
      bytes = await readMedia(`/packs/${packId}/${entry.path}`, entry.bytes);
    } catch (error) {
      throw new Error(boundedMessage(error));
    }
    if (bytes.byteLength !== entry.bytes || (await sha256(bytes)) !== entry.sha256) {
      throw new Error(uiText.integrityFailure);
    }
    await validateMedia(pack, entry.path, bytes).catch((error: unknown) => {
      throw new Error(error instanceof MediaBudgetError ? uiText.mediaBudget : uiText.mediaFailure);
    });
  }
}

async function loadPack(packId: string): Promise<ValidatedPetPack> {
  const [pack, manifest] = await Promise.all([
    fetchJson(`/packs/${packId}/pet-pack.json`),
    fetchJson(`/packs/${packId}/assets.manifest.json`),
  ]);
  const result = validatePetPack(pack, manifest);
  if (!result.success) throw new Error(uiText.invalidPack);
  await verifyAssets(result.value, packId);
  return result.value;
}

async function start(): Promise<void> {
  try {
    const errors: unknown[] = [];
    const saved = localStorage.getItem("maneki.selectedPack");
    const ordered = saved && packIds.includes(saved) ? [saved, ...packIds.filter((id) => id !== saved)] : packIds;
    for (const id of ordered) {
      let pack: ValidatedPetPack;
      try { pack = await loadPack(id); }
      catch (error) { errors.push(error); continue; }
      packs.set(id, pack);
      const option = document.createElement("option");
      option.value = id;
      option.textContent = pack.pack.name;
      packSelect.append(option);
      if (packs.size === 1) {
        packSelect.value = id;
        packSelect.disabled = false;
        player.loadPack(pack.pack, id);
        updateActions(pack.pack);
        status.dataset.visible = "false";
      }
    }
    if (packs.size === 0) throw errors[0] ?? new Error(uiText.loadFailure);
    if (errors.length > 0) {
      const error = errors[0];
      status.textContent = error instanceof Error ? error.message : uiText.loadFailure;
      status.dataset.visible = "true";
    }
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : uiText.loadFailure;
    status.dataset.visible = "true";
  }
}

function showBubble(text: string): void {
  status.textContent = text;
  status.dataset.visible = "true";
  window.setTimeout(() => {
    status.dataset.visible = "false";
  }, 4_000);
}

async function refreshRuntimePanel(token: string): Promise<void> {
  try {
    const limits = await runtimeClient.getLimits(token);
    runtimeLimitsLine.textContent =
      `${uiText.limitsLabel}：${limits.proactive.remaining}/${limits.proactive.limit}` +
      ` · ${uiText.notificationsLabel}：${limits.notifications.usedThisHour}/${limits.notifications.maxPerHour}`;
    const dnd = await runtimeClient.getDnd(token);
    runtimeDndLine.textContent = `${uiText.dndStateLabel}：${dnd ? uiText.dndOn : uiText.dndOff}`;
  } catch {
    // 刷新失败保持上次内容，连接状态由事件流回调维护。
  }
}

async function connectRuntime(): Promise<void> {
  if (!isTauriRuntime()) {
    runtimeSectionLabel.remove();
    runtimeStateLine.remove();
    runtimeLimitsLine.remove();
    runtimeDndLine.remove();
    return;
  }
  let ready: boolean;
  try {
    ready = await runtimeClient.ensureRuntime();
  } catch (error) {
    runtimeStateLine.textContent = String(error);
    return;
  }
  if (!ready) {
    runtimeStateLine.textContent = uiText.runtimeUnavailable;
    return;
  }
  let token: string;
  try {
    token = await runtimeClient.pairIfNeeded();
  } catch (error) {
    runtimeStateLine.textContent = `${uiText.runtimePairFailure}：${String(error)}`;
    return;
  }
  runtimeStateLine.textContent = uiText.runtimeConnected;
  void assistantPanel.reuse();
  try {
    const dnd = await runtimeClient.getDnd(token);
    await invoke("sync_tray_dnd", { enabled: dnd });
    runtimeDndLine.textContent = `${uiText.dndStateLabel}：${dnd ? uiText.dndOn : uiText.dndOff}`;
  } catch {
    // 托盘对齐失败不阻塞连接。
  }
  await runtimeClient.watchTrayDnd(token, () => {
    runtimeStateLine.textContent = uiText.dndSyncFailure;
  });
  await refreshRuntimePanel(token);
  settingsButton.addEventListener("click", () => {
    void refreshRuntimePanel(token);
  });
  let stateRevision = 0;
  const applyExpressionState = (state: unknown): void => {
    if (typeof state === "string" && petStates.includes(state as PetState)) {
      player.setState(state as PetState);
      stateSelect.value = state;
    }
  };
  await runtimeClient.connectEvents(
    token,
    (event) => {
      if (event.kind === "expression.state") {
        stateRevision += 1;
        applyExpressionState(event.payload.state);
        return;
      }
      if (event.kind === "expression.say") {
        if (typeof event.payload.text === "string") showBubble(event.payload.text);
        return;
      }
      if (event.kind === "expression.play") {
        if (typeof event.payload.action === "string") player.playAction(event.payload.action);
        return;
      }
      if (event.kind === "notification.sent") {
        const title = String(event.payload.title ?? "");
        const body = String(event.payload.body ?? "");
        showBubble(`${title}：${body}`);
        void refreshRuntimePanel(token);
        return;
      }
      if (event.kind === "dnd.changed") {
        if (typeof event.payload.enabled === "boolean") {
          void runtimeClient.syncRuntimeDnd(event.payload.enabled).catch(() => {
            runtimeStateLine.textContent = uiText.dndSyncFailure;
          });
        }
        void refreshRuntimePanel(token);
        return;
      }
      if (event.kind === "runtime.ready") {
        runtimeStateLine.textContent = uiText.runtimeConnected;
      }
    },
    (connected) => {
      runtimeStateLine.textContent = connected ? uiText.runtimeConnected : uiText.runtimeDisconnected;
      stateRevision += 1;
      if (connected) {
        const revision = stateRevision;
        void runtimeClient.getExpressionState(token).then((state) => {
          // 订阅先就绪；快照请求期间的新事件优先，断线的旧请求也不能覆盖新连接。
          if (stateRevision === revision) applyExpressionState(state);
        }).catch(() => undefined);
      }
    },
  );
}

void start();
void connectRuntime();
