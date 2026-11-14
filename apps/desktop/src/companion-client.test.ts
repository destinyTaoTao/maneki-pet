import { afterEach, expect, it, vi } from "vitest";
import { CompanionClient } from "./companion-client.js";
import { CompanionBubble } from "./companion-bubble.js";
import { AssistantClientError } from "./assistant-client.js";
import type { CompanionUtterance } from "@maneki-pet/core";
const epoch="11111111-1111-4111-8111-111111111111", connection="22222222-2222-4222-8222-222222222222", leaseId="33333333-3333-4333-8333-333333333333";
const status={protocolVersion:1,runtimeEpoch:epoch,serverNow:1000,policyRevision:0,settingsVersion:1,historyEpoch:0,dnd:false,companion:{murmurEnabled:true,murmurSnoozedUntil:null},automaticBlock:null,nextEligibleAt:null,limits:{minIntervalMs:7200000,maxPerLocalDay:4,maxPerRolling24h:4,leaseMs:15000,renewEveryMs:5000,candidateTtlMs:15000,replyTtlMs:600000}};
afterEach(()=>vi.useRealTimers());
function setup(){vi.useFakeTimers();vi.setSystemTime(1000);let instance="";const show=vi.fn((_utterance:CompanionUtterance)=>true),reconnect=vi.fn();const call=vi.fn(async(path:string,body?:any):Promise<unknown>=>{if(path==="/companion/status")return status;if(path==="/companion/display/acquire"){instance=body.displayInstanceId;return {runtimeEpoch:epoch,connectionId:connection,displayInstanceId:instance,leaseId,stateSeq:0,serverNow:1000,expiresAt:16000,leaseMs:15000,policyRevision:0};}if(path==="/companion/display/renew")return {runtimeEpoch:epoch,connectionId:connection,displayInstanceId:instance,leaseId,stateSeq:body.stateSeq,serverNow:Date.now(),expiresAt:Date.now()+15000,leaseMs:15000,policyRevision:0};return {recorded:true};});const client=new CompanionClient({call,show,reconnect,wallNow:Date.now,monoNow:()=>Date.now()});return {client,call,show,reconnect,instance:()=>instance};}
it("old ready and old runtime never register displays",async()=>{const {client,call}=setup();await client.connected({});expect(call).not.toHaveBeenCalled();call.mockRejectedValueOnce(new AssistantClientError("not_found"));await client.connected({connectionId:connection,runtimeEpoch:epoch});expect(call).toHaveBeenCalledTimes(1);client.dispose();});
it("accepts only matching active lease, state and policy; busy blocks locally",async()=>{const {client,show,instance}=setup();client.setDisplayState({visible:true,busyReasons:[],activitySeq:0});await client.connected({connectionId:connection,runtimeEpoch:epoch});const payload={protocolVersion:1,runtimeEpoch:epoch,connectionId:connection,displayInstanceId:instance(),leaseId,utteranceId:crypto.randomUUID(),mode:"automatic",templateId:"a",theme:"a",text:"你好",actionId:null,createdAt:1000,expiresAt:16000,replyExpiresAt:601000,displayStateSeq:0,policyRevision:0,settingsVersion:1,historyEpoch:0,displayDurationMs:6000};client.onEvent({eventId:"1",occurredAt:"",kind:"assistant.companion",payload});expect(show).toHaveBeenCalledTimes(1);client.onEvent({eventId:"1",occurredAt:"",kind:"assistant.companion",payload});expect(show).toHaveBeenCalledTimes(1);client.setDisplayState({visible:true,busyReasons:["voice"],activitySeq:1});client.onEvent({eventId:"2",occurredAt:"",kind:"assistant.companion",payload:{...payload,utteranceId:crypto.randomUUID()}});expect(show).toHaveBeenCalledTimes(1);client.dispose();});
it("invalidates on suspended time gap and requests fresh socket",async()=>{const {client,reconnect}=setup();client.setDisplayState({visible:true,busyReasons:[],activitySeq:0});await client.connected({connectionId:connection,runtimeEpoch:epoch});vi.setSystemTime(21000);client.checkClock();expect(reconnect).toHaveBeenCalledOnce();client.dispose();});

it("403 status reports authorization failure without registering or treating it as unsupported",async()=>{const {client,call}=setup();call.mockRejectedValueOnce(new AssistantClientError("assistant_scope_required"));await client.connected({connectionId:connection,runtimeEpoch:epoch});expect(call).toHaveBeenCalledTimes(1);expect(client.isReady()).toBe(false);client.dispose();});
it("a policy event that overtakes status cannot be rolled back by the old response",async()=>{
 vi.useFakeTimers();vi.setSystemTime(1000);let finish:(v:unknown)=>void=()=>undefined;const policy=vi.fn(),show=vi.fn(()=>true);let display="";
 const call=vi.fn(async(path:string,body?:any):Promise<unknown>=>{if(path==="/companion/status")return await new Promise(resolve=>{finish=resolve;});if(path==="/companion/display/acquire"){display=body.displayInstanceId;return {runtimeEpoch:epoch,connectionId:connection,displayInstanceId:display,leaseId,stateSeq:0,serverNow:1000,expiresAt:16000,leaseMs:15000,policyRevision:2};}return {recorded:true};});
 const c=new CompanionClient({call,show,reconnect:vi.fn(),wallNow:Date.now,monoNow:()=>Date.now(),onPolicy:policy});c.setDisplayState({visible:true,busyReasons:[],activitySeq:0});const connecting=c.connected({connectionId:connection,runtimeEpoch:epoch});
 c.onEvent({eventId:"p",occurredAt:"",kind:"assistant.companion.policy",payload:{runtimeEpoch:epoch,policyRevision:2,settingsVersion:2,historyEpoch:0,dnd:true,companion:status.companion,healthy:true}});finish(status);await connecting;
 expect(policy).toHaveBeenCalledTimes(1);expect(policy.mock.lastCall?.[0].dnd).toBe(true);c.dispose();
});
it("manual request retries use the same id and sequence, and suppress superseded automatic messages",async()=>{
 const {client,call,show,instance}=setup();client.setDisplayState({visible:true,busyReasons:[],activitySeq:0});await client.connected({connectionId:connection,runtimeEpoch:epoch});const id=crypto.randomUUID(),auto=crypto.randomUUID();
 const payload={protocolVersion:1 as const,runtimeEpoch:epoch,displayInstanceId:instance(),leaseId,utteranceId:id,mode:"manual" as const,templateId:"a",theme:"a",text:"你好",actionId:null,createdAt:1000,expiresAt:16000,replyExpiresAt:601000,displayStateSeq:0,policyRevision:0,settingsVersion:1,historyEpoch:0,displayDurationMs:6000 as const};
 let first=true;call.mockImplementation(async(path)=>{if(path==="/companion/say"){if(first){first=false;throw new AssistantClientError("runtime_unavailable");}return {utterance:payload,supersedes:[auto]};}return {recorded:true};});
 await expect(client.say()).rejects.toThrow();await client.say();const requests=call.mock.calls.filter(a=>a[0]==="/companion/say").map(a=>a[1]);expect(requests[0]).toEqual(requests[1]);expect(show).toHaveBeenCalledTimes(1);
 client.onEvent({eventId:"late",occurredAt:"",kind:"assistant.companion",payload:{...payload,mode:"automatic",utteranceId:auto}});expect(show).toHaveBeenCalledTimes(1);client.dispose();
});
it("a late renew response cannot revive an expired lease",async()=>{
 const {client,call,reconnect}=setup();client.setDisplayState({visible:true,busyReasons:[],activitySeq:0});await client.connected({connectionId:connection,runtimeEpoch:epoch});let finish:(v:unknown)=>void=()=>undefined;
 call.mockImplementation(async(path)=>path==="/companion/display/renew"?await new Promise(resolve=>{finish=resolve;}):{recorded:true});vi.advanceTimersByTime(5000);vi.setSystemTime(17000);
 finish({runtimeEpoch:epoch,connectionId:connection,displayInstanceId:"other",leaseId,stateSeq:1,serverNow:6000,expiresAt:21000,leaseMs:15000,policyRevision:0});await Promise.resolve();await Promise.resolve();expect(reconnect).toHaveBeenCalledOnce();client.dispose();
});

it("ignores malformed and wrong-mode WS expressions",async()=>{const {client,show,instance}=setup();client.setDisplayState({visible:true,busyReasons:[],activitySeq:0});await client.connected({connectionId:connection,runtimeEpoch:epoch});const payload={protocolVersion:1,runtimeEpoch:epoch,displayInstanceId:instance(),leaseId,utteranceId:crypto.randomUUID(),mode:"manual",templateId:"a",theme:"a",text:"hi",actionId:null,createdAt:1000,expiresAt:16000,replyExpiresAt:601000,displayStateSeq:0,policyRevision:0,settingsVersion:1,historyEpoch:0,displayDurationMs:6000};client.onEvent({eventId:"1",occurredAt:"",kind:"assistant.companion",payload});expect(show).not.toHaveBeenCalled();client.dispose();});

it("manual request waits until the in-flight display update is confirmed",async()=>{
 const {client,call,instance}=setup();client.setDisplayState({visible:true,busyReasons:[],activitySeq:0});await client.connected({connectionId:connection,runtimeEpoch:epoch});let finish:(v:unknown)=>void=()=>undefined;
 const payload={protocolVersion:1 as const,runtimeEpoch:epoch,displayInstanceId:instance(),leaseId,utteranceId:crypto.randomUUID(),mode:"manual" as const,templateId:"a",theme:"a",text:"你好",actionId:null,createdAt:1000,expiresAt:16000,replyExpiresAt:601000,displayStateSeq:1,policyRevision:0,settingsVersion:1,historyEpoch:0,displayDurationMs:6000 as const};
 call.mockImplementation(async(path)=>{if(path==="/companion/display/renew")return await new Promise(resolve=>{finish=resolve;});if(path==="/companion/say")return {utterance:payload,supersedes:[]};return {recorded:true};});
 client.setDisplayState({visible:true,busyReasons:["panel"],activitySeq:1});const say=client.say();await Promise.resolve();expect(call.mock.calls.filter(a=>a[0]==="/companion/say")).toHaveLength(0);
 finish({runtimeEpoch:epoch,connectionId:connection,displayInstanceId:instance(),leaseId,stateSeq:1,serverNow:1000,expiresAt:16000,leaseMs:15000,policyRevision:0});await say;expect(call.mock.calls.filter(a=>a[0]==="/companion/say")).toHaveLength(1);client.dispose();
});

it("a failed manual request does not suppress future automatic candidates indefinitely",async()=>{
 const {client,call,show,instance}=setup();client.setDisplayState({visible:true,busyReasons:[],activitySeq:0});await client.connected({connectionId:connection,runtimeEpoch:epoch});
 call.mockImplementation(async(path)=>{if(path==="/companion/say")throw new AssistantClientError("runtime_unavailable");return {recorded:true};});await expect(client.say()).rejects.toThrow();vi.setSystemTime(2000);
 const payload={protocolVersion:1,runtimeEpoch:epoch,displayInstanceId:instance(),leaseId,utteranceId:crypto.randomUUID(),mode:"automatic",templateId:"a",theme:"a",text:"你好",actionId:null,createdAt:2000,expiresAt:16000,replyExpiresAt:602000,displayStateSeq:0,policyRevision:0,settingsVersion:1,historyEpoch:0,displayDurationMs:6000};
 client.onEvent({eventId:"future",occurredAt:"",kind:"assistant.companion",payload});expect(show).toHaveBeenCalledOnce();client.dispose();
});

it("an automatic candidate rejected while busy is not replayed after becoming idle",async()=>{
 const {client,call,show,instance}=setup();client.setDisplayState({visible:true,busyReasons:[],activitySeq:0});await client.connected({connectionId:connection,runtimeEpoch:epoch});
 call.mockImplementation(async(path)=>path==="/companion/display/renew"?await new Promise(()=>undefined):{recorded:true});
 const payload={protocolVersion:1,runtimeEpoch:epoch,displayInstanceId:instance(),leaseId,utteranceId:crypto.randomUUID(),mode:"automatic",templateId:"a",theme:"a",text:"你好",actionId:null,createdAt:1000,expiresAt:16000,replyExpiresAt:601000,displayStateSeq:0,policyRevision:0,settingsVersion:1,historyEpoch:0,displayDurationMs:6000};
 client.setDisplayState({visible:true,busyReasons:["input"],activitySeq:1});client.onEvent({eventId:"first",occurredAt:"",kind:"assistant.companion",payload});client.setDisplayState({visible:true,busyReasons:[],activitySeq:1});client.onEvent({eventId:"duplicate",occurredAt:"",kind:"assistant.companion",payload});expect(show).not.toHaveBeenCalled();client.dispose();
});

it("a state change during an in-flight renewal immediately sends the next state",async()=>{
 const {client,call,instance}=setup();client.setDisplayState({visible:true,busyReasons:[],activitySeq:0});await client.connected({connectionId:connection,runtimeEpoch:epoch});let finish:(v:unknown)=>void=()=>undefined;let count=0;
 call.mockImplementation(async(path,body)=>{if(path!=="/companion/display/renew")return {recorded:true};count++;if(count===1)return await new Promise(resolve=>{finish=resolve;});return {runtimeEpoch:epoch,connectionId:connection,displayInstanceId:instance(),leaseId,stateSeq:body.stateSeq,serverNow:1000,expiresAt:16000,leaseMs:15000,policyRevision:0};});
 client.setDisplayState({visible:true,busyReasons:["input"],activitySeq:1});client.setDisplayState({visible:true,busyReasons:[],activitySeq:1});finish({runtimeEpoch:epoch,connectionId:connection,displayInstanceId:instance(),leaseId,stateSeq:1,serverNow:1000,expiresAt:16000,leaseMs:15000,policyRevision:0});for(let i=0;i<8;i++)await Promise.resolve();expect(count).toBe(2);expect(call.mock.calls.filter(a=>a[0]==="/companion/display/renew")[1]![1]).toMatchObject({stateSeq:2,state:{busyReasons:[]}});client.dispose();
});

it("does not render manual response if native visibility fails after the request",async()=>{
 vi.useFakeTimers();vi.setSystemTime(1000);const show=vi.fn(()=>true);let instance="";const beforeShow=vi.fn(async()=>false);
 const call=vi.fn(async(path:string,body?:any):Promise<unknown>=>{if(path==="/companion/status")return status;if(path==="/companion/display/acquire"){instance=body.displayInstanceId;return {runtimeEpoch:epoch,connectionId:connection,displayInstanceId:instance,leaseId,stateSeq:0,serverNow:1000,expiresAt:16000,leaseMs:15000,policyRevision:0};}if(path==="/companion/say")return {utterance:{protocolVersion:1,runtimeEpoch:epoch,displayInstanceId:instance,leaseId,utteranceId:crypto.randomUUID(),mode:"manual",templateId:"a",theme:"a",text:"你好",actionId:null,createdAt:1000,expiresAt:16000,replyExpiresAt:601000,displayStateSeq:0,policyRevision:0,settingsVersion:1,historyEpoch:0,displayDurationMs:6000},supersedes:[]};return {recorded:true};});
 const client=new CompanionClient({call,show,reconnect:vi.fn(),wallNow:Date.now,monoNow:()=>Date.now(),beforeShow});client.setDisplayState({visible:true,busyReasons:[],activitySeq:0});await client.connected({connectionId:connection,runtimeEpoch:epoch});await expect(client.say()).rejects.toThrow("companion_display_not_shown");expect(beforeShow).toHaveBeenCalledOnce();expect(show).not.toHaveBeenCalled();client.dispose();
});

it("temporary status 503 reconnects with bounded delay and recovers",async()=>{
 const {client,call,reconnect}=setup();client.setDisplayState({visible:true,busyReasons:[],activitySeq:0});call.mockRejectedValueOnce(new AssistantClientError("companion_state_unavailable",503));
 await client.connected({connectionId:connection,runtimeEpoch:epoch});expect(client.isReady()).toBe(false);vi.advanceTimersByTime(2999);expect(reconnect).not.toHaveBeenCalled();vi.advanceTimersByTime(1);expect(reconnect).toHaveBeenCalledOnce();
 await client.connected({connectionId:connection,runtimeEpoch:epoch});expect(client.isReady()).toBe(true);client.dispose();
});
it("an acquisition timeout schedules a fresh socket and dispose cancels it",async()=>{
 const {client,call,reconnect}=setup();client.setDisplayState({visible:true,busyReasons:[],activitySeq:0});call.mockImplementation(async(path)=>{if(path==="/companion/status")return status;throw new AssistantClientError("runtime_unavailable");});
 await client.connected({connectionId:connection,runtimeEpoch:epoch});expect(call.mock.calls.some(a=>a[0]==="/companion/display/acquire")).toBe(true);vi.advanceTimersByTime(3000);expect(reconnect).toHaveBeenCalledOnce();
 await client.connected({connectionId:connection,runtimeEpoch:epoch});client.dispose();vi.advanceTimersByTime(120000);expect(reconnect).toHaveBeenCalledTimes(1);
});
it("404 and authorization failures do not initiate automatic reconnect",async()=>{
 const {client,call,reconnect}=setup();call.mockRejectedValueOnce(new AssistantClientError("not_found",404));await client.connected({connectionId:connection,runtimeEpoch:epoch});vi.advanceTimersByTime(60000);expect(reconnect).not.toHaveBeenCalled();
 call.mockRejectedValueOnce(new AssistantClientError("assistant_scope_required",403));await client.connected({connectionId:connection,runtimeEpoch:epoch});vi.advanceTimersByTime(60000);expect(reconnect).not.toHaveBeenCalled();client.dispose();
});

it("manual display rejection is reported without generating an automatic new request",async()=>{
 const {client,call,show,instance}=setup();client.setDisplayState({visible:true,busyReasons:[],activitySeq:0});await client.connected({connectionId:connection,runtimeEpoch:epoch});show.mockReturnValue(false);
 const u={protocolVersion:1,runtimeEpoch:epoch,displayInstanceId:instance(),leaseId,utteranceId:crypto.randomUUID(),mode:"manual",templateId:"a",theme:"a",text:"你好",actionId:null,createdAt:1000,expiresAt:16000,replyExpiresAt:601000,displayStateSeq:0,policyRevision:0,settingsVersion:1,historyEpoch:0,displayDurationMs:6000};call.mockImplementation(async(path)=>path==="/companion/say"?{utterance:u,supersedes:[]}:{recorded:true});
 await expect(client.say()).rejects.toThrow("companion_display_not_shown");expect(call.mock.calls.filter(a=>a[0]==="/companion/say")).toHaveLength(1);expect(call.mock.calls.find(a=>a[0]==="/companion/ack")?.[1]).toMatchObject({utteranceId:u.utteranceId,result:"discarded"});client.dispose();
});
it("a renew overtaking manual response reports that no bubble was displayed",async()=>{
 const {client,call,instance}=setup();client.setDisplayState({visible:true,busyReasons:[],activitySeq:0});await client.connected({connectionId:connection,runtimeEpoch:epoch});let finish:(v:unknown)=>void=()=>undefined;
 const u={protocolVersion:1,runtimeEpoch:epoch,displayInstanceId:instance(),leaseId,utteranceId:crypto.randomUUID(),mode:"manual",templateId:"a",theme:"a",text:"你好",actionId:null,createdAt:1000,expiresAt:16000,replyExpiresAt:601000,displayStateSeq:0,policyRevision:0,settingsVersion:1,historyEpoch:0,displayDurationMs:6000};
 call.mockImplementation(async(path,body)=>{if(path==="/companion/say")return await new Promise(resolve=>{finish=resolve;});if(path==="/companion/display/renew")return {runtimeEpoch:epoch,connectionId:connection,displayInstanceId:instance(),leaseId,stateSeq:body.stateSeq,serverNow:1000,expiresAt:16000,leaseMs:15000,policyRevision:0};return {recorded:true};});
 const pending=client.say();await Promise.resolve();client.setDisplayState({visible:true,busyReasons:["panel"],activitySeq:1});for(let i=0;i<6;i++)await Promise.resolve();finish({utterance:u,supersedes:[]});await expect(pending).rejects.toThrow("companion_display_not_shown");client.dispose();
});

it("automatic candidate cannot displace a manual bubble and is acknowledged discarded",async()=>{
 const {client,call,show,instance}=setup();client.setDisplayState({visible:true,busyReasons:[],activitySeq:0});await client.connected({connectionId:connection,runtimeEpoch:epoch});
 const render=vi.fn(),bubble=new CompanionBubble({render,playAction:()=>undefined,restoreLatest:()=>undefined});show.mockImplementation(u=>bubble.show(u));
 const auto={protocolVersion:1 as const,runtimeEpoch:epoch,displayInstanceId:instance(),leaseId,utteranceId:crypto.randomUUID(),mode:"automatic" as const,templateId:"a",theme:"a",text:"自动",actionId:null,createdAt:1000,expiresAt:16000,replyExpiresAt:601000,displayStateSeq:0,policyRevision:0,settingsVersion:1,historyEpoch:0,displayDurationMs:6000 as const};
 bubble.show({...auto,utteranceId:crypto.randomUUID(),mode:"manual",text:"手动"});client.onEvent({eventId:"auto",occurredAt:"",kind:"assistant.companion",payload:auto});
 expect(render.mock.lastCall?.[0]?.text).toBe("手动");expect(call.mock.calls.find(a=>a[0]==="/companion/ack")?.[1]).toMatchObject({utteranceId:auto.utteranceId,result:"discarded"});bubble.dispose();client.dispose();
});
