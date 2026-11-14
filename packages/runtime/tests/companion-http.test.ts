import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect,it,vi } from "vitest";
import { AssistantError, defaultAssistantSettings } from "../src/assistant-settings.js";
import { AssistantStore } from "../src/assistant-store.js";
import { startFetchCompatibleRuntime } from "./fetch-compatible-runtime.js";

it("authenticated display and silent manual say honor schemas, identity, idempotency and limits",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"maneki-companion-http-"));const runtime=await startFetchCompatibleRuntime({configDir:dir});let ws:WebSocket|undefined;
 try {
  const base=`http://127.0.0.1:${runtime.port}`;
  const call=async(path:string,token:string,body?:unknown,method=body===undefined?"GET":"POST")=>{
   const response=await fetch(base+path,{method,headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json() as any};
  };
  const pair=async(scopes:string)=>(await call("/v1/pair",runtime.rootToken,{name:"fixture",scopes})).body;
  const client=await pair("assistant,settings"),observer=await pair("express"),assistantOnly=await pair("assistant"),admin=runtime.rootToken;
  const status=await call("/v1/assistant/companion/status",client.token);expect(status.status).toBe(200);expect(status.body.automaticBlock).toBe("no_display");
  expect((await call("/v1/assistant/companion/status",observer.token)).status).toBe(403);
  const ticket=(await call("/v1/ws-ticket",client.token,{})).body.ticket;
  ws=new WebSocket(base.replace("http","ws")+"/v1/events");const messages:any[]=[];
  ws.addEventListener("message",e=>messages.push(JSON.parse(String(e.data))));await new Promise<void>((resolve,reject)=>{ws!.addEventListener("open",()=>{ws!.send(JSON.stringify({type:"auth",ticket}));resolve();});ws!.addEventListener("error",()=>reject(Error("websocket failed")));});
  await expect.poll(()=>messages.find(m=>m.type==="ready")).toBeTruthy();const ready=messages.find(m=>m.type==="ready");
  const acquire={protocolVersion:1,runtimeEpoch:ready.runtimeEpoch,connectionId:ready.connectionId,displayInstanceId:randomUUID(),state:{visible:true,busyReasons:[],activitySeq:0}};
  const url="/v1/assistant/companion/display/acquire";
  expect((await call(url,admin,acquire)).status).toBe(403);
  expect((await call(url,client.token,{...acquire,unknown:true})).status).toBe(400);
  const lease=await call(url,client.token,acquire);expect(lease.status).toBe(200);
  expect((await call("/v1/assistant/companion/status",client.token)).body.automaticBlock).toBe("warming_up");
  expect((await call("/v1/dnd",client.token,{enabled:true})).status).toBe(200);
  expect((await call("/v1/assistant/companion/status",client.token)).body.automaticBlock).toBe("dnd");
  const request={protocolVersion:1,runtimeEpoch:ready.runtimeEpoch,leaseId:lease.body.leaseId,requestId:"say1",requestSeq:1};
  const first=await call("/v1/assistant/companion/say",client.token,request);expect(first.status).toBe(200);expect(first.body.utterance.mode).toBe("manual");
  expect((await call("/v1/assistant/companion/say",client.token,request)).body).toEqual(first.body);
  expect((await call("/v1/assistant/companion/say",client.token,{...request,requestId:"other"})).status).toBe(409);
  expect((await call("/v1/assistant/companion/say",observer.token,request)).status).toBe(403);
  const ack={protocolVersion:1,runtimeEpoch:ready.runtimeEpoch,leaseId:lease.body.leaseId,utteranceId:first.body.utterance.utteranceId,result:"displayed"};
  expect((await call("/v1/assistant/companion/ack",client.token,ack)).status).toBe(200);
  expect((await call("/v1/assistant/companion/ack",client.token,{...ack,result:"discarded"})).status).toBe(409);
  const version=(await call("/v1/assistant/settings",client.token)).body.version;
  const snooze={requestId:"snooze1",action:"companion.snooze",version};
  expect((await call("/v1/assistant/mutations",assistantOnly.token,snooze)).status).toBe(403);
  const firstSnooze=await call("/v1/assistant/mutations",client.token,snooze);expect(firstSnooze.status).toBe(200);
  const repeat=await call("/v1/assistant/mutations",client.token,snooze);expect(repeat.status).toBe(200);expect(repeat.body).toEqual(firstSnooze.body);
  expect((await call("/v1/assistant/mutations",client.token,{...snooze,version:version+1})).body.error).toBe("request_id_conflict");
  expect((await call("/v1/assistant/settings",client.token)).body.version).toBe(version+1);
 }finally{vi.restoreAllMocks();ws?.close();await runtime.stop();rmSync(dir,{recursive:true,force:true});}
});

it.each(["write","commit"] as const)("snooze %s failure rolls back, returns 503, and announces degraded health",async failure=>{
 const dir=mkdtempSync(join(tmpdir(),"maneki-companion-failure-"));const runtime=await startFetchCompatibleRuntime({configDir:dir});
 const events=vi.fn();runtime.feed.subscribe(events);
 try {
  const base=`http://127.0.0.1:${runtime.port}`;const call=async(path:string,body?:unknown)=>{const res=await fetch(base+path,{method:body===undefined?"GET":"POST",headers:{authorization:`Bearer ${runtime.rootToken}`,"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,body:await res.json() as any};};
  const initial=(await call("/v1/assistant/settings")).body;await call("/v1/assistant/companion/status");
  const before=runtime.store.assistantStore().get("companion.preferences");
  if(failure==="write"){
   const old=AssistantStore.prototype.set;vi.spyOn(AssistantStore.prototype,"set").mockImplementation(function(this:AssistantStore,key,value){if(key==="settings")throw Error("fixture write");return old.call(this,key,value);});
  } else {
   const old=AssistantStore.prototype.transaction;vi.spyOn(AssistantStore.prototype,"transaction").mockImplementation(function(this:AssistantStore,body:any){return old.call(this,()=>{body();throw Error("fixture commit");});});
  }
  const failed=await call("/v1/assistant/mutations",{requestId:"fail",action:"companion.snooze",version:initial.version});
  expect(failed).toEqual({status:503,body:{error:"companion_state_unavailable"}});
  const healthEvent=events.mock.calls.filter(c=>c[0].kind==="assistant.companion.policy").at(-1)?.[0].payload;vi.restoreAllMocks();
  expect(runtime.store.assistantStore().get("companion.preferences")).toBe(before);
  expect((await call("/v1/assistant/settings")).body.version).toBe(initial.version);
  expect((await call("/v1/assistant/companion/status")).body.automaticBlock).toBe("storage_unavailable");
  expect(healthEvent).toMatchObject({healthy:false,companion:null});
  expect((await call("/v1/assistant/snapshot")).status).toBe(200);
  expect((await call("/v1/assistant/mutations",{requestId:"conflict",action:"companion.snooze",version:initial.version+1})).body.error).toBe("settings_conflict");
 }finally{vi.restoreAllMocks();await runtime.stop();rmSync(dir,{recursive:true,force:true});}
});

it("snooze with corrupt preferences broadcasts unhealthy immediately while preserving its 503",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"maneki-companion-corrupt-"));const runtime=await startFetchCompatibleRuntime({configDir:dir});
 const events=vi.fn();runtime.feed.subscribe(events);
 try {
  const base=`http://127.0.0.1:${runtime.port}`;
  const call=async(path:string,body?:unknown)=>{const res=await fetch(base+path,{method:body===undefined?"GET":"POST",headers:{authorization:`Bearer ${runtime.rootToken}`,"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,body:await res.json() as any};};
  const settings=(await call("/v1/assistant/settings")).body;
  await call("/v1/assistant/companion/status");
  runtime.store.assistantStore().set("companion.preferences","{}");
  const failed=await call("/v1/assistant/mutations",{requestId:"corrupt",action:"companion.snooze",version:settings.version});
  expect(failed).toEqual({status:503,body:{error:"companion_state_unavailable"}});
  expect(events.mock.calls.filter(c=>c[0].kind==="assistant.companion.policy").at(-1)?.[0].payload).toMatchObject({healthy:false,companion:null});
  expect((await call("/v1/assistant/settings")).body.version).toBe(settings.version);
  expect(runtime.store.assistantStore().mutation("root","corrupt")).toBeUndefined();
 }finally{await runtime.stop();rmSync(dir,{recursive:true,force:true});}
});

it("chat replies preserve a verified reference and retry after it expires without writing twice", async()=>{
 const dir=mkdtempSync(join(tmpdir(),"maneki-chat-quote-"));let runtime=await startFetchCompatibleRuntime({configDir:dir});let ws:WebSocket|undefined;
 try{
  let base=`http://127.0.0.1:${runtime.port}`;
  const call=async(path:string,token:string,body?:unknown)=>{const response=await fetch(base+path,{method:body===undefined?"GET":"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json() as any};};
  const client=(await call("/v1/pair",runtime.rootToken,{name:"reply",scopes:"assistant,settings"})).body;
  const other=(await call("/v1/pair",runtime.rootToken,{name:"other",scopes:"assistant"})).body;
  const ticket=(await call("/v1/ws-ticket",client.token,{})).body.ticket;
  ws=new WebSocket(base.replace("http","ws")+"/v1/events");const messages:any[]=[];
  ws.addEventListener("message",e=>messages.push(JSON.parse(String(e.data))));
  await new Promise<void>((resolve,reject)=>{ws!.addEventListener("open",()=>{ws!.send(JSON.stringify({type:"auth",ticket}));resolve();});ws!.addEventListener("error",()=>reject(Error("ws")));});
  await expect.poll(()=>messages.find(m=>m.type==="ready")).toBeTruthy();const ready=messages.find(m=>m.type==="ready");const displayInstanceId=randomUUID();
  const lease=(await call("/v1/assistant/companion/display/acquire",client.token,{protocolVersion:1,runtimeEpoch:ready.runtimeEpoch,connectionId:ready.connectionId,displayInstanceId,state:{visible:true,busyReasons:[],activitySeq:0}})).body;
  const utterance=(await call("/v1/assistant/companion/say",client.token,{protocolVersion:1,runtimeEpoch:ready.runtimeEpoch,leaseId:lease.leaseId,requestId:"say",requestSeq:1})).body.utterance;
  const replyTo={runtimeEpoch:ready.runtimeEpoch,displayInstanceId,utteranceId:utterance.utteranceId};
  expect((await call("/v1/assistant/chat",other.token,{requestId:"foreign",text:"你好",companionReplyTo:replyTo})).status).toBe(404);
  for(const invalid of [null,{}, {...replyTo, extra:true}, {...replyTo,utteranceId:"invalid"}])
   expect((await call("/v1/assistant/chat",client.token,{requestId:"bad",text:"你好",companionReplyTo:invalid})).status).toBe(400);
  expect((await call("/v1/assistant/chat",runtime.rootToken,{requestId:"admin",text:"你好",companionReplyTo:replyTo})).status).toBe(403);
  const originalSet=AssistantStore.prototype.set;
  vi.spyOn(AssistantStore.prototype,"set").mockImplementation(function(this:AssistantStore,key,value){if(key.startsWith("companion.reference."))throw Error("fixture");return originalSet.call(this,key,value);});
  expect((await call("/v1/assistant/chat",client.token,{requestId:"rollback",text:"你好",companionReplyTo:replyTo})).status).toBe(500);
  vi.restoreAllMocks();expect((await call("/v1/assistant/snapshot",client.token)).body.messages).toHaveLength(0);
  expect((await call("/v1/assistant/chat/rollback",client.token)).status).toBe(404);
  const request={requestId:"reply",text:"我也这么想",companionReplyTo:replyTo};
  expect((await call("/v1/assistant/chat",client.token,request)).status).toBe(202);
  await expect.poll(async()=>(await call("/v1/assistant/chat/reply",client.token)).body.status).toBe("completed");
  const before=(await call("/v1/assistant/snapshot",client.token)).body.messages;expect(before[0].companionReference.text).toBe(utterance.text);
  vi.spyOn(runtime.assistant.companion!,"resolveReference").mockImplementation(()=>{throw new AssistantError(410,"companion_reference_expired");});
  expect((await call("/v1/assistant/chat",client.token,request)).status).toBe(202);
  expect((await call("/v1/assistant/chat",client.token,{...request,text:"不同文本"})).body.error).toBe("request_id_conflict");
  expect((await call("/v1/assistant/chat",client.token,{...request,requestId:"new"})).status).toBe(410);
  expect((await call("/v1/assistant/snapshot",client.token)).body.messages).toHaveLength(before.length);
  vi.restoreAllMocks();ws.close();ws=undefined;await runtime.stop();runtime=await startFetchCompatibleRuntime({configDir:dir});base=`http://127.0.0.1:${runtime.port}`;
  expect((await call("/v1/assistant/chat",client.token,request)).status).toBe(202);
  expect((await call("/v1/assistant/chat",client.token,{...request,requestId:"after-restart"})).body.error).toBe("companion_epoch_changed");
  expect((await call("/v1/assistant/snapshot",client.token)).body.messages).toHaveLength(before.length);
  const preview=(await call("/v1/assistant/clear-preview",client.token,{scope:"history"})).body;
  expect((await call("/v1/assistant/clear",client.token,{confirmationId:preview.confirmationId})).status).toBe(200);
  const retried=await call("/v1/assistant/chat",client.token,request);expect(retried.status).toBe(202);expect(retried.body.status).toBe("cleared");
  expect((await call("/v1/assistant/snapshot",client.token)).body.messages).toHaveLength(0);


 }finally{vi.restoreAllMocks();ws?.close();await runtime.stop();rmSync(dir,{recursive:true,force:true});}
});

it("first-time invalid and expired references are checked before a busy chat", async()=>{
 const dir=mkdtempSync(join(tmpdir(),"maneki-quote-busy-"));let release:(value:any)=>void=()=>{};
 const runtime=await startFetchCompatibleRuntime({configDir:dir,chatProvider:()=>({info:{id:"fixture",apiVersion:1,locality:"local"},reply:()=>new Promise(resolve=>{release=resolve;})})});
 try{
  const base=`http://127.0.0.1:${runtime.port}`;const call=async(path:string,token:string,body?:unknown,method=body===undefined?"GET":"POST")=>{const response=await fetch(base+path,{method,headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json() as any};};
  const token=(await call("/v1/pair",runtime.rootToken,{name:"busy",scopes:"assistant,settings"})).body.token;
  const {schemaVersion:_,...settings}=defaultAssistantSettings();settings.chat={...settings.chat,enabled:true,baseUrl:"http://127.0.0.1:1/v1",model:"fixture"};
  expect((await call("/v1/assistant/settings",token,settings,"PUT")).status).toBe(200);
  expect((await call("/v1/assistant/chat",token,{requestId:"busy",text:"你好"})).status).toBe(202);
  await expect.poll(()=>release.toString()).not.toContain("=>{}");
  const status=(await call("/v1/assistant/companion/status",token)).body;
  const quote={runtimeEpoch:status.runtimeEpoch,displayInstanceId:randomUUID(),utteranceId:randomUUID()};
  expect((await call("/v1/assistant/chat",token,{requestId:"invalid",text:"你好",companionReplyTo:quote})).body.error).toBe("companion_reference_not_found");
  vi.spyOn(runtime.assistant.companion!,"resolveReference").mockImplementation(()=>{throw new AssistantError(410,"companion_reference_expired");});
  expect((await call("/v1/assistant/chat",token,{requestId:"expired",text:"你好",companionReplyTo:quote})).body.error).toBe("companion_reference_expired");
 }finally{vi.restoreAllMocks();release({text:"完成",usage:{inputTokens:10,outputTokens:10}});await runtime.stop();rmSync(dir,{recursive:true,force:true});}
});

it("startup removes old-runtime orphan references while preserving unknown format keys",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"maneki-quote-upgrade-"));let runtime=await startFetchCompatibleRuntime({configDir:dir});
 try{
  const store=runtime.store.assistantStore();const seq=store.append("user","旧消息");
  store.set(`companion.reference.0.${seq}`,JSON.stringify({formatVersion:1,epoch:0,userSeq:seq,utteranceId:randomUUID(),text:"旧引用",mode:"manual",createdAt:1}));
  const orphan=store.get(`companion.reference.0.${seq}`)!;
  store.transaction(()=>store.clearHistory());
  store.set(`companion.reference.0.${seq}`,orphan); // 旧版不认识引用键。
  store.set("companion.reference.0.999",JSON.stringify({formatVersion:2,epoch:0,userSeq:999}));
  await runtime.stop();runtime=await startFetchCompatibleRuntime({configDir:dir});
  const reloaded=runtime.store.assistantStore();expect(reloaded.get(`companion.reference.0.${seq}`)).toBeNull();
  expect(reloaded.get("companion.reference.0.999")).toContain('"formatVersion":2');expect(reloaded.messages()).toEqual([]);
 }finally{await runtime.stop();rmSync(dir,{recursive:true,force:true});}
});
