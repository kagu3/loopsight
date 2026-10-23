import { hasDelayMark } from "./delay.js";
import type { ModelElement, ModelJSON } from "./modeljson.js";

/** AI が読みやすい、座標などを省いたモデルの要約 */
export interface ModelSummary {
  /** モデルの表示名（ModelJSON の name） */
  title?: string;
  description?: string;
  simulation: ModelJSON["simulation"];
  counts: Record<string, number>;
  stocks: Record<string, unknown>[];
  flows: Record<string, unknown>[];
  variables: Record<string, unknown>[];
  converters: Record<string, unknown>[];
  states?: Record<string, unknown>[];
  transitions?: Record<string, unknown>[];
  links: string[];
  scenarios?: string[];
}

function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}

/** 図で強調している要素なら true（ふつうなら項目を出さない） */
function emphasis(el: ModelElement): true | undefined {
  return el.display?.emphasis === true ? true : undefined;
}

function interactive(el: ModelElement): string | undefined {
  const d = el.display;
  if (!d?.interactive) return undefined;
  return `スライダー ${d.interactive_min ?? "?"}〜${d.interactive_max ?? "?"}`;
}

export function summarizeModel(model: ModelJSON): ModelSummary {
  const of = (type: string) => model.elements.filter((e) => e.type === type);
  const counts: Record<string, number> = {};
  for (const e of model.elements) counts[e.type] = (counts[e.type] ?? 0) + 1;

  const summary: ModelSummary = {
    title: model.name,
    description: model.description,
    simulation: model.simulation,
    counts,
    stocks: of("STOCK").map((e) =>
      compact({ name: e.name, initial_value: e.behavior?.initial_value, units: e.behavior?.units, non_negative: e.behavior?.non_negative, slider: interactive(e), emphasis: emphasis(e), description: e.description }),
    ),
    flows: of("FLOW").map((e) =>
      // from と to の null は「モデルの外」
      ({ name: e.name, from: e.from ?? null, to: e.to ?? null, ...compact({ value: e.behavior?.value, units: e.behavior?.units, non_negative: e.behavior?.non_negative, delay_mark: hasDelayMark(e) || undefined, description: e.description }) }),
    ),
    variables: of("VARIABLE").map((e) => compact({ name: e.name, value: e.behavior?.value, units: e.behavior?.units, slider: interactive(e), emphasis: emphasis(e), description: e.description })),
    converters: of("CONVERTER").map((e) =>
      compact({
        name: e.name,
        input: e.behavior?.input === "ELEMENT" ? e.behavior?.input_element : "TIME",
        interpolation: e.behavior?.interpolation,
        data: e.behavior?.data,
        units: e.behavior?.units,
        emphasis: emphasis(e),
        description: e.description,
      }),
    ),
    links: of("LINK").map((e) => {
      const p = e.behavior?.polarity;
      return `${e.from ?? "?"} → ${e.to ?? "?"}${p === "POSITIVE" ? " (+)" : p === "NEGATIVE" ? " (-)" : ""}${hasDelayMark(e) ? " ‖遅れ" : ""}`;
    }),
  };
  if (counts.STATE) summary.states = of("STATE").map((e) => compact({ name: e.name, initial_value: e.behavior?.initial_value, emphasis: emphasis(e), description: e.description }));
  if (counts.TRANSITION) {
    summary.transitions = of("TRANSITION").map((e) => compact({ name: e.name, from: e.from, to: e.to, trigger: e.behavior?.trigger, value: e.behavior?.value }));
  }
  if (model.scenarios?.length) summary.scenarios = model.scenarios.map((s) => s.name ?? "(名前なし)");
  return compact(summary as unknown as Record<string, unknown>) as unknown as ModelSummary;
}
