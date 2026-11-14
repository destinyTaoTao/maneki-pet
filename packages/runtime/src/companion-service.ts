import { createHash, randomUUID } from "node:crypto";
import { companionDayKey, companionLimits, companionTemplates, evaluateCompanion, selectCompanionTemplate,
  type CompanionAcquireRequest, type CompanionRenewRequest, type CompanionReleaseRequest,
  type CompanionSayRequest, type CompanionSayResponse, type CompanionAckRequest, type CompanionReplyTo,
  type CompanionReference, type CompanionUtterance, type CompanionStatus, type CompanionLease } from "@maneki-pet/core";
import { AssistantError } from "./assistant-settings.js";
import { CompanionClock } from "./companion-clock.js";
import type { CompanionStore } from "./companion-store.js";
import type { CompanionLeases } from "./companion-leases.js";
import type { EventFeed } from "./events.js";

interface Deps { store:CompanionStore; leases:CompanionLeases; feed:EventFeed; runtimeEpoch:string;
  settings:()=>{version:number;timeZone:string}; historyEpoch:()=>number; dnd:()=>boolean;
  now?:()=>number; mono?:()=>number; timers?:boolean }
interface Item { clientId:string; utterance:CompanionUtterance; createdMono:number; result?:"displayed"|"discarded"; invalid:boolean }
interface ManualEntry { requestId:string; at:number; atMono:number; response:CompanionSayResponse }
interface ManualState { clientId:string; seq:number; cache:Map<number,ManualEntry> }
const hash=(text:string)=>createHash("sha256").update(text.trim().normalize("NFC"),"utf8").digest("hex");
const hour=(now:number,zone:string)=>Number(new Intl.DateTimeFormat("en-GB",{timeZone:zone,hour:"2-digit",hourCycle:"h23"}).format(now));
/** Runtime owns scheduling, budget claims and bounded temporary references. */
export class CompanionService {
  private readonly now:()=>number;
  private readonly mono:()=>number;
  private readonly clock:CompanionClock;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private readonly items=new Map<string,Item>();
  private readonly expiredReferences=new Map<string,{clientId:string;displayInstanceId:string;leaseId:string;until:number}>();
  private readonly manual=new Map<string,ManualState>();
  private readonly lastManual=new Map<string,number>();
  private lastManualTemplate:string|null=null;
  private revision=0;
  private health:"healthy"|"storage_unavailable"|"clock_untrusted"|undefined;
  private writeFailed=false;
  private nextHealthProbe=0;
  private unavailableDay:string|null=null;
  private closed=false;
  constructor(private readonly deps:Deps){this.now=deps.now??Date.now;this.mono=deps.mono??(()=>performance.now());this.clock=new CompanionClock(this.now,this.mono);}
  policyRevision():number{return this.revision;}
  private fail(status:number,code:string):never{throw new AssistantError(status,code);}
  private checkEpoch(epoch:string):void{if(epoch!==this.deps.runtimeEpoch)this.fail(409,"companion_epoch_changed");}
  private clean():void {
    const now=this.now();
    for(const [id,item] of this.items) if(now>=item.utterance.replyExpiresAt||now<item.utterance.createdAt||this.mono()<item.createdMono||this.mono()-item.createdMono>=600000){
      this.items.delete(id);this.expiredReferences.set(id,{clientId:item.clientId,displayInstanceId:item.utterance.displayInstanceId,leaseId:item.utterance.leaseId,until:now+600000});
    }
    for(const [id,item] of this.expiredReferences)if(now>=item.until)this.expiredReferences.delete(id);
    while(this.expiredReferences.size>256)this.expiredReferences.delete(this.expiredReferences.keys().next().value!);
    for(const [lease,state] of this.manual) {
      for(const [seq,item] of state.cache) if(now-item.at>=600000||now<item.at||this.mono()<item.atMono||this.mono()-item.atMono>=600000)state.cache.delete(seq);
      if(state.cache.size===0&&!this.deps.leases.owner(lease))this.manual.delete(lease);
    }
    for(const [client,at] of this.lastManual) if(now-at>=600000)this.lastManual.delete(client);
  }
  private hasCapacity(client:string,display:string):boolean {
    this.clean();const list=[...this.items.values()];
    return list.length<256&&list.filter(i=>i.clientId===client).length<64&&list.filter(i=>i.clientId===client&&i.utterance.displayInstanceId===display).length<32;
  }
  private invalidatePending():void {
    for(const item of this.items.values())if(!item.result)item.invalid=true;
  }
  private publishPolicy(s:CompanionStatus,healthy:boolean):void {
    this.deps.feed.publish("assistant.companion.policy",{runtimeEpoch:s.runtimeEpoch,policyRevision:s.policyRevision,settingsVersion:s.settingsVersion,historyEpoch:s.historyEpoch,dnd:s.dnd,companion:s.companion,healthy});
  }
  /** 写入故障锁存；恢复前需通过有界间隔的实际事务写入验证。 */
  storageFailure():void {
    this.writeFailed=true;this.nextHealthProbe=this.mono()+30000;
    try{this.status();}catch{}
  }
  status():CompanionStatus {
    const settings=this.deps.settings(),now=this.now();let state:ReturnType<CompanionStore["readState"]>|undefined;
    if(this.writeFailed&&this.mono()>=this.nextHealthProbe){
      try{this.deps.store.transaction(()=>{const current=this.deps.store.readState();this.deps.store.writeBudget(current.budget);});this.writeFailed=false;}
      catch{this.nextHealthProbe=this.mono()+30000;}
    }
    if(!this.writeFailed)try{state=this.deps.store.readState();}catch{}
    const lease=this.deps.leases.selectEligible();
    const trusted=state?this.clock.sample(state.budget.lastTrustedWallAt).trusted:false;
    const currentHealth=!state?"storage_unavailable":!trusted?"clock_untrusted":"healthy";
    const verdict=state?evaluateCompanion({nowMs:now,timeZone:settings.timeZone,preferences:state.preferences,budget:state.budget,dnd:this.deps.dnd(),storageHealthy:true,clockTrusted:trusted,displayAvailable:!!lease,contentAvailable:this.unavailableDay!==companionDayKey(now,settings.timeZone)}):{allowed:false,reason:"storage_unavailable" as const,nextEligibleAt:null};
    const changed=this.health===undefined?currentHealth!=="healthy":this.health!==currentHealth;
    this.health=currentHealth;
    if(changed){this.revision++;this.invalidatePending();}
    const result:CompanionStatus={protocolVersion:1,runtimeEpoch:this.deps.runtimeEpoch,serverNow:now,policyRevision:this.revision,settingsVersion:settings.version,historyEpoch:this.deps.historyEpoch(),dnd:this.deps.dnd(),companion:state?.preferences??null,automaticBlock:verdict.reason,nextEligibleAt:verdict.nextEligibleAt,limits:companionLimits};
    if(changed)this.publishPolicy(result,currentHealth==="healthy");
    return result;
  }
  policyChanged():void {
    const s=this.status();this.revision++;this.invalidatePending();
    this.publishPolicy({...s,policyRevision:this.revision},this.health==="healthy");
    this.wake();
  }
  acquire(client:string,request:CompanionAcquireRequest):CompanionLease {
    const lease=this.deps.leases.acquire(client,request);
    if(!this.writeFailed&&request.state.visible&&request.state.busyReasons.length===0){
      try{this.deps.store.transaction(()=>{const b=this.deps.store.readState().budget;if(b.firstEligibleAt===null){const sample=this.clock.sample(b.lastTrustedWallAt);if(sample.trusted){b.firstEligibleAt=sample.nowMs;b.lastTrustedWallAt=sample.nowMs;this.deps.store.writeBudget(b);}}});}catch(error){if(!(error instanceof AssistantError))this.storageFailure();}
    }
    this.wake();return lease;
  }
  renew(client:string,request:CompanionRenewRequest):CompanionLease {
    const lease=this.deps.leases.renew(client,request);
    if(!this.writeFailed&&request.state.visible&&request.state.busyReasons.length===0){
      try{this.deps.store.transaction(()=>{const b=this.deps.store.readState().budget;if(b.firstEligibleAt===null){const sample=this.clock.sample(b.lastTrustedWallAt);if(sample.trusted){b.firstEligibleAt=sample.nowMs;b.lastTrustedWallAt=sample.nowMs;this.deps.store.writeBudget(b);}}});}catch(error){if(!(error instanceof AssistantError))this.storageFailure();}
    }
    this.wake();return lease;
  }
  release(client:string,request:CompanionReleaseRequest):{released:true}{const result=this.deps.leases.release(client,request);this.wake();return result;}
  private makeUtterance(client:string,lease:CompanionLease,mode:"manual"|"automatic"):CompanionUtterance {
    const now=this.now(),settings=this.deps.settings();
    if(!this.hasCapacity(client,lease.displayInstanceId))return this.fail(429,"companion_capacity");
    try { return this.deps.store.transaction(()=>{
      const {preferences,budget}=this.deps.store.readState();const sample=this.clock.sample(budget.lastTrustedWallAt);
      if(!sample.trusted)return this.fail(503,"companion_clock_untrusted");
      if(mode==="automatic"){
        const decision=evaluateCompanion({nowMs:now,timeZone:settings.timeZone,preferences,budget,dnd:this.deps.dnd(),storageHealthy:true,clockTrusted:true,displayAvailable:true,contentAvailable:true});
        if(!decision.allowed)return this.fail(503,"companion_state_unavailable");
      }
      const day=companionDayKey(now,settings.timeZone);
      const recent=budget.usedTemplates.filter(u=>companionDayKey(u.lastUsedAt,settings.timeZone)===day||u.lastUsedAt>now-86400000);
      const excludedHashes=new Set(recent.map(u=>u.contentHash));
      const excludedIds=new Set(companionTemplates.filter(t=>excludedHashes.has(hash(t.text))).map(t=>t.id));
      const template=selectCompanionTemplate({mode,hour:hour(now,settings.timeZone),excludedIds,lastTheme:budget.lastAutomaticTheme,lastTemplateId:mode==="manual"?this.lastManualTemplate:null},companionTemplates);
      if(!template)return this.fail(503,"companion_content_unavailable");
      const digest=hash(template.text),utteranceId=randomUUID();
      budget.attempts=budget.attempts.filter(a=>a.at>now-72*3600000);
      budget.usedTemplates=recent.filter(u=>u.templateId!==template.id&&u.contentHash!==digest);
      if(budget.usedTemplates.length>=256||(mode==="automatic"&&budget.attempts.length>=16))return this.fail(503,"companion_state_unavailable");
      budget.usedTemplates.push({templateId:template.id,contentHash:digest,lastUsedAt:now});budget.lastTrustedWallAt=now;
      if(mode==="automatic") {budget.lastAutomaticAttemptAt=now;budget.lastAutomaticTheme=template.theme;budget.attempts.push({utteranceId,at:now,dayKey:day,timeZone:settings.timeZone,templateId:template.id,contentHash:digest});}
      this.deps.store.writeBudget(budget);
      // Find the day boundary without assuming a fixed local day length.
      let lo=now,hi=now+27*3600000;while(hi-lo>1){const mid=Math.floor((lo+hi)/2);if(companionDayKey(mid,settings.timeZone)===day)lo=mid;else hi=mid;}
      return {runtimeEpoch:this.deps.runtimeEpoch,displayInstanceId:lease.displayInstanceId,leaseId:lease.leaseId,utteranceId,protocolVersion:1,mode,templateId:template.id,theme:template.theme,text:template.text,actionId:template.actionId,createdAt:now,expiresAt:Math.min(now+15000,hi-1),replyExpiresAt:now+600000,displayStateSeq:lease.stateSeq,policyRevision:this.revision,settingsVersion:settings.version,historyEpoch:this.deps.historyEpoch(),displayDurationMs:6000};
    }); } catch(error) {
      if(error instanceof AssistantError){
        if(error.code==="companion_state_unavailable")this.storageFailure();
        else if(error.code==="companion_clock_untrusted")this.status();
        throw error;
      }
      this.storageFailure();return this.fail(503,"companion_state_unavailable");
    }
  }
  say(client:string,request:CompanionSayRequest):CompanionSayResponse {
    this.checkEpoch(request.runtimeEpoch);this.clean();
    let state=this.manual.get(request.leaseId);if(state&&state.clientId!==client)return this.fail(404,"companion_display_not_found");const cached=state?.cache.get(request.requestSeq);
    if(cached){if(cached.requestId!==request.requestId)return this.fail(409,"companion_sequence_conflict");return structuredClone(cached.response);}
    if(state&&request.requestSeq<=state.seq)return this.fail(410,"companion_request_expired");
    if(this.status().automaticBlock==="storage_unavailable")return this.fail(503,"companion_state_unavailable");
    const {lease,state:display}=this.deps.leases.get(client,request.leaseId);
    if(request.requestSeq!==(state?.seq??0)+1)return this.fail(409,"companion_sequence_conflict");
    if(!display.visible||display.busyReasons.some(r=>r==="voice"||r==="drag"))return this.fail(409,"companion_display_busy");
    const last=this.lastManual.get(client);if(last!==undefined&&this.now()-last<3000)return this.fail(429,"companion_rate_limited");
    const old=[...this.items.values()].find(i=>i.clientId===client&&i.utterance.leaseId===lease.leaseId&&i.utterance.mode==="automatic"&&!i.invalid&&!i.result);
    if(old)old.invalid=true;
    const utterance=this.makeUtterance(client,lease,"manual");
    this.lastManualTemplate=utterance.templateId;this.lastManual.set(client,this.now());
    const response:CompanionSayResponse={utterance,supersedes:old?[old.utterance.utteranceId]:[]};
    this.items.set(utterance.utteranceId,{clientId:client,utterance,createdMono:this.mono(),invalid:false});
    if(!state){state={clientId:client,seq:0,cache:new Map()};this.manual.set(request.leaseId,state);}state.seq=request.requestSeq;state.cache.set(request.requestSeq,{requestId:request.requestId,at:this.now(),atMono:this.mono(),response});
    while(state.cache.size>16)state.cache.delete(state.cache.keys().next().value!);
    return structuredClone(response);
  }
  ack(client:string,request:CompanionAckRequest):{recorded:true}{
    this.checkEpoch(request.runtimeEpoch);this.deps.leases.get(client,request.leaseId);
    const item=this.items.get(request.utteranceId);
    if(!item){const expired=this.expiredReferences.get(request.utteranceId);
      if(expired&&expired.clientId===client&&expired.leaseId===request.leaseId&&this.now()<expired.until)return this.fail(410,"companion_utterance_expired");
      return this.fail(404,"companion_reference_not_found");
    }
    if(item.clientId!==client||item.utterance.leaseId!==request.leaseId)return this.fail(404,"companion_reference_not_found");
    if(this.now()>=item.utterance.createdAt+60000||this.now()<item.utterance.createdAt||this.mono()<item.createdMono||this.mono()-item.createdMono>=60000)return this.fail(410,"companion_utterance_expired");
    if(item.result&&item.result!==request.result)return this.fail(409,"companion_ack_conflict");
    item.result=request.result;return {recorded:true};
  }
  resolveReference(client:string,reply:CompanionReplyTo):CompanionReference {
    this.checkEpoch(reply.runtimeEpoch);const item=this.items.get(reply.utteranceId);
    if(!item){const expired=this.expiredReferences.get(reply.utteranceId);if(expired&&expired.clientId===client&&expired.displayInstanceId===reply.displayInstanceId&&this.now()<expired.until)return this.fail(410,"companion_reference_expired");return this.fail(404,"companion_reference_not_found");}
    if(item.clientId!==client||item.utterance.displayInstanceId!==reply.displayInstanceId)return this.fail(404,"companion_reference_not_found");
    if(this.now()>=item.utterance.replyExpiresAt||this.now()<item.utterance.createdAt||this.mono()<item.createdMono||this.mono()-item.createdMono>=600000)return this.fail(410,"companion_reference_expired");
    const u=item.utterance;return {utteranceId:u.utteranceId,text:u.text,mode:u.mode,createdAt:u.createdAt};
  }
  wake():void {
    if(this.closed)return;if(this.timer){clearTimeout(this.timer);this.timer=undefined;}
    const lease=this.deps.leases.selectEligible(),status=this.status();
    if(lease&&status.automaticBlock===null&&this.unavailableDay!==companionDayKey(this.now(),this.deps.settings().timeZone)){
      const client=this.deps.leases.owner(lease.leaseId);
      if(client&&this.hasCapacity(client,lease.displayInstanceId))try{
        const utterance=this.makeUtterance(client,lease,"automatic");this.items.set(utterance.utteranceId,{clientId:client,utterance,createdMono:this.mono(),invalid:false});
        this.deps.feed.publish("assistant.companion",{...utterance},{clientId:client,connectionId:lease.connectionId});
      }catch(error){if(error instanceof AssistantError&&error.code==="companion_content_unavailable")this.unavailableDay=companionDayKey(this.now(),this.deps.settings().timeZone);}
    }
    if(this.deps.timers!==false){const next=this.status().nextEligibleAt;if(next!==null&&next>this.now()){
      this.timer=setTimeout(()=>this.wake(),Math.min(next-this.now(),2147483647));this.timer.unref();}}
  }
  connectionClosed(connectionId:string):void {this.deps.leases.invalidateConnection(connectionId);this.clean();this.wake();}
  revoke(client:string):void {for(const [id,state]of this.manual)if(state.clientId===client)this.manual.delete(id);this.lastManual.delete(client);this.deps.leases.invalidateClient(client);for(const [id,item]of this.expiredReferences)if(item.clientId===client)this.expiredReferences.delete(id);for(const [id,item]of this.items)if(item.clientId===client)this.items.delete(id);this.clean();this.wake();}
  historyCleared():void {this.items.clear();this.expiredReferences.clear();this.policyChanged();}
  stop():void {this.closed=true;if(this.timer)clearTimeout(this.timer);this.deps.leases.close();this.items.clear();this.expiredReferences.clear();this.manual.clear();this.lastManual.clear();}
}
