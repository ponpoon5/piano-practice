import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../app/logic.js';

const T0 = new Date(2026, 10, 20, 9, 0, 0).getTime();

function song(duration = 60, len = 15) {
  return L.newSong({ id: 'x', name: 't', duration, now: T0, sectionLen: len });
}

test('自動で区切る・最後の短い端はくっつける', () => {
  const s = song(67, 15);
  assert.equal(s.sections.length, 4);
  assert.equal(s.sections[3].start, 45);
  assert.equal(s.sections[3].end, 67);
  const s2 = song(68, 15);
  assert.equal(s2.sections.length, 5); // 8秒の端は長さの半分以上なので別区間
  assert.equal(s2.sections.at(-1).start, 60);
});

test('◎3回で速度アップ、最後の速度で合格', () => {
  const s = song();
  const k = L.sectionKey(s, 0);
  assert.equal(L.speedPercent(s, k), 60);
  let ev;
  for (let step = 0; step < 3; step++) {
    L.grade(s, k, 'ok', T0);
    L.grade(s, k, 'ok', T0);
    ev = L.grade(s, k, 'ok', T0).event;
    assert.equal(ev, 'speedup');
  }
  assert.equal(L.speedPercent(s, k), 100);
  L.grade(s, k, 'ok', T0);
  L.grade(s, k, 'meh', T0); // 途切れる
  L.grade(s, k, 'ok', T0);
  L.grade(s, k, 'ok', T0);
  ev = L.grade(s, k, 'ok', T0).event;
  assert.equal(ev, 'cleared');
  assert.equal(L.sectionStatus(s, 0, T0), 'cleared');
  assert.equal(L.sectionStatus(s, 0, T0 + L.DAY), 'due');
});

test('×が3回続くと速度を下げる', () => {
  const s = song();
  const k = L.sectionKey(s, 0);
  for (let i = 0; i < 3; i++) L.grade(s, k, 'ok', T0);
  assert.equal(L.speedPercent(s, k), 75);
  L.grade(s, k, 'ng', T0);
  L.grade(s, k, 'ng', T0);
  assert.equal(L.grade(s, k, 'ng', T0).event, 'slowdown');
  assert.equal(L.speedPercent(s, k), 60);
});

function clear(s, k) {
  for (let i = 0; i < 40 && !L.getState(s, k).cleared; i++) L.grade(s, k, 'ok', T0);
}

test('復習: ◎で間隔が伸び、×で練習に戻る', () => {
  const s = song();
  const k = L.sectionKey(s, 0);
  clear(s, k);
  assert.equal(L.getState(s, k).next, T0 + L.DAY);
  L.grade(s, k, 'ok', T0 + L.DAY);
  assert.equal(L.getState(s, k).next, T0 + L.DAY + 3 * L.DAY);
  assert.equal(L.grade(s, k, 'ng', T0 + 4 * L.DAY).event, 'relearn');
  assert.equal(L.getState(s, k).cleared, false);
  assert.equal(L.speedPercent(s, k), 90);
  assert.equal(L.getState(s, k).everCleared, true);
});

test('つなぎ→まとめ→通しが順に出る', () => {
  const s = song(75, 15); // 5区間
  assert.deepEqual(L.chainUnits(s), []);
  clear(s, L.sectionKey(s, 0));
  clear(s, L.sectionKey(s, 1));
  const ch = L.chainUnits(s);
  assert.equal(ch.length, 1);
  assert.equal(L.unitInfo(s, ch[0]).label, 'つなぎ 1→2');
  // つなぎは目標の一段下から・2回で進む
  assert.equal(L.speedPercent(s, ch[0]), 90);
  for (let i = 2; i < 5; i++) clear(s, L.sectionKey(s, i));
  for (const k of L.chainUnits(s)) if (k.startsWith('p:')) clear(s, k);
  const after = L.chainUnits(s);
  assert.ok(after.some((k) => k.startsWith('b:') && L.unitInfo(s, k).label === 'まとめ 1〜4'));
  assert.ok(after.includes('full'));
  const u = L.unitInfo(s, 'full');
  assert.equal(u.start, 0);
  assert.equal(u.end, 75);
});

test('今日のメニュー: 復習→練習中→新しい区間→つなぎ', () => {
  const s = song(90, 15); // 6区間
  let m = L.buildMenu(s, T0);
  assert.deepEqual(m.map((x) => x.kind), ['new', 'new']);
  clear(s, L.sectionKey(s, 0));
  clear(s, L.sectionKey(s, 1));
  L.grade(s, L.sectionKey(s, 2), 'ok', T0);
  m = L.buildMenu(s, T0 + L.DAY);
  assert.deepEqual(
    m.map((x) => x.kind),
    ['review', 'review', 'practice', 'new', 'chain']
  );
  assert.equal(L.unitInfo(s, m[3].key).label, '区間 4');
});

test('止まった区間は弱点になりメニューに入る', () => {
  const s = song(60, 15);
  for (let i = 0; i < 4; i++) clear(s, L.sectionKey(s, i));
  const i = L.markStop(s, 32, T0 + 1000);
  assert.equal(i, 2);
  assert.equal(L.sectionStatus(s, 2, T0 + 1000), 'weak');
  const m = L.buildMenu(s, T0 + 1000);
  assert.equal(m[0].kind, 'weak');
  assert.equal(L.unitInfo(s, m[0].key).label, '区間 3');
  L.grade(s, m[0].key, 'ok', T0 + 2000);
  assert.equal(L.sectionStatus(s, 2, T0 + 2000), 'cleared');
});

test('区切りの追加・削除・移動', () => {
  const s = song(60, 15);
  const k0 = L.sectionKey(s, 0);
  L.grade(s, k0, 'ok', T0);
  assert.ok(L.splitAt(s, 7));
  assert.equal(s.sections.length, 5);
  assert.equal(s.progress[k0], undefined); // 区切り直した区間の記録は消える
  const k2 = L.sectionKey(s, 2);
  L.grade(s, k2, 'ok', T0);
  assert.ok(L.moveBoundary(s, 2, 0.5));
  assert.equal(s.sections[2].end, 30.5);
  assert.ok(s.progress[k2]); // 少し動かすだけなら残る
  assert.ok(!L.moveBoundary(s, 2, 20));
  assert.ok(L.removeBoundary(s, 0));
  assert.equal(s.sections.length, 4);
  assert.equal(s.sections[0].end, 15);
  assert.ok(!L.splitAt(s, 15.2));
});

test('練習時間と連続日数', () => {
  const log = {};
  L.addPractice(log, T0, 300, 'x');
  L.addPractice(log, T0 - L.DAY, 120, 'x');
  L.addPractice(log, T0 - 2 * L.DAY, 30, 'x'); // 1分未満は数えない
  assert.equal(L.streakDays(log, T0), 2);
  assert.equal(L.streakDays(log, T0 + L.DAY), 2); // 今日まだ弾いていなくても昨日まで続いていれば
  assert.equal(L.streakDays(log, T0 + 2 * L.DAY), 0);
});

test('片手ずつ: 右手◎2回→左手◎2回→両手', () => {
  const s = song(60, 15);
  s.handFirst = true;
  const k = L.sectionKey(s, 0);
  assert.equal(L.phaseOf(L.getState(s, k)), 'R');
  assert.equal(L.remainingOk(s, k), 2);
  L.grade(s, k, 'ok', T0);
  L.grade(s, k, 'ng', T0); // 途切れる
  L.grade(s, k, 'ok', T0);
  assert.equal(L.grade(s, k, 'ok', T0).event, 'hand-next');
  assert.equal(L.phaseOf(L.getState(s, k)), 'L');
  L.grade(s, k, 'ok', T0);
  assert.equal(L.grade(s, k, 'ok', T0).event, 'hand-next');
  assert.equal(L.phaseOf(L.getState(s, k)), 'B');
  assert.equal(L.speedPercent(s, k), 60);
  for (let i = 0; i < 2; i++) L.grade(s, k, 'ok', T0);
  assert.equal(L.grade(s, k, 'ok', T0).event, 'speedup');
  // つなぎは片手の段階なし
  assert.equal(L.phaseOf(L.getState(s, 'full')), 'B');
});

test('苦手な所: 足す・重ならない・続けて弾けたら消える', () => {
  const s = song(60, 15);
  const k = L.addSpot(s, 20, 23);
  assert.ok(k);
  assert.equal(L.addSpot(s, 22, 25), null);
  const u = L.unitInfo(s, k);
  assert.equal(u.kind, 'spot');
  assert.equal(u.label, '苦手な所(区間 2)');
  assert.equal(L.buildMenu(s, T0)[0].key, k);
  L.grade(s, k, 'ok', T0);
  assert.equal(L.grade(s, k, 'ok', T0).event, 'spot-cleared');
  assert.equal(s.spots.length, 0);
  assert.equal(L.unitInfo(s, k), null);
});

// 小節4秒・頭は2秒目から。左手は小節の頭に長い低音、右手は3連符(1/3秒ごと)を切れ目なく
function barSong(bars = 16, P = 4, t0 = 2, drift = 0) {
  const notes = [];
  for (let b = 0; b < bars; b++) {
    const s = t0 + b * (P + drift);
    notes.push({ p: 37 + (b % 4), t: s, d: P - 0.1, h: 'L' });
    for (let k = 0; k < 12; k++) notes.push({ p: 61 + ((k + b) % 5), t: s + (k * (P + drift)) / 12, d: 0.3, h: 'R' });
  }
  return { notes, duration: t0 + bars * (P + drift) + 2 };
}

test('音符があれば小節の頭で区切る(繰り返しの途中で切らない)', () => {
  const { notes, duration } = barSong(16, 4, 2);
  const s = L.newSong({ id: 'x', name: 't', duration, now: T0, sectionLen: 8, notes: { notes } });
  const bounds = s.sections.slice(1).map((x) => x.start);
  assert.ok(bounds.length >= 5);
  for (const b of bounds) {
    const bar = (b + 0.08 - 2) / 4; // 区切りは和音の少し前
    assert.ok(Math.abs(bar - Math.round(bar)) < 0.03, `小節の頭でない: ${b}`);
  }
  // 目安8秒 = 2小節ずつ
  const lens = s.sections.slice(1, -1).map((x) => Math.round((x.end - x.start) / 4));
  assert.ok(lens.every((n) => n === 2), lens.join(','));
  assert.ok(Math.abs(s.splitInfo.bar - 4) < 0.05);
});

test('テンポが少しずつずれても小節の頭を追う', () => {
  const { notes, duration } = barSong(40, 4, 2, 0.02); // 1小節ごとに0.02秒ずつ遅くなる
  const s = L.newSong({ id: 'x', name: 't', duration, now: T0, sectionLen: 8, notes: { notes } });
  const heads = new Set(notes.filter((n) => n.h === 'L').map((n) => Math.round(n.t * 100)));
  for (const x of s.sections.slice(1)) {
    const near = [...heads].some((h) => Math.abs(h / 100 - (x.start + 0.08)) < 0.03);
    assert.ok(near, `小節の頭でない: ${x.start}`);
  }
});

test('音符がない曲はこれまで通り同じ長さ', () => {
  const s = L.newSong({ id: 'x', name: 't', duration: 60, now: T0, sectionLen: 15 });
  assert.deepEqual(s.sections.map((x) => x.start), [0, 15, 30, 45]);
  assert.equal(s.splitInfo, null);
});
