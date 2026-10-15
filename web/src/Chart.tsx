import { useEffect, useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from "recharts";
import type { ModelJSON, RunResult } from "../../src/viewer/api.js";

// 実行結果の時系列グラフと表。
// 色は検証済みの 8 色を順に使う。色は要素ごとに決め、ほかの要素を出し入れしても変えない。
// 9 色目は作らないので、同時に出せるのは 8 本まで。

export const MAX_SERIES = 8;
const SLOTS = ["--series-1", "--series-2", "--series-3", "--series-4", "--series-5", "--series-6", "--series-7", "--series-8"];

const TIME_UNIT_LABEL: Record<string, string> = {
  seconds: "秒",
  minutes: "分",
  hours: "時間",
  days: "日",
  weeks: "週",
  months: "月",
  years: "年",
};

export function formatValue(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs !== 0 && (abs >= 1e9 || abs < 1e-3)) return v.toExponential(3);
  return v.toLocaleString("ja-JP", { maximumFractionDigits: abs >= 100 ? 2 : 4 });
}

/** 時刻は桁区切りなし（2014.5 年のように） */
function formatTime(t: number | null | undefined): string {
  if (t === null || t === undefined || !Number.isFinite(t)) return "—";
  return t.toLocaleString("ja-JP", { useGrouping: false, maximumFractionDigits: 4 });
}

/** グラフに出せる要素（数値の結果があるもの）を、モデルの並び順で */
function candidatesOf(model: ModelJSON, run: RunResult): { name: string; type: string }[] {
  return model.elements
    .filter((e) => e.name && e.type !== "LINK" && run.series[e.name]?.some((v) => v !== null))
    .map((e) => ({ name: e.name!, type: e.type }));
}

/** 最初に出す要素：モデルのグラフ設定の最初のもの。なければストック */
function defaultVisible(model: ModelJSON, names: string[]): string[] {
  const has = new Set(names.map((n) => n.toLowerCase()));
  const fromViz = (model.visualizations?.[0]?.elements ?? []).filter((n) => has.has(n.toLowerCase()));
  const pick = fromViz.length ? fromViz : model.elements.filter((e) => e.type === "STOCK" && e.name && has.has(e.name.toLowerCase())).map((e) => e.name!);
  return (pick.length ? pick : names).slice(0, MAX_SERIES);
}

/** 見えている要素に色の枠を割り当てる。すでに割り当てた要素はそのまま */
function assignSlots(visible: string[], prev: Map<string, number>): Map<string, number> {
  const next = new Map<string, number>();
  for (const n of visible) if (prev.has(n)) next.set(n, prev.get(n)!);
  for (const n of visible) {
    if (next.has(n)) continue;
    const used = new Set(next.values());
    const free = SLOTS.findIndex((_, i) => !used.has(i));
    next.set(n, free);
  }
  return next;
}

export interface ChartProps {
  modelName: string;
  model: ModelJSON;
  run: RunResult;
}

export function Chart({ modelName, model, run }: ChartProps) {
  const candidates = useMemo(() => candidatesOf(model, run), [model, run]);
  const names = useMemo(() => candidates.map((c) => c.name), [candidates]);
  const [visible, setVisible] = useState<string[]>(() => defaultVisible(model, names));
  const [slots, setSlots] = useState<Map<string, number>>(() => assignSlots(visible, new Map()));
  const [view, setView] = useState<"chart" | "table">("chart");

  // 別のモデルを開いたら選び直す。同じモデルの更新では、消えた要素だけ外す
  const [shownModel, setShownModel] = useState(modelName);
  useEffect(() => {
    if (shownModel !== modelName) {
      setShownModel(modelName);
      const v = defaultVisible(model, names);
      setVisible(v);
      setSlots(assignSlots(v, new Map()));
      return;
    }
    const keep = visible.filter((n) => names.includes(n));
    if (keep.length !== visible.length) {
      const v = keep.length ? keep : defaultVisible(model, names);
      setVisible(v);
      setSlots((s) => assignSlots(v, s));
    }
  }, [modelName, model, names]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (name: string) => {
    const v = visible.includes(name) ? visible.filter((n) => n !== name) : [...visible, name];
    if (v.length > MAX_SERIES) return;
    // 並びはモデルの順にそろえる（凡例と表の列の順）
    const ordered = names.filter((n) => v.includes(n));
    setVisible(ordered);
    setSlots((s) => assignSlots(ordered, s));
  };

  // Recharts の dataKey は「.」を入れ子のパスとして読むので、要素名ではなく番号で持つ
  const keyOf = (name: string) => `s${names.indexOf(name)}`;
  const data = useMemo(
    () =>
      run.times.map((t, i) => {
        const row: Record<string, number | null> = { t };
        for (const n of visible) row[keyOf(n)] = run.series[n]?.[i] ?? null;
        return row;
      }),
    [run, visible, names], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const unit = TIME_UNIT_LABEL[run.time_units.toLowerCase()] ?? run.time_units;
  const colorOf = (name: string) => `var(${SLOTS[slots.get(name) ?? 0]})`;

  return (
    <div className="chart-panel">
      <div className="chart-toolbar">
        <div className="segmented" role="tablist" aria-label="表示の切り替え">
          <button role="tab" aria-selected={view === "chart"} className={view === "chart" ? "on" : ""} onClick={() => setView("chart")}>
            グラフ
          </button>
          <button role="tab" aria-selected={view === "table"} className={view === "table" ? "on" : ""} onClick={() => setView("table")}>
            表
          </button>
        </div>
        <div className="series-picker" aria-label="表示する要素">
          {candidates.map((c) => {
            const on = visible.includes(c.name);
            const full = !on && visible.length >= MAX_SERIES;
            return (
              <label key={c.name} className={`series-chip ${on ? "on" : ""} ${full ? "full" : ""}`} title={full ? `同時に出せるのは ${MAX_SERIES} 本までです` : c.type}>
                <input type="checkbox" checked={on} disabled={full} onChange={() => toggle(c.name)} />
                {on && <span className="swatch" style={{ background: colorOf(c.name) }} />}
                {c.name}
              </label>
            );
          })}
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="muted pad">表示する要素を選んでください。</p>
      ) : view === "chart" ? (
        <div className="chart-area">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
              <CartesianGrid stroke="var(--grid)" vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                domain={["dataMin", "dataMax"]}
                tick={{ fill: "var(--text-secondary)", fontSize: 12 }}
                tickFormatter={(v: number) => formatTime(v)}
                stroke="var(--axis)"
                label={{ value: `時間（${unit}）`, position: "insideBottomRight", offset: -4, fill: "var(--text-secondary)", fontSize: 12 }}
                height={36}
              />
              <YAxis tick={{ fill: "var(--text-secondary)", fontSize: 12 }} stroke="var(--axis)" tickFormatter={(v: number) => formatValue(v)} width={72} />
              <Tooltip
                cursor={{ stroke: "var(--text-muted)", strokeWidth: 1 }}
                content={(p: TooltipContentProps) => <ChartTooltip {...p} unit={unit} visible={visible} keyOf={keyOf} colorOf={colorOf} />}
                isAnimationActive={false}
              />
              {visible.map((n) => (
                <Line
                  key={n}
                  type="linear"
                  dataKey={keyOf(n)}
                  name={n}
                  stroke={colorOf(n)}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface-1)" }}
                  isAnimationActive={false}
                  connectNulls={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="table-area">
          <table>
            <thead>
              <tr>
                <th>時間（{unit}）</th>
                {visible.map((n) => (
                  <th key={n}>{n}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {run.times.map((t, i) => (
                <tr key={i}>
                  <td>{formatTime(t)}</td>
                  {visible.map((n) => (
                    <td key={n}>{formatValue(run.series[n]?.[i])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ChartTooltip(
  p: TooltipContentProps & { unit: string; visible: string[]; keyOf(n: string): string; colorOf(n: string): string },
) {
  if (!p.active || !p.payload?.length) return null;
  const row = p.payload[0]!.payload as Record<string, number | null>;
  return (
    <div className="tooltip">
      <div className="tooltip-title">
        {formatTime(row.t)} {p.unit}
      </div>
      {p.visible.map((n) => (
        <div key={n} className="tooltip-row">
          <span className="swatch" style={{ background: p.colorOf(n) }} />
          <span className="tooltip-name">{n}</span>
          <span className="tooltip-value">{formatValue(row[p.keyOf(n)])}</span>
        </div>
      ))}
    </div>
  );
}
