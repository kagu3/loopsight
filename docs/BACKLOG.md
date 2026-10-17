# 後で直すか検討すること

レビューで見つかったが、マージを止めるほどではなかった指摘の書き溜め。**優先度は低く、まだ直すと決めたものではない。** 手が空いたときに見直し、直すと決めたものは GitHub の Issue にして、ここからは消す。直す必要がないと決めたものも、理由を書かずに消してよい。

Issue にしないのは、Issue をまとめて片付けるときに一緒に拾われないようにするため。新しい機能の案は [IDEAS.md](IDEAS.md) に書く。

各項目の「出どころ」は、指摘が出たときの PR。詳しい経緯は PR の本文にある。

（書き始めた日：2026-10-16）

## 施策（シナリオ）

- **ほかの施策が 1 つでも実行できないと、`set_scenarios` 全体が失敗して何も保存されない。** 要素を消して施策 A が壊れると、関係のない施策 B の説明を直すこともできない。保存はして、比較の結果に施策ごとのエラーを入れる形（`runScenarios` と同じやり方）のほうが扱いやすい。出どころ：[#21](https://github.com/suda0033/sd-modeler/pull/21)
- **実行できなかった施策があると、ほかの施策の色がずれる。** 色を、実行できた施策の中での位置で決めているため。モデルの中の並び順で決めれば変わらない。出どころ：[#21](https://github.com/suda0033/sd-modeler/pull/21)
- **名前のないシナリオの仮の名前（scenario N）が、前のシナリオを消すとずれる。** 配列の位置で作っているため。名前のないシナリオは取り込んだモデルでしか起きない。出どころ：[#21](https://github.com/suda0033/sd-modeler/pull/21)
- **施策の上限（8）が 3 か所に分かれている。** `src/core/slides.ts` の `MAX_SLIDE_SCENARIOS`、`src/viewer/server.ts` の `MAX_SCENARIOS`、web の `MAX_SERIES`。中核から 1 つの定数で出せば、ずれる心配がなくなる。「何もしない場合」の名前も web 側に写しがある。出どころ：[#21](https://github.com/suda0033/sd-modeler/pull/21)、[#23](https://github.com/suda0033/sd-modeler/pull/23)
- **ビューアで要素を消したときの黄色の帯が、中核（`removeElements`）の知らせをそのまま並べている。** `FLOW "Births" の to は "Population" を指していたので空（モデルの外）にしました。` や `シナリオ "…" から "…" の値を消しました。` のように、MCP 向けの書き方（英語の種類名、「シナリオ」）で、作業者には読みにくい。画面では「Births の行き先をモデルの外にしました」「施策「…」から … の値を消しました」のように言い換えるか、要点だけにする。出どころ：#35

## 実際のデータ（CSV）

- **日本語版 Excel で「CSV（コンマ区切り）」として保存すると Shift_JIS になり、文字化けする。** 日本語の要素名がどの列とも合わない、という警告だけが出る。文字化けの文字（U+FFFD）を見つけたら「UTF-8 で保存してください」と知らせるか、少なくとも VIEWER.md に書く。出どころ：[#22](https://github.com/suda0033/sd-modeler/pull/22)
- **タブ区切りの CSV で、カンマを含む名前に変えると次から読めなくなる。** 区切りの判定が「1 行目にタブがあり、カンマがなければタブ区切り」のため。タブの数がカンマより多ければタブ区切りとするか、カンマを含む名前は `"…"` で囲む。出どころ：[#22](https://github.com/suda0033/sd-modeler/pull/22)
- **データの時刻に合わせて足した行では、ツールチップのモデルの値が「—」になる。** 線は補った値でその時刻を通っているので、ちょうど比べたい点で値が読めない。補った値を出す。出どころ：[#22](https://github.com/suda0033/sd-modeler/pull/22)
- **正規化表示で、モデルの線が一定だとデータの点がすべて 50% に並ぶ。** 合っているように見えてしまう。データ自身の最小・最大も目盛りに入れるか、その要素の点は正規化表示では描かない。出どころ：[#22](https://github.com/suda0033/sd-modeler/pull/22)
- **期間外の時刻のデータがあると、横軸がそこまで広がる。** モデルの開始より前の実績を入れると、線のない区間ができる。望ましい場合もあるので、どちらにするか決めて VIEWER.md に書く。出どころ：[#22](https://github.com/suda0033/sd-modeler/pull/22)
- **データのある要素が、最初はグラフに出ない。** 自分で選ぶまで点が見えない。会議資料という目的からは、最初から出したほうが親切かもしれない。出どころ：[#22](https://github.com/suda0033/sd-modeler/pull/22)
- **`1,5` を桁区切りとして 15 と読む。** 小数点にカンマを使う地域の書き方を取り違える。日本語の環境では起きにくい。出どころ：[#22](https://github.com/suda0033/sd-modeler/pull/22)

## 筋書きと発表モード

- **極性が決まっていない原因スライドがあると、編集のたびに同じ警告が `slides_issues` と「問題」欄に出る。** 自動で足すリンクには極性が付かないので、brooks_law のようなモデルではスライドの枚数分の警告が毎回返る。警告は `set_slides` と `view_slides` のときだけにし、編集のあとは食い違い（errors）だけを返す、などを検討する。出どころ：[#24](https://github.com/suda0033/sd-modeler/pull/24)
- **`set_scenarios` の `replace: true` で施策の名前を付け直すと、筋書きは追従しない。** `slides_issues` で知らせるので実害は小さい。出どころ：[#23](https://github.com/suda0033/sd-modeler/pull/23)
- **比較スライドで、施策名の重複（大文字小文字違い）を除いていない。** 同じ線が 2 本出て、React の key も重なる。出どころ：[#23](https://github.com/suda0033/sd-modeler/pull/23)
- **比較スライドの値が `2,691.59` のように小数 2 桁で出る。** 会議資料としては、桁を丸めたほうが読みやすい。出どころ：[#23](https://github.com/suda0033/sd-modeler/pull/23)
- **例の population の B ループは、R より見分けにくい。** Population → Deaths のリンクがフローの線に沿って、細いレンズ形になる。Death Rate と Deaths の位置を少しずらす。出どころ：[#24](https://github.com/suda0033/sd-modeler/pull/24)
- **図の R / B の札は px 指定なので、全画面の発表では見出しに比べて小さく見える。** 出どころ：[#24](https://github.com/suda0033/sd-modeler/pull/24)

## ループ（find_loops）

- **細長い大きな輪（100 要素を超える）では、見つける前に手数の上限で止まる。** 長さを広げながら探し直すため。実際の SD モデルではまずない形。出どころ：[#24](https://github.com/suda0033/sd-modeler/pull/24)
- **強連結成分を探す処理（Tarjan 法）が再帰。** 数千要素がつながった鎖のようなモデルでは、呼び出しが深くなりすぎて止まるおそれがある。出どころ：[#24](https://github.com/suda0033/sd-modeler/pull/24)

## 画像と PDF（ヘッドレスのブラウザ）

- **`view_slides` と `export_slides` は、描き終わりを固定の時間（400ms など）で待つ。** 重いモデルの図では足りないかもしれない。出どころ：[#23](https://github.com/suda0033/sd-modeler/pull/23)、[#25](https://github.com/suda0033/sd-modeler/pull/25)
- **`DevToolsActivePort` を一度読むと読み直さない。** 書いている途中で読んだ場合などに、まれに「接続できません」で失敗しうる。`/json/list` が失敗したら読み直す。出どころ：[#25](https://github.com/suda0033/sd-modeler/pull/25)
- **ブラウザを閉じるときの `fetch` と WebSocket に時間の上限がない。** ブラウザが固まると `close()` が終わらない。`AbortSignal.timeout` を付ける。出どころ：[#25](https://github.com/suda0033/sd-modeler/pull/25)
- **ブラウザが見つからないとき、空の `im-browser-*` フォルダが残る。** 一時フォルダを作ってからブラウザを探しているため。順を入れ替える。前からある。出どころ：[#25](https://github.com/suda0033/sd-modeler/pull/25)
- **PDF から文字を取り出すと、「人」が「⼈」のような部首の文字になることがある。** Chrome と Yu Gothic の組み合わせの癖。見た目と印刷は正しい。出どころ：[#25](https://github.com/suda0033/sd-modeler/pull/25)
