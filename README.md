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

## 音声から音符データを作る(鍵盤の動画がないとき)

演奏動画や録音の音だけから `.notes.json` を作る(採譜モデル ByteDance piano_transcription)。

準備(1回だけ): `python -m venv --system-site-packages work\ptvenv` → `work\ptvenv\Scripts\python -m pip install piano_transcription_inference`、
モデル(約170MB)を `%USERPROFILE%\piano_transcription_inference_data\note_F1=0.9677_pedal_F1=0.9186.pth` に置く。

    work\ptvenv\Scripts\python tools\transcribe_audio.py 演奏.mp4 -o 演奏.notes.json

CPUで曲の長さの約1.7倍かかる。倍音の聞き違いを捨て、左右の手は音の高さと流れから推定する。
音の長さは「指で押している長さ」に直す(片手5鍵まで・1オクターブより離れたら離す・ペダル中は同じ手の次の音で離す)。鳴っている長さのままにするなら `--keep-sustain`。
月光第1楽章(動画から読んだ正解1146音)との突き合わせ: 拾えた 98.2%・余分でない 99.3%・左右一致 98.0%
(`python tools\compare_notes.py 正解.notes.json 推定.notes.json`)。
