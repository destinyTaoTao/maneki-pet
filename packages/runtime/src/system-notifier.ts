import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { SystemNotifier } from "@maneki-pet/core";

// 固定程序，仅经 stdin 接收数据；文本节点避免文案变成 XML 或脚本。
const TOAST_SCRIPT = `
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.Encoding]::UTF8
try {
  $data=[Console]::In.ReadToEnd()|ConvertFrom-Json
  $identity=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\\Classes\\AppUserModelId\\com.manekipet.desktop')
  try { $identity.SetValue('DisplayName','小招 · Maneki') } finally { $identity.Dispose() }
  [Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]>$null
  [Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]>$null
  $document=New-Object System.Xml.XmlDocument
  $document.LoadXml('<toast><visual><binding template="ToastGeneric"><text></text><text></text></binding></visual><audio silent="true"/></toast>')
  $nodes=$document.GetElementsByTagName('text')
  $nodes[0].InnerText=[string]$data.title
  $nodes[1].InnerText=[string]$data.body
  $xml=New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml($document.OuterXml)
  $toast=[Windows.UI.Notifications.ToastNotification]::new($xml)
  $toast.Tag=[string]$data.id
  $toast.Group='maneki-reminders'
  $notifier=[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('com.manekipet.desktop')
  # 首次登记的身份在 Show 前读取 Setting 可能返回 ELEMENT_NOT_FOUND。
  # Show 自身遵守 OS 通知策略；之后读取权限，不能把被阻止的调用报告为受理。
  $notifier.Show($toast)
  $setting=$notifier.GetType().GetProperty('Setting').GetValue($notifier)
  if ($null -eq $setting) { throw 'notification permission unavailable' }
  if ($setting.ToString() -ne 'Enabled') { [Console]::Write('{"status":"failed","code":"notifications_blocked"}'); exit }
  [Console]::Write('{"status":"accepted"}')
} catch { [Console]::Write('{"status":"failed","code":"system_notification_failed"}') }
`;
export class WindowsSystemNotifier implements SystemNotifier {
  async notify(input: { id: string; title: string; body: string }) {
    if (process.platform !== "win32")
      return { status: "failed" as const, code: "unsupported_platform" };
    return new Promise<{ status: "accepted" | "failed"; code?: string }>(
      (resolve) => {
        const child = spawn(
          join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32/WindowsPowerShell/v1.0/powershell.exe",
          ),
          [
            "-NoProfile",
            "-NonInteractive",
            "-NoLogo",
            "-Command",
            TOAST_SCRIPT,
          ],
          { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
        );
        let stdout = "";
        let settled = false;
        const finish = (result: {
          status: "accepted" | "failed";
          code?: string;
        }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => {
          child.kill();
          finish({ status: "failed", code: "notification_timeout" });
        }, 6000);
        child.on("error", () =>
          finish({ status: "failed", code: "system_notification_failed" }),
        );
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          if (stdout.length > 4096) {
            child.kill();
            finish({ status: "failed", code: "system_notification_failed" });
          }
        });
        child.on("close", () => {
          try {
            const result = JSON.parse(stdout) as {
              status?: string;
              code?: string;
            };
            finish(
              result.status === "accepted"
                ? { status: "accepted" }
                : {
                    status: "failed",
                    code:
                      result.code === "notifications_blocked"
                        ? result.code
                        : "system_notification_failed",
                  },
            );
          } catch {
            finish({ status: "failed", code: "system_notification_failed" });
          }
        });
        child.stdin.on("error", () =>
          finish({ status: "failed", code: "system_notification_failed" }),
        );
        child.stdin.end(
          JSON.stringify({
            id: createHash("sha256")
              .update(input.id)
              .digest("hex")
              .slice(0, 16),
            title: input.title.slice(0, 120),
            body: input.body.slice(0, 2500),
          }),
        );
      },
    );
  }
}
