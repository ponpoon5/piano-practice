"""ピアノの録音(動画の音声でも可)から .notes.json を作る。

使い方:
  work\\ptvenv\\Scripts\\python tools\\transcribe_audio.py 入力.mp4 [-o 出力.notes.json]

音の高さ・弾き始め・長さは採譜モデル(ByteDance piano_transcription)が出す。
右手/左手は音からは分からないので、音の高さと流れから推定する(assign_hands)。
"""
import argparse
import json
import os
import subprocess
import sys

import numpy as np

SR = 16000


def load_audio(path):
    cmd = ['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-']
    raw = subprocess.run(cmd, stdout=subprocess.PIPE, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def transcribe(audio, device='cpu'):
    from piano_transcription_inference import PianoTranscription
    ckpt = os.path.join(os.path.expanduser('~'), 'piano_transcription_inference_data',
                        'note_F1=0.9677_pedal_F1=0.9186.pth')
    tr = PianoTranscription(device=device, checkpoint_path=ckpt)
    out = tr.transcribe(audio, os.devnull if os.name != 'nt' else 'NUL')
    return out['est_note_events'], out.get('est_pedal_events', [])


HARMONICS = (12, 19, 24, 28, 31, 34, 36)  # 倍音が出やすい音程(半音)


def drop_overtones(notes, dv=5, same=0.03):
    """倍音の聞き違いを捨てる。下に倍音の音程の音が同時(same秒以内)に始まり、
    それより dv 以上弱い音。本物のオクターブ(左手の低音など)は強さが近いので残る。
    月光で測定: 適合 90.0%→99.3%、再現 99.1%→98.2%。"""
    keep = []
    for e in notes:
        ghost = False
        for f in notes:
            if (e['p'] - f['p']) in HARMONICS and abs(e['t'] - f['t']) <= same and f['v'] - e['v'] >= dv:
                ghost = True
                break
        if not ghost:
            keep.append(e)
    return keep


def assign_hands(notes, posL=45.0, posR=65.0):
    """手の推定。同時に始まる音の塊ごとに「下の何音を左手にするか」を全通り試し、
    各手の今の位置(直近の平均)からの距離＋片手で届かない幅(12半音超)の罰が小さい分け方を選ぶ。
    1音だけのときは近い方の手。月光で左右一致 98.1%(固定の境目52で96.5%)。"""
    notes = sorted(notes, key=lambda n: (n['t'], n['p']))
    groups = []
    for n in notes:
        if groups and n['t'] - groups[-1][0]['t'] <= 0.05:
            groups[-1].append(n)
        else:
            groups.append([n])

    def cost(part, pos):
        if not part:
            return 0
        ps = [x['p'] for x in part]
        return abs(sum(ps) / len(ps) - pos) + 3 * max(0, ps[-1] - ps[0] - 12)

    for g in groups:
        g.sort(key=lambda n: n['p'])
        if len(g) >= 2:
            c = min(range(len(g) + 1), key=lambda c: cost(g[:c], posL) + cost(g[c:], posR))
        else:
            c = 1 if abs(g[0]['p'] - posL) < abs(g[0]['p'] - posR) else 0
        for k, n in enumerate(g):
            n['h'] = 'L' if k < c else 'R'
        L = [n['p'] for n in g[:c]]
        R = [n['p'] for n in g[c:]]
        if L:
            posL = 0.7 * posL + 0.3 * sum(L) / len(L)
        if R:
            posR = 0.7 * posR + 0.3 * sum(R) / len(R)
    return sorted(notes, key=lambda n: (n['t'], n['p']))


def finger_release(notes, pedals=(), fingers=5, reach=12, pedal_max=1.0):
    """音の長さを「指が鍵盤を押している長さ」に直す。録音ではペダルで鳴り続ける音も
    押したままに聞こえ、コナン天国では同時に最大48鍵押しっぱなしになった。
    片手で同時に押せるのは5鍵まで(古い方から離す)、手が届く幅(12半音)より離れた音を
    弾いたら、それまでの音は離している、として切る。同じ鍵を次に弾く前にも離す。
    ペダルを踏んでいる間は音からは指を離したか分からないので、同じ手の次の音で離す
    (最後の音は pedal_max 秒まで)。コナン天国はペダル率93%。"""
    notes = sorted(notes, key=lambda n: (n['t'], n['p']))
    ped = sorted((p['on'], p['off']) for p in pedals)

    def pedal_at(t):
        return any(on <= t < off for on, off in ped)
    for hand in ('L', 'R'):
        held = []  # 押している音(始まり順)
        hs = [n for n in notes if n['h'] == hand]
        i = 0
        while i < len(hs):
            t = hs[i]['t']
            g = []
            while i < len(hs) and hs[i]['t'] - t <= 0.05:
                g.append(hs[i])
                i += 1
            held = [h for h in held if h['t'] + h['d'] > t]

            def cut(h):
                h['d'] = round(max(0.05, t - h['t'] - 0.02), 3)

            ps = [n['p'] for n in g]
            under = pedal_at(t)
            keep = []
            for h in held:
                if under or h['p'] in ps or any(abs(h['p'] - p) > reach for p in ps):
                    cut(h)
                else:
                    keep.append(h)
            while len(keep) + len(g) > fingers and keep:
                cut(keep.pop(0))
            held = keep + g
        for h in held:  # この手の最後の音
            if pedal_at(h['t'] + 0.1):
                h['d'] = min(h['d'], pedal_max)
    return notes


def to_notes(events, min_vel=0):
    out = []
    for e in events:
        if e['velocity'] < min_vel:
            continue
        t = float(e['onset_time'])
        d = max(0.05, float(e['offset_time']) - t)
        out.append({'p': int(e['midi_note']), 't': round(t, 3), 'd': round(d, 3), 'v': int(e['velocity'])})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input')
    ap.add_argument('-o', '--out')
    ap.add_argument('--min-vel', type=int, default=0, help='これより弱い音は捨てる(余分な音対策)')
    ap.add_argument('--device', default='cpu')
    ap.add_argument('--from-raw', help='前に保存した .raw.json から作り直す(採譜をやり直さない)')
    ap.add_argument('--keep-overtones', action='store_true', help='倍音らしい音を捨てない')
    ap.add_argument('--keep-lead', action='store_true', help='頭の無音を詰めない(元の動画と時刻を合わせる)')
    ap.add_argument('--end', type=float, help='この秒より後の音は捨てる(繰り返し部分を省くなど)')
    ap.add_argument('--keep-sustain', action='store_true', help='ペダルで鳴り続ける長さのまま(押している長さに直さない)')
    a = ap.parse_args()
    out = a.out or os.path.splitext(a.input)[0] + '.audio.notes.json'
    raw_path = os.path.splitext(out)[0] + '.raw.json'
    if a.from_raw:
        with open(a.from_raw, encoding='utf-8') as f:
            rd = json.load(f)
        raw, pedal_list = rd['notes'], rd.get('pedals', [])
        duration = rd.get('duration') or max(n['t'] + n['d'] for n in raw)
    else:
        audio = load_audio(a.input)
        duration = len(audio) / SR
        print(f'音声 {duration:.1f}秒 採譜中...', file=sys.stderr)
        events, pedals = transcribe(audio, a.device)
        raw = to_notes(events, 0)
        pedal_list = [dict(on=float(p['onset_time']), off=float(p['offset_time'])) for p in pedals]
        # 生の結果(強さ付き)を残す: 後で作り直せるように
        with open(raw_path, 'w', encoding='utf-8') as f:
            json.dump({'notes': raw, 'pedals': pedal_list, 'duration': duration}, f)
    if a.end:
        raw = [n for n in raw if n['t'] < a.end]
        duration = min(duration, a.end)
    sel = [dict(n) for n in raw if n['v'] >= a.min_vel]
    if not a.keep_overtones:
        sel = drop_overtones(sel)
    notes = assign_hands(sel)
    if not a.keep_sustain:
        notes = finger_release(notes, pedal_list)
    # 頭の無音(題名画面など)を詰めて、最初の音を1秒目にする。動画と合わせたいときは --keep-lead
    lead = 0.0
    if not a.keep_lead and notes:
        lead = max(0.0, round(notes[0]['t'] - 1.0, 3))
        for n in notes:
            n['t'] = round(n['t'] - lead, 3)
        duration -= lead
    for n in notes:
        n.pop('v', None)
    nl = sum(1 for n in notes if n['h'] == 'L')
    doc = {
        'app': 'piano-practice-notes', 'version': 1,
        'source': os.path.basename(a.input), 'from': 'audio',
        'duration': round(duration, 3),
        'hands': {'mode': 'guessed'},
        'lead_trimmed': lead,
        'notes': notes,
    }
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False)
    print(f'{out}: {len(notes)}音 (左{nl}/右{len(notes) - nl})', file=sys.stderr)


if __name__ == '__main__':
    main()
