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
