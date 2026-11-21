"""notes.json を簡易ピアノ音で鳴らして音声ファイル(.m4a/.wav)にする。耳で確かめる用。
使い方: python tools/render_audio.py 入力.notes.json 出力.m4a [--hand R|L|B]
"""
import argparse
import json
import subprocess

import numpy as np

SR = 32000


def tone(p, dur):
    f = 440.0 * 2 ** ((p - 69) / 12)
    rel = 0.25
    n = int((dur + rel) * SR)
    t = np.arange(n) / SR
    # 低い音ほどゆっくり減衰する
    decay = 0.8 + 3.0 * (108 - p) / 87
    env = np.exp(-t / decay)
    env *= np.clip((dur + rel - t) / rel, 0, 1)  # 離したら消える
    env *= np.clip(t / 0.003, 0, 1)  # 打鍵のプチ音を防ぐ
    y = np.zeros(n)
    for k in range(1, 7):
        if f * k > SR / 2:
            break
        y += np.sin(2 * np.pi * f * k * t) * (0.6 ** (k - 1)) * np.exp(-t * k * 0.6)
    return y * env


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('out')
    ap.add_argument('--hand', default='B')
    a = ap.parse_args()
    notes = json.load(open(a.src, encoding='utf-8'))['notes']
    if a.hand != 'B':
        notes = [n for n in notes if n.get('h') == a.hand]
    end = max(n['t'] + n['d'] for n in notes) + 1
    buf = np.zeros(int(end * SR) + SR)
    cache = {}
    for n in notes:
        d = round(min(n['d'], 4.0), 2)
        key = (n['p'], d)
        if key not in cache:
            cache[key] = tone(n['p'], d)
        y = cache[key]
        i = int(n['t'] * SR)
        buf[i:i + len(y)] += y[:len(buf) - i]
    buf /= max(1e-9, np.percentile(np.abs(buf), 99.9)) * 1.1
    pcm = (np.clip(buf, -1, 1) * 32000).astype('<i2').tobytes()
    cmd = ['ffmpeg', '-y', '-v', 'error', '-f', 's16le', '-ar', str(SR), '-ac', '1', '-i', '-']
    cmd += ['-c:a', 'aac', '-b:a', '128k'] if a.out.endswith('.m4a') else []
    subprocess.run(cmd + [a.out], input=pcm, check=True)
    print(a.out, f'{end:.0f}秒 {len(notes)}音')


if __name__ == '__main__':
    main()
