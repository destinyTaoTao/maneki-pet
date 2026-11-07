import type {
  ChatProvider,
  ChatReplyInput,
  CallContext,
} from "@maneki-pet/core";
import type { AssistantSettings } from "./assistant-settings.js";
import { AssistantError } from "./assistant-settings.js";

/** 非流式兼容协议；不跟随重定向、无工具执行、无失败重试。 */
export class HttpChatProvider implements ChatProvider {
  readonly info;
  constructor(
    private readonly settings: AssistantSettings,
    private readonly key?: string,
  ) {
    this.info = {
      id: "configured-chat",
      apiVersion: 1 as const,
      locality: settings.chat.locality,
    };
  }
  async reply(input: ChatReplyInput, ctx: CallContext) {
    const signal = AbortSignal.any([
      ctx.signal,
      AbortSignal.timeout(Math.max(1, ctx.deadlineAtMs - Date.now())),
    ]);
    let response: Response;
    try {
      response = await fetch(
        `${this.settings.chat.baseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            "content-type": "application/json",
            ...(this.key ? { authorization: `Bearer ${this.key}` } : {}),
          },
          body: JSON.stringify({
            model: this.settings.chat.model,
            stream: false,
            max_tokens: this.settings.chat.maxOutputTokens,
            messages: input.messages.map((m) => ({
              role: m.role,
              content: m.text,
            })),
          }),
        },
      );
    } catch {
      throw new AssistantError(
        502,
        ctx.signal.aborted
          ? "chat_cancelled"
          : signal.aborted
            ? "provider_timeout"
            : "provider_unavailable",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AssistantError(
        502,
        response.status === 401 || response.status === 403
          ? "provider_auth_failed"
          : "provider_failed",
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new AssistantError(502, "provider_invalid_response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 256 * 1024)
          throw new AssistantError(502, "provider_response_too_large");
        chunks.push(part.value);
      }
    } catch (error) {
      throw error instanceof AssistantError
        ? error
        : new AssistantError(
            502,
            ctx.signal.aborted
              ? "chat_cancelled"
              : signal.aborted
                ? "provider_timeout"
                : "provider_unavailable",
          );
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new AssistantError(502, "provider_invalid_response");
    }
    const record = (value: unknown): Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const root = record(raw),
      choices = root.choices,
      choice = record(Array.isArray(choices) ? choices[0] : undefined);
    const text = record(choice.message).content,
      usage = record(root.usage);
    if (
      typeof text !== "string" ||
      !text.trim() ||
      text.length > 16384 ||
      choice.finish_reason !== "stop"
    )
      throw new AssistantError(502, "provider_incomplete_response");
    const inputTokens = usage.prompt_tokens,
      outputTokens = usage.completion_tokens;
    if (
      typeof inputTokens !== "number" ||
      typeof outputTokens !== "number" ||
      !Number.isSafeInteger(inputTokens) ||
      inputTokens < 0 ||
      !Number.isSafeInteger(outputTokens) ||
      outputTokens < 0
    )
      throw new AssistantError(502, "metering_unavailable");
    return { text, usage: { inputTokens, outputTokens } };
  }
}
