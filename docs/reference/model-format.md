# モデルのファイルの形式

loopsight は、モデルを作業フォルダの中に、Insight Maker の ModelJSON 形式のファイルとして保存する。MCP サーバーとビューアは同じファイルを読み書きする。この文書には、ファイルの形と、作業フォルダの中身、起動のしかた（起動引数と環境変数）を書く。

## 目次

- [ModelJSON](#modeljson)
- [使う公式の項目](#使う公式の項目)
- [loopsight が足した項目](#loopsight-が足した項目)
- [作業フォルダ](#作業フォルダ)
- [起動引数と環境変数](#起動引数と環境変数)

## ModelJSON

ModelJSON は、Insight Maker のモデルを JSON で書く形式。公式の仕様は [scottfr/modeljson](https://github.com/scottfr/modeljson) にある。シミュレーションには、Insight Maker 公式のエンジン [`simulation`](https://github.com/scottfr/simulation) の `loadModelJSON` を使う。

- 扱うのはシステムダイナミクスのモデルだけ。要素の種類はストック（`STOCK`）、フロー（`FLOW`）、変数（`VARIABLE`）、コンバーター（`CONVERTER`）、リンク（`LINK`）の 5 つ。状態（`STATE`）と遷移（`TRANSITION`）を含むファイルは読み込まない
- ファイルは UTF-8 の JSON。字下げは空白 2 つで、終わりに改行を付ける
- 読み込めるファイルの条件は、`elements` が並び（配列）であること。ほかの項目は、なくても読み込める
- 知らない項目があっても消さずに残す。ただし、エンジンは知らない項目をエラーにするので、loopsight が足した項目（下の表）以外の知らない項目があると、実行と検証はエラーになる。名前が `_` で始まる項目は、エンジンが無視するのでエラーにならない

## 使う公式の項目

ModelJSON の公式の項目のうち、loopsight が読み書きするもの。場所は、最上位の項目を `name`、並びの 1 件ごとの項目を `elements[].name`、中の項目を `simulation.time_start` のように書く。

| 場所 | loopsight での扱い |
|---|---|
| `engine` | 新しいモデルに `SIMULATION_PACKAGE` を入れる |
| `name` | モデルの題名。一覧に出す |
| `description` | モデルの説明 |
| `file_notes` | 使わない。あればそのまま残す |
| `simulation.algorithm` | 計算のしかた（`RK1` か `RK4`）。新しいモデルは `RK1` |
| `simulation.time_start` | 開始の時刻。新しいモデルは 0 |
| `simulation.time_length` | 期間。新しいモデルは 100 |
| `simulation.time_step` | 刻み幅。新しいモデルは 1 |
| `simulation.time_units` | 時間の単位（`SECONDS`〜`YEARS`）。新しいモデルは `YEARS` |
| `elements[].type` | 要素の種類 |
| `elements[].name` | 要素の名前。大文字と小文字を区別しない。式では `[名前]` で参照する |
| `elements[].description` | 要素の説明 |
| `elements[].from` | フローとリンクの元。フローでは、外から入るとき `null` |
| `elements[].to` | フローとリンクの先。フローでは、外へ出るとき `null` |
| `elements[].behavior.initial_value` | ストックの初めの値（式） |
| `elements[].behavior.value` | 変数とフローの式 |
| `elements[].behavior.non_negative` | ストックとフローを負にしない |
| `elements[].behavior.units` | 単位 |
| `elements[].behavior.input` | コンバーターの入力（`TIME` か `ELEMENT`） |
| `elements[].behavior.input_element` | コンバーターの入力にする要素の名前 |
| `elements[].behavior.interpolation` | コンバーターの補間（`NONE` か `LINEAR`） |
| `elements[].behavior.data` | コンバーターの表（`[入力, 出力]` の並び） |
| `elements[].behavior.polarity` | リンクの極性。`POSITIVE` が +、`NEGATIVE` が −。`NEUTRAL` か項目なしは「決めていない」。フィードバックループの R と B を決めるのに使う |
| `elements[].display.coordinates` | ストック、変数、コンバーターの位置 `[x, y]` |
| `elements[].display.size` | ストック、変数、コンバーターの大きさ `[幅, 高さ]` |
| `elements[].display.from_coordinates` | フローとリンクの、元がないときの端の位置 |
| `elements[].display.to_coordinates` | フローとリンクの、先がないときの端の位置 |
| `elements[].display.interactive` | Insight Maker でスライダーを出す。loopsight は `get_model` の要約に出すだけ |
| `elements[].display.interactive_min` | スライダーのいちばん小さい値 |
| `elements[].display.interactive_max` | スライダーのいちばん大きい値 |
| `elements[].display.symbol` | 使わない。あればそのまま残す |
| `visualizations[].type` | グラフの種類（`TIME_SERIES` か `TABLE`） |
| `visualizations[].name` | グラフの名前 |
| `visualizations[].elements` | グラフに出す要素の名前。ビューアは 1 つ目のグラフの要素を最初に出す |
| `scenarios[].name` | 比べるシナリオの名前 |
| `scenarios[].description` | シナリオの説明 |
| `scenarios[].values` | シナリオで変える値（要素の名前 → 値か式）。ビューアのグラフで、何も変えない実行（名前は `baseline.name`）と重ねて出す |
| `engine_settings.units` | 使わない。あればそのまま残し、エンジンに渡す |
| `engine_settings.globals` | 使わない。あればそのまま残し、エンジンに渡す |

`scenarios` とリンクの `polarity` は公式の項目なので、Insight Maker でもそのまま読める。要素の名前を変えたり消したりすると、`visualizations` と `scenarios` の中の名前も直す。

## loopsight が足した項目

ModelJSON に決まった書き方がない情報は、loopsight 独自の項目として同じファイルに保存する。どれも図や結果の見せ方のためのもので、シミュレーションの結果は変わらない。

| 場所 | 形 | 意味 | シミュレーション | エンジンの `loadModelJSON`（Web 版は未確認） |
|---|---|---|---|---|
| `groups` | 並び | 図のグループ。属する要素を薄い色の長方形で囲み、凡例に出す | 使わない | エラー |
| `groups[].name` | 文字 | グループの名前。大文字と小文字を区別せず、重ねない | 使わない | エラー |
| `groups[].color` | 文字 | 囲みの色。`yellow`、`green`、`teal`、`purple`、`pink`、`brown`、`gray` のどれか | 使わない | エラー |
| `groups[].elements` | 文字の並び | 属する要素の名前。リンクは入れない。1 つの要素が属するグループは 1 つまで | 使わない | エラー |
| `loops` | 並び | ループの名前。説明に使うループに付ける。名前の付いたループは、`find_loops` の結果とビューアの一覧で先に並ぶ（付けた順） | 使わない | エラー |
| `loops[].name` | 文字 | ループの名前（「口コミ」など）。大文字と小文字を区別せず、重ねない | 使わない | エラー |
| `loops[].elements` | 文字の並び | ループが通る要素の名前を、つながる順に（`find_loops` の `elements`）。どこから回り始めても同じループとみなす。R / B は持たず、いつもリンクの極性から求める。モデルが変わってループでなくなっても消さずに残し、`validate_model` の警告で知らせる | 使わない | エラー |
| `annotations` | 並び | 図の注釈。どこにもつながらない、文字だけのもの。要素ではないので `elements` に入れない | 使わない | エラー |
| `annotations[].id` | 文字 | 注釈を見分ける名前。直す・消すときに使う | 使わない | エラー |
| `annotations[].text` | 文字 | 注釈の文字。改行で行を分ける | 使わない | エラー |
| `annotations[].coordinates` | `[x, y]` | 注釈の左上の位置 | 使わない | エラー |
| `annotations[].width` | 数 | 折り返す幅（60〜800）。なければ 200 | 使わない | エラー |
| `baseline` | オブジェクト | 何も変えない実行（シナリオと並べて比べる基準）の名前と説明。何を表す線かはモデルごとに違うので、ここに書く | 使わない | エラー |
| `baseline.name` | 文字 | 何も変えない実行の名前。グラフの凡例、シナリオの表の列の見出し、図の「値を表示」などに出す。なければ「いまのまま」。シナリオと同じ名前にはできない（大文字と小文字を区別しない） | 使わない | エラー |
| `baseline.description` | 文字 | 何も変えない実行の説明。凡例の名前にカーソルを乗せると出る | 使わない | エラー |
| `elements[].display.emphasis` | `true` | 図で強調して大きく描く。付けられるのはストック、変数、コンバーター。強調しないときは項目を消す | 使わない | エラー |
| `elements[].display.delay` | `true` | 遅れの印（‖）を線の途中に描く。付けられるのはリンクとフロー。外すときは項目を消す。実際の遅れは式（`Delay` や `Smooth` など）で表す | 使わない | エラー |

- **シミュレーション：** 実行と検証の前に、これらの項目を取り除いてからエンジンに渡す（`src/core/modeljson.ts` の `engineModel`）
- **Insight Maker：** エンジンの `loadModelJSON` は、知らない項目があるとエラーにする（`Invalid property "groups" found in the model` など）。確かめたのはエンジンだけ。Insight Maker の Web 版の「Import ModelJSON」で同じようにエラーになるか、黙って消すかは、人が確かめる必要がある。エラーになるなら、これらの項目を含むファイルは、そのままでは Insight Maker に読み込ませられないので、項目を消してから渡す
- **書き換えたとき：** 形の合わないもの（id や座標のない注釈、名前のないグループ、要素のないループの名前など）は、図や一覧に出さずに飛ばす。`validate_model` が知らせるものもある

項目を足したら、この表にも書く。書き忘れると `npm test` が落ち、足りない項目を知らせる（`tests/docs-model-format.test.ts`。一覧は `src/core/modeljson.ts` の `LOOPSIGHT_FIELDS`）。

## 作業フォルダ

モデルは作業フォルダに保存する。人がファイルを直接開いて確かめられる。

### 場所

作業フォルダは次の順で決まる。

1. 起動引数 `--models-dir <フォルダ>`
2. 環境変数 `LOOPSIGHT_MODELS_DIR`
3. どちらもなければ、起動したフォルダの `models/`

### 中身

| もの | 内容 |
|---|---|
| `<モデル名>.json` | モデル（ModelJSON） |
| `<モデル名>.data.csv` | `import_data` で取り込んだ実際のデータ。モデルと同じフォルダに置く。モデルの一覧には出さない |
| `exports/` | `export_diagram`（とビューアの図の「書き出す」ボタン）で書き出した図の画像。既定は `exports/<モデル名>/diagram.svg` と `diagram.png` |
| `output/` | `run_simulation` の `csv: true` で保存した結果の CSV。既定は `output/<モデル名>-<年月日>-<時分秒>.csv` |

- 保存は、一時ファイル（`<ファイル名>.<番号>.<時刻>.tmp`）に書いてから置き換える。途中で止まっても、壊れたファイルを残さない
- 以前のスライドの機能のファイル（`<モデル名>.slides.json`）が残っていても、モデルとしては扱わない。`.slides` で終わる名前はモデル名に使えない
- OS が作るファイル（`.DS_Store`、`Thumbs.db`、`desktop.ini`）は数えない。空のフォルダを消すときは、いっしょに消す

### 実際のデータ（.data.csv）

- 1 行目は見出し。1 列目が時刻、ほかの列が要素の名前。1 列目の見出しの文字は何でもよい
- 2 行目からが値。空欄は「値がない」として扱う。桁区切り（`1,234`）も読む
- 文字コードは UTF-8。保存するときは、Excel でも日本語が化けないように BOM を付ける。読むときは BOM があってもなくてもよい
- 区切りはカンマ。1 行目にタブがあってカンマがなければ、タブ区切りとして読む（Excel から貼ったもの）
- 要素の名前を変えると、列の見出しも直す。モデルを動かしたり消したりすると、データもいっしょに動く・消える

`output/` の CSV も、1 列目が時刻（見出しは `Time`）、ほかの列が要素の名前で、BOM 付きの UTF-8 にする。

### フォルダに分けて置く

関係のあるモデルは、作業フォルダの中のフォルダにまとめて置ける（フォルダの中のフォルダも、何段でも）。ビューアの一覧は、作業フォルダの中の実際のフォルダと同じ形で出る。

```
models/
  coffee-cooling.json              … モデル名は coffee-cooling
  ブルックスの法則/
    brooks_law.json                … モデル名は ブルックスの法則/brooks_law
    brooks_law.data.csv            … 実際のデータは、モデルと同じフォルダに置く
    brooks_law_detailed.json
```

### モデル名の決まり

- モデル名は、作業フォルダからの相対パス（`/` 区切り、`.json` なし）。MCP の各ツール、ビューアのアドレス（`#ブルックスの法則/brooks_law`）、ビューアの API（`/api/models/:name`）でこの名前を使う。どの OS でも区切りは `/` にする
- 作業フォルダの外を指す名前（`..`、絶対パス、`\` 区切り）は使えない
- フォルダ名とファイル名には、`\ : * ? " < > |` と制御文字を使えない。先頭の `.`、終わりの `.`、前後の空白も使えない（Windows では終わりの `.` が落ち、別の名前と同じものを指すため）
- フォルダ名とファイル名は 1 つ 100 文字まで、フォルダを含めた名前全体は 255 文字まで
- 名前の終わりの `.json` は付けても付けなくてもよい（付けたものは外す）
- ビューアの一覧に出るのは、モデルと、モデルがあるフォルダと、空のフォルダ。モデル以外のファイル（`.data.csv` など）、モデルでないファイルだけがあるフォルダ（`output/` など）、先頭が `.` のフォルダは出さない

## 起動引数と環境変数

MCP サーバー（`loopsight`）とビューア（`loopsight-viewer`）を起動するときに指定できるもの。起動引数が環境変数より先に効く。起動引数は、`npx -y loopsight --models-dir ~/loopsight-models` のようにコマンドのあとに書く（入れ方は [はじめての手順](../getting-started.md)）。

| 名前 | 種類 | 使うもの | 意味 | 既定 |
|---|---|---|---|---|
| `--models-dir` | 起動引数 | MCP サーバー、ビューア | 作業フォルダ（`--models-dir <フォルダ>`） | 環境変数 `LOOPSIGHT_MODELS_DIR`、なければ `models/` |
| `--port` | 起動引数 | ビューア | ビューアのポート（`--port <番号>`） | 環境変数 `LOOPSIGHT_VIEWER_PORT`、なければ 5180 |
| `LOOPSIGHT_MODELS_DIR` | 環境変数 | MCP サーバー、ビューア | 作業フォルダ | 起動したフォルダの `models/` |
| `LOOPSIGHT_VIEWER_PORT` | 環境変数 | ビューア | ビューアのポート | 5180 |
| `BROWSER_PATH` | 環境変数 | MCP サーバー、画像を撮るスクリプト | 図を画像にするとき（`view_diagram`、`export_diagram`、`npm run screenshots`）に使う Edge か Chrome の場所 | 決まった場所から Edge か Chrome を探す |

clone して `npm run viewer` で起動するときは、`npm run viewer -- --port 5181` のように `--` のあとに書く（[開発に参加する](../../CONTRIBUTING.md)）。

起動引数や環境変数を足したら、この表にも書く。書き忘れると `npm test` が落ちる（一覧は `src/core/options.ts`）。
