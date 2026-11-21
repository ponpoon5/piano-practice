"""2つの .notes.json を突き合わせる(正解 vs 推定)。
使い方: python tools/compare_notes.py 正解.notes.json 推定.notes.json [--tol 0.1]
時刻のずれ(映像と音の遅れ)は全体で一つ推定して差し引く。
"""
import argparse
import json
from collections import Counter


def load(p):
    with open(p, encoding='utf-8') as f:
        d = json.load(f)
    return d['notes'] if isinstance(d, dict) else d


def match(ref, est, tol, shift):
    used = set()
    pairs = []
    by_p = {}
    for j, e in enumerate(est):
        by_p.setdefault(e['p'], []).append(j)
    for i, r in enumerate(ref):
        best, bj = tol, None
        for j in by_p.get(r['p'], []):
            if j in used:
                continue
            dt = abs(est[j]['t'] - shift - r['t'])
            if dt <= best:
                best, bj = dt, j
        if bj is not None:
            used.add(bj)
            pairs.append((i, bj))
    return pairs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('ref')
    ap.add_argument('est')
    ap.add_argument('--tol', type=float, default=0.1)
    ap.add_argument('--min-vel', type=int, default=0)
    a = ap.parse_args()
    ref = load(a.ref)
    est = [e for e in load(a.est) if e.get('v', 127) >= a.min_vel]
    # 全体のずれ: 同じ音高の最寄り onset 差の最頻値
    diffs = Counter()
    for r in ref:
        for e in est:
            if e['p'] == r['p'] and abs(e['t'] - r['t']) < 0.5:
                diffs[round(e['t'] - r['t'], 2)] += 1
    shift = diffs.most_common(1)[0][0] if diffs else 0.0
    pairs = match(ref, est, a.tol, shift)
    tp = len(pairs)
    rec, prec = tp / len(ref), tp / len(est) if est else 0
    f1 = 2 * rec * prec / (rec + prec) if tp else 0
    print(f'ずれ {shift:+.2f}秒 / 正解{len(ref)}音 推定{len(est)}音 一致{tp}')
    print(f'拾えた割合(再現) {rec:.1%}  余分でない割合(適合) {prec:.1%}  F1 {f1:.1%}')
    hands = [(ref[i].get('h'), est[j].get('h')) for i, j in pairs if est[j].get('h')]
    if hands:
        ok = sum(1 for x, y in hands if x == y)
        print(f'左右の一致 {ok}/{len(hands)} = {ok / len(hands):.1%}')
    mi = set(i for i, _ in pairs)
    mj = set(j for _, j in pairs)
    miss = [ref[i] for i in range(len(ref)) if i not in mi]
    extra = [est[j] for j in range(len(est)) if j not in mj]
    # 1オクターブ違い・時刻ずれ大の内訳
    def near(x, pool, dp):
        return any(abs(y['t'] - shift - x['t']) < 0.3 and y['p'] - x['p'] == dp for y in pool)
    print(f'抜け{len(miss)}: うちオクターブ上で出た {sum(near(m, extra, 12) for m in miss)}, 時刻だけずれ {sum(any(abs(y["t"]-shift-m["t"])<0.3 and y["p"]==m["p"] for y in extra) for m in miss)}')
    if extra and 'v' in extra[0]:
        vs = sorted(e['v'] for e in extra)
        print(f'余分{len(extra)}: 強さの中央値 {vs[len(vs)//2]} (一致した音の中央値 {sorted(est[j]["v"] for _, j in pairs)[tp//2]})')
    else:
        print(f'余分{len(extra)}')
    print('抜けの例:', [(m['p'], m['t']) for m in miss[:8]])
    print('余分の例:', [(e['p'], round(e['t'] - shift, 2)) for e in extra[:8]])


if __name__ == '__main__':
    main()
