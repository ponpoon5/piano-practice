"""落ちてくる鍵盤型の動画から音符を読み取る。

使い方:
  python tools/extract_notes.py <動画> [-o 出力フォルダ] [--start 秒] [--end 秒] [--lowest MIDI番号]

出力:
  <名前>.notes.json  アプリに取り込む音符(音の高さ・始まり・長さ・左右の手。時刻は動画の秒)
  <名前>.mid         耳で確かめる用
  <名前>_calib.png   鍵盤の読み取り位置(目で確かめる用)
  <名前>_roll.png    読み取った音符の一覧図

しくみ:
  1. 動画のあちこちから40枚取り出し、画素ごとの中央値で「何も押していない鍵盤」を作る
  2. 白鍵だけの帯の継ぎ目から白鍵の幅、黒鍵の帯の暗い塊から黒鍵の位置を求め、
     黒鍵の 2本・3本 の並びからドを特定して各鍵の音の高さを決める
  3. 毎フレーム、各鍵の位置が色付き(押されている)かを読む
  4. 同じ鍵を続けて弾く音は、鍵盤のすぐ上を落ちてくる棒の切れ目で分ける
  5. 押された色を2つに分け、低い音が多い方を左手とする
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

import cv2
import numpy as np

WHITE_IN_OCT = [0, 2, 4, 5, 7, 9, 11]  # ド レ ミ ファ ソ ラ シ
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def note_name(p: int) -> str:
    return f"{NAMES[p % 12]}{p // 12 - 1}"


# ---------------------------------------------------------------- 鍵盤を見つける

def sample_frames(cap, n_total, k=40, t0=0.0, t1=None, fps=30.0):
    a = int(t0 * fps)
    b = int((t1 * fps) if t1 else n_total)
    out = []
    for i in range(k):
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(a + (b - a) * (i + 0.5) / k))
        ok, f = cap.read()
        if ok:
            out.append(f)
    return out


def find_keyboard(med_gray: np.ndarray):
    """白鍵だけの帯・黒鍵の帯・音が当たる線の高さを返す。"""
    h, w = med_gray.shape
    # 白鍵が暗めに映る動画もある(コナン天国: 白鍵≒141)ので、画面の明るい所に合わせる
    # 白鍵だけの段 = 暗い画素がなく、横に一様で明るめの行。その明るさを基準にする
    rmean = med_gray.mean(axis=1)
    rstd = med_gray.std(axis=1)
    rdark = (med_gray < 70).mean(axis=1)
    cand = np.where((rdark < 0.02) & (rstd < 30) & (rmean > 100))[0]
    thr = 190
    if len(cand):
        cg = max(np.split(cand, np.where(np.diff(cand) > 1)[0] + 1), key=len)
        if len(cg) >= 8:
            thr = min(190, float(np.median(rmean[cg])) * 0.85)
    bright = (med_gray > thr).mean(axis=1)
    dark = (med_gray < 70).mean(axis=1)
    white_rows = np.where(bright > 0.8)[0]
    if len(white_rows) == 0:
        raise RuntimeError("鍵盤(白鍵の帯)が見つかりません")
    # 一番下の、まとまった白い帯
    groups = np.split(white_rows, np.where(np.diff(white_rows) > 1)[0] + 1)
    g = max(groups, key=len)
    wy0, wy1 = int(g[0]), int(g[-1])
    # その上の黒鍵が混じる帯(明るい 35〜70% かつ 暗い 15% 以上)
    def mixed(y):
        return 0.3 < bright[y] < 0.8 and dark[y] > 0.15

    y = wy0 - 1
    while y > 0 and not mixed(y) and wy0 - y < 15:  # 黒鍵の先端の影などを飛ばす
        y -= 1
    by1 = y
    while y > 0 and mixed(y):
        y -= 1
    by0 = y + 1
    if by1 - by0 < 10:
        raise RuntimeError("黒鍵の帯が見つかりません")
    hit = by0 - 1
    return dict(white_y0=wy0, white_y1=wy1, black_y0=by0, black_y1=by1, hit_y=hit, white_thr=thr)


def runs(mask: np.ndarray):
    out = []
    x = 0
    n = len(mask)
    while x < n:
        if mask[x]:
            s = x
            while x < n and mask[x]:
                x += 1
            out.append((s, x))
        else:
            x += 1
    return out


def find_keys(med_gray: np.ndarray, kb: dict, lowest: int | None = None):
    h, w = med_gray.shape
    yb = (kb["black_y0"] + kb["black_y1"]) // 2
    yw = (kb["white_y0"] + kb["white_y1"]) // 2
    row_w = med_gray[yw].astype(float)
    wthr = kb.get("white_thr", 190)
    bright = row_w > min(150, wthr * 0.9)
    xs = np.where(bright)[0]
    xl, xr = int(xs[0]), int(xs[-1]) + 1
    # 白鍵の継ぎ目(少し暗い谷)
    seam_max = min(215, float(np.percentile(row_w[xl:xr], 90)) - 3)
    seams = [x for x in range(xl + 2, xr - 2) if row_w[x] < row_w[x - 1] and row_w[x] <= row_w[x + 1] and row_w[x] < seam_max]
    d = np.diff(seams)
    d = d[(d > 6)]
    n0 = int(round((xr - xl) / float(np.median(d))))
    # 継ぎ目が格子にいちばん揃う本数を選ぶ(幅が 24/25px と交互になる動画でも数え違えない)
    sa = np.array(seams, float)

    def misfit(n):
        w_ = (xr - xl) / n
        r = (sa - xl) / w_
        return float(np.mean(np.abs(r - np.round(r))))

    n_white = min(range(max(7, n0 - 3), n0 + 4), key=misfit)
    ww = (xr - xl) / n_white
    # 黒鍵
    row_b = med_gray[yb].astype(float)
    blacks = [(a, b) for a, b in runs(row_b < 80) if b - a > ww * 0.3]
    centers = [(a + b) / 2 for a, b in blacks]
    seam_idx = sorted({int(round((c - xl) / ww)) for c in centers})
    has = set(seam_idx)
    # 黒鍵がある継ぎ目: ド|レ, レ|ミ, ファ|ソ, ソ|ラ, ラ|シ → 白鍵番号で 1,2,4,5,6 (ド=0 のとき)
    best = None
    for o in range(7):
        score = 0
        for j in range(1, n_white):
            pos = (j - o) % 7
            expect = pos in (1, 2, 4, 5, 6)
            score += 1 if expect == (j in has) else -1
        if best is None or score > best[0]:
            best = (score, o)
    o = best[1]  # 白鍵 o 番がド

    def rel_midi(j):  # 白鍵 o 番のドを 0 とした音の高さ
        r = j - o
        return 12 * (r // 7) + WHITE_IN_OCT[r % 7]

    # オクターブ: 指定があればそれ、52鍵なら左端はラ0、それ以外は真ん中に近いドを C4 とする
    if lowest is not None:
        base = lowest - rel_midi(0)
    elif n_white == 52:
        base = 21 - rel_midi(0)
    else:
        cs = [j for j in range(n_white) if (j - o) % 7 == 0]
        mid_c = min(cs, key=lambda j: abs(j - n_white / 2))
        base = 60 - rel_midi(mid_c)
    keys = []
    for j in range(n_white):
        keys.append(dict(p=base + rel_midi(j), x=xl + (j + 0.5) * ww, y=yw, black=False, w=ww))
    # 押されっぱなし等で見つからなかった黒鍵を、並びの規則から補う
    found = {int(round((c - xl) / ww)) for c in centers}
    for j in range(1, n_white):
        if (j - o) % 7 in (1, 2, 4, 5, 6) and j not in found:
            centers.append(xl + j * ww)
    for c in centers:
        j = int(round((c - xl) / ww))  # 右側の白鍵
        left = next((kk for kk in keys if not kk["black"] and abs(kk["x"] - (xl + (j - 0.5) * ww)) < 1), None)
        if left is None:  # 端からはみ出した黒鍵
            continue
        keys.append(dict(p=left["p"] + 1, x=c, y=yb, black=True, w=ww * 0.55))
    keys.sort(key=lambda k: k["p"])
    return keys, dict(xl=xl, xr=xr, white_w=ww, n_white=n_white, n_black=len(centers), match=best[0])


# ---------------------------------------------------------------- 毎フレーム読む

def patch(img, x, y, rx, ry):
    x = int(round(x))
    return img[y - ry:y + ry + 1, max(0, x - rx):x + rx + 1]


def scan(cap, keys, kb, fps, f0, f1, bar_dy=60, progress=True):
    n = f1 - f0
    K = len(keys)
    pressed = np.zeros((n, K), bool)
    hue = np.full((n, K), np.nan, np.float32)
    bar = np.zeros((n, K), bool)
    bar_y = kb["hit_y"] - bar_dy
    cap.set(cv2.CAP_PROP_POS_FRAMES, f0)
    xs = [int(round(k["x"])) for k in keys]
    for i in range(n):
        ok, f = cap.read()
        if not ok:
            pressed = pressed[:i]
            hue = hue[:i]
            bar = bar[:i]
            break
        hsv = cv2.cvtColor(f, cv2.COLOR_BGR2HSV)
        for j, k in enumerate(keys):
            rx = max(1, int(k["w"] * 0.18))
            p = patch(hsv, k["x"], k["y"], rx, 3)
            s = float(p[..., 1].mean())
            v = float(p[..., 2].mean())
            if s > 70 and v > 70:
                pressed[i, j] = True
                hue[i, j] = float(np.median(p[..., 0]))
            # 鍵盤の少し上: 棒があるか(棒は明るさ200前後、切れ目・背景は60前後)
            q = hsv[bar_y - 1:bar_y + 2, max(0, xs[j] - 1):xs[j] + 2]
            bar[i, j] = float(q[..., 2].mean()) > 140
        if progress and i % 600 == 0:
            print(f"  {i}/{n} フレーム", file=sys.stderr, flush=True)
    return pressed, hue, bar


def segments(col: np.ndarray, min_len=2, max_gap=1):
    """True の連続をまとめる(1フレームの抜けは埋める)。"""
    r = runs(col)
    merged = []
    for a, b in r:
        if merged and a - merged[-1][1] <= max_gap:
            merged[-1] = (merged[-1][0], b)
        else:
            merged.append((a, b))
    return [(a, b) for a, b in merged if b - a >= min_len]


def estimate_lag(pressed, bar, max_lag=60):
    """鍵盤上の棒の始まり→鍵が色付くまでのフレーム数。"""
    diffs = []
    for j in range(pressed.shape[1]):
        ons = [a for a, b in segments(pressed[:, j])]
        bon = [a for a, b in runs(bar[:, j])]
        for a in ons:
            c = [a - x for x in bon if 0 <= a - x <= max_lag]
            if c:
                diffs.append(min(c))
    return int(np.median(diffs)) if diffs else 0, len(diffs)


def build_notes(pressed, hue, bar, keys, fps, f0, lag):
    notes = []
    for j, k in enumerate(keys):
        for a, b in segments(pressed[:, j]):
            # 押されている間に棒の切れ目が通ったら、そこで音を分ける
            cuts = []
            col = bar[:, j]
            for g0, g1 in runs(~col[max(0, a - lag):max(0, b - lag)]):
                t = g1 + max(0, a - lag) + lag  # 切れ目の終わり=次の棒の始まりが鍵盤に届く
                if a + 2 <= t <= b - 2:
                    cuts.append(t)
            bounds = [a] + cuts + [b]
            for s, e in zip(bounds[:-1], bounds[1:]):
                hs = hue[s:e, j]
                hs = hs[~np.isnan(hs)]
                notes.append(dict(
                    p=k["p"],
                    t=round((f0 + s) / fps, 3),
                    d=round((e - s) / fps, 3),
                    hue=float(np.median(hs)) if len(hs) else None,
                ))
    notes.sort(key=lambda n: (n["t"], n["p"]))
    return notes


def assign_hands(notes):
    hs = np.array([n["hue"] for n in notes if n["hue"] is not None], np.float32)
    if len(hs) < 2:
        for n in notes:
            n["h"] = "R"
        return None
    # 色相(0-179)を2群に分ける
    c = np.array([np.percentile(hs, 10), np.percentile(hs, 90)], np.float32)
    for _ in range(20):
        lab = np.argmin(np.abs(hs[:, None] - c[None, :]), axis=1)
        for k in range(2):
            if (lab == k).any():
                c[k] = hs[lab == k].mean()
    if abs(c[0] - c[1]) < 8:
        for n in notes:
            n["h"] = "R" if n["p"] >= 60 else "L"
        return dict(centers=c.tolist(), mode="pitch")
    mean_p = []
    for k in range(2):
        ps = [n["p"] for n in notes if n["hue"] is not None and np.argmin(np.abs(n["hue"] - c)) == k]
        mean_p.append(np.mean(ps) if ps else 0)
    left = int(np.argmin(mean_p))
    for n in notes:
        if n["hue"] is None:
            n["h"] = "R" if n["p"] >= 60 else "L"
        else:
            n["h"] = "L" if int(np.argmin(np.abs(n["hue"] - c))) == left else "R"
    return dict(centers=c.tolist(), left=left, mode="color")


# ---------------------------------------------------------------- 出力

def write_midi(notes, path, tempo_us=500000):
    tpq = 480
    ticks = lambda sec: int(round(sec * 1e6 / tempo_us * tpq))
    ev = []
    for n in notes:
        ch = 0 if n["h"] == "R" else 1
        ev.append((ticks(n["t"]), 1, ch, n["p"]))
        ev.append((ticks(n["t"] + n["d"]), 0, ch, n["p"]))
    ev.sort(key=lambda e: (e[0], e[1]))

    def vlq(v):
        out = [v & 0x7F]
        v >>= 7
        while v:
            out.append((v & 0x7F) | 0x80)
            v >>= 7
        return bytes(reversed(out))

    data = bytearray(b"\x00\xff\x51\x03" + tempo_us.to_bytes(3, "big"))
    last = 0
    for t, on, ch, p in ev:
        data += vlq(t - last)
        last = t
        data += bytes([(0x90 if on else 0x80) | ch, p, 80 if on else 0])
    data += b"\x00\xff\x2f\x00"
    with open(path, "wb") as f:
        f.write(b"MThd" + struct.pack(">IHHH", 6, 0, 1, tpq))
        f.write(b"MTrk" + struct.pack(">I", len(data)) + data)


def draw_calib(frame, keys, kb, path):
    im = frame.copy()
    for k in keys:
        x = int(round(k["x"]))
        col = (0, 0, 255) if k["black"] else (255, 0, 0)
        cv2.circle(im, (x, k["y"]), 3, col, -1)
        if k["p"] % 12 == 0:
            cv2.putText(im, note_name(k["p"]), (x - 10, kb["white_y1"] + 14), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 255), 1)
    cv2.line(im, (0, kb["hit_y"] - 60), (im.shape[1], kb["hit_y"] - 60), (0, 255, 255), 1)
    cv2.imwrite(str(path), im)


def draw_roll(notes, path, t0, t1, px_per_sec=40):
    lo = min(n["p"] for n in notes) - 2
    hi = max(n["p"] for n in notes) + 2
    W = int((t1 - t0) * px_per_sec) + 1
    H = (hi - lo + 1) * 6
    W = min(W, 30000)
    im = np.full((H, W, 3), 30, np.uint8)
    for p in range(lo, hi + 1):
        if p % 12 == 0:
            y = (hi - p) * 6
            cv2.line(im, (0, y + 5), (W, y + 5), (70, 70, 70), 1)
    for n in notes:
        x0 = int((n["t"] - t0) * px_per_sec)
        x1 = max(x0 + 1, int((n["t"] + n["d"] - t0) * px_per_sec) - 1)
        y = (hi - n["p"]) * 6
        col = (90, 200, 110) if n["h"] == "R" else (213, 155, 91)
        cv2.rectangle(im, (x0, y), (x1, y + 4), col, -1)
    cv2.imwrite(str(path), im)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("-o", "--out", default=None)
    ap.add_argument("--name", default=None)
    ap.add_argument("--start", type=float, default=0)
    ap.add_argument("--end", type=float, default=None)
    ap.add_argument("--lowest", type=int, default=None, help="左端の白鍵の MIDI 番号(自動判定が外れたとき)")
    a = ap.parse_args()

    src = Path(a.video)
    out = Path(a.out) if a.out else src.parent
    out.mkdir(parents=True, exist_ok=True)
    name = a.name or src.stem
    cap = cv2.VideoCapture(str(src))
    fps = cap.get(cv2.CAP_PROP_FPS)
    n_total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = n_total / fps

    frames = sample_frames(cap, n_total, fps=fps)
    med = np.median(np.stack(frames), axis=0).astype(np.uint8)
    med_gray = cv2.cvtColor(med, cv2.COLOR_BGR2GRAY)
    kb = find_keyboard(med_gray)
    keys, info = find_keys(med_gray, kb, a.lowest)
    print(f"鍵盤: 白鍵 {info['n_white']} 本・黒鍵 {info['n_black']} 本・白鍵幅 {info['white_w']:.1f}px・"
          f"範囲 {note_name(keys[0]['p'])}〜{note_name(keys[-1]['p'])}・並びの一致 {info['match']}", file=sys.stderr)
    draw_calib(med, keys, kb, out / f"{name}_calib.png")

    f0 = int(a.start * fps)
    f1 = int(a.end * fps) if a.end else n_total
    pressed, hue, bar = scan(cap, keys, kb, fps, f0, f1)
    lag, nlag = estimate_lag(pressed, bar)
    print(f"棒→鍵の遅れ {lag} フレーム(標本 {nlag})", file=sys.stderr)
    notes = build_notes(pressed, hue, bar, keys, fps, f0, lag)
    hands = assign_hands(notes)
    for n in notes:
        n.pop("hue", None)

    doc = dict(
        app="piano-practice-notes",
        version=1,
        source=src.name,
        fps=fps,
        duration=duration,
        keyboard=dict(lowest=keys[0]["p"], highest=keys[-1]["p"], **{k: v for k, v in info.items()}),
        hands=hands,
        notes=notes,
    )
    (out / f"{name}.notes.json").write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    write_midi(notes, out / f"{name}.mid")
    if notes:
        draw_roll(notes, out / f"{name}_roll.png", a.start, min(duration, (a.end or duration)))
    nl = sum(1 for n in notes if n["h"] == "L")
    print(f"音符 {len(notes)} 個(左手 {nl}・右手 {len(notes) - nl})→ {out / (name + '.notes.json')}", file=sys.stderr)


if __name__ == "__main__":
    main()
