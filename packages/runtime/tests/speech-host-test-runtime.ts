import type { StartedRuntime } from "../src/runtime.js";
import { startFetchCompatibleRuntime } from "./fetch-compatible-runtime.js";

export function speechHostTestRuntime(configDir: string): Promise<StartedRuntime> {
  return startFetchCompatibleRuntime({ configDir, notifier: { notify: async () => ({ status: "accepted" as const }) } });
}
