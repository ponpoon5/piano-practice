// 電子ピアノ(P-125 など)とのやりとり。iPad の Safari には無いので「Web MIDI Browser」で開く。

// アプリによって入力の一覧の形が違う(Map / forEach だけのもの)ので、どちらでも取り出す
function ports(m) {
  const out = [];
  if (!m) return out;
  try {
    if (typeof m.forEach === 'function') m.forEach((p) => out.push(p));
    else if (typeof m.values === 'function') for (const p of m.values()) out.push(p);
  } catch (e) {}
  return out.filter((p) => p && p.state !== 'disconnected');
}

export const midi = {
  status: 'init', // init / unsupported / denied / none / ok
  access: null,
  inputName: '',
  outputName: '',
  output: null,
  onNoteOn: null,
  onNoteOff: null,
  onChange: null,
  down: new Set(),
  lastError: '',
  _timer: null,
  _tries: 0,

  async init() {
    if (!navigator.requestMIDIAccess) {
      this.status = 'unsupported';
      this.changed();
      return;
    }
    await this.request();
    // つないだことを知らせてくれないアプリもあるので、つながるまで見に行く
    if (!this._timer) {
      this._timer = setInterval(() => {
        if (this.status === 'ok') return;
        this._tries++;
        if (this._tries % 3 === 0) this.request();
        else this.refresh();
      }, 2000);
    }
  },

  async request() {
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.access.onstatechange = () => this.refresh();
      this.lastError = '';
    } catch (e) {
      this.lastError = (e && (e.name || e.message)) || String(e);
      this.status = 'denied';
      this.changed();
      return;
    }
    this.refresh();
  },

  refresh() {
    if (!this.access) return;
    const ins = ports(this.access.inputs);
    const outs = ports(this.access.outputs).filter((p) => !/through/i.test(p.name || ''));
    for (const i of ins) {
      if (i.onmidimessage !== this._handler) i.onmidimessage = this._handler;
      try {
        if (typeof i.open === 'function') i.open();
      } catch (e) {}
    }
    this.inputName = ins.map((i) => i.name || '電子ピアノ').join('、');
    this.output = outs[0] || null;
    this.outputName = this.output ? this.output.name : '';
    const before = this.status;
    this.status = ins.length ? 'ok' : 'none';
    if (before !== this.status || before === 'ok') this.changed();
  },

  _handler: null,

  message(d) {
    const cmd = d[0] & 0xf0;
    if (cmd === 0x90 && d[2] > 0) {
      this.down.add(d[1]);
      if (this.onNoteOn) this.onNoteOn(d[1], d[2]);
    } else if (cmd === 0x80 || (cmd === 0x90 && d[2] === 0)) {
      this.down.delete(d[1]);
      if (this.onNoteOff) this.onNoteOff(d[1]);
    }
  },

  // ピアノ側で鳴らす(伴奏・お手本)。durMs 後に止める
  play(p, vel, durMs, ch = 0) {
    if (!this.output) return;
    try {
      this.output.send([0x90 | ch, p, vel]);
      this.output.send([0x80 | ch, p, 0], performance.now() + durMs);
    } catch (e) {}
  },

  allOff() {
    if (!this.output) return;
    try {
      for (let ch = 0; ch < 2; ch++) this.output.send([0xb0 | ch, 123, 0]);
    } catch (e) {}
  },

  // 調べた内容(つながらないときに見せる)
  diagnose() {
    const a = this.access;
    return [
      `MIDIの機能: ${navigator.requestMIDIAccess ? 'あり' : 'なし'}`,
      `状態: ${this.status}${this.lastError ? '(' + this.lastError + ')' : ''}`,
      `入力: ${a ? ports(a.inputs).map((p) => p.name).join('、') || 'なし' : '-'}`,
      `出力: ${a ? ports(a.outputs).map((p) => p.name).join('、') || 'なし' : '-'}`,
    ].join('\n');
  },

  changed() {
    if (this.onChange) this.onChange();
  },

  get connected() {
    return this.status === 'ok';
  },
};
midi._handler = (e) => midi.message(e.data);
