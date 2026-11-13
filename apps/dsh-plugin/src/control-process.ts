import { spawn } from "node:child_process";

/** 原生入口退出且完整回执到达即可完成，后台服务可能继续持有继承的管道。 */
export function runControlProcess(executable: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, signal, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    let exited = false;
    let ended = false;
    let finished = false;
    const fail = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", fail);
      child.stdout.destroy();
      if (!exited) child.kill();
      reject(new Error("native_control_failed"));
    };
    const complete = () => {
      if (finished || !exited || (!ended && !output.endsWith("\n"))) return;
      if (signal.aborted || !output) return fail();
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", fail);
      child.stdout.destroy();
      resolve(output);
    };
    const timer = setTimeout(fail, 120_000);
    signal.addEventListener("abort", fail, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (finished) return;
      output += chunk;
      if (Buffer.byteLength(output, "utf8") > 16_384) return fail();
      complete();
    });
    child.stdout.on("end", () => { ended = true; complete(); });
    child.stdout.on("error", fail);
    child.on("error", fail);
    child.on("exit", (_code, terminationSignal) => {
      exited = true;
      if (terminationSignal) return fail();
      complete();
    });
  });
}
