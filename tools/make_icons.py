"""アプリのアイコン(鍵盤＋落ちてくる音符)を作る。"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "app"


def icon(size: int) -> Image.Image:
    s = 512
    im = Image.new("RGB", (s, s), (22, 24, 29))
    d = ImageDraw.Draw(im)
    top = 300
    n = 7
    w = s / n
    for i in range(n):
        d.rectangle([i * w + 4, top, (i + 1) * w - 4, s - 30], fill=(238, 240, 243))
    for i in (0, 1, 3, 4, 5):
        x = (i + 1) * w
        d.rectangle([x - w * 0.3, top, x + w * 0.3, top + 120], fill=(22, 24, 29))
    d.rounded_rectangle([1.15 * w, 70, 1.85 * w, top - 14], radius=14, fill=(91, 155, 213))
    d.rounded_rectangle([4.15 * w, 140, 4.85 * w, top - 14], radius=14, fill=(108, 192, 74))
    d.rounded_rectangle([5.15 * w, 40, 5.85 * w, 120], radius=14, fill=(108, 192, 74))
    return im.resize((size, size), Image.LANCZOS)


for sz in (180, 192, 512):
    icon(sz).save(OUT / f"icon-{sz}.png")
print("ok")
