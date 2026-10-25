import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  BASELINE_SCENARIO,
  EDITABLE_TYPES,
  EditError,
  ImportError,
  LOOP_KIND_LABEL,
  MAX_LOOPS,
  ModelError,
  ModelStore,
  StoreError,
  TIME_UNITS,
  checkModelName,
  checkActualData,
  checkDiagram,
  compareScenarios,
  dataToCSV,
  describeLoop,
  didYouMean,
  emptyModel,
  findElement,
  findLoops,
  importModelText,
  layoutModel,
  modelScenarios,
  namesByElement,
  parseDataCSV,
  removeElements,
  renamesSince,
  resolveTargets,
  runModel,
  runToCSV,
  setScenarios,
  setSimulation,
  staticCheck,
  summarizeModel,
  summarizeRun,
  sweepParameter,
  sweepValues,
  unmarkedDelays,
  upsertElements,
  validateModel,
  withBaseline,
  type ElementPatch,
  type LoopStep,
  type LoopView,
  type ModelJSON,
  type ScenarioPatch,
} from "../core/index.js";
import { BrowserNotFoundError, launchBrowser } from "../viewer/browser.js";
import { startViewer } from "../viewer/server.js";

// ---- 入力の形 ----

const modelName = z
  .string()
  .min(1)
  .describe("モデル名（作業フォルダの <モデル名>.json）。サブフォルダのモデルは、作業フォルダからの相対パスを / 区切りで（例: ブルックスの法則/brooks_law）");
const folderName = z.string().min(1).describe("フォルダ名。作業フォルダからの相対パスを / 区切りで（例: ブルックスの法則、事例/在庫）");
const equation = z.union([z.string(), z.number(), z.boolean()]);
const overrides = z
  .record(z.string(), equation)
  .describe("一時的に変える値 { 要素名: 値 }。STOCK は初期値、VARIABLE と FLOW は式を置き換える。ファイルは変わらない。");
const simulationShape = {
  algorithm: z.enum(["RK1", "RK4"]).optional().describe("解法。RK1 はオイラー法"),
  time_start: z.number().optional().describe("開始時刻"),
  time_length: z.number().optional().describe("期間"),
  time_step: z.number().optional().describe("刻み幅"),
  time_units: z.enum(TIME_UNITS).optional().describe("時間の単位"),
};
const simulation = z.object(simulationShape);
const targets = z.array(z.string()).optional().describe("結果を返す要素名。省略するとストックすべて");

const elementPatch = z.object({
  type: z.enum(EDITABLE_TYPES).optional().describe("新しく追加するときは必須"),
  name: z.string().optional().describe("要素名（LINK 以外は必須）。既存の名前なら更新、なければ追加"),
  rename_to: z.string().optional().describe("既存の要素の名前を変える。式やリンクの参照と、実際のデータ（<モデル名>.data.csv）の列名も書き換える"),
  description: z.string().nullable().optional(),
  from: z.string().nullable().optional().describe("FLOW の出元のストック（null はモデルの外）、LINK の始点"),
  to: z.string().nullable().optional().describe("FLOW の行き先のストック（null はモデルの外）、LINK の終点"),
  behavior: z
    .record(z.string(), z.any())
    .optional()
    .describe(
      "既存の値に重ねる（null でその項目を消す）。STOCK: initial_value, non_negative, units / VARIABLE: value, units / FLOW: value, non_negative, units / " +
        'CONVERTER: input ("TIME" か "ELEMENT"), input_element, interpolation ("NONE" か "LINEAR"), data ([[入力, 出力], ...]), units / LINK: polarity ("POSITIVE" "NEGATIVE" "NEUTRAL")',
    ),
  display: z
    .record(z.string(), z.any())
    .optional()
    .describe(
      "表示。coordinates [x, y], size [幅, 高さ], interactive（スライダー）, interactive_min, interactive_max など。座標のない要素には layout_model で座標を付けられる。" +
        "emphasis: true で図の要素を強調する（箱・名前の文字・枠の太さをまとめて大きく描く。size を指定した要素はその大きさを基準に大きくする）。false でふつうに戻す。" +
        "強調できるのはストック、変数、コンバーター、状態。付け外ししても箱の真ん中の位置は変わらない（coordinates も一緒に指定したときはそれに従う）。シミュレーションには影響しない。" +
        "emphasis はループサイト独自の項目で、Insight Maker などほかのツールは読み込めないことがあるので、ほかのツールに渡すときは強調を外す / " +
        "LINK と FLOW: delay（true で遅れの印 ‖ を図の線の途中に描く。false か null で外す。見た目だけで、シミュレーションには影響しない。実際の遅れは式の Delay や Smooth などで表す）",
    ),
});

// ---- 共通の処理 ----

/** view_diagram の、遅れの印の確認。式で遅れて効くのに印のないリンクがなければ何も足さない */
function unmarkedDelaysCheck(m: ModelJSON): { unmarked_delays?: { links: string[]; hint: string } } {
  const links = unmarkedDelays(m).map((l) => `${l.from} → ${l.to}`);
  if (!links.length) return {};
  return {
    unmarked_delays: {
      links,
      hint:
        "先の要素の式が、元の要素を Delay や Smooth などの時間をまたぐ関数に渡しているのに、遅れの印のないリンクです。" +
        "図で「時間がたってから効く」ことを見せたいなら、upsert_elements で [{type:'LINK', from:'元', to:'先', display:{delay:true}}] を付けます（印は見た目だけ）。",
    },
  };
}

/** ループのつながりを 1 行ずつの文にする（例: "採用 → 新人 (+, フロー)"） */
const VIA_LABEL: Record<LoopStep["via"], string> = { link: "", flow: ", フロー", reference: ", フローの式の参照" };
const stepText = (s: LoopStep) => `${s.from} → ${s.to} (${s.polarity}${VIA_LABEL[s.via]}${s.delay ? ", 遅れ ‖" : ""})`;

const isPrimitive = (v: unknown) => v === null || typeof v !== "object";

/**
 * 読みやすさを保ちつつ短くした JSON。数や文字列だけの配列（時系列の [時刻, 値] など）は 1 行にまとめ、
 * そうした配列が並ぶ配列も、短ければ 1 行にする。
 */
export function formatJSON(value: unknown, indent = ""): string {
  if (isPrimitive(value)) return JSON.stringify(value) ?? "null";
  const inner = indent + "  ";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every(isPrimitive)) return JSON.stringify(value);
    if (value.every((v) => Array.isArray(v) && v.every(isPrimitive))) {
      const line = JSON.stringify(value);
      if (line.length <= 120) return line;
    }
    return `[\n${value.map((v) => inner + formatJSON(v, inner)).join(",\n")}\n${indent}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "{}";
  return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${formatJSON(v, inner)}`).join(",\n")}\n${indent}}`;
}

function ok(data: unknown, compact = false): CallToolResult {
  return { content: [{ type: "text", text: compact ? JSON.stringify(data) : formatJSON(data) }] };
}

/** エラーはどれも { error, issues? } の JSON で返す */
function fail(e: unknown): CallToolResult {
  let body: { error: string; issues?: unknown[] };
  if (e instanceof ModelError) body = e.issues.length ? { error: e.message, issues: e.issues } : { error: e.message };
  else if (e instanceof StoreError || e instanceof EditError || e instanceof ImportError || e instanceof BrowserNotFoundError) body = { error: e.message };
  else body = { error: `予期しないエラー: ${(e as Error)?.message ?? String(e)}` };
  return { isError: true, content: [{ type: "text", text: formatJSON(body) }] };
}

/** 例外を MCP のエラー応答に変える */
function handle<A>(fn: (args: A) => Promise<unknown> | unknown, compact = false) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      const result = await fn(args);
      return isCallToolResult(result) ? result : ok(result, compact);
    } catch (e) {
      return fail(e);
    }
  };
}

function isCallToolResult(v: unknown): v is CallToolResult {
  return !!v && typeof v === "object" && Array.isArray((v as CallToolResult).content);
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? path.join(homedir(), p.slice(1)) : p;
}

/** 取り込むファイルを読む。相対パスは、カレントか作業フォルダから探す */
async function readInputFile(store: ModelStore, p: string): Promise<string> {
  const candidates = path.isAbsolute(p) ? [p] : [path.resolve(p), path.resolve(store.dir, p)];
  for (const c of candidates) {
    try {
      return await readFile(c, "utf8");
    } catch {
      // 次の候補を試す
    }
  }
  throw new ImportError(`ファイルが読めません: ${candidates.join(" / ")}`);
}

/** ファイル名をモデル名に使える形にする */
function toModelName(base: string): string {
  const n = base.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+/, "").trim();
  return n.slice(0, 100) || "model";
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const SERVER_INSTRUCTIONS = `システムダイナミクス（SD）のモデルを作り、実行し、分析するためのツールです（Loopsight）。モデルの形式は Insight Maker の ModelJSON です。
モデルは作業フォルダに ModelJSON ファイル（<モデル名>.json）として保存されます。
関係のあるモデルはサブフォルダにまとめられます（何段でも）。モデル名は作業フォルダからの相対パス（/ 区切り、.json なし。例: ブルックスの法則/brooks_law）で、直下のモデルはファイル名だけです。実際のデータ（<モデル名>.data.csv）はモデルと同じフォルダに置きます。
list_models でモデルとフォルダの一覧を見られます（ビューアの一覧と同じ。作業フォルダの中の実際のフォルダのとおりに並ぶ）。フォルダは create_folder で作り、move_folder で動かし・名前を変え、remove_folder で空のものを消します。モデルは move_model で動かし・名前を変え、remove_model で消します（消すと戻せないので、使う前に人に確かめる）。

進め方:
1. create_model か import_model でモデルを用意する
2. upsert_elements でストック、フロー、変数を追加する。式では他の要素を [名前] で参照する。足りないリンクは自動で追加される
3. 結果に検証エラーが出たら直す。validate_model でも確かめられる
4. run_simulation で実行し、sweep_parameter で感度分析やシナリオ比較をする。人に見せるシナリオは set_scenarios でモデルに保存する（ビューアのグラフに「元のモデル」と重ねて出る）。実際のデータ（実績や観測値）があれば import_data で取り込む。人はビューアのグラフで、モデルの線とデータの点を見比べる
5. 会議などで原因を説明するときは、find_loops でフィードバックループ（R：強める、B：釣り合わせる）を探す。極性が決まっていなければ、upsert_elements で LINK の behavior.polarity を入れる。view_diagram の loop でループを目立たせた図を見られる。時間がたってから効くつながり（発注してから届くまでなど）には、upsert_elements の display.delay: true で遅れの印（‖）を付ける
6. 図の配置を整える。layout_model で座標を付けて保存し、view_diagram で図の画像と、箱の重なり・線が要素や名前の上を通るところ・線の交差・1 か所に集まる線の一覧を見る。気になるところは upsert_elements の display で位置を直し、もう一度 view_diagram で確かめる。説明のときに見てほしい要素（問題になっている在庫など）は、display.emphasis: true で強調すると大きく描かれる。人はビューア（npm run viewer）で同じ図を見ている

式の書き方: 足し算などの演算子、[Stock] のような参照、{5 Meters} のような単位つきの数、IfThenElse(cond, a, b)、Years()、Rand() などの関数が使えます。
insightmaker.com には自動でアクセスしません。`;

export { SERVER_INSTRUCTIONS };

export function registerTools(server: McpServer, store: ModelStore): void {
  /** 保存して、検証の結果を付けて返す */
  async function saveAndCheck(name: string, model: ModelJSON, extra: Record<string, unknown> = {}) {
    const file = await store.write(name, model);
    const validation = validateModel(model);
    return { model: name, file, ...extra, validation };
  }

  server.registerTool(
    "list_models",
    {
      title: "モデル一覧",
      description:
        "作業フォルダにあるモデルと、フォルダの一覧を返す（ビューアの左の欄の一覧と同じもの）。サブフォルダの中も（何段でも）たどる。" +
        "models の name はモデル名（作業フォルダからの相対パス、/ 区切り）、folder はモデルのあるフォルダ（直下なら空の文字列）。" +
        "folders は、中に（サブフォルダの中も含めて）モデルがあるフォルダと、空のフォルダ（models が 0）。親のすぐあとに子が並ぶ。" +
        "モデルでないファイルだけがあるフォルダ（exports/ や output/ のような書き出し先）と、先頭が . のフォルダは出さない。",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    handle(async () => ({ models_dir: store.dir, ...(await store.tree()) })),
  );

  server.registerTool(
    "create_model",
    {
      title: "モデルを作る",
      description:
        "空のモデルを作って保存する。既定のシミュレーション設定は 0 から 100 年、刻み 1、RK1。" +
        "model に「フォルダ/名前」を渡すと、そのフォルダに作る（フォルダがなければ作る）。",
      inputSchema: {
        model: modelName,
        title: z.string().optional().describe("モデルの表示名（省略するとモデル名）"),
        description: z.string().optional(),
        simulation: simulation.optional(),
        overwrite: z.boolean().optional().describe("同じ名前のモデルがあれば上書きする（既定は false）"),
      },
    },
    handle(async (a: { model: string; title?: string; description?: string; simulation?: z.infer<typeof simulation>; overwrite?: boolean }) => {
      if (!a.overwrite && (await store.exists(a.model))) {
        throw new StoreError(`モデル "${a.model}" はすでにあります。上書きするなら overwrite: true を付けてください。`);
      }
      // 表示名を省略したら、フォルダを除いた名前にする
      const m = emptyModel(a.title ?? checkModelName(a.model).split("/").at(-1)!);
      if (a.description) m.description = a.description;
      if (a.simulation) setSimulation(m, a.simulation);
      const file = await store.write(a.model, m);
      return { model: a.model, file, simulation: m.simulation };
    }),
  );

  server.registerTool(
    "import_model",
    {
      title: "モデルを取り込む",
      description:
        "ModelJSON ファイルを取り込んで作業フォルダに保存する。path か content のどちらかを指定する。",
      inputSchema: {
        path: z.string().optional().describe("取り込むファイルのパス（絶対パス、またはカレントか作業フォルダからの相対パス）"),
        content: z.string().optional().describe("ファイルの中身を直接渡す場合"),
        model: z.string().optional().describe("保存するモデル名（省略するとファイル名）。「フォルダ/名前」でそのフォルダに保存する（フォルダがなければ作る）"),
        overwrite: z.boolean().optional(),
      },
    },
    handle(async (a: { path?: string; content?: string; model?: string; overwrite?: boolean }) => {
      let text = a.content;
      let base = a.model;
      if (text === undefined) {
        if (!a.path) throw new ImportError("path か content を指定してください。");
        const p = expandHome(a.path);
        text = await readInputFile(store, p);
        base ??= toModelName(path.basename(p).replace(/\.json$/i, ""));
      }
      // 中身に名前がないときの表示名は、フォルダを除いた名前にする（create_model と同じ）
      const { model, warnings } = importModelText(text, base?.split("/").at(-1));
      // 名前を指定したら、フォルダを含めてそのまま使う（使えない文字があれば断る）。ファイル名などから決めるときは、使えない文字を _ にする
      const name = a.model !== undefined ? checkModelName(a.model) : toModelName(base ?? model.name ?? "imported");
      if (!a.overwrite && (await store.exists(name))) {
        throw new StoreError(`モデル "${name}" はすでにあります。別の名前（model）を付けるか overwrite: true を付けてください。`);
      }
      return saveAndCheck(name, model, { warnings, summary: summarizeModel(model) });
    }),
  );

  server.registerTool(
    "move_model",
    {
      title: "モデルを動かす・名前を変える",
      description:
        "モデルを別のフォルダへ動かすか、名前を変える。to は新しいモデル名（「フォルダ/名前」。直下へ戻すときは名前だけ）。" +
        "付属のファイル（<名前>.data.csv の実際のデータ）もいっしょに動かす。exports/ に書き出したファイルは動かさない。" +
        "行き先のフォルダがなければ作る。行き先に同じ名前のモデル（か付属のファイル）があれば断る。",
      inputSchema: {
        model: modelName,
        to: z.string().min(1).describe("新しいモデル名（例: ブルックスの法則/brooks_law_detailed）"),
      },
    },
    handle(async (a: { model: string; to: string }) => {
      const r = await store.moveModel(a.model, a.to);
      return { model: r.to, from: r.from, files: r.files };
    }),
  );

  server.registerTool(
    "remove_model",
    {
      title: "モデルを消す",
      description:
        "モデルを消す。<名前>.json と、付属のファイル（<名前>.data.csv の実際のデータ）をいっしょに消す。" +
        "exports/ に書き出したファイルは消さない（もう人に送ったかもしれないため）。" +
        "消したファイルは戻せないので、使う前に、どのモデルを消すかを人に伝えて、消してよいか確かめること。",
      inputSchema: { model: modelName },
      annotations: { destructiveHint: true },
    },
    handle(async (a: { model: string }) => {
      const r = await store.removeModel(a.model);
      return { removed: r.model, files: r.files };
    }),
  );

  server.registerTool(
    "create_folder",
    {
      title: "フォルダを作る",
      description:
        "作業フォルダの中に、空のフォルダを作る（「親/子」でサブフォルダも。途中のフォルダがなければ作る）。すでにあれば何もせず created: false を返す。" +
        "空のフォルダもビューアの一覧に出る。モデルをフォルダに作るだけなら、create_model に「フォルダ/名前」を渡せばよい。",
      inputSchema: { folder: folderName },
    },
    handle(async (a: { folder: string }) => store.createFolder(a.folder)),
  );

  server.registerTool(
    "move_folder",
    {
      title: "フォルダを動かす・名前を変える",
      description:
        "フォルダを別の場所へ動かすか、名前を変える（中のモデルと付属のファイル、サブフォルダごと）。to は新しいフォルダ名（作業フォルダからの相対パス）。" +
        "行き先の親のフォルダがなければ作る。行き先に同じ名前のフォルダかファイルがあれば断る。exports/ に書き出したファイルは動かさない。" +
        "結果の models は、動かしたあとのモデル名。",
      inputSchema: {
        folder: folderName,
        to: z.string().min(1).describe("新しいフォルダ名（例: 事例/ブルックスの法則）"),
      },
    },
    handle(async (a: { folder: string; to: string }) => {
      const r = await store.moveFolder(a.folder, a.to);
      return { folder: r.to, from: r.from, models: r.models };
    }),
  );

  server.registerTool(
    "remove_folder",
    {
      title: "空のフォルダを消す",
      description:
        "空のフォルダを消す（空のサブフォルダだけがあるときは、それもいっしょに消す）。中にファイルが 1 つでもあれば消さない。" +
        "中のモデルは、先に remove_model で消すか、move_model でほかへ動かす。",
      inputSchema: { folder: folderName },
    },
    handle(async (a: { folder: string }) => {
      const r = await store.removeFolder(a.folder);
      return { removed: r.folder, dir: r.dir };
    }),
  );

  server.registerTool(
    "layout_model",
    {
      title: "図の配置を付ける",
      description:
        "座標のない要素に、重ならないように座標を付けて保存する（ビューアが座標のない要素を仮に並べるのと同じ簡易レイアウト）。reset: true ですべて並べ直す。強調した要素（display.emphasis）は大きくした箱の大きさで並べる。" +
        "結果に図の確認（重なり、線が要素や名前の上を通るところ、線の交差、1 か所に集まる線）を付ける。直すときは view_diagram で図を見ながら upsert_elements の display で位置を変える。",
      inputSchema: {
        model: modelName,
        reset: z.boolean().optional().describe("いまの座標を捨てて、すべて並べ直す（既定は false）"),
      },
    },
    handle(async (a: { model: string; reset?: boolean }) => {
      const m = await store.read(a.model);
      if (a.reset) {
        for (const el of m.elements) {
          if (!el.display) continue;
          delete el.display.coordinates;
          delete el.display.from_coordinates;
          delete el.display.to_coordinates;
          if (!Object.keys(el.display).length) delete el.display;
        }
      }
      const placed = layoutModel(m);
      const file = await store.write(a.model, m);
      const { positions: _positions, ...check } = checkDiagram(m);
      return { model: a.model, file, placed_elements: placed, diagram: check };
    }),
  );

  server.registerTool(
    "view_diagram",
    {
      title: "図を見る",
      description:
        "モデルの図を、ビューアと同じ描き方で PNG の画像にして返す。あわせて、箱の重なり、線（フロー、リンク）がつながっていない要素の上を通るところ、線の交差、リンクがフローの名前の上を通るところ、1 か所に集まる線（ほぼ同じ向きでつながる線、1 つの弁に集まる多くのリンク）、各要素の位置を返す。" +
        "位置は upsert_elements の display で直す（ストックや変数は display.coordinates が左上、雲はフローの display.from_coordinates / to_coordinates が中心）。" +
        "強調した要素（display.emphasis）は大きく描き、重なりなどの確認もその大きさで行う（positions の size も大きくしたもの）。" +
        "画像には Edge か Chrome が必要（なければ image: false と同じで、一覧だけ返す）。" +
        "loop を渡すと、そのループの要素と線だけを目立たせ、ほかを薄くし、ループの名前と R / B を図の左上に出す（会議などで原因を説明するときの表示）。" +
        "遅れの印（display.delay）のあるリンクやフローは、線の途中に ‖ を描く。先の要素の式が元の要素を Delay や Smooth などの時間をまたぐ関数に渡しているのに印のないリンクがあれば、unmarked_delays で知らせる（自動では付けない）。",
      inputSchema: {
        model: modelName,
        image: z.boolean().optional().describe("画像を付ける（既定は true）。一覧だけでよければ false"),
        loop: z
          .object({
            elements: z.array(z.string()).min(1).describe("ループを作る要素名を、つながる順に（find_loops の elements）"),
            name: z.string().optional().describe("図に出すループの名前（find_loops の name や「増員で遅れが増える」など。省略すると「強めるループ」などの種類の名前）"),
          })
          .optional()
          .describe("目立たせるループ"),
        width: z.number().int().min(400).max(4000).optional().describe("画像の幅（既定 1600）"),
        height: z.number().int().min(300).max(4000).optional().describe("画像の高さ（既定 1000）"),
      },
      annotations: { readOnlyHint: true },
    },
    handle(async (a: { model: string; image?: boolean; width?: number; height?: number; loop?: { elements: string[]; name?: string } }) => {
      const m = await store.read(a.model);
      let loop: LoopView | undefined;
      let loopSteps: string[] | undefined;
      if (a.loop) {
        const found = describeLoop(m, a.loop.elements);
        if ("error" in found) throw new ModelError(`ループになっていません。${found.error}`, []);
        loop = { name: a.loop.name ?? LOOP_KIND_LABEL[found.loop.kind], kind: found.loop.kind, elements: found.loop.elements };
        loopSteps = found.loop.steps.map(stepText);
      }
      const check = {
        model: a.model,
        ...(loop ? { loop: { ...loop, steps: loopSteps } } : {}),
        how_to_move:
          "upsert_elements で [{name:'要素名', display:{coordinates:[x, y]}}]（左上）。雲は [{name:'フロー名', display:{from_coordinates:[x, y]}}]（中心、行き先なら to_coordinates）。y は下向き",
        ...checkDiagram(m),
        ...unmarkedDelaysCheck(m),
      };
      if (a.image === false) return check;
      let png: Buffer;
      try {
        png = await renderDiagram(store, a.model, a.width ?? 1600, a.height ?? 1000, loop);
      } catch (e) {
        return { ...check, image_error: e instanceof BrowserNotFoundError ? e.message : `図を画像にできませんでした: ${(e as Error).message}` };
      }
      return {
        content: [
          { type: "text", text: formatJSON(check) },
          { type: "image", data: png.toString("base64"), mimeType: "image/png" },
        ],
      } satisfies CallToolResult;
    }),
  );

  server.registerTool(
    "get_model",
    {
      title: "モデルを見る",
      description: "モデルの内容を返す。summary（既定）は要素と式とつながりの要約、full は ModelJSON 全体。",
      inputSchema: {
        model: modelName,
        format: z.enum(["summary", "full"]).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (a: { model: string; format?: "summary" | "full" }) => {
      try {
        const m = await store.read(a.model);
        return a.format === "full" ? ok(m, true) : ok({ model: a.model, ...summarizeModel(m) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "find_loops",
    {
      title: "ループを探す",
      description:
        "モデルのフィードバックループ（リンクとフローがつくる因果の循環）を探し、強めるループ（R）か釣り合わせるループ（B）かを返す。" +
        "R か B かはリンクの極性（behavior.polarity）で決める。フローは行き先のストックを増やし（+）、出元のストックを減らす（-）。- が偶数個なら R、奇数個なら B。" +
        "極性が決まっていないつながり（polarity のないリンクや、フローの式がリンクなしで自分のストックを見ているところ）があれば kind は unknown にし、undetermined に挙げる。" +
        "ループは短い順。elements はつながる順で、最後の要素は最初の要素につながる。name（R1、B2 など）は返したループの中での通し番号で、element や max_length を変えると変わる。" +
        "遅れの印（display.delay）のあるリンクやフローを通るループには、delays にそのつながりを挙げる（遅れのある釣り合わせるループ（B）は、行き過ぎて振れやすい）。" +
        "view_diagram の loop に elements を渡すと、そのループを目立たせた図を見られる。",
      inputSchema: {
        model: modelName,
        element: z.string().optional().describe("この要素を通るループだけを返す"),
        max_length: z.number().int().min(1).optional().describe("返すループの要素数の上限"),
      },
      annotations: { readOnlyHint: true },
    },
    handle(async (a: { model: string; element?: string; max_length?: number }) => {
      const m = await store.read(a.model);
      if (a.element !== undefined && !findElement(m, a.element)) {
        const names = m.elements.filter((e) => e.type !== "LINK" && e.name).map((e) => e.name!);
        throw new EditError(`要素 "${a.element}" が見つかりません。${didYouMean(a.element, names)}`);
      }
      const { loops, truncated } = findLoops(m, { element: a.element, maxLength: a.max_length });
      const undetermined = (steps: LoopStep[]) => steps.filter((s) => s.polarity === "?").map(stepText);
      const anyUndetermined = loops.some((l) => l.kind === "unknown");
      return {
        model: a.model,
        count: { R: loops.filter((l) => l.kind === "R").length, B: loops.filter((l) => l.kind === "B").length, unknown: loops.filter((l) => l.kind === "unknown").length },
        loops: loops.map((l) => {
          const u = undetermined(l.steps);
          const delays = l.steps.filter((s) => s.delay).map(stepText);
          return { name: l.name, kind: l.kind, elements: l.elements, steps: l.steps.map(stepText), ...(u.length ? { undetermined: u } : {}), ...(delays.length ? { delays } : {}) };
        }),
        ...(truncated
          ? {
              truncated:
                (truncated === "loops"
                  ? `ループが多いため、${MAX_LOOPS} 個で探すのをやめました。`
                  : "つながりが多く、探すのに時間がかかるため、途中で探すのをやめました。") +
                "短いループから探しているので、返した中で最も長いものと同じ長さか、それより長いループが残っているかもしれません。element（その要素を通るループだけを探す）か max_length で絞ってください。",
            }
          : {}),
        ...(anyUndetermined
          ? {
              hint:
                "極性が決まっていないつながりがあります。upsert_elements で LINK の behavior.polarity（POSITIVE か NEGATIVE）を入れると、R か B かが決まります。" +
                "フローの式がリンクなしで自分のストックを見ているところは、そのストックからフローへの LINK を polarity つきで足します。",
            }
          : {}),
      };
    }),
  );

  server.registerTool(
    "upsert_elements",
    {
      title: "要素を追加・更新する",
      description:
        "要素をまとめて追加・更新して保存する。LINK 以外は name で既存の要素を探し、あれば behavior と display を重ね、なければ追加する。LINK は from と to の組で探す。" +
        "式が [名前] で参照しているのにリンクがない場合は、auto_link が false でなければリンクを自動で追加する。保存後の検証結果を返す。" +
        "例: [{type:'STOCK', name:'Population', behavior:{initial_value:100}}, {type:'VARIABLE', name:'Birth Rate', behavior:{value:0.03}}, " +
        "{type:'FLOW', name:'Births', from:null, to:'Population', behavior:{value:'[Population]*[Birth Rate]'}}]",
      inputSchema: {
        model: modelName,
        elements: z.array(elementPatch).min(1),
        auto_link: z.boolean().optional().describe("足りないリンクを自動で追加する（既定は true）"),
      },
    },
    handle(async (a: { model: string; elements: ElementPatch[]; auto_link?: boolean }) => {
      const m = await store.read(a.model);
      const before = namesByElement(m);
      const report = upsertElements(m, a.elements, { autoLink: a.auto_link });
      const result = await saveAndCheck(a.model, m, { changes: report });
      // CSV を直せなくても、モデルはもう保存してあるので成功として返し、知らせだけ添える
      const renamed = renamesSince(m, before);
      const data = await store.renameDataColumns(a.model, renamed);
      if (data.note) report.notes.push(data.note);
      if (data.warning) report.notes.push(data.warning);
      return result;
    }),
  );

  server.registerTool(
    "remove_elements",
    {
      title: "要素を削除する",
      description:
        "要素を削除して保存する。消した要素につながるリンクも消す。ストックを消すと、つながっていたフローは残して端を空（モデルの外）にする（cascade_flows: true なら一緒に消す）。" +
        "LINK は {from, to} で指定する。",
      inputSchema: {
        model: modelName,
        elements: z
          .array(z.object({ name: z.string().optional(), from: z.string().optional(), to: z.string().optional() }))
          .min(1)
          .describe("[{name:'X'}] または LINK なら [{from:'A', to:'B'}]"),
        cascade_flows: z.boolean().optional(),
      },
    },
    handle(async (a: { model: string; elements: { name?: string; from?: string; to?: string }[]; cascade_flows?: boolean }) => {
      const m = await store.read(a.model);
      const report = removeElements(m, a.elements, { cascadeFlows: a.cascade_flows });
      return saveAndCheck(a.model, m, { changes: report });
    }),
  );

  server.registerTool(
    "set_simulation",
    {
      title: "シミュレーション設定",
      description: "開始時刻、期間、刻み幅、解法、時間の単位を設定して保存する。指定しなかった項目はそのまま。",
      inputSchema: { model: modelName, ...simulationShape },
    },
    handle(async (a: { model: string } & z.infer<typeof simulation>) => {
      const { model, ...patch } = a;
      const m = await store.read(model);
      const sim = setSimulation(m, patch);
      return saveAndCheck(model, m, { simulation: sim });
    }),
  );

  server.registerTool(
    "set_scenarios",
    {
      title: "シナリオを保存する",
      description:
        "シナリオをモデルの scenarios に保存する。シナリオは名前、説明、変える値の組 { 要素名: 値 }（STOCK は初期値、VARIABLE と FLOW は式を置き換える）。" +
        `名前で既存のシナリオを探し、あれば説明と値を重ね（値を null にするとその要素は変えない）、なければ追加する。remove で消し、replace: true で今のシナリオをすべて置き換える。` +
        `何も変えない実行は「${BASELINE_SCENARIO}」として扱う（保存しなくてよい）。ビューアのグラフでは「${BASELINE_SCENARIO}」と各シナリオが重なって出る。` +
        `結果に、「${BASELINE_SCENARIO}」と各シナリオの初期値・最終値・最小・最大の比較を付ける。`,
      inputSchema: {
        model: modelName,
        scenarios: z
          .array(
            z.object({
              name: z.string().describe("シナリオ名。既存の名前なら更新、なければ追加"),
              rename_to: z.string().optional().describe("既存のシナリオの名前を変える"),
              description: z.string().nullable().optional().describe("どんなシナリオか（null で消す）"),
              values: z.record(z.string(), equation.nullable()).optional().describe("変える値 { 要素名: 値 }。既存の値に重ねる（null でその要素は変えない）"),
            }),
          )
          .optional()
          .describe("[{name:'広告を増やす', description:'広告費を 2 倍にする', values:{'Ad Budget':200}}, ...]"),
        remove: z.array(z.string()).optional().describe("消すシナリオの名前"),
        replace: z.boolean().optional().describe("今のシナリオをすべて捨ててから scenarios を保存する（既定は false）"),
        elements: targets,
      },
    },
    handle(async (a: { model: string; scenarios?: ScenarioPatch[]; remove?: string[]; replace?: boolean; elements?: string[] }) => {
      if (!a.scenarios?.length && !a.remove?.length && !a.replace) throw new EditError("scenarios か remove を指定してください。");
      const m = await store.read(a.model);
      const report = setScenarios(m, a.scenarios ?? [], { remove: a.remove, replace: a.replace });
      const extra: Record<string, unknown> = { changes: report, scenarios: m.scenarios ?? [] };
      // 実行できないシナリオは保存しない（エラーのあるモデルは、検証結果で知らせる）
      if (m.scenarios?.length && staticCheck(m).errors.length === 0) {
        const { targets: names, time_units, rows } = compareScenarios(m, withBaseline(modelScenarios(m)), { targets: a.elements });
        extra.comparison = { targets: names, time_units, rows };
      }
      return saveAndCheck(a.model, m, extra);
    }),
  );

  server.registerTool(
    "validate_model",
    {
      title: "モデルを検証する",
      description: "モデルのエラーと警告を返す。式の参照、リンクの不足、つながりの誤り、式の文法などを確かめ、試しに実行もする。",
      inputSchema: { model: modelName },
      annotations: { readOnlyHint: true },
    },
    handle(async (a: { model: string }) => validateModel(await store.read(a.model))),
  );

  server.registerTool(
    "run_simulation",
    {
      title: "実行する",
      description:
        "モデルを実行して、要素ごとに初期値・最終値・最小・最大とその時刻、間引いた時系列を返す。overrides と simulation で一時的に値を変えられる（ファイルは変わらない）。" +
        "csv: true で全データを作業フォルダの output/ に CSV で保存する。",
      inputSchema: {
        model: modelName,
        elements: targets,
        samples: z.number().int().min(0).max(200).optional().describe("返す時系列の点数（既定 11、0 で時系列なし）"),
        overrides: overrides.optional(),
        simulation: simulation.optional().describe("一時的に変えるシミュレーション設定"),
        csv: z.boolean().optional().describe("全データを CSV に保存する"),
        csv_path: z.string().optional().describe("CSV の保存先（作業フォルダからの相対パス）。指定すると csv: true と同じ"),
      },
      annotations: { readOnlyHint: false },
    },
    handle(
      async (a: {
        model: string;
        elements?: string[];
        samples?: number;
        overrides?: Record<string, string | number | boolean>;
        simulation?: z.infer<typeof simulation>;
        csv?: boolean;
        csv_path?: string;
      }) => {
        const m = await store.read(a.model);
        const names = resolveTargets(m, a.elements);
        const data = runModel(m, { overrides: a.overrides, simulation: a.simulation });
        const summary: Record<string, unknown> = { model: a.model, ...summarizeRun(data, names, a.samples ?? 11) };
        if (a.overrides) summary.overrides = a.overrides;
        // 因果ループ図のように結果が 0 ばかりになる理由を、実行結果にも添える
        const { warnings } = staticCheck(m);
        if (warnings.length) summary.warnings = warnings;
        if (a.csv || a.csv_path) {
          const rel = a.csv_path ?? path.join("output", `${a.model}-${timestamp()}.csv`);
          // BOM を付けて、Excel でも日本語の要素名が文字化けしないようにする
          summary.csv = await store.writeTextFile(store.resolveInside(rel), "﻿" + runToCSV(data));
        }
        return summary;
      },
    ),
  );

  server.registerTool(
    "sweep_parameter",
    {
      title: "パラメータを振って比較する",
      description:
        "感度分析とシナリオ比較。次のどれかを指定する: " +
        "(1) parameter と values（または from, to, steps）で 1 つの値を振る、" +
        "(2) scenarios で複数の値をまとめて変えた組を比べる、" +
        `(3) どちらもなければモデルに保存されたシナリオ（set_scenarios）を「${BASELINE_SCENARIO}」と並べて比べる（overrides は各シナリオにだけ当て、「${BASELINE_SCENARIO}」には当てない）。` +
        "結果は組ごとに、指定した要素の初期値・最終値・最小・最大を返す。",
      inputSchema: {
        model: modelName,
        parameter: z.string().optional().describe("振る要素の名前（STOCK なら初期値、VARIABLE と FLOW なら値）"),
        values: z.array(equation).optional().describe("試す値の一覧"),
        from: z.number().optional(),
        to: z.number().optional(),
        steps: z.number().int().optional().describe("from から to を何点に分けるか（既定 5）"),
        scenarios: z
          .array(z.object({ name: z.string(), overrides: z.record(z.string(), equation) }))
          .optional()
          .describe("[{name:'高成長', overrides:{'Birth Rate':0.05}}, ...]"),
        overrides: overrides.optional().describe("すべての組に共通で当てる上書き（保存したシナリオと比べるときの「元のモデル」には当てない）"),
        elements: targets,
        samples: z.number().int().min(0).max(50).optional().describe("組ごとに返す時系列の点数（既定 0）"),
        simulation: simulation.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handle(
      async (a: {
        model: string;
        parameter?: string;
        values?: (string | number | boolean)[];
        from?: number;
        to?: number;
        steps?: number;
        scenarios?: { name: string; overrides: Record<string, string | number | boolean> }[];
        overrides?: Record<string, string | number | boolean>;
        elements?: string[];
        samples?: number;
        simulation?: z.infer<typeof simulation>;
      }) => {
        const m = await store.read(a.model);
        const opts = { targets: a.elements, samples: a.samples, simulation: a.simulation };
        if (a.parameter) {
          const values = a.values?.length ? a.values : sweepValues({ from: a.from, to: a.to, steps: a.steps });
          return { model: a.model, parameter: a.parameter, ...sweepParameter(m, a.parameter, values, { ...opts, baseOverrides: a.overrides }) };
        }
        const fromModel = !a.scenarios?.length;
        const scenarios = fromModel ? modelScenarios(m) : a.scenarios!;
        if (!scenarios.length) {
          throw new ModelError("比べるものがありません。parameter か scenarios を指定してください（モデルにもシナリオが保存されていません）。", []);
        }
        const withBase = scenarios.map((s) => ({ name: s.name, overrides: { ...(a.overrides ?? {}), ...s.overrides } }));
        // 保存したシナリオと比べるときの「元のモデル」は、名前どおり何も変えない（overrides も当てない）
        return { model: a.model, ...compareScenarios(m, fromModel ? withBaseline(withBase) : withBase, opts) };
      },
    ),
  );

  server.registerTool(
    "import_data",
    {
      title: "実際のデータを取り込む",
      description:
        "実際のデータ（観測値や実績）の CSV を取り込み、作業フォルダの <モデル名>.data.csv に保存する。ビューアのグラフで、要素の線に点で重ねて描く。path か content のどちらかを指定する。" +
        "1 行目は見出しで、1 列目が時刻、ほかの列が要素名（Excel から貼ったタブ区切りも読む）。空欄は値なし。" +
        "要素名と合わない列は warnings に「もしかして」を付けて返す（保存はする）。要素の名前を upsert_elements で変えると、列名も直す。",
      inputSchema: {
        model: modelName,
        path: z.string().optional().describe("取り込む CSV のパス（絶対パス、またはカレントか作業フォルダからの相対パス）"),
        content: z.string().optional().describe("CSV の中身を直接渡す場合"),
      },
    },
    handle(async (a: { model: string; path?: string; content?: string }) => {
      const m = await store.read(a.model);
      let text = a.content;
      if (text === undefined) {
        if (!a.path) throw new ImportError("path か content を指定してください。");
        text = await readInputFile(store, expandHome(a.path));
      }
      const data = parseDataCSV(text);
      const warnings = checkActualData(m, data);
      const file = await store.writeData(a.model, dataToCSV(data));
      return {
        model: a.model,
        file,
        columns: data.columns.map((c) => c.name),
        rows: data.times.length,
        ...(data.times.length ? { time_range: [data.times[0], data.times.at(-1)] } : {}),
        warnings,
      };
    }),
  );
}

/** ビルドした画面（dist/web）。ビルドしたものは dist/mcp/tools.js、テストではソースの src/mcp/tools.ts から探す */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = [path.resolve(HERE, "../web"), path.resolve(HERE, "../../dist/web")].find((d) => existsSync(path.join(d, "index.html"))) ?? path.resolve(HERE, "../web");

/** ビューアを一時的に起動し、ヘッドレスのブラウザで図だけを描いて PNG にする */
async function renderDiagram(store: ModelStore, name: string, width: number, height: number, loop?: LoopView): Promise<Buffer> {
  if (!existsSync(path.join(WEB_DIR, "index.html"))) throw new Error("画面がビルドされていません。npm run build を実行してください。");
  const viewer = await startViewer({ modelsDir: store.dir, staticDir: WEB_DIR, port: 0 });
  try {
    const browser = await launchBrowser();
    try {
      await browser.setViewport(width, height);
      const query = loop ? `&loop=${encodeURIComponent(JSON.stringify(loop))}` : "";
      await browser.open(`${viewer.url}?view=diagram${query}#${encodeURIComponent(name)}`);
      return await browser.screenshot();
    } finally {
      await browser.close();
    }
  } finally {
    await viewer.close();
  }
}
