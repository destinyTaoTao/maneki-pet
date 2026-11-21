import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { clientCredential } from "../packages/runtime/dist/desktop-credential.js";
import { startRuntime } from "../packages/runtime/dist/runtime.js";
import { exerciseHost, repo, withFixture, writeProfile } from "./fixtures/dsh-acceptance.mjs";

const summary = await withFixture("briefing", async ({ lab, env, cwd, configDir, runNode, version, signal }) => {
  const runtime = await startRuntime({ configDir, port: 0 });
  try {
    const url = "http://127.0.0.1:" + runtime.port;
    runtime.assistant.mutation("fixture", { requestId: "fixture-due", action: "todo.create",
      title: "Fixture due item", notes: "excluded fixture notes", dueDate: "2024-01-03" });
    runtime.assistant.mutation("fixture", { requestId: "fixture-future", action: "todo.create",
      title: "Fixture future", dueDate: "2099-01-03" });

    const observer = await clientCredential(configDir, runtime.port, "fixture-observer", "fixture-observer", "express", true);
    const observerTokenFile = join(lab, "observer.token");
    writeFileSync(observerTokenFile, observer.token, { mode: 0o600 });
    writeProfile(env.DSH_HOME, [{
      id: "maneki-observer", name: join(repo, "apps/dsh-plugin/dist/index.js"),
      config: { baseUrl: url, tokenFile: observerTokenFile, profileId: "acceptance", showOnConnect: false },
    }, { id: "probe", name: join(repo, "scripts/fixtures/dsh-briefing-probe.mjs") }]);

    const pair = action => runNode(join(repo, "packages/runtime/scripts/pair-briefing-client.mjs"),
      configDir, String(runtime.port), "dsh-fixture", action);
    env.MANEKI_BRIEFING_URL = url;
    env.MANEKI_BRIEFING_BRIDGE = join(repo, "packages/cli/dist/briefing-mcp.js");
    env.MANEKI_BRIEFING_TOKEN_FILE = (await pair("--allow-briefing-read")).stdout.trim();

    const deadline = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
    const result = await exerciseHost(cwd, env, join(repo, "apps/dsh-plugin/briefing.patch.example.yml"),
      () => pair("--revoke-briefing-read"), deadline);
    assert.equal(result.waiting[0].clientId, observer.clientId);
    const sources = runtime.assistant.snapshot().observations;
    assert.equal(sources.length, 1);
    assert.equal(sources[0].connected, false);
    assert.ok(Date.now() - sources[0].lastSeenAt < 10000, "应由插件显式上报离线");
    return { dsh: version, node: process.version, ...result, observerDisconnected: true };
  } finally {
    await runtime.stop();
  }
});
console.log(JSON.stringify(summary, null, 2));
