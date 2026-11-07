import { captureWave } from "@maneki-pet/core";
export interface VoiceCapture {
  start(): Promise<void>;
  finish(): Promise<Uint8Array>;
  cancel(): Promise<void>;
}
export interface VoicePlayer {
  play(bytes: Uint8Array): Promise<void>;
  stop(): void;
}
export class BrowserVoiceCapture implements VoiceCapture {
  private stream: MediaStream | undefined;
  private context: AudioContext | undefined;
  private source: MediaStreamAudioSourceNode | undefined;
  private node: AudioWorkletNode | undefined;
  private closed = false;
  private chunks: Float32Array[] = [];
  private count = 0;
  private flushed: (() => void) | undefined;
  async start() {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error("microphone_unavailable");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    });
    this.stream = stream;
    if (this.closed) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error("voice_cancelled");
    }
    try {
      const context = new AudioContext();
      this.context = context;
      await context.audioWorklet.addModule(
        new URL("./capture-worklet.js?no-inline", import.meta.url).href,
      );
      if (this.closed) throw new Error("voice_cancelled");
      const node = new AudioWorkletNode(context, "maneki-capture");
      this.node = node;
      node.port.onmessage = (event) => {
        if (event.data?.flushed) {
          this.flushed?.();
          return;
        }
        if (
          this.closed ||
          !(event.data instanceof Float32Array) ||
          this.count >= context.sampleRate * 30
        )
          return;
        const chunk = event.data.slice(0, context.sampleRate * 30 - this.count);
        this.count += chunk.length;
        this.chunks.push(chunk);
      };
      this.source = context.createMediaStreamSource(stream);
      const mute = context.createGain();
      mute.gain.value = 0;
      this.source.connect(node);
      node.connect(mute);
      mute.connect(context.destination);
      await context.resume();
      if (this.closed) throw new Error("voice_cancelled");
    } catch (error) {
      await this.cancel();
      throw error;
    }
  }
  async finish() {
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.node) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 300);
        this.flushed = () => {
          clearTimeout(timer);
          resolve();
        };
        this.node!.port.postMessage("flush");
      });
    }
    const rate = this.context?.sampleRate ?? 48000,
      samples = new Float32Array(this.count);
    let offset = 0;
    for (const chunk of this.chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    await this.cancel();
    return captureWave(samples, rate);
  }
  async cancel() {
    this.closed = true;
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
    }
    this.source?.disconnect();
    await this.context?.close().catch(() => undefined);
    this.chunks = [];
    this.count = 0;
    this.flushed?.();
  }
}
export class BrowserVoicePlayer implements VoicePlayer {
  private audio: HTMLAudioElement | undefined;
  private cancel: (() => void) | undefined;
  play(bytes: Uint8Array): Promise<void> {
    this.stop();
    const url = URL.createObjectURL(
        new Blob([bytes.slice().buffer], { type: "audio/wav" }),
      ),
      audio = new Audio(url);
    this.audio = audio;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
        URL.revokeObjectURL(url);
        if (this.audio === audio) {
          this.audio = undefined;
          this.cancel = undefined;
        }
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(
        () => finish(new Error("speech_playback_timeout")),
        60000,
      );
      this.cancel = () => finish(new Error("voice_cancelled"));
      audio.onended = () => finish();
      audio.onerror = () => finish(new Error("speech_playback_failed"));
      void audio
        .play()
        .catch(() => finish(new Error("speech_playback_blocked")));
    });
  }
  stop() {
    this.cancel?.();
  }
}
