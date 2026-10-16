# sd-modeler

AI アシスタントと一緒にシステムダイナミクス（SD）のモデルを作り、動かし、確かめるための道具。AI が使う MCP サーバーと、人が図とグラフで見て手直しするビューア（Web 画面）からなる。

モデルは [Insight Maker](https://insightmaker.com/) の ModelJSON 形式で保存するので、Insight Maker の Web 版ともファイルでやりとりできる。（以前の名前は insight-maker-mcp）

- Claude Code などから、言葉でモデルを作り、実行し、パラメータを振って比較できる
- Insight Maker の Web 版で作ったモデル（`.InsightMaker` / ModelJSON）を取り込んで分析できる
- 作ったモデルを、Web 版に読み込める ModelJSON として書き出せる
- ビューア（Web 画面）で図とグラフを見て、式の値や配置を手直しできる。AI がモデルを変えると、画面がその場で変わる

シミュレーションには Insight Maker 公式のエンジン [`simulation`](https://github.com/scottfr/simulation) を使う。insightmaker.com には自動でアクセスしない（利用規約で禁止されているため）。Web 版とのやりとりは、人がファイルを読み込んだり書き出したりして行う。

## 必要なもの

- Node.js 20 以上

## セットアップ

```bash
git clone https://github.com/suda0033/sd-modeler.git
cd sd-modeler
npm install
npm run build
```

## Claude Code に登録する

### このリポジトリの中で使う

リポジトリのルートに [.mcp.json](.mcp.json) があるので、登録の作業はいらない。ビルドしてから、このリポジトリで Claude Code のセッションを始める。最初に、プロジェクトの MCP サーバーを使ってよいか聞かれるので許可する。モデルはリポジトリの `models/` に保存される（git の管理外）。

### ほかのプロジェクトから使う

`claude mcp add` で登録する。パスは自分の環境に合わせて絶対パスで書く。

```bash
claude mcp add --scope user sd-modeler -- node /absolute/path/to/sd-modeler/dist/mcp/index.js --models-dir /absolute/path/to/models
```

そのプロジェクトの `.mcp.json` に書いてもよい。作業フォルダは環境変数 `SD_MODELER_MODELS_DIR` でも指定できる。

```json
{
  "mcpServers": {
    "sd-modeler": {
      "command": "node",
      "args": ["/absolute/path/to/sd-modeler/dist/mcp/index.js"],
      "env": { "SD_MODELER_MODELS_DIR": "/absolute/path/to/models" }
    }
  }
}
```

### 作業フォルダ

モデルは作業フォルダに `<モデル名>.json`（ModelJSON）として保存する。人がファイルを直接開いて確かめられる。場所は次の順で決まる。

1. 起動引数 `--models-dir <フォルダ>`
2. 環境変数 `SD_MODELER_MODELS_DIR`
3. どちらもなければ、起動したフォルダの `models/`

以前の名前のころの環境変数 `INSIGHT_MAKER_MODELS_DIR` と `INSIGHT_MAKER_VIEWER_PORT` も、そのまま使える。

作業フォルダの中には、ほかに次のものが作られる。

- `exports/`：`export_model` で書き出した Web 版向けのファイル
- `output/`：`run_simulation` で保存した CSV
- `<モデル名>.data.csv`：`import_data` で取り込んだ実際のデータ（1 列目が時刻、ほかの列が要素名）。モデルの一覧には出さない。要素の名前を変えると、列名も直す

## ツール

| ツール | 内容 |
|---|---|
| `list_models` | 作業フォルダのモデル一覧 |
| `create_model` | 空のモデルを作る（名前、シミュレーション設定） |
| `import_model` | `.InsightMaker` または ModelJSON ファイルを取り込む |
| `export_model` | Web 版に読み込める ModelJSON を書き出す。座標のない要素には座標を付け、大きさのない箱にはビューアと同じ大きさを入れる |
| `layout_model` | 座標のない要素に座標を付けて保存する。`reset: true` ですべて並べ直す |
| `view_diagram` | 図を PNG の画像にし、箱の重なり、線が要素や名前の上を通るところ、線の交差、1 か所に集まる線、各要素の位置を返す。AI が図を見ながら配置を直すのに使う（画像には Edge か Chrome が必要） |
| `get_model` | モデルの要約（要素、式、つながり）、または ModelJSON 全体を返す |
| `upsert_elements` | 要素をまとめて追加・更新する。名前変更にも使える。足りないリンクは自動で足す |
| `remove_elements` | 要素を削除する。つながっているリンクを消し、フローの端は空（モデルの外）にする |
| `set_simulation` | 開始時刻、期間、刻み幅、解法、時間の単位を設定する |
| `set_scenarios` | 施策（シナリオ：名前、説明、変える値の組）をモデルに保存する。何も変えない実行を「何もしない場合」として、各施策と比べた結果を返す。ビューアのグラフにも重ねて出る |
| `validate_model` | エラーと警告を、直し方のヒントつきで返す |
| `run_simulation` | 実行して要約（初期値、最終値、最小と最大、間引いた時系列）を返す。CSV にも保存できる |
| `sweep_parameter` | パラメータを振って比較する（感度分析）。複数の値を変えたシナリオや、保存した施策も比べられる |
| `import_data` | 実際のデータ（実績や観測値）の CSV を取り込み、`<モデル名>.data.csv` に保存する。ビューアのグラフで、要素の線に点で重ねる。要素名と合わない列は「もしかして」を付けて知らせる |

`run_simulation` と `sweep_parameter` には `overrides` を渡せる。値を一時的に変えて実行するもので、ファイルは変わらない。

編集するツール（`upsert_elements`、`remove_elements`、`set_simulation`、`set_scenarios`）は、保存した後に検証結果を返す。AI はその結果を見て、自分で直せる。

## 使い方の例

Claude Code に次のように頼む。

> 人口モデルを作って。初期人口 1000、出生率 3%、死亡率 1%、50 年。

> 出生率を 1% から 5% まで 5 段階で振って、50 年後の人口を比べて。

> 「出生率を 4% に上げる」と「移民を毎年 20 人受け入れる」の 2 つの施策を保存して。ビューアで何もしない場合と比べたい。

> ~/Downloads/model.InsightMaker を取り込んで、どんなモデルか説明して。

> Web 版に読み込めるように書き出して。

## Insight Maker の Web 版とのやりとり

### Web 版 → MCP

1. Web 版でモデルを開き、Import/Export メニューで `Model.InsightMaker` か `Model.json`（ModelJSON）を書き出す
2. AI に「このファイルを取り込んで」と頼む（`import_model`）

### MCP → Web 版

1. AI に「書き出して」と頼む（`export_model`）。作業フォルダの `exports/<モデル名>.json` にできる
2. Web 版で Import/Export メニューの「Import ModelJSON」から、そのファイルを読み込む
   - Import/Export は、エディタ右上の共有アイコン（3 つの点を線でつないだ形）を押すと、メニューの下のほうに出てくる。上向きの矢印が読み込み
   - モデルにグラフや表の設定がなければ、書き出すときにストックの時系列グラフを 1 つ足す（`chart: false` で足さない）。ほかの要素を見たいときは、SIMULATE のあと「ADD DISPLAY」で足す

[examples/population.json](examples/population.json) は、この MCP で作って書き出した例。[examples/population.data.csv](examples/population.data.csv) は、その実際のデータの例（`import_data` で取り込むと、ビューアのグラフに点で重なる）。

## ビューア（Web 画面）

作業フォルダのモデルを、図とグラフで見て手直しするための画面。MCP サーバーとは別に起動する。ファイルの変更を監視しているので、AI が MCP でモデルを変えると、画面がその場で変わる（変わった要素は色の枠で示す）。

```bash
npm run viewer
```

ブラウザで http://localhost:5180/ を開く。作業フォルダは MCP サーバーと同じ決め方（`--models-dir`、`SD_MODELER_MODELS_DIR`、`./models`）で、ポートは `--port` か環境変数 `SD_MODELER_VIEWER_PORT` で変えられる。`127.0.0.1` だけで待ち受けるので、ほかの機械からは見えない。

- **図：** ストック、フロー、変数、コンバーター、リンク、モデルの外（雲）を描く。ストックには最終値を出す。座標のない要素は仮に並べる。配置は、ドラッグで直すか、AI に頼む（AI は `view_diagram` で図を見ながら直す）
- **グラフと表：** 実行結果の時系列。最初はモデルのグラフ設定の要素（なければストック）を出し、要素を選んで切り替えられる（同時に 8 本まで）。実際のデータ（`<モデル名>.data.csv`）があれば、線に点で重ねる
- **詳しい情報：** 図の要素を押すと、式、初期値、単位、最終値を出す
- **問題：** 検証のエラーと警告を出す。エラーがあるときは実行しない

- **編集：** 選んだ要素の式、初期値、単位などを直せる。図の要素をドラッグすると位置を保存する。画面で変えたことは「元に戻す」（Ctrl+Z）で戻せる。どれも MCP と同じファイルに書き戻す
- **AI との同時の変更：** 画面より先に AI がモデルを変えていたら、黙って上書きせずに知らせる

要素を足す・消す・名前を変える・線でつなぐ操作は、まだ画面からはできない（AI に頼む）。

画面の見方は、スクリーンショットつきの [ビューアの使い方](docs/VIEWER.md) にまとめている。

## できないこと（段階 1）

- **エージェントベースのモデル**（Agent、Population）は ModelJSON で表せないので、取り込まない
- テキスト、画像、ボタン、アクションも ModelJSON にないので、取り込まない。フォルダはなくなるが、中の要素は残る（どちらも `import_model` が警告を出す）
- 状態（STATE）と遷移（TRANSITION）は、読み込み、保存、実行、上書きはできる。追加や変更はできない
- 自動で付ける座標は、重ならない程度の簡易なもの

## 開発

```bash
npm test          # テスト（vitest）
npm run typecheck # 型チェック
npm run build     # dist/ にビルド（サーバーと画面）
npm run dev:web   # 画面の開発用サーバー（/api は npm run viewer に回す）
npm run screenshots # docs/VIEWER.md のスクリーンショットを撮り直す（先に npm run build。Edge か Chrome が必要）
```

- `src/core`：モデルの保持、変換、編集、検証、実行。MCP に依存しない（段階 2 の Web 画面でも使う）
- `src/mcp`：中核部分を MCP ツールとして公開する薄い層
- `src/viewer`：ビューアのサーバー（API、ファイルの監視、画面の配信）
- `web`：ビューアの画面（React、React Flow、Recharts。Vite で `dist/web` にビルド）

## ドキュメント

- [ビューアの使い方](docs/VIEWER.md)：画面の見方と操作（スクリーンショットつき）
- [人の確認が必要なこと](docs/HUMAN_CHECKS.md)：AI では確かめられないことと、人が決めること
- [構想と前提](docs/VISION.md)：目指すもの、3 段階の構想、調査でわかった前提と制約
- [ロードマップ](docs/ROADMAP.md)：段階 1（中核部分＋MCP）と段階 2（ビューア）の設計方針とマイルストーン

## ライセンス

未定。エンジン `simulation` が AGPL のため、AGPL-3.0 にする見込み。
