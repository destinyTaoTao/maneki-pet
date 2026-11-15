import { CompanionPowerGuard } from "./companion-power.js";
import {
  petStates,
  validatePetPack,
  type PetPack,
  type PetState,
  type ValidatedPetPack,
} from "@maneki-pet/core";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createAssistantPanel, petVariantForPack } from "./assistant-panel.js";
import { assistantText } from "./assistant-text.js";
import { AssistantClientError } from "./assistant-client.js";
import { PetPlayer } from "./player.js";
import { VoicePetCoordinator } from "./voice-pet.js";
import { CompanionClient } from "./companion-client.js";
import { bindCompanionInputFocus, CompanionPresence } from "./companion-presence.js";
import { CompanionBubble } from "./companion-bubble.js";
import { BoundedReadError, MEDIA_READ_TIMEOUT_MS, readBounded, readMedia } from "./bounded-fetch.js";
import { imageDimensions, MediaBudgetError, withinPixelBudget } from "./media-budget.js";
import { attachWindowDrag, isTauriRuntime } from "./window-drag.js";
import { attachPetInteraction } from "./pet-interaction.js";
import * as runtimeClient from "./runtime-client.js";
import { uiText } from "./ui-text.js";
import "./style.css";
import packIds from "../config/builtin-packs.json" with { type: "json" };
import optionalPackIds from "../config/optional-packs.json" with { type: "json" };

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
const packGallery = document.createElement("div");
packGallery.className = "pack-gallery";
packGallery.setAttribute("aria-label", uiText.packLabel);
const packCards = new Map<string, HTMLButtonElement>();
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
panel.append(packGallery, stateLabel, actionLabel, playActionButton, runtimeSectionLabel, runtimeStateLine, runtimeLimitsLine, runtimeDndLine);
app.append(status, petButton, controls, panel);
const assistantHost=document.createElement("section");
assistantHost.className="assistant-panel";
assistantHost.hidden=true;
assistantHost.setAttribute("aria-label",assistantText.title);
const listeningAvatar = document.createElement("div");
listeningAvatar.className = "assistant-listening-avatar";
listeningAvatar.hidden = true;
assistantHost.append(listeningAvatar);
app.append(assistantHost);
const quickMenu=document.createElement("aside");
quickMenu.className="pet-quick-menu";
quickMenu.hidden=true;
quickMenu.setAttribute("aria-label",uiText.quickSettings);
const quickCaption=document.createElement("span");
quickCaption.className="quick-caption";
quickCaption.textContent=uiText.quickSettings;
const quickDndLabel=document.createElement("label");
quickDndLabel.className="quick-dnd";
quickDndLabel.append(document.createTextNode(uiText.dndLabel));
const quickDnd=document.createElement("input");
quickDnd.type="checkbox";
quickDnd.className="quick-switch";
quickDnd.disabled=true;
quickDndLabel.append(quickDnd);
const quickVoice=Object.assign(document.createElement("button"),{type:"button",textContent:uiText.quickVoice});
const quickAppearance=Object.assign(document.createElement("button"),{type:"button",textContent:uiText.quickAppearance});
const quickAll=Object.assign(document.createElement("button"),{type:"button",textContent:uiText.quickAll,className:"quick-all"});
quickMenu.append(quickCaption,quickDndLabel,quickVoice,quickAppearance,quickAll);
assistantHost.append(quickMenu);
let runtimeToken: string | undefined;
let companionClient:CompanionClient|undefined;
let companionPresence:CompanionPresence|undefined;
let companionBubble:CompanionBubble|undefined;
let nativeVisible=false;
let visibilityGeneration=0;
const companionPower = new CompanionPowerGuard(
  () => invoke<number>("companion_power_generation"),
  () => companionPresence?.resume(),
);
async function refreshCompanionVisibility():Promise<boolean> {
  const generation=++visibilityGeneration;
  let visible=false;
  try { visible=!document.hidden && (isTauriRuntime()?await companionPower.checkVisible(()=>invoke<boolean>("companion_window_visible"),()=>!document.hidden):true); } catch { visible=false; }
  if(generation===visibilityGeneration){nativeVisible=visible;companionPresence?.setVisible(visible);}
  return generation===visibilityGeneration&&visible;
}
const setQuickOpen=(open:boolean):void=>{quickMenu.hidden=!open;};
const assistantPanel=createAssistantPanel(assistantHost,()=>{
  assistantPanel.close();
  companionPresence?.setBusy("panel",false);
  setQuickOpen(false);
  app.dataset.assistantOpen="false";
  settingsButton.setAttribute("aria-expanded","false");
  for(const node of [status,petButton,controls,panel])node.inert=false;
  if(isTauriRuntime())void invoke("assistant_view",{open:false}).catch(()=>showBubble(uiText.interactionUnavailable));
},showBubble, (phase) => { voicePet.voiceChanged(phase); companionPresence?.setBusy("voice",phase!=="idle"); },panel,{
  onReady:(ready)=>void companionClient?.connected(ready),
  onDisconnected:()=>companionClient?.disconnected(),
  onEvent:(event)=>{
    if(event.kind==="assistant.companion")void refreshCompanionVisibility().then(visible=>{if(visible)companionClient?.onEvent(event);});
    else companionClient?.onEvent(event);
  },
});
type AssistantTarget = "settings" | "appearance" | "voice";
async function openAssistant(draft?:string,target?:AssistantTarget,quick=false):Promise<void>{
  setQuickOpen(false);
  if(isTauriRuntime()){
    await invoke("assistant_view",{open:true});
    if(!await runtimeClient.ensureRuntime())throw new Error(uiText.runtimeUnavailable);
  }
  companionPresence?.setBusy("panel",true);
  // 设置/形象仅切换视图；首次个人数据授权由明确打开助手的入口触发。
  await assistantPanel.open(draft,target===undefined&&!quick);
  app!.dataset.assistantOpen="true";
  status.inert=true;
  controls.inert=true;
  petButton.inert=false;
  panel.inert=false;
  if(target==="appearance")assistantPanel.show("appearance");
  else if(target==="voice")assistantPanel.show("settings","voice");
  else if(target==="settings")assistantPanel.show("settings");
  settingsButton.setAttribute("aria-expanded",String(target==="appearance"));
  if(quick)setQuickOpen(true);
}
quickDnd.addEventListener("change",()=>{
  const enabled=quickDnd.checked;
  if(!runtimeToken){quickDnd.checked=!enabled;return;}
  const token=runtimeToken;
  quickDnd.disabled=true;
  void (async()=>{
    try{
      await runtimeClient.setDnd(token,enabled);
      voicePet.setDnd(enabled);
      runtimeDndLine.textContent=`${uiText.dndStateLabel}：${enabled?uiText.dndOn:uiText.dndOff}`;
      await runtimeClient.syncRuntimeDnd(enabled).catch(()=>undefined);
    }catch{
      quickDnd.checked=!enabled;
      showBubble(uiText.dndSyncFailure);
    }finally{quickDnd.disabled=false;}
  })();
});
quickVoice.addEventListener("click",()=>{assistantPanel.show("settings","voice");setQuickOpen(false);});
quickAppearance.addEventListener("click",()=>{assistantPanel.show("appearance");setQuickOpen(false);});
quickAll.addEventListener("click",()=>{assistantPanel.show("settings");setQuickOpen(false);});
document.addEventListener("pointerdown",(event)=>{
  if(quickMenu.hidden||!(event.target instanceof Node))return;
  if(!quickMenu.contains(event.target)&&!petButton.contains(event.target))setQuickOpen(false);
});
panel.append(Object.assign(document.createElement("button"),{type:"button",textContent:assistantText.openAssistant,onclick:()=>void openAssistant().then(()=>assistantPanel.show("chat")).catch(()=>showBubble(uiText.runtimeUnavailable))}));
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
const voicePet = new VoicePetCoordinator({
  showListening: (listening) => {
    listeningAvatar.hidden = !listening;
    if (listening) listeningAvatar.append(playerRoot);
    else petButton.append(playerRoot);
  },
  setState: (state) => player.setState(state),
  playAction: (action) => player.playAction(action),
});
window.addEventListener("pagehide", () => player.dispose(), { once: true });
companionBubble=new CompanionBubble({
  render:(value)=>{
    status.replaceChildren();status.dataset.visible=value?"true":"false";status.inert=!assistantHost.hidden&&!value?.utterance;
    companionPresence?.setBusy("important",value?.mode==="important");
    if(!value){delete status.dataset.interactive;return;}
    const text=document.createElement("span");text.textContent=value.text;status.append(text);
    if(value.utterance){
      status.dataset.interactive="true";
      const reply=document.createElement("button");reply.type="button";reply.textContent=assistantText.companionReply;
      reply.addEventListener("click",()=>{const utterance=value.utterance!;companionBubble?.dismiss(value.utteranceId);void openAssistant().then(()=>assistantPanel.openWithCompanionReply(utterance)).catch(()=>showBubble(assistantText.companionUnavailable));});
      const close=document.createElement("button");close.type="button";close.textContent=assistantText.companionClose;close.addEventListener("click",()=>companionBubble?.dismiss(value.utteranceId));status.append(reply,close);
    } else delete status.dataset.interactive;
  },
  playAction:(id)=>voicePet.playAction(id),restoreLatest:()=>voicePet.restoreLatest(),
});
companionClient=new CompanionClient({
  call:(path,body)=>assistantPanel.companionCall(path,body),
  beforeShow:()=>refreshCompanionVisibility(),
  show:(utterance)=>nativeVisible?companionBubble!.show(utterance):false,
  reconnect:()=>assistantPanel.reconnectCompanion(),wallNow:Date.now,monoNow:()=>performance.now(),
  onDropAutomatic:()=>companionBubble?.dropAutomatic(),
  onPolicy:(policy)=>assistantPanel.setCompanionAvailability(policy.healthy?null:assistantText.companionUnavailable),
  onUnavailable:()=>assistantPanel.setCompanionAvailability(assistantText.companionUnavailable),
});
companionPresence=new CompanionPresence(state=>{companionClient?.setDisplayState(state);companionBubble?.setUserBusy(state.busyReasons.some(reason=>reason!=="important"));},()=>companionClient?.invalidate());
const visibilityTimer=setInterval(()=>{companionClient?.checkClock();void refreshCompanionVisibility();},2000);
document.addEventListener("visibilitychange",()=>{if(document.hidden){nativeVisible=false;companionPresence?.setVisible(false);companionPresence?.resume();}else{companionPresence?.resume();void refreshCompanionVisibility();}});
window.addEventListener("pageshow",()=>{companionPresence?.resume();void refreshCompanionVisibility();});
window.addEventListener("pagehide",()=>{clearInterval(visibilityTimer);companionPresence?.dispose();companionClient?.dispose();companionBubble?.dispose();},{once:true});
void refreshCompanionVisibility();
app.addEventListener("pointerdown",()=>companionPresence?.noteInteraction());
app.addEventListener("keydown",()=>companionPresence?.noteInteraction());
const stopCompanionInputFocus=bindCompanionInputFocus(app,document,window,value=>companionPresence?.setBusy("input",value));
window.addEventListener("pagehide",stopCompanionInputFocus,{once:true});
petButton.addEventListener("pointerdown",()=>companionPresence?.setBusy("drag",true));
for(const event of ["pointerup","pointercancel","lostpointercapture"] as const)window.addEventListener(event,()=>companionPresence?.setBusy("drag",false));
const companionSay=Object.assign(document.createElement("button"),{type:"button",textContent:assistantText.companionSay});
companionSay.addEventListener("click",()=>{void (async()=>{try{if(!companionClient?.isReady()){await openAssistant();assistantPanel.reconnectCompanion();showFeedback(assistantText.companionReconnect);return;}await refreshCompanionVisibility();await companionClient.say();}catch(error){showFeedback(error instanceof AssistantClientError&&error.code==="companion_display_not_shown"?assistantText.companionNotShown:assistantText.companionUnavailable);}})();});
const companionSnooze=Object.assign(document.createElement("button"),{type:"button",textContent:assistantText.companionSnooze});
companionSnooze.addEventListener("click",()=>void assistantPanel.snoozeCompanion().catch(()=>showFeedback(assistantText.companionUnavailable)));
const companionDisable=Object.assign(document.createElement("button"),{type:"button",textContent:assistantText.companionDisable});
companionDisable.addEventListener("click",()=>void assistantPanel.setCompanionEnabled(false).catch(()=>showFeedback(assistantText.companionUnavailable)));
quickMenu.append(companionSay,companionSnooze,companionDisable);
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
window.addEventListener("blur", () => { setQuickOpen(false); refreshControls(); });
app.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setQuickOpen(false);
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
  void attachPetInteraction(petButton, () => {
    if (!assistantHost.hidden) {
      const regions: HTMLElement[] = [];
      const drawer = assistantHost.querySelector<HTMLElement>(".assistant-drawer");
      if (drawer) regions.push(drawer);
      if (status.dataset.interactive === "true") regions.push(status);
      if (!quickMenu.hidden) regions.push(quickMenu);
      return regions;
    }
    const regions:HTMLElement[] = app.dataset.controlsVisible === "true" ? [controls] : [];
    if(status.dataset.interactive === "true") regions.push(status);
    return regions;
  },
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
  void openAssistant(undefined,"appearance").catch(()=>showBubble(uiText.runtimeUnavailable));
});
petButton.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  void openAssistant(undefined,"settings",true).catch(()=>showBubble(uiText.runtimeUnavailable));
});
petButton.addEventListener("click", () => {
  if (dragHandle?.consumeRecentDrag()) return;
  setQuickOpen(false);
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

function updatePackCards(selected: string): void {
  for (const [id, card] of packCards) card.setAttribute("aria-pressed", String(id === selected));
}

function addPackCard(id: string, pack: ValidatedPetPack): void {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "pack-card";
  card.dataset.variant = petVariantForPack(id);
  card.title = pack.pack.name;
  card.setAttribute("aria-label", pack.pack.name);
  const variant = petVariantForPack(id);
  if (variant === "custom") {
    const placeholder = document.createElement("span");
    placeholder.className = "pack-card-placeholder";
    placeholder.textContent = pack.pack.name.slice(0, 1);
    card.append(placeholder);
  } else {
    const image = document.createElement("img");
    image.src = `/variants/${variant}.png`;
    image.alt = "";
    image.draggable = false;
    card.append(image);
  }
  const name = document.createElement("span");
  name.textContent = pack.pack.name.replace("小招 · ", "");
  card.append(name);
  card.addEventListener("click", () => {
    if (packSelect.value === id) return;
    packSelect.value = id;
    packSelect.dispatchEvent(new Event("change"));
  });
  packCards.set(id, card);
  packGallery.append(card);
  updatePackCards(packSelect.value);
}

packSelect.addEventListener("change", () => {
  const pack = packs.get(packSelect.value);
  if (!pack) return;
  player.loadPack(pack.pack, packSelect.value);
  assistantPanel.setPetAppearance(packSelect.value);
  updatePackCards(packSelect.value);
  updateActions(pack.pack);
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
      catch (error) { if (optionalPackIds.includes(id)) continue; errors.push(error); continue; }
      packs.set(id, pack);
      const option = document.createElement("option");
      option.value = id;
      option.textContent = pack.pack.name;
      packSelect.append(option);
      addPackCard(id, pack);
      if (packs.size === 1) {
        packSelect.value = id;
        packSelect.disabled = false;
        player.loadPack(pack.pack, id);
        assistantPanel.setPetAppearance(id);
        updatePackCards(id);
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

function showFeedback(text:string):void {
  if(companionBubble){companionBubble.showFeedback(crypto.randomUUID(),text);return;}
  showBubble(text);
}
function showBubble(text: string): void {
  if(companionBubble){companionBubble.showImportant(crypto.randomUUID(),text);return;}
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
    voicePet.setDnd(dnd);
    quickDnd.checked=dnd;
    quickDnd.disabled=false;
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
  runtimeToken=token;
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
  const applyExpressionState = (state: unknown, live = false): void => {
    if (typeof state === "string" && petStates.includes(state as PetState)) {
      voicePet.expressionChanged(state as PetState, live);
      stateSelect.value = state;
    }
  };
  await runtimeClient.connectEvents(
    token,
    (event) => {
      if (event.kind === "expression.state") {
        stateRevision += 1;
        applyExpressionState(event.payload.state, true);
        return;
      }
      if (event.kind === "expression.say") {
        if (typeof event.payload.text === "string") showBubble(event.payload.text);
        return;
      }
      if (event.kind === "expression.play") {
        if (typeof event.payload.action === "string") voicePet.playAction(event.payload.action);
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
          voicePet.setDnd(event.payload.enabled);
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
