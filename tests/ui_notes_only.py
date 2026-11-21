"""動画なし(音符データだけ)の曲を Edge(画面なし)で確かめる。偽の電子ピアノを差し込む。
使い方: python tests/ui_notes_only.py <URL> <notes.json> <出力フォルダ>
"""
import json
import sys
import time
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.edge.options import Options

url, notes_path, out = sys.argv[1], sys.argv[2], Path(sys.argv[3])
out.mkdir(parents=True, exist_ok=True)
NOTES = json.loads(Path(notes_path).read_text(encoding="utf-8"))["notes"]

MOCK = r"""
(() => {
  const input = { name: 'P-125 (偽)', state: 'connected', onmidimessage: null };
  const sent = [];
  const output = { name: 'P-125 (偽)', state: 'connected', send: (d) => sent.push(Array.from(d)) };
  window.__midi = { input, sent,
    on: (p) => input.onmidimessage && input.onmidimessage({ data: [0x90, p, 90] }),
    off: (p) => input.onmidimessage && input.onmidimessage({ data: [0x80, p, 0] }) };
  navigator.requestMIDIAccess = async () => ({ inputs: new Map([['i', input]]), outputs: new Map([['o', output]]), onstatechange: null });
  window.__play = (notes, hand) => {
    let i = 0;
    const list = notes.filter((n) => hand === 'B' || n.h === hand).sort((a, b) => a.t - b.t);
    if (window.__raf) cancelAnimationFrame(window.__raf);
    const step = () => {
      const t = __pp.media.currentTime;
      while (i < list.length && list[i].t <= t + 0.02) {
        const n = list[i++];
        if (n.t < t - 0.3) continue;
        window.__midi.on(n.p); setTimeout(() => window.__midi.off(n.p), 100);
      }
      window.__raf = requestAnimationFrame(step);
    };
    step();
  };
})();
"""

opt = Options()
opt.add_argument("--headless=new")
opt.add_argument("--window-size=1180,820")
opt.add_argument("--mute-audio")
d = webdriver.Edge(options=opt)
d.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": MOCK})
errors = []


def js(s, *a):
    return d.execute_script(s, *a)


def check(cond, msg):
    print(("OK  " if cond else "NG  ") + msg, flush=True)
    if not cond:
        errors.append(msg)


def text(i):
    return js(f"return document.getElementById('{i}').textContent")


try:
    d.get(url)
    time.sleep(1.0)
    js("indexedDB.deleteDatabase('piano-practice')")
    d.get(url)
    time.sleep(1.5)
    d.find_element(By.ID, "fileAddNotes").send_keys(str(Path(notes_path).resolve()))
    for _ in range(20):
        time.sleep(0.3)
        if js("return !document.getElementById('song').hidden"):
            break
    time.sleep(0.8)
    check(js("return !document.getElementById('song').hidden"), "音符データだけで曲が開く: " + text("songTitle"))
    check(not js("return document.getElementById('roll').hidden"), "落ちてくる音符を表示")
    check(js("return document.getElementById('video').style.visibility") == "hidden", "動画の場所は隠す")
    check(js("return document.getElementById('soundSel').value") == "midi", "音は最初からピアノ")
    check(js("return document.getElementById('viewNotes').closest('label').hidden"), "「音符で表示」の切り替えは出さない")
    n = js("return document.querySelectorAll('#strip .sec').length")
    check(n >= 2, f"区間に分かれる ({n})")
    # 区切りは左手の低音が始まる所(小節の頭)のすぐ前
    starts = js("return __pp.song.sections.slice(1).map(s => s.start)")
    bass = [x["t"] for x in NOTES if x["h"] == "L"]
    check(all(any(0 <= b - s < 0.12 for b in bass) for s in starts), f"区切りが小節の頭 {starts}")
    d.save_screenshot(str(out / "n1_open.png"))

    # 時計が進む
    js("document.getElementById('btnListen').click()")
    time.sleep(1.5)
    t = js("return __pp.media.currentTime")
    check(0.8 < t < 2.5, f"お手本で時間が進む (t={t:.2f})")
    sent = js("return window.__midi.sent.filter(m => (m[0] & 0xf0) === 0x90).length")
    check(sent > 0, f"お手本の音をピアノで鳴らす ({sent} 音)")
    d.save_screenshot(str(out / "n2_listen.png"))
    js("document.getElementById('btnPlay').click()")
    time.sleep(0.3)

    # 右手を正しく弾いて採点(速さを上げて短縮)
    js("const s=document.getElementById('setTarget'); s.value='2'; s.dispatchEvent(new Event('change'))")
    js("document.querySelector('#menu li').click()")
    time.sleep(0.3)
    js("document.getElementById('btnAgain').click()")
    time.sleep(0.05)
    js("window.__play(arguments[0], 'R')", NOTES)
    for _ in range(160):
        time.sleep(0.25)
        if not js("return document.getElementById('result').hidden"):
            break
    r = text("result")
    check("◎" in r, "動画なしでも採点できる: " + r)

    # 待ってくれるモード
    time.sleep(2.5)
    js("const w=document.getElementById('waitMode'); w.checked=true; w.dispatchEvent(new Event('change'))")
    js("document.getElementById('btnAgain').click()")
    time.sleep(1.5)
    t1 = js("return __pp.media.currentTime")
    time.sleep(0.8)
    t2 = js("return __pp.media.currentTime")
    check(abs(t2 - t1) < 0.02, f"押すまで止まる ({t1:.2f}→{t2:.2f})")
    js("""const t = __pp.media.currentTime;
      arguments[0].filter(n => n.h === 'R' && Math.abs(n.t - t) < 0.1).forEach(n => window.__midi.on(n.p));""", NOTES)
    time.sleep(0.6)
    t3 = js("return __pp.media.currentTime")
    check(t3 > t2 + 0.05 and js("return __pp.P.wait.i") >= 1, f"押すと次の和音まで進む ({t2:.2f}→{t3:.2f})")
    js("document.getElementById('btnPlay').click()")

    # 区切りの編集でも音符が鳴る
    d.find_element(By.CSS_SELECTOR, "#tabs [data-tab=edit]").click()
    time.sleep(0.3)
    before = js("return window.__midi.sent.length")
    js("__pp.media.currentTime = 6")
    d.find_element(By.ID, "btnEditPlay").click()
    time.sleep(1.5)
    d.find_element(By.ID, "btnEditPlay").click()
    check(js("return window.__midi.sent.length") > before, "区切りの編集で流すと音が鳴る")
    d.find_element(By.ID, "btnSplit").click()
    time.sleep(0.3)
    check(js("return document.querySelectorAll('#strip .sec').length") == n + 1, "区切りを足せる")
    d.save_screenshot(str(out / "n3_edit.png"))

    # 戻ってもう一度開ける・一覧に「音符のみ」
    d.find_element(By.ID, "btnBack").click()
    time.sleep(0.8)
    check("音符のみ" in js("return document.querySelector('.songcard').textContent"), "一覧に「音符のみ」と出る")
    d.find_element(By.CSS_SELECTOR, ".songcard").click()
    time.sleep(1.0)
    check(not js("return document.getElementById('roll').hidden"), "開き直しても音符表示")

    # Web MIDI Browser のように標準の確認窓が出ない(すぐ「いいえ」)場合でも、区切り直し・削除ができる
    js("window.confirm = () => false; window.alert = () => {};")
    d.find_element(By.CSS_SELECTOR, "#tabs [data-tab=edit]").click()
    time.sleep(0.3)
    js("document.querySelector('[data-tab=edit] details.more').open = true")
    js("const s=document.getElementById('resplitLen'); s.value='30'; s.dispatchEvent(new Event('change'))")
    before_n = js("return __pp.song.sections.length")
    d.find_element(By.ID, "btnResplit").click()
    time.sleep(0.3)
    check(not js("return document.getElementById('dlg').hidden"), "区切り直しの確認をアプリ内で出す")
    d.find_element(By.ID, "dlgYes").click()
    time.sleep(0.5)
    after_n = js("return __pp.song.sections.length")
    check(after_n != before_n, f"区切り直せる ({before_n}→{after_n} 区間)")
    d.find_element(By.CSS_SELECTOR, "#tabs [data-tab=settings]").click()
    time.sleep(0.3)
    d.find_element(By.ID, "btnDeleteSong").click()
    time.sleep(0.3)
    d.find_element(By.ID, "dlgYes").click()
    time.sleep(1.0)
    check(not js("return document.getElementById('home').hidden") and js("return document.querySelectorAll('.songcard').length") == 0, "曲を削除できる")
    check(js("return document.getElementById('errbar').hidden"), "エラー表示なし")

    sev = [l for l in d.get_log("browser") if l.get("level") == "SEVERE"]
    check(not sev, "コンソールにエラーなし " + str(sev[:3]))
finally:
    d.quit()
print("失敗", len(errors))
sys.exit(1 if errors else 0)
