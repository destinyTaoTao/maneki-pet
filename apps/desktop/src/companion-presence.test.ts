import { expect,it,vi } from "vitest";
import { bindCompanionInputFocus, CompanionPresence } from "./companion-presence.js";
it("combines independent interaction reasons and increments only for interaction",()=>{const change=vi.fn(),resume=vi.fn();const p=new CompanionPresence(change,resume);expect(p.snapshot()).toEqual({visible:false,busyReasons:[],activitySeq:0});p.setVisible(true);p.setBusy("voice",true);p.setBusy("panel",true);p.setBusy("voice",false);expect(p.snapshot()).toEqual({visible:true,busyReasons:["panel"],activitySeq:0});p.noteInteraction();expect(p.snapshot().activitySeq).toBe(1);p.resume();expect(resume).toHaveBeenCalledOnce();p.dispose();});

it("input focus follows window focus even when activeElement remains unchanged",()=>{
 let focused=true;const active={tagName:"INPUT"};const root=Object.assign(new EventTarget(),{contains:(element:unknown)=>element===active}) as unknown as HTMLElement;
 const doc={hasFocus:()=>focused,activeElement:active} as unknown as Document;const win=new EventTarget() as Window;
 const presence=new CompanionPresence(()=>undefined,()=>undefined);presence.setBusy("voice",true);presence.setBusy("panel",true);presence.setBusy("drag",true);
 const stop=bindCompanionInputFocus(root,doc,win,value=>presence.setBusy("input",value));root.dispatchEvent(new Event("focusin"));expect(presence.snapshot().busyReasons).toContain("input");
 focused=false;win.dispatchEvent(new Event("blur"));expect(presence.snapshot().busyReasons).toEqual(["drag","panel","voice"]);
 focused=true;win.dispatchEvent(new Event("focus"));expect(presence.snapshot().busyReasons).toEqual(["drag","input","panel","voice"]);
 stop();presence.dispose();
});
