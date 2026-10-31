import type { PetAction, PetPack, PetState } from "./pet-pack.js";

export interface Playback {
  id: number;
  clipId: string;
  state: PetState;
  actionId?: string;
}

interface ActiveAction {
  definition: PetAction;
  clipIndex: number;
}

export class AnimationChain {
  private nextPlaybackId = 0;
  private requestedState: PetState = "idle";
  private currentPlayback: Playback;
  private activeAction: ActiveAction | undefined;

  constructor(
    private readonly pack: PetPack,
    private readonly random: () => number,
  ) {
    this.currentPlayback = this.playState();
  }

  get current(): Playback {
    return this.currentPlayback;
  }

  setState(state: PetState): Playback {
    this.requestedState = state;
    this.activeAction = undefined;
    this.currentPlayback = this.playState();
    return this.currentPlayback;
  }

  play(actionId: string): Playback | undefined {
    const definition = this.pack.actions.find((action) => action.id === actionId);
    if (!definition) {
      return undefined;
    }
    if (
      this.activeAction &&
      (!this.activeAction.definition.interruptible ||
        this.activeAction.definition.priority > definition.priority)
    ) {
      return undefined;
    }
    this.activeAction = { definition, clipIndex: 0 };
    this.currentPlayback = this.playAction(this.activeAction);
    return this.currentPlayback;
  }

  complete(playbackId: number): Playback {
    if (playbackId !== this.currentPlayback.id) {
      return this.currentPlayback;
    }
    if (this.activeAction) {
      if (this.activeAction.clipIndex + 1 < this.activeAction.definition.clips.length) {
        this.activeAction.clipIndex += 1;
        this.currentPlayback = this.playAction(this.activeAction);
        return this.currentPlayback;
      }
      this.activeAction = undefined;
    }
    this.currentPlayback = this.playState();
    return this.currentPlayback;
  }

  private playState(): Playback {
    const state = this.pack.states[this.requestedState] ? this.requestedState : "idle";
    const animation = this.pack.states[state];
    if (!animation) {
      throw new Error("Pet pack idle state has no animation");
    }
    const clipId = this.selectClip(animation.clips, animation.weights);
    this.nextPlaybackId += 1;
    return { id: this.nextPlaybackId, clipId, state };
  }

  private playAction(action: ActiveAction): Playback {
    const clipId = action.definition.clips[action.clipIndex];
    if (clipId === undefined) {
      throw new Error("Pet pack action has no clip");
    }
    this.nextPlaybackId += 1;
    return {
      id: this.nextPlaybackId,
      clipId,
      state: this.requestedState,
      actionId: action.definition.id,
    };
  }

  private selectClip(clips: string[], weights: number[]): string {
    const scale = Math.max(...weights);
    const total = weights.reduce((sum, weight) => sum + weight / scale, 0);
    const target = this.random() * total;
    let cumulative = 0;
    for (let index = 0; index < clips.length; index += 1) {
      cumulative += (weights[index] ?? 0) / scale;
      if (target < cumulative) {
        return clips[index]!;
      }
    }
    throw new Error("Pet pack animation has no selectable clip");
  }
}
