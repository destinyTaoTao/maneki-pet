import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { RuntimeStore } from "../src/store.js";
import { CompanionReferences } from "../src/companion-references.js";

it("keeps references with their user messages and removes them when history is cleared", () => {
  const runtime = new RuntimeStore(":memory:");
  try {
    const store = runtime.assistantStore();
    const refs = new CompanionReferences(store);
    const reference = { utteranceId: "11111111-1111-4111-8111-111111111111", text: "你好", mode: "manual" as const, createdAt: 100 };
    let seq = 0;
    store.transaction(() => { seq = store.append("user", "回应"); refs.put(store.epoch(), seq, reference); });
    expect(refs.get(store.epoch(), seq)).toEqual(reference);
    store.transaction(() => { refs.clear(); store.clearHistory(); });
    expect(refs.get(0, seq)).toBeUndefined();
  } finally { runtime.close(); }
});

it("removes orphaned references after an older runtime cleared history", () => {
  const runtime = new RuntimeStore(":memory:");
  try {
    const store = runtime.assistantStore();
    const refs = new CompanionReferences(store);
    const reference = { utteranceId: "11111111-1111-4111-8111-111111111111", text: "你好", mode: "automatic" as const, createdAt: 100 };
    let seq = 0;
    store.transaction(() => { seq = store.append("user", "回应"); refs.put(store.epoch(), seq, reference); });
    const orphan = store.get(`companion.reference.0.${seq}`)!;
    store.transaction(() => store.clearHistory());
    store.set(`companion.reference.0.${seq}`, orphan); // 模拟旧 Runtime 不认识引用 KV。
    refs.pruneOrphans();
    expect(refs.get(0, seq)).toBeUndefined();
  } finally { runtime.close(); }
});

it("history readers expose committed references only on their corresponding user message", () => {
  const runtime = new RuntimeStore(":memory:");
  try {
    const store = runtime.assistantStore(); const refs = new CompanionReferences(store);
    const reference = { utteranceId: "11111111-1111-4111-8111-111111111111", text: "你好", mode: "manual" as const, createdAt: 100 };
    let seq = 0; store.transaction(() => { seq = store.append("user", "回应"); refs.put(store.epoch(), seq, reference); store.append("assistant", "好的"); });
    expect(store.message(seq)?.companionReference).toEqual(reference);
    expect(store.messages()[0]?.companionReference).toEqual(reference);
    expect(store.messages()[1]?.companionReference).toBeUndefined();
    store.transaction(() => store.clearHistory());
    expect(refs.get(0, seq)).toBeUndefined();
  } finally { runtime.close(); }
});

it("prunes only known v1 orphan keys and leaves unknown formats and malformed keys untouched",()=>{
 const runtime=new RuntimeStore(":memory:");try{
  const store=runtime.assistantStore(),refs=new CompanionReferences(store);
  const ref={utteranceId:"11111111-1111-4111-8111-111111111111",text:"你好",mode:"manual" as const,createdAt:100};
  const live=store.append("user","live"),assistant=store.append("assistant","assistant");
  refs.put(0,live,ref);refs.put(0,assistant,ref);refs.put(1,123,ref);
  store.set("companion.reference.0.999",JSON.stringify({formatVersion:2,epoch:0,userSeq:999}));
  store.set("companion.reference.malformed","future data");
  store.set("companion.reference.0.998",JSON.stringify({formatVersion:1,epoch:0,userSeq:998,unexpected:true}));
  refs.pruneOrphans();
  expect(refs.get(0,live)).toEqual(ref);expect(refs.get(0,assistant)).toBeUndefined();expect(refs.get(1,123)).toBeUndefined();
  expect(store.get("companion.reference.0.999")).toContain('"formatVersion":2');expect(store.get("companion.reference.malformed")).toBe("future data");expect(store.get("companion.reference.0.998")).toContain("unexpected");
 }finally{runtime.close();}
});
it("orphan message checks use the SQLite INTEGER PRIMARY KEY index",()=>{
 const db=new DatabaseSync(":memory:");try{
  db.exec("CREATE TABLE assistant_messages(seq INTEGER PRIMARY KEY,epoch INTEGER,role TEXT)");
  const plan=db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM assistant_messages WHERE seq=? AND epoch=? AND role='user'").all(10,1);
  expect(JSON.stringify(plan)).toContain("INTEGER PRIMARY KEY");
 }finally{db.close();}
});

it("prunes across bounded key pages while preserving oversized and future-format records",()=>{
 const runtime=new RuntimeStore(":memory:");try{
  const store=runtime.assistantStore(),refs=new CompanionReferences(store);
  const ref={utteranceId:"11111111-1111-4111-8111-111111111111",text:"你好",mode:"manual" as const,createdAt:100};
  store.transaction(()=>{for(let i=1;i<=300;i++)refs.put(1,i,ref);store.set("companion.reference.1.999",JSON.stringify({formatVersion:2,epoch:1,userSeq:999,blob:"x".repeat(5000)}));});
  refs.pruneOrphans();
  for(let i=1;i<=300;i++)expect(store.get(`companion.reference.1.${i}`)).toBeNull();
  expect(store.get("companion.reference.1.999")).toContain('"formatVersion":2');
 }finally{runtime.close();}
});

it("范围引用分页使用当前会话KV前缀索引和消息主键点查",()=>{
 const db=new DatabaseSync(":memory:");try{db.exec("CREATE TABLE assistant_messages(seq INTEGER PRIMARY KEY,epoch INTEGER,role TEXT); CREATE TABLE runtime_kv(key TEXT PRIMARY KEY,value TEXT)");
 const keyPlan=db.prepare("EXPLAIN QUERY PLAN SELECT key FROM runtime_kv WHERE key>=? AND key<? AND key>? ORDER BY key LIMIT 128").all("p","q","");
 const messagePlan=db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM assistant_messages WHERE seq=? AND epoch=? AND role='user'").all(1,0);
 expect(JSON.stringify(keyPlan)).toContain("SEARCH runtime_kv USING COVERING INDEX");expect(JSON.stringify(messagePlan)).toContain("INTEGER PRIMARY KEY");
 }finally{db.close();}
});
