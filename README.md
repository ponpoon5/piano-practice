# ピアノ練習

落ちてくる鍵盤型のチュートリアル動画で、区間ごとに反復しながら通しで弾けるまで進める iPad 向けアプリ(PWA)。

- `app/` アプリ本体(GitHub Pages で配信)。動画と練習記録は端末の中(IndexedDB)だけに保存
- `tools/` PC 側の補助(アイコン作成、動画からの音符読み取り)
- `tests/` `npm test`(進め方のロジック)、`python tests/ui_smoke.py <URL> <動画> <出力>`(画面の動作確認)
