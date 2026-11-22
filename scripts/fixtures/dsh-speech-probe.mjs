import { startSpeechHost } from "../../apps/dsh-plugin/dist/speech-host.js";
import { runProbe, send } from "./dsh-tool-probe.mjs";

export const inject = ["speechToText"];

export function apply(ctx) {
  return runProbe(ctx, async (_ctx, revoked, signal) => {
    const token = process.env.MANEKI_VOICE_TEST_TOKEN;
    delete process.env.MANEKI_VOICE_TEST_TOKEN;
    const stop = startSpeechHost(new URL(process.env.MANEKI_VOICE_TEST_URL),
      token, process.env.MANEKI_VOICE_TEST_CLIENT,
      "acceptance-sensevoice", () => ctx.speechToText);
    try {
      await send({ type: "revoke" });
      await revoked;
      signal.throwIfAborted();
      return { provider: ctx.speechToText.snapshot().selection.providerId };
    } finally {
      await stop();
    }
  });
}
