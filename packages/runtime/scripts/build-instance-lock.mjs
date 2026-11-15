import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Native instance lock currently supports Windows x64 only; no PID-lock fallback is available.");
}
const nativeRoot = join(root, "native/instance-lock");
const build = spawnSync("cargo", ["build", "--release", "--locked", "--manifest-path", join(nativeRoot, "Cargo.toml")], { stdio: "inherit", windowsHide: true });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
const source = join(nativeRoot, "target/release/maneki_instance_lock.dll");
const target = join(nativeRoot, "maneki-instance-lock.node");
// Windows 不允许覆盖已装载的模块；相同构建无须重写。源码变化时仍明确失败，不用旧绑定冒充新构建。
if (!existsSync(target) || !readFileSync(source).equals(readFileSync(target))) copyFileSync(source, target);
const notices = spawnSync(process.execPath, [join(root, "scripts/instance-lock-notices.mjs"), "--check"], { stdio: "inherit", windowsHide: true });
if (notices.error) throw notices.error;
if (notices.status !== 0) process.exit(notices.status ?? 1);
