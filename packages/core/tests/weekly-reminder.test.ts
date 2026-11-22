import { expect, it } from "vitest";
import { normalizeWeeklyReminderInput } from "../src/index.js";

const input = { requestId: "weekly-1", localTime: "08:00", message: "确认构建" };

it("规范化有效的 ISO 星期集合与正文，不改写调用方数组", () => {
  const daysOfWeek = Object.freeze([7, 2, 1]);
  expect(normalizeWeeklyReminderInput({ ...input, message: ` ${input.message} `, daysOfWeek }))
    .toEqual({ ...input, daysOfWeek: [1, 2, 7] });
  expect(daysOfWeek).toEqual([7, 2, 1]);
  expect(normalizeWeeklyReminderInput({ ...input, daysOfWeek: [7, 6, 5, 4, 3, 2, 1] })?.daysOfWeek).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(normalizeWeeklyReminderInput({ ...input, daysOfWeek: [7] })?.daysOfWeek).toEqual([7]);
});

it("拒绝缺失、重复、稀疏或超界的星期与额外字段", () => {
  for (const daysOfWeek of [null, "1,3,5", [], [1, 1], [0], [8], [1.5], ["1"], [NaN], [, 2], [1, 2, 3, 4, 5, 6, 7, 8]]) {
    expect(normalizeWeeklyReminderInput({ ...input, daysOfWeek })).toBeNull();
  }
  expect(normalizeWeeklyReminderInput(input)).toBeNull();
  expect(normalizeWeeklyReminderInput({ ...input, daysOfWeek: [1], timeZone: "UTC" })).toBeNull();
  expect(normalizeWeeklyReminderInput({ ...input, daysOfWeek: [1], localTime: "24:00" })).toBeNull();
});
