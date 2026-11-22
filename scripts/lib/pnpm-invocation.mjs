import { existsSync } from "node:fs";
import { extname } from "node:path";

/** npm_execpath 在 Windows 可以是原生 pnpm 可执行文件。 */
export function pnpmInvocation(script, args) {
  const manager = process.env.npm_execpath;
  if (!manager || !existsSync(manager)) throw new Error(`Run with pnpm ${script}`);
  return extname(manager).toLowerCase() === ".exe"
    ? [manager, args]
    : [process.execPath, [manager, ...args]];
}
