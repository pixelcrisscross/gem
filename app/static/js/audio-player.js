export class AudioPlayer {
  constructor() {
    this._context = null;
    this._worklet = null;
  }

  async init() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this._context = new Ctx({ sampleRate: 24000 });
    await this._context.audioWorklet.addModule("/static/js/pcm-player-processor.js");
    this._worklet = new AudioWorkletNode(this._context, "pcm-player-processor");
    this._worklet.connect(this._context.destination);
  }

  play(pcmBytes) {
    if (!this._worklet) return;
    if (this._context.state === "suspended") this._context.resume();
    this._worklet.port.postMessage(pcmBytes.buffer || pcmBytes);
  }

  stop() {
    if (this._worklet) this._worklet.port.postMessage({ command: "endOfAudio" });
    if (this._context) {
      this._context.close();
      this._context = null;
      this._worklet = null;
    }
  }
}