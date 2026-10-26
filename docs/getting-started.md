# はじめての手順

loopsight を入れて、最初のモデルを作り、ビューアで見て、シナリオで比べるところまでを、順に進めます。

> **Claude に任せることもできます。** Claude Code に、このページのアドレス（https://github.com/kagu3/loopsight/blob/main/docs/getting-started.md）を貼って「この手順で loopsight を入れて」と頼めば、Claude が代わりに入れるか、あなたがすることを示してくれます。Claude 向けの注意は [Claude がこの手順を進めるとき](#claude-がこの手順を進めるとき) にあります。

## 目次

- [ことば](#ことば)
- [必要なもの](#必要なもの)
- [1. Node.js を入れる](#1-nodejs-を入れる)
- [2. Claude Code に登録する](#2-claude-code-に登録する)
- [3. 最初のモデルを頼む](#3-最初のモデルを頼む)
- [4. ビューアで見る](#4-ビューアで見る)
- [5. シナリオで比べる](#5-シナリオで比べる)
- [次に読むもの](#次に読むもの)
- [よくある失敗と直し方](#よくある失敗と直し方)
- [Claude がこの手順を進めるとき](#claude-がこの手順を進めるとき)

## ことば

- **ターミナル：** コマンドを打ち込む画面です。Windows では「PowerShell」、macOS では「ターミナル」を使います。このページのコマンドは、そのまま写して Enter を押します
- **MCP サーバー：** AI（Claude）が使う道具をまとめたプログラムです。loopsight の MCP サーバーを Claude Code に登録すると、Claude がモデルを作ったり動かしたりできます
- **ビューア：** 人がモデルを図とグラフで見る画面です。ブラウザで開きます
- **作業フォルダ：** モデルのファイルを置くフォルダです。このページでは、ホームフォルダの中の `loopsight-models` を使います（Windows なら `C:\Users\<あなたの名前>\loopsight-models`）。MCP サーバーとビューアには、同じ作業フォルダを渡します。フォルダがなければ自動で作ります
- **シナリオ：** 「出生率が下がったら」のように、モデルの値を変えた場合です。元のモデルと並べて比べます

## 必要なもの

- Windows、macOS、Linux のどれか
- Node.js 22 以上（次の手順で入れます）
- [Claude Code](https://claude.com/claude-code)（入れてあり、`claude` で起動できること）
- Edge か Chrome（AI が図を画像にして確かめるときに使います。Windows には Edge が最初から入っています。WSL では、Windows の Edge は使えないので、WSL の中に Chrome か Chromium を入れます）

## 1. Node.js を入れる

ターミナルで次のコマンドを打ち、Node.js の版を確かめます。

```bash
node --version
```

`v22.12.0` のように、`v22` 以上の数が出れば次へ進みます。

「見つかりません」「認識されていません」と出たときや、`v20` などの古い版が出たときは、[Node.js の公式サイト](https://nodejs.org/ja) から「LTS」と書かれた版を入れます。入れたら、ターミナルを一度閉じて開き直し、もう一度 `node --version` で確かめます。

## 2. Claude Code に登録する

loopsight の MCP サーバーを Claude Code に登録します。登録は 1 回だけで済みます。`--scope user` を付けるので、どのフォルダで Claude Code を起動しても使えます。

使う OS のコマンドを 1 つだけ打ちます。

**macOS、Linux、WSL：**

```bash
claude mcp add --scope user loopsight -- npx -y loopsight --models-dir ~/loopsight-models
```

**Windows（PowerShell）：**

```powershell
claude mcp add --scope user loopsight -- cmd /c npx -y loopsight --models-dir $HOME\loopsight-models
```

Windows では、`npx` の前に `cmd /c` を付けます。付けないと、Claude Code が MCP サーバーを起動できません。

Claude Code を npm で入れていて、PowerShell で `unknown option '-y'` と出たときは、`claude` を `claude.cmd` にして打ち直します（PowerShell が `--` を消してしまうため）。

`npx -y loopsight` は、loopsight を npm から取ってきて起動するコマンドです。前もって入れる作業はいりません（初めて起動するときに取ってくるので、少し時間がかかります）。

### うまくいったかを確かめる

次のコマンドを打ちます。

```bash
claude mcp list
```

`loopsight` の行に `✓ Connected` と出れば成功です。初めてのときは取ってくるのに時間がかかり、つながらないと出ることがあります。少し待って、もう一度打ちます。

登録を直したいときは、`claude mcp remove --scope user loopsight` で消してから、登録し直します。

### Claude Code 以外で使うとき

設定ファイルで MCP サーバーを登録するほかの MCP クライアントでは、次のように書きます（この形は、Claude Code 以外では試していません）。`--models-dir` には絶対パスを書きます（macOS は `/Users/<あなたの名前>/loopsight-models`、Linux は `/home/<あなたの名前>/loopsight-models`）。Windows では `"command": "cmd"`、`"args": ["/c", "npx", "-y", "loopsight", "--models-dir", "C:\\Users\\<あなたの名前>\\loopsight-models"]` にします。

```json
{
  "mcpServers": {
    "loopsight": {
      "command": "npx",
      "args": ["-y", "loopsight", "--models-dir", "/Users/<あなたの名前>/loopsight-models"]
    }
  }
}
```

## 3. 最初のモデルを頼む

ターミナルで `claude` と打って Claude Code を起動します（どのフォルダで起動してもかまいません）。次のように頼みます。

> 人口のモデルを作って。名前は first-model、表示名は「人口」。人口は最初 1000 人、出生率 3%、死亡率 1%、期間は 50 年。要素の名前は日本語（人口、出生、死亡、出生率、死亡率）にして。

loopsight のツールを使ってよいか聞かれたら、許可します。

**うまくいったかを確かめる：** Claude が「50 年後の人口は約 2,692 人」のように答えれば成功です。作業フォルダに `first-model.json` ができています。

Claude が loopsight を使わずに答えたときは、Claude Code の中で `/mcp` と打ち、`loopsight` がつながっているか確かめます。登録したあとに起動し直していなければ、Claude Code を一度終えて（`/exit`）、もう一度 `claude` で起動します。

## 4. ビューアで見る

Claude Code とは別に、もう 1 つターミナルを開いて、ビューアを起動します。`--models-dir` には、登録したときと同じ作業フォルダを書きます。

**macOS、Linux、WSL：**

```bash
npx -y -p loopsight loopsight-viewer --models-dir ~/loopsight-models
```

**Windows（PowerShell）：**

```powershell
npx.cmd -y -p loopsight loopsight-viewer --models-dir $HOME\loopsight-models
```

`Loopsight ビューア: http://localhost:5180/` と出たら、ブラウザで http://localhost:5180/ を開きます。左下の「モデル」の一覧から `first-model` を選ぶと、図とグラフが出ます。人口のグラフが右上がりに増えていれば成功です。

ビューアは開いたままにしておきます。Claude がモデルを変えると、画面がその場で変わります。止めるときは、ビューアを起動したターミナルで Ctrl+C を押します。

画面の見方は [ビューアの使い方](viewer.md) にあります。

## 5. シナリオで比べる

Claude Code に戻って、次のように頼みます。

> 出生率が 2% に下がる場合を「出生率が下がる」、4% に上がる場合を「出生率が上がる」というシナリオとして保存して。

**うまくいったかを確かめる：** ビューアのグラフに、「元のモデル」と 2 つのシナリオの線が重なって出ます。50 年後の人口は、元のモデルが約 2,692 人、「出生率が下がる」が約 1,645 人、「出生率が上がる」が約 4,384 人です。

ここまでの手順で作ったモデルは、[examples/first-model.json](../examples/first-model.json) にあります（図の配置は、Claude によって少し変わります）。作業フォルダにコピーすると、ビューアで開けます。

## 次に読むもの

- [ビューアの使い方](viewer.md)：画面の見方と、画面での直し方
- [ツールのリファレンス](reference/tools.md)：Claude が使う道具の一覧
- [式の書き方](reference/formulas.md)：要素の式に使える演算子と関数
- [モデルのファイルの形式](reference/model-format.md)：保存するファイルの中身と、作業フォルダの決まり

ほかにも、次のように頼めます。

> 出生率を 1% から 5% まで 5 段階で振って、50 年後の人口を比べて。

> フィードバックループを探して、図で目立たせて。

> ~/Downloads/model.json を取り込んで、どんなモデルか説明して。

## よくある失敗と直し方

| 症状 | 直し方 |
|---|---|
| `node` が「見つかりません」「認識されていません」と出る | Node.js を入れます（[1. Node.js を入れる](#1-nodejs-を入れる)）。入れたあとは、ターミナルを開き直します |
| `node --version` が `v20` などで、22 より古い | Node.js の公式サイトから LTS 版を入れ直します。22 より古い版には対応していません（図の画像も作れません） |
| PowerShell で「このシステムではスクリプトの実行が無効になっているため」と出て、`npx` や `claude` が止まる | `npx` の代わりに `npx.cmd`、`claude` の代わりに `claude.cmd` と打ちます。または、`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` を一度打って、PowerShell の設定を変えます |
| PowerShell で登録すると `unknown option '-y'` と出る | `claude` の代わりに `claude.cmd` と打ちます（npm で入れた Claude Code を PowerShell から使うと、`--` が消えるため） |
| Windows で `claude mcp list` が、ずっとつながらないと出る | 登録のコマンドに `cmd /c` が入っているか確かめます。`claude mcp remove --scope user loopsight` で消して、Windows のコマンドで登録し直します |
| Claude が loopsight を使わない | Claude Code の中で `/mcp` と打ち、`loopsight` がつながっているか確かめます。登録したあとは Claude Code を起動し直します |
| ビューアに「モデルがありません」と出る | ビューアを起動したときの「作業フォルダ:」の表示が、登録したときの `--models-dir` と同じか確かめます |
| ビューアが「ポート 5180 はほかのプログラムが使っています」と出て止まる | ビューアがもう起動していれば、http://localhost:5180/ を開きます。別のポートで起動するときは、コマンドの最後に `--port 5181` を付けます |
| Claude が「Edge か Chrome が見つかりません」と言う | Edge か Chrome を入れます。WSL では、WSL の中に Chrome か Chromium を入れます（Windows の Edge は使えません）。決まった場所にないときは、環境変数 `BROWSER_PATH` にその場所を書きます（[起動引数と環境変数](reference/model-format.md#起動引数と環境変数)） |

## Claude がこの手順を進めるとき

利用者にこのページを渡されて、loopsight を入れるよう頼まれたときは、次のように進めてください。

1. OS を確かめる（Windows か、macOS・Linux・WSL か）。コマンドは OS に合うものを使う
2. `node --version` で Node.js が 22 以上かを確かめる。なければ、入れ方を利用者に示す（Node.js を入れるのは利用者にしてもらう）
3. 作業フォルダをどこにするかを利用者に確かめる。決まっていなければ、ホームフォルダの `loopsight-models` を勧める
4. [2. Claude Code に登録する](#2-claude-code-に登録する) のコマンドを実行する。利用者の設定（`--scope user`）が変わるので、実行する前に利用者に確かめる。Windows では `cmd /c` で包む。Windows の PowerShell 用のコマンドは、PowerShell で実行する。Git Bash（Bash のツール）で実行すると、`cmd /c` が `cmd C:/` に、`$HOME\loopsight-models` が別のパスに変わって、登録が壊れる。Git Bash で実行するときは、次の形にする

   ```bash
   claude mcp add --scope user loopsight -- cmd //c npx -y loopsight --models-dir "$USERPROFILE\loopsight-models"
   ```

5. `claude mcp list` で `loopsight` がつながったかを確かめ、結果を利用者に伝える
6. 登録は、いま動いている Claude Code のセッションには効かない。Claude Code を起動し直してから [3. 最初のモデルを頼む](#3-最初のモデルを頼む) に進むよう、利用者に伝える
7. ビューアは、利用者が自分のターミナルで起動する（Ctrl+C で止めるまで動き続けるため）。[4. ビューアで見る](#4-ビューアで見る) のコマンドを、作業フォルダに合わせて示す

うまくいかないときは、[よくある失敗と直し方](#よくある失敗と直し方) を見て直す。表にある `Set-ExecutionPolicy` は利用者の PC の設定を変えるので、Claude は自分で打たず、利用者に任せる（Claude は `npx.cmd` や `claude.cmd` を使えばよい）。insightmaker.com にはアクセスしない。
