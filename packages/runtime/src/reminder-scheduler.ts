import type { SystemNotifier } from "@maneki-pet/core";
import type { AssistantStore } from "./assistant-store.js";
import type { NotificationBudget } from "./quota.js";
import type { EventFeed } from "./events.js";
import type { RecurringReminders } from "./daily-reminders.js";
import { randomUUID } from "node:crypto";

const SCAN_INTERVAL_MS = 30_000;

export class ReminderScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;
  private backingOff = false;
  private readonly recurringRetryAt = new Map<RecurringReminders, number>();
  constructor(
    private readonly store: AssistantStore,
    private readonly notifier: SystemNotifier,
    private readonly budget: NotificationBudget,
    private readonly dnd: () => boolean,
    private readonly feed: EventFeed,
    private readonly now: () => number = Date.now,
    private readonly recurring: readonly RecurringReminders[] = [],
  ) {}
  wake(): void {
    if (this.stopped) return;
    if (this.backingOff && this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.running) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.deliver()
        .catch(() => {
          this.backingOff = true;
        })
        .finally(() => {
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
    let interval = SCAN_INTERVAL_MS;
    if (!this.backingOff) {
      try {
        let next = this.store.nextDue() ?? Infinity;
        for (const reminders of this.recurring) {
          const due = this.withRecurring(reminders, () => reminders.nextDue());
          if (due !== null) next = Math.min(next, due);
        }
        interval =
          this.allowed()
            ? Math.min(SCAN_INTERVAL_MS, Math.max(1, next - this.now()))
            : SCAN_INTERVAL_MS;
      } catch {
        this.backingOff = true;
      }
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.backingOff = false;
      this.wake();
    }, interval);
    this.timer.unref();
  }
  private allowed(): boolean {
    return !this.dnd() && this.budget.canSend(this.now()).allowed;
  }
  private withRecurring<T>(reminders: RecurringReminders, run: () => T): T | null {
    if (performance.now() < (this.recurringRetryAt.get(reminders) ?? 0)) return null;
    try {
      return run();
    } catch {
      // 每种周期的存储故障独立退避。
      this.recurringRetryAt.set(reminders, performance.now() + SCAN_INTERVAL_MS);
      return null;
    }
  }
  private async deliver(): Promise<void> {
    if (this.allowed()) await this.deliverOnce();
    for (const reminders of this.recurring) {
      if (this.stopped) return;
      const delivery = this.withRecurring(reminders, () => reminders.advance(this.now(), this.allowed()));
      if (!delivery) continue;
      this.budget.record(this.now());
      const body = this.body(delivery);
      const result = await this.notify(delivery.id, 1, body);
      this.publish(delivery.id, body, result.status);
    }
  }
  private async deliverOnce(): Promise<void> {
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
        .map((item) => this.body(item))
        .join("\n") +
      (claimed.length > 4
        ? `\n另有 ${claimed.length - 4} 项，请打开助手查看`
        : "");
    const result = await this.notify(id, claimed.length, body);
    this.store.transaction(() => {
      for (const item of claimed)
        this.store.finishDelivery(item.id, result.status, result.code ?? null);
    });
    if (this.stopped) return;
    this.publish(id, body, result.status);
    this.feed.publish("assistant.changed", { revision: this.store.revision() });
  }
  private body(item: { message: string; remindAt: number; timeZone: string }): string {
    return `${item.message}（原定 ${new Date(item.remindAt).toLocaleString("zh-CN", { timeZone: item.timeZone })}）`;
  }
  private async notify(id: string, count: number, body: string): Promise<{ status: "accepted" | "failed"; code?: string }> {
    try {
      return await this.notifier.notify({
        id,
        title: count === 1 ? "小招提醒" : `小招提醒 · ${count} 项`,
        body,
      });
    } catch {
      return { status: "failed", code: "system_notification_failed" };
    }
  }
  private publish(id: string, body: string, status: "accepted" | "failed"): void {
    if (!this.stopped && !this.dnd())
      this.feed.publish("assistant.reminder", {
        id,
        body,
        status,
      });
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }
}
