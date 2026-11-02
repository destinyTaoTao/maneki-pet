import {
  petStates,
  validatePetPack,
  type PetPack,
  type PetState,
  type ValidatedPetPack,
} from "@maneki-pet/core";

import { invoke } from "@tauri-apps/api/core";
import { PetPlayer } from "./player.js";
import { BoundedReadError, MEDIA_READ_TIMEOUT_MS, readBounded, readMedia } from "./bounded-fetch.js";
import { imageDimensions, MediaBudgetError, withinPixelBudget } from "./media-budget.js";
import { attachWindowDrag, isTauriRuntime } from "./window-drag.js";
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

const settingsButton = document.createElement("button");
settingsButton.className = "settings-button";
settingsButton.type = "button";
settingsButton.textContent = uiText.settings;
settingsButton.setAttribute("aria-label", uiText.settings);

const panel = document.createElement("section");
panel.className = "settings-panel";
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
const runtimeSectionLabel = document.createElement("label");
runtimeSectionLabel.textContent = uiText.runtimeSection;
const runtimeStateLine = document.createElement("div");
runtimeStateLine.className = "runtime-line";
runtimeStateLine.textContent = uiText.runtimeConnecting;
const runtimeLimitsLine = document.createElement("div");
runtimeLimitsLine.className = "runtime-line";
const runtimeDndLine = document.createElement("div");
runtimeDndLine.className = "runtime-line";
panel.append(packLabel, stateLabel, runtimeSectionLabel, runtimeStateLine, runtimeLimitsLine, runtimeDndLine);
app.append(status, petButton, settingsButton, panel);

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

settingsButton.addEventListener("click", () => {
  panel.hidden = !panel.hidden;
  settingsButton.textContent = panel.hidden ? uiText.settings : uiText.closeSettings;
});
petButton.addEventListener("click", () => {
  if (dragHandle?.consumeRecentDrag()) return;
  player.playAction("wave");
});
stateSelect.addEventListener("change", () => {
  player.setState(stateSelect.value as PetState);
});
packSelect.addEventListener("change", () => {
  const pack = packs.get(packSelect.value);
  if (!pack) return;
  player.loadPack(pack.pack, packSelect.value);
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
  const ready = await runtimeClient.ensureRuntime();
  if (!ready) {
    runtimeStateLine.textContent = uiText.runtimeUnavailable;
    return;
  }
  let token: string;
  try {
    token = await runtimeClient.pairIfNeeded();
  } catch {
    runtimeStateLine.textContent = uiText.runtimePairFailure;
    return;
  }
  runtimeStateLine.textContent = uiText.runtimeConnected;
  try {
    const dnd = await runtimeClient.getDnd(token);
    await invoke("sync_tray_dnd", { enabled: dnd });
    runtimeDndLine.textContent = `${uiText.dndStateLabel}：${dnd ? uiText.dndOn : uiText.dndOff}`;
  } catch {
    // 托盘对齐失败不阻塞连接。
  }
  await runtimeClient.watchTrayDnd(token);
  await refreshRuntimePanel(token);
  settingsButton.addEventListener("click", () => {
    void refreshRuntimePanel(token);
  });
  await runtimeClient.connectEvents(
    token,
    (event) => {
      if (event.kind === "notification.sent") {
        const title = String(event.payload.title ?? "");
        const body = String(event.payload.body ?? "");
        showBubble(`${title}：${body}`);
        void refreshRuntimePanel(token);
        return;
      }
      if (event.kind === "dnd.changed") {
        void refreshRuntimePanel(token);
        return;
      }
      if (event.kind === "runtime.ready") {
        runtimeStateLine.textContent = uiText.runtimeConnected;
      }
    },
    (connected) => {
      runtimeStateLine.textContent = connected ? uiText.runtimeConnected : uiText.runtimeDisconnected;
    },
  );
}

void start();
void connectRuntime();
