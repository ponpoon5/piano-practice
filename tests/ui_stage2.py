"""段階2(音符データ・電子ピアノ)を Edge(画面なし)で確かめる。
電子ピアノの代わりに、偽の MIDI 入力をページに差し込む。
使い方: python tests/ui_stage2.py <URL> <動画> <notes.json> <出力フォルダ>
"""
import json
import sys
import time
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.edge.options import Options

url, clip, notes_path, out = sys.argv[1], sys.argv[2], sys.argv[3], Path(sys.argv[4])
out.mkdir(parents=True, exist_ok=True)
NOTES = json.loads(Path(notes_path).read_text(encoding="utf-8"))["notes"]

MOCK = r"""
(() => {
  const input = { name: 'P-125 (偽)', state: 'connected', onmidimessage: null };
  const sent = [];
  const output = { name: 'P-125 (偽)', state: 'connected', send: (d) => sent.push(Array.from(d)) };
  window.__midi = {
    input, sent,
    on: (p) => input.onmidimessage && input.onmidimessage({ data: [0x90, p, 90] }),
    off: (p) => input.onmidimessage && input.onmidimessage({ data: [0x80, p, 0] }),
  };
  navigator.requestMIDIAccess = async () => ({
    inputs: new Map([['i', input]]),
    outputs: new Map([['o', output]]),
    onstatechange: null,
  });
})();
"""

# 動画の時刻に合わせて、指定した手の音を弾く(miss=true なら弾かない・違う鍵を押す)
PLAYER = r"""
window.__play = (notes, hand, mode) => {
  const v = document.getElementById('video');
  let i = 0;
  const list = notes.filter((n) => hand === 'B' || n.h === hand).sort((a, b) => a.t - b.t);
  if (window.__raf) cancelAnimationFrame(window.__raf);
  const step = () => {
    const t = v.currentTime;
    while (i < list.length && list[i].t <= t + 0.02) {
      const n = list[i++];
      if (n.t < t - 0.3) continue;
      if (mode === 'good') { window.__midi.on(n.p); setTimeout(() => window.__midi.off(n.p), 120); }
      if (mode === 'wrong') { window.__midi.on(n.p + 1); setTimeout(() => window.__midi.off(n.p + 1), 120); }
    }
    window.__raf = requestAnimationFrame(step);
  };
  step();
};
"""

opt = Options()
opt.add_argument("--headless=new")
opt.add_argument("--autoplay-policy=no-user-gesture-required")
opt.add_argument("--window-size=1180,820")
opt.add_argument("--mute-audio")
d = webdriver.Edge(options=opt)
d.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": MOCK + PLAYER})
errors = []


def js(s, *a):
    return d.execute_script(s, *a)


def shot(name):
    d.save_screenshot(str(out / f"{name}.png"))


def check(cond, msg):
    print(("OK  " if cond else "NG  ") + msg, flush=True)
    if not cond:
        errors.append(msg)


def text(id_):
    return js(f"return document.getElementById('{id_}').textContent")


def run_unit(hand, mode, wait_s=32):
    js("document.getElementById('btnAgain').click()")
    time.sleep(0.05)
    js("window.__play(arguments[0], arguments[1], arguments[2])", NOTES, hand, mode)
    t0 = time.time()
    while time.time() - t0 < wait_s:
        time.sleep(0.25)
        if not js("return document.getElementById('result').hidden"):
            break
    js("if (window.__raf) cancelAnimationFrame(window.__raf)")
    return text("result")


try:
    d.get(url)
    time.sleep(1.0)
    js("indexedDB.deleteDatabase('piano-practice')")
    d.get(url)
    time.sleep(1.5)
    d.find_element(By.ID, "fileAdd").send_keys(str(Path(clip).resolve()))
    for _ in range(30):
        time.sleep(0.5)
        if js("return !document.getElementById('song').hidden"):
            break
    time.sleep(1.0)
    check(js("return document.getElementById('noteCtl').hidden"), "音符データなしでは片手などの操作は出ない")

    # 音符データを取り込む
    d.find_element(By.CSS_SELECTOR, "#tabs [data-tab=settings]").click()
    time.sleep(0.4)
    d.find_element(By.ID, "fileNotes").send_keys(str(Path(notes_path).resolve()))
    time.sleep(1.0)
    check("取り込み済み" in text("notesInfo"), "音符データを取り込める: " + text("notesInfo"))
    check(js("return document.getElementById('setHandFirst').checked"), "片手ずつ進めるが既定でオン")
    d.find_element(By.CSS_SELECTOR, "#tabs [data-tab=practice]").click()
    time.sleep(0.6)
    check(not js("return document.getElementById('noteCtl').hidden"), "練習タブに片手・待ちモードの操作が出る")
    check("につながっています" in text("midiStatus"), "偽の電子ピアノを認識: " + text("midiStatus"))
    check(js("return document.querySelector('#handSel .on').dataset.hand") == "R", "新しい区間は右手から")
    check("右手だけで" in text("unitHint"), "ヒントに右手だけ: " + text("unitHint"))
    check("右手" in text("menu"), "メニューに右手と出る")
    shot("s2_01_right_hand")

    # 速さを上げて時間短縮(目標×2 → 60%で動画×1.2)
    js("""const s=document.getElementById('setTarget'); s.value='2'; s.dispatchEvent(new Event('change'));""")
    js("document.querySelector('#menu li').click()")
    time.sleep(0.3)

    # 右手を正しく2回 → 左手へ
    r = run_unit("R", "good")
    check("正しい音" in r and "◎" in r, "右手を正しく弾くと ◎: " + r)
    m = r.split("正しい音 ")[1].split(" ")[0]
    hits, total = map(int, m.split("/"))
    check(total > 5 and hits == total, f"右手の音をすべて拾う {hits}/{total}")
    time.sleep(3.2)
    r = run_unit("R", "good")
    time.sleep(0.6)
    check(js("return document.querySelector('#handSel .on').dataset.hand") == "L", "右手 ◎2回で左手へ進む: " + r + " / " + text("unitHint"))
    shot("s2_02_left_hand")

    # 左手を外す → ×、間違いが多ければ苦手な所ができる
    time.sleep(3.0)
    r = run_unit("L", "none")
    check("×" in r, "左手を弾かないと ×: " + r)
    time.sleep(1.8)

    # 待ってくれるモード: 押さないと止まる → 押すと進む
    js("document.getElementById('result').hidden = true")
    js("const w=document.getElementById('waitMode'); w.checked=true; w.dispatchEvent(new Event('change'))")
    js("document.getElementById('btnAgain').click()")
    time.sleep(3.5)
    t1 = js("return document.getElementById('video').currentTime")
    time.sleep(1.0)
    t2 = js("return document.getElementById('video').currentTime")
    check(abs(t2 - t1) < 0.05, f"正しい鍵を押すまで止まって待つ (t={t1:.2f}→{t2:.2f})")
    check(text("btnPlay").startswith("⏸"), "待っている間も再生中の表示")
    shot("s2_03_waiting")
    # 待っている和音を押す
    js("""
      const v = document.getElementById('video'); const t = v.currentTime;
      const hand = document.querySelector('#handSel .on').dataset.hand;
      const ps = arguments[0].filter(n => (hand === 'B' || n.h === hand) && Math.abs(n.t - t) < 0.1).map(n => n.p);
      ps.forEach(p => window.__midi.on(p));
      setTimeout(() => ps.forEach(p => window.__midi.off(p)), 100);
    """, NOTES)
    t3 = t2
    for _ in range(20):
        time.sleep(0.1)
        t3 = js("return document.getElementById('video').currentTime")
        if t3 > t2 + 0.2:
            break
    check(t3 > t2 + 0.2, f"押すと進む (t={t2:.2f}→{t3:.2f})")
    js("document.getElementById('btnPlay').click()")
    js("const w=document.getElementById('waitMode'); w.checked=false; w.dispatchEvent(new Event('change'))")
    time.sleep(0.3)

    # 苦手な所: 右手の区間2を全部外して作る
    js("const a = document.querySelectorAll('#strip .sec'); a[a.length - 1].click()")  # 区切りは小節の頭で決まるので本数は曲しだい
    time.sleep(0.5)
    r = run_unit("R", "wrong")
    time.sleep(2.0)
    check("×" in r, "違う鍵ばかりだと ×: " + r)
    check("苦手な所" in text("menu"), "間違いが集まった所が「苦手な所」としてメニューに入る")
    shot("s2_04_spot")

    # 音符で表示・iPad の音
    js("const w=document.getElementById('viewNotes'); w.checked=true; w.dispatchEvent(new Event('change'))")
    js("const s=document.getElementById('soundSel'); s.value='synth'; s.dispatchEvent(new Event('change'))")
    check(js("return document.getElementById('video').muted"), "iPadの音にすると動画は消音")
    js("document.getElementById('btnListen').click()")
    time.sleep(2.0)
    shot("s2_05_roll")
    check(not js("return document.getElementById('roll').hidden"), "音符で表示")
    js("const s=document.getElementById('soundSel'); s.value='midi'; s.dispatchEvent(new Event('change'))")
    js("document.getElementById('btnListen').click()")
    time.sleep(2.0)
    n_sent = js("return window.__midi.sent.filter(m => (m[0] & 0xf0) === 0x90).length")
    check(n_sent > 0, f"お手本の音をピアノに送る ({n_sent} 音)")
    js("document.getElementById('btnPlay').click()")

    logs = d.get_log("browser")
    sev = [l for l in logs if l.get("level") == "SEVERE"]
    check(not sev, "コンソールにエラーなし " + str(sev[:3]))
finally:
    d.quit()

print("失敗", len(errors))
sys.exit(1 if errors else 0)
