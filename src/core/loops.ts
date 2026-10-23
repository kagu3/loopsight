// フィードバックループ（因果のつながりの循環）を探し、強めるループ（R）か釣り合わせるループ（B）かを決める。
// MCP の find_loops と、図でループを目立たせる表示（図の表示はループの要素名の並びを受け取る）で使う。
//
// つながりは次の 3 つ。
// - リンク：極性（behavior.polarity）の POSITIVE が +、NEGATIVE が -。NEUTRAL やないものは決まっていない
// - フロー → ストック：行き先のストックは増える（+）、出元のストックは減る（-）
// - ストック → フロー：フローの式が自分の出元か行き先のストックをリンクなしで参照しているもの（極性は決まっていない）
// - が偶数個なら R、奇数個なら B。決まっていないつながりが 1 つでもあれば、どちらか分からない
// リンクとフローに遅れの印（display.delay）があれば、そのつながりに delay を付ける（遅れのある B ループは振れやすい、と説明するため）。
// フローの印は、フローから行き先のストックへのつながりに付ける
import { hasDelayMark } from "./delay.js";
import { equationsOf, nameKey, referencesIn, sameName, type ModelJSON } from "./modeljson.js";

export type Polarity = "+" | "-" | "?";
/** R：強めるループ、B：釣り合わせるループ、unknown：極性が決まっていないつながりがある */
export type LoopKind = "R" | "B" | "unknown";

export interface LoopStep {
  from: string;
  to: string;
  polarity: Polarity;
  /** link：リンク、flow：フローがストックを増減させる、reference：フローの式が自分のストックを参照している（リンクなし） */
  via: "link" | "flow" | "reference";
  /** 遅れの印（‖）のあるリンクか、フローか */
  delay?: true;
}

export interface FeedbackLoop {
  /** R1、B2 など（種類ごとの通し番号）。極性が決まっていなければ ?1 など */
  name: string;
  kind: LoopKind;
  /** ループを作る要素名。原因から結果の順で、最後の要素は最初の要素につながる */
  elements: string[];
  steps: LoopStep[];
}

/** 図で目立たせるループ。find_loops の結果から渡す */
export interface LoopView {
  name: string;
  kind: LoopKind;
  elements: string[];
}

export const LOOP_KIND_LABEL: Record<LoopKind, string> = {
  R: "強めるループ",
  B: "釣り合わせるループ",
  unknown: "R か B か決まっていないループ",
};

/** 探すループの数の上限。大きなモデルではループの数が急に増えるため */
export const MAX_LOOPS = 200;
/** ループを探すときにたどる手数の上限。つながりの多いモデルで、探すのに時間がかかりすぎないように */
export const MAX_STEPS = 200_000;

interface Node {
  name: string;
  isStock: boolean;
  out: LoopStep[];
}

/** 因果のつながり。同じ向きのつながりが重なれば、極性の決まっているほうを使う */
function causalGraph(model: ModelJSON): Map<string, Node> {
  const nodes = new Map<string, Node>();
  for (const el of model.elements) {
    if (el.type === "LINK" || !el.name) continue;
    nodes.set(nameKey(el.name), { name: el.name, isStock: el.type === "STOCK", out: [] });
  }
  const add = (from: string, to: string, polarity: Polarity, via: LoopStep["via"], delay = false) => {
    const a = nodes.get(nameKey(from));
    const b = nodes.get(nameKey(to));
    if (!a || !b) return;
    const same = a.out.find((s) => sameName(s.to, b.name));
    if (same) {
      if (same.polarity === "?" && polarity !== "?") Object.assign(same, { polarity, via });
      if (delay) same.delay = true;
      return;
    }
    a.out.push({ from: a.name, to: b.name, polarity, via, ...(delay ? { delay: true as const } : {}) });
  };
  for (const el of model.elements) {
    if (el.type === "LINK" && el.from && el.to) {
      const p = el.behavior?.polarity;
      add(el.from, el.to, p === "POSITIVE" ? "+" : p === "NEGATIVE" ? "-" : "?", "link", hasDelayMark(el));
    }
  }
  for (const el of model.elements) {
    if (el.type !== "FLOW" || !el.name) continue;
    if (el.to) add(el.name, el.to, "+", "flow", hasDelayMark(el));
    // フローの印は、図と同じく行き先の側（流れてから届くまでの遅れ）とする
    if (el.from) add(el.name, el.from, "-", "flow");
    // フローは自分のストックをリンクなしで参照できる
    for (const eq of equationsOf(el)) {
      for (const ref of referencesIn(eq.text)) {
        if (sameName(ref, el.from) || sameName(ref, el.to)) add(ref, el.name, "?", "reference");
      }
    }
  }
  return nodes;
}

export function loopKind(steps: LoopStep[]): LoopKind {
  if (steps.some((s) => s.polarity === "?")) return "unknown";
  return steps.filter((s) => s.polarity === "-").length % 2 === 0 ? "R" : "B";
}

/**
 * 強連結成分（互いに行き来できる要素の組）の番号。ループはこの組の外に出ないので、探す範囲を組の中に絞る
 */
function components(graph: Map<string, Node>): Map<string, number> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const comp = new Map<string, number>();
  const stack: string[] = [];
  let next = 0;
  let count = 0;
  const visit = (v: string) => {
    index.set(v, next);
    low.set(v, next++);
    stack.push(v);
    for (const s of graph.get(v)!.out) {
      const w = nameKey(s.to);
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (!comp.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      let w: string;
      do {
        w = stack.pop()!;
        comp.set(w, count);
      } while (w !== v);
      count++;
    }
  };
  for (const v of graph.keys()) if (!index.has(v)) visit(v);
  return comp;
}

/**
 * モデルのフィードバックループを探す。
 * 短いループから順に探し（長さ 1, 2, 3, … と広げる）、数が maxLoops を超えるか、たどった手数が maxSteps を超えたら
 * そこでやめて truncated に理由（loops：数、steps：手数）を入れる。ある長さの途中でやめるので、
 * 残るのは、返した中で最も長いものと同じ長さか、それより長いループ。
 * element を渡すと、その要素を通るループだけを探す（上限もその中で数える）。
 * 並びは短い順、同じ長さなら通るストックの多い順（短いループほど説明しやすく、長いループは短いものの組み合わせであることが多いため）。
 * 名前（R1 など）は、返すループの中での通し番号（絞り込みを変えると変わる）。
 * 各ループの要素は、通るストックのうちモデルで先に出てくるものから始める。
 */
export function findLoops(
  model: ModelJSON,
  opts: { element?: string; maxLength?: number; maxLoops?: number; maxSteps?: number } = {},
): { loops: FeedbackLoop[]; truncated: false | "loops" | "steps" } {
  const graph = causalGraph(model);
  const keys = [...graph.keys()];
  const order = new Map(keys.map((k, i) => [k, i]));
  const comp = components(graph);
  const maxLoops = opts.maxLoops ?? MAX_LOOPS;
  const maxSteps = opts.maxSteps ?? MAX_STEPS;
  const focus = opts.element === undefined ? undefined : nameKey(opts.element);
  if (focus !== undefined && !graph.has(focus)) return { loops: [], truncated: false };
  // element がなければ、各ループはモデルで最初に出てくる要素から 1 度だけ見つける（それより前の要素は通らない）。
  // element があれば、その要素から始めて戻ってくるループだけを見つける
  const starts = focus !== undefined ? [focus] : keys;
  const size = new Map<number, number>();
  for (const c of comp.values()) size.set(c, (size.get(c) ?? 0) + 1);
  const longest = Math.min(opts.maxLength ?? Infinity, Math.max(0, ...starts.map((k) => size.get(comp.get(k)!)!)));

  const found: LoopStep[][] = [];
  let steps = 0;
  let truncated: false | "loops" | "steps" = false;
  for (let length = 1; length <= longest && !truncated; length++) {
    for (const start of starts) {
      const startIndex = order.get(start)!;
      const startComp = comp.get(start)!;
      if (size.get(startComp)! < length) continue;
      const path: LoopStep[] = [];
      const onPath = new Set<string>([start]);
      const visit = (key: string): boolean => {
        for (const step of graph.get(key)!.out) {
          const next = nameKey(step.to);
          if (comp.get(next) !== startComp) continue;
          if (next === start) {
            if (path.length + 1 !== length) continue;
            if (found.length >= maxLoops) return !!(truncated = "loops");
            found.push([...path, step]);
            continue;
          }
          if (focus === undefined && order.get(next)! < startIndex) continue;
          if (onPath.has(next) || path.length + 2 > length) continue;
          if (++steps > maxSteps) return !!(truncated = "steps");
          path.push(step);
          onPath.add(next);
          const stop = visit(next);
          onPath.delete(next);
          path.pop();
          if (stop) return true;
        }
        return false;
      };
      if (visit(start)) break;
    }
  }

  const stockOrder = (name: string) => (graph.get(nameKey(name))!.isStock ? order.get(nameKey(name))! : Infinity);
  const loops = found.map((steps) => {
    // 先に出てくるストックから始める
    const first = steps.reduce((best, st, i) => (stockOrder(st.from) < stockOrder(steps[best]!.from) ? i : best), 0);
    const rotated = [...steps.slice(first), ...steps.slice(0, first)];
    return { steps: rotated, elements: rotated.map((st) => st.from), kind: loopKind(rotated) };
  });
  const stocks = (l: { elements: string[] }) => l.elements.filter((e) => graph.get(nameKey(e))!.isStock).length;
  loops.sort((a, b) => a.elements.length - b.elements.length || stocks(b) - stocks(a));

  const count: Record<LoopKind, number> = { R: 0, B: 0, unknown: 0 };
  return {
    loops: loops.map((l) => ({ name: `${l.kind === "unknown" ? "?" : l.kind}${++count[l.kind]}`, ...l })),
    truncated,
  };
}

/**
 * 要素名の並びがループになっているかを確かめ、つながりと R / B を返す。
 * 並びの順につながり、最後の要素が最初の要素につながっていなければ、つながっていないところを error で返す。
 * 同じ要素が 2 度出てくる並び（8 の字など）も error にする（R / B を正しく決められないため）。
 */
export function describeLoop(model: ModelJSON, elements: string[]): { loop: Omit<FeedbackLoop, "name"> } | { error: string } {
  if (!elements.length) return { error: "ループの要素名がありません。" };
  const graph = causalGraph(model);
  const missing = elements.filter((e) => !graph.has(nameKey(e)));
  if (missing.length) return { error: `要素が見つかりません: ${missing.map((e) => `"${e}"`).join("、")}` };
  const twice = elements.filter((e, i) => elements.findIndex((x) => nameKey(x) === nameKey(e)) !== i);
  if (twice.length) return { error: `同じ要素が 2 度出てきます: ${twice.map((e) => `"${e}"`).join("、")}（ループは同じ要素を 1 度だけ通る並びで渡してください）` };
  const steps: LoopStep[] = [];
  for (const [i, e] of elements.entries()) {
    const next = elements[(i + 1) % elements.length]!;
    const step = graph.get(nameKey(e))!.out.find((s) => sameName(s.to, next));
    if (!step) return { error: `"${graph.get(nameKey(e))!.name}" から "${graph.get(nameKey(next))!.name}" へのつながり（リンクかフロー）がありません。` };
    steps.push(step);
  }
  return { loop: { kind: loopKind(steps), elements: steps.map((s) => s.from), steps } };
}
