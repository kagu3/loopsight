# 開発に参加する

loopsight の開発の始め方と、変更するときに守ってほしい決まりをまとめる。npm で入れて使う方法は [はじめての手順](docs/getting-started.md) を見る。

## 開発の始め方

Node.js 22 以上が必要。

```bash
git clone https://github.com/kagu3/loopsight.git
cd loopsight
npm install
npm run build
```

よく使うコマンドは次のとおり。

```bash
npm test          # テスト（vitest）
npm run typecheck # 型チェック
npm run build     # dist/ にビルド（サーバーと画面）
npm run viewer    # ビルドしたビューアを起動する（http://localhost:5180/）
npm run dev:web   # 画面の開発用サーバー（/api は npm run viewer に回す）
npm run build:demo # デモサイトを dist/demo にビルドする（下の「デモサイト」）
npm run screenshots # docs/viewer.md のスクリーンショットを撮り直す（先に npm run build。Edge か Chrome が必要）
npm run docs      # MCP のツールの定義から docs/reference/tools.md を作り直す
```

`npm run viewer` に起動引数を渡すときは、`npm run viewer -- --port 5181` のように `--` のあとに書く。

図の画像を作るテスト（view_diagram と export_diagram）は、ビルドした画面（`dist/web`）とブラウザ（Edge か Chrome）を使う。`dist/web` がないときは、画像を作れないときの知らせだけを確かめる。画像まで確かめるときは、先に `npm run build` をしてから `npm test` を実行する（`dist/web` が古いと、古い画面で画像を作る）。

### デモサイト

[デモサイト](https://kagu3.github.io/loopsight/) は、`examples/` の sample を、入れずにブラウザで触れるビューアの画面。サーバーはなく、画面の中でモデルを実行し、変更はメモリにだけ持つ（読み直すと元の sample に戻る）。

- ビルド：`npm run build:demo`（`vite build --mode demo`）。`dist/demo` に静的なファイルを出す。`base` は `/loopsight/`
- 手元で開く：`npx vite preview --config web/vite.config.ts --mode demo` を実行し、表示されたアドレスの `/loopsight/` を開く
- 公開：main に入るたびに、GitHub Actions（[.github/workflows/demo.yml](.github/workflows/demo.yml)）がビルドして GitHub Pages に置く。手でも動かせる（Actions →「デモサイトを公開する」→ Run workflow）。リポジトリの Settings → Pages の Source は「GitHub Actions」にしておく
- しくみ：画面がサーバーとやりとりするのは `web/src/api.ts` だけ。デモのビルドでは、その裏側を `web/src/demo/store.ts`（ブラウザの中のモデル）に差し替える。モデルを実行して返す形を作ることと、書き込みの確かめは `src/viewer/shared.ts` にまとめ、ビューアのサーバーと同じものを使う（動きがずれていないことは `tests/demo-store.test.ts` で確かめる）
- sample の中身：`web/src/demo/samples.ts` が、ビルドのときに `examples/*/*.json`（モデル）と `examples/*/*.data.csv`（実際のデータ）を埋め込む。データも、モデルと同じようにメモリに持ち、グラフに点で重ねる
- デモでは、作業フォルダに書く機能（図の書き出し）と、変更の知らせ（`/api/events`）を使わない。画面のコードは複製せず、`web/src/api.ts` の `DEMO` で切り替える。`api.ts` はやりとりの相手（サーバーかブラウザの中のモデルか）を、`App.tsx` も同じ `DEMO` を見て、画面の違い（「ライブ」の代わりの「デモ」の印、デモの説明の欄、図の「書き出す」ボタンを出さないこと）を切り替える

**デモを置いていかないための決まり。** 画面のコードはビューアと同じなので、ほとんどの変更は main に入ると自動でデモにも入る。ただし、ビューアのサーバーと新しい種類のやりとり（`web/src/api.ts` の新しい関数と、`src/viewer/server.ts` の新しい API）を足したときは、デモ側の `web/src/demo/store.ts` にも同じものを足す。足さないと、デモではその機能だけ動かない。モデルへの書き込みの種類を足すときは、`src/viewer/shared.ts` の `WriteAction` と `applyWrite` に足せば、サーバーとデモの両方に入る。この決まりは [docs/dev/doc-map.md](docs/dev/doc-map.md) の表にもある。

### CI と main の保護

PR を出すと（main に入ったときも）、GitHub Actions（[.github/workflows/ci.yml](.github/workflows/ci.yml)）が ubuntu-latest と Node.js 22 で次を順に走らせ、結果が PR に出る。手元で同じことを確かめるには、同じコマンドを実行する。ただし、CI ではテストのときに `dist/web` がないので、図の画像を作るテストは知らせだけを確かめる（上の「よく使うコマンド」のあとの説明）。手元に前のビルドの `dist/web` が残っていると、その画面で画像まで作る。

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run build:demo
```

- 同じ PR に新しい push をすると、前の実行は止まり、新しいものだけが走る
- CI では `npm run screenshots`（ブラウザで撮る）は走らせない
- デモサイトの公開（demo.yml）は公開だけの役目なので、CI とは分けている（同じビルドを 2 回するが、そのままにする）

main は保護していて、次の決まりがある。管理者も同じ決まりに従う。

- CI のジョブ（`check`）が通らない PR はマージできない
- PR のレビューの承認は求めない（一人で開発しているため）
- main への force push と、main の削除はできない

ジョブの名前（`check`）を変えるときは、main の保護の「必須のチェック」も合わせて直す。

### clone したもので MCP サーバーを使う

このリポジトリで Claude Code のセッションを始めると、ルートの [.mcp.json](.mcp.json) で、ビルドした MCP サーバー（`dist/mcp/index.js`）が使われる。先に `npm run build` をしておく。最初に、プロジェクトの MCP サーバーを使ってよいか聞かれるので許可する。モデルはリポジトリの `models/` に保存される（git の管理外）。

このリポジトリ以外のフォルダで Claude Code を起動して、clone したものを使うときは、絶対パスで登録する（Windows でも `node` は `cmd /c` で包まなくてよい）。

```bash
claude mcp add --scope user loopsight -- node /absolute/path/to/loopsight/dist/mcp/index.js --models-dir /absolute/path/to/models
```

npm で入れたものも `loopsight` の名前で登録しているときは、名前がぶつからないように、`loopsight-dev` のような別の名前で登録する。

### フォルダの役割

- `src/core`：モデルの保持、変換、編集、検証、実行。MCP に依存しない（ビューアでも使う）
- `src/mcp`：中核部分を MCP ツールとして公開する薄い層
- `src/viewer`：ビューアのサーバー（API、ファイルの監視、画面の配信）。`shared.ts` はデモサイトと共通の処理で、Node.js に依存させない
- `web`：ビューアの画面（React、React Flow、Recharts。Vite で `dist/web` にビルド）。`web/src/demo` はデモサイトだけで使う
- `examples`：公開する sample のモデル。足す・直すときの決まりと、テスト（`tests/examples.test.ts`、`tests/examples-numbers.test.ts`）で確かめていることは [examples/README.md](examples/README.md) にある

## 守ってほしい決まり

### 操作の指針

**何ができるかは、人と AI で同じにする。** 人はビューアで、AI は MCP のツールで（画面ではなくモデルを直接）操作する。片方でしか作れない結果（モデルや表示の変化）は作らない。人に操作させるには重すぎる機能は作らない。

例外として、次の 2 つは AI だけの道具でよい。人向けにも足すのは、人にもかなり役に立つときだけにする。

- 人が手で作れる結果を手早くする便利な道具（例：自動配置）
- モデルを変えない調べもの（検証、図の確認、一時的な上書きでの試し実行）

ただし、ほかの手段とあまり手間が変わらない道具は作らない。

### 制約と方針

- **共通のデータ形式は ModelJSON にする。** 中核部分、MCP、ビューアのすべてで使う。
- **insightmaker.com には自動でアクセスしない**（利用規約で自動アクセスとスクレイピングが禁止されているため）。
- **エンジン `simulation` が AGPL なので、このプロジェクトも AGPL-3.0（3 以降の版も可）にする。** 本文はリポジトリ直下の [LICENSE](LICENSE)。
- **対象はシステムダイナミクスのモデル。** エージェントベースのモデルと、その部品の状態（STATE）と遷移（TRANSITION）は扱わない。
- **`src/core` は Node.js の API に依存させない**（ファイルを読み書きする `store.ts` を除く）。ブラウザだけで動く版を後で作るため。`node:fs` などを使う処理は `store.ts` か、`src/mcp`・`src/viewer` に置く。ただし `src/viewer/shared.ts` と `web/src/demo` はデモサイトで動くので、同じく Node.js に依存させない（`tests/viewer-shared.test.ts` で確かめる）。

これらの決まりは、もとは [docs/dev/VISION.md](docs/dev/VISION.md) の「操作の指針」と「制約と方針」にあった。Issue の本文で `docs/VISION.md` の「操作の指針」と書いてあるものは、ここを指す。

### 文書も一緒に直す

変更したら、同じ PR で文書も直す。直す必要がなければ、PR にその理由を書く。何を変えたら、どの文書を直すかは [docs/dev/doc-map.md](docs/dev/doc-map.md) の表にある。

## Issue と PR

- 不具合の報告や機能の案は、[GitHub の Issue](https://github.com/kagu3/loopsight/issues) に書く。不具合なら、起きたことと、そのときの手順（できればモデルの ModelJSON）を書く
- 大きな変更は、PR を作る前に Issue で相談する
- PR を送る前に、`npm run build`、`npm run typecheck`、`npm test`、`npm run build:demo` が通ることを確かめる。PR を出すと、同じことを CI でも確かめる（上の「CI と main の保護」）
- PR には、何をなぜ変えたかと、直した文書を書く

## 内部メモ（docs/dev/）

開発中に書いているメモ。利用者向けではない。決まっていないことも含む。

- [VISION.md](docs/dev/VISION.md)：目指すもの、3 段階の構想、調査でわかった前提、設計の要点
- [IDEAS.md](docs/dev/IDEAS.md)：まだ決まっていない機能の案。決まったものから Issue にする
- [BACKLOG.md](docs/dev/BACKLOG.md)：レビューで見つかったが、優先度が低く残した指摘の書き溜め
- [HUMAN_CHECKS.md](docs/dev/HUMAN_CHECKS.md)：AI では確かめられないことと、人が決めること
- [doc-map.md](docs/dev/doc-map.md)：何を変えたら、どの文書を直すかの表
