import type { PetState } from "@maneki-pet/core";

export const expressionStates = ["idle", "thinking", "working", "waiting_input", "celebrating", "error"] as const;
type ExpressionState = typeof expressionStates[number];
const PRIORITY: ExpressionState[] = ["waiting_input", "working", "thinking", "error", "celebrating"];

/** 短租约只仲裁表现，不代表任务状态或交付记录。 */
export class ExpressionStateFeed {
  private readonly sources = new Map<string, { clientId: string; state: ExpressionState; expiresAt: number }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private state: PetState = "idle";

  constructor(private readonly deps: { active(clientId: string): boolean; publish(state: PetState): void }) {}

  update(clientId: string, sourceId: string, state: ExpressionState): boolean {
    this.refresh();
    const key = `${clientId}:${sourceId}`;
    if (state === "idle") this.sources.delete(key);
    else {
      if (!this.sources.has(key) && this.sources.size >= 64) return false;
      this.sources.set(key, { clientId, state, expiresAt: Date.now() + 15_000 });
    }
    this.refresh();
    if (this.sources.size && !this.timer) {
      this.timer = setInterval(() => this.refresh(), 1_000);
      this.timer.unref();
    }
    return true;
  }

  current(): PetState {
    this.refresh();
    return this.state;
  }

  close(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.sources.clear();
  }

  private refresh(): void {
    const now = Date.now();
    for (const [key, source] of this.sources) {
      if (source.expiresAt <= now || !this.deps.active(source.clientId)) this.sources.delete(key);
    }
    const states = new Set([...this.sources.values()].map((source) => source.state));
    const next = PRIORITY.find((state) => states.has(state)) ?? "idle";
    if (next !== this.state) {
      this.state = next;
      this.deps.publish(next);
    }
    if (!this.sources.size) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
