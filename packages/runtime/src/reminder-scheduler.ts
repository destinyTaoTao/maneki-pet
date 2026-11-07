import type { SystemNotifier } from "@maneki-pet/core";
import type { AssistantStore } from "./assistant-store.js";
import type { NotificationBudget } from "./quota.js";
import type { EventFeed } from "./events.js";
import { randomUUID } from "node:crypto";

export class ReminderScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;
  constructor(
    private readonly store: AssistantStore,
    private readonly notifier: SystemNotifier,
    private readonly budget: NotificationBudget,
    private readonly dnd: () => boolean,
    private readonly feed: EventFeed,
    private readonly now: () => number = Date.now,
  ) {}
  wake(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    if (this.running) return;
    this.timer = setTimeout(() => {
      this.running = this.deliver().finally(() => {
        this.running = undefined;
        this.schedule();
      });
      void this.running.catch(() => undefined);
    }, 0);
    this.timer.unref();
  }
  private schedule(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    const next = this.store.nextDue();
    const blocked = this.dnd() || !this.budget.canSend(this.now()).allowed;
    const interval =
      next === null || blocked
        ? 30_000
        : Math.min(30_000, Math.max(1, next - this.now()));
    this.timer = setTimeout(() => this.wake(), interval);
    this.timer.unref();
  }
  private async deliver(): Promise<void> {
    if (this.dnd() || !this.budget.canSend(this.now()).allowed) return;
    const due = this.store.due(this.now());
    if (!due.length) return;
    // 崩溃后沿用原批次标识，新到期项另投一批，避免改变系统通知去重键。
    const recovered = this.store.deliveryId(due[0]!.id);
    const id = recovered ?? randomUUID();
    const claimed = this.store.transaction(() =>
      due.filter(
        (item) =>
          this.store.deliveryId(item.id) === recovered &&
          this.store.claim(item.id, id),
      ),
    );
    if (!claimed.length) return;
    this.budget.record(this.now());
    const body =
      claimed
        .slice(0, 4)
        .map(
          (item) =>
            `${item.message}（原定 ${new Date(item.remindAt).toLocaleString("zh-CN", { timeZone: item.timeZone })}）`,
        )
        .join("\n") +
      (claimed.length > 4
        ? `\n另有 ${claimed.length - 4} 项，请打开助手查看`
        : "");
    let result: { status: "accepted" | "failed"; code?: string };
    try {
      result = await this.notifier.notify({
        id,
        title:
          claimed.length === 1 ? "小招提醒" : `小招提醒 · ${claimed.length} 项`,
        body,
      });
    } catch {
      result = { status: "failed", code: "system_notification_failed" };
    }
    this.store.transaction(() => {
      for (const item of claimed)
        this.store.finishDelivery(item.id, result.status, result.code ?? null);
    });
    if (this.stopped) return;
    if (!this.dnd())
      this.feed.publish("assistant.reminder", {
        id,
        body,
        status: result.status,
      });
    this.feed.publish("assistant.changed", { revision: this.store.revision() });
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }
}
