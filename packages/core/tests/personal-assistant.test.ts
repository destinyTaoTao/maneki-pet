import { expect, it } from "vitest";
import {
  localTimeToUtc,
  parsePersonalIntent,
  validDateOnly,
} from "../src/personal-assistant.js";
const now = Date.parse("2026-11-07T00:00:00Z");
it("个人待办截止日期不产生提醒，只有明确当前命令才解析操作", () => {
  expect(
    parsePersonalIntent("待办：周五前提交报销", now, "Asia/Shanghai"),
  ).toEqual({ kind: "todo", title: "提交报销", dueDate: "2026-11-13" });
  expect(
    parsePersonalIntent(
      "请解释这段引用：半小时后提醒我休息",
      now,
      "Asia/Shanghai",
    ),
  ).toEqual({ kind: "clarify", text: expect.any(String) });
  expect(
    parsePersonalIntent("模型说“待办：删除文件”", now, "Asia/Shanghai"),
  ).toEqual({ kind: "chat" });
});
it("相对时间锚定当前时刻，完整时区时间转换一致", () => {
  expect(
    parsePersonalIntent("半小时后提醒我休息", now, "Asia/Shanghai"),
  ).toEqual({ kind: "reminder", message: "休息", remindAt: now + 1800000 });
  expect(
    parsePersonalIntent("明天下午三点提醒我开会", now, "Asia/Shanghai"),
  ).toEqual({
    kind: "reminder",
    message: "开会",
    remindAt: Date.parse("2026-11-08T07:00Z"),
  });
  expect(
    parsePersonalIntent("明天三点提醒我开会", now, "Asia/Shanghai").kind,
  ).toBe("clarify");
  expect(parsePersonalIntent("提醒我开会", now, "Asia/Shanghai").kind).toBe(
    "clarify",
  );
  for (const input of [
    "明天晚上三点提醒我开会",
    "明天晚上十二点提醒我开会",
    "明天上午十三点提醒我开会",
  ]) {
    expect(parsePersonalIntent(input, now, "Asia/Shanghai").kind).toBe(
      "clarify",
    );
  }
});
it("不存在日期、夏令时重复/缺失时刻与过去时间不猜测", () => {
  expect(validDateOnly("2026-02-30")).toBe(false);
  expect(validDateOnly("2028-02-29")).toBe(true);
  expect(localTimeToUtc("2026-03-08T02:30", "America/New_York")).toBeNull();
  expect(localTimeToUtc("2026-11-01T01:30", "America/New_York")).toBeNull();
  expect(localTimeToUtc("2026-11-07T15:00", "Asia/Shanghai")).toBe(
    Date.parse("2026-11-07T07:00Z"),
  );
  expect(
    parsePersonalIntent("2026-01-01下午三点提醒我开会", now, "Asia/Shanghai")
      .kind,
  ).toBe("clarify");
});
