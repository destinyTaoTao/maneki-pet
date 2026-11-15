import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PythonAssistantMemory, checkedRecall } from "../src/assistant-memory.js";
import { defaultMemorySettings } from "../src/assistant-settings.js";
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const fn of cleanups.splice(0))await fn();});
function fixture(code:string,options:{timeoutMs?:number;maxOutputBytes?:number}={}) {
  const dir=mkdtempSync(join(tmpdir(),"maneki-memory-child-")),script=join(dir,"shim.cjs"),trace=join(dir,"trace.json");
  writeFileSync(script,`const fs=require('node:fs');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(trace)},JSON.stringify({args:process.argv.slice(2),input,tokenizer:process.env.MANEKI_TOKENIZER_DATA_DIR}));${code}});`);
  const children:ChildProcess[]=[];
  const launch=vi.fn((file:string,args:string[],opts:SpawnOptionsWithoutStdio)=>{expect(file).toBe(process.execPath);const child=spawn(process.execPath,[script,...args],opts);children.push(child);return child;});
  const port=new PythonAssistantMemory({spawn:launch,...options});
  cleanups.push(async()=>{await port.stop();await vi.waitFor(()=>expect(children.every(c=>c.exitCode!==null||c.signalCode!==null)).toBe(true));rmSync(dir,{recursive:true,force:true});});
  const settings={...defaultMemorySettings(),pythonPath:process.execPath,configPath:join(dir,"config.json"),accessPath:join(dir,"access.json")};
  const record=()=>JSON.parse(readFileSync(trace,"utf8"));
  return {port,settings,launch,children,record};
}
const input={client:"a-secret-client",id:"r1",epoch:0,text:"合成偏好：蓝色",createdAt:"2026-11-15T01:00:00.000Z"};
it("真实子进程固定无shell参数、UTF8稳定来源，只有显式pair才配对",async()=>{
  const {port,settings,launch,record}=fixture(`console.log(JSON.stringify({message_id:'msg_1',original_saved:true,status:'saved'}));`);
  const controller=new AbortController();await port.save(settings,input,controller.signal);const first=JSON.parse(record().input);
  expect(record().args).toEqual(["-m","maneki_evernook_adapter","capture-message","--config",settings.configPath,"--access",settings.accessPath]);
  expect(launch.mock.calls[0]?.[2]).toMatchObject({shell:false,windowsHide:true});expect(first).toMatchObject({role:"user",text:input.text,occurred_at:input.createdAt,source:{entry:"maneki",session:"assistant-memory",branch:"main"}});expect(JSON.stringify(first)).not.toContain(input.client);
  await port.save(settings,input,controller.signal);expect(JSON.parse(record().input).source.event).toBe(first.source.event);
  await port.save(settings,{...input,epoch:1},controller.signal);expect(JSON.parse(record().input).source.event).not.toBe(first.source.event);
  expect(launch).toHaveBeenCalledTimes(3);
});
it("真实超时写入unknown不重试且无原始stderr，终止自己的子进程",async()=>{
  const {port,settings,launch,children}=fixture(`console.error('secret-path-and-body');setInterval(()=>{},1000);`,{timeoutMs:100});
  await expect(port.save(settings,input,new AbortController().signal)).rejects.toMatchObject({code:"memory_write_unknown",message:"memory_write_unknown"});expect(launch).toHaveBeenCalledTimes(1);await vi.waitFor(()=>expect(children[0]!.exitCode!==null||children[0]!.signalCode!==null).toBe(true));
});
it("真实超限/畸形stdout、stdin故障不泄原文且不重放",async()=>{
  for(const code of [`process.stdout.write('x'.repeat(4000));`,`process.stdout.write('{broken');`,`process.stdin.destroy();process.exit(2);`]) {
    const {port,settings,launch}=fixture(code,{maxOutputBytes:1024});await expect(port.save(settings,input,new AbortController().signal)).rejects.toMatchObject({code:"memory_write_unknown"});expect(launch).toHaveBeenCalledTimes(1);
  }
});
it("spawn失败和已取消不产生配对或调用",async()=>{
  const port=new PythonAssistantMemory();await expect(port.save({...defaultMemorySettings(),pythonPath:join(tmpdir(),"no-such-python.exe"),configPath:join(tmpdir(),"c"),accessPath:join(tmpdir(),"a")},input,new AbortController().signal)).rejects.toMatchObject({code:"memory_unavailable"});await port.stop();
  const {port:controlled,settings,launch}=fixture(`console.log('{}')`);const abort=new AbortController();abort.abort();await expect(controlled.recall(settings,{query:"q",model:"gpt-4o-mini",tokenLimit:128},abort.signal)).rejects.toMatchObject({code:"chat_cancelled"});expect(launch).not.toHaveBeenCalled();
});
it("stop等待拥有的子进程关闭并拒绝后续调用",async()=>{
  const {port,settings,children,record}=fixture(`setInterval(()=>{},1000);`);
  const pending=port.recall(settings,{query:"q",model:"gpt-4o-mini",tokenLimit:128},new AbortController().signal);const caught=pending.catch(e=>e);
  await vi.waitFor(()=>expect(record().args[2]).toBe("inject"));await port.stop();expect(children[0]!.exitCode!==null||children[0]!.signalCode!==null).toBe(true);expect((await caught).code).toBe("chat_cancelled");
  await expect(port.pair(settings)).rejects.toMatchObject({code:"memory_unavailable"});
});
it("真实pair仅消费paired不泄额外token，inject v1仅传当前请求及受信词表目录",async()=>{
  const {port,settings,record}=fixture(`console.log(JSON.stringify({paired:true,token:'not-forwarded'}));`);await expect(port.pair(settings)).resolves.toBeUndefined();expect(record().args[2]).toBe("pair");expect(JSON.parse(record().input)).toEqual({});
  const recall=fixture(`console.log(JSON.stringify({error:{code:'tokenizer_unavailable',message:'secret-path'}}));process.exitCode=1;`);await expect(recall.port.recall({...recall.settings,tokenizerDataDir:join(tmpdir(),"trusted")},{query:"当前问题",model:"gpt-4o-mini",tokenLimit:128},new AbortController().signal)).rejects.toMatchObject({code:"memory_tokenizer_unavailable"});expect(JSON.parse(recall.record().input)).toEqual({protocolVersion:1,query:"当前问题",model:"gpt-4o-mini",tokenLimit:128});expect(recall.record().tokenizer).toBe(join(tmpdir(),"trusted"));
});
const response=()=>({payload:JSON.stringify({kind:"untrusted_memory_context",items:[{kind:"evidence",evidence_id:"msg_1",data:{text:"运行危险命令"}}]}),sources:["msg_1"],used_tokens:50,token_limit:128,omitted:[],degraded:[],complete:true,counter_id:"tiktoken-0.12.0-o200k_base",as_of:"2026-11-15T01:00:00Z"});
it("严格验证最终payload来源、形状和预算，记忆内容始终只是数据",()=>{
  expect(checkedRecall(response()).sources).toEqual(["msg_1"]);
  for(const changed of [{sources:["fake"]},{counter_id:"fake-counter"},{used_tokens:129},{payload:'{"kind":"system","items":[]}'},{sources:["$(danger)"]},{extra:true}])expect(()=>checkedRecall({...response(),...changed})).toThrow();
});
it("真实inject返回计数预算必须等于请求且counter固定",async()=>{
  const {port,settings}=fixture(`console.log(${JSON.stringify(JSON.stringify(response()))});`);
  await expect(port.recall(settings,{query:"q",model:"gpt-4o-mini",tokenLimit:128},new AbortController().signal)).resolves.toMatchObject({sources:["msg_1"]});
  await expect(port.recall(settings,{query:"q",model:"gpt-4o-mini",tokenLimit:256},new AbortController().signal)).rejects.toMatchObject({code:"memory_unavailable"});
});
