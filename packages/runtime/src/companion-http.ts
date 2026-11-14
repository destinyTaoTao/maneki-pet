import type { IncomingMessage, ServerResponse } from "node:http";
import type { CompanionAcquireRequest, CompanionRenewRequest, CompanionReleaseRequest, CompanionSayRequest, CompanionAckRequest } from "@maneki-pet/core";
import { AssistantError } from "./assistant-settings.js";
import type { CompanionService } from "./companion-service.js";
const uuid=(v:unknown)=>typeof v==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const number=(v:unknown)=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0;
const id=(v:unknown)=>typeof v==="string"&&/^[A-Za-z0-9_-]{1,80}$/.test(v);
function exact(value:unknown,keys:string[]):value is Record<string,unknown>{return typeof value==="object"&&value!==null&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));}
function state(value:unknown):boolean{
 if(!exact(value,["visible","busyReasons","activitySeq"])||typeof value.visible!=="boolean"||!number(value.activitySeq)||!Array.isArray(value.busyReasons)||value.busyReasons.length>5)return false;
 return new Set(value.busyReasons).size===value.busyReasons.length&&value.busyReasons.every(v=>typeof v==="string"&&["input","voice","drag","panel","important"].includes(v));
}
function checked(path:string,body:Record<string,unknown>):void {
 const invalid=()=>{throw new AssistantError(400,"companion_request_invalid");};
 const common=["protocolVersion","runtimeEpoch"];
 const fields:Record<string,string[]>={
  "/display/acquire":[...common,"connectionId","displayInstanceId","state"],
  "/display/renew":[...common,"leaseId","stateSeq","state"],
  "/display/release":[...common,"leaseId"],
  "/say":[...common,"leaseId","requestId","requestSeq"],
  "/ack":[...common,"leaseId","utteranceId","result"],
 };
 const keys=fields[path];if(!keys||!exact(body,keys))return invalid();
 if(body.protocolVersion!==1){if(number(body.protocolVersion))throw new AssistantError(400,"companion_protocol_unsupported");return invalid();}
 if(!uuid(body.runtimeEpoch))return invalid();
 for(const key of ["connectionId","displayInstanceId","leaseId","utteranceId"])if(key in body&&!uuid(body[key]))return invalid();
 if("state" in body&&!state(body.state))return invalid();
 if("stateSeq" in body&&(!number(body.stateSeq)||body.stateSeq===0))return invalid();
 if("requestSeq" in body&&(!number(body.requestSeq)||body.requestSeq===0))return invalid();
 if("requestId" in body&&!id(body.requestId))return invalid();
 if("result" in body&&body.result!=="displayed"&&body.result!=="discarded")return invalid();
}
export async function handleCompanionHttp(req:IncomingMessage,res:ServerResponse,client:{clientId:string;scopes:string[]},service:CompanionService,readBody:(maxBytes?:number)=>Promise<Record<string,unknown>|undefined>):Promise<boolean>{
 const path=new URL(req.url??"/","http://127.0.0.1").pathname.slice("/v1/assistant/companion".length);
 const post=["/display/acquire","/display/renew","/display/release","/say","/ack"];
 if(req.method==="GET"&&path==="/status") {res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(service.status()));return true;}
 if(req.method!=="POST"||!post.includes(path))return false;
 if(!client.scopes.includes("assistant"))throw new AssistantError(403,"assistant_scope_required");
 const body=await readBody(8192);if(!body)return true;checked(path,body);
 let result:unknown;
 switch(path){
  case "/display/acquire":result=service.acquire(client.clientId,body as unknown as CompanionAcquireRequest);break;
  case "/display/renew":result=service.renew(client.clientId,body as unknown as CompanionRenewRequest);break;
  case "/display/release":result=service.release(client.clientId,body as unknown as CompanionReleaseRequest);break;
  case "/say":result=service.say(client.clientId,body as unknown as CompanionSayRequest);break;
  case "/ack":result=service.ack(client.clientId,body as unknown as CompanionAckRequest);break;
 }
 const json=JSON.stringify(result);if(Buffer.byteLength(json)>16384)throw new AssistantError(503,"companion_state_unavailable");
 res.writeHead(200,{"content-type":"application/json"});res.end(json);return true;
}
