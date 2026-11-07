import { spawn } from "node:child_process";
import { dirname } from "node:path";
import type { CallContext } from "@maneki-pet/core";
import { AssistantError } from "./assistant-settings.js";

/** 固定 argv、内存管道；终止后等到 close 才交还调用槽，不把 stderr 暴露给日志。 */
export function speechProcess(
  executable: string,
  args: string[],
  input: Uint8Array,
  ctx: CallContext,
  maxBytes: number,
): Promise<Uint8Array> {
  if (ctx.signal.aborted)
    return Promise.reject(new AssistantError(499, "voice_cancelled"));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
      shell: false,
      cwd: dirname(executable),
    });
    const chunks: Buffer[] = [];
    let size = 0,
      error: AssistantError | undefined,
      finished = false;
    const abort = (code: string) => {
      error ??= new AssistantError(499, code);
      child.kill();
    };
    const onAbort = () => abort("voice_cancelled");
    const timer = setTimeout(
      () => abort("speech_timeout"),
      Math.max(1, ctx.deadlineAtMs - Date.now()),
    );
    const settle = (failure?: AssistantError) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      if (failure) reject(failure);
      else resolve(Buffer.concat(chunks));
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", () =>
      settle(new AssistantError(503, "speech_unavailable")),
    );
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) abort("speech_output_limit");
      else chunks.push(chunk);
    });
    child.stdin.on("error", () => {
      error ??= new AssistantError(502, "speech_failed");
    });
    child.on("close", (code) =>
      settle(
        error ??
          (code === 0 ? undefined : new AssistantError(502, "speech_failed")),
      ),
    );
    if (ctx.signal.aborted) onAbort();
    else child.stdin.end(input);
  });
}
