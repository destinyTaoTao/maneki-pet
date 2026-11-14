import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { CompanionClient } from "../../../apps/desktop/src/companion-client.js";
import { AssistantClientError } from "../../../apps/desktop/src/assistant-client.js";
import { startFetchCompatibleRuntime } from "./fetch-compatible-runtime.js";

it("desktop client uses a real isolated Runtime for lease, DND, manual display, ACK and quoted chat", async () => {
  const dir = mkdtempSync(join(tmpdir(), "maneki-companion-wire-"));
  const notify = vi.fn().mockResolvedValue({status:"accepted"});
  const runtime = await startFetchCompatibleRuntime({ configDir: dir, notifier: { notify } });
  const sockets: WebSocket[] = [];
  let client: CompanionClient | undefined;
  try {
    const base = `http://127.0.0.1:${runtime.port}`;
    const call = async (path:string, token:string, body?:unknown) => {
      const response = await fetch(base+path, { method:body===undefined?"GET":"POST", headers:{authorization:`Bearer ${token}`,"content-type":"application/json"}, ...(body===undefined?{}:{body:JSON.stringify(body)}) });
      const value = await response.json() as Record<string,any>;
      return {status:response.status,body:value};
    };
    const paired = (await call("/v1/pair",runtime.rootToken,{name:"wire",scopes:"assistant,settings"})).body;
    const token = paired.token as string;
    const connect = async () => {
      const ticket = (await call("/v1/ws-ticket",token,{})).body.ticket;
      const socket = new WebSocket(base.replace("http","ws")+"/v1/events"); sockets.push(socket);
      const messages:Record<string,any>[] = [];
      socket.addEventListener("message", event => {const m=JSON.parse(String(event.data));messages.push(m);if(m.type==="event"&&client)client.onEvent(m.event);});
      await new Promise<void>((resolve,reject)=>{socket.addEventListener("open",()=>{socket.send(JSON.stringify({type:"auth",ticket}));resolve();});socket.addEventListener("error",()=>reject(Error("socket failed")));});
      await expect.poll(()=>messages.find(m=>m.type==="ready")).toBeTruthy();
      return {socket,messages,ready:messages.find(m=>m.type==="ready")!};
    };
    const a = await connect(); const b = await connect();
    const acknowledgements:unknown[]=[]; const rendered:Record<string,any>[]=[];
    client = new CompanionClient({
      call: async(path,body)=>{const result=await call(`/v1/assistant${path}`,token,body);if(path==="/companion/ack")acknowledgements.push({body,status:result.status});if(result.status!==200)throw new AssistantClientError(String(result.body.error),result.status);return result.body;},
      show:u=>{rendered.push(u);return true;},beforeShow:async()=>true,reconnect:()=>{},wallNow:Date.now,monoNow:()=>performance.now(),
    });
    client.setDisplayState({visible:true,busyReasons:[],activitySeq:0});
    await client.connected(a.ready);
    expect(client.isReady()).toBe(true);
    // Only advance the isolated fixture's persisted warmup; production timing is unchanged.
    const store=runtime.store.assistantStore();
    store.transaction(()=>{const budget=JSON.parse(store.get("companion.budget")!);budget.firstEligibleAt=Date.now()-7200000;store.set("companion.budget",JSON.stringify(budget));});
    runtime.assistant.companion!.wake();
    await expect.poll(()=>rendered.length).toBe(1);
    expect(rendered[0]!.mode).toBe("automatic");
    expect(a.messages.filter(m=>m.type==="event"&&m.event?.kind==="assistant.companion")).toHaveLength(1);
    expect(b.messages.filter(m=>m.type==="event"&&m.event?.kind==="assistant.companion")).toHaveLength(0);
    expect((await call("/v1/dnd",token,{enabled:true})).status).toBe(200);
    await expect.poll(async()=>(await call("/v1/assistant/companion/status",token)).body.dnd).toBe(true);
    const result=await client.say();
    expect(result.utterance.mode).toBe("manual");expect(rendered).toHaveLength(2);
    await expect.poll(()=>acknowledgements.length).toBe(2);
    expect(acknowledgements[1]).toMatchObject({status:200,body:{result:"displayed"}});
    const u=result.utterance, companionReplyTo={runtimeEpoch:u.runtimeEpoch,displayInstanceId:u.displayInstanceId,utteranceId:u.utteranceId};
    const request={requestId:"desktop-reply",text:"你好，小招",companionReplyTo};
    expect((await call("/v1/assistant/chat",token,request)).status).toBe(202);
    await expect.poll(async()=>(await call("/v1/assistant/chat/desktop-reply",token)).body.status).toBe("completed");
    const snapshot=(await call("/v1/assistant/snapshot",token)).body;
    expect(snapshot.messages[0].companionReference.text).toBe(u.text);
    expect((await call("/v1/assistant/chat",token,request)).status).toBe(202);
    expect((await call("/v1/assistant/snapshot",token)).body.messages).toHaveLength(snapshot.messages.length);
    expect(b.messages.filter(m=>m.type==="event"&&m.event?.kind==="assistant.companion")).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  } finally { client?.dispose();for(const socket of sockets)socket.close();await runtime.stop();rmSync(dir,{recursive:true,force:true}); }
}, 20000);

it("automatic claim survives a failed send and Runtime restart without replay", async () => {
  const dir=mkdtempSync(join(tmpdir(),"maneki-companion-restart-"));
  let runtime=await startFetchCompatibleRuntime({configDir:dir});
  let socket:WebSocket|undefined;
  try {
    let base=`http://127.0.0.1:${runtime.port}`;
    const call=async(path:string,token:string,body?:unknown)=>{
      const response=await fetch(base+path,{method:body===undefined?"GET":"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
      return {status:response.status,body:await response.json() as Record<string,any>};
    };
    const token=(await call("/v1/pair",runtime.rootToken,{name:"restart",scopes:"assistant,settings"})).body.token as string;
    const open=async()=>{
      const ticket=(await call("/v1/ws-ticket",token,{})).body.ticket;
      socket=new WebSocket(base.replace("http","ws")+"/v1/events");const messages:Record<string,any>[]=[];
      socket.addEventListener("message",event=>messages.push(JSON.parse(String(event.data))));
      await new Promise<void>((resolve,reject)=>{socket!.addEventListener("open",()=>{socket!.send(JSON.stringify({type:"auth",ticket}));resolve();});socket!.addEventListener("error",()=>reject(Error("socket failed")));});
      await expect.poll(()=>messages.some(m=>m.type==="ready")).toBe(true);
      return {ready:messages.find(m=>m.type==="ready")!,messages};
    };
    const acquire=async(ready:Record<string,any>)=>call("/v1/assistant/companion/display/acquire",token,{protocolVersion:1,runtimeEpoch:ready.runtimeEpoch,connectionId:ready.connectionId,displayInstanceId:crypto.randomUUID(),state:{visible:true,busyReasons:[],activitySeq:0}});
    const first=await open();expect((await acquire(first.ready)).status).toBe(200);
    const db=runtime.store.assistantStore();
    db.transaction(()=>{const b=JSON.parse(db.get("companion.budget")!);b.firstEligibleAt=Date.now()-7200000;db.set("companion.budget",JSON.stringify(b));});
    const oldPublish=runtime.feed.publish.bind(runtime.feed);let attempted=0;
    vi.spyOn(runtime.feed,"publish").mockImplementation((kind,payload,audience)=>{if(kind==="assistant.companion"){attempted++;throw Error("simulated delivery failure");}return oldPublish(kind,payload,audience);});
    runtime.assistant.companion!.wake();
    expect(attempted).toBe(1);
    const original=JSON.parse(db.get("companion.budget")!);expect(original.attempts).toHaveLength(1);
    vi.restoreAllMocks();socket?.close();socket=undefined;await runtime.stop();
    runtime=await startFetchCompatibleRuntime({configDir:dir});base=`http://127.0.0.1:${runtime.port}`;
    expect(JSON.parse(runtime.store.assistantStore().get("companion.budget")!).attempts).toEqual(original.attempts);
    const second=await open();expect((await acquire(second.ready)).status).toBe(200);
    expect(second.messages.filter(m=>m.type==="event"&&m.event?.kind==="assistant.companion")).toHaveLength(0);
    expect((await call("/v1/assistant/companion/status",token)).body.automaticBlock).toBe("budget");
    expect(JSON.parse(runtime.store.assistantStore().get("companion.budget")!).attempts).toHaveLength(1);
  } finally {vi.restoreAllMocks();socket?.close();await runtime.stop();rmSync(dir,{recursive:true,force:true});}
}, 20000);

it("legacy settings PUT and v6 restart preserve companion preference and delivered reminder", async () => {
  const dir=mkdtempSync(join(tmpdir(),"maneki-companion-legacy-"));
  let runtime=await startFetchCompatibleRuntime({configDir:dir});
  try {
    let base=`http://127.0.0.1:${runtime.port}`;
    const call=async(path:string,body?:unknown,method=body===undefined?"GET":"PUT")=>{
      const response=await fetch(base+path,{method,headers:{authorization:`Bearer ${runtime.rootToken}`,"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
      return {status:response.status,body:await response.json() as Record<string,any>};
    };
    const db=runtime.store.assistantStore();
    db.saveReminder({id:"delivered",todoId:null,message:"fixture",remindAt:100,timeZone:"UTC",status:"accepted",attempts:1,code:null,version:2});
    const original=db.reminders();
    const input=(view:Record<string,any>)=>({version:view.version,timeZone:view.timeZone,persona:view.persona,cloudEnabled:view.cloudEnabled,chat:{enabled:view.chat.enabled,locality:view.chat.locality,baseUrl:view.chat.baseUrl,model:view.chat.model,maxInputTokens:view.chat.maxInputTokens,maxOutputTokens:view.chat.maxOutputTokens}});
    const settings=(await call("/v1/assistant/settings")).body;
    expect((await call("/v1/assistant/settings",{...input(settings),companion:{murmurEnabled:false}})).status).toBe(200);
    const updated=(await call("/v1/assistant/settings")).body;
    expect((await call("/v1/assistant/settings",input(updated))).status).toBe(200);
    expect((await call("/v1/assistant/settings")).body.companion.murmurEnabled).toBe(false);
    expect(db.reminders()).toEqual(original);
    await runtime.stop();runtime=await startFetchCompatibleRuntime({configDir:dir});base=`http://127.0.0.1:${runtime.port}`;
    expect((await call("/v1/assistant/settings")).body.companion.murmurEnabled).toBe(false);
    expect(runtime.store.assistantStore().reminders()).toEqual(original);
  } finally {await runtime.stop();rmSync(dir,{recursive:true,force:true});}
},20000);
