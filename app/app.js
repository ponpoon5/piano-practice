import * as L from './logic.js';
import * as N from './notes.js';
import { store } from './store.js';
import { midi } from './midi.js';
import { unlockAudio, playNote } from './synth.js';
import { ClockPlayer } from './clock.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

const videoEl = $('#video');
const clock = new ClockPlayer(); // 動画のない曲で時間を進める
let video = videoEl; // 今使っている方(動画 か 時計)
const stage = $('#stage');
const overlay = $('#overlay');

let songs = [];
let log = {};
let song = null; // 開いている曲
let videoUrl = null;
let tab = 'practice';

// 練習の状態
const P = {
  key: null,
  unit: null,
  mode: 'idle', // idle / playing / asking / countdown
  listen: false, // お手本(採点しない・目標の速さ)
  stops: [],
  timer: null,
  hand: 'B', // 今弾く手 R / L / B
  scorer: null, // 電子ピアノの採点
  wait: null, // 待ってくれるモード { chords, i, got, wrong }
  waiting: false,
  lastT: 0, // 伴奏を鳴らした所まで(動画の秒)
  pressed: new Map(), // 今押している鍵 p → ok / bad / free
};

function hasNotes() {
  return !!(song && song.notes && song.notes.notes && song.notes.notes.length);
}

// この単位で今弾くべき手(片手の段階)
function expectedHand() {
  if (!hasNotes() || !P.key) return 'B';
  return L.phaseOf(L.getState(song, P.key));
}

// ---------- 共通 ----------

function fmt(t, dec = false) {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return dec ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
}

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
}

let toastTimer = null;
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

let saveTimer = null;
function saveSong() {
  if (!song) return;
  clearTimeout(saveTimer);
  const s = song;
  saveTimer = setTimeout(() => store.putSong(s).catch((e) => toast('保存できません: ' + e.message, 4000)), 300);
}

function saveLog() {
  return store.set('log', log).catch(() => {});
}

// ---------- ホーム ----------

async function showHome() {
  await leaveSong();
  $('#song').hidden = true;
  $('#home').hidden = false;
  songs = await store.songs();
  songs.sort((a, b) => (b.lastOpened || b.createdAt) - (a.lastOpened || a.createdAt));
  renderHome();
}

function renderHome() {
  const now = Date.now();
  const today = log[L.dateStr(now)]?.sec || 0;
  $('#homeStats').textContent = `今日 ${Math.round(today / 60)}分 ・ 連続 ${L.streakDays(log, now)}日`;
  const list = $('#songList');
  list.textContent = '';
  for (const s of songs) {
    const o = L.overall(s);
    const due = L.buildMenu(s, now).filter((x) => x.kind === 'review' || x.kind === 'weak').length;
    const map = el('div', { class: 'minimap' }, s.sections.map((_, i) => el('div', { class: 'st-' + L.sectionStatus(s, i, now) })));
    let sub = `合格 ${o.cleared}/${o.sections} 区間`;
    if (o.fullCleared) sub += ' ・ 通し合格';
    if (s.noVideo) sub = '🎼 音符のみ ・ ' + sub;
    if (due) sub += ` ・ 復習 ${due}`;
    list.append(
      el('div', { class: 'songcard', onclick: () => openSong(s.id) },
        el('div', { class: 'name' }, s.name),
        map,
        el('div', { class: 'sub' }, sub))
    );
  }
  store.usage().then((u) => {
    if (u) $('#storageInfo').textContent = `使用中 ${(u.usage / 1e6).toFixed(0)}MB / 使える量 約${(u.quota / 1e9).toFixed(1)}GB`;
  });
}

function videoDuration(file) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    const url = URL.createObjectURL(file);
    const done = () => {
      v.onloadedmetadata = v.onerror = null;
      v.removeAttribute('src');
      v.load();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    v.onloadedmetadata = () => {
      const d = v.duration;
      done();
      resolve(d);
    };
    v.onerror = () => {
      done();
      reject(new Error('この動画は読み込めません'));
    };
    v.src = url;
  });
}

// iPad/iPhone で Safari 以外(Web MIDI Browser など)から開いているか。
// こうしたアプリは動画を選ぶときの「写真ライブラリ/撮影」メニューで落ちるので、
// 動画の種類を指定せずに「ファイル」を直接開かせる(種類が空になるので後で補う)
const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IOS_MIDI_APP = IOS && !!navigator.requestMIDIAccess;

function setupVideoInputs() {
  if (!IOS_MIDI_APP) return;
  for (const id of ['fileAdd', 'fileReplace']) $('#' + id).setAttribute('accept', 'application/octet-stream');
  const note = $('#fileAdd').closest('.addbtn').nextElementSibling;
  if (note) note.textContent = '「ファイル」アプリが開きます。写真アプリにある動画は、先に共有→「"ファイル"に保存」で移してください。動画はこの iPad の中だけに保存されます。';
}

// 種類が空の動画ファイルに種類を付ける(blob のまま再生できるように)
function asVideo(file) {
  if (file.type && file.type.startsWith('video/')) return file;
  const ext = (file.name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase();
  const type = { mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm' }[ext] || 'video/mp4';
  return file.slice(0, file.size, type);
}

async function addVideo(picked) {
  const st = $('#addStatus');
  const file = asVideo(picked);
  try {
    st.textContent = '動画を読み込んでいます…';
    const duration = await videoDuration(file);
    const id = 'song' + Date.now();
    const name = picked.name.replace(/\.[^.]+$/, '');
    const s = L.newSong({ id, name, duration, now: Date.now() });
    st.textContent = '保存しています…(大きい動画は少し時間がかかります)';
    await store.putVideo(id, file);
    await store.putSong(s);
    await store.persist();
    st.textContent = '';
    await openSong(id);
  } catch (e) {
    st.textContent = '追加できませんでした: ' + e.message;
  }
}

// 音符データだけで曲を作る(動画なし)
async function addNotesSong(file) {
  const st = $('#addStatus');
  try {
    const nd = N.parseNotesFile(await file.text());
    const last = nd.notes.reduce((m, n) => Math.max(m, n.t + n.d), 0);
    const duration = Math.max(nd.duration || 0, last + 1);
    const id = 'song' + Date.now();
    const name = (nd.source || file.name).replace(/\.(notes\.)?json$/i, '').replace(/\.[^.]+$/, '');
    const s = L.newSong({ id, name, duration, now: Date.now(), notes: nd });
    Object.assign(s, { noVideo: true, handFirst: true, handStreak: 2, tol: 0.25, sound: midi.output ? 'midi' : 'synth' });
    await store.putSong(s);
    await store.persist();
    st.textContent = '';
    await openSong(id);
  } catch (e) {
    st.textContent = '追加できませんでした: ' + e.message;
  }
}

async function exportData() {
  const data = { app: 'piano-practice', version: 1, exportedAt: Date.now(), songs: await store.songs(), log };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const name = `ピアノ練習の記録_${L.dateStr(Date.now())}.json`;
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'piano-practice') throw new Error('このアプリの記録ではありません');
    for (const s of data.songs || []) await store.putSong(s);
    for (const [d, e] of Object.entries(data.log || {})) {
      if (!log[d] || log[d].sec < e.sec) log[d] = e;
    }
    await saveLog();
    toast('読み込みました');
    await showHome();
    const missing = [];
    for (const s of data.songs || []) if (!(await store.video(s.id))) missing.push(s.name);
    if (missing.length) $('#addStatus').textContent = '動画がない曲: ' + missing.join('、') + '(曲の「設定」から動画を入れ直してください)';
  } catch (e) {
    alert('読み込めませんでした: ' + e.message);
  }
}

// ---------- 曲を開く ----------

let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) {}
}

async function openSong(id) {
  const s = (await store.songs()).find((x) => x.id === id);
  if (!s) return;
  song = s;
  song.lastOpened = Date.now();
  saveSong();
  $('#home').hidden = true;
  $('#song').hidden = false;
  $('#songTitle').textContent = song.name;
  videoEl.pause();
  clock.pause();
  const oldUrl = videoUrl;
  videoUrl = null;
  if (song.noVideo) {
    video = clock;
    clock.reset(song.duration);
    videoEl.removeAttribute('src');
    videoEl.load();
  } else {
    video = videoEl;
    const blob = await store.video(id);
    if (blob) {
      videoUrl = URL.createObjectURL(blob);
      videoEl.src = videoUrl;
    } else {
      videoEl.removeAttribute('src');
      videoEl.load();
      toast('動画がありません。「設定」から入れ直してください', 5000);
    }
  }
  if (oldUrl) setTimeout(() => URL.revokeObjectURL(oldUrl), 1000);
  applySound();
  lay = null;
  keepAwake();
  setTab('practice');
  renderStrip();
  const menu = L.buildMenu(song, Date.now());
  const first = song.lastKey && L.unitInfo(song, song.lastKey) ? song.lastKey : menu[0]?.key || L.sectionKey(song, 0);
  selectUnit(first);
  fitStage();
}

async function leaveSong() {
  cancelTimer();
  midi.allOff();
  P.key = null;
  P.unit = null;
  if (!video.paused) video.pause();
  P.mode = 'idle';
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
  if (song) {
    clearTimeout(saveTimer);
    await store.putSong(song).catch(() => {});
  }
  await saveLog();
  song = null;
}

function setTab(t) {
  tab = t;
  for (const b of $$('#tabs button')) b.classList.toggle('on', b.dataset.tab === t);
  for (const d of $$('#panel .tab')) d.hidden = d.dataset.tab !== t;
  cancelTimer();
  if (!video.paused) video.pause();
  P.mode = 'idle';
  overlay.textContent = '';
  if (t === 'practice') {
    if (P.key) selectUnit(P.key);
  } else if (t === 'edit') {
    video.playbackRate = Number($('#editRate').value);
    renderSecList();
  } else if (t === 'record') {
    renderRecord();
  } else if (t === 'settings') {
    renderSettings();
  }
  updatePlayButtons();
}

// ---------- 表示範囲(拡大) ----------

function fitStage() {
  const wrap = $('#stageWrap');
  const ar = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
  const portrait = matchMedia('(orientation: portrait), (max-width: 760px)').matches;
  let w = wrap.clientWidth;
  let h = portrait ? Math.min(window.innerHeight * 0.5, w / ar) : wrap.clientHeight;
  if (song && song.noVideo) {
    // 動画がなければ縦横の比にしばられず、空いている所いっぱいに描く
    if (portrait) h = window.innerHeight * 0.5;
  } else if (w / h > ar) w = h * ar;
  else h = w / ar;
  stage.style.width = Math.floor(w) + 'px';
  stage.style.height = Math.floor(h) + 'px';
  applyCrop();
  sizeCanvases();
}

function clampCrop(c) {
  c.s = Math.min(4, Math.max(1, c.s));
  const m = 1 - 1 / c.s;
  c.x = Math.min(m, Math.max(0, c.x));
  c.y = Math.min(m, Math.max(0, c.y));
  return c;
}

function applyCrop() {
  const c = song ? song.crop : { s: 1, x: 0, y: 0 };
  videoEl.style.transform = `scale(${c.s}) translate(${-c.x * 100}%, ${-c.y * 100}%)`;
}

function zoomBy(f) {
  const c = song.crop;
  const cx = c.x + 0.5 / c.s;
  const cy = c.y + 0.5 / c.s;
  c.s *= f;
  c.x = cx - 0.5 / c.s;
  c.y = cy - 0.5 / c.s;
  clampCrop(c);
  applyCrop();
  saveSong();
}

let adjusting = false;
const pointers = new Map();
let gesture = null;

function setAdjust(on) {
  adjusting = on;
  stage.classList.toggle('adjusting', on);
  $('#adjustHint').hidden = !on;
  if (!on) saveSong();
}

stage.addEventListener('pointerdown', (e) => {
  if (!adjusting || e.target.closest('button')) return;
  stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  gesture = null;
});
stage.addEventListener('pointermove', (e) => {
  if (!adjusting || !pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId);
  const cur = { x: e.clientX, y: e.clientY };
  const r = stage.getBoundingClientRect();
  const c = song.crop;
  if (pointers.size === 1) {
    c.x -= (cur.x - prev.x) / (r.width * c.s);
    c.y -= (cur.y - prev.y) / (r.height * c.s);
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.entries()].map(([id, p]) => (id === e.pointerId ? cur : p));
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2 - r.left;
    const my = (a.y + b.y) / 2 - r.top;
    if (gesture && gesture.d > 0) {
      const vx = c.x + mx / (r.width * c.s);
      const vy = c.y + my / (r.height * c.s);
      c.s *= d / gesture.d;
      clampCrop(c);
      c.x = vx - mx / (r.width * c.s);
      c.y = vy - my / (r.height * c.s);
    }
    gesture = { d };
  }
  clampCrop(c);
  applyCrop();
  pointers.set(e.pointerId, cur);
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  gesture = null;
};
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);
stage.addEventListener(
  'wheel',
  (e) => {
    if (!adjusting) return;
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
  },
  { passive: false }
);

// ---------- 区間の帯 ----------

function renderStrip() {
  const strip = $('#strip');
  for (const d of $$('.sec', strip)) d.remove();
  const now = Date.now();
  song.sections.forEach((s, i) => {
    const d = el('div', { class: 'sec st-' + L.sectionStatus(song, i, now), style: `flex:${s.end - s.start} 1 0` }, String(i + 1));
    d.addEventListener('click', () => {
      if (tab === 'edit') {
        video.currentTime = s.start;
        renderSecList();
      } else {
        if (tab !== 'practice') setTab('practice');
        selectUnit(L.sectionKey(song, i));
      }
    });
    strip.append(d);
  });
  markStrip();
}

function markStrip() {
  const secs = $$('#strip .sec');
  secs.forEach((d, i) => d.classList.toggle('sel', tab === 'practice' && P.unit && i >= P.unit.a && i <= P.unit.b));
}

function updatePlayhead() {
  if (!song || !song.duration) return;
  const strip = $('#strip');
  const secs = $$('.sec', strip);
  const t = video.currentTime;
  const i = L.sectionIndexAt(song, t);
  const d = secs[i];
  if (!d) return;
  const s = song.sections[i];
  const f = Math.min(1, Math.max(0, (t - s.start) / (s.end - s.start)));
  $('#playhead').style.left = d.offsetLeft + f * d.offsetWidth - 1 + 'px';
}

// ---------- 練習 ----------

function selectUnit(key) {
  const u = L.unitInfo(song, key);
  if (!u) return;
  cancelTimer();
  if (!video.paused) video.pause();
  P.key = key;
  P.unit = u;
  P.mode = 'idle';
  P.listen = false;
  P.stops = [];
  P.scorer = null;
  P.wait = null;
  P.waiting = false;
  P.hand = expectedHand();
  midi.allOff();
  $('#result').hidden = true;
  song.lastKey = key;
  saveSong();
  overlay.textContent = '';
  seekUnitStart();
  renderHand();
  renderUnit();
  renderMenu();
  markStrip();
}

function seekUnitStart() {
  const t = Math.max(0, P.unit.start - (P.unit.a === 0 && P.unit.start === 0 ? 0 : song.leadIn));
  if (video.readyState > 0) video.currentTime = t;
  else video.addEventListener('loadedmetadata', () => (video.currentTime = t), { once: true });
  return t;
}

function renderUnit() {
  const u = P.unit;
  const st = L.getState(song, P.key);
  $('#unitLabel').textContent = u.label;
  $('#unitRange').textContent = `${fmt(u.start)}–${fmt(u.end)}`;
  const pct = L.speedPercent(song, P.key);
  const rate = L.rateFor(song, P.key);
  $('#unitSpeed').textContent = `速さ ${pct}%` + (song.targetRate !== 1 ? `(動画×${+rate.toFixed(2)})` : '');
  const ph = L.phaseOf(st);
  const handPhase = hasNotes() && ph !== 'B' && !st.cleared;
  const need = handPhase ? song.handStreak || 2 : P.key.startsWith('s:') ? song.streakToPass : song.chainStreak;
  const got = handPhase ? st.hstreak || 0 : st.streak;
  $('#unitDots').textContent = st.cleared ? '' : '●'.repeat(got) + '○'.repeat(Math.max(0, need - got));
  let hint;
  if (st.cleared) {
    const days = st.next ? Math.max(0, Math.ceil((st.next - Date.now()) / L.DAY)) : 0;
    hint = st.next && st.next <= Date.now() ? '復習の日です。1回弾いて確かめましょう。' : `合格済み。次の復習は${days}日後。`;
  } else if (handPhase) {
    const nextPh = L.PHASES[L.PHASES.indexOf(ph) + 1];
    hint = `${L.PHASE_LABEL[ph]}だけで ◎ をあと${need - got}回 → ${L.PHASE_LABEL[nextPh]}へ`;
  } else {
    const rem = L.remainingOk(song, P.key);
    const last = st.step >= song.steps.length - 1;
    hint = last ? `◎ をあと${rem}回続けると合格` : `◎ をあと${rem}回続けると ${Math.round(song.steps[st.step + 1] * 100)}% へ`;
    if (st.weak) hint = '止まった区間です。' + hint;
  }
  if (P.listen) hint = 'お手本を再生中(採点しません)';
  $('#unitHint').textContent = hint;
  $('#btnStopHere').hidden = u.kind === 'section';
  updatePlayButtons();
}

function updatePlayButtons() {
  const playing = !video.paused || P.mode === 'countdown' || P.waiting;
  $('#btnPlay').textContent = playing ? '⏸ 止める' : '▶ 再生';
  $('#btnEditPlay').textContent = video.paused ? '▶' : '⏸';
  $('.row.grade').classList.toggle('asking', P.mode === 'asking');
}

const KIND_LABEL = { review: '復習', weak: '苦手', practice: '練習中', new: '新しい', chain: 'つなぎ', full: '通し' };

function renderMenu() {
  const ol = $('#menu');
  ol.textContent = '';
  const now = Date.now();
  const today = L.dateStr(now);
  const items = L.buildMenu(song, now);
  if (P.key && !items.some((x) => x.key === P.key)) items.unshift({ key: P.key, kind: 'pick' });
  for (const it of items) {
    const u = L.unitInfo(song, it.key);
    const st = song.progress[it.key];
    const n = st && st.td === today ? st.tn : 0;
    const kind = it.kind === 'pick' ? null : it.kind;
    const ph = hasNotes() && st && !st.cleared ? L.phaseOf(st) : 'B';
    const phTxt = hasNotes() && ph !== 'B' ? L.PHASE_LABEL[ph] + ' ' : hasNotes() && !st && it.key.startsWith('s:') && song.handFirst ? '右手 ' : '';
    const meta = phTxt + `${L.speedPercent(song, it.key)}%` + (n ? ` ・ 今日${n}回` : '');
    ol.append(
      el('li', { class: it.key === P.key ? 'cur' : '', onclick: () => selectUnit(it.key) },
        kind ? el('span', { class: 'tag tag-' + kind }, KIND_LABEL[kind]) : el('span', { class: 'tag tag-new' }, '選択中'),
        el('span', { class: 'lbl' }, u.label),
        el('span', { class: 'meta' }, meta))
    );
  }
  if (!items.length) ol.append(el('li', {}, '今日の分は終わりです。通しで弾いてみましょう。'));
}

function cancelTimer() {
  if (P.timer) {
    clearInterval(P.timer);
    P.timer = null;
  }
  if (P.mode === 'countdown') {
    P.mode = 'idle';
    overlay.textContent = '';
  }
}

function countdown(sec, then) {
  cancelTimer();
  P.mode = 'countdown';
  let n = Math.ceil(sec);
  const show = () => {
    overlay.textContent = '';
    if (n > 0) overlay.append(el('div', { class: 'count' }, String(n)));
  };
  if (n <= 0) {
    P.mode = 'idle';
    then();
    return;
  }
  show();
  updatePlayButtons();
  P.timer = setInterval(() => {
    n--;
    if (n <= 0) {
      clearInterval(P.timer);
      P.timer = null;
      P.mode = 'idle';
      overlay.textContent = '';
      then();
    } else show();
  }, 1000);
}

// 電子ピアノの採点・待ちモードの準備
function setupRun(fromT) {
  P.scorer = null;
  P.wait = null;
  P.waiting = false;
  P.lastT = fromT;
  midi.allOff();
  if (!hasNotes() || P.listen) return;
  const targets = N.inRange(song.notes.notes, P.unit.start, P.unit.end, P.hand);
  if (!midi.connected || !targets.length) return;
  if (song.waitMode) {
    const chords = N.chords(targets);
    let i = 0;
    while (i < chords.length && chords[i].t < fromT - 0.05) i++;
    P.wait = { chords, i, got: new Set(), wrong: 0 };
  } else {
    P.scorer = new N.Scorer(targets, (song.tol || 0.25) * video.playbackRate);
  }
}

function applySound() {
  videoEl.muted = hasNotes() && soundSrc() !== 'video';
}

function playUnit({ listen = false, fromStart = true } = {}) {
  if (!P.unit || !video.src) return;
  cancelTimer();
  unlockAudio();
  P.listen = listen;
  overlay.textContent = '';
  $('#result').hidden = true;
  video.playbackRate = listen ? song.targetRate : L.rateFor(song, P.key);
  applySound();
  let fromT = video.currentTime;
  if (fromStart) {
    P.stops = [];
    fromT = seekUnitStart();
  }
  setupRun(fromT);
  P.mode = 'playing';
  video.play().catch((e) => {
    // 始まってすぐ止めた(待ってくれるモードで最初の和音を待つ等)ときの中断は失敗ではない
    if (e && e.name === 'AbortError') return;
    P.mode = 'idle';
    toast('再生できません。もう一度 ▶ を押してください');
    updatePlayButtons();
  });
  renderUnit();
}

function showResult(html) {
  const r = $('#result');
  r.textContent = html;
  r.hidden = false;
}

function onUnitEnd() {
  video.pause();
  midi.allOff();
  if (P.listen) {
    P.listen = false;
    P.mode = 'idle';
    seekUnitStart();
    renderUnit();
    return;
  }
  if (P.wait) {
    const w = P.wait;
    P.wait = null;
    showResult(`待ってくれるモード: 間違えた鍵 ${w.wrong}回(テンポどおりに弾けたら、待たないモードで採点しましょう)`);
  } else if (P.scorer) {
    const r = P.scorer.result();
    P.scorer = null;
    const g = N.gradeFrom(r);
    const mark = { ok: '◎', meh: '△', ng: '×' }[g] || '';
    showResult(`正しい音 ${r.hits}/${r.total} ・ 余分 ${r.extra} → ${mark}`);
    if (r.missed.length >= 3 && P.unit.kind !== 'spot') {
      const rate = video.playbackRate;
      const w = N.worstWindow(r.missed, 2.5 * rate);
      if (w && w.count >= 3) {
        const k = L.addSpot(song, w.start - 0.8 * rate, w.end + 0.8 * rate);
        if (k) setTimeout(() => toast('間違いが多い所を「苦手な所」に足しました'), 1300);
      }
    }
    if (g && !$('#autoLoop').checked) {
      P.mode = 'idle';
      doGrade(g);
      return;
    }
  }
  if ($('#autoLoop').checked) {
    P.mode = 'idle';
    countdown(song.gap, () => playUnit());
    return;
  }
  P.mode = 'asking';
  overlay.textContent = '';
  overlay.append(el('div', { class: 'ask' }, 'どうだった？  ◎ △ ×'));
  updatePlayButtons();
}

const EVENT_MSG = {
  speedup: (pct) => `速さアップ！ ${pct}% へ`,
  cleared: () => '合格！',
  slowdown: (pct) => `少しゆっくりに戻します(${pct}%)`,
  reviewed: () => '復習OK。次はもう少し先に',
  'review-meh': () => '明日もう一度復習します',
  relearn: () => '練習し直しましょう',
  'hand-next': (pct, st) => `${L.PHASE_LABEL[L.phaseOf(st)]}へ進みます`,
  'spot-cleared': () => '苦手な所を卒業！',
};

function doGrade(g) {
  if (!P.unit || tab !== 'practice') return;
  if (P.listen) return;
  if (!video.paused) video.pause();
  midi.allOff();
  cancelTimer();
  P.waiting = false;
  overlay.textContent = '';
  // 今の段階と違う手で弾いたときは記録しない
  if (hasNotes() && P.hand !== expectedHand()) {
    toast(`自由練習(${L.PHASE_LABEL[P.hand]})なので記録しません`, 1500);
    P.mode = 'idle';
    countdown(song.gap, () => playUnit());
    return;
  }
  const now = Date.now();
  if (P.unit.kind !== 'section') L.recordRun(song, P.stops.map((i) => i + 1), now);
  if (P.key === 'full' && P.stops.length && g === 'ok') g = 'meh';
  const { event, state } = L.grade(song, P.key, g, now);
  const today = L.dateStr(now);
  state.tn = state.td === today ? state.tn + 1 : 1;
  state.td = today;
  saveSong();
  renderStrip();
  if (event) toast(EVENT_MSG[event](L.speedPercent(song, P.key), state));
  else toast({ ok: '◎', meh: '△', ng: '×' }[g], 900);

  if (event === 'cleared' || event === 'reviewed' || event === 'review-meh' || event === 'spot-cleared') {
    const gone = event === 'spot-cleared';
    const next = L.buildMenu(song, now).find((x) => x.key !== P.key) || (gone ? { key: L.sectionKey(song, P.unit.a) } : null);
    if (!gone) renderUnit();
    renderMenu();
    if (next) {
      setTimeout(() => {
        if (song && tab === 'practice' && P.mode === 'idle') {
          selectUnit(next.key);
          toast('次: ' + L.unitInfo(song, next.key).label);
        }
      }, 1600);
    }
    P.mode = 'idle';
    updatePlayButtons();
    return;
  }
  if (event === 'hand-next') {
    P.hand = expectedHand();
    renderHand();
  }
  renderUnit();
  renderMenu();
  P.mode = 'idle';
  countdown(song.gap, () => playUnit());
}

function stopHere() {
  if (!P.unit || P.unit.kind === 'section') return;
  const i = L.markStop(song, video.currentTime, Date.now());
  if (!P.stops.includes(i)) P.stops.push(i);
  saveSong();
  renderStrip();
  toast(`区間 ${i + 1} を練習に回します`);
}

function togglePlay() {
  if (tab === 'edit') {
    unlockAudio();
    if (video.paused) {
      editLastT = video.currentTime;
      video.play();
    } else {
      video.pause();
      midi.allOff();
    }
    return;
  }
  if (tab !== 'practice') return;
  if (P.mode === 'countdown') {
    cancelTimer();
    updatePlayButtons();
    return;
  }
  if (!video.paused || P.waiting) {
    P.waiting = false;
    P.mode = 'idle';
    video.pause();
    midi.allOff();
    updatePlayButtons();
    return;
  }
  if (P.mode === 'asking') {
    playUnit();
    return;
  }
  const inside = video.currentTime >= P.unit.start - song.leadIn - 0.1 && video.currentTime < P.unit.end - 0.2;
  playUnit({ fromStart: !inside });
}

// ---------- 音符データ・電子ピアノ ----------

// 落ちてくる音符を出すか(動画のない曲はいつも)
function viewNotes() {
  return !!(song && (song.viewNotes || song.noVideo));
}

// 伴奏の音の出どころ(動画のない曲で「動画の音」は選べない)
function soundSrc() {
  const s = song.sound || 'video';
  if (song.noVideo && s === 'video') return midi.output ? 'midi' : 'synth';
  return s;
}

function renderHand() {
  const show = hasNotes();
  $('#noteCtl').hidden = !show;
  const roll = show && viewNotes();
  $('#keys').hidden = !show || roll;
  $('#roll').hidden = !roll;
  videoEl.style.visibility = roll ? 'hidden' : '';
  $('#viewNotes').closest('label').hidden = !!song.noVideo;
  $('#soundSel option[value=video]').disabled = !!song.noVideo;
  if (!show) return;
  const exp = expectedHand();
  for (const b of $$('#handSel button')) {
    b.classList.toggle('on', b.dataset.hand === P.hand);
    b.classList.toggle('phase', b.dataset.hand === exp && exp !== 'B');
  }
  $('#waitMode').checked = !!song.waitMode;
  $('#viewNotes').checked = !!song.viewNotes;
  $('#soundSel').value = soundSrc();
  renderMidiStatus();
  sizeCanvases();
}

function renderMidiStatus() {
  for (const b of $$('.midibadge')) {
    b.hidden = midi.status === 'unsupported';
    b.classList.toggle('ok', midi.connected);
    b.textContent = midi.connected ? '🎹 つながっています' : midi.status === 'init' ? '🎹 確認中…' : '🎹 未接続';
  }
  const box = $('#midiStatus');
  if (!box) return;
  const t = {
    init: '電子ピアノを確認しています…',
    unsupported: 'このブラウザは電子ピアノにつなげません(採点は ◎△× を自分で)。iPad では「Web MIDI Browser」アプリでこのページを開くとつながります。',
    denied: '電子ピアノの使用が許可されませんでした。',
    none: '電子ピアノが見つかりません。USB でつなぐと、弾いた音で採点します。',
  }[midi.status];
  box.textContent = midi.connected ? `🎹 ${midi.inputName} につながっています。${song && song.waitMode ? '正しい鍵を押すまで待ちます。' : '弾くと自動で採点します。'}` : t;
  const opt = $('#soundSel option[value=midi]');
  if (opt) opt.disabled = !midi.output;
}

let lay = null;
let layW = 0;
function sizeCanvases() {
  if (!hasNotes()) return;
  const dpr = window.devicePixelRatio || 1;
  for (const c of [$('#keys'), $('#roll')]) {
    if (c.hidden) continue;
    const w = Math.round(c.clientWidth * dpr);
    const h = Math.round(c.clientHeight * dpr);
    if (w && (c.width !== w || c.height !== h)) {
      c.width = w;
      c.height = h;
    }
  }
  layW = 0;
}

function getLayout(w) {
  if (!lay || layW !== w) {
    lay = N.layout(Math.max(21, song.notes.lo - 2), Math.min(108, song.notes.hi + 2), w);
    layW = w;
  }
  return lay;
}

function keyState(t) {
  const sounding = new Map();
  const notes = song.notes.notes;
  let i = firstAtOrAfter(notes, t - 12);
  for (; i < notes.length && notes[i].t <= t; i++) {
    const n = notes[i];
    if (t < n.t + n.d) sounding.set(n.p, n.h);
  }
  const expect = new Map();
  if (P.wait) {
    const c = P.wait.chords[P.wait.i];
    if (c) for (const p of c.ps) if (!P.wait.got.has(p)) expect.set(p, P.hand === 'B' ? handOf(c.t, p) : P.hand);
  }
  return { sounding, expect, pressed: P.pressed };
}

function handOf(t, p) {
  const notes = song.notes.notes;
  for (let i = firstAtOrAfter(notes, t - 0.07); i < notes.length && notes[i].t <= t + 0.07; i++) if (notes[i].p === p) return notes[i].h;
  return 'R';
}

function firstAtOrAfter(notes, t) {
  let a = 0;
  let b = notes.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (notes[m].t < t) a = m + 1;
    else b = m;
  }
  return a;
}

function drawNotes() {
  if (!hasNotes()) return;
  const t = video.currentTime;
  const st = keyState(t);
  if (viewNotes()) {
    const c = $('#roll');
    const ctx = c.getContext('2d');
    const kh = Math.round(c.height * 0.16);
    const l = getLayout(c.width);
    N.drawFalling(ctx, l, c.width, c.height - kh, song.notes.notes, t, 3 * (video.playbackRate || 1), tab === 'practice' ? P.hand : 'B');
    N.drawKeyboard(ctx, l, 0, c.height - kh, c.width, kh, st);
  } else {
    const c = $('#keys');
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    N.drawKeyboard(ctx, getLayout(c.width), 0, 0, c.width, c.height, st);
  }
}

// 伴奏・お手本を iPad かピアノで鳴らす
// all: 両手とも鳴らす(お手本・区切りの編集)
function soundNotes(from, to, all = P.listen) {
  const src = song && soundSrc();
  if (!hasNotes() || src === 'video' || to <= from) return;
  if (!all && P.hand === 'B') return;
  const notes = song.notes.notes;
  const rate = video.playbackRate || 1;
  for (let i = firstAtOrAfter(notes, from); i < notes.length && notes[i].t < to; i++) {
    const n = notes[i];
    if (!all && n.h === P.hand) continue;
    if (!all && P.unit && n.t < P.unit.start - 0.01) continue;
    const dur = n.d / rate;
    if (src === 'midi') midi.play(n.p, 72, dur * 1000, n.h === 'L' ? 1 : 0);
    else playNote(n.p, dur);
  }
}

const NOTE_NAMES = ['ド', 'ド#', 'レ', 'レ#', 'ミ', 'ファ', 'ファ#', 'ソ', 'ソ#', 'ラ', 'ラ#', 'シ'];
let badgeTimer = null;
function flashKey(p) {
  for (const b of $$('.midibadge')) b.textContent = `🎹 ${NOTE_NAMES[p % 12]}(${Math.floor(p / 12) - 1})`;
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(renderMidiStatus, 1200);
}

function onMidiNoteOn(p) {
  flashKey(p);
  P.pressed.set(p, 'free');
  if (!song || tab !== 'practice' || !hasNotes()) return;
  const tv = video.currentTime;
  if (P.wait && P.mode === 'playing') {
    const w = P.wait;
    const c = w.chords[w.i];
    const early = 0.8 * (video.playbackRate || 1);
    if (c && c.ps.includes(p) && tv >= c.t - early) {
      w.got.add(p);
      P.pressed.set(p, 'ok');
      if (c.ps.every((q) => w.got.has(q))) {
        w.i++;
        w.got.clear();
        if (P.waiting) {
          P.waiting = false;
          video.play();
        }
      }
    } else {
      w.wrong++;
      P.pressed.set(p, 'bad');
    }
  } else if (P.scorer && P.mode === 'playing' && !video.paused) {
    P.pressed.set(p, P.scorer.onNote(p, tv) === 'hit' ? 'ok' : 'bad');
  }
}

async function importNotes(file) {
  try {
    const nd = N.parseNotesFile(await file.text());
    if (nd.duration && Math.abs(nd.duration - song.duration) > 2 && !confirm(`動画の長さ(${fmt(song.duration)})と音符データの長さ(${fmt(nd.duration)})が違います。別の動画のデータかもしれません。取り込みますか？`)) return;
    const first = !song.notes;
    song.notes = nd;
    let resplitMsg = '';
    if (first) {
      song.handFirst = true;
      song.handStreak = song.handStreak || 2;
      song.tol = song.tol || 0.25;
      song.sound = song.sound || 'video';
      // まだ練習の記録がなければ、曲のまとまりで区切り直す
      if (!Object.keys(song.progress).length && !song.runs.length) {
        L.resplit(song, L.DEFAULTS.sectionLen);
        P.key = L.sectionKey(song, 0);
        P.unit = L.unitInfo(song, P.key);
        renderStrip();
        renderSecList();
        resplitMsg = `・曲のまとまりで ${song.sections.length} 区間に区切りました`;
      }
    }
    saveSong();
    lay = null;
    renderSettings();
    P.hand = expectedHand();
    renderHand();
    const c = N.countHands(nd.notes);
    toast(`音符 ${nd.notes.length}個を取り込みました(右手 ${c.R}・左手 ${c.L})${resplitMsg}`, 3500);
  } catch (e) {
    alert('取り込めませんでした: ' + e.message);
  }
}

// ---------- 区切りの編集 ----------

function renderSecList() {
  const box = $('#secList');
  box.textContent = '';
  const now = Date.now();
  const ci = L.sectionIndexAt(song, video.currentTime);
  song.sections.forEach((s, i) => {
    box.append(
      el('div', { class: 'secrow' + (i === ci ? ' cur' : '') },
        el('span', { class: 'n st-' + L.sectionStatus(song, i, now) }, String(i + 1)),
        el('span', { class: 't mono' }, `${fmt(s.start, true)} – ${fmt(s.end, true)}`),
        el('button', { onclick: () => { video.currentTime = s.start; video.play(); } }, '▶'))
    );
    if (i < song.sections.length - 1) {
      const edit = (fn) => () => {
        if (fn()) {
          saveSong();
          renderStrip();
          renderSecList();
        }
      };
      box.append(
        el('div', { class: 'bndrow' },
          el('button', { onclick: edit(() => L.moveBoundary(song, i, -0.2)) }, '◀ 0.2'),
          el('button', { onclick: () => { video.currentTime = Math.max(0, s.end - 2); video.play(); } }, '境目を聞く'),
          el('button', { onclick: edit(() => L.moveBoundary(song, i, 0.2)) }, '0.2 ▶'),
          el('button', { onclick: edit(() => L.removeBoundary(song, i)) }, '✕ 消す'))
      );
    }
  });
}

// ---------- 記録 ----------

function renderRecord() {
  const box = $('#recordBody');
  box.textContent = '';
  const now = Date.now();
  const o = L.overall(song);
  const todaySec = log[L.dateStr(now)]?.songs?.[song.id] || 0;
  let totalSec = 0;
  for (const e of Object.values(log)) totalSec += e.songs?.[song.id] || 0;
  box.append(
    el('div', { class: 'bigstat' },
      el('div', {}, el('b', {}, `${o.cleared}/${o.sections}`), el('span', {}, '合格した区間')),
      el('div', {}, el('b', {}, o.fullCleared ? '合格' : 'まだ'), el('span', {}, '通し')),
      el('div', {}, el('b', {}, `${L.streakDays(log, now)}日`), el('span', {}, '連続')))
  );
  box.append(
    el('div', { class: 'bigstat', style: 'margin-top:8px' },
      el('div', {}, el('b', {}, `${Math.round(todaySec / 60)}分`), el('span', {}, '今日この曲')),
      el('div', {}, el('b', {}, `${(totalSec / 3600).toFixed(1)}時間`), el('span', {}, 'この曲の合計')))
  );
  box.append(el('h3', {}, '練習時間(この曲・14日)'));
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = now - i * L.DAY;
    days.push({ d: new Date(d), sec: log[L.dateStr(d)]?.songs?.[song.id] || 0 });
  }
  const max = Math.max(600, ...days.map((x) => x.sec));
  box.append(el('div', { class: 'bars' }, days.map((x) => el('div', { class: x.sec ? '' : 'zero', style: `height:${(x.sec / max) * 100}%`, title: `${Math.round(x.sec / 60)}分` }))));
  box.append(el('div', { class: 'barlbl' }, days.map((x) => el('span', {}, String(x.d.getDate())))));
  box.append(el('h3', {}, '区間の色'));
  box.append(
    el('div', { class: 'legend' },
      [['new', 'まだ'], ['practice', '練習中'], ['cleared', '合格'], ['due', '復習の日'], ['weak', '止まった']].map(([k, t]) =>
        el('span', {}, el('i', { class: 'st-' + k }), t)))
  );
  const runs = song.runs.filter((r) => r).slice(-10).reverse();
  if (runs.length) {
    box.append(el('h3', {}, 'つなぎ・通しの記録(新しい順)'));
    box.append(
      el('ul', { class: 'runs' },
        runs.map((r) => {
          const d = new Date(r.at);
          return el('li', {}, `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')} ` + (r.stops.length ? `止まった区間 ${r.stops.join('・')}` : '止まらず'));
        }))
    );
  }
}

// ---------- 設定 ----------

function renderSettings() {
  $('#setName').value = song.name;
  $('#setTarget').value = String(song.targetRate);
  if ($('#setTarget').value !== String(song.targetRate)) {
    $('#setTarget').append(el('option', { value: String(song.targetRate) }, '×' + song.targetRate));
    $('#setTarget').value = String(song.targetRate);
  }
  $('#setSteps').value = song.steps.map((x) => Math.round(x * 100)).join(',');
  $('#setStreak').value = song.streakToPass;
  $('#setChain').value = song.chainStreak;
  $('#setLead').value = song.leadIn;
  $('#setGap').value = song.gap;
  if (hasNotes()) {
    const c = N.countHands(song.notes.notes);
    $('#notesInfo').textContent = `取り込み済み: 音符 ${song.notes.notes.length}個(右手 ${c.R}・左手 ${c.L})${song.notes.source ? ' ・ ' + song.notes.source : ''}`;
  } else {
    $('#notesInfo').textContent = 'PC の tools/extract_notes.py で動画から作った .notes.json を取り込むと、電子ピアノでの採点・片手練習・待ってくれるモードが使えます。';
  }
  $('#btnNotesRemove').hidden = !hasNotes() || !!song.noVideo;
  $('#setHandFirst').checked = !!song.handFirst;
  $('#setHandFirst').disabled = !hasNotes();
  $('#setTol').value = String(song.tol || 0.25);
}

function bindSettings() {
  $('#setName').addEventListener('change', (e) => {
    song.name = e.target.value.trim() || song.name;
    $('#songTitle').textContent = song.name;
    saveSong();
  });
  $('#setTarget').addEventListener('change', (e) => {
    song.targetRate = Number(e.target.value);
    saveSong();
  });
  $('#setSteps').addEventListener('change', (e) => {
    const v = e.target.value
      .split(/[,、\s]+/)
      .map(Number)
      .filter((x) => x >= 20 && x <= 200)
      .sort((a, b) => a - b)
      .map((x) => x / 100);
    if (v.length) {
      const last = song.steps.length - 1;
      song.steps = v;
      for (const st of Object.values(song.progress)) st.step = Math.min(st.step, v.length - 1);
      if (last !== v.length - 1) toast('段階の数が変わりました');
    }
    renderSettings();
    saveSong();
  });
  const num = (id, key, min, max) =>
    $(id).addEventListener('change', (e) => {
      const v = Number(e.target.value);
      if (isFinite(v)) song[key] = Math.min(max, Math.max(min, v));
      renderSettings();
      saveSong();
    });
  num('#setStreak', 'streakToPass', 1, 10);
  num('#setChain', 'chainStreak', 1, 10);
  num('#setLead', 'leadIn', 0, 5);
  num('#setGap', 'gap', 0, 10);
  $('#btnAdjust').addEventListener('click', () => setAdjust(!adjusting));
  $('#btnAdjustDone').addEventListener('click', () => setAdjust(false));
  $('#btnZoomIn').addEventListener('click', () => zoomBy(1.2));
  $('#btnZoomOut').addEventListener('click', () => zoomBy(1 / 1.2));
  $('#btnZoomReset').addEventListener('click', () => {
    song.crop = { s: 1, x: 0, y: 0 };
    applyCrop();
    saveSong();
  });
  $('#fileReplace').addEventListener('change', async (e) => {
    const picked = e.target.files[0];
    e.target.value = '';
    if (!picked) return;
    const f = asVideo(picked);
    try {
      const d = await videoDuration(f);
      if (Math.abs(d - song.duration) > 2 && !confirm(`前の動画と長さが違います(${fmt(song.duration)} → ${fmt(d)})。区切りがずれるかもしれません。入れ直しますか？`)) return;
      await store.putVideo(song.id, f);
      song.duration = d;
      song.noVideo = false;
      saveSong();
      openSong(song.id);
    } catch (err) {
      alert(err.message);
    }
  });
  $('#btnResetProgress').addEventListener('click', () => {
    if (!confirm('この曲の練習の記録(合格・速さ)を消します。区切りは残ります。')) return;
    song.progress = {};
    song.runs = [];
    saveSong();
    renderStrip();
    selectUnit(L.sectionKey(song, 0));
    toast('記録を消しました');
  });
  $('#btnDeleteSong').addEventListener('click', async () => {
    if (!confirm(`「${song.name}」を動画ごと削除します。`)) return;
    const id = song.id;
    song = null;
    await store.deleteSong(id);
    showHome();
  });
}

// ---------- イベント ----------

function bind() {
  $('#fileAddNotes').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) addNotesSong(f);
  });
  $('#fileAdd').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) addVideo(f);
  });
  $('#btnExport').addEventListener('click', exportData);
  $('#fileImport').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importData(f);
  });
  $('#btnBack').addEventListener('click', showHome);
  for (const b of $$('#tabs button')) b.addEventListener('click', () => setTab(b.dataset.tab));

  $('#btnPlay').addEventListener('click', togglePlay);
  $('#btnAgain').addEventListener('click', () => playUnit());
  $('#btnListen').addEventListener('click', () => playUnit({ listen: true }));
  for (const b of $$('.row.grade button')) b.addEventListener('click', () => doGrade(b.dataset.g));
  $('#btnStopHere').addEventListener('click', stopHere);

  for (const b of $$('#handSel button')) {
    b.addEventListener('click', () => {
      P.hand = b.dataset.hand;
      if (P.mode === 'playing') setupRun(video.currentTime);
      renderHand();
      if (P.hand !== expectedHand()) toast(`${L.PHASE_LABEL[P.hand]}の自由練習(記録しません)`, 1800);
    });
  }
  $('#waitMode').addEventListener('change', (e) => {
    song.waitMode = e.target.checked;
    saveSong();
    renderMidiStatus();
    if (P.mode === 'playing') setupRun(video.currentTime);
  });
  $('#viewNotes').addEventListener('change', (e) => {
    song.viewNotes = e.target.checked;
    saveSong();
    renderHand();
  });
  $('#soundSel').addEventListener('change', (e) => {
    song.sound = e.target.value;
    unlockAudio();
    applySound();
    midi.allOff();
    saveSong();
  });
  $('#fileNotes').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importNotes(f);
  });
  $('#btnNotesRemove').addEventListener('click', () => {
    if (!confirm('この曲の音符データを外します(練習の記録は残ります)。')) return;
    delete song.notes;
    song.handFirst = false;
    for (const st of Object.values(song.progress)) st.phase = 'B';
    applySound();
    saveSong();
    renderSettings();
    P.hand = 'B';
    renderHand();
  });
  $('#setHandFirst').addEventListener('change', (e) => {
    song.handFirst = e.target.checked;
    if (!song.handFirst) for (const st of Object.values(song.progress)) if (st.phase !== 'B') st.phase = 'B';
    saveSong();
  });
  $('#setTol').addEventListener('change', (e) => {
    song.tol = Number(e.target.value);
    saveSong();
  });
  midi.onNoteOn = onMidiNoteOn;
  midi.onNoteOff = (p) => P.pressed.delete(p);
  midi.onChange = renderMidiStatus;
  for (const b of $$('.midibadge')) {
    b.addEventListener('click', async () => {
      await midi.request();
      renderMidiStatus();
      alert((midi.connected ? '電子ピアノにつながっています。' : '電子ピアノが見つかりません。ケーブルを挿し直し、ピアノの電源を入れてからもう一度押してください。') + '\n\n' + midi.diagnose());
    });
  }

  $('#btnEditPlay').addEventListener('click', togglePlay);
  for (const b of $$('[data-seek]')) {
    b.addEventListener('click', () => {
      video.currentTime = Math.min(song.duration, Math.max(0, video.currentTime + Number(b.dataset.seek)));
    });
  }
  $('#editRate').addEventListener('change', (e) => (video.playbackRate = Number(e.target.value)));
  $('#btnSplit').addEventListener('click', () => {
    if (L.splitAt(song, video.currentTime)) {
      saveSong();
      renderStrip();
      renderSecList();
      toast(`${fmt(video.currentTime, true)} で区切りました`, 1200);
    } else toast('区切りに近すぎます');
  });
  $('#btnResplit').addEventListener('click', () => {
    const how = hasNotes() ? '曲のまとまり(小節の頭など)で' : '同じ長さで';
    if (!confirm(`${how}区切り直します。この曲の練習の記録は消えます。`)) return;
    L.resplit(song, Number($('#resplitLen').value));
    saveSong();
    renderStrip();
    renderSecList();
    P.key = L.sectionKey(song, 0);
    P.unit = L.unitInfo(song, P.key);
    const bi = song.splitInfo;
    const lens = song.sections.map((s) => s.end - s.start).sort((a, b) => a - b);
    const per = bi ? `1区間 ≒ ${Math.round(lens[lens.length >> 1] / bi.bar)} 小節(${Math.round(lens[lens.length >> 1])}秒)` : '';
    toast(`${song.sections.length} 区間に区切りました ${per}`, 3000);
  });
  bindSettings();

  for (const m of [videoEl, clock]) {
    m.addEventListener('play', () => m === video && updatePlayButtons());
    m.addEventListener('pause', () => m === video && updatePlayButtons());
    m.addEventListener('ended', () => {
      if (m === video && tab === 'practice' && P.mode === 'playing') onUnitEnd();
    });
  }
  videoEl.addEventListener('loadedmetadata', fitStage);
  window.addEventListener('resize', () => song && fitStage());

  document.addEventListener('keydown', (e) => {
    if (!song || e.target.matches('input, select, textarea')) return;
    const k = e.key;
    if (k === ' ' || k === 'Enter') {
      e.preventDefault();
      togglePlay();
    } else if (tab === 'practice' && (k === 'ArrowRight' || k === 'PageDown')) {
      e.preventDefault();
      doGrade('ok');
    } else if (tab === 'practice' && (k === 'ArrowLeft' || k === 'PageUp')) {
      e.preventDefault();
      doGrade('ng');
    } else if (tab === 'practice' && k === 'ArrowDown') {
      e.preventDefault();
      doGrade('meh');
    } else if (tab === 'practice' && k === 'ArrowUp') {
      e.preventDefault();
      stopHere();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (song) store.putSong(song).catch(() => {});
      saveLog();
    } else if (song) keepAwake();
  });
}

// 練習時間を数える・区間の終わりを見張る
let lastTick = performance.now();
let unsavedSec = 0;
let editLastT = 0;
function frame(now) {
  if (song) {
    if (tab === 'practice' && P.mode === 'playing' && P.unit && !video.paused) {
      const cur = video.currentTime;
      // 待ってくれるモード: 次の和音が来たら、押すまで止める
      if (P.wait) {
        const c = P.wait.chords[P.wait.i];
        if (c && cur >= c.t - 0.01) {
          P.waiting = true;
          video.pause();
        }
      }
      if (cur > P.lastT) {
        soundNotes(P.lastT, cur);
        P.lastT = cur;
      }
      if (cur >= P.unit.end - 0.03 && P.unit.end < song.duration - 0.1) onUnitEnd();
    }
    // 区切りの編集で流しているときも音符を鳴らす(動画のない曲)
    if (tab === 'edit' && !video.paused) {
      const cur = video.currentTime;
      if (cur > editLastT && cur - editLastT < 1) soundNotes(editLastT, cur, true);
      editLastT = cur;
    }
    drawNotes();
    updatePlayhead();
    if (tab === 'edit') {
      $('#editTime').textContent = `${fmt(video.currentTime, true)} / ${fmt(song.duration)}`;
    }
    const dt = (now - lastTick) / 1000;
    if (!video.paused && dt < 1) {
      unsavedSec += dt;
      if (unsavedSec >= 5) {
        L.addPractice(log, Date.now(), Math.round(unsavedSec), song.id);
        unsavedSec = 0;
        if (Math.random() < 0.3) saveLog();
      }
    }
  }
  lastTick = now;
  requestAnimationFrame(frame);
}

let lastSecIdx = -1;
setInterval(() => {
  if (song && tab === 'edit') {
    const i = L.sectionIndexAt(song, video.currentTime);
    if (i !== lastSecIdx) {
      lastSecIdx = i;
      renderSecList();
    }
  }
}, 400);

async function init() {
  globalThis.__pp = { P, midi, get media() { return video; }, get song() { return song; } }; // 動作確認用
  setupVideoInputs();
  bind();
  midi.init();
  log = await store.get('log', {});
  await showHome();
  requestAnimationFrame(frame);
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
