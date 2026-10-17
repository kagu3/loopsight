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
  LOOP_POLARITIES,
  ImportError,
  LOOP_KIND_LABEL,
  MAX_LOOPS,
  ModelError,
  ModelStore,
  StoreError,
  TIME_UNITS,
  addBoxSizes,
  addDefaultVisualization,
  checkActualData,
  checkDiagram,
  checkSlides,
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
  namesByScenario,
  parseDataCSV,
  parseSlides,
  removeElements,
  renamesSince,
  resolveTargets,
  runModel,
  runToCSV,
  scenarioRenamesSince,
  setScenarios,
  setSimulation,
  staticCheck,
  summarizeModel,
  summarizeRun,
  sweepParameter,
  sweepValues,
  toSlideDeck,
  upsertElements,
  validateModel,
  withBaseline,
  SLIDE_KIND_LABEL,
  type ActualData,
  type ElementPatch,
  type LoopStep,
  type LoopView,
  type ModelJSON,
  type ScenarioPatch,
} from "../core/index.js";
import { BrowserNotFoundError, launchBrowser } from "../viewer/browser.js";
import { startViewer } from "../viewer/server.js";

// ---- 入力の形 ----

const modelName = z.string().min(1).describe("モデル名（作業フォルダの <モデル名>.json）");
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
    .describe("表示。coordinates [x, y], size [幅, 高さ], interactive（スライダー）, interactive_min, interactive_max など。座標は書き出し時に自動で付く"),
});

const slideText = {
  title: z.string().describe("見出し"),
  message: z.string().describe("言いたいこと（1 文）。SD を知らない人に伝わる言葉で、グラフから読み取れることを書く"),
};
const slideNames = (what: string) => z.array(z.string()).describe(`${what}（4 つまで）`);
const slide = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("problem").describe("問題"),
    ...slideText,
    elements: slideNames("注目する要素の名前"),
    data: z.array(z.string()).optional().describe("点で重ねる実際のデータ（<モデル名>.data.csv）の列名。省略すると、注目する要素のうちデータのあるものすべて"),
    now: z.number().optional().describe("「今」の時点（モデルの時刻）。グラフに縦の線を引く"),
  }),
  z.object({
    kind: z.literal("cause").describe("原因"),
    ...slideText,
    loop: z.object({
      elements: z.array(z.string()).describe("ループを作る要素の名前。ループをひと回りする順に並べる"),
      polarity: z.enum(LOOP_POLARITIES).describe("R は強めるループ、B は釣り合わせるループ"),
    }),
  }),
  z.object({
    kind: z.literal("solution").describe("解決案"),
    ...slideText,
    scenario: z.string().describe("set_scenarios で保存したシナリオの名前。説明と変える値はシナリオから出す"),
  }),
  z.object({
    kind: z.literal("compare").describe("比較"),
    ...slideText,
    scenarios: z.array(z.string()).describe(`比べるシナリオの名前。「${BASELINE_SCENARIO}」はいつも重ねるので並べなくてよい`),
    elements: slideNames("比べる要素の名前"),
    at: z.number().optional().describe("注目する時点（モデルの時刻）。その時点の値を並べて出す"),
  }),
  z.object({ kind: z.literal("conclusion").describe("結論（文章だけ）"), ...slideText }),
]);

// ---- 共通の処理 ----

/** ループのつながりを 1 行ずつの文にする（例: "採用 → 新人 (+, フロー)"） */
const VIA_LABEL: Record<LoopStep["via"], string> = { link: "", flow: ", フロー", reference: ", フローの式の参照" };
const stepText = (s: LoopStep) => `${s.from} → ${s.to} (${s.polarity}${VIA_LABEL[s.via]})`;

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

const SERVER_INSTRUCTIONS = `システムダイナミクス（SD）のモデルを作り、実行し、分析するためのツールです（SD Modeler）。モデルの形式は Insight Maker の ModelJSON です。
モデルは作業フォルダに ModelJSON ファイル（<モデル名>.json）として保存されます。

進め方:
1. create_model か import_model でモデルを用意する
2. upsert_elements でストック、フロー、変数を追加する。式では他の要素を [名前] で参照する。足りないリンクは自動で追加される
3. 結果に検証エラーが出たら直す。validate_model でも確かめられる
4. run_simulation で実行し、sweep_parameter で感度分析やシナリオ比較をする。人に見せるシナリオは set_scenarios でモデルに保存する（ビューアのグラフに「元のモデル」と重ねて出る）。実際のデータ（実績や観測値）があれば import_data で取り込む。人はビューアのグラフで、モデルの線とデータの点を見比べる
5. 会議などで原因を説明するときは、find_loops でフィードバックループ（R：強める、B：釣り合わせる）を探す。極性が決まっていなければ、upsert_elements で LINK の behavior.polarity を入れる。view_diagram の loop でループを目立たせた図を見られる
6. 図の配置を整える。layout_model で座標を付けて保存し、view_diagram で図の画像と、箱の重なり・線が要素や名前の上を通るところ・線の交差・1 か所に集まる線の一覧を見る。気になるところは upsert_elements の display で位置を直し、もう一度 view_diagram で確かめる。人はビューア（npm run viewer）で同じ図を見ている
7. export_model で Insight Maker の Web 版に読み込める Model.json を書き出す（Web 版の「Import ModelJSON」で人が読み込む）

「説明資料を作って」と頼まれたら（SD を知らない身近な人に、問題と解決案を順に見せる資料。決定権がある人向けの正式な提案資料の素材にもなる）:
a. get_model と run_simulation でモデルの振る舞いを確かめる。実際のデータ（実績）があれば import_data で取り込む。比べるシナリオがなければ set_scenarios で保存する（description に、どんなシナリオかを書く）
b. set_slides で筋書きを保存する。問題 → 原因 → 解決案 → 比較 → 結論 の順に並べ、どのスライドにも見出しと「言いたいこと」の 1 文を書く。式や SD の用語は使わず、グラフから読み取れることを書く
   - 問題（problem）：注目する要素、実際のデータ、「今」の時点。モデルの線に実際のデータの点が重なり、モデルが問題を再現していることを見せる
   - 原因（cause）：問題を生むループを作る要素の名前と、強めるループ（R）か釣り合わせるループ（B）か。ループごとに 1 枚。find_loops で探したループの elements を loop.elements に、kind を loop.polarity に使う（set_slides は、ループになっているか、R / B がリンクの極性と合うかを確かめる。極性が決まっていなければ upsert_elements で入れる）
   - 解決案（solution）：シナリオの名前。シナリオごとに 1 枚
   - 比較（compare）：比べるシナリオと要素、注目する時点。「元のモデル」はいつも重なる
   - 結論（conclusion）：文章だけ
c. view_slides でスライドを画像にして 1 枚ずつ確かめ、言いたいことがグラフから読み取れなければ直す。人はビューアの発表モード（http://localhost:5180/?view=present#<モデル名>）で ← → を押して見せる
d. 資料を送るときは export_slides で PDF に書き出す（1 スライド 1 ページ。中身は止まった絵で、受け取った人は値を変えられない）

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

  /** 実際のデータを読む。ないときや読めないときは undefined（筋書きの確認では「データがない」として扱う） */
  async function readActualData(name: string): Promise<ActualData | undefined> {
    const text = await store.readData(name);
    if (text === undefined) return undefined;
    try {
      return parseDataCSV(text);
    } catch {
      return undefined;
    }
  }

  /**
   * 要素やシナリオを消したり、期間や実際のデータを変えたりしたあと、筋書きがモデルに合わなくなっていれば slides_issues で知らせる。
   * 直さないと見せられないもの（errors）と、確かめたほうがよいもの（warnings。時点が期間の外など）の両方を入れる
   */
  async function slidesAfterEdit(name: string, model: ModelJSON): Promise<{ slides_issues?: unknown[] }> {
    const read = await store.readSlidesText(name);
    if (!read) return {};
    try {
      const { errors, warnings } = checkSlides(model, parseSlides(read.text), await readActualData(name));
      const issues = [...errors, ...warnings];
      return issues.length ? { slides_issues: issues } : {};
    } catch {
      return {};
    }
  }

  server.registerTool(
    "list_models",
    {
      title: "モデル一覧",
      description: "作業フォルダにあるモデルの一覧を返す。",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    handle(async () => ({ models_dir: store.dir, models: await store.list() })),
  );

  server.registerTool(
    "create_model",
    {
      title: "モデルを作る",
      description: "空のモデルを作って保存する。既定のシミュレーション設定は 0 から 100 年、刻み 1、RK1。",
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
      const m = emptyModel(a.title ?? a.model);
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
        ".InsightMaker ファイル（Insight Maker の XML）か ModelJSON ファイルを取り込んで作業フォルダに保存する。path か content のどちらかを指定する。" +
        "ModelJSON にないもの（エージェント、テキスト、画像、ボタンなど）は取り込まれず、warnings に出る。",
      inputSchema: {
        path: z.string().optional().describe("取り込むファイルのパス（絶対パス、またはカレントか作業フォルダからの相対パス）"),
        content: z.string().optional().describe("ファイルの中身を直接渡す場合"),
        model: z.string().optional().describe("保存するモデル名（省略するとファイル名）"),
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
        base ??= toModelName(path.basename(p).replace(/\.(InsightMaker|json|xml)$/i, ""));
      }
      const { model, warnings } = importModelText(text, base);
      const name = toModelName(base ?? model.name ?? "imported");
      if (!a.overwrite && (await store.exists(name))) {
        throw new StoreError(`モデル "${name}" はすでにあります。別の名前（model）を付けるか overwrite: true を付けてください。`);
      }
      return saveAndCheck(name, model, { warnings, summary: summarizeModel(model) });
    }),
  );

  server.registerTool(
    "export_model",
    {
      title: "Web 版向けに書き出す",
      description:
        "Insight Maker の Web 版で「Import ModelJSON」から読み込める JSON ファイルを書き出す。座標のない要素には、重ならないように座標を付ける。" +
        "大きさのない箱には、図と同じ大きさ（名前の長さから決めたもの）を入れる（モデル本体には保存しない）。" +
        "グラフや表の設定がなければ、ストックの時系列グラフを 1 つ足す。" +
        "書き出し先は作業フォルダの中（既定は exports/<モデル名>.json）。",
      inputSchema: {
        model: modelName,
        path: z.string().optional().describe("作業フォルダからの相対パス（既定は exports/<モデル名>.json）"),
        layout: z.boolean().optional().describe("座標のない要素に座標を付ける（既定は true）"),
        save_layout: z.boolean().optional().describe("付けた座標をモデル本体にも保存する（既定は false）"),
        chart: z
          .boolean()
          .optional()
          .describe("グラフや表の設定がなければ、ストックの時系列グラフを 1 つ足す（既定は true）。モデル本体には保存しない"),
      },
    },
    handle(async (a: { model: string; path?: string; layout?: boolean; save_layout?: boolean; chart?: boolean }) => {
      const m = await store.read(a.model);
      const validation = validateModel(m);
      let placed: string[] = [];
      if (a.layout !== false) {
        placed = layoutModel(m);
        if (a.save_layout && placed.length) await store.write(a.model, m);
      }
      const chart = a.chart !== false ? addDefaultVisualization(m) : undefined;
      // 箱の大きさは書き出すファイルにだけ入れる（Web 版でもビューアと同じ幅にする）
      addBoxSizes(m);
      const rel = a.path ?? path.join("exports", `${a.model}.json`);
      const file = await store.writeJSONFile(store.resolveInside(rel.endsWith(".json") ? rel : `${rel}.json`), m);
      return {
        file,
        placed_elements: placed,
        ...(chart ? { added_chart: chart } : {}),
        validation,
        next_step: "Insight Maker の Web 版でモデルを開き、Import/Export メニューの「Import ModelJSON」からこのファイルを読み込んでください。",
      };
    }),
  );

  server.registerTool(
    "layout_model",
    {
      title: "図の配置を付ける",
      description:
        "座標のない要素に、重ならないように座標を付けて保存する（書き出しと同じ簡易レイアウト）。reset: true ですべて並べ直す。" +
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
        "画像には Edge か Chrome が必要（なければ image: false と同じで、一覧だけ返す）。" +
        "loop を渡すと、そのループの要素と線だけを目立たせ、ほかを薄くし、ループの名前と R / B を図の左上に出す（説明資料の「原因」のスライド向けの表示）。",
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
          return { name: l.name, kind: l.kind, elements: l.elements, steps: l.steps.map(stepText), ...(u.length ? { undetermined: u } : {}) };
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
      const slides = await store.renameSlideNames(a.model, { elements: renamed });
      if (slides.note) report.notes.push(slides.note);
      if (slides.warning) report.notes.push(slides.warning);
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
      return saveAndCheck(a.model, m, { changes: report, ...(await slidesAfterEdit(a.model, m)) });
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
      return saveAndCheck(model, m, { simulation: sim, ...(await slidesAfterEdit(model, m)) });
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
      const before = namesByScenario(m);
      const report = setScenarios(m, a.scenarios ?? [], { remove: a.remove, replace: a.replace });
      const extra: Record<string, unknown> = { changes: report, scenarios: m.scenarios ?? [] };
      // 実行できないシナリオは保存しない（エラーのあるモデルは、検証結果で知らせる）
      if (m.scenarios?.length && staticCheck(m).errors.length === 0) {
        const { targets: names, time_units, rows } = compareScenarios(m, withBaseline(modelScenarios(m)), { targets: a.elements });
        extra.comparison = { targets: names, time_units, rows };
      }
      const result = await saveAndCheck(a.model, m, extra);
      // シナリオの名前を変えたら、筋書きの中の名前も直す（モデルはもう保存してあるので、直せなくても知らせだけ添える）
      const slides = await store.renameSlideNames(a.model, { scenarios: scenarioRenamesSince(m, before) });
      if (slides.note) report.notes.push(slides.note);
      if (slides.warning) report.notes.push(slides.warning);
      return { ...result, ...(await slidesAfterEdit(a.model, m)) };
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
        // 差し替えたデータで、筋書きの問題のスライドが使う列がなくなっていないか
        ...(await slidesAfterEdit(a.model, m)),
      };
    }),
  );

  server.registerTool(
    "set_slides",
    {
      title: "説明資料の筋書きを保存する",
      description:
        "説明資料の筋書きを作業フォルダの <モデル名>.slides.json に保存する（今の筋書きはすべて置き換える）。ビューアの発表モードで、スライドを順に見せる。" +
        "スライドの種類は problem（問題）、cause（原因）、solution（解決案）、compare（比較）、conclusion（結論）で、この順に並べる。どのスライドにも title（見出し）と message（言いたいこと 1 文）を書く。" +
        "要素名、シナリオの名前、実際のデータの列名が実在するかを確かめ、合わなければ保存せずに issues（何枚目の何が合わないか、「もしかして」）を返す。" +
        "原因のスライドは、loop.elements がつながる順のループになっているか、polarity がリンクの極性から決まる R / B と合うかも確かめる（極性が決まっていなければ warnings で知らせて保存する）。" +
        "要素やシナリオの名前を upsert_elements や set_scenarios で変えると、筋書きの中の名前も直す。保存したら view_slides で画像を見て確かめる。",
      inputSchema: {
        model: modelName,
        title: z.string().optional().describe("資料の題"),
        slides: z.array(slide).min(1).describe("スライドの並び"),
        version: z.string().optional().describe("前に view_slides で読んだ筋書きの版。渡すと、そのあとにほかで筋書きが変わっていたら保存しない"),
      },
    },
    handle(async (a: { model: string; title?: string; slides: unknown[]; version?: string }) => {
      const m = await store.read(a.model);
      const current = await store.readSlidesText(a.model);
      if (a.version !== undefined && current?.version !== a.version) {
        throw new StoreError(
          `筋書きは、読んだあとにほかのところで変わっています（いまの版: ${current?.version ?? "なし"}）。view_slides で読み直してから保存してください。`,
        );
      }
      const deck = toSlideDeck({ title: a.title, slides: a.slides });
      const { errors, warnings } = checkSlides(m, deck, await readActualData(a.model));
      if (errors.length) throw new ModelError(`筋書きに直すところが ${errors.length} つあるため、保存しませんでした。`, errors);
      const { file, version } = await store.writeSlides(a.model, deck);
      return {
        model: a.model,
        file,
        version,
        slides: deck.slides.map((s, i) => `${i + 1}. ${SLIDE_KIND_LABEL[s.kind]}：${s.title}`),
        warnings,
        next_step: `view_slides でスライドを画像にして確かめてください。人はビューアの発表モード（?view=present#${a.model}）で見られます。`,
      };
    }),
  );

  server.registerTool(
    "view_slides",
    {
      title: "スライドを見る",
      description:
        "説明資料の筋書き（set_slides で保存したもの）を、ビューアの発表モードと同じ描き方で 1 枚ずつ PNG の画像にして返す。" +
        "あわせて、筋書きの中身と版、名前がモデルに合わないところ（errors）と確かめたほうがよいところ（warnings）を返す。" +
        "画像には Edge か Chrome が必要（なければ image: false と同じで、中身だけ返す）。",
      inputSchema: {
        model: modelName,
        slides: z.array(z.number().int().min(1)).optional().describe("画像にするスライドの番号（1 から）。省略するとすべて"),
        image: z.boolean().optional().describe("画像を付ける（既定は true）。中身だけでよければ false"),
        width: z.number().int().min(640).max(3840).optional().describe("画像の幅（既定 1280。高さは 16:9 にする）"),
      },
      annotations: { readOnlyHint: true },
    },
    handle(async (a: { model: string; slides?: number[]; image?: boolean; width?: number }) => {
      const m = await store.read(a.model);
      const read = await store.readSlidesText(a.model);
      if (!read) throw new StoreError(`モデル "${a.model}" の筋書きがありません。set_slides で保存してください。`);
      const deck = parseSlides(read.text);
      const { errors, warnings } = checkSlides(m, deck, await readActualData(a.model));
      const numbers = a.slides?.length ? [...new Set(a.slides)] : deck.slides.map((_, i) => i + 1);
      const missing = numbers.filter((n) => n > deck.slides.length);
      if (missing.length) throw new StoreError(`スライド ${missing.join(", ")} はありません（筋書きは ${deck.slides.length} 枚）。`);
      const info = { model: a.model, file: store.slidesPathOf(a.model), version: read.version, ...deck, errors, warnings };
      if (a.image === false || numbers.length === 0) return info;
      const width = a.width ?? 1280;
      let images: Buffer[];
      try {
        images = await renderSlides(store, a.model, numbers, width, Math.round((width * 9) / 16));
      } catch (e) {
        return { ...info, image_error: e instanceof BrowserNotFoundError ? e.message : `スライドを画像にできませんでした: ${(e as Error).message}` };
      }
      return {
        content: [
          { type: "text", text: formatJSON(info) },
          ...images.flatMap((png, i) => [
            { type: "text" as const, text: `スライド ${numbers[i]}` },
            { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
          ]),
        ],
      } satisfies CallToolResult;
    }),
  );

  server.registerTool(
    "export_slides",
    {
      title: "説明資料を PDF に書き出す",
      description:
        "説明資料の筋書き（set_slides で保存したもの）を、ビューアの発表モードと同じ描き方で、1 スライド 1 ページの PDF に書き出す。" +
        "ページは 16:9（13.33 × 7.5 インチ）で、文字のフォントを埋め込むので、ほかの PC でもそのまま開ける。中身は止まった絵で、受け取った人は値を変えられない。" +
        "名前がモデルに合わないところ（errors）があれば書き出さない。書き出し先は作業フォルダの中（既定は exports/<モデル名>.pdf）。Edge か Chrome が必要。",
      inputSchema: {
        model: modelName,
        path: z.string().optional().describe("作業フォルダからの相対パス（既定は exports/<モデル名>.pdf）"),
      },
    },
    handle(async (a: { model: string; path?: string }) => {
      const m = await store.read(a.model);
      const read = await store.readSlidesText(a.model);
      if (!read) throw new StoreError(`モデル "${a.model}" の筋書きがありません。set_slides で保存してください。`);
      const deck = parseSlides(read.text);
      const { errors, warnings } = checkSlides(m, deck, await readActualData(a.model));
      if (errors.length) throw new ModelError(`筋書きに直すところが ${errors.length} つあるため、書き出しませんでした。`, errors);
      if (!deck.slides.length) throw new StoreError(`モデル "${a.model}" の筋書きにスライドがありません。`);
      const rel = a.path ?? path.join("exports", `${a.model}.pdf`);
      const file = store.resolveInside(rel.toLowerCase().endsWith(".pdf") ? rel : `${rel}.pdf`);
      let pdf: Buffer;
      try {
        pdf = await renderSlidesPDF(store, a.model, deck.slides.length);
      } catch (e) {
        if (e instanceof BrowserNotFoundError) throw e;
        throw new StoreError(`PDF にできませんでした: ${(e as Error).message}`);
      }
      await store.writeBinaryFile(file, pdf);
      return {
        model: a.model,
        file,
        pages: deck.slides.length,
        slides: deck.slides.map((s, i) => `${i + 1}. ${SLIDE_KIND_LABEL[s.kind]}：${s.title}`),
        warnings,
        next_step: "このファイルを、そのまま説明する相手に送れます。",
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

/** ビューアを一時的に起動し、ヘッドレスのブラウザで発表モードのスライドを 1 枚ずつ PNG にする */
async function renderSlides(store: ModelStore, name: string, numbers: number[], width: number, height: number): Promise<Buffer[]> {
  if (!existsSync(path.join(WEB_DIR, "index.html"))) throw new Error("画面がビルドされていません。npm run build を実行してください。");
  const viewer = await startViewer({ modelsDir: store.dir, staticDir: WEB_DIR, port: 0 });
  try {
    const browser = await launchBrowser();
    try {
      await browser.setViewport(width, height);
      const ready = (n: number) => `document.querySelector('.slide[data-index="${n}"][data-ready="1"]')`;
      await browser.open(`${viewer.url}?view=present&slide=${numbers[0]}#${encodeURIComponent(name)}`, ready(numbers[0]!));
      const out: Buffer[] = [];
      for (const n of numbers) {
        // 開き直さずに、アドレスの slide= を変えて切り替える（ページを開き直すたびにビューアへのつながりが増えないように）
        await browser.evaluate(
          `(() => { const u = new URL(location.href); u.searchParams.set("slide", "${n}"); history.replaceState(null, "", u); dispatchEvent(new PopStateEvent("popstate")); })()`,
        );
        await browser.waitFor(ready(n));
        await new Promise((r) => setTimeout(r, 400)); // グラフと図を描き終えるのを待つ
        out.push(await browser.screenshot());
      }
      return out;
    } finally {
      await browser.close();
    }
  } finally {
    await viewer.close();
  }
}

/** PDF のページの大きさ（16:9）。1 インチは 96 px なので、発表モードを幅 1280 px で開いたときの 1 枚がちょうど 1 ページになる */
const PDF_PAGE = { width: 1280, height: 720 };

/** ビューアを一時的に起動し、ヘッドレスのブラウザで発表モードのスライドをすべて並べて、1 枚 1 ページの PDF にする */
async function renderSlidesPDF(store: ModelStore, name: string, count: number): Promise<Buffer> {
  if (!existsSync(path.join(WEB_DIR, "index.html"))) throw new Error("画面がビルドされていません。npm run build を実行してください。");
  const viewer = await startViewer({ modelsDir: store.dir, staticDir: WEB_DIR, port: 0 });
  try {
    const browser = await launchBrowser();
    try {
      await browser.setViewport(PDF_PAGE.width, PDF_PAGE.height);
      await browser.open(`${viewer.url}?view=present&print=1#${encodeURIComponent(name)}`, `document.querySelectorAll('.slide[data-ready="1"]').length === ${count}`);
      await new Promise((r) => setTimeout(r, 400)); // グラフと図を描き終えるのを待つ
      const { data } = await browser.send("Page.printToPDF", {
        paperWidth: PDF_PAGE.width / 96,
        paperHeight: PDF_PAGE.height / 96,
        marginTop: 0,
        marginBottom: 0,
        marginLeft: 0,
        marginRight: 0,
        printBackground: true,
        preferCSSPageSize: false,
      });
      return Buffer.from(data as string, "base64");
    } finally {
      await browser.close();
    }
  } finally {
    await viewer.close();
  }
}
