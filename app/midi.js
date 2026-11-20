// 電子ピアノ(P-125 など)とのやりとり。iPad の Safari には無いので「Web MIDI Browser」で開く。

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

  async init() {
    if (!navigator.requestMIDIAccess) {
      this.status = 'unsupported';
      this.changed();
      return;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (e) {
      this.status = 'denied';
      this.changed();
      return;
    }
    this.access.onstatechange = () => this.refresh();
    this.refresh();
  },

  refresh() {
    const ins = [...this.access.inputs.values()].filter((p) => p.state !== 'disconnected');
    const outs = [...this.access.outputs.values()].filter((p) => p.state !== 'disconnected' && !/through/i.test(p.name || ''));
    for (const i of ins) i.onmidimessage = (e) => this.message(e.data);
    this.inputName = ins.map((i) => i.name).join('、');
    this.output = outs[0] || null;
    this.outputName = this.output ? this.output.name : '';
    this.status = ins.length ? 'ok' : 'none';
    this.changed();
  },

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

  // ピアノ側で鳴らす(伴奏・お手本)。delayMs 後に止める
  play(p, vel, durMs, ch = 0) {
    if (!this.output) return;
    const now = performance.now();
    try {
      this.output.send([0x90 | ch, p, vel]);
      this.output.send([0x80 | ch, p, 0], now + durMs);
    } catch (e) {}
  },

  allOff() {
    if (!this.output) return;
    try {
      for (let ch = 0; ch < 2; ch++) this.output.send([0xb0 | ch, 123, 0]);
    } catch (e) {}
  },

  changed() {
    if (this.onChange) this.onChange();
  },

  get connected() {
    return this.status === 'ok';
  },
};
