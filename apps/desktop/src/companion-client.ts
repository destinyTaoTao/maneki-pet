import type { CompanionDisplayState, CompanionLease, CompanionPolicyEvent, CompanionSayResponse, CompanionStatus, CompanionUtterance } from "@maneki-pet/core";
import { AssistantClientError } from "./assistant-client.js";
import type { RuntimeEvent, WsReady } from "./runtime-client.js";

type Call = (path:string, body?:unknown) => Promise<unknown>;
const uuid=(v:unknown):v is string=>typeof v==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const number=(v:unknown):v is number=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0&&v<=253402300799999;
const slug=(v:unknown):v is string=>typeof v==="string"&&/^[a-z0-9_-]{1,64}$/.test(v);
function validUtterance(value:unknown, mode:"automatic"|"manual"):value is CompanionUtterance {
 if(!value||typeof value!=="object"||Array.isArray(value))return false;
 const v=value as CompanionUtterance;
 return v.protocolVersion===1&&v.mode===mode&&[v.runtimeEpoch,v.displayInstanceId,v.leaseId,v.utteranceId].every(uuid)&&slug(v.templateId)&&slug(v.theme)&&(v.actionId===null||slug(v.actionId))&&typeof v.text==="string"&&!!v.text.trim()&&v.text.length<=80&&[v.createdAt,v.expiresAt,v.replyExpiresAt,v.displayStateSeq,v.policyRevision,v.settingsVersion,v.historyEpoch].every(number)&&v.expiresAt>=v.createdAt&&v.expiresAt<=v.createdAt+15000&&v.replyExpiresAt===v.createdAt+600000&&v.displayDurationMs===6000;
}
interface Dependencies { call:Call; beforeShow?:()=>Promise<boolean>; show:(utterance:CompanionUtterance)=>boolean; reconnect:()=>void; wallNow:()=>number; monoNow:()=>number; onPolicy?:(policy:CompanionPolicyEvent)=>void; onUnavailable?:(reason:string)=>void; onDropAutomatic?:()=>void }
/** 展示端只采纳已确认 lease/策略的候选，任何身份或时钟不确定均保守丢弃。 */
export class CompanionClient {
  private state:CompanionDisplayState={visible:false,busyReasons:[],activitySeq:0};
  private epoch=""; private connection=""; private instance="";
  private lease:CompanionLease|undefined; private deadline=0; private anchorMono=0; private anchorServer=0;
  private policy:CompanionPolicyEvent|undefined; private timer:ReturnType<typeof setTimeout>|undefined;
  private generation=0; private retryAttempt=0; private closed=false; private renewing=false; private renewal:Promise<void>|undefined; private confirmedState=""; private manualInFlight=false; private manualPending:{requestId:string;requestSeq:number}|undefined;
  private manualSeq=0; private suppressAutomaticThrough=-1; private seen=new Set<string>(); private lastClock:{wall:number;mono:number}|undefined;
  constructor(private readonly deps:Dependencies){}
  private clear():void {clearTimeout(this.timer);this.timer=undefined;this.lease=undefined;this.epoch="";this.instance="";this.connection="";this.policy=undefined;this.manualPending=undefined;this.manualSeq=0;this.suppressAutomaticThrough=-1;this.confirmedState="";this.seen.clear();this.lastClock=undefined;this.generation++;this.deps.onDropAutomatic?.();}
  isReady():boolean {return !!this.lease&&!this.closed&&this.checkClock();}
  disconnected():void {this.clear();}
  invalidate():void {if(this.closed)return;const wasConnected=!!this.connection;this.clear();if(wasConnected)this.deps.reconnect();}
  dispose():void {if(this.closed)return;const l=this.lease;if(l)void this.deps.call("/companion/display/release",{protocolVersion:1,runtimeEpoch:l.runtimeEpoch,leaseId:l.leaseId}).catch(()=>undefined);this.closed=true;this.clear();}
  checkClock():boolean {
    const wall=this.deps.wallNow(),mono=this.deps.monoNow(),last=this.lastClock;this.lastClock={wall,mono};
    if(last&&(mono<last.mono||wall<last.wall||wall-last.wall>15000||mono-last.mono>15000||Math.abs((wall-last.wall)-(mono-last.mono))>1000)){this.invalidate();return false;}
    if(this.lease&&(mono>=this.deadline||wall>=this.lease.expiresAt)){this.invalidate();return false;}return true;
  }
  setDisplayState(state:CompanionDisplayState):void {this.state={...state,busyReasons:[...state.busyReasons]};if(!state.visible||state.busyReasons.length)this.deps.onDropAutomatic?.();if(this.lease&&!this.renewing)void this.renew();}
  async connected(ready:WsReady):Promise<void> {
    this.clear(); if(this.closed||!ready.connectionId||!ready.runtimeEpoch)return;
    this.connection=ready.connectionId;this.epoch=ready.runtimeEpoch;const generation=this.generation;
    try {
      const status=await this.deps.call("/companion/status") as CompanionStatus;
      if(generation!==this.generation||this.closed)return;
      if(status.protocolVersion!==1||status.runtimeEpoch!==this.epoch){this.deps.onUnavailable?.("companion_protocol_unsupported");return;}
      const policy={runtimeEpoch:status.runtimeEpoch,policyRevision:status.policyRevision,settingsVersion:status.settingsVersion,historyEpoch:status.historyEpoch,dnd:status.dnd,companion:status.companion,healthy:status.companion!==null&&status.automaticBlock!=="storage_unavailable"&&status.automaticBlock!=="clock_untrusted"};
      this.applyPolicy(policy);this.instance=crypto.randomUUID();const submittedState={...this.state,busyReasons:[...this.state.busyReasons]};const start=this.deps.monoNow();this.lastClock={wall:this.deps.wallNow(),mono:start};
      const lease=await this.deps.call("/companion/display/acquire",{protocolVersion:1,runtimeEpoch:this.epoch,connectionId:this.connection,displayInstanceId:this.instance,state:submittedState}) as CompanionLease;
      if(generation!==this.generation||this.closed)return;
      if(!this.adopt(lease,start,0)){this.invalidate();return;}this.retryAttempt=0;this.confirmedState=JSON.stringify(submittedState);if(this.confirmedState!==JSON.stringify(this.state))void this.renew();else this.schedule();
    } catch(error) {
      if(generation!==this.generation||this.closed)return;
      const code=error instanceof AssistantClientError?error.code:"runtime_unavailable";
      const retry=error instanceof AssistantClientError
        ? error.status===429 || (error.status!==undefined&&error.status>=500) || (error.status===undefined&&error.code==="runtime_unavailable")
        : true;
      this.deps.onUnavailable?.(code);
      this.clear();
      if(retry&&!this.closed){
        const delay=Math.min(30000,3000*2**Math.min(this.retryAttempt,4));this.retryAttempt++;
        this.timer=setTimeout(()=>{this.timer=undefined;if(!this.closed)this.deps.reconnect();},delay);
      }
    }
  }
  private applyPolicy(value:CompanionPolicyEvent):void {
    if(value.runtimeEpoch!==this.epoch||(this.policy&&value.policyRevision<=this.policy.policyRevision))return;
    this.policy=value;this.deps.onPolicy?.(value);
    if(!value.healthy||value.dnd||!value.companion?.murmurEnabled||(value.companion.murmurSnoozedUntil??0)>this.deps.wallNow())this.deps.onDropAutomatic?.();
  }
  private adopt(lease:CompanionLease,start:number,seq:number):boolean {
    if(lease.runtimeEpoch!==this.epoch||lease.connectionId!==this.connection||lease.displayInstanceId!==this.instance||lease.stateSeq!==seq||lease.leaseMs!==15000||this.deps.monoNow()>=start+15000||this.deps.wallNow()>=lease.expiresAt)return false;
    this.lease=lease;this.deadline=start+15000;this.anchorMono=start;this.anchorServer=lease.serverNow;return true;
  }
  private schedule():void {clearTimeout(this.timer);this.timer=setTimeout(()=>void this.renew(),5000);}
  private renew():Promise<void> {
    if(this.renewal)return this.renewal;
    const pending=this.renewOnce();this.renewal=pending;
    void pending.finally(()=>{
      if(this.renewal!==pending)return;
      this.renewal=undefined;
      if(this.lease&&this.confirmedState!==JSON.stringify(this.state))void this.renew();
    });return pending;
  }
  private async renewOnce():Promise<void>{
    if(this.renewing||!this.lease||!this.checkClock())return;this.renewing=true;clearTimeout(this.timer);
    const l=this.lease,generation=this.generation,start=this.deps.monoNow(),seq=l.stateSeq+1,state={...this.state,busyReasons:[...this.state.busyReasons]};
    try {const next=await this.deps.call("/companion/display/renew",{protocolVersion:1,runtimeEpoch:this.epoch,leaseId:l.leaseId,stateSeq:seq,state}) as CompanionLease;
      if(generation!==this.generation)return;
      if(!this.adopt(next,start,seq)){this.invalidate();return;}this.confirmedState=JSON.stringify(state);this.schedule();
    }catch{if(generation===this.generation)this.invalidate();}finally{this.renewing=false;}
  }
  onEvent(event:RuntimeEvent):void {
    if(event.kind==="assistant.companion.policy"){this.applyPolicy(event.payload as unknown as CompanionPolicyEvent);return;}
    if(event.kind!=="assistant.companion")return;const value=event.payload as unknown as CompanionUtterance;
    this.accept(value);
  }
  private accept(value:CompanionUtterance):boolean {
    const l=this.lease,p=this.policy,now=this.deps.wallNow(),mono=this.deps.monoNow();
    if(!validUtterance(value,"automatic")||!l||value.runtimeEpoch!==this.epoch||value.leaseId!==l.leaseId||value.displayInstanceId!==this.instance||this.seen.has(value.utteranceId))return false;
    // 候选一经观察即终结；交互状态变化后不能重放先前丢弃的候选。
    this.remember(value.utteranceId);
    if(!p||!this.checkClock()||value.protocolVersion!==1||value.runtimeEpoch!==this.epoch||value.leaseId!==l.leaseId||value.displayInstanceId!==this.instance||value.displayStateSeq!==l.stateSeq||value.policyRevision!==p.policyRevision||value.historyEpoch!==p.historyEpoch||value.settingsVersion!==p.settingsVersion||!this.state.visible||this.state.busyReasons.length>0||!p.healthy||p.dnd||!p.companion?.murmurEnabled||(p.companion.murmurSnoozedUntil??0)>now||now>=value.expiresAt||mono>=this.anchorMono+(value.expiresAt-this.anchorServer)||typeof value.text!=="string"||!value.text.trim()||value.text.length>80||this.manualInFlight||value.createdAt<=this.suppressAutomaticThrough){void this.ack(value.utteranceId,"discarded");return false;}
    const shown=this.deps.show(value);void this.ack(value.utteranceId,shown?"displayed":"discarded");return shown;
  }
  private remember(id:string):void {this.seen.add(id);while(this.seen.size>256)this.seen.delete(this.seen.values().next().value!);}
  async say():Promise<CompanionSayResponse>{
    if(this.manualInFlight)throw new AssistantClientError("companion_display_busy");
    this.manualInFlight=true;
    try{return await this.sayOnce();}finally{this.manualInFlight=false;}
  }
  private async sayOnce():Promise<CompanionSayResponse>{
    if(this.renewal)await this.renewal;
    if(this.lease&&this.confirmedState!==JSON.stringify(this.state))await this.renew();
    const l=this.lease;if(!l||!this.checkClock()||!this.state.visible||this.state.busyReasons.some(v=>v==="voice"||v==="drag"))throw new AssistantClientError("companion_display_busy");
    this.deps.onDropAutomatic?.();
    this.suppressAutomaticThrough=Math.max(this.suppressAutomaticThrough,this.deps.wallNow());
    if(!this.manualPending)this.manualPending={requestId:crypto.randomUUID(),requestSeq:this.manualSeq+1};
    const req=this.manualPending,generation=this.generation;
    const result=await this.deps.call("/companion/say",{protocolVersion:1,runtimeEpoch:this.epoch,leaseId:l.leaseId,...req}) as CompanionSayResponse;
    if(generation!==this.generation||this.lease?.leaseId!==l.leaseId)throw new AssistantClientError("companion_lease_expired");
    if(!result||typeof result!=="object"||!validUtterance(result.utterance,"manual")||!Array.isArray(result.supersedes)||result.supersedes.length>1||!result.supersedes.every(uuid))throw new AssistantClientError("invalid_response");
    this.manualSeq=req.requestSeq;this.manualPending=undefined;
    for(const id of result.supersedes)this.remember(id);
    const u=result.utterance;
    const visible = !this.deps.beforeShow || await this.deps.beforeShow();
    const now=this.deps.wallNow();
    const eligible=visible&&!this.seen.has(u.utteranceId)&&generation===this.generation&&this.lease?.leaseId===l.leaseId&&this.checkClock()&&u.runtimeEpoch===this.epoch&&u.leaseId===l.leaseId&&u.displayInstanceId===this.instance&&u.displayStateSeq===this.lease.stateSeq&&u.policyRevision===this.policy?.policyRevision&&this.policy.healthy&&u.settingsVersion===this.policy.settingsVersion&&u.historyEpoch===this.policy.historyEpoch&&now<u.expiresAt&&this.deps.monoNow()<this.anchorMono+(u.expiresAt-this.anchorServer)&&this.state.visible&&!this.state.busyReasons.some(v=>v==="voice"||v==="drag");
    const shown=eligible&&this.deps.show(u);
    this.remember(u.utteranceId);
    if(generation===this.generation&&this.lease?.leaseId===l.leaseId)void this.ack(u.utteranceId,shown?"displayed":"discarded");
    if(!shown)throw new AssistantClientError("companion_display_not_shown");
    return result;
  }
  async ack(utteranceId:string,result:"displayed"|"discarded"):Promise<void>{const l=this.lease;if(!l)return;try{await this.deps.call("/companion/ack",{protocolVersion:1,runtimeEpoch:this.epoch,leaseId:l.leaseId,utteranceId,result});}catch{/* ACK 不重试，也不返还预算。 */}}
}
