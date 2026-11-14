import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { RuntimeStore } from "../src/store.js";
import { CompanionStore } from "../src/companion-store.js";
import { CompanionLeases } from "../src/companion-leases.js";
import { CompanionService } from "../src/companion-service.js";
import { EventFeed } from "../src/events.js";

function fixture() {
 let now=Date.UTC(2026,10,14,1), mono=0;
 const runtime=new RuntimeStore(":memory:"), db=runtime.assistantStore(), store=new CompanionStore(db), feed=new EventFeed(), epoch=randomUUID(), connectionId=randomUUID();
 store.initialize(now);
 let revision=0;
 const leases=new CompanionLeases({runtimeEpoch:epoch,now:()=>now,mono:()=>mono,scopes:()=>["assistant"],ownsConnection:()=>true,policyRevision:()=>revision});
 const service=new CompanionService({store,leases,feed,runtimeEpoch:epoch,now:()=>now,mono:()=>mono,settings:()=>({version:1,timeZone:"UTC"}),historyEpoch:()=>0,dnd:()=>false,timers:false});
 const acquire=()=>service.acquire("alice",{protocolVersion:1,runtimeEpoch:epoch,connectionId,displayInstanceId:randomUUID(),state:{visible:true,busyReasons:[],activitySeq:0}});
 return {runtime,store,service,leases,feed,epoch,acquire,tick:(n:number)=>{now+=n;mono+=n;},jumpWall:(n:number)=>{now+=n;},setRevision:()=>revision++};
}
it("warms up for two hours, then claims budget before targeted delivery",()=>{
 const f=fixture(), events=vi.fn(); f.feed.subscribe(events);
 try {let lease=f.acquire();
 // Keep the display alive using deterministic renewals across the warmup.
 for(let i=1;i<=1440;i++){f.tick(5000);lease=f.service.renew("alice",{protocolVersion:1,runtimeEpoch:f.epoch,leaseId:lease.leaseId,stateSeq:i,state:{visible:true,busyReasons:[],activitySeq:0}});}
 expect(f.store.readState().budget.attempts).toHaveLength(1);
 const delivery=events.mock.calls.find(c=>c[0].kind==="assistant.companion");
 expect(delivery?.[1]).toEqual({clientId:"alice",connectionId:lease.connectionId});
 expect(f.store.readState().budget.attempts[0]?.utteranceId).toBe(delivery?.[0].payload.utteranceId);
 } finally {f.service.stop();f.runtime.close();}
});
it("manual retries return the same utterance and do not consume automatic attempts",()=>{
 const f=fixture();try{const lease=f.acquire();const request={protocolVersion:1 as const,runtimeEpoch:f.epoch,leaseId:lease.leaseId,requestId:"r1",requestSeq:1};
 const first=f.service.say("alice",request);expect(f.service.say("alice",request)).toEqual(first);
 expect(f.store.readState().budget.attempts).toHaveLength(0);
 expect(()=>f.service.say("alice",{...request,requestId:"other"})).toThrow("companion_sequence_conflict");
 expect(f.service.resolveReference("alice",{runtimeEpoch:f.epoch,displayInstanceId:lease.displayInstanceId,utteranceId:first.utterance.utteranceId}).text).toBe(first.utterance.text);
 }finally{f.service.stop();f.runtime.close();}
});

it("cached manual result is private and survives an expired lease without generating another",()=>{
 const f=fixture();try{const lease=f.acquire();const request={protocolVersion:1 as const,runtimeEpoch:f.epoch,leaseId:lease.leaseId,requestId:"once",requestSeq:1};
 const first=f.service.say("alice",request);
 expect(()=>f.service.say("bob",request)).toThrow("companion_display_not_found");
 f.tick(15000);expect(f.service.say("alice",request)).toEqual(first);
 }finally{f.service.stop();f.runtime.close();}
});
it("expired references return 410 even after a later cleanup",()=>{
 const f=fixture();try{const lease=f.acquire();const result=f.service.say("alice",{protocolVersion:1,runtimeEpoch:f.epoch,leaseId:lease.leaseId,requestId:"r",requestSeq:1});
 f.tick(600001);try{f.service.say("alice",{protocolVersion:1,runtimeEpoch:f.epoch,leaseId:lease.leaseId,requestId:"r2",requestSeq:2});}catch{}
 const ref={runtimeEpoch:f.epoch,displayInstanceId:lease.displayInstanceId,utteranceId:result.utterance.utteranceId};
 expect(()=>f.service.resolveReference("alice",ref)).toThrow("companion_reference_expired");
 expect(()=>f.service.resolveReference("bob",ref)).toThrow("companion_reference_not_found");
 }finally{f.service.stop();f.runtime.close();}
});

it("revocation invalidates both outstanding references and cached manual results",()=>{
 const f=fixture();try{const lease=f.acquire();const request={protocolVersion:1 as const,runtimeEpoch:f.epoch,leaseId:lease.leaseId,requestId:"once",requestSeq:1};
 const result=f.service.say("alice",request);f.service.revoke("alice");
 expect(()=>f.service.say("alice",request)).toThrow("companion_lease_expired");
 expect(()=>f.service.resolveReference("alice",{runtimeEpoch:f.epoch,displayInstanceId:lease.displayInstanceId,utteranceId:result.utterance.utteranceId})).toThrow("companion_reference_not_found");
 }finally{f.service.stop();f.runtime.close();}
});

it("a backward wall-clock jump cannot extend a reference or manual retry lifetime",()=>{
 const f=fixture();try{const lease=f.acquire();const request={protocolVersion:1 as const,runtimeEpoch:f.epoch,leaseId:lease.leaseId,requestId:"once",requestSeq:1};
 const result=f.service.say("alice",request);f.jumpWall(-1000);
 expect(()=>f.service.resolveReference("alice",{runtimeEpoch:f.epoch,displayInstanceId:lease.displayInstanceId,utteranceId:result.utterance.utteranceId})).toThrow("companion_reference_expired");
 expect(()=>f.service.say("alice",request)).toThrow();
 }finally{f.service.stop();f.runtime.close();}
});

it("observing storage damage and restoration broadcasts one revision per health transition",()=>{
 const f=fixture(),events=vi.fn();f.feed.subscribe(events);try{
  f.acquire();const db=f.runtime.assistantStore(),raw=db.get("companion.budget")!;
  db.set("companion.budget","{}");const bad=f.service.status();expect(bad.automaticBlock).toBe("storage_unavailable");
  expect(events.mock.calls.filter(c=>c[0].kind==="assistant.companion.policy").at(-1)?.[0].payload).toMatchObject({healthy:false,companion:null,policyRevision:bad.policyRevision});
  const count=events.mock.calls.length;f.service.status();expect(events.mock.calls.length).toBe(count);
  db.set("companion.budget",raw);const restored=f.service.status();expect(restored.policyRevision).toBe(bad.policyRevision+1);
  expect(events.mock.calls.at(-1)?.[0].payload).toMatchObject({healthy:true,policyRevision:restored.policyRevision});
 }finally{f.service.stop();f.runtime.close();}
});
it("observing a clock jump broadcasts unhealthy and a stable two-hour recovery broadcasts healthy",()=>{
 const f=fixture(),events=vi.fn();f.feed.subscribe(events);try{
  f.acquire();f.jumpWall(3600000);const bad=f.service.status();expect(bad.automaticBlock).toBe("clock_untrusted");
  expect(events.mock.calls.at(-1)?.[0].payload).toMatchObject({healthy:false,policyRevision:bad.policyRevision});
  f.tick(7200000);const restored=f.service.status();expect(restored.policyRevision).toBe(bad.policyRevision+1);
  expect(events.mock.calls.at(-1)?.[0].payload).toMatchObject({healthy:true,policyRevision:restored.policyRevision});
 }finally{f.service.stop();f.runtime.close();}
});
it("a failed budget transaction maps to 503, rolls back and emits an unhealthy policy",()=>{
 const f=fixture(),events=vi.fn();f.feed.subscribe(events);try{
  const lease=f.acquire(),before=f.store.readState().budget;
  const original=f.store.transaction.bind(f.store);const spy=vi.spyOn(f.store,"transaction").mockImplementation((run:any)=>original(()=>{run();throw Error("commit fixture");}));
  expect(()=>f.service.say("alice",{protocolVersion:1,runtimeEpoch:f.epoch,leaseId:lease.leaseId,requestId:"failure",requestSeq:1})).toThrow("companion_state_unavailable");
  expect(f.store.readState().budget).toEqual(before);expect(f.service.status().automaticBlock).toBe("storage_unavailable");
  expect(events.mock.calls.at(-1)?.[0].payload).toMatchObject({healthy:false});spy.mockRestore();
  expect(()=>f.service.say("alice",{protocolVersion:1,runtimeEpoch:f.epoch,leaseId:lease.leaseId,requestId:"second",requestSeq:1})).toThrow("companion_state_unavailable");
  f.tick(30000);expect(f.service.status().automaticBlock).not.toBe("storage_unavailable");
  expect(events.mock.calls.at(-1)?.[0].payload).toMatchObject({healthy:true});
 }finally{vi.restoreAllMocks();f.service.stop();f.runtime.close();}
});

it("expired ACK remains 410 after cleanup without disclosing another client's item",()=>{
 const f=fixture();try{let lease=f.acquire();const first=f.service.say("alice",{protocolVersion:1,runtimeEpoch:f.epoch,leaseId:lease.leaseId,requestId:"old",requestSeq:1});
 for(let i=1;i<=120;i++){f.tick(5000);lease=f.service.renew("alice",{protocolVersion:1,runtimeEpoch:f.epoch,leaseId:lease.leaseId,stateSeq:i,state:{visible:true,busyReasons:[],activitySeq:0}});}
 f.service.say("alice",{protocolVersion:1,runtimeEpoch:f.epoch,leaseId:lease.leaseId,requestId:"next",requestSeq:2});
 const ack={protocolVersion:1 as const,runtimeEpoch:f.epoch,leaseId:lease.leaseId,utteranceId:first.utterance.utteranceId,result:"displayed" as const};
 expect(()=>f.service.ack("alice",ack)).toThrow("companion_utterance_expired");
 expect(()=>f.service.ack("bob",ack)).toThrow("companion_display_not_found");
 }finally{f.service.stop();f.runtime.close();}
});

it("an automatic send failure retains the durable attempt and never immediately resends",()=>{
 const f=fixture();let deliveries=0;const publish=f.feed.publish.bind(f.feed);
 vi.spyOn(f.feed,"publish").mockImplementation((kind,payload,audience)=>{if(kind==="assistant.companion"){deliveries++;throw Error("send failed");}return publish(kind,payload,audience);});
 try{let lease=f.acquire();for(let i=1;i<=1440;i++){f.tick(5000);lease=f.service.renew("alice",{protocolVersion:1,runtimeEpoch:f.epoch,leaseId:lease.leaseId,stateSeq:i,state:{visible:true,busyReasons:[],activitySeq:0}});}
 expect(deliveries).toBe(1);expect(f.store.readState().budget.attempts).toHaveLength(1);f.service.wake();expect(deliveries).toBe(1);
 }finally{vi.restoreAllMocks();f.service.stop();f.runtime.close();}
});

it("the first unhealthy observation emits a policy even before a previous status read",()=>{
 const f=fixture(),events=vi.fn();f.feed.subscribe(events);try{
 f.runtime.assistantStore().set("companion.budget","{}");const status=f.service.status();
 expect(status.automaticBlock).toBe("storage_unavailable");expect(events.mock.calls.at(-1)?.[0].payload).toMatchObject({healthy:false,companion:null,policyRevision:status.policyRevision});
 }finally{f.service.stop();f.runtime.close();}
});
it("storage failure invalidates an undisplayed automatic candidate",()=>{
 const f=fixture(),events=vi.fn();f.feed.subscribe(events);try{
 let lease=f.acquire();for(let i=1;i<=1440;i++){f.tick(5000);lease=f.service.renew("alice",{protocolVersion:1,runtimeEpoch:f.epoch,leaseId:lease.leaseId,stateSeq:i,state:{visible:true,busyReasons:[],activitySeq:0}});}
 expect(events.mock.calls.some(c=>c[0].kind==="assistant.companion")).toBe(true);
 const db=f.runtime.assistantStore(),raw=db.get("companion.budget")!;db.set("companion.budget","{}");f.service.status();db.set("companion.budget",raw);f.service.status();
 expect(f.service.say("alice",{protocolVersion:1,runtimeEpoch:f.epoch,leaseId:lease.leaseId,requestId:"after",requestSeq:1}).supersedes).toEqual([]);
 }finally{f.service.stop();f.runtime.close();}
});
it("automatic claim write failure rolls back and does not block ordinary assistant storage",()=>{
 const f=fixture(),events=vi.fn();f.feed.subscribe(events);try{
 let lease=f.acquire();for(let i=1;i<1440;i++){f.tick(5000);lease=f.service.renew("alice",{protocolVersion:1,runtimeEpoch:f.epoch,leaseId:lease.leaseId,stateSeq:i,state:{visible:true,busyReasons:[],activitySeq:0}});}
 const spy=vi.spyOn(f.store,"writeBudget").mockImplementation(()=>{throw Error("write fixture");});f.tick(5000);f.service.renew("alice",{protocolVersion:1,runtimeEpoch:f.epoch,leaseId:lease.leaseId,stateSeq:1440,state:{visible:true,busyReasons:[],activitySeq:0}});
 expect(f.store.readState().budget.attempts).toEqual([]);expect(f.service.status().automaticBlock).toBe("storage_unavailable");
 expect(events.mock.calls.at(-1)?.[0].payload).toMatchObject({healthy:false});
 const db=f.runtime.assistantStore();db.transaction(()=>db.append("user","正常文字"));expect(db.messages().at(-1)?.text).toBe("正常文字");spy.mockRestore();
 }finally{vi.restoreAllMocks();f.service.stop();f.runtime.close();}
});

it("a failed first warmup write is not retried on every renewal while health is latched",()=>{
 const f=fixture(),events=vi.fn();f.feed.subscribe(events);try{
  const write=vi.spyOn(f.store,"writeBudget").mockImplementation(()=>{throw Error("warmup write failed");});
  let lease=f.acquire();expect(write).toHaveBeenCalledTimes(1);expect(f.store.readState().budget.firstEligibleAt).toBeNull();
  for(let i=1;i<=5;i++){f.tick(5000);lease=f.service.renew("alice",{protocolVersion:1,runtimeEpoch:f.epoch,leaseId:lease.leaseId,stateSeq:i,state:{visible:true,busyReasons:[],activitySeq:0}});}
  expect(write).toHaveBeenCalledTimes(1);expect(f.service.status().automaticBlock).toBe("storage_unavailable");
  for(let i=6;i<=11;i++){f.tick(5000);lease=f.service.renew("alice",{protocolVersion:1,runtimeEpoch:f.epoch,leaseId:lease.leaseId,stateSeq:i,state:{visible:true,busyReasons:[],activitySeq:0}});}
  expect(write).toHaveBeenCalledTimes(2); // One recovery probe at 30s, no retry on other renewals.
  write.mockRestore();f.tick(5000);lease=f.service.renew("alice",{protocolVersion:1,runtimeEpoch:f.epoch,leaseId:lease.leaseId,stateSeq:12,state:{visible:true,busyReasons:[],activitySeq:0}});
  expect(f.service.status().automaticBlock).toBe("warming_up");
  f.tick(5000);f.service.renew("alice",{protocolVersion:1,runtimeEpoch:f.epoch,leaseId:lease.leaseId,stateSeq:13,state:{visible:true,busyReasons:[],activitySeq:0}});
  expect(f.store.readState().budget.firstEligibleAt).not.toBeNull();
  expect(events.mock.calls.filter(c=>c[0].kind==="assistant.companion.policy").map(c=>c[0].payload.healthy)).toEqual([false,true]);
 }finally{vi.restoreAllMocks();f.service.stop();f.runtime.close();}
});
