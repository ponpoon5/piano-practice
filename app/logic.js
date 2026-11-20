// 練習の進め方(画面に依存しない部分)。node のテストからも読む。

export const DAY = 86400000;
export const REVIEW_DAYS = [1, 3, 7, 14, 30];

export const DEFAULTS = {
  steps: [0.6, 0.75, 0.9, 1.0], // 目標速度に対する割合
  streakToPass: 3, // 区間: 同じ速度で ◎ が何回続いたら次へ
  chainStreak: 2, // つなぎ・まとめ・通し
  leadIn: 1.0, // 区間の少し前から流す(動画の秒)
  gap: 2, // 繰り返しの間(秒)
  sectionLen: 15, // 自動で区切る長さ(動画の秒)
  blockSize: 4, // まとめ練習の区間数
};

// ---------- 曲 ----------

export function newSong({ id, name, duration, now, sectionLen = DEFAULTS.sectionLen }) {
  const song = {
    id,
    name,
    duration,
    createdAt: now,
    targetRate: 1,
    steps: DEFAULTS.steps.slice(),
    streakToPass: DEFAULTS.streakToPass,
    chainStreak: DEFAULTS.chainStreak,
    leadIn: DEFAULTS.leadIn,
    gap: DEFAULTS.gap,
    crop: { s: 1, x: 0, y: 0 },
    sections: [],
    progress: {},
    runs: [],
    nextId: 1,
    lastKey: null,
  };
  song.sections = autoSplit(song, duration, sectionLen);
  return song;
}

function newId(song) {
  return 'k' + song.nextId++;
}

export function autoSplit(song, duration, len) {
  const out = [];
  let t = 0;
  while (t < duration - 0.01) {
    let end = Math.min(duration, t + len);
    if (duration - end < len / 2) end = duration; // 最後の短い端は前にくっつける
    out.push({ id: newId(song), start: round(t), end: round(end) });
    t = end;
  }
  if (!out.length) out.push({ id: newId(song), start: 0, end: round(duration) });
  return out;
}

export function resplit(song, len) {
  song.sections = autoSplit(song, song.duration, len);
  song.progress = {};
  song.lastKey = null;
}

function round(t) {
  return Math.round(t * 100) / 100;
}

export function sectionIndexAt(song, t) {
  const s = song.sections;
  for (let i = 0; i < s.length; i++) if (t < s[i].end) return i;
  return s.length - 1;
}

// その区間を含む練習記録を消す(区切りを変えたとき)
function dropProgressFor(song, ids) {
  for (const key of Object.keys(song.progress)) {
    if (key === 'full' || ids.some((id) => key.split(':').includes(id))) delete song.progress[key];
  }
}

export function splitAt(song, t, minLen = 0.5) {
  const i = sectionIndexAt(song, t);
  const s = song.sections[i];
  if (t - s.start < minLen || s.end - t < minLen) return false;
  dropProgressFor(song, [s.id]);
  const a = { id: newId(song), start: s.start, end: round(t) };
  const b = { id: newId(song), start: round(t), end: s.end };
  song.sections.splice(i, 1, a, b);
  return true;
}

// i 番目と i+1 番目の間の区切りを消す
export function removeBoundary(song, i) {
  const s = song.sections;
  if (i < 0 || i >= s.length - 1) return false;
  dropProgressFor(song, [s[i].id, s[i + 1].id]);
  const m = { id: newId(song), start: s[i].start, end: s[i + 1].end };
  s.splice(i, 2, m);
  return true;
}

// i 番目と i+1 番目の間の区切りを少し動かす(記録は残す)
export function moveBoundary(song, i, delta, minLen = 0.5) {
  const s = song.sections;
  if (i < 0 || i >= s.length - 1) return false;
  const t = round(s[i].end + delta);
  if (t - s[i].start < minLen || s[i + 1].end - t < minLen) return false;
  s[i].end = t;
  s[i + 1].start = t;
  return true;
}

// ---------- 練習の単位 ----------
// 's:ID' 区間 / 'p:ID:ID' つなぎ(隣どうし) / 'b:ID:ID' まとめ(数区間) / 'full' 通し

export function sectionKey(song, i) {
  return 's:' + song.sections[i].id;
}

function idx(song, id) {
  return song.sections.findIndex((s) => s.id === id);
}

export function unitInfo(song, key) {
  const n = song.sections.length;
  if (key === 'full') {
    return { key, kind: 'full', a: 0, b: n - 1, start: 0, end: song.duration, label: '通し' };
  }
  const [t, id1, id2] = key.split(':');
  const a = idx(song, id1);
  const b = id2 ? idx(song, id2) : a;
  if (a < 0 || b < 0) return null;
  const start = song.sections[a].start;
  const end = song.sections[b].end;
  if (t === 's') return { key, kind: 'section', a, b, start, end, label: `区間 ${a + 1}` };
  if (t === 'p') return { key, kind: 'pair', a, b, start, end, label: `つなぎ ${a + 1}→${b + 1}` };
  if (t === 'b') return { key, kind: 'block', a, b, start, end, label: `まとめ ${a + 1}〜${b + 1}` };
  return null;
}

function isChain(key) {
  return !key.startsWith('s:');
}

export function getState(song, key) {
  let st = song.progress[key];
  if (!st) {
    const last = song.steps.length - 1;
    st = {
      step: isChain(key) ? Math.max(0, last - 1) : 0,
      streak: 0,
      fails: 0,
      cleared: false,
      everCleared: false,
      level: 0,
      next: null,
      tries: 0,
      weak: false,
      lastAt: null,
      hist: [],
    };
  }
  return st;
}

function needStreak(song, key) {
  return isChain(key) ? song.chainStreak : song.streakToPass;
}

export function rateFor(song, key) {
  const st = getState(song, key);
  const step = st.cleared ? song.steps.length - 1 : Math.min(st.step, song.steps.length - 1);
  return song.targetRate * song.steps[step];
}

export function speedPercent(song, key) {
  const st = getState(song, key);
  const step = st.cleared ? song.steps.length - 1 : Math.min(st.step, song.steps.length - 1);
  return Math.round(song.steps[step] * 100);
}

// g: 'ok' (◎) / 'meh' (△) / 'ng' (×)
export function grade(song, key, g, now) {
  const st = getState(song, key);
  song.progress[key] = st;
  const last = song.steps.length - 1;
  st.tries++;
  st.lastAt = now;
  st.hist.push(g);
  if (st.hist.length > 30) st.hist.shift();
  let event = null;

  if (st.cleared) {
    // 復習
    if (g === 'ok') {
      st.level = Math.min(st.level + 1, REVIEW_DAYS.length - 1);
      st.next = now + REVIEW_DAYS[st.level] * DAY;
      st.weak = false;
      event = 'reviewed';
    } else if (g === 'meh') {
      st.next = now + DAY;
      event = 'review-meh';
    } else {
      st.cleared = false;
      st.step = Math.max(0, last - 1);
      st.streak = 0;
      st.fails = 0;
      st.next = null;
      event = 'relearn';
    }
    return { event, state: st };
  }

  if (g === 'ok') {
    st.streak++;
    st.fails = 0;
    if (st.streak >= needStreak(song, key)) {
      st.streak = 0;
      if (st.step < last) {
        st.step++;
        event = 'speedup';
      } else {
        st.cleared = true;
        st.everCleared = true;
        st.weak = false;
        st.level = 0;
        st.next = now + REVIEW_DAYS[0] * DAY;
        event = 'cleared';
      }
    }
  } else if (g === 'meh') {
    st.streak = 0;
  } else {
    st.streak = 0;
    st.fails++;
    if (st.fails >= 3 && st.step > 0) {
      st.step--;
      st.fails = 0;
      event = 'slowdown';
    }
  }
  return { event, state: st };
}

// あと何回 ◎ で次へ進むか
export function remainingOk(song, key) {
  const st = getState(song, key);
  if (st.cleared) return 0;
  return needStreak(song, key) - st.streak;
}

// 通しやつなぎの途中で「止まった」場所
export function markStop(song, t, now) {
  const i = sectionIndexAt(song, t);
  const key = sectionKey(song, i);
  const st = getState(song, key);
  song.progress[key] = st;
  st.weak = true;
  if (st.cleared) st.next = Math.min(st.next ?? now, now);
  return i;
}

export function recordRun(song, stops, now) {
  song.runs.push({ at: now, stops: stops.slice() });
  if (song.runs.length > 100) song.runs.shift();
}

// ---------- 状態 ----------

export function sectionStatus(song, i, now) {
  const st = song.progress[sectionKey(song, i)];
  if (!st || st.tries === 0) return st && st.weak ? 'weak' : 'new';
  if (st.weak) return 'weak';
  if (st.cleared) return st.next != null && st.next <= now ? 'due' : 'cleared';
  return 'practice';
}

function everCleared(song, key) {
  const st = song.progress[key];
  return !!(st && st.everCleared);
}

// 練習できるつなぎ・まとめ・通し
export function chainUnits(song) {
  const s = song.sections;
  const n = s.length;
  const out = [];
  for (let i = 0; i < n - 1; i++) {
    if (everCleared(song, sectionKey(song, i)) && everCleared(song, sectionKey(song, i + 1))) {
      out.push(`p:${s[i].id}:${s[i + 1].id}`);
    }
  }
  const bs = DEFAULTS.blockSize;
  for (let a = 0; a < n; a += bs) {
    const b = Math.min(a + bs - 1, n - 1);
    if (b - a < 2) continue;
    let ok = true;
    for (let i = a; i < b; i++) if (!everCleared(song, `p:${s[i].id}:${s[i + 1].id}`)) ok = false;
    if (ok) out.push(`b:${s[a].id}:${s[b].id}`);
  }
  if (n > 0 && s.every((_, i) => everCleared(song, sectionKey(song, i)))) out.push('full');
  return out;
}

const KIND_ORDER = { review: 0, weak: 1, practice: 2, new: 3, chain: 4, full: 5 };

// 今日のメニュー
export function buildMenu(song, now, { maxReview = 4, maxActive = 2 } = {}) {
  const items = [];
  const seen = new Set();
  const add = (key, kind) => {
    if (seen.has(key) || !unitInfo(song, key)) return;
    seen.add(key);
    items.push({ key, kind });
  };
  const n = song.sections.length;

  // 復習(期限が来たもの)
  const due = Object.entries(song.progress)
    .filter(([k, st]) => st.cleared && st.next != null && st.next <= now && unitInfo(song, k))
    .sort((x, y) => x[1].next - y[1].next)
    .slice(0, maxReview);
  for (const [k] of due) add(k, song.progress[k].weak ? 'weak' : 'review');

  // 止まった区間(まだ合格していないもの)
  for (let i = 0; i < n; i++) {
    const k = sectionKey(song, i);
    const st = song.progress[k];
    if (st && st.weak && !st.cleared) add(k, 'weak');
  }

  // 練習中の区間
  let active = 0;
  for (let i = 0; i < n; i++) {
    const k = sectionKey(song, i);
    const st = song.progress[k];
    if (st && st.tries > 0 && !st.cleared) {
      add(k, 'practice');
      active++;
    }
  }
  // 新しい区間(練習中が maxActive 未満なら先頭から足す)
  for (let i = 0; i < n && active < maxActive; i++) {
    const k = sectionKey(song, i);
    const st = song.progress[k];
    if (!st || (st.tries === 0 && !st.cleared)) {
      add(k, 'new');
      active++;
    }
  }
  // つなぎ・まとめ・通し(まだ合格していないもの)
  for (const k of chainUnits(song)) {
    const st = song.progress[k];
    if (st && st.cleared) continue;
    add(k, k === 'full' ? 'full' : 'chain');
  }
  items.sort((x, y) => KIND_ORDER[x.kind] - KIND_ORDER[y.kind]);
  return items;
}

export function overall(song) {
  const n = song.sections.length;
  let cleared = 0;
  for (let i = 0; i < n; i++) if (everCleared(song, sectionKey(song, i))) cleared++;
  const full = song.progress.full;
  return { sections: n, cleared, fullCleared: !!(full && full.everCleared) };
}

// ---------- 練習時間の記録 ----------

export function dateStr(ms) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addPractice(log, now, sec, songId) {
  const k = dateStr(now);
  const e = (log[k] = log[k] || { sec: 0, songs: {} });
  e.sec += sec;
  if (songId) e.songs[songId] = (e.songs[songId] || 0) + sec;
}

// 今日(または昨日)まで何日続いているか
export function streakDays(log, now) {
  let d = new Date(now);
  d.setHours(12, 0, 0, 0);
  const has = (x) => (log[dateStr(x.getTime())]?.sec || 0) >= 60;
  if (!has(d)) d = new Date(d.getTime() - DAY);
  let n = 0;
  while (has(d)) {
    n++;
    d = new Date(d.getTime() - DAY);
  }
  return n;
}
