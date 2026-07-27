/**
 * Microphone tap for dictation: raw float32 samples out, in useful-sized pieces.
 *
 * Runs on the audio thread, which is the point — a dropped render quantum here
 * is a gap in what the recogniser hears, and the main thread is busy rendering
 * a chat. It does nothing but copy: no resampling (the AudioContext is created
 * at 16 kHz so the browser has already done it), no encoding.
 *
 * A separate file rather than a blob: URL because the renderer's CSP is
 * `script-src 'self'` and a worklet is a script — a blob would be silently
 * blocked in the packaged app while working fine in dev.
 */

/** 256ms at 16 kHz. Small enough that partials feel live, large enough that
 * the IPC round-trip per chunk is noise (4/second, not 125/second). */
const CHUNK = 4096;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(CHUNK);
    this.n = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    // No input yet is normal on the first quanta; keeping the processor alive
    // (true) is what lets it start producing once the track goes live.
    if (channel === undefined) return true;
    for (let i = 0; i < channel.length; i += 1) {
      this.buf[this.n] = channel[i];
      this.n += 1;
      if (this.n === CHUNK) {
        // A copy, transferred: the port would otherwise structured-clone a view
        // onto a buffer this processor keeps writing into.
        const out = this.buf.slice(0);
        this.port.postMessage(out, [out.buffer]);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
