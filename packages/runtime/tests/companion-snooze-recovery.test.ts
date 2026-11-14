import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startFetchCompatibleRuntime } from "./fetch-compatible-runtime.js";

it("budget corruption still permits safe snooze and the pause survives budget recovery", async () => {
  const dir=mkdtempSync(join(tmpdir(),"maneki-companion-snooze-recovery-"));
  const runtime=await startFetchCompatibleRuntime({configDir:dir});
  try {
    const store=runtime.store.assistantStore(), oldBudget=store.get("companion.budget");
    expect(oldBudget).not.toBeNull();
    const call=async(path:string,body?:unknown)=>{
      const response=await fetch(`http://127.0.0.1:${runtime.port}/v1/assistant${path}`,{method:body===undefined?"GET":"POST",headers:{authorization:`Bearer ${runtime.rootToken}`,"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
      return {status:response.status,body:await response.json() as Record<string,any>};
    };
    store.set("companion.budget","{}");
    const status=await call("/companion/status");expect(status.status).toBe(200);expect(status.body).toMatchObject({protocolVersion:1,companion:null,automaticBlock:"storage_unavailable"});
    const settings=await call("/settings");expect(settings.body.companion).toBeUndefined();
    const snooze=await call("/mutations",{requestId:"snooze-corrupt-budget",action:"companion.snooze",version:settings.body.version});expect(snooze.status).toBe(200);
    const until=snooze.body.murmurSnoozedUntil;expect(until).toBeGreaterThan(Date.now());
    store.set("companion.budget",oldBudget!);
    const recovered=await call("/companion/status");expect(recovered.body.companion).toMatchObject({murmurSnoozedUntil:until});expect(recovered.body.automaticBlock).toBe("snoozed");
    expect((await call("/settings")).body.companion.murmurSnoozedUntil).toBe(until);
  } finally { await runtime.stop();rmSync(dir,{recursive:true,force:true}); }
});
