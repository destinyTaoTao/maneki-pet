import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { AssistantError, checkedMemory, type AssistantMemorySettings } from "./assistant-settings.js";

export interface MemorySaveInput { client:string; id:string; epoch:number; text:string; createdAt:string }
export interface MemoryReceipt { message_id:string; original_saved:boolean; status:string }
export interface MemoryQuery { query:string; model:string; tokenLimit:number }
export interface MemoryRecall { payload:string; sources:string[]; degraded:string[] }
export interface AssistantMemoryPort {
  pair(settings:AssistantMemorySettings,signal?:AbortSignal):Promise<void>;
  save(settings:AssistantMemorySettings,input:MemorySaveInput,signal:AbortSignal):Promise<MemoryReceipt>;
  recall(settings:AssistantMemorySettings,input:MemoryQuery,signal:AbortSignal):Promise<MemoryRecall>;
  invalidate():void;
  stop():Promise<void>;
}
export type MemorySpawn = (command:string,args:string[],options:SpawnOptionsWithoutStdio)=>ChildProcessWithoutNullStreams;
const object = (raw:unknown): raw is Record<string,unknown> => Boolean(raw && typeof raw === "object" && !Array.isArray(raw));
const sourceId = (raw:unknown): raw is string => typeof raw === "string" && /^[A-Za-z0-9_.:/-]{1,200}$/.test(raw);
export function checkedRecall(raw:unknown):MemoryRecall {
  if (!object(raw) || Object.keys(raw).some(k=>!["payload","sources","used_tokens","token_limit","omitted","degraded","complete","counter_id","as_of"].includes(k)) ||
      typeof raw.payload !== "string" || Buffer.byteLength(raw.payload,"utf8") > 128*1024 ||
      !Array.isArray(raw.sources) || raw.sources.length > 8 || !raw.sources.every(sourceId) || new Set(raw.sources).size !== raw.sources.length ||
      !Number.isSafeInteger(raw.used_tokens) || Number(raw.used_tokens)<0 || !Number.isSafeInteger(raw.token_limit) || Number(raw.token_limit)<128 || Number(raw.token_limit)>2048 || Number(raw.used_tokens)>Number(raw.token_limit) ||
      !Array.isArray(raw.omitted) || raw.omitted.length>256 || !raw.omitted.every(v=>typeof v === "string" && v.length<=200) ||
      !Array.isArray(raw.degraded) || raw.degraded.length>64 || !raw.degraded.every(v=>typeof v === "string" && v.length<=200) || typeof raw.complete !== "boolean" ||
      raw.counter_id !== "tiktoken-0.12.0-o200k_base" || typeof raw.as_of !== "string" || raw.as_of.length>80 || !Number.isFinite(Date.parse(raw.as_of)))
    throw new AssistantError(502,"memory_unavailable");
  let payload:unknown;try { payload=JSON.parse(raw.payload); } catch { throw new AssistantError(502,"memory_unavailable"); }
  if (!object(payload) || payload.kind !== "untrusted_memory_context" || !Array.isArray(payload.items) || payload.items.length>256 ||
      !payload.items.every(item=>object(item) && typeof item.kind === "string" && item.kind.length<=80 && sourceId(item.evidence_id) && object(item.data))) throw new AssistantError(502,"memory_unavailable");
  const sources=[...new Set(payload.items.map(item=>(item as Record<string,unknown>).evidence_id as string))].slice(0,8);
  if (JSON.stringify(sources)!==JSON.stringify(raw.sources)) throw new AssistantError(502,"memory_unavailable");
  return {payload:raw.payload,sources,degraded:raw.degraded as string[]};
}

/** 固定 Python 模块和参数；所有可执行路径仅来自已保存的受信设置。 */
export class PythonAssistantMemory implements AssistantMemoryPort {
  private readonly children = new Set<ChildProcessWithoutNullStreams>();
  private readonly closures = new Set<Promise<void>>();
  private readonly cancellations = new Map<ChildProcessWithoutNullStreams,()=>void>();
  private stopped=false;
  constructor(private readonly options:{ spawn?:MemorySpawn; timeoutMs?:number; pairTimeoutMs?:number; maxOutputBytes?:number }={}) {}
  private configured(settings:AssistantMemorySettings):void {
    checkedMemory(settings);
    if (!settings.pythonPath || !settings.configPath || !settings.accessPath) throw new AssistantError(400,"memory_not_configured");
    if (this.stopped) throw new AssistantError(503,"memory_unavailable");
  }
  private call(settings:AssistantMemorySettings,command:"pair"|"capture-message"|"inject",input:unknown,signal?:AbortSignal):Promise<unknown> {
    this.configured(settings);
    if (signal?.aborted) return Promise.reject(new AssistantError(499,"chat_cancelled"));
    const encoded=Buffer.from(JSON.stringify(input),"utf8");
    if (encoded.length>32*1024) return Promise.reject(new AssistantError(400,"memory_request_invalid"));
    return new Promise((resolve,reject)=>{
      let child:ChildProcessWithoutNullStreams;
      try {
        const env={...process.env};
        // 不继承宿主的词表路径；未配置即明确缺失，不触发联网兜底。
        delete env.MANEKI_TOKENIZER_DATA_DIR;
        if (settings.tokenizerDataDir) env.MANEKI_TOKENIZER_DATA_DIR=settings.tokenizerDataDir;
        child=(this.options.spawn??spawn)(settings.pythonPath,["-m","maneki_evernook_adapter",command,"--config",settings.configPath,"--access",settings.accessPath],{shell:false,windowsHide:true,stdio:["pipe","pipe","pipe"],env}) as ChildProcessWithoutNullStreams;
      } catch { reject(new AssistantError(503,"memory_unavailable"));return; }
      this.children.add(child);
      let closed!:()=>void;
      const closure=new Promise<void>(resolve=>{closed=resolve;});
      this.closures.add(closure);
      let sent=false, settled=false, size=0;
      const chunks:Buffer[]=[];
      const finish=(error?:AssistantError,result?:unknown)=>{
        if(settled)return;settled=true;
        clearTimeout(timer);signal?.removeEventListener("abort",abort);
        child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.kill("SIGKILL");
        this.cancellations.delete(child);
        chunks.length=0;
        if(error)reject(error);else resolve(result);
      };
      const failed=()=>finish(new AssistantError(503,command==="capture-message"&&sent?"memory_write_unknown":"memory_unavailable"));
      const abort=()=>finish(new AssistantError(499,command==="capture-message"&&sent?"memory_write_unknown":"chat_cancelled"));
      const timer=setTimeout(failed,command==="pair"?(this.options.pairTimeoutMs??10000):(this.options.timeoutMs??5000));
      this.cancellations.set(child,abort);
      child.once("close",()=>{this.children.delete(child);this.closures.delete(closure);closed();});
      child.once("error",failed);child.stdin.on("error",failed);child.stdout.on("error",failed);child.stderr.on("error",failed);
      child.stderr.on("data",()=>undefined); // 原始 stderr 可能含 token、路径或正文，永不转发。
      child.stdout.on("data",(chunk:Buffer)=>{if(settled)return;size+=chunk.length;if(size>(this.options.maxOutputBytes??128*1024)){failed();return;}chunks.push(Buffer.from(chunk));});
      child.once("close",(code)=>{
        if(settled)return;
        let result:unknown;try{result=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)));}catch{failed();return;}
        if(code!==0 || (object(result)&&Object.hasOwn(result,"error"))){
          const failure=object(result)&&object(result.error)?result.error.code:undefined;
          const known=["unauthorized","permission_denied","permission-denied","pairing_required"].includes(String(failure));
          const errorCode=known?"memory_pairing_required":failure==="tokenizer_unavailable"?"memory_tokenizer_unavailable":command==="capture-message"&&sent?"memory_write_unknown":"memory_unavailable";
          finish(new AssistantError(503,errorCode));return;
        }
        finish(undefined,result);
      });
      signal?.addEventListener("abort",abort,{once:true});
      child.once("spawn",()=>{if(settled)return;try{sent=true;child.stdin.end(encoded);}catch{failed();}});
    });
  }
  async pair(settings:AssistantMemorySettings,signal?:AbortSignal):Promise<void> {
    const result=await this.call(settings,"pair",{},signal);
    if(!object(result)||result.paired!==true)throw new AssistantError(502,"memory_unavailable");
  }
  async save(settings:AssistantMemorySettings,input:MemorySaveInput,signal:AbortSignal):Promise<MemoryReceipt> {
    const event=createHash("sha256").update(JSON.stringify([input.client,input.id,input.epoch])).digest("hex");
    const result=await this.call(settings,"capture-message",{source:{entry:"maneki",session:"assistant-memory",branch:"main",event},role:"user",sequence:1,occurred_at:input.createdAt,completion:"complete",text:input.text},signal);
    if(!object(result)||Object.keys(result).some(k=>!["message_id","original_saved","status"].includes(k))||!sourceId(result.message_id)||typeof result.original_saved!=="boolean"||typeof result.status!=="string"||result.status.length>80)throw new AssistantError(502,"memory_write_unknown");
    return result as unknown as MemoryReceipt;
  }
  async recall(settings:AssistantMemorySettings,input:MemoryQuery,signal:AbortSignal):Promise<MemoryRecall> {
    if(!input.query.trim()||input.query.length>4000||!input.model||input.model.length>120||!Number.isInteger(input.tokenLimit)||input.tokenLimit<128||input.tokenLimit>2048)throw new AssistantError(400,"memory_request_invalid");
    const raw=await this.call(settings,"inject",{protocolVersion:1,...input},signal);
    if(!object(raw)||raw.token_limit!==input.tokenLimit)throw new AssistantError(502,"memory_unavailable");
    return checkedRecall(raw);
  }
  invalidate():void {for(const cancel of this.cancellations.values())cancel();}
  async stop():Promise<void> {
    this.stopped=true;this.invalidate();
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      await Promise.race([Promise.all([...this.closures]),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new AssistantError(503,"memory_cleanup_failed")),5000);})]);
    } finally {if(timer)clearTimeout(timer);}
  }
}
