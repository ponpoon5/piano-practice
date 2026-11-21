// 音符データから、曲の切れ目として自然な区切りを選ぶ(画面に依存しない。node のテストからも読む)。
//
// 1. 左手(低音)の打鍵の繰り返しから小節の長さ P と位置を推定する
// 2. 和音(ほぼ同時の打鍵)ごとに「ここから始めると自然か」の点をつける
//    小節の頭 / 長い低音が始まる / 直前の音がそろって離れる / 少し間がある / 和音が変わる
// 3. 区間の長さが目安に近く、2・4・8小節のまとまりになる組み合わせを動的計画法で選ぶ

const EPS = 0.06; // 同時とみなす幅(秒)

function groupsOf(notes) {
  const ns = notes.slice().sort((a, b) => a.t - b.t || a.p - b.p);
  const gs = [];
  for (const n of ns) {
    const g = gs[gs.length - 1];
    if (g && n.t - g.t <= EPS) g.notes.push(n);
    else gs.push({ t: n.t, notes: [n] });
  }
  return gs;
}

function percentile(xs, q) {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

function median(xs) {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
}

// 低音の打鍵の並びから小節の長さと位置。見つからなければ null
export function estimateBar(gs, minP = 1.2, maxP = 16) {
  const bassT = [];
  const w = [];
  for (const g of gs) {
    const ls = g.notes.filter((n) => n.h === 'L');
    if (!ls.length) continue;
    bassT.push(g.t);
    w.push(1 + Math.min(3, Math.max(...ls.map((n) => n.d))));
  }
  if (bassT.length < 8) return null;
  const R = 0.02; // 20ms 刻み
  const T = bassT[bassT.length - 1] + 1;
  const n = Math.ceil(T / R);
  const x = new Float32Array(n);
  bassT.forEach((t, i) => {
    const k = Math.round(t / R);
    // 少しぼかして演奏の揺れを許す
    for (let d = -2; d <= 2; d++) if (k + d >= 0 && k + d < n) x[k + d] += w[i] * (1 - Math.abs(d) / 3);
  });
  const lo = Math.round(minP / R);
  const hi = Math.min(Math.round(maxP / R), n >> 1);
  const ac = [];
  for (let L = lo; L <= hi; L++) {
    let s = 0;
    for (let i = 0; i + L < n; i++) s += x[i] * x[i + L];
    ac.push([L, s / (n - L)]);
  }
  if (!ac.length) return null;
  const top = Math.max(...ac.map((a) => a[1]));
  if (top <= 0) return null;
  // いちばん強い周期(ほぼ同じ強さの山が複数あれば短い方)。規則正しい曲ではその倍数も同じ強さになるが、
  // 区間は 1・2・4・8… 単位でまとめるので、どれを選んでも区切りはほぼ同じになる。
  // 位置(小節の頭)は曲全体では決めない: テンポの揺れがたまるので scoreGroups でその場ごとに確かめる
  const at = ac.findIndex((a, i) => a[1] >= top * 0.9 && (i === 0 || a[1] >= ac[i - 1][1]) && (i === ac.length - 1 || a[1] >= ac[i + 1][1]));
  return { P: ac[at][0] * R };
}

// 各和音の「ここから区間を始めると自然」の点
export function scoreGroups(gs, bar) {
  const iois = [];
  for (let i = 1; i < gs.length; i++) iois.push(gs[i].t - gs[i - 1].t);
  const mIOI = Math.max(0.05, median(iois));
  const lDur = median(gs.flatMap((g) => g.notes.filter((n) => n.h === 'L').map((n) => n.d)));
  const ends = gs.flatMap((g) => g.notes.map((n) => n.t + n.d)).sort((a, b) => a - b);
  const pcs = (g) => new Set(g.notes.map((n) => n.p % 12));
  const bass = [];
  for (const g of gs) {
    const ls = g.notes.filter((n) => n.h === 'L');
    if (ls.length) bass.push({ t: g.t, w: Math.min(1, Math.max(...ls.map((n) => n.d)) / (1.5 * (lDur || 1))) });
  }
  bass.times = bass.map((b) => b.t);
  return gs.map((g, i) => {
    let s = 0;
    const gap = i ? g.t - gs[i - 1].t : 9;
    s += Math.min(2, Math.max(0, gap / mIOI - 1.2)); // 少し間がある
    const ls = g.notes.filter((n) => n.h === 'L');
    if (ls.length) {
      s += 0.5;
      if (lDur && Math.max(...ls.map((n) => n.d)) >= lDur * 1.2) s += 1; // 長い低音
    }
    // 直前に離れた音の数(区間の終わりで手がそろって上がる)
    let rel = 0;
    for (let k = lowerBound(ends, g.t - 0.25); k < ends.length && ends[k] <= g.t + 0.03; k++) rel++;
    s += Math.min(1.5, rel * 0.3);
    // 和音が変わる
    if (i) {
      const a = pcs(gs[i - 1]);
      const b = pcs(g);
      let diff = 0;
      for (const p of b) if (!a.has(p)) diff++;
      if (diff >= 2) s += 0.3;
    }
    // 小節の頭: ここに低音があり、1・2小節前後にも同じ間隔で低音がある(テンポの揺れがたまらないよう、その場で確かめる)
    if (bar && ls.length) {
      const tol = Math.max(0.15, bar.P * 0.03);
      let hit = 0;
      for (const k of [-2, -1, 1, 2]) {
        const w = bassNear(bass, g.t + k * bar.P * 1, tol * Math.abs(k));
        if (w) hit += Math.abs(k) === 1 ? w : w * 0.5;
      }
      s += Math.min(3, hit);
    }
    return s;
  });
}

// 低音の打鍵 [{t, w}] から、時刻 t の近く(tol 以内)にあるものの重み(長い低音ほど 1 に近い)
function bassNear(bass, t, tol) {
  let k = lowerBound(bass.times, t - tol);
  let w = 0;
  for (; k < bass.length && bass[k].t <= t + tol; k++) w = Math.max(w, bass[k].w);
  return w;
}

function lowerBound(a, x) {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

// 区切りの時刻の一覧(0 と duration は含まない)。音符が少なすぎるときは null
export function smartBoundaries(notes, duration, target) {
  if (!notes || notes.length < 16) return null;
  const gs = groupsOf(notes);
  const bar = estimateBar(gs);
  const sc = scoreGroups(gs, bar);
  // 区切りの位置は和音の少し前(その和音は次の区間に入る)
  // 長さは実際に音がある所で測る(頭の無音・最後の余韻で最初/最後の区間が短くならないように)
  const first = gs[0].t;
  const last = Math.max(...notes.map((n) => n.t));
  const cand = [{ t: first, s: 0 }];
  gs.forEach((g, i) => {
    if (i === 0) return;
    const gap = g.t - gs[i - 1].t;
    const t = g.t - Math.min(0.08, gap / 2);
    if (t - first > target * 0.4 && last - t > target * 0.3) cand.push({ t, s: sc[i], gt: g.t });
  });
  cand.push({ t: Math.max(last + 0.5, Math.min(duration, last + 2)), s: 0, end: true });
  // 区切り1つごとの手間 = いちばん良い所の点。区切りを増やしても得をせず、
  // 「どこで切るか」は点、「何本切るか」は長さの目安で決まる
  const cost = cand.length > 2 ? percentile(cand.slice(1, -1).map((c) => c.s), 0.98) : 0;
  const N = cand.length;
  const best = new Float64Array(N).fill(-Infinity);
  const prev = new Int32Array(N).fill(-1);
  best[0] = 0;
  // 小節が分かれば、目安を 1・2・4・8 小節のどれかに丸めて小節単位でそろえる
  const nbT = bar ? Math.pow(2, Math.max(0, Math.min(5, Math.round(Math.log2(target / bar.P))))) : 0;
  const unit = bar ? bar.P * nbT : target;
  const minL = Math.min(target, unit) * 0.5;
  const maxL = Math.max(target, unit) * 2.1;
  for (let j = 1; j < N; j++) {
    for (let i = j - 1; i >= 0; i--) {
      const len = cand[j].t - cand[i].t;
      if (len < minL && !(cand[j].end && i === 0)) continue;
      if (len > maxL && !(j === N - 1 && i === 0)) break;
      if (best[i] === -Infinity) continue;
      let v = best[i] + (cand[j].end ? 0 : cand[j].s - cost);
      const r = (len - unit) / unit;
      v -= 8 * r * r; // 目安の長さから離れるほど減点
      if (bar && !cand[j].end) {
        const bars = len / bar.P;
        const nb = Math.round(bars);
        if (Math.abs(bars - nb) < 0.15 && [1, 2, 4, 8, 16, 32].includes(nb)) v += 1.5; // 1・2・4・8…小節のまとまり
      }
      if (v > best[j]) {
        best[j] = v;
        prev[j] = i;
      }
    }
  }
  if (best[N - 1] === -Infinity) return null;
  const out = [];
  for (let j = prev[N - 1]; j > 0; j = prev[j]) out.push(cand[j].t);
  return { times: out.reverse(), bar };
}
