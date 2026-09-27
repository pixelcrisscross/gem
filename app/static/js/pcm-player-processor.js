class PCMPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 24000 * 180;
    this.buffer = new Float32Array(this.bufferSize);
    this.writeIndex = 0; this.readIndex = 0;
    this.port.onmessage = (event) => {
      if (event.data && event.data.command === "endOfAudio") {
        this.readIndex = this.writeIndex;
        return;
      }
      const i16 = new Int16Array(event.data);
      for (let i = 0; i < i16.length; i++) {
        this.buffer[this.writeIndex] = i16[i] / 32768;
        this.writeIndex = (this.writeIndex + 1) % this.bufferSize;
        if (this.writeIndex === this.readIndex) {
          this.readIndex = (this.readIndex + 1) % this.bufferSize;
        }
      }
    };
  }
  process(inputs, outputs) {
    const output = outputs[0];
    const frames = output[0].length;
    for (let f = 0; f < frames; f++) {
      output[0][f] = this.buffer[this.readIndex];
      if (output.length > 1) output[1][f] = this.buffer[this.readIndex];
      if (this.readIndex !== this.writeIndex) {
        this.readIndex = (this.readIndex + 1) % this.bufferSize;
      }
    }
    return true;
  }
}
registerProcessor("pcm-player-processor", PCMPlayerProcessor);