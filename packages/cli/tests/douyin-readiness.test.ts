import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";

it("离线诊断不把公开文档当作账号发布已就绪", () => {
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "../dist/main.js"), "platform", "douyin-check"], { encoding: "utf8", timeout: 5000 });
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report).toMatchObject({ platform: "douyin", mode: "offline", status: "restricted", publishingEnabled: false, liveChecksPerformed: false });
  expect(report.checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "application_permission", status: "unknown" }),
    expect.objectContaining({ id: "account_authorization", status: "unknown" }),
    expect.objectContaining({ id: "publication_verified", status: "unknown" }),
  ]));
  expect(report.nextSteps.length).toBeGreaterThan(0);
});

it("离线诊断拒绝凭证参数且不回显其内容", () => {
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "../dist/main.js"), "platform", "douyin-check", "--access", "test-credential-do-not-echo"], { encoding: "utf8", timeout: 5000 });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("离线诊断");
  expect(result.stdout + result.stderr).not.toContain("test-credential-do-not-echo");
});
