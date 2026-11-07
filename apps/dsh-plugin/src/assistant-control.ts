import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export type ControlAction = "connect" | "pair" | "status" | "show" | "assistant" | "quit";
export interface ControlResult { state: "ready" | "stopped"; token?: string }

export const controlText: Record<string, string> = {
  not_installed: "请先安装并运行更新后的小招，登记本机启动入口",
  unsupported_platform: "本阶段管理入口仅支持 Windows",
  invalid_config: "助手配置或凭证损坏，请从受信本机入口检查",
  protocol_mismatch: "助手管理协议不兼容，请更新安装",
  identity_mismatch: "本机服务身份不符，已停止连接",
  runtime_unavailable: "共享 Runtime 未就绪，请检查安装或端口占用",
  timeout: "助手响应超时，请检查后台状态后重试",
  pairing_required: "尚未配对，请执行 /maneki pair 并在原生窗口确认",
  credential_rejected: "本 profile 凭证已撤销；请从本机管理入口处理后重新配对",
  pairing_busy: "另一个管理操作正在进行，请稍后重试",
  pairing_failed: "助手拒绝配对，请检查管理凭证",
  user_denied: "已取消，未授权本次操作",
};

export function installedExecutable(): string {
  if (process.platform !== "win32") throw new Error(controlText.unsupported_platform);
  if (!process.env.APPDATA) throw new Error(controlText.not_installed);
  try {
    const path = join(process.env.APPDATA, "com.manekipet.desktop", "installation.json");
    if (statSync(path).size > 8192) throw new Error();
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null || !("schemaVersion" in value) || value.schemaVersion !== 1 || !("protocolVersion" in value) || value.protocolVersion !== 1 || !("executable" in value) || typeof value.executable !== "string" || !isAbsolute(value.executable) || !value.executable.toLowerCase().endsWith(".exe") || !statSync(value.executable).isFile()) throw new Error();
    return value.executable;
  } catch { throw new Error(controlText.not_installed); }
}

/** 固定本机登记入口，无 shell、无项目可执行路径，无 root 凭证。 */
export async function controlAssistant(action: ControlAction, profileId: string, signal: AbortSignal): Promise<ControlResult> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(profileId)) throw new Error(controlText.invalid_config);
  const executable = installedExecutable();
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(executable, ["--assistant", action, "--client", profileId], { windowsHide: true, timeout: 120_000, maxBuffer: 16_384, signal }, (error, output) => {
      if (error && !output) reject(new Error(controlText.runtime_unavailable));
      else resolve(output);
    });
  });
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw new Error(controlText.protocol_mismatch); }
  if (typeof value !== "object" || value === null) throw new Error(controlText.protocol_mismatch);
  if ("error" in value) throw new Error(controlText[String(value.error)] ?? controlText.invalid_config);
  if (!("state" in value) || (value.state !== "ready" && value.state !== "stopped")) throw new Error(controlText.protocol_mismatch);
  if (action === "connect" || action === "pair") {
    if (!("token" in value) || typeof value.token !== "string" || !/^[A-Za-z0-9_-]{32,}$/.test(value.token)) throw new Error(controlText.protocol_mismatch);
    return { state: value.state, token: value.token };
  }
  return { state: value.state };
}
