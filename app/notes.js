// 音符データ(tools/extract_notes.py が作る .notes.json)を扱う。時刻はすべて動画の秒。

export function parseNotesFile(text) {
  const doc = JSON.parse(text);
  if (doc.app !== 'piano-practice-notes' || !Array.isArray(doc.notes)) throw new Error('音符データのファイルではありません');
  const notes = doc.notes
    .filter((n) => Number.isFinite(n.p) && Number.isFinite(n.t) && Number.isFinite(n.d))
    .map((n) => ({ p: n.p | 0, t: +n.t, d: Math.max(0.05, +n.d), h: n.h === 'L' ? 'L' : 'R' }))
    .sort((a, b) => a.t - b.t || a.p - b.p);
  if (!notes.length) throw new Error('音符が入っていません');
  let lo = 127;
  let hi = 0;
  for (const n of notes) {
    lo = Math.min(lo, n.p);
    hi = Math.max(hi, n.p);
  }
  return { source: doc.source || '', duration: doc.duration || null, notes, lo, hi };
}

export function countHands(notes) {
  let r = 0;
  for (const n of notes) if (n.h === 'R') r++;
  return { R: r, L: notes.length - r };
}

// [a, b) に始まる音。hand: 'R' / 'L' / 'B'(両方)
export function inRange(notes, a, b, hand = 'B') {
  return notes.filter((n) => n.t >= a - 0.001 && n.t < b - 0.001 && (hand === 'B' || n.h === hand));
}

// 同時に押す音をまとめる
export function chords(list, eps = 0.06) {
  const out = [];
  for (const n of list) {
    const last = out[out.length - 1];
    if (last && n.t - last.t <= eps) {
      if (!last.ps.includes(n.p)) last.ps.push(n.p);
    } else out.push({ t: n.t, ps: [n.p] });
  }
  return out;
}

// 弾いた音を楽譜の音と突き合わせる。tol は動画の秒
export class Scorer {
  constructor(targets, tol) {
    this.targets = targets.map((n) => ({ ...n, hit: false }));
    this.tol = tol;
    this.extra = 0;
    this.played = 0;
  }
  onNote(p, tv) {
    this.played++;
    let best = null;
    for (const n of this.targets) {
      if (n.hit || n.p !== p) continue;
      const dt = Math.abs(n.t - tv);
      if (dt <= this.tol && (!best || dt < Math.abs(best.t - tv))) best = n;
    }
    if (best) {
      best.hit = true;
      return 'hit';
    }
    this.extra++;
    return 'extra';
  }
  result() {
    const total = this.targets.length;
    const hits = this.targets.filter((n) => n.hit).length;
    return { total, hits, extra: this.extra, played: this.played, missed: this.targets.filter((n) => !n.hit) };
  }
}

// 採点 → ◎△×
export function gradeFrom(r) {
  if (r.total === 0) return null;
  const acc = r.hits / r.total;
  const extraRate = r.extra / r.total;
  if (acc >= 0.95 && extraRate <= 0.1) return 'ok';
  if (acc >= 0.8 && extraRate <= 0.3) return 'meh';
  return 'ng';
}

// 外した音が一番集まっている幅 win の窓
export function worstWindow(missed, win) {
  const ts = missed.map((n) => n.t).sort((a, b) => a - b);
  let best = null;
  let j = 0;
  for (let i = 0; i < ts.length; i++) {
    while (ts[i] - ts[j] > win) j++;
    const c = i - j + 1;
    if (!best || c > best.count) best = { start: ts[j], end: ts[i], count: c };
  }
  return best;
}

// ---------- 描画 ----------

const BLACK = new Set([1, 3, 6, 8, 10]);
export const isBlack = (p) => BLACK.has(((p % 12) + 12) % 12);

// lo〜hi(白鍵から始まり白鍵で終わるよう広げる)の鍵の位置を出す
export function layout(lo, hi, width) {
  while (isBlack(lo)) lo--;
  while (isBlack(hi)) hi++;
  let nWhite = 0;
  for (let p = lo; p <= hi; p++) if (!isBlack(p)) nWhite++;
  const ww = width / nWhite;
  const keys = new Map();
  let wi = 0;
  for (let p = lo; p <= hi; p++) {
    if (isBlack(p)) {
      keys.set(p, { x: wi * ww - ww * 0.3, w: ww * 0.6, black: true });
    } else {
      keys.set(p, { x: wi * ww, w: ww, black: false });
      wi++;
    }
  }
  return { lo, hi, ww, keys };
}

const COL = { R: '#6cc04a', L: '#5b9bd5' };
const COL_DIM = { R: 'rgba(108,192,74,.22)', L: 'rgba(91,155,213,.22)' };

// 鍵盤を描く。state: { sounding: Map p→hand, expect: Map p→hand, pressed: Map p→'ok'|'bad'|'free' }
export function drawKeyboard(ctx, lay, x0, y0, w, h, state) {
  const sounding = state.sounding || new Map();
  const expect = state.expect || new Map();
  const pressed = state.pressed || new Map();
  ctx.save();
  ctx.translate(x0, y0);
  ctx.fillStyle = '#555';
  ctx.fillRect(0, 0, w, h);
  for (const [p, k] of lay.keys) {
    if (k.black) continue;
    ctx.fillStyle = '#f2f2f2';
    if (sounding.has(p)) ctx.fillStyle = COL[sounding.get(p)];
    const pr = pressed.get(p);
    if (pr) ctx.fillStyle = pr === 'bad' ? '#e05a4f' : pr === 'ok' ? '#ffffff' : '#d8d8d8';
    ctx.fillRect(k.x + 0.5, 0, k.w - 1, h);
    if (pr === 'ok') {
      ctx.fillStyle = COL.R;
      ctx.fillRect(k.x + 0.5, h - 6, k.w - 1, 6);
    }
    if (expect.has(p)) {
      ctx.strokeStyle = COL[expect.get(p)];
      ctx.lineWidth = 3;
      ctx.strokeRect(k.x + 2, 2, k.w - 4, h - 4);
    }
  }
  for (const [p, k] of lay.keys) {
    if (!k.black) continue;
    ctx.fillStyle = '#1b1b1b';
    if (sounding.has(p)) ctx.fillStyle = COL[sounding.get(p)];
    const pr = pressed.get(p);
    if (pr) ctx.fillStyle = pr === 'bad' ? '#e05a4f' : '#ffffff';
    ctx.fillRect(k.x, 0, k.w, h * 0.62);
    if (expect.has(p)) {
      ctx.strokeStyle = COL[expect.get(p)];
      ctx.lineWidth = 3;
      ctx.strokeRect(k.x + 1.5, 1.5, k.w - 3, h * 0.62 - 3);
    }
  }
  // ドの位置
  ctx.fillStyle = '#888';
  ctx.font = `${Math.max(8, Math.min(11, lay.ww * 0.45))}px sans-serif`;
  ctx.textAlign = 'center';
  for (const [p, k] of lay.keys) if (p % 12 === 0) ctx.fillText('C' + (p / 12 - 1), k.x + k.w / 2, h - 3);
  ctx.restore();
}

// 落ちてくる音符(上が未来)。win は画面に見せる動画の秒
export function drawFalling(ctx, lay, w, h, notes, t, win, hand) {
  ctx.fillStyle = '#202329';
  ctx.fillRect(0, 0, w, h);
  // ド・ファの線
  ctx.strokeStyle = 'rgba(255,255,255,.07)';
  ctx.lineWidth = 1;
  for (const [p, k] of lay.keys) {
    if (p % 12 === 0 || p % 12 === 5) {
      ctx.beginPath();
      ctx.moveTo(k.x + 0.5, 0);
      ctx.lineTo(k.x + 0.5, h);
      ctx.stroke();
    }
  }
  const pxs = h / win;
  // 二分探索で見える範囲の手前から
  let i0 = 0;
  let a = 0;
  let b = notes.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (notes[m].t < t - 20) a = m + 1;
    else b = m;
  }
  i0 = a;
  for (let i = i0; i < notes.length; i++) {
    const n = notes[i];
    if (n.t > t + win) break;
    if (n.t + n.d < t) continue;
    const k = lay.keys.get(n.p);
    if (!k) continue;
    const yTop = h - (n.t + n.d - t) * pxs;
    const yBot = h - (n.t - t) * pxs;
    const mine = hand === 'B' || n.h === hand;
    ctx.fillStyle = mine ? COL[n.h] : COL_DIM[n.h];
    const x = k.black ? k.x : k.x + k.w * 0.12;
    const bw = k.black ? k.w : k.w * 0.76;
    const r = Math.min(5, bw / 3);
    roundRect(ctx, x, Math.max(-10, yTop), bw, Math.max(3, Math.min(h + 10, yBot) - Math.max(-10, yTop)), r);
    ctx.fill();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
