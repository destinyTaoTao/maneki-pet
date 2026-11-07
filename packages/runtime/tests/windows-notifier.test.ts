import { execFileSync } from "node:child_process";
import { expect, it, vi } from "vitest";
const identity = vi.hoisted(() => `com.manekipet.acceptance.${Date.now()}`);
// 只替换本次验收的身份，仍运行真实 Adapter 与系统程序，覆盖首次投递初始化。
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const [command, argv, options] = args;
      return actual.spawn(
        command,
        argv.map((arg) => arg.replaceAll("com.manekipet.desktop", identity)),
        options,
      );
    },
  };
});
import { WindowsSystemNotifier } from "../src/system-notifier.js";

// 显式设备验收才产生真实系统通知；普通测试不会打扰用户或登记身份。
it.skipIf(
  process.platform !== "win32" || process.env.MANEKI_TOAST_ACCEPTANCE !== "1",
)(
  "Windows 使用本应用身份投递通知；拒绝时如实返回 blocked",
  async () => {
    try {
      const result = await new WindowsSystemNotifier().notify({
        id: "maneki-device-acceptance",
        title: "小招通知验收",
        body: '中文、<XML>、"引号"和 $() 均为文字数据。',
      });
      expect(
        result.status === "accepted" ||
          (result.status === "failed" &&
            result.code === "notifications_blocked"),
        JSON.stringify(result),
      ).toBe(true);
    } finally {
      execFileSync(
        "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('Software\\Classes\\AppUserModelId\\${identity}',$false)`,
        ],
        { windowsHide: true },
      );
    }
  },
  10000,
);
