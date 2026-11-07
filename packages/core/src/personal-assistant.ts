export interface PersonalTodo {
  id: string;
  title: string;
  notes: string;
  dueDate: string | null;
  completed: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface PersonalReminder {
  id: string;
  todoId: string | null;
  message: string;
  remindAt: number;
  timeZone: string;
  status: "pending" | "sending" | "accepted" | "failed" | "cancelled";
  attempts: number;
  code: string | null;
  version: number;
}
export interface SystemNotifier {
  notify(input: {
    id: string;
    title: string;
    body: string;
  }): Promise<{ status: "accepted" | "failed"; code?: string }>;
}
export type PersonalIntent =
  | { kind: "todo"; title: string; dueDate: string | null }
  | { kind: "reminder"; message: string; remindAt: number }
  | { kind: "complete" | "delete"; title: string }
  | { kind: "clarify"; text: string }
  | { kind: "chat" };

export function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).format(0);
    return true;
  } catch {
    return false;
  }
}
export function validDateOnly(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}
export function localParts(
  now: number,
  zone: string,
): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}
/** 本地时间须唯一对应 UTC；不存在或夏令时重复的时刻不猜测。 */
export function localTimeToUtc(value: string, zone: string): number | null {
  if (!validTimeZone(zone) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
    return null;
  const [date, time] = value.split("T") as [string, string];
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  if (!validDateOnly(date) || hour > 23 || minute > 59) return null;
  const nominal = Date.parse(`${value}:00Z`);
  const offsets = new Set<number>();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const instant = nominal + hours * 3_600_000;
    const local = localParts(instant, zone);
    offsets.add(
      Date.parse(
        `${local.date}T${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}:00Z`,
      ) - instant,
    );
  }
  const matches = [...offsets]
    .map((offset) => nominal - offset)
    .filter((instant) => {
      const local = localParts(instant, zone);
      return (
        local.date === date && local.hour === hour && local.minute === minute
      );
    });
  return matches.length === 1 ? matches[0]! : null;
}
function number(text: string): number | null {
  if (/^\d+$/.test(text)) return Number(text);
  const digits = "零一二三四五六七八九";
  if (text === "两") return 2;
  if (text.includes("十")) {
    const [a, b] = text.split("十");
    const tens = a ? digits.indexOf(a) : 1;
    const ones = b ? digits.indexOf(b) : 0;
    return tens >= 1 && ones >= 0 ? tens * 10 + ones : null;
  }
  const n = digits.indexOf(text);
  return n >= 0 && text.length === 1 ? n : null;
}
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export function todoText(
  text: string,
  now: number,
  zone: string,
): { title: string; dueDate: string | null } {
  const current = localParts(now, zone).date;
  const match = /^(今天|明天|后天|周[一二三四五六日天])前\s*(.+)$/s.exec(
    text.trim(),
  );
  if (!match) return { title: text.trim(), dueDate: null };
  let days =
    match[1] === "今天"
      ? 0
      : match[1] === "明天"
        ? 1
        : match[1] === "后天"
          ? 2
          : -1;
  if (days < 0) {
    const target = "日一二三四五六".indexOf(
      match[1]!.slice(1).replace("天", "日"),
    );
    days = (target - new Date(`${current}T00:00Z`).getUTCDay() + 7) % 7;
  }
  return { title: match[2]!.trim(), dueDate: addDays(current, days) };
}

/** 仅解析用户当前输入的明确命令；模型回答和外部输出不进入此入口。 */
export function parsePersonalIntent(
  text: string,
  now: number,
  zone: string,
): PersonalIntent {
  const source = text.trim();
  const todo =
    /^(?:\/?待办[：:\s]|添加待办[：:\s]*|帮我记一下[：:\s]*)(.+)$/s.exec(
      source,
    );
  if (todo) return { kind: "todo", ...todoText(todo[1]!, now, zone) };
  const completion = /^把(.+?)(?:标记(?:为)?完成|标为完成)$/s.exec(source);
  if (completion) return { kind: "complete", title: completion[1]!.trim() };
  const deletion = /^删除待办[：:\s]*(.+)$/s.exec(source);
  if (deletion) return { kind: "delete", title: deletion[1]!.trim() };
  const reminder = /^(.*?)提醒我[：:\s]*(.+)$/s.exec(source);
  if (!reminder) return { kind: "chat" };
  const when = reminder[1]!.replace(/^(请|小招[，,\s]*)/, "").trim();
  const message = reminder[2]!.trim();
  const relative = /^(半|[\d零一二三四五六七八九十两]+)(分钟|小时|天)后$/.exec(
    when,
  );
  if (relative) {
    const amount = relative[1] === "半" ? 0.5 : number(relative[1]!);
    const unit =
      relative[2] === "分钟"
        ? 60_000
        : relative[2] === "小时"
          ? 3_600_000
          : 86_400_000;
    if (amount !== null && amount > 0 && amount * unit <= 366 * 86_400_000)
      return { kind: "reminder", message, remindAt: now + amount * unit };
  }
  const absolute =
    /^(今天|明天|后天|\d{4}-\d{2}-\d{2})(上午|下午|晚上)?\s*([\d零一二三四五六七八九十两]+)(?:点|:)(半|[\d零一二三四五六七八九十两]+分?)?$/.exec(
      when,
    );
  if (absolute) {
    const date = /^\d/.test(absolute[1]!)
      ? absolute[1]!
      : addDays(
          localParts(now, zone).date,
          absolute[1] === "今天" ? 0 : absolute[1] === "明天" ? 1 : 2,
        );
    let hour = number(absolute[3]!);
    const minute =
      absolute[4] === "半"
        ? 30
        : absolute[4]
          ? number(absolute[4].replace("分", ""))
          : 0;
    if (
      hour !== null &&
      minute !== null &&
      (!absolute[2] || (hour >= 1 && hour <= 12)) &&
      (absolute[2] !== "上午" || hour !== 12) &&
      (absolute[2] !== "晚上" || (hour >= 6 && hour < 12)) &&
      (absolute[2] || hour >= 13 || hour === 0)
    ) {
      if ((absolute[2] === "下午" || absolute[2] === "晚上") && hour < 12)
        hour += 12;
      const instant = localTimeToUtc(
        `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
        zone,
      );
      if (instant !== null && instant > now)
        return { kind: "reminder", message, remindAt: instant };
    }
  }
  return {
    kind: "clarify",
    text: "请补充明确的未来提醒时间，例如“半小时后提醒我休息”或“明天下午三点提醒我开会”；也可以在提醒表单选择日期和时间。",
  };
}
