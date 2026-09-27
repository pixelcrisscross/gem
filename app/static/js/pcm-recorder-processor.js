class PCMRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._bufferSize = 8000;
    this._buffer = new Float32Array(this._bufferSize);
    this._index = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    for (let i = 0; i < ch.length; i++) {
      this._buffer[this._index++] = ch[i];
      if (this._index >= this._bufferSize) {
        this.port.postMessage({ audio: this._buffer.slice() });
        this._index = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-recorder-processor", PCMRecorderProcessor);