// 動画のない曲で、動画の代わりに時間を進める時計。
// アプリが動画に対して使う所(currentTime・play・pause・playbackRate・各イベント)だけを同じ形で持つ。

export class ClockPlayer extends EventTarget {
  constructor() {
    super();
    this.duration = 0;
    this._base = 0; // 止めた時点の位置(秒)
    this._t0 = 0; // 動き出した時刻(ms)
    this._rate = 1;
    this.paused = true;
    this.muted = true;
    this.readyState = 4;
    this.src = 'clock';
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.style = {};
  }

  reset(duration) {
    this.pause();
    this.duration = duration;
    this._base = 0;
  }

  _now() {
    return performance.now();
  }

  get currentTime() {
    if (this.paused) return this._base;
    const t = this._base + ((this._now() - this._t0) / 1000) * this._rate;
    if (t >= this.duration) {
      this._base = this.duration;
      this.paused = true;
      this.dispatchEvent(new Event('pause'));
      this.dispatchEvent(new Event('ended'));
      return this.duration;
    }
    return t;
  }

  set currentTime(t) {
    this._base = Math.min(Math.max(0, +t || 0), this.duration);
    this._t0 = this._now();
    this.dispatchEvent(new Event('seeked'));
  }

  get playbackRate() {
    return this._rate;
  }

  set playbackRate(r) {
    if (!this.paused) {
      this._base = this.currentTime;
      this._t0 = this._now();
    }
    this._rate = r > 0 ? r : 1;
  }

  play() {
    if (this.paused) {
      if (this._base >= this.duration) this._base = 0;
      this._t0 = this._now();
      this.paused = false;
      this.dispatchEvent(new Event('play'));
    }
    return Promise.resolve();
  }

  pause() {
    if (!this.paused) {
      this._base = this.currentTime;
      this.paused = true;
      this.dispatchEvent(new Event('pause'));
    }
  }

  removeAttribute() {}
  load() {}
}
