"""Edge(画面なし)でアプリを実際に動かし、スクショを撮る。
使い方: python tests/ui_smoke.py <URL> <動画> <出力フォルダ>
"""
import sys
import time
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.edge.options import Options

url, clip, out = sys.argv[1], sys.argv[2], Path(sys.argv[3])
out.mkdir(parents=True, exist_ok=True)

opt = Options()
opt.add_argument("--headless=new")
opt.add_argument("--autoplay-policy=no-user-gesture-required")
opt.add_argument("--window-size=1180,820")
opt.add_argument("--mute-audio")
d = webdriver.Edge(options=opt)
errors = []


def js(s, *a):
    return d.execute_script(s, *a)


def shot(name):
    d.save_screenshot(str(out / f"{name}.png"))


def check(cond, msg):
    print(("OK  " if cond else "NG  ") + msg)
    if not cond:
        errors.append(msg)


try:
    d.get(url)
    time.sleep(1.5)
    js("indexedDB.deleteDatabase('piano-practice')")
    d.get(url)
    time.sleep(1.5)
    shot("01_home_empty")

    inp = d.find_element(By.ID, "fileAdd")
    inp.send_keys(str(Path(clip).resolve()))
    for _ in range(30):
        time.sleep(0.5)
        if js("return !document.getElementById('song').hidden"):
            break
    check(js("return !document.getElementById('song').hidden"), "動画を追加すると曲画面が開く")
    time.sleep(1.5)
    n = js("return document.querySelectorAll('#strip .sec').length")
    check(n == 3, f"45秒の動画が3区間に分かれる (実際 {n})")
    check(js("return document.getElementById('unitLabel').textContent") == "区間 1", "最初は区間1")
    check(js("return document.getElementById('unitSpeed').textContent").startswith("速さ 60%"), "最初の速さは60%")
    shot("02_song_practice")

    # 再生して区間の終わりで止まり、採点を聞かれる
    js("document.getElementById('video').currentTime = 13.5")
    d.find_element(By.ID, "btnPlay").click()
    time.sleep(0.3)
    js("document.getElementById('video').playbackRate = 1")
    time.sleep(3.5)
    t = js("return document.getElementById('video').currentTime")
    paused = js("return document.getElementById('video').paused")
    check(paused and 14.5 <= t <= 15.4, f"区間の終わり(15秒)で止まる (t={t:.2f}, paused={paused})")
    check("どうだった" in js("return document.getElementById('overlay').textContent"), "採点を聞かれる")
    shot("03_asking")

    # ペダル(→キー)で ◎ を3回 → 速さアップ
    body = d.find_element(By.TAG_NAME, "body")
    for i in range(3):
        body.send_keys(Keys.ARROW_RIGHT)
        time.sleep(0.2)
    time.sleep(0.3)
    check(js("return document.getElementById('unitSpeed').textContent").startswith("速さ 75%"), "◎3回で75%に上がる")
    check("速さアップ" in js("return document.getElementById('toast').textContent"), "速さアップの表示")
    shot("04_speedup")
    # 繰り返しの前の数え
    check(js("return document.querySelector('#overlay .count') !== null"), "次の繰り返しの前に数える")

    # 合格まで進める
    for i in range(9):
        body.send_keys(Keys.ARROW_RIGHT)
        time.sleep(0.15)
    time.sleep(2.2)
    cls = js("return document.querySelector('#strip .sec').className")
    check("st-cleared" in cls, f"区間1が合格の色になる ({cls})")
    check(js("return document.getElementById('unitLabel').textContent") == "区間 2", "合格すると次の区間へ")
    shot("05_cleared_next")

    # 区間2も合格 → つなぎがメニューに出る
    for i in range(12):
        body.send_keys(Keys.ARROW_RIGHT)
        time.sleep(0.15)
    time.sleep(2.2)
    menu = js("return document.getElementById('menu').textContent")
    check("つなぎ 1→2" in menu, "区間1・2の合格後につなぎが出る")
    shot("06_chain_menu")

    # 区切りタブ
    d.find_element(By.CSS_SELECTOR, "#tabs [data-tab=edit]").click()
    time.sleep(0.5)
    js("document.getElementById('video').currentTime = 37")
    time.sleep(0.6)
    d.find_element(By.ID, "btnSplit").click()
    time.sleep(0.6)
    n = js("return document.querySelectorAll('#strip .sec').length")
    check(n == 4, f"区切りを足すと4区間 (実際 {n})")
    shot("07_edit")

    # 記録タブ・設定タブ
    d.find_element(By.CSS_SELECTOR, "#tabs [data-tab=record]").click()
    time.sleep(0.5)
    shot("08_record")
    d.find_element(By.CSS_SELECTOR, "#tabs [data-tab=settings]").click()
    time.sleep(0.5)
    d.find_element(By.ID, "btnZoomIn").click()
    d.find_element(By.ID, "btnZoomIn").click()
    time.sleep(0.3)
    shot("09_settings_zoom")

    # 戻ってからもう一度開くと記録が残っている
    d.find_element(By.ID, "btnBack").click()
    time.sleep(1.0)
    shot("10_home")
    d.get(url)
    time.sleep(1.5)
    d.find_element(By.CSS_SELECTOR, ".songcard").click()
    time.sleep(1.5)
    cls = js("return document.querySelector('#strip .sec').className")
    check("st-cleared" in cls, "読み込み直しても合格が残る")
    crop = js("return document.getElementById('video').style.transform")
    check("scale(1.44" in crop, f"拡大が残る ({crop})")

    # 縦向き
    d.set_window_size(820, 1180)
    time.sleep(0.8)
    shot("11_portrait")

    logs = d.get_log("browser") if hasattr(d, "get_log") else []
    sev = [l for l in logs if l.get("level") == "SEVERE"]
    check(not sev, "コンソールにエラーなし " + str(sev[:3]))
finally:
    d.quit()

print("失敗", len(errors))
sys.exit(1 if errors else 0)
