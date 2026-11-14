import type { CompanionUtterance } from "@maneki-pet/core";
type BubbleValue = { utteranceId:string; text:string; mode:"automatic"|"manual"|"important"; utterance?:CompanionUtterance };
/** 单槽气泡的定时器属于其展示实例，不影响后继内容。 */
export class CompanionBubble {
  private current:BubbleValue|null=null; private timer:ReturnType<typeof setTimeout>|undefined; private busy=false;
  constructor(private readonly deps:{render:(value:BubbleValue|null)=>void;playAction:(id:string)=>void;restoreLatest:()=>void}){}
  show(utterance:CompanionUtterance):boolean {
    if(utterance.mode==="automatic"&&(this.busy||this.current?.mode==="important"||this.current?.mode==="manual"))return false;
    this.replace({utteranceId:utterance.utteranceId,text:utterance.text,mode:utterance.mode,utterance},6000);
    if(utterance.actionId)this.deps.playAction(utterance.actionId);return true;
  }
  showImportant(id:string,text:string):void {if(!this.busy&&this.current?.mode!=="manual")this.replace({utteranceId:id,text,mode:"important"},4000);}
  showFeedback(id:string,text:string):void {this.replace({utteranceId:id,text,mode:"manual"},4000);}
  setUserBusy(value:boolean):void {this.busy=value;if(value&&(this.current?.mode==="automatic"||this.current?.mode==="important"))this.dismiss(this.current.utteranceId);}
  dropAutomatic():void {if(this.current?.mode==="automatic")this.dismiss(this.current.utteranceId);}
  private replace(value:BubbleValue,duration:number):void {clearTimeout(this.timer);if(this.current?.utterance?.actionId)this.deps.restoreLatest();this.current=value;this.deps.render(value);this.timer=setTimeout(()=>this.dismiss(value.utteranceId),duration);}
  dismiss(id:string):void {if(this.current?.utteranceId!==id)return;clearTimeout(this.timer);const hadAction=!!this.current.utterance?.actionId;this.current=null;this.deps.render(null);if(hadAction||this.busy)this.deps.restoreLatest();}
  dispose():void {clearTimeout(this.timer);this.current=null;this.deps.render(null);}
}
