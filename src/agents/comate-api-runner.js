import { AgentRunner } from '../agent/runner.js';

/** Comate must acknowledge native cancellation; EOF/taskkill is not a successful stop. */
export class ComateApiRunner extends AgentRunner {
  constructor(options) {
    super(options);
    this.nativeStop = null;
    this.stopWaitMs = options?.nativeStopWaitMs || 20000;
    this._nativeStopPromise = null;
    this._ioClosed = false;
    this.on('io-close', () => { this._ioClosed = true; });
    this.on('line', (line) => {
      let frame; try { frame = JSON.parse(line); } catch { return; }
      if (frame?.protocol === 'comate-local-api-v1' && frame.type === 'stop_result') {
        const verified = frame.confirmed === true && ((frame.reason === 'native-cancelled' && frame.native_cancelled === true)
          || (frame.reason === 'not-started' && frame.native_cancelled === false));
        this.nativeStop = { confirmed: verified,
          native_cancelled: frame.native_cancelled === true,
          reason: frame.reason === 'native-cancelled' ? 'native-cancelled' : frame.reason === 'not-started' ? 'not-started' : 'native-cancel-unconfirmed' };
      }
    });
  }

  stop() {
    if (!this.child) return Promise.resolve({ exited: true, confirmed: true, native_cancelled: false, reason: 'never-started' });
    if (!this._nativeStopPromise) this._nativeStopPromise = this._stopNative();
    return this._nativeStopPromise;
  }

  async _stopNative() {
    if (!this.alive) return { exited: true, confirmed: false, native_cancelled: false, reason: 'already-exited' };
    if (!this.sendJson({ type: 'control_stop' })) return { exited: false, confirmed: false, native_cancelled: false, reason: 'control-write-failed' };
    // Keep stdin open while worker waits for native cancelled SSE and history.
    await new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.off('io-close', done); resolve(); };
      const timer = setTimeout(done, this.stopWaitMs);
      this.once('io-close', done);
      if (this._ioClosed) done();
    });
    const exited = !this.alive;
    return { exited, confirmed: exited && this.nativeStop?.confirmed === true,
      native_cancelled: exited && this.nativeStop?.native_cancelled === true,
      reason: this.nativeStop?.reason || 'native-cancel-unconfirmed',
      code: this.child.exitCode, signal: this.child.signalCode };
  }
}
