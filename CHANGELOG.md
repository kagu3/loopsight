# 変更履歴

このファイルには、版ごとの主な変更を書く。版の番号は [セマンティック バージョニング](https://semver.org/lang/ja/) に従う。

## 0.1.0（まだ公開していない）

最初の版。AI が使う MCP サーバー（`loopsight`）と、人が図とグラフで見て手直しするビューア（`loopsight-viewer`）からなる。モデルは Insight Maker の ModelJSON 形式で保存し、シミュレーションには Insight Maker 公式のエンジン `simulation` を使う。

### MCP サーバー

- モデルを作る・取り込む：`create_model`、`import_model`（ModelJSON ファイル）
- モデルを読む：`get_model`。モデルの要約（要素、式、つながり）か、ModelJSON 全体を返す
- 要素を足す・直す・消す：`upsert_elements`、`remove_elements`。足りないリンクは自動で足す。編集した後に検証結果を返す
- 検証する：`validate_model`。エラーと警告を、直し方のヒントつきで返す
- 実行する：`run_simulation`。要約を返し、CSV にも保存できる。`overrides` で値を一時的に変えて実行できる（感度分析に使う）
- シナリオを保存して比べる：`set_scenarios` で保存し、`run_simulation` の `scenarios: true` で「元のモデル」と並べて返す
- シミュレーションの設定を変える：`set_simulation`（開始時刻、期間、刻み幅、解法、時間の単位）
- 実際のデータを取り込む：`import_data`（`<モデル名>.data.csv`）。ビューアのグラフで、要素の線に点で重ねる
- フィードバックループを探す：`find_loops`。リンクの極性から、強めるループ（R）か釣り合わせるループ（B）かを返す
- 図の配置を整える：`layout_model` で座標を付け、`view_diagram` で図の画像と、箱の重なりや線の交差などの一覧を返す。`loop` でループを目立たせた図にできる
- 図を書き出す：`export_diagram`。図だけを、資料に貼る SVG と PNG にする
- 図に情報を足す：`set_groups`（意味のまとまりを色の背景で囲む）、`set_annotations`（文字だけの注釈）、`upsert_elements` の `display.emphasis`（大事な要素を強調）と `display.delay`（遅れのあるリンクに ‖ の印）
- モデルをフォルダに分けて置く：`list_models`、`move_model`、`remove_model`、`create_folder`、`move_folder`、`remove_folder`

### ビューア

- 作業フォルダのモデルを、フォルダごとの一覧、図、グラフと表で見る。AI がモデルを変えると、画面がその場で変わる
- 選んだ要素の名前、式、初期値、単位などを直す。「図を編集」をオンにすると、要素を動かす・足す・つなぐ・消すことができる
- リンクの極性（+ / −）を付ける
- フィードバックループの一覧を出し、選んだループを図で目立たせる
- シナリオを足す・直す・消し、グラフで「元のモデル」と重ねて比べる
- シミュレーションの設定（開始、期間、刻み幅、解法、時間の単位）を直す
- 図だけを SVG と PNG に書き出す
- 画面で変えたことを「元に戻す」（Ctrl+Z）で戻す。画面より先に AI がモデルを変えていたら、黙って上書きせずに知らせる

### デモサイト

- `examples/` の sample を、入れずにブラウザで触れるデモサイトを足す（https://kagu3.github.io/loopsight/）。値や式を変える、シナリオを足す・直す、ループを見る、元に戻す、ができる。変更は保存されない（読み直すと元に戻る）。図の書き出しなど、作業フォルダを使う機能はない

### sample のモデル

- システム思考を学ぶための sample のモデルを `examples/` に置く（[examples/README.md](examples/README.md)）。sample の決まりを守っているかをテストで確かめる

### 必要なもの

- Node.js 22 以上
- 図の画像（`view_diagram`、`export_diagram`）には Edge か Chrome が要る

### できないこと

- 状態（STATE）と遷移（TRANSITION）は扱わない。含むモデルは、読み込むときにエラーになる
