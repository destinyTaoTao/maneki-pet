import { invoke } from "@tauri-apps/api/core";
import type { PersonalTodo, PersonalReminder } from "@maneki-pet/core";
import { readBounded } from "./bounded-fetch.js";

export interface AssistantMessage {
  seq: number;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}
export interface AssistantSettingsView {
  schemaVersion: 1;
  version: number;
  timeZone: string;
  persona: string;
  cloudEnabled: boolean;
  chat: {
    enabled: boolean;
    locality: "local" | "cloud";
    baseUrl: string;
    model: string;
    maxInputTokens: number;
    maxOutputTokens: number;
    apiKeyConfigured: boolean;
  };
}
export interface AssistantSnapshot {
  epoch: number;
  revision: number;
  messages: AssistantMessage[];
  todos: PersonalTodo[];
  reminders: PersonalReminder[];
  settings: AssistantSettingsView | null;
  expressionState: string;
  activeRequest: { requestId: string } | null;
}
export class AssistantClientError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const base = "http://127.0.0.1:18100/v1/assistant";
let savedToken: string | undefined;
export async function assistantToken(create: boolean): Promise<string> {
  if (!savedToken) {
    try {
      savedToken = await invoke<string>("assistant_client_token", { create });
    } catch (error) {
      throw new AssistantClientError(
        typeof error === "string" &&
        /^assistant_credential_[a-z_]+$/.test(error)
          ? error
          : "runtime_unavailable",
      );
    }
  }
  return savedToken;
}
export async function assistantCall<T>(
  token: string,
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new AssistantClientError("runtime_unavailable");
  }
  // 保留服务端错误码，且错误响应也须受读取上限约束。
  const bytes = await readBounded(new Response(response.body), 4 * 1024 * 1024);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AssistantClientError("invalid_response");
  }
  if (!response.ok)
    throw new AssistantClientError(
      typeof value === "object" && value !== null && "error" in value
        ? String(value.error)
        : "assistant_failed",
    );
  return value as T;
}
