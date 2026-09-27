export class AudioRecorder {
  constructor(onData) {
    this._onData = onData; this._ctx = null; this._worklet = null;
    this._source = null; this._stream = null;
  }
  async start(deviceId) {
    const audio = { sampleRate: 16000, channelCount: 1, echoCancellation: true };
    if (deviceId) audio.deviceId = { exact: deviceId };
    this._stream = await navigator.mediaDevices.getUserMedia({ audio });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this._ctx = new Ctx({ sampleRate: 16000 });
    await this._ctx.audioWorklet.addModule("/static/js/pcm-recorder-processor.js");
    this._source = this._ctx.createMediaStreamSource(this._stream);
    this._worklet = new AudioWorkletNode(this._ctx, "pcm-recorder-processor");
    this._worklet.port.onmessage = (e) => {
      const f32 = e.data.audio;
      const i16 = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) {
        const s = Math.max(-1, Math.min(1, f32[i]));
        i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this._onData(i16.buffer);
    };
    this._source.connect(this._worklet);
    const sink = this._ctx.createGain(); sink.gain.value = 0;
    this._worklet.connect(sink); sink.connect(this._ctx.destination);
  }
  stop() {
    if (this._worklet) { this._worklet.disconnect(); this._worklet = null; }
    if (this._source) { this._source.disconnect(); this._source = null; }
    if (this._stream) { this._stream.getTracks().forEach((t) => t.stop()); this._stream = null; }
    if (this._ctx) { this._ctx.close(); this._ctx = null; }
  }
}