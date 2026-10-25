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
  ELEMENT_TYPES,
  EditError,
  GROUP_COLORS,
  ImportError,
  LOOP_KIND_LABEL,
  MAX_LOOPS,
  ModelError,
  ModelStore,
  StoreError,
  TIME_UNITS,
  applyOverrides,
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
  setAnnotations,
  setGroups,
  setScenarios,
  setSimulation,
  staticCheck,
  summarizeModel,
  summarizeRun,
  unmarkedDelays,
  upsertElements,
  validateModel,
  withBaseline,
  type AnnotationPatch,
  type ElementPatch,
  type GroupPatch,
  type LoopStep,
  type LoopView,
  type ModelJSON,
  type ScenarioPatch,
} from "../core/index.js";
import { BrowserNotFoundError, launchBrowser } from "../viewer/browser.js";
import { DIAGRAM_FILE_BASE, checkFileBase, exportFolderOf, writeDiagramImages } from "../viewer/diagram-export.js";
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
  type: z.enum(ELEMENT_TYPES).optional().describe("新しく追加するときは必須"),
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
        "強調できるのはストック、変数、コンバーター。付け外ししても箱の真ん中の位置は変わらない（coordinates も一緒に指定したときはそれに従う）。シミュレーションには影響しない。" +
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
4. run_simulation で実行する。値を振って調べる（感度分析）ときや、いくつかの値をまとめて変えて比べるときは、run_simulation の overrides を変えて何回か実行する。人に見せるシナリオは set_scenarios でモデルに保存する（ビューアのグラフに「元のモデル」と重ねて出る）。保存したシナリオは run_simulation の scenarios: true で「元のモデル」と並べて読める。実際のデータ（実績や観測値）があれば import_data で取り込む。人はビューアのグラフで、モデルの線とデータの点を見比べる
5. 会議などで原因を説明するときは、find_loops でフィードバックループ（R：強める、B：釣り合わせる）を探す。極性が決まっていなければ、upsert_elements で LINK の behavior.polarity を入れる。view_diagram の loop でループを目立たせた図を見られる。時間がたってから効くつながり（発注してから届くまでなど）には、upsert_elements の display.delay: true で遅れの印（‖）を付ける
6. 図の配置を整える。layout_model で座標を付けて保存し、view_diagram で図の画像と、箱の重なり・線が要素や名前の上を通るところ・線の交差・1 か所に集まる線の一覧を見る。気になるところは upsert_elements の display で位置を直し、もう一度 view_diagram で確かめる。説明のときに見てほしい要素（問題になっている在庫など）は、display.emphasis: true で強調すると大きく描かれる。人はビューア（npm run viewer）で同じ図を見ている。要素の補足や図の読み方は、set_annotations で説明する箱の近くに注釈（文字だけのもの）として置ける
   要素が多いときは、set_groups で意味のまとまり（「お店側」「お客側」など）をグループにする。図では属する要素が薄い色の背景で囲まれ、凡例が出る。layout_model は同じグループの要素を近くに集めて並べる
7. 図だけを資料（PDF やスライド）に貼るときは、export_diagram で SVG と PNG に書き出す（既定は exports/<モデル名>/diagram.svg と diagram.png）。人はビューアの図の右上の「書き出す」ボタンで同じものを書き出せる

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
        "グループ（set_groups）があれば、同じグループの要素が近くに集まるように並べる。" +
        "注釈（set_annotations）は動かさない。箱は注釈を避けて置くが、雲やフローの線・名前は注釈に重なることがあるので、view_diagram で確かめて直す。" +
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
        "モデルの図を、ビューアと同じ描き方で PNG の画像にして返す。あわせて、箱の重なり（注釈も含む）、線（フロー、リンク）がつながっていない要素や注釈の上を通るところ、線の交差、リンクがフローの名前の上を通るところ、1 か所に集まる線（ほぼ同じ向きでつながる線、1 つの弁に集まる多くのリンク）、" +
        "グループ（set_groups）の囲みどうしの重なりとグループに属さない要素が囲みに入っているところ（group_issues）、グループの囲みの範囲（groups）、各要素の位置を返す。" +
        "位置は upsert_elements の display で直す（ストックや変数は display.coordinates が左上、雲はフローの display.from_coordinates / to_coordinates が中心）。" +
        "注釈（positions の type が NOTE）は set_annotations の coordinates（左上）で直す。" +
        "強調した要素（display.emphasis）は大きく描き、重なりなどの確認もその大きさで行う（positions の size も大きくしたもの）。" +
        "画像には Edge か Chrome が必要（なければ image: false と同じで、一覧だけ返す）。" +
        "loop を渡すと、そのループの要素と線だけを目立たせ、ほかを薄くし、ループの名前と R / B を図の左上に出す（会議などで原因を説明するときの表示）。" +
        "遅れの印（display.delay）のあるリンクやフローは、線の途中に ‖ を描く。先の要素の式が元の要素を Delay や Smooth などの時間をまたぐ関数に渡しているのに印のないリンクがあれば、unmarked_delays で知らせる（自動では付けない）。" +
        "資料に貼る図の画像をファイルにするときは export_diagram を使う。",
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
          "upsert_elements で [{name:'要素名', display:{coordinates:[x, y]}}]（左上）。雲は [{name:'フロー名', display:{from_coordinates:[x, y]}}]（中心、行き先なら to_coordinates）。注釈は set_annotations で [{id:'注釈1', coordinates:[x, y]}]（左上）。y は下向き",
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
    "export_diagram",
    {
      title: "図を画像に書き出す",
      description:
        "モデルの図だけを、資料（PDF やスライド）に貼る画像にして、作業フォルダの中のフォルダに書き出す。ビューアの図の「書き出す」ボタンと同じ描き方で、画面の図をそのまま写す。" +
        "書き出し先は既定で exports/<モデル名>/（フォルダにあるモデルは exports/<フォルダ>/<名前>/）で、ファイルは <name>.svg と <name>.png（name の既定は diagram。同じ名前のファイルは置き換える）。" +
        "SVG は拡大してもぼやけない（文字も <text> のまま）。PNG は scale 倍の解像度（既定 2）。背景は白で、いつも明るい配色。" +
        "全体図・ズームのボタン・背景の点などの操作用の部品は入れず、図全体が収まるように切り取る。" +
        "loop を渡すと、view_diagram の loop と同じく、そのループを目立たせ、ループの名前と R / B の札を図の上に付ける。ループごとに name を変えると、別のファイルに残せる。" +
        "Edge か Chrome が必要。",
      inputSchema: {
        model: modelName,
        loop: z
          .object({
            elements: z.array(z.string()).min(1).describe("ループを作る要素名を、つながる順に（find_loops の elements）"),
            name: z.string().optional().describe("図に出すループの名前（省略すると「強めるループ」などの種類の名前）"),
          })
          .optional()
          .describe("目立たせるループ"),
        formats: z.array(z.enum(["svg", "png"])).min(1).optional().describe("書き出す形式（既定は両方）"),
        scale: z.number().min(1).max(4).optional().describe("PNG の解像度の倍率（既定 2。図が大きいときは、長い辺が 8000 px に収まるよう下げる）"),
        path: z.string().optional().describe("書き出すフォルダ。作業フォルダからの相対パス（既定は exports/<モデル名>。フォルダにあるモデルは exports/<フォルダ>/<名前>）"),
        name: z.string().optional().describe("ファイル名（拡張子なし。既定は diagram）"),
      },
    },
    handle(async (a: { model: string; loop?: { elements: string[]; name?: string }; formats?: ("svg" | "png")[]; scale?: number; path?: string; name?: string }) => {
      const m = await store.read(a.model);
      let loop: LoopView | undefined;
      if (a.loop) {
        const found = describeLoop(m, a.loop.elements);
        if ("error" in found) throw new ModelError(`ループになっていません。${found.error}`, []);
        loop = { name: a.loop.name ?? LOOP_KIND_LABEL[found.loop.kind], kind: found.loop.kind, elements: found.loop.elements };
      }
      const rel = a.path ?? exportFolderOf(a.model);
      const base = checkFileBase(a.name ?? DIAGRAM_FILE_BASE);
      // 書き出し先は、描く前（ブラウザを起動する前）に確かめる
      if (/\.(svg|png)$/i.test(rel)) throw new StoreError(`path には書き出すフォルダを指定してください（"${rel}" は画像のファイル名に見えます。ファイル名は name で指定します）。`);
      const target = store.resolveInside(rel);
      if (path.relative(store.dir, target) === "") throw new StoreError("作業フォルダそのものには書き出せません。exports/<モデル名> のようなフォルダを指定してください。");
      const formats = new Set(a.formats ?? ["svg", "png"]);
      let image: RenderedDiagram;
      try {
        image = await renderDiagramExport(store, a.model, a.scale ?? 2, loop);
      } catch (e) {
        if (e instanceof BrowserNotFoundError) throw e;
        throw new StoreError(`図を画像にできませんでした: ${(e as Error).message}`);
      }
      const { dir, files } = await writeDiagramImages(store, rel, base, {
        svg: formats.has("svg") ? image.svg : undefined,
        png: formats.has("png") ? Buffer.from(image.png, "base64") : undefined,
      });
      return {
        model: a.model,
        dir,
        files,
        size: { width: image.width, height: image.height },
        ...(formats.has("png") ? { png_size: { width: Math.round(image.width * image.scale), height: Math.round(image.height * image.scale) }, png_scale: image.scale } : {}),
        ...(loop ? { loop } : {}),
        next_step: "SVG は PDF やスライドに貼っても、拡大してぼやけません。SVG を貼れないアプリには PNG を使えます。",
      };
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
    "set_groups",
    {
      title: "図のグループを保存する",
      description:
        "図のグループをモデルの groups に保存する（シミュレーションには影響しない）。グループは名前、色、属する要素の組。図では属する要素をまとめて薄い色の長方形で囲み、隅に名前を出し、図の端に凡例（色と名前の一覧）を出す。" +
        "囲みの位置と大きさは要素の位置から自動で決まる。ビューアの図と view_diagram の図の両方に出る（図の部品は共通）。" +
        `色は ${GROUP_COLORS.join("、")} のどれか（省略すると、ほかのグループが使っていない色）。1 つの要素が属するグループは 1 つまでで、ほかのグループに属する要素を足すとそちらから移す。` +
        "名前で既存のグループを探し、あれば重ね、なければ追加する。remove で消し、replace: true で今のグループをすべて置き換える。要素の名前を変えたり消したりすると、グループの中身も合わせて直る。" +
        "並べ直すときは layout_model（reset: true）で、同じグループの要素が近くに集まる。view_diagram の group_issues で、囲みどうしの重なりや、グループに属さない要素が囲みに入っているところを確かめる。",
      inputSchema: {
        model: modelName,
        groups: z
          .array(
            z.object({
              name: z.string().describe("グループ名。既存の名前なら更新、なければ追加"),
              rename_to: z.string().optional().describe("既存のグループの名前を変える"),
              color: z.enum(GROUP_COLORS).optional().describe("背景の色"),
              elements: z.array(z.string()).optional().describe("属する要素をこの並びに置き換える（LINK 以外の要素名）"),
              add_elements: z.array(z.string()).optional().describe("属する要素に足す"),
              remove_elements: z.array(z.string()).optional().describe("属する要素から外す"),
            }),
          )
          .optional()
          .describe("[{name:'お店側', color:'green', elements:['在庫','仕入れ']}, ...]"),
        remove: z.array(z.string()).optional().describe("消すグループの名前"),
        replace: z.boolean().optional().describe("今のグループをすべて捨ててから groups を保存する（既定は false）"),
      },
    },
    handle(async (a: { model: string; groups?: GroupPatch[]; remove?: string[]; replace?: boolean }) => {
      if (!a.groups?.length && !a.remove?.length && !a.replace) throw new EditError("groups か remove を指定してください。");
      const m = await store.read(a.model);
      const report = setGroups(m, a.groups ?? [], { remove: a.remove, replace: a.replace });
      const file = await store.write(a.model, m);
      const { group_issues, groups } = checkDiagram(m);
      return {
        model: a.model,
        file,
        changes: report,
        groups: m.groups ?? [],
        diagram: { group_issues, ...(groups ? { areas: groups.map((g) => ({ name: g.name, ...g.area })) } : {}) },
        next_step: "view_diagram で図を見て確かめてください。グループの要素が離れているときは、layout_model（reset: true）で並べ直すと近くに集まります。",
      };
    }),
  );

  server.registerTool(
    "set_annotations",
    {
      title: "図の注釈を置く",
      description:
        "図に注釈（どこにもつながらない、文字だけのもの）を置いて保存する。要素の補足や「この図の読み方」を、説明する箱の近くに書くのに使う。" +
        "注釈はシミュレーションの要素ではない（式から参照できず、ループや検証、グラフの要素の一覧には出ない）。モデルの annotations に保存し、Insight Maker に読み込ませると消える。" +
        "id で既存の注釈を探し、あれば重ね、なければ足す（id を省くと「注釈1」のように付ける）。remove で消し、replace: true で今の注釈をすべて置き換える。" +
        "文字は決まった幅（既定 200）で折り返し、改行（\n）で行を分けられる。coordinates は左上。新しい注釈で省くと、図の下に置く。" +
        "ビューアの図と view_diagram の図の両方に出る（図の部品は共通）。layout_model は注釈を動かさない（箱は注釈を避けて置くが、雲やフローの線・名前は重なることがあるので、view_diagram で確かめて直す）。" +
        "結果の diagram_issues に、注釈と要素・線の重なりを返す。view_diagram で図を見て、重なっていれば coordinates を直す。" +
        "図の左上は、ループを目立たせる表示（view_diagram の loop）でループの名前の札に隠れることがあるので、左上の角は避ける。" +
        "色の説明（凡例）は注釈で作らない。",
      inputSchema: {
        model: modelName,
        annotations: z
          .array(
            z.object({
              id: z.string().optional().describe("注釈の id。既存の id なら直し、なければ足す。省くと新しく足す"),
              text: z.string().optional().describe("文字。改行で行を分けられる。新しく足すときは必須"),
              coordinates: z.tuple([z.number(), z.number()]).optional().describe("左上の座標 [x, y]（y は下向き）。新しい注釈で省くと図の下に置く"),
              width: z.number().nullable().optional().describe("折り返す幅（60〜800。既定 200）。null で既定に戻す"),
            }),
          )
          .optional()
          .describe("[{text:'外から人が入ってくると人口は増える', coordinates:[100, 40]}, {id:'注釈1', coordinates:[300, 40]}]"),
        remove: z.array(z.string()).optional().describe("消す注釈の id"),
        replace: z.boolean().optional().describe("今の注釈をすべて捨ててから annotations を保存する（既定は false）"),
      },
    },
    handle(async (a: { model: string; annotations?: AnnotationPatch[]; remove?: string[]; replace?: boolean }) => {
      if (!a.annotations?.length && !a.remove?.length && !a.replace) throw new EditError("annotations か remove を指定してください。");
      const m = await store.read(a.model);
      const report = setAnnotations(m, a.annotations ?? [], { remove: a.remove, replace: a.replace });
      const file = await store.write(a.model, m);
      const check = checkDiagram(m);
      const issues = [...check.overlaps, ...check.lines_through_elements].filter((t) => t.includes("注釈 "));
      return {
        model: a.model,
        file,
        changes: report,
        annotations: check.positions.filter((p) => p.type === "NOTE"),
        ...(issues.length ? { diagram_issues: issues } : {}),
      };
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
        "値を振って調べる（感度分析）ときは、overrides を変えて何回か実行する。" +
        "csv: true で全データを作業フォルダの output/ に CSV で保存する。" +
        `scenarios: true で、モデルに保存したシナリオ（set_scenarios）も実行し、「${BASELINE_SCENARIO}」と各シナリオの結果を rows に並べて返す（ビューアのシナリオの比較と同じ値）。` +
        `このとき overrides は各シナリオにだけ当て、「${BASELINE_SCENARIO}」には当てない。実行できないシナリオは、その行の error と issues に理由を入れる。`,
      inputSchema: {
        model: modelName,
        elements: targets,
        samples: z.number().int().min(0).max(200).optional().describe("返す時系列の点数（既定 11、0 で時系列なし）"),
        overrides: overrides.optional(),
        simulation: simulation.optional().describe("一時的に変えるシミュレーション設定"),
        csv: z.boolean().optional().describe("全データを CSV に保存する"),
        csv_path: z.string().optional().describe("CSV の保存先（作業フォルダからの相対パス）。指定すると csv: true と同じ"),
        scenarios: z.boolean().optional().describe(`保存したシナリオも実行して「${BASELINE_SCENARIO}」と並べる（csv とは一緒に使えない）`),
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
        scenarios?: boolean;
      }) => {
        const m = await store.read(a.model);
        if (a.scenarios) return compareSaved(m, a);
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

  /** run_simulation の scenarios: true。「元のモデル」と保存したシナリオを並べる（set_scenarios の comparison と同じ形） */
  function compareSaved(
    m: ModelJSON,
    a: {
      model: string;
      elements?: string[];
      samples?: number;
      overrides?: Record<string, string | number | boolean>;
      simulation?: z.infer<typeof simulation>;
      csv?: boolean;
      csv_path?: string;
    },
  ): Record<string, unknown> {
    if (a.csv || a.csv_path) throw new ModelError("csv と scenarios は一緒に使えません。CSV がほしいときは scenarios を外して実行してください。", []);
    const saved = modelScenarios(m);
    if (!saved.length) throw new ModelError("モデルにシナリオが保存されていません。set_scenarios で保存してください。", []);
    // 渡された overrides の要素名の間違いは、シナリオごとの失敗ではないので、全体をエラーにする（候補つき）
    if (a.overrides) applyOverrides(m, { overrides: a.overrides });
    // 「元のモデル」は名前どおり何も変えない（overrides も当てない）
    const scenarios = withBaseline(saved.map((s) => ({ name: s.name, overrides: { ...(a.overrides ?? {}), ...s.overrides } })));
    const comparison = compareScenarios(m, scenarios, { targets: a.elements, samples: a.samples ?? 11, simulation: a.simulation, keepErrors: true });
    const out: Record<string, unknown> = { model: a.model, ...comparison };
    if (a.overrides) out.overrides = a.overrides;
    const { warnings } = staticCheck(m);
    if (warnings.length) out.warnings = warnings;
    return out;
  }

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

/** 図を書き出した画像。png は base64、width と height は SVG の大きさ（px）、scale は PNG の倍率 */
interface RenderedDiagram {
  svg: string;
  png: string;
  width: number;
  height: number;
  scale: number;
}

/**
 * ビューアを一時的に起動し、ヘッドレスのブラウザで図だけの表示を開いて、ビューアの「書き出す」ボタンと同じ処理（web/src/diagramExport.ts）で SVG と PNG にする。
 * 画面の大きさは、書き出す画像の大きさに関係しない（図全体を図の座標で書き出す）
 */
async function renderDiagramExport(store: ModelStore, name: string, scale: number, loop?: LoopView): Promise<RenderedDiagram> {
  if (!existsSync(path.join(WEB_DIR, "index.html"))) throw new Error("画面がビルドされていません。npm run build を実行してください。");
  const viewer = await startViewer({ modelsDir: store.dir, staticDir: WEB_DIR, port: 0 });
  try {
    const browser = await launchBrowser();
    try {
      await browser.setViewport(1600, 1000);
      const query = loop ? `&loop=${encodeURIComponent(JSON.stringify(loop))}` : "";
      await browser.open(`${viewer.url}?view=diagram${query}#${encodeURIComponent(name)}`);
      return await browser.evaluate<RenderedDiagram>(`window.loopsightExportDiagram(${JSON.stringify(scale)})`);
    } finally {
      await browser.close();
    }
  } finally {
    await viewer.close();
  }
}
