import {
  petStates,
  validatePetPack,
  type PetPack,
  type PetState,
  type ValidatedPetPack,
} from "@maneki-pet/core";

import { PetPlayer } from "./player.js";
import { BoundedReadError, readBounded } from "./bounded-fetch.js";
import { attachWindowDrag, isTauriRuntime } from "./window-drag.js";
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
panel.append(packLabel, stateLabel);
app.append(status, petButton, settingsButton, panel);

const player = new PetPlayer(playerRoot, () => {
  status.textContent = uiText.playbackFallback;
  status.dataset.visible = "true";
});
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
  const response = await fetch(url);
  try {
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
      const finish = (failed: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        probe.onloadedmetadata = null;
        probe.onerror = null;
        if (failed) reject(new Error(uiText.mediaFailure));
        else resolve();
      };
      const timeout = window.setTimeout(() => finish(true), 5000);
      probe.preload = "metadata";
      probe.muted = true;
      probe.onloadedmetadata = () => {
        finish(
          !(
            probe.videoWidth > 0 &&
            probe.videoHeight > 0 &&
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
    const response = await fetch(`/packs/${packId}/${entry.path}`);
    let bytes: ArrayBuffer;
    try {
      bytes = await readBounded(response, entry.bytes);
    } catch (error) {
      throw new Error(boundedMessage(error));
    }
    if (bytes.byteLength !== entry.bytes || (await sha256(bytes)) !== entry.sha256) {
      throw new Error(uiText.integrityFailure);
    }
    await validateMedia(pack, entry.path, bytes).catch(() => {
      throw new Error(uiText.mediaFailure);
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
    const results = await Promise.allSettled(packIds.map((id) => loadPack(id)));
    const errors: unknown[] = [];
    results.forEach((result, index) => {
      const id = packIds[index]!;
      if (result.status === "rejected") {
        errors.push(result.reason);
        return;
      }
      const pack = result.value;
      packs.set(id, pack);
      const option = document.createElement("option");
      option.value = id;
      option.textContent = pack.pack.name;
      packSelect.append(option);
    });
    if (packs.size === 0) throw errors[0] ?? new Error(uiText.loadFailure);
    const saved = localStorage.getItem("maneki.selectedPack");
    const selected =
      saved && packs.has(saved) ? saved : packIds.find((id) => packs.has(id))!;
    packSelect.value = selected;
    packSelect.disabled = false;
    player.loadPack(packs.get(selected)!.pack, selected);
    if (errors.length > 0) {
      const error = errors[0];
      status.textContent = error instanceof Error ? error.message : uiText.loadFailure;
      status.dataset.visible = "true";
    } else {
      status.dataset.visible = "false";
    }
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : uiText.loadFailure;
    status.dataset.visible = "true";
  }
}

void start();
