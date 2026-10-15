import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  EDITABLE_TYPES,
  EditError,
  ImportError,
  ModelError,
  ModelStore,
  StoreError,
  TIME_UNITS,
  addDefaultVisualization,
  checkDiagram,
  compareScenarios,
  emptyModel,
  importModelText,
  layoutModel,
  modelScenarios,
  removeElements,
  resolveTargets,
  runModel,
  runToCSV,
  setSimulation,
  staticCheck,
  summarizeModel,
  summarizeRun,
  sweepParameter,
  sweepValues,
  upsertElements,
  validateModel,
  type ElementPatch,
  type ModelJSON,
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
  rename_to: z.string().optional().describe("既存の要素の名前を変える。式やリンクの参照も書き換える"),
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

// ---- 共通の処理 ----

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
  else if (e instanceof StoreError || e instanceof EditError || e instanceof ImportError) body = { error: e.message };
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

const SERVER_INSTRUCTIONS = `Insight Maker のシステムダイナミクス（SD）モデルを作り、実行し、分析するためのツールです。
モデルは作業フォルダに ModelJSON ファイル（<モデル名>.json）として保存されます。

進め方:
1. create_model か import_model でモデルを用意する
2. upsert_elements でストック、フロー、変数を追加する。式では他の要素を [名前] で参照する。足りないリンクは自動で追加される
3. 結果に検証エラーが出たら直す。validate_model でも確かめられる
4. run_simulation で実行し、sweep_parameter で感度分析やシナリオ比較をする
5. 図の配置を整える。layout_model で座標を付けて保存し、view_diagram で図の画像と、箱の重なり・線が要素の上を通るところ・線の交差の一覧を見る。気になるところは upsert_elements の display で位置を直し、もう一度 view_diagram で確かめる。人はビューア（npm run viewer）で同じ図を見ている
6. export_model で Insight Maker の Web 版に読み込める Model.json を書き出す（Web 版の「Import ModelJSON」で人が読み込む）

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
        const candidates = path.isAbsolute(p) ? [p] : [path.resolve(p), path.resolve(store.dir, p)];
        for (const c of candidates) {
          try {
            text = await readFile(c, "utf8");
            break;
          } catch {
            // 次の候補を試す
          }
        }
        if (text === undefined) throw new ImportError(`ファイルが読めません: ${candidates.join(" / ")}`);
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
        "結果に図の確認（重なり、線が要素の上を通るところ、線の交差）を付ける。直すときは view_diagram で図を見ながら upsert_elements の display で位置を変える。",
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
        "モデルの図を、ビューアと同じ描き方で PNG の画像にして返す。あわせて、箱の重なり、線（フロー、リンク）がつながっていない要素の上を通るところ、線の交差、各要素の位置を返す。" +
        "位置は upsert_elements の display で直す（ストックや変数は display.coordinates が左上、雲はフローの display.from_coordinates / to_coordinates が中心）。" +
        "画像には Edge か Chrome が必要（なければ image: false と同じで、一覧だけ返す）。",
      inputSchema: {
        model: modelName,
        image: z.boolean().optional().describe("画像を付ける（既定は true）。一覧だけでよければ false"),
        width: z.number().int().min(400).max(4000).optional().describe("画像の幅（既定 1600）"),
        height: z.number().int().min(300).max(4000).optional().describe("画像の高さ（既定 1000）"),
      },
      annotations: { readOnlyHint: true },
    },
    handle(async (a: { model: string; image?: boolean; width?: number; height?: number }) => {
      const m = await store.read(a.model);
      const check = {
        model: a.model,
        how_to_move:
          "upsert_elements で [{name:'要素名', display:{coordinates:[x, y]}}]（左上）。雲は [{name:'フロー名', display:{from_coordinates:[x, y]}}]（中心、行き先なら to_coordinates）。y は下向き",
        ...checkDiagram(m),
      };
      if (a.image === false) return check;
      let png: Buffer;
      try {
        png = await renderDiagram(store, a.model, a.width ?? 1600, a.height ?? 1000);
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
      const report = upsertElements(m, a.elements, { autoLink: a.auto_link });
      return saveAndCheck(a.model, m, { changes: report });
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
        "(3) どちらもなければモデルに保存されたシナリオを比べる。結果は組ごとに、指定した要素の初期値・最終値・最小・最大を返す。",
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
        overrides: overrides.optional().describe("すべての組に共通で当てる上書き"),
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
        const scenarios = a.scenarios?.length ? a.scenarios : modelScenarios(m);
        if (!scenarios.length) {
          throw new ModelError("比べるものがありません。parameter か scenarios を指定してください（モデルにもシナリオが保存されていません）。", []);
        }
        const withBase = scenarios.map((s) => ({ name: s.name, overrides: { ...(a.overrides ?? {}), ...s.overrides } }));
        return { model: a.model, ...compareScenarios(m, withBase, opts) };
      },
    ),
  );
}

/** ビルドした画面（dist/web）。ビルドしたものは dist/mcp/tools.js、テストではソースの src/mcp/tools.ts から探す */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = [path.resolve(HERE, "../web"), path.resolve(HERE, "../../dist/web")].find((d) => existsSync(path.join(d, "index.html"))) ?? path.resolve(HERE, "../web");

/** ビューアを一時的に起動し、ヘッドレスのブラウザで図だけを描いて PNG にする */
async function renderDiagram(store: ModelStore, name: string, width: number, height: number): Promise<Buffer> {
  if (!existsSync(path.join(WEB_DIR, "index.html"))) throw new Error("画面がビルドされていません。npm run build を実行してください。");
  const viewer = await startViewer({ modelsDir: store.dir, staticDir: WEB_DIR, port: 0 });
  try {
    const browser = await launchBrowser();
    try {
      await browser.setViewport(width, height);
      await browser.open(`${viewer.url}?view=diagram#${encodeURIComponent(name)}`);
      return await browser.screenshot();
    } finally {
      await browser.close();
    }
  } finally {
    await viewer.close();
  }
}

