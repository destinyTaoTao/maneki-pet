import { expect, it } from "vitest";
import {
  localTimeToUtc,
  parsePersonalIntent,
  parseReminderTime,
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
it("查询过滤和单项修改只接受明确完整命令，截止日期与提醒时间分开", () => {
  expect(
    parsePersonalIntent("查看今天未完成的待办", now, "Asia/Shanghai"),
  ).toEqual({ kind: "list", entity: "todo", filter: "today-open" });
  expect(parsePersonalIntent("今天有哪些提醒", now, "Asia/Shanghai")).toEqual({
    kind: "list",
    entity: "reminder",
    filter: "today",
  });
  expect(
    parsePersonalIntent("把待办“买牛奶”改名为“买豆浆”", now, "Asia/Shanghai"),
  ).toEqual({
    kind: "todo.update",
    title: "买牛奶",
    patch: { title: "买豆浆" },
  });
  expect(
    parsePersonalIntent("把待办买牛奶的备注改为无糖", now, "Asia/Shanghai"),
  ).toEqual({ kind: "todo.update", title: "买牛奶", patch: { notes: "无糖" } });
  expect(
    parsePersonalIntent("把待办买牛奶的截止日期改为明天", now, "Asia/Shanghai"),
  ).toEqual({
    kind: "todo.update",
    title: "买牛奶",
    patch: { dueDate: "2026-11-08" },
  });
  expect(
    parsePersonalIntent("清除待办买牛奶的截止日期", now, "Asia/Shanghai"),
  ).toEqual({ kind: "todo.update", title: "买牛奶", patch: { dueDate: "" } });
  for (const value of ["2026-02-30", "明天前去开会", "下周某天"])
    expect(
      parsePersonalIntent(
        `把待办买牛奶的截止日期改为${value}`,
        now,
        "Asia/Shanghai",
      ).kind,
    ).toBe("clarify");
  expect(
    parsePersonalIntent("把买牛奶的提醒改到明天下午三点", now, "Asia/Shanghai"),
  ).toEqual({ kind: "reminder.update", title: "买牛奶", when: "明天下午三点" });
  expect(parsePersonalIntent("取消买牛奶的提醒", now, "Asia/Shanghai")).toEqual(
    { kind: "reminder.cancel", title: "买牛奶" },
  );
});
it("缺时间可继续澄清，引用、裸时间和选择文本不会独立成为操作", () => {
  expect(
    parsePersonalIntent("提醒我买牛奶", now, "Asia/Shanghai"),
  ).toMatchObject({ kind: "clarify", reminder: { message: "买牛奶" } });
  for (const input of [
    "第2个",
    "明天下午三点",
    "模型说“取消提醒买牛奶”",
    "请解释把待办买牛奶改名为豆浆",
  ])
    expect(parsePersonalIntent(input, now, "Asia/Shanghai")).toEqual({
      kind: "chat",
    });
  expect(
    parsePersonalIntent(
      "请解释这段引用：半小时后提醒我休息",
      now,
      "Asia/Shanghai",
    ),
  ).not.toHaveProperty("reminder");
  expect(
    parsePersonalIntent("把待办项目标记完成", now, "Asia/Shanghai"),
  ).toEqual({ kind: "complete", title: "待办项目" });
});
it("补充时间复用时区与一年范围限制，不猜测模糊时段", () => {
  expect(parseReminderTime("明天下午三点", now, "Asia/Shanghai")).toBe(
    Date.parse("2026-11-08T07:00Z"),
  );
  for (const when of [
    "明天三点",
    "明天晚上三点",
    "2028-11-07下午三点",
    "0分钟后",
  ])
    expect(parseReminderTime(when, now, "Asia/Shanghai")).toBeNull();
});
it("标题改名不隐式写入截止日期", () => {
  expect(
    parsePersonalIntent("把待办买牛奶改名为明天前买豆浆", now, "Asia/Shanghai")
      .kind,
  ).toBe("clarify");
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
