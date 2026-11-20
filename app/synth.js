// iPad で鳴らす簡単なピアノ風の音(伴奏・お手本用)

let ctx = null;
let master = null;

export function unlockAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.35;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp);
    comp.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
}

export function playNote(p, dur, vel = 0.8) {
  if (!ctx) return;
  const f = 440 * Math.pow(2, (p - 69) / 12);
  const t = ctx.currentTime;
  const len = Math.min(Math.max(dur, 0.15), 6);
  const g = ctx.createGain();
  const peak = 0.5 * vel * (p < 48 ? 1.1 : 1);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
  g.gain.exponentialRampToValueAtTime(peak * 0.35, t + 0.25);
  g.gain.setTargetAtTime(peak * 0.12, t + 0.25, 1.2);
  g.gain.setTargetAtTime(0.0001, t + len, 0.08);
  g.connect(master);
  const parts = [
    [1, 'triangle', 1],
    [2, 'sine', 0.35],
    [3, 'sine', 0.12],
  ];
  for (const [mul, type, amp] of parts) {
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.type = type;
    o.frequency.value = f * mul;
    og.gain.value = amp;
    o.connect(og);
    og.connect(g);
    o.start(t);
    o.stop(t + len + 0.6);
  }
}
