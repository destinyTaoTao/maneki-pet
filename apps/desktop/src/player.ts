import {
  AnimationChain,
  type ClipSource,
  type PetPack,
  type PetState,
  type Playback,
} from "@maneki-pet/core";

import { AssetCache } from "./asset-cache.js";
import { MEDIA_READ_TIMEOUT_MS, readBounded } from "./bounded-fetch.js";
import { imageWithinPixelBudget, withinPixelBudget } from "./media-budget.js";

// 与动作包 v1 单文件上限保持一致。
const MAX_ASSET_BYTES = 64 * 1024 * 1024;

export class PetPlayer {
  private chain: AnimationChain | undefined;
  private pack: PetPack | undefined;
  private packId = "";
  private cancelCurrent: () => void = () => {};
  private readonly cache: AssetCache;

  constructor(
    private readonly container: HTMLElement,
    private readonly onFallback: () => void,
    private readonly onRestricted: () => void = () => {},
    private readonly onRecovered: () => void = () => {},
  ) {
    this.cache = new AssetCache(
      1,
      (key, signal) => this.loadAssetUrl(key, signal),
      (url) => URL.revokeObjectURL(url),
    );
  }

  dispose(): void {
    this.cancelCurrent();
    this.cache.clear();
    this.container.replaceChildren();
    this.chain = undefined;
    this.pack = undefined;
  }

  loadPack(pack: PetPack, packId: string): void {
    this.cancelCurrent();
    this.cache.clear();
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

  private async loadAssetUrl(key: string, signal: AbortSignal): Promise<string> {
    const prefix = `${this.packId}/`;
    if (!key.startsWith(prefix)) throw new Error("asset pack changed");
    const path = key.slice(prefix.length);
    const source = Object.values(this.pack?.clips ?? {}).flatMap((clip) => clip.sources).find((item) => item.path === path);
    if (!source) throw new Error("asset source missing");
    const response = await fetch(`/packs/${key}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(MEDIA_READ_TIMEOUT_MS)]) });
    const bytes = await readBounded(response, MAX_ASSET_BYTES);
    signal.throwIfAborted();
    if (source.renderer === "spritesheet" && !imageWithinPixelBudget(bytes, source.mimeType)) throw new Error("image exceeds resource budget");
    return URL.createObjectURL(new Blob([bytes], { type: source.mimeType }));
  }

  private resolveAssetUrl(path: string): Promise<string> {
    return this.cache.get(`${this.packId}/${path}`);
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
    const path = source.path;
    const retry = () => {
      if (this.chain?.current.id === playback.id) {
        this.onRestricted();
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
    video.preload = "metadata";
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
    this.cancelCurrent = () => {
      settled = true;
      video.onended = null;
      video.onerror = null;
      video.onloadedmetadata = null;
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
    this.container.append(video);
    void this.resolveAssetUrl(path).then(
      (url) => {
        if (settled) return;
        video.onended = finish;
        video.onerror = fail;
        video.onloadedmetadata = () => {
          if (!withinPixelBudget(video.videoWidth, video.videoHeight)) { fail(); return; }
          void video.play().then(() => { if (!settled) this.onRecovered(); }).catch(fail);
        };
        video.src = url;
      },
      () => fail(),
    );
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
    let interval: number | undefined;
    strip.onload = () => {
      if (settled) return;
      this.onRecovered();
      interval = window.setInterval(() => {
        frame += 1;
        if (frame >= source.frameCount) {
          finish();
          return;
        }
        strip.style.transform = `translateX(-${(frame * 100) / source.frameCount}%)`;
      }, 1000 / source.framesPerSecond);
    };
    strip.onerror = fail;
    this.cancelCurrent = () => {
      settled = true;
      window.clearInterval(interval);
      strip.onload = null;
      strip.onerror = null;
      strip.removeAttribute("src");
    };
    void this.resolveAssetUrl(path).then(
      (url) => {
        if (settled) return;
        strip.src = url;
      },
      () => fail(),
    );
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
