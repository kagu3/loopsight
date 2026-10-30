# ドキュメント

loopsight の文書の一覧。初めての人は、[はじめての手順](getting-started.md) から読む。

## 使う人向け

- [はじめての手順](getting-started.md)：Node.js を入れる、Claude Code に登録する、最初のモデルを頼む、ビューアで見る、シナリオで比べる。Claude に渡して、代わりに入れてもらうこともできる
- [ビューアの使い方](viewer.md)：画面の見方と操作（スクリーンショットつき）
- [sample のモデル](../examples/README.md)：システム思考を学ぶための sample。学ぶ順の一覧と使い方

### リファレンス

- [ツールのリファレンス](reference/tools.md)：AI が使うツールと引数、AI に渡している使い方の説明
- [式の書き方](reference/formulas.md)：要素の式に使える演算子、関数、単位
- [モデルのファイルの形式](reference/model-format.md)：ModelJSON の項目、作業フォルダ、起動引数と環境変数

### そのほか

- [変更履歴](../CHANGELOG.md)：版ごとの主な変更

## 開発する人向け

- [開発に参加する](../CONTRIBUTING.md)：clone して動かす方法、コマンド、守ってほしい決まり

内部メモ（[dev/](dev/)）は、開発中に書いているもので、利用者向けではない。決まっていないことも含む。

- [VISION.md](dev/VISION.md)：目指すもの、3 段階の構想、調査でわかった前提、設計の要点
- [IDEAS.md](dev/IDEAS.md)：まだ決まっていない機能の案
- [BACKLOG.md](dev/BACKLOG.md)：レビューで見つかったが、優先度が低く残した指摘
- [HUMAN_CHECKS.md](dev/HUMAN_CHECKS.md)：AI では確かめられないことと、人が決めること
- [doc-map.md](dev/doc-map.md)：何を変えたら、どの文書を直すかの表
