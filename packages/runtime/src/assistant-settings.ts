import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  validTimeZone,
  defaultVoiceSettings,
  defaultBailianSettings,
  type VoiceSettings,
} from "@maneki-pet/core";
import { validateObject } from "./validate.js";
import type { AssistantStore } from "./assistant-store.js";

export class AssistantError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export interface AssistantSettings {
  schemaVersion: 1;
  version: number;
  timeZone: string;
  persona: string;
  cloudEnabled: boolean;
  voice: VoiceSettings;
  speechApiKeyRef?: string;
  chat: {
    enabled: boolean;
    locality: "local" | "cloud";
    baseUrl: string;
    model: string;
    maxInputTokens: number;
    maxOutputTokens: number;
    apiKeyRef?: string;
  };
}
export function defaultAssistantSettings(): AssistantSettings {
  return {
    voice: defaultVoiceSettings(),
    schemaVersion: 1,
    version: 0,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    persona: "你是小招，一位简洁、可靠的个人助理。",
    cloudEnabled: false,
    chat: {
      enabled: false,
      locality: "local",
      baseUrl: "",
      model: "",
      maxInputTokens: 4096,
      maxOutputTokens: 1024,
    },
  };
}
export function readAssistantSettings(
  store: AssistantStore,
): AssistantSettings {
  const raw = store.get("settings");
  if (raw === null) return defaultAssistantSettings();
  try {
    const value = JSON.parse(raw) as AssistantSettings;
    if (
      value.schemaVersion !== 1 ||
      !Number.isSafeInteger(value.version) ||
      value.version < 0 ||
      !validTimeZone(value.timeZone) ||
      typeof value.persona !== "string" ||
      value.persona.length > 500 ||
      typeof value.cloudEnabled !== "boolean" ||
      !value.chat ||
      typeof value.chat.enabled !== "boolean"
    )
      throw new Error();
    const { apiKeyRef, ...chat } = value.chat;
    checkedChat(chat);
    if (
      apiKeyRef !== undefined &&
      (typeof apiKeyRef !== "string" ||
        !/^assistant-key-[0-9a-f-]{36}$/.test(apiKeyRef))
    )
      throw new Error();
    value.voice = checkedVoice(value.voice ?? defaultVoiceSettings());
    if (
      value.speechApiKeyRef !== undefined &&
      !/^assistant-speech-key-[0-9a-f-]{36}$/.test(value.speechApiKeyRef)
    )
      throw new Error();
    return value;
  } catch {
    throw new AssistantError(503, "settings_invalid");
  }
}
export function settingsView(settings: AssistantSettings) {
  const { apiKeyRef: _secret, ...chat } = settings.chat;
  const { speechApiKeyRef, ...visible } = settings;
  return {
    ...visible,
    voice: { ...settings.voice, apiKeyConfigured: Boolean(speechApiKeyRef) },
    chat: { ...chat, apiKeyConfigured: Boolean(_secret) },
  };
}
export function readSpeechKey(
  dir: string,
  settings: AssistantSettings,
): string | undefined {
  const ref = settings.speechApiKeyRef;
  if (!ref) return undefined;
  if (!/^assistant-speech-key-[0-9a-f-]{36}$/.test(ref))
    throw new AssistantError(503, "key_unavailable");
  try {
    if (statSync(join(dir, ref)).size > 1000) throw new Error();
    const key = readFileSync(join(dir, ref), "utf8");
    if (!key.trim() || /[\r\n]/.test(key)) throw new Error();
    return key;
  } catch {
    throw new AssistantError(503, "key_unavailable");
  }
}
export function readChatKey(
  dir: string,
  settings: AssistantSettings,
): string | undefined {
  const ref = settings.chat.apiKeyRef;
  if (!ref) return undefined;
  if (!/^assistant-key-[0-9a-f-]{36}$/.test(ref))
    throw new AssistantError(503, "key_unavailable");
  try {
    if (statSync(join(dir, ref)).size > 1000) throw new Error();
    return readFileSync(join(dir, ref), "utf8");
  } catch {
    throw new AssistantError(503, "key_unavailable");
  }
}
function checkedChat(rawChat: unknown): AssistantSettings["chat"] {
  const chat = validateObject(rawChat, {
    enabled: { type: "boolean", required: true },
    locality: {
      type: "string",
      required: true,
      maxLength: 5,
      enumValues: ["local", "cloud"],
    },
    baseUrl: { type: "string", required: true, maxLength: 500 },
    model: { type: "string", required: true, maxLength: 120 },
    maxInputTokens: { type: "number", required: true, min: 512, max: 32768 },
    maxOutputTokens: { type: "number", required: true, min: 64, max: 4096 },
  });
  if (!chat.ok) throw new AssistantError(400, "settings_invalid");
  const selected = chat.value as AssistantSettings["chat"];
  if (
    ![selected.maxInputTokens, selected.maxOutputTokens].every(Number.isInteger)
  )
    throw new AssistantError(400, "settings_invalid");
  if (selected.enabled || selected.baseUrl) {
    let endpoint: URL;
    try {
      endpoint = new URL(selected.baseUrl);
    } catch {
      throw new AssistantError(400, "endpoint_invalid");
    }
    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !["http:", "https:"].includes(endpoint.protocol)
    )
      throw new AssistantError(400, "endpoint_invalid");
    if (
      selected.locality === "local" &&
      !["127.0.0.1", "[::1]"].includes(endpoint.hostname)
    )
      throw new AssistantError(400, "local_endpoint_required");
    if (selected.locality === "cloud" && endpoint.protocol !== "https:")
      throw new AssistantError(400, "https_required");
    if (selected.enabled && !selected.model.trim())
      throw new AssistantError(400, "model_required");
  }
  return selected;
}
export function saveAssistantSettings(
  store: AssistantStore,
  dir: string,
  raw: Record<string, unknown>,
): AssistantSettings {
  const { chat: rawChat, voice: rawVoice, ...flat } = raw;
  const checked = validateObject(flat, {
    version: { type: "number", required: true, min: 0 },
    timeZone: { type: "string", required: true, maxLength: 80 },
    persona: { type: "string", required: true, maxLength: 500 },
    cloudEnabled: { type: "boolean", required: true },
    apiKey: { type: "string", required: false, maxLength: 1000 },
    speechApiKey: { type: "string", required: false, maxLength: 1000 },
  });
  if (
    !checked.ok ||
    !validTimeZone(String(raw.timeZone)) ||
    [raw.apiKey, raw.speechApiKey].some(
      (key) => typeof key === "string" && /[\r\n]/.test(key),
    )
  )
    throw new AssistantError(400, "settings_invalid");
  const selected = checkedChat(rawChat);
  let old: AssistantSettings;
  try {
    old = readAssistantSettings(store);
  } catch {
    old = defaultAssistantSettings();
  }
  if (!Number.isSafeInteger(raw.version) || raw.version !== old.version)
    throw new AssistantError(409, "settings_conflict");
  const settings: AssistantSettings = {
    voice:
      rawVoice === undefined ? old.voice : checkedVoice(rawVoice, old.voice),
    schemaVersion: 1,
    version: old.version + 1,
    timeZone: raw.timeZone as string,
    persona: raw.persona as string,
    cloudEnabled: raw.cloudEnabled as boolean,
    chat: { ...selected },
  };
  let created: string | undefined, speechCreated: string | undefined;
  try {
    if (raw.apiKey !== undefined) {
      const key = String(raw.apiKey).trim();
      if (key) {
        created = `assistant-key-${randomUUID()}`;
        writeFileSync(join(dir, created), key, { mode: 0o600, flag: "wx" });
        settings.chat.apiKeyRef = created;
      }
    } else if (old.chat.apiKeyRef) settings.chat.apiKeyRef = old.chat.apiKeyRef;
    if (raw.speechApiKey !== undefined) {
      const key = String(raw.speechApiKey).trim();
      if (key) {
        speechCreated = `assistant-speech-key-${randomUUID()}`;
        writeFileSync(join(dir, speechCreated), key, {
          mode: 0o600,
          flag: "wx",
        });
        settings.speechApiKeyRef = speechCreated;
      }
    } else if (old.speechApiKeyRef)
      settings.speechApiKeyRef = old.speechApiKeyRef;
    store.transaction(() => {
      store.set("settings", JSON.stringify(settings));
      store.changed();
    });
  } catch (error) {
    if (created) rmSync(join(dir, created), { force: true });
    if (speechCreated) rmSync(join(dir, speechCreated), { force: true });
    throw error;
  }
  if (
    old.chat.apiKeyRef &&
    old.chat.apiKeyRef !== settings.chat.apiKeyRef &&
    /^assistant-key-[0-9a-f-]{36}$/.test(old.chat.apiKeyRef) &&
    existsSync(join(dir, old.chat.apiKeyRef))
  )
    rmSync(join(dir, old.chat.apiKeyRef), { force: true });
  if (
    old.speechApiKeyRef &&
    old.speechApiKeyRef !== settings.speechApiKeyRef &&
    /^assistant-speech-key-[0-9a-f-]{36}$/.test(old.speechApiKeyRef)
  )
    rmSync(join(dir, old.speechApiKeyRef), { force: true });
  return settings;
}
function checkedVoice(
  raw: unknown,
  old = defaultVoiceSettings(),
): VoiceSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new AssistantError(400, "voice_settings_invalid");
  const value = raw as Record<string, unknown>,
    { asr, tts, bailian, apiKeyConfigured, ...flat } = value;
  if (apiKeyConfigured !== undefined && typeof apiKeyConfigured !== "boolean")
    throw new AssistantError(400, "voice_settings_invalid");
  const checked = validateObject(flat, {
    microphoneEnabled: { type: "boolean", required: true },
  });
  const recognition = validateObject(asr, {
    provider: {
      type: "string",
      required: false,
      maxLength: 7,
      enumValues: ["local", "bailian"],
    },
    enabled: { type: "boolean", required: true },
    language: {
      type: "string",
      required: true,
      maxLength: 4,
      enumValues: ["zh", "en", "auto"],
    },
  });
  const synthesis = validateObject(tts, {
    provider: {
      type: "string",
      required: false,
      maxLength: 7,
      enumValues: ["local", "bailian"],
    },
    enabled: { type: "boolean", required: true },
    voiceId: { type: "string", required: true, maxLength: 150 },
  });
  if (!checked.ok || !recognition.ok || !synthesis.ok)
    throw new AssistantError(400, "voice_settings_invalid");
  let config = old.bailian;
  if (bailian !== undefined) {
    const online = validateObject(bailian, {
      workspaceId: { type: "string", required: true, maxLength: 64 },
      asrModel: { type: "string", required: true, maxLength: 120 },
      ttsModel: { type: "string", required: true, maxLength: 120 },
      voiceId: { type: "string", required: true, maxLength: 80 },
    });
    if (!online.ok) throw new AssistantError(400, "voice_settings_invalid");
    config = online.value as NonNullable<VoiceSettings["bailian"]>;
    if (
      !/^[A-Za-z0-9-]*$/.test(config.workspaceId) ||
      ![config.asrModel, config.ttsModel, config.voiceId].every((v) =>
        /^[A-Za-z0-9._-]+$/.test(v),
      )
    )
      throw new AssistantError(400, "voice_settings_invalid");
  }
  const asrProvider = recognition.value.provider ?? old.asr.provider;
  const ttsProvider = synthesis.value.provider ?? old.tts.provider;
  return {
    microphoneEnabled: checked.value.microphoneEnabled as boolean,
    asr: {
      ...recognition.value,
      ...(asrProvider ? { provider: asrProvider } : {}),
    } as VoiceSettings["asr"],
    tts: {
      ...synthesis.value,
      ...(ttsProvider ? { provider: ttsProvider } : {}),
    } as VoiceSettings["tts"],
    ...(config || asrProvider === "bailian" || ttsProvider === "bailian"
      ? { bailian: config ?? defaultBailianSettings() }
      : {}),
  };
}
