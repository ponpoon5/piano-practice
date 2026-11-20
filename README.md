# ピアノ練習

落ちてくる鍵盤型のチュートリアル動画で、区間ごとに反復しながら通しで弾けるまで進める iPad 向けアプリ(PWA)。
公開先: https://ponpoon5.github.io/piano-practice/

- `app/` アプリ本体(GitHub Pages で配信)。動画・音符データ・練習記録は端末の中(IndexedDB)だけに保存
- `tools/extract_notes.py` 動画から音符を読み取る(PC・Python + OpenCV)
  `python tools/extract_notes.py <動画> -o <出力フォルダ>` → `<名前>.notes.json`(アプリの「設定」で取り込む)・確認用 `.mid`・`_calib.png`・`_roll.png`
- `tools/make_icons.py` アイコン作成
- `tests/` `npm test`(進め方のロジック)、`python tests/ui_smoke.py <URL> <動画> <出力>`(段階1の画面)、
  `python tests/ui_stage2.py <URL> <動画> <notes.json> <出力>`(段階2・偽の電子ピアノで採点/待ちモード)

電子ピアノ(USB MIDI)で採点するには、iPad では Safari ではなく「Web MIDI Browser」アプリでページを開く。
