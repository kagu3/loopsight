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
//
// ループには名前（「口コミ」など）を付けて、モデルの loops に保存できる（ループサイト独自の項目。setLoops）。
// ループは通る要素の並びで見分ける（loopKey）ので、極性が変わって R / B が変わっても、同じ名前のまま。
// 名前の付いたループは、find_loops とビューアの一覧で先に並べる
import { hasDelayMark } from "./delay.js";
import { EditError } from "./edit.js";
import { didYouMean, equationsOf, nameKey, referencesIn, sameName, type ModelJSON, type NamedLoop } from "./modeljson.js";

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
  symbol: string;
  /** モデルの loops で付けた名前（なければ付けない） */
  name?: string;
  kind: LoopKind;
  /** ループを作る要素名。原因から結果の順で、最後の要素は最初の要素につながる */
  elements: string[];
  steps: LoopStep[];
}

/** 図で目立たせるループ。find_loops の結果から渡す */
export interface LoopView {
  /** 札に大きく出す名前（付けた名前か、R1 などの記号か、「強めるループ」などの種類の名前） */
  name: string;
  /** 名前を付けたループの R1 などの記号。札に小さく添える */
  symbol?: string;
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
 * 残るのは、返した名前のないループの中で最も長いものと同じ長さか、それより長いループ（あとで足す名前付きのループは、この長さの順に入らない）。
 * element を渡すと、その要素を通るループだけを探す（上限もその中で数える）。
 * 並びは短い順、同じ長さなら通るストックの多い順（短いループほど説明しやすく、長いループは短いものの組み合わせであることが多いため）。
 * 記号（R1 など）は、返すループの中での通し番号（絞り込みを変えると変わる）。
 * 各ループの要素は、通るストックのうちモデルで先に出てくるものから始める。
 * モデルの loops で名前を付けたループには name を付け、loops の順で先に並べる（記号は振り直さない）。
 * 途中でやめて見つからなかった名前付きのループも、まだループになっていて、絞り込みに合えば足す。
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
  const rotate = (steps: LoopStep[]) => {
    // 先に出てくるストックから始める
    const first = steps.reduce((best, st, i) => (stockOrder(st.from) < stockOrder(steps[best]!.from) ? i : best), 0);
    const rotated = [...steps.slice(first), ...steps.slice(0, first)];
    return { steps: rotated, elements: rotated.map((st) => st.from), kind: loopKind(rotated) };
  };
  const loops = found.map(rotate);
  const stocks = (l: { elements: string[] }) => l.elements.filter((e) => graph.get(nameKey(e))!.isStock).length;
  loops.sort((a, b) => a.elements.length - b.elements.length || stocks(b) - stocks(a));

  // 名前を付けたループ（鍵 → 名前と loops の順）。名前やループが重なっていれば、先のものを使う（重なりは checkLoops で知らせる）
  const named = new Map<string, { name: string; order: number }>();
  for (const [order, l] of wellFormedLoops(model).entries()) {
    const key = loopKey(l.elements);
    if (!named.has(key) && !findNamed(named, l.name)) named.set(key, { name: l.name, order });
  }
  // 途中でやめたときは、見つかっていない名前付きのループを後ろに足す
  if (truncated && named.size) {
    const have = new Set(loops.map((l) => loopKey(l.elements)));
    for (const key of named.keys()) {
      if (have.has(key)) continue;
      const l = wellFormedLoops(model).find((x) => loopKey(x.elements) === key)!;
      const described = describeLoop(model, l.elements);
      if ("error" in described) continue;
      if (focus !== undefined && !described.loop.elements.some((e) => nameKey(e) === focus)) continue;
      if (opts.maxLength !== undefined && described.loop.elements.length > opts.maxLength) continue;
      loops.push(rotate(described.loop.steps));
    }
  }

  const count: Record<LoopKind, number> = { R: 0, B: 0, unknown: 0 };
  const result: FeedbackLoop[] = loops.map((l) => {
    const name = named.get(loopKey(l.elements))?.name;
    return { symbol: `${l.kind === "unknown" ? "?" : l.kind}${++count[l.kind]}`, ...(name !== undefined ? { name } : {}), ...l };
  });
  const orderOf = (l: FeedbackLoop) => (l.name !== undefined ? named.get(loopKey(l.elements))!.order : Infinity);
  // 並べ替えは安定なので、名前のないループは見つけた順のまま
  result.sort((a, b) => (orderOf(a) === orderOf(b) ? 0 : orderOf(a) - orderOf(b)));
  return { loops: result, truncated };
}

/**
 * 要素名の並びがループになっているかを確かめ、つながりと R / B を返す。
 * 並びの順につながり、最後の要素が最初の要素につながっていなければ、つながっていないところを error で返す。
 * 同じ要素が 2 度出てくる並び（8 の字など）も error にする（R / B を正しく決められないため）。
 */
export function describeLoop(model: ModelJSON, elements: string[]): { loop: Omit<FeedbackLoop, "name" | "symbol"> } | { error: string } {
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

const findNamed = (named: Map<string, { name: string }>, name: string) => [...named.values()].some((n) => sameName(n.name, name));

// ---- ループの名前（モデルの loops） ----

/**
 * ループを見分ける鍵。要素名の並びを、どこから回り始めても同じになるよう、名前（小文字）の並びがいちばん小さくなる回し方にそろえる。
 * 極性が変わって R / B が変わっても、同じ要素を同じ順に回るループなら同じ
 */
export function loopKey(elements: string[]): string {
  const keys = elements.map(nameKey);
  let best: string[] | undefined;
  for (let i = 0; i < keys.length; i++) {
    const rotated = [...keys.slice(i), ...keys.slice(0, i)];
    if (!best || rotated.join("\n") < best.join("\n")) best = rotated;
  }
  return (best ?? []).join("\n");
}

/**
 * モデルの loops のうち、形の合うもの（名前が文字で、要素が文字の並び）。
 * 手で書き換えたファイルの loops が並びでなかったり、中に null があったりしても、ループ探しや要素の名前変更が止まらないように
 */
export function wellFormedLoops(model: ModelJSON): NamedLoop[] {
  if (!Array.isArray(model.loops)) return [];
  return model.loops
    .filter((l): l is NamedLoop => !!l && typeof l === "object" && typeof l.name === "string" && !!l.name.trim() && Array.isArray(l.elements))
    .map((l) => ({ name: l.name, elements: l.elements.filter((e): e is string => typeof e === "string") }))
    .filter((l) => l.elements.length > 0);
}

/** 要素名の並びのループに付けた名前（なければ undefined） */
export function loopNameOf(model: ModelJSON, elements: string[]): string | undefined {
  const key = loopKey(elements);
  return wellFormedLoops(model).find((l) => loopKey(l.elements) === key)?.name;
}

/** set_loops の 1 件分 */
export interface LoopPatch {
  /** ループの名前。あれば直し、なければ足す */
  name: string;
  /** 名前を変える */
  rename_to?: string;
  /** ループが通る要素の名前を、つながる順に（find_loops の elements）。新しく名前を付けるときは必須 */
  elements?: string[];
}

export interface LoopReport {
  added: string[];
  updated: string[];
  removed: string[];
  notes: string[];
}

function checkLoopName(name: string, loops: NamedLoop[], self?: NamedLoop): string {
  const n = name.trim();
  if (!n) throw new EditError("ループの名前（name）が空です。");
  if (loops.some((l) => l !== self && sameName(l.name, n))) throw new EditError(`"${n}" という名前のループがすでにあります。`);
  return n;
}

/**
 * ループに名前を付け・直し・外す。モデルはその場で書き換える。
 * 名前で付けた名前を探し、あれば直し（名前を変える、ループを付け替える）、なければ足す。remove で外し、replace なら今の名前をすべて捨ててから足す。
 * elements は、並びの順につながって元に戻るループでなければエラー。要素の名前は要素の表記にそろえる。
 * ほかの名前の付いたループに名前を付けると、前の名前は外す（1 つのループに名前は 1 つ）
 */
export function setLoops(model: ModelJSON, patches: LoopPatch[], options: { remove?: string[]; replace?: boolean } = {}): LoopReport {
  const report: LoopReport = { added: [], updated: [], removed: [], notes: [] };
  // 形の合わないもの（手で書き換えたものなど）は、保存し直すときに捨てる。ループでなくなったものは残す
  const loops = options.replace ? [] : wellFormedLoops(model);
  if (options.replace) report.removed.push(...wellFormedLoops(model).map((l) => l.name));

  const find = (name: string) => loops.find((l) => sameName(l.name, name.trim()));
  for (const name of options.remove ?? []) {
    const l = find(name);
    if (!l) throw new EditError(`名前を外すループ "${name}" が見つかりません。${didYouMean(name, loops.map((x) => x.name))}`);
    report.removed.push(l.name);
    loops.splice(loops.indexOf(l), 1);
  }

  for (const p of patches) {
    if (typeof p.name !== "string" || !p.name.trim()) throw new EditError("ループには name が必要です。");
    let l = find(p.name);
    if (!l) {
      if (p.rename_to !== undefined) throw new EditError(`名前を変えるループ "${p.name}" が見つかりません。${didYouMean(p.name, loops.map((x) => x.name))}`);
      if (!p.elements?.length) {
        throw new EditError(`ループ "${p.name.trim()}" に名前を付けるには、elements（ループが通る要素の名前を、つながる順に）が必要です。find_loops の elements を渡してください。`);
      }
      l = { name: checkLoopName(p.name, loops), elements: [] };
      loops.push(l);
      report.added.push(l.name);
    } else {
      if (p.rename_to !== undefined) {
        const before = l.name;
        l.name = checkLoopName(p.rename_to, loops, l);
        if (before !== l.name) report.notes.push(`ループの名前 "${before}" を "${l.name}" に変えました。`);
      }
      report.updated.push(l.name);
    }
    if (p.elements !== undefined) {
      const found = describeLoop(model, p.elements);
      if ("error" in found) throw new EditError(`ループ "${l.name}" の elements がループになっていません。${found.error}`);
      const self = l;
      self.elements = found.loop.elements;
      const key = loopKey(self.elements);
      for (const other of [...loops]) {
        if (other === self || loopKey(other.elements) !== key) continue;
        loops.splice(loops.indexOf(other), 1);
        report.removed.push(other.name);
        report.notes.push(`同じループに付いていた名前 "${other.name}" を外し、"${self.name}" にしました（1 つのループに名前は 1 つ）。`);
      }
    }
  }

  if (loops.length) model.loops = loops;
  else delete model.loops;
  return report;
}

/**
 * 名前を付けたが、モデルが変わってループでなくなったものの名前（checkLoops の「モデルにありません」と同じもの）。
 * 重なった名前の 2 つ目（大文字と小文字だけ違うものも）は入れない（名前で外すと、先のものが外れるため）
 */
export function missingLoops(model: ModelJSON): string[] {
  const seen: string[] = [];
  const missing: string[] = [];
  for (const l of wellFormedLoops(model)) {
    if (seen.some((n) => sameName(n, l.name))) continue;
    seen.push(l.name);
    if ("error" in describeLoop(model, l.elements)) missing.push(l.name);
  }
  return missing;
}

/** 要素の名前を変えたとき、名前を付けたループの中の名前も変える */
export function renameInLoops(model: ModelJSON, oldName: string, newName: string): void {
  if (!Array.isArray(model.loops)) return;
  for (const l of model.loops) {
    if (!l || typeof l !== "object" || !Array.isArray(l.elements)) continue;
    l.elements = l.elements.map((e) => (typeof e === "string" && sameName(e, oldName) ? newName : e));
  }
}

/**
 * モデルの loops の問題（validate_model の警告）。名前を付けたループが、モデルが変わってループでなくなったときなど。
 * 項目は消さずに残す（要素を戻せば、また同じ名前で出る）
 */
export function checkLoops(model: ModelJSON): { message: string; hint?: string }[] {
  if (model.loops === undefined) return [];
  const hint = "set_loops の elements で付け直すか、remove で名前を外してください。";
  if (!Array.isArray(model.loops)) return [{ message: "loops が並び（配列）になっていません。", hint: "set_loops の replace で作り直してください。" }];
  const issues: { message: string; hint?: string }[] = [];
  const seenNames: string[] = [];
  const seenKeys = new Map<string, string>();
  for (const l of model.loops as unknown[]) {
    const item = l as Partial<NamedLoop> | null;
    if (!item || typeof item !== "object" || typeof item.name !== "string" || !item.name.trim() || !Array.isArray(item.elements) || !item.elements.length || !item.elements.every((e) => typeof e === "string")) {
      issues.push({ message: "loops に、名前（name）と要素の名前の並び（elements）のそろっていないものがあります。", hint: "set_loops で付け直してください（形の合わないものは、保存し直すときに捨てます）。" });
      continue;
    }
    const name = item.name;
    if (seenNames.some((n) => sameName(n, name))) {
      issues.push({ message: `ループの名前 "${name}" が重なっています。`, hint });
      continue;
    }
    seenNames.push(name);
    const found = describeLoop(model, item.elements);
    if ("error" in found) {
      issues.push({ message: `名前を付けたループ "${name}" が、モデルにありません（${found.error}）。`, hint });
      continue;
    }
    const key = loopKey(item.elements);
    const other = seenKeys.get(key);
    if (other !== undefined) issues.push({ message: `ループの名前 "${other}" と "${name}" が、同じループに付いています。`, hint });
    else seenKeys.set(key, name);
  }
  return issues;
}
