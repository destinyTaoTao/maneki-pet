import { AssistantService } from "../../dist/assistant-service.js";

const stop = AssistantService.prototype.stop;
AssistantService.prototype.stop = async function () {
  await stop.call(this);
  throw new Error("private provider details");
};

await import("../../dist/cli.js");
// Windows 的 kill(SIGINT) 会直接杀进程，在该进程内向真实 CLI 处理器交付信号。
process.emit("SIGINT");
