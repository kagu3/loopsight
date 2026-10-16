import type { ModelJSON, Scenario } from "./modeljson.js";
import { didYouMean, findElement, sameName } from "./modeljson.js";
import type { ActualData } from "./data.js";
import { BASELINE_SCENARIO } from "./edit.js";
import { ImportError } from "./importer.js";
import type { Issue } from "./validate.js";

// 会議資料の筋書き（<モデル名>.slides.json）。ビューアの発表モードで、スライドを順に見せる。
// エンジンは ModelJSON の決まったキー以外を受け付けないので、モデルのファイルには入れず、別のファイルに置く。
// どのスライドにも見出し（title）と「言いたいこと」の 1 文（message）を持たせる。

export const SLIDE_KINDS = ["problem", "cause", "solution", "compare", "conclusion"] as const;
export type SlideKind = (typeof SLIDE_KINDS)[number];

/** 画面とツールの説明で使う、スライドの種類の呼び名 */
export const SLIDE_KIND_LABEL: Record<SlideKind, string> = {
  problem: "問題",
  cause: "原因",
  solution: "解決案",
  compare: "比較",
  conclusion: "結論",
};

/** ループの種類。R は強めるループ、B は釣り合わせるループ */
export const LOOP_POLARITIES = ["R", "B"] as const;
export type LoopPolarity = (typeof LOOP_POLARITIES)[number];

/** 1 つのグラフに並べる要素の数の上限（発表の画面に収まる数） */
export const MAX_SLIDE_ELEMENTS = 4;
/** 比較のスライドで重ねる施策の数の上限（グラフの色の数。「何もしない場合」はほかに出す） */
export const MAX_SLIDE_SCENARIOS = 8;

interface SlideBase {
  /** 見出し */
  title: string;
  /** 言いたいこと（1 文） */
  message: string;
}

/** 問題：注目する要素のモデルの線に、実際のデータの点を重ねる。now は「今」の時点 */
export interface ProblemSlide extends SlideBase {
  kind: "problem";
  elements: string[];
  /** 点で重ねる実際のデータの列名（要素名と同じ）。省略すると、注目する要素のうちデータのあるものすべて */
  data?: string[];
  now?: number;
}

/** 原因：ループを作る要素の名前と、強めるループ（R）か釣り合わせるループ（B）か */
export interface CauseSlide extends SlideBase {
  kind: "cause";
  loop: { elements: string[]; polarity: LoopPolarity };
}

/** 解決案：施策（シナリオ）の名前。説明と変える値はモデルの施策から出す */
export interface SolutionSlide extends SlideBase {
  kind: "solution";
  scenario: string;
}

/** 比較：「何もしない場合」と施策を、要素ごとに重ねる。at は注目する時点 */
export interface CompareSlide extends SlideBase {
  kind: "compare";
  scenarios: string[];
  elements: string[];
  at?: number;
}

/** 結論：文章だけ */
export interface ConclusionSlide extends SlideBase {
  kind: "conclusion";
}

export type Slide = ProblemSlide | CauseSlide | SolutionSlide | CompareSlide | ConclusionSlide;

export interface SlideDeck {
  /** 資料の題（なくてもよい） */
  title?: string;
  slides: Slide[];
}

/** 筋書きの問題。slide は何枚目か（1 から） */
export interface SlideIssue extends Issue {
  slide: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

/**
 * 筋書きの形を確かめて、決まったキーだけの筋書きにする。形が違えば ImportError。
 * 名前が実在するかは checkSlides で確かめる（ファイルを人が書き換えたときも読めるように、形だけを見る）
 */
export function toSlideDeck(value: unknown): SlideDeck {
  if (!isObject(value) || !Array.isArray(value.slides)) throw new ImportError("筋書きは { \"slides\": [...] } の形にしてください。");
  if (value.title !== undefined && typeof value.title !== "string") throw new ImportError("title は文字列にしてください。");
  const slides = value.slides.map((s, i): Slide => {
    const at = `${i + 1} 枚目のスライド`;
    if (!isObject(s)) throw new ImportError(`${at}がオブジェクトではありません。`);
    const kind = s.kind as SlideKind;
    if (!SLIDE_KINDS.includes(kind)) {
      throw new ImportError(`${at}の kind "${String(s.kind)}" は使えません（${SLIDE_KINDS.map((k) => `${k}（${SLIDE_KIND_LABEL[k]}）`).join("、")}）。`);
    }
    if (typeof s.title !== "string" || typeof s.message !== "string") throw new ImportError(`${at}には title（見出し）と message（言いたいこと）の文字列が必要です。`);
    const base = { title: s.title, message: s.message };
    const names = (key: string, required: boolean): string[] | undefined => {
      const v = s[key];
      if (v === undefined && !required) return undefined;
      if (!isStringArray(v)) throw new ImportError(`${at}（${SLIDE_KIND_LABEL[kind]}）の ${key} は名前の配列にしてください。`);
      return [...v];
    };
    const time = (key: string): number | undefined => {
      const v = s[key];
      if (v === undefined || v === null) return undefined;
      if (typeof v !== "number" || !Number.isFinite(v)) throw new ImportError(`${at}（${SLIDE_KIND_LABEL[kind]}）の ${key} は時刻（数）にしてください。`);
      return v;
    };
    switch (kind) {
      case "problem": {
        const slide: ProblemSlide = { kind, ...base, elements: names("elements", true)! };
        const data = names("data", false);
        if (data) slide.data = data;
        const now = time("now");
        if (now !== undefined) slide.now = now;
        return slide;
      }
      case "cause": {
        const loop = s.loop;
        if (!isObject(loop) || !isStringArray(loop.elements) || !LOOP_POLARITIES.includes(loop.polarity as LoopPolarity)) {
          throw new ImportError(`${at}（原因）の loop は { "elements": [ループを作る要素の名前], "polarity": "R" か "B" } にしてください。`);
        }
        return { kind, ...base, loop: { elements: [...loop.elements], polarity: loop.polarity as LoopPolarity } };
      }
      case "solution":
        if (typeof s.scenario !== "string") throw new ImportError(`${at}（解決案）には scenario（施策の名前）が必要です。`);
        return { kind, ...base, scenario: s.scenario };
      case "compare": {
        const slide: CompareSlide = { kind, ...base, scenarios: names("scenarios", true)!, elements: names("elements", true)! };
        const t = time("at");
        if (t !== undefined) slide.at = t;
        return slide;
      }
      case "conclusion":
        return { kind, ...base };
    }
  });
  return value.title === undefined ? { slides } : { title: value.title, slides };
}

/** 筋書きのファイルを読む。読めなければ ImportError */
export function parseSlides(text: string): SlideDeck {
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    throw new ImportError(`JSON として読めません: ${(e as Error).message}`);
  }
  return toSlideDeck(json);
}

function scenarioNameOf(s: Scenario, i: number): string {
  return s.name ?? `scenario ${i + 1}`;
}

/**
 * 筋書きがモデルに合うか確かめる。要素名、施策の名前、実際のデータの列名が実在するか。
 * 合う名前はモデル（とデータ）の表記にそろえる（deck をその場で書き換える）。
 * errors は直さないと見せられないもの、warnings は見せられるが確かめたほうがよいもの
 */
export function checkSlides(model: ModelJSON, deck: SlideDeck, data?: ActualData): { errors: SlideIssue[]; warnings: SlideIssue[] } {
  const errors: SlideIssue[] = [];
  const warnings: SlideIssue[] = [];
  const elementNames = model.elements.filter((e) => e.type !== "LINK" && e.name).map((e) => e.name!);
  const scenarios = model.scenarios ?? [];
  const scenarioNames = scenarios.map(scenarioNameOf);
  const start = model.simulation?.time_start ?? 0;
  const end = start + (model.simulation?.time_length ?? 0);

  if (deck.slides.length === 0) errors.push({ slide: 0, message: "スライドがありません。", hint: "問題 → 原因 → 解決案 → 比較 → 結論 の順にスライドを並べてください。" });

  deck.slides.forEach((s, i) => {
    const n = i + 1;
    const at = `${n} 枚目（${SLIDE_KIND_LABEL[s.kind]}）`;
    const error = (message: string, hint?: string, element?: string) => errors.push({ slide: n, message: `${at}: ${message}`, ...(hint ? { hint } : {}), ...(element ? { element } : {}) });
    const warning = (message: string, hint?: string) => warnings.push({ slide: n, message: `${at}: ${message}`, ...(hint ? { hint } : {}) });
    if (!s.title.trim()) error("見出し（title）が空です。");
    if (!s.message.trim()) error("言いたいこと（message）が空です。", "このスライドで伝えたいことを 1 文で書いてください。");

    /** 要素名をモデルの表記にそろえる。なければエラー */
    const elements = (list: string[], what: string): string[] => {
      if (list.length === 0) error(`${what}がありません。`);
      if (list.length > MAX_SLIDE_ELEMENTS) error(`${what}は ${MAX_SLIDE_ELEMENTS} つまでにしてください（${list.length} あります）。`, "スライドを分けてください。");
      return list.map((name) => {
        const el = findElement(model, name);
        if (el) return el.name!;
        error(`${what} "${name}" がモデルにありません。`, didYouMean(name, elementNames) || "get_model で要素名を確かめてください。");
        return name;
      });
    };
    /** 施策の名前をモデルの表記にそろえる。なければエラー */
    const scenario = (name: string): string => {
      if (sameName(name, BASELINE_SCENARIO)) return BASELINE_SCENARIO;
      const k = scenarios.findIndex((sc, j) => sameName(scenarioNameOf(sc, j), name));
      if (k < 0) {
        error(
          `施策 "${name}" がモデルにありません。`,
          didYouMean(name, scenarioNames) || (scenarioNames.length ? `ある施策: ${scenarioNames.join("、")}` : "先に set_scenarios で施策を保存してください。"),
        );
        return name;
      }
      if (k >= MAX_SLIDE_SCENARIOS) warning(`施策 "${scenarioNames[k]}" は ${k + 1} 番目に保存されているため、ビューアで実行されません。`, `ビューアが実行する施策は先頭の ${MAX_SLIDE_SCENARIOS} つまでです。`);
      return scenarioNames[k]!;
    };
    const time = (t: number | undefined, what: string) => {
      if (t !== undefined && (t < start || t > end)) warning(`${what}（${t}）がシミュレーションの期間（${start} から ${end}）の外です。`, "グラフに線を引けません。期間の中の時刻にしてください。");
    };

    switch (s.kind) {
      case "problem": {
        s.elements = elements(s.elements, "注目する要素");
        if (s.data) {
          if (!data) error("実際のデータの列を指定していますが、実際のデータ（<モデル名>.data.csv）がありません。", "import_data で取り込むか、data を外してください。");
          else {
            const columns = data.columns.map((c) => c.name);
            s.data = s.data.map((name) => {
              const c = columns.find((c) => sameName(c, name));
              if (!c) {
                error(`実際のデータに列 "${name}" がありません。`, didYouMean(name, columns) || `ある列: ${columns.join("、")}`);
                return name;
              }
              if (!s.elements.some((e) => sameName(e, c))) error(`実際のデータの列 "${c}" は、注目する要素に入っていません。`, "点はその要素の線に重ねるので、elements にも入れてください。");
              const el = findElement(model, c);
              return el ? el.name! : c;
            });
          }
        } else if (!data || !s.elements.some((e) => data.columns.some((c) => sameName(c.name, e)))) {
          warning("注目する要素に、実際のデータがありません。", "実際のデータがあれば import_data で取り込むと、モデルの線に点で重なります。");
        }
        time(s.now, "「今」の時点");
        break;
      }
      case "cause": {
        s.loop.elements = elements(s.loop.elements, "ループを作る要素");
        if (s.loop.elements.length === 1) error("ループを作る要素が 1 つだけです。", "ループをひと回りする順に、2 つ以上の要素を並べてください。");
        break;
      }
      case "solution":
        s.scenario = scenario(s.scenario);
        if (s.scenario === BASELINE_SCENARIO) error(`「${BASELINE_SCENARIO}」は施策ではありません。`, "set_scenarios で保存した施策の名前にしてください。");
        break;
      case "compare": {
        s.elements = elements(s.elements, "比べる要素");
        // 「何もしない場合」はいつも重ねるので、並べなくてよい
        s.scenarios = s.scenarios.map(scenario).filter((name) => name !== BASELINE_SCENARIO);
        if (s.scenarios.length === 0) error("比べる施策がありません。", `「${BASELINE_SCENARIO}」はいつも重ねます。ほかに施策の名前を 1 つ以上並べてください。`);
        if (s.scenarios.length > MAX_SLIDE_SCENARIOS) error(`比べる施策は ${MAX_SLIDE_SCENARIOS} つまでにしてください。`);
        time(s.at, "注目する時点");
        break;
      }
      case "conclusion":
        break;
    }
  });
  return { errors, warnings };
}

/** 要素や施策の名前を変えたときに、筋書きの中の名前も変える。変えたら true */
export function renameInSlides(deck: SlideDeck, renames: { elements?: [string, string][]; scenarios?: [string, string][] }): boolean {
  let changed = false;
  const rename = (list: [string, string][] | undefined, name: string): string => {
    const r = list?.find(([from]) => sameName(from, name));
    if (!r || r[1] === name) return name;
    changed = true;
    return r[1];
  };
  const element = (name: string) => rename(renames.elements, name);
  const scenario = (name: string) => rename(renames.scenarios, name);
  for (const s of deck.slides) {
    switch (s.kind) {
      case "problem":
        s.elements = s.elements.map(element);
        // 実際のデータの列名は要素名と同じ（要素の名前を変えると列名も直る）
        if (s.data) s.data = s.data.map(element);
        break;
      case "cause":
        s.loop.elements = s.loop.elements.map(element);
        break;
      case "solution":
        s.scenario = scenario(s.scenario);
        break;
      case "compare":
        s.elements = s.elements.map(element);
        s.scenarios = s.scenarios.map(scenario);
        break;
      case "conclusion":
        break;
    }
  }
  return changed;
}

/** 施策 → いまの名前。名前を変えたかどうかを、あとで scenarioRenamesSince で調べるために取っておく */
export function namesByScenario(model: ModelJSON): Map<Scenario, string> {
  return new Map((model.scenarios ?? []).map((s, i) => [s, scenarioNameOf(s, i)]));
}

/** namesByScenario を取ってから名前の変わった施策の [前の名前, 新しい名前] */
export function scenarioRenamesSince(model: ModelJSON, before: Map<Scenario, string>): [string, string][] {
  const out: [string, string][] = [];
  const now = model.scenarios ?? [];
  for (const [s, name] of before) {
    const i = now.indexOf(s);
    if (i >= 0 && scenarioNameOf(s, i) !== name) out.push([name, scenarioNameOf(s, i)]);
  }
  return out;
}
