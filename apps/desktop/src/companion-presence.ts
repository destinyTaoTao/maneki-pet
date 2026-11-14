import type { CompanionBusyReason,CompanionDisplayState } from "@maneki-pet/core";
/** 仅汇总小招窗口内的交互状态，不收集系统级活动。 */
export class CompanionPresence {
  private visible=false;private readonly busy=new Set<CompanionBusyReason>();private seq=0;private disposed=false;
  constructor(private readonly onChange:(state:CompanionDisplayState)=>void,private readonly onResume:()=>void){}
  snapshot():CompanionDisplayState{return {visible:this.visible,busyReasons:[...this.busy].sort(),activitySeq:this.seq};}
  setVisible(value:boolean):void {if(this.disposed||this.visible===value)return;this.visible=value;this.onChange(this.snapshot());}
  setBusy(reason:CompanionBusyReason,value:boolean):void {if(this.disposed||this.busy.has(reason)===value)return;if(value)this.busy.add(reason);else this.busy.delete(reason);this.onChange(this.snapshot());}
  noteInteraction():void {if(this.disposed)return;this.seq++;this.onChange(this.snapshot());}
  resume():void {if(!this.disposed)this.onResume();}
  dispose():void {this.disposed=true;}
}

/** 窗口失焦时 activeElement 可能不变，必须同时考虑文档焦点。 */
export function bindCompanionInputFocus(root:HTMLElement, doc:Document, view:Window, setBusy:(value:boolean)=>void):()=>void {
  let disposed=false;
  const sync=()=>{if(disposed)return;const active=doc.activeElement;setBusy(Boolean(doc.hasFocus()&&active&&root.contains(active)&&(active.tagName==="INPUT"||active.tagName==="TEXTAREA")));};
  const deferred=()=>queueMicrotask(sync);
  const blur=()=>setBusy(false);
  root.addEventListener("focusin",sync);root.addEventListener("focusout",deferred);
  view.addEventListener("blur",blur);view.addEventListener("focus",sync);
  return ()=>{disposed=true;root.removeEventListener("focusin",sync);root.removeEventListener("focusout",deferred);view.removeEventListener("blur",blur);view.removeEventListener("focus",sync);};
}
