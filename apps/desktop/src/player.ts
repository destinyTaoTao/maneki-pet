import {
  AnimationChain,
  type ClipSource,
  type PetPack,
  type PetState,
  type Playback,
} from "@maneki-pet/core";

export class PetPlayer {
  private chain: AnimationChain | undefined;
  private pack: PetPack | undefined;
  private packId = "";
  private cancelCurrent: () => void = () => {};

  constructor(
    private readonly container: HTMLElement,
    private readonly onFallback: () => void,
  ) {}

  loadPack(pack: PetPack, packId: string): void {
    this.cancelCurrent();
    this.pack = pack;
    this.packId = packId;
    this.chain = new AnimationChain(pack, Math.random);
    this.render(this.chain.current);
  }

  setState(state: PetState): void {
    if (this.chain) {
      this.render(this.chain.setState(state));
    }
  }

  playAction(actionId: string): void {
    if (!this.chain) return;
    const playback = this.chain.play(actionId);
    if (playback) this.render(playback);
  }

  private complete(playbackId: number): void {
    if (!this.chain || this.chain.current.id !== playbackId) return;
    const playback = this.chain.complete(playbackId);
    if (playback.id !== playbackId) this.render(playback);
  }

  private render(playback: Playback): void {
    this.cancelCurrent();
    this.cancelCurrent = () => {};
    this.container.replaceChildren();
    const clip = this.pack?.clips[playback.clipId];
    if (!clip) {
      this.renderFallback();
      return;
    }
    const video = document.createElement("video");
    const sources = clip.sources.filter(
      (source) =>
        source.renderer === "spritesheet" || video.canPlayType(source.mimeType) !== "",
    );
    this.renderSource(playback, sources, 0);
  }

  private renderSource(playback: Playback, sources: ClipSource[], index: number): void {
    if (!this.chain || this.chain.current.id !== playback.id) return;
    this.cancelCurrent();
    this.cancelCurrent = () => {};
    this.container.replaceChildren();
    const source = sources[index];
    if (!source) {
      this.renderFallback();
      return;
    }
    const path = `/packs/${this.packId}/${source.path}`;
    const retry = () => {
      if (this.chain?.current.id === playback.id) {
        this.renderSource(playback, sources, index + 1);
      }
    };
    if (source.renderer === "video-alpha") {
      this.renderVideo(playback, path, retry);
    } else {
      this.renderSpritesheet(playback, path, source, retry);
    }
  }

  private renderVideo(playback: Playback, path: string, retry: () => void): void {
    const video = document.createElement("video");
    video.className = "pet-media";
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.preload = "auto";
    video.src = path;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      this.complete(playback.id);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      retry();
    };
    video.onended = finish;
    video.onerror = fail;
    this.cancelCurrent = () => {
      settled = true;
      video.onended = null;
      video.onerror = null;
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
    this.container.append(video);
    void video.play().catch(fail);
  }

  private renderSpritesheet(
    playback: Playback,
    path: string,
    source: Extract<ClipSource, { renderer: "spritesheet" }>,
    retry: () => void,
  ): void {
    const frameWindow = document.createElement("div");
    frameWindow.className = "sprite-frame";
    const strip = document.createElement("img");
    strip.className = "sprite-strip";
    strip.draggable = false;
    strip.alt = "";
    strip.src = path;
    strip.style.width = `${source.frameCount * 100}%`;
    frameWindow.append(strip);
    this.container.append(frameWindow);
    let frame = 0;
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        this.complete(playback.id);
      }
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      retry();
    };
    const interval = window.setInterval(() => {
      frame += 1;
      if (frame >= source.frameCount) {
        finish();
        return;
      }
      strip.style.transform = `translateX(-${(frame * 100) / source.frameCount}%)`;
    }, 1000 / source.framesPerSecond);
    strip.onerror = fail;
    this.cancelCurrent = () => {
      settled = true;
      window.clearInterval(interval);
      strip.onerror = null;
      strip.removeAttribute("src");
    };
  }

  private renderFallback(): void {
    this.cancelCurrent();
    this.cancelCurrent = () => {};
    const image = document.createElement("img");
    image.className = "pet-media";
    image.src = "/fallback.png";
    image.alt = "";
    image.draggable = false;
    this.container.replaceChildren(image);
    this.onFallback();
  }
}
