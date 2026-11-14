import type { PetState } from "@maneki-pet/core";
import type { VoicePhase } from "./voice-controller.js";

/** 倾听期间缓存宿主状态，停止采集后恢复最新表现。 */
export class VoicePetCoordinator {
  private listening = false;
  private latest: PetState = "idle";
  private dnd = true;

  constructor(private readonly deps: {
    showListening(value: boolean): void;
    setState(state: PetState): void;
    playAction(action: string): void;
  }) {}

  setDnd(value: boolean): void { this.dnd = value; }

  voiceChanged(phase: VoicePhase): void {
    const listening = phase === "recording";
    if (listening === this.listening) return;
    this.listening = listening;
    this.deps.showListening(listening);
    if (listening) {
      this.deps.setState("thinking");
      this.deps.playAction("head-tilt");
    } else this.deps.setState(this.latest);
  }

  expressionChanged(state: PetState, live: boolean): void {
    const previous = this.latest;
    this.latest = state;
    if (this.listening) return;
    this.deps.setState(state);
    if (live && state === "waiting_input" && previous !== state && !this.dnd)
      this.deps.playAction("wave");
  }

  restoreLatest(): void { if (!this.listening) this.deps.setState(this.latest); }

  playAction(action: string): void {
    if (!this.listening) this.deps.playAction(action);
  }
}
