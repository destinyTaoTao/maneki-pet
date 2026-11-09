import { createHash } from "node:crypto";
import {
  localParts,
  parsePersonalIntent,
  parseReminderTime,
  type PersonalIntent,
} from "@maneki-pet/core";
import type { AssistantStore } from "./assistant-store.js";

type TargetIntent = Extract<
  PersonalIntent,
  {
    kind:
      | "complete"
      | "delete"
      | "todo.update"
      | "reminder.update"
      | "reminder.cancel";
  }
>;
interface Target {
  id: string;
  version: number;
  label: string;
}
interface Context {
  client: string;
  requestId: string;
  epoch: number;
  zone: string;
}
type TimeOperation =
  | { kind: "create"; message: string }
  | { kind: "move"; target: Target };
type Pending = { epoch: number; zone: string; expires: number } & (
  | { step: "choose"; intent: TargetIntent; choices: Target[] }
  | { step: "time"; operation: TimeOperation }
);
const stale = "这项澄清已失效或目标已变化，请重新说完整命令；没有修改事项。";
const timePrompt =
  "请补充明确的未来时间，例如“明天下午三点”或“半小时后”；回复“取消”可放弃。";
const statuses = {
  pending: "待投递",
  sending: "投递中",
  accepted: "系统已受理",
  failed: "投递失败",
  cancelled: "已取消",
};
// 名称/备注按数据展示，不能伪造候选列表的新行；长内容在面板查看。
const label = (value: string, max = 120) =>
  JSON.stringify(value.slice(0, max)) + (value.length > max ? "…" : "");

/** 用户对话的确定性办理层；不读取模型回答或从共享历史恢复授权。 */
export class PersonalDialogue {
  private readonly pending = new Map<string, Pending>();
  constructor(
    private readonly deps: {
      store: AssistantStore;
      now: () => number;
      mutate: (client: string, input: Record<string, unknown>) => unknown;
    },
  ) {}

  invalidate(client?: string): void {
    if (client === undefined) this.pending.clear();
    else this.pending.delete(client);
  }
  private mutate(context: Context, input: Record<string, unknown>): void {
    this.deps.mutate(context.client, {
      requestId: `chat-${createHash("sha256").update(context.requestId).digest("hex")}`,
      ...input,
    });
  }
  private remember(context: Context, next: Pending): boolean {
    if (!this.pending.has(context.client) && this.pending.size >= 32)
      return false;
    this.pending.set(context.client, next);
    return true;
  }
  private binding(context: Context) {
    return {
      epoch: context.epoch,
      zone: context.zone,
      expires: this.deps.now() + 300000,
    };
  }
  private date(at: number, zone: string): string {
    return `${new Date(at).toLocaleString("zh-CN", { timeZone: zone })}（${zone}）`;
  }
  private list(
    context: Context,
    intent: Extract<PersonalIntent, { kind: "list" }>,
  ): string {
    const today = localParts(this.deps.now(), context.zone).date;
    if (intent.entity === "todo") {
      const items = this.deps.store.todos().filter((item) => {
        switch (intent.filter) {
          case "open":
            return !item.completed;
          case "completed":
            return item.completed;
          case "today":
            return item.dueDate === today;
          case "today-open":
            return !item.completed && item.dueDate === today;
          case "overdue":
            return (
              !item.completed && item.dueDate !== null && item.dueDate < today
            );
          default:
            return true;
        }
      });
      if (!items.length) return "没有符合条件的待办。";
      return (
        `找到 ${items.length} 项待办：\n` +
        items
          .slice(0, 20)
          .map(
            (item, index) =>
              `${index + 1}. ${label(item.title)}（${item.completed ? "已完成" : "未完成"}${item.dueDate ? `，截止 ${item.dueDate}` : "，无截止日期"}）`,
          )
          .join("\n") +
        (items.length > 20 ? "\n仅显示前 20 项，更多请打开待办清单。" : "")
      );
    }
    const items = this.deps.store
      .reminders()
      .filter((item) =>
        intent.filter === "open"
          ? item.status === "pending"
          : intent.filter === "today"
            ? localParts(item.remindAt, context.zone).date === today
            : true,
      );
    if (!items.length) return "没有符合条件的提醒。";
    return (
      `找到 ${items.length} 项提醒：\n` +
      items
        .slice(0, 20)
        .map(
          (item, index) =>
            `${index + 1}. ${label(item.message)} · ${this.date(item.remindAt, context.zone)} · ${statuses[item.status]}${item.seenAt ? " · 已查看" : ""}`,
        )
        .join("\n") +
      (items.length > 20 ? "\n仅显示前 20 项，更多请打开提醒清单。" : "")
    );
  }

  reply(context: Context, input: string): string | null {
    const intent = parsePersonalIntent(input, this.deps.now(), context.zone);
    const prior = this.pending.get(context.client);
    for (const [client, pending] of this.pending) {
      if (
        pending.expires <= this.deps.now() ||
        pending.epoch !== context.epoch ||
        pending.zone !== context.zone
      )
        this.pending.delete(client);
    }
    if (["取消", "算了", "不改了"].includes(input.trim())) {
      this.invalidate(context.client);
      return prior
        ? "已取消待澄清操作；已提交的事项不受影响。"
        : "没有待澄清操作；取消具体提醒请说“取消提醒名称”。";
    }
    if (intent.kind === "chat" && prior) {
      if (
        prior.expires <= this.deps.now() ||
        prior.epoch !== context.epoch ||
        prior.zone !== context.zone
      )
        return stale;
      if (prior.step === "choose") {
        const selection =
          /^(?:第)?([1-9]\d*|[一二三四五六七八九十])(?:个|项)?$/.exec(
            input.trim(),
          );
        if (selection) {
          const digit = selection[1]!;
          const index = /^\d+$/.test(digit)
            ? Number(digit) - 1
            : "一二三四五六七八".indexOf(digit);
          const target = prior.choices[index];
          if (!target)
            return "序号超出候选范围，请回复列表中的“第 N 个”，或回复“取消”。";
          this.invalidate(context.client);
          return this.execute(context, prior.intent, target);
        }
      } else {
        const when = input.trim().replace(/^(?:改到|改为|时间是)[：:\s]*/, "");
        const at = parseReminderTime(when, this.deps.now(), context.zone);
        if (at !== null) {
          this.invalidate(context.client);
          return this.time(context, prior.operation, at);
        }
        if (
          /^(?:今天|明天|后天|\d{4}-|半|[\d零一二三四五六七八九十两]+(?:分钟|小时|天))/.test(
            when,
          )
        )
          return timePrompt;
      }
    }
    // 新的完整命令或无关聊天替换旧上下文，不能稍后误用旧序号/时间。
    this.invalidate(context.client);
    switch (intent.kind) {
      case "chat":
        if (
          /^(?:第)?([1-9]\d*|[一二三四五六七八九十])(?:个|项)?$/.test(
            input.trim(),
          ) ||
          parseReminderTime(input.trim(), this.deps.now(), context.zone) !==
            null
        )
          return "没有有效的待澄清操作，请重新说完整命令；没有修改事项。";
        return null;
      case "list":
        return this.list(context, intent);
      case "clarify":
        if (
          intent.reminder &&
          !this.remember(context, {
            ...this.binding(context),
            step: "time",
            operation: { kind: "create", message: intent.reminder.message },
          })
        )
          return "当前待澄清操作较多，请使用提醒表单或稍后重述完整命令。";
        return intent.text;
      case "todo":
        this.mutate(context, {
          action: "todo.create",
          title: intent.title,
          ...(intent.dueDate ? { dueDate: intent.dueDate } : {}),
        });
        return `已加入待办：${intent.title}${intent.dueDate ? `，截止日期 ${intent.dueDate}` : ""}。未自动设置提醒。`;
      case "reminder":
        return this.time(
          context,
          { kind: "create", message: intent.message },
          intent.remindAt,
        );
      default:
        return this.resolve(context, intent);
    }
  }
  private resolve(context: Context, intent: TargetIntent): string {
    const reminder = intent.kind.startsWith("reminder.");
    const candidates: Target[] = reminder
      ? this.deps.store
          .reminders()
          .filter((item) => item.message === intent.title)
          .map((item) => ({
            id: item.id,
            version: item.version,
            label: `${label(item.message)} · ${this.date(item.remindAt, context.zone)} · ${statuses[item.status]} · 编号 ${item.id.slice(0, 8)}`,
          }))
      : this.deps.store
          .todos()
          .filter((item) => item.title === intent.title)
          .map((item) => ({
            id: item.id,
            version: item.version,
            label: `${label(item.title)} · ${item.completed ? "已完成" : "未完成"} · ${item.dueDate ?? "无截止日期"}${item.notes ? ` · ${label(item.notes, 40)}` : ""} · 编号 ${item.id.slice(0, 8)}`,
          }));
    if (!candidates.length)
      return `没有找到这个${reminder ? "提醒" : "待办"}，请核对完整名称或打开清单。`;
    if (candidates.length === 1)
      return this.execute(context, intent, candidates[0]!);
    if (candidates.length > 8)
      return "同名事项超过 8 项，请在清单中选择具体一项；没有修改事项。";
    if (
      !this.remember(context, {
        ...this.binding(context),
        step: "choose",
        intent,
        choices: candidates,
      })
    )
      return "当前待澄清操作较多，请在清单中选择具体一项。";
    return (
      "找到多个同名事项，请回复“第 N 个”选择本次操作的目标，或回复“取消”：\n" +
      candidates.map((item, i) => `${i + 1}. ${item.label}`).join("\n")
    );
  }
  private execute(
    context: Context,
    intent: TargetIntent,
    target: Target,
  ): string {
    if (
      intent.kind === "reminder.update" ||
      intent.kind === "reminder.cancel"
    ) {
      const item = this.deps.store.reminder(target.id);
      if (!item || item.version !== target.version) return stale;
      if (item.status !== "pending")
        return `该提醒${statuses[item.status]}，不能通过对话改期或撤回；没有修改记录。`;
      if (intent.kind === "reminder.cancel") {
        this.mutate(context, {
          action: "reminder.delete",
          id: target.id,
          version: target.version,
        });
        return `已取消并删除尚未投递的提醒：${item.message}。`;
      }
      const at = parseReminderTime(intent.when, this.deps.now(), context.zone);
      if (at === null) {
        if (
          !this.remember(context, {
            ...this.binding(context),
            step: "time",
            operation: { kind: "move", target },
          })
        )
          return "当前待澄清操作较多，请在提醒清单修改时间。";
        return timePrompt;
      }
      return this.time(context, { kind: "move", target }, at);
    }
    const item = this.deps.store.todo(target.id);
    if (!item || item.version !== target.version) return stale;
    this.mutate(context, {
      action: intent.kind === "delete" ? "todo.delete" : "todo.update",
      id: target.id,
      version: target.version,
      ...(intent.kind === "complete"
        ? { completed: true }
        : intent.kind === "todo.update"
          ? intent.patch
          : {}),
    });
    if (intent.kind === "delete")
      return `已删除待办：${item.title}。尚未投递的关联提醒一并取消；在途通知不承诺撤回。`;
    if (intent.kind === "complete")
      return `已完成待办：${item.title}。尚未投递的关联提醒一并取消；在途通知不承诺撤回。`;
    return `已修改待办：${intent.patch.title ?? item.title}。${intent.patch.dueDate !== undefined ? "截止日期不自动创建提醒。" : ""}`;
  }
  private time(context: Context, operation: TimeOperation, at: number): string {
    if (operation.kind === "create") {
      this.mutate(context, {
        action: "reminder.create",
        message: operation.message,
        remindAt: at,
      });
      return `已设置提醒：${operation.message}，${this.date(at, context.zone)}。`;
    }
    const item = this.deps.store.reminder(operation.target.id);
    if (!item || item.version !== operation.target.version) return stale;
    if (item.status !== "pending")
      return `该提醒${statuses[item.status]}，无法改期；没有修改记录。`;
    this.mutate(context, {
      action: "reminder.update",
      id: item.id,
      version: item.version,
      remindAt: at,
    });
    return `已修改提醒：${item.message}，${this.date(at, context.zone)}。`;
  }
}
