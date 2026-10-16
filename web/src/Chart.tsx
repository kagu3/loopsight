import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from "recharts";
import type { ActualDataResult, ModelJSON, RunResult, ScenarioRunResult } from "../../src/viewer/api.js";
import { sameTime, withActualPoints } from "./actualPoints.js";
import { normalize, normalizeLike, normalizeTogether } from "./normalize.js";
import { BASELINE_NAME, compareRuns, describeRun, resultRows, valueRows, type CompareRun, type CompareRuns } from "./scenarios.js";
import { groupCandidates, type SeriesCandidate } from "./seriesPicker.js";

// 実行結果の時系列グラフと表。
// 色は検証済みの 8 色を順に使う。色は要素ごとに決め、ほかの要素を出し入れしても変えない。
// 9 色目は作らないので、同時に出せるのは 8 本まで。
// モデルに施策（シナリオ）が保存されていれば、要素ごとに小さなグラフを並べ、「何もしない場合」（灰色の点線）と施策を重ねる。
// このときの色は施策ごとに決める（施策も 8 つまで）。
// 実際のデータ（<モデル名>.data.csv）がある要素は、同じ色の白抜きの丸を線に重ねる（線の上の、塗りつぶした丸と見分けるため）。
// 施策を重ねているときは、施策の色と見分けられるよう、文字の色の白抜きの丸にする。

export const MAX_SERIES = 8;
const SLOTS = ["--series-1", "--series-2", "--series-3", "--series-4", "--series-5", "--series-6", "--series-7", "--series-8"];

export const TIME_UNIT_LABEL: Record<string, string> = {
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
export function formatTime(t: number | null | undefined): string {
  if (t === null || t === undefined || !Number.isFinite(t)) return "—";
  return t.toLocaleString("ja-JP", { useGrouping: false, maximumFractionDigits: 4 });
}

/** グラフに出せる要素（数値の結果があるもの）を、モデルの並び順で */
function candidatesOf(model: ModelJSON, run: RunResult): SeriesCandidate[] {
  return model.elements
    .filter((e) => e.name && e.type !== "LINK" && run.series[e.name]?.some((v) => v !== null))
    .map((e) => ({ name: e.name!, type: e.type }));
}

/** 最初に出す要素：モデルのグラフ設定の最初のもの。なければストック */
function defaultVisible(model: ModelJSON, names: string[]): string[] {
  // グラフ設定の名前は大文字と小文字が要素と違うことがあるので、要素の表記にそろえる
  const canonical = new Map(names.map((n) => [n.toLowerCase(), n]));
  const has = new Set(canonical.keys());
  const fromViz = (model.visualizations?.[0]?.elements ?? []).flatMap((n) => {
    const c = canonical.get(n.toLowerCase());
    return c ? [c] : [];
  });
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

/**
 * 縦軸の決め方。
 * - value: 値そのまま
 * - normalized: 要素ごとに、最小を 0%、最大を 100% にそろえる。大きさの違う要素の、増え方や減り方の形を比べるため
 */
type Scale = "value" | "normalized";
const SCALE_KEY = "viewer.chartScale";
function loadScale(): Scale {
  try {
    return localStorage.getItem(SCALE_KEY) === "normalized" ? "normalized" : "value";
  } catch {
    return "value";
  }
}
function saveScale(scale: Scale) {
  try {
    localStorage.setItem(SCALE_KEY, scale);
  } catch {
    // 覚えられなくても動く
  }
}

const formatPercent = (v: number) => `${Math.round(v * 100)}%`;

/** 施策の凡例を開いて、施策の中身の表にしているか（縦軸と同じく、ブラウザに覚えておく） */
const MATRIX_KEY = "viewer.scenarioMatrix";
function loadMatrixOpen(): boolean {
  try {
    return localStorage.getItem(MATRIX_KEY) === "open";
  } catch {
    return false;
  }
}
function saveMatrixOpen(open: boolean) {
  try {
    localStorage.setItem(MATRIX_KEY, open ? "open" : "closed");
  } catch {
    // 覚えられなくても動く
  }
}

export interface ChartProps {
  modelName: string;
  model: ModelJSON;
  run: RunResult;
  /** 保存した施策の実行結果 */
  scenarios?: ScenarioRunResult[];
  /** 実際のデータ。あれば点で重ねる */
  actual?: ActualDataResult;
  /** 左の欄で直している施策の名前（凡例で目立たせる） */
  editingScenario?: string;
  /** 施策の編集欄を開く。name がなければ施策を足す */
  onEditScenario?(name?: string): void;
  /** 施策の凡例（開いたときは表の列の見出し）にカーソルを乗せた・外した（図の変えた要素に札を付ける）。「何もしない場合」では呼ばない */
  onFocusScenario?(name: string | undefined): void;
}

/** 「何もしない場合」の線の色と点線 */
const BASELINE_COLOR = "var(--text-muted)";
const BASELINE_DASH = "4 4";
const runColor = (r: CompareRun, k: number) => (r.baseline ? BASELINE_COLOR : `var(${SLOTS[(k - 1) % SLOTS.length]})`);

/** 施策の線の色（凡例と同じ）。実行できなかった施策と、色が足りずに出さない施策は undefined */
export function scenarioColor(run: RunResult, scenarios: ScenarioRunResult[], name: string): string | undefined {
  const runs = compareRuns(run, scenarios, MAX_SERIES).runs;
  const k = runs.findIndex((r) => !r.baseline && r.name.toLowerCase() === name.toLowerCase());
  return k > 0 ? runColor(runs[k]!, k) : undefined;
}

/** 施策を重ねているときの、実際のデータの点の色 */
const ACTUAL_COMPARE_COLOR = "var(--text-primary)";

export function Chart({ modelName, model, run, scenarios, actual, editingScenario, onEditScenario, onFocusScenario }: ChartProps) {
  const candidates = useMemo(() => candidatesOf(model, run), [model, run]);
  const names = useMemo(() => candidates.map((c) => c.name), [candidates]);
  const [visible, setVisible] = useState<string[]>(() => defaultVisible(model, names));
  const [slots, setSlots] = useState<Map<string, number>>(() => assignSlots(visible, new Map()));
  const [view, setView] = useState<"chart" | "table">("chart");
  const [scale, setScaleState] = useState<Scale>(loadScale);
  // 施策を重ねるか。施策が保存されていれば、はじめは重ねる
  const [overlay, setOverlay] = useState(true);
  const compare = useMemo(() => compareRuns(run, scenarios ?? [], MAX_SERIES), [run, scenarios]);
  const hasScenarios = (scenarios?.length ?? 0) > 0;
  const comparing = overlay && hasScenarios;
  // 施策を重ねたグラフにカーソルを乗せている時点（施策の中身の表の、結果の行に出す）
  const [hoverTime, setHoverTime] = useState<number | undefined>();
  // マウスが出ないままグラフが消えたり（要素を外す・表にする）、別のモデルを開いたりしたら、時点を忘れる
  useEffect(() => setHoverTime(undefined), [modelName, view, visible]);
  const setScale = (s: Scale) => {
    setScaleState(s);
    saveScale(s);
  };

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

  // 凡例の × で外す。キーボードで押したときは、消える × の代わりに隣の × か「要素を選ぶ」にフォーカスを移す
  const removeFromLegend = (button: HTMLButtonElement, name: string) => {
    if (document.activeElement === button) {
      const li = button.closest("li");
      const next =
        (li?.nextElementSibling ?? li?.previousElementSibling)?.querySelector<HTMLButtonElement>("button") ??
        button.closest(".chart-toolbar")?.querySelector<HTMLButtonElement>(".picker-button");
      next?.focus();
    }
    toggle(name);
  };

  // Recharts の dataKey は「.」を入れ子のパスとして読むので、要素名ではなく番号で持つ
  const keyOf = (name: string) => `s${names.indexOf(name)}`;
  // 行には時刻と行の番号（i）を持たせる。ツールチップは正規化していても、番号から元の値を出す
  const data = useMemo(() => {
    const series = new Map(visible.map((n) => [n, scale === "normalized" ? normalize(run.series[n] ?? []) : (run.series[n] ?? [])]));
    return run.times.map((t, i) => {
      const row: Record<string, number | null> = { t, i };
      for (const n of visible) row[keyOf(n)] = series.get(n)?.[i] ?? null;
      return row;
    });
  }, [run, visible, names, scale]); // eslint-disable-line react-hooks/exhaustive-deps
  // 実際のデータの点。モデルの線と同じ行に入れる。正規化するときはモデルの線と同じ目盛りにする
  const actualKeyOf = (name: string) => `a${names.indexOf(name)}`;
  const withActual = useMemo(() => {
    const points = new Map<string, { t: number; v: number }[]>();
    for (const n of visible) {
      const values = actual?.series[n];
      if (!values) continue;
      const scaled = scale === "normalized" ? normalizeLike(values, run.series[n] ?? []) : values;
      points.set(actualKeyOf(n), actual!.times.flatMap((t, i) => (scaled[i] == null ? [] : [{ t, v: scaled[i]! }])));
    }
    return { rows: withActualPoints(data, points, visible.map(keyOf)), names: visible.filter((n) => points.has(actualKeyOf(n))) };
  }, [data, actual, run, visible, names, scale]); // eslint-disable-line react-hooks/exhaustive-deps
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
        {hasScenarios && (
          <div className="segmented" role="radiogroup" aria-label="施策">
            <button
              role="radio"
              aria-checked={comparing}
              className={comparing ? "on" : ""}
              onClick={() => setOverlay(true)}
              title={`要素ごとにグラフを分け、「${BASELINE_NAME}」とモデルに保存した施策を重ねます`}
            >
              施策を重ねる
            </button>
            <button
              role="radio"
              aria-checked={!comparing}
              className={!comparing ? "on" : ""}
              onClick={() => setOverlay(false)}
              title={`「${BASELINE_NAME}」だけを、要素を重ねて出します`}
            >
              重ねない
            </button>
          </div>
        )}
        {/* 施策の凡例を出していないとき（施策がない・重ねない）の、施策を足す入口 */}
        {!comparing && onEditScenario && (
          <button className="toolbar-button" onClick={() => onEditScenario()} title={`値を変えた施策を足し、「${BASELINE_NAME}」と重ねて比べます`}>
            ＋ 施策を足す
          </button>
        )}
        {view === "chart" && (
          <div className="segmented" role="radiogroup" aria-label="縦軸">
            <button
              role="radio"
              aria-checked={scale === "value"}
              className={scale === "value" ? "on" : ""}
              onClick={() => setScale("value")}
              title="値をそのまま出します"
            >
              実際の値
            </button>
            <button
              role="radio"
              aria-checked={scale === "normalized"}
              className={scale === "normalized" ? "on" : ""}
              onClick={() => setScale("normalized")}
              title={
                comparing
                  ? "要素ごとに、どの施策も通した最小を 0%、最大を 100% にそろえます"
                  : "要素ごとに、最小を 0%、最大を 100% にそろえます。大きさの違う要素の、変わり方の形を比べられます"
              }
            >
              正規化
            </button>
          </div>
        )}
        <SeriesPicker candidates={candidates} visible={visible} colorOf={colorOf} plain={comparing} onToggle={toggle} />
        {/* 凡例を兼ねる。出している要素だけを色つきで出し、× で外せる。施策を重ねているときの色は施策のものなので、要素には色を付けない */}
        <ul className="series-legend" aria-label="表示している要素">
          {visible.map((n) => (
            <li key={n} className="legend-chip" title={n}>
              {!comparing && <span className="swatch" style={{ background: colorOf(n) }} />}
              <span className="legend-name">{n}</span>
              {withActual.names.includes(n) && <span className="legend-actual" style={{ borderColor: comparing ? ACTUAL_COMPARE_COLOR : colorOf(n) }} title={`点は実際のデータ（${actual!.file}）`} />}
              <button className="legend-remove" onClick={(e) => removeFromLegend(e.currentTarget, n)} aria-label={`${n} を外す`} title="グラフから外す">
                ×
              </button>
            </li>
          ))}
        </ul>
      </div>

      {comparing && (
        <ScenarioLegend
          compare={compare}
          model={model}
          times={run.times}
          visible={visible}
          at={view === "chart" ? hoverTime : undefined}
          unit={unit}
          editing={editingScenario}
          onEdit={onEditScenario}
          onFocus={onFocusScenario}
        />
      )}

      {visible.length === 0 ? (
        <p className="muted pad">表示する要素を選んでください。</p>
      ) : comparing && view === "chart" ? (
        <div className="compare-grid">
          {visible.map((n) => (
            <CompareChart key={n} name={n} times={run.times} runs={compare.runs} unit={unit} scale={scale} actual={actual} onHover={setHoverTime} />
          ))}
        </div>
      ) : comparing ? (
        <div className="table-area">
          <table>
            <thead>
              <tr>
                <th>時間（{unit}）</th>
                {visible.flatMap((n) =>
                  compare.runs.map((r, k) => (
                    <th key={`${n}/${k}`}>
                      {n}
                      <span className="th-sub">{r.name}</span>
                    </th>
                  )),
                )}
              </tr>
            </thead>
            <tbody>
              {run.times.map((t, i) => (
                <tr key={i}>
                  <td>{formatTime(t)}</td>
                  {visible.flatMap((n) => compare.runs.map((r, k) => <td key={`${n}/${k}`}>{formatValue(r.series[n]?.[i])}</td>))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : view === "chart" ? (
        <div className="chart-area">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={withActual.rows} margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
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
              {yAxis(scale)}
              <Tooltip
                cursor={{ stroke: "var(--text-muted)", strokeWidth: 1 }}
                content={(p: TooltipContentProps) => <ChartTooltip {...p} unit={unit} visible={visible} run={run} actual={actual} colorOf={colorOf} />}
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
              {withActual.names.map((n) => (
                <Line
                  key={`actual:${n}`}
                  type="linear"
                  dataKey={actualKeyOf(n)}
                  name={`${n}（実際）`}
                  stroke="none"
                  dot={{ r: 4, fill: "var(--surface-1)", stroke: colorOf(n), strokeWidth: 2 }}
                  activeDot={false}
                  legendType="none"
                  tooltipType="none"
                  isAnimationActive={false}
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

/** 縦軸。正規化しているときは 0%〜100% */
function yAxis(scale: Scale) {
  return scale === "normalized" ? (
    <YAxis
      domain={[0, 1]}
      ticks={[0, 0.25, 0.5, 0.75, 1]}
      tick={{ fill: "var(--text-secondary)", fontSize: 12 }}
      stroke="var(--axis)"
      tickFormatter={formatPercent}
      width={72}
    />
  ) : (
    <YAxis tick={{ fill: "var(--text-secondary)", fontSize: 12 }} stroke="var(--axis)" tickFormatter={(v: number) => formatValue(v)} width={72} />
  );
}

/** 施策の中身の表で、はじめから出す「変えた値」の行の数。超えたぶんは畳んで「ほか N 件」で開く */
const MATRIX_ROWS = 6;

/**
 * 施策の凡例。「何もしない場合」は灰色の点線。実行できなかった施策と、色が足りずに出さない施策も知らせる。
 * onEdit があれば、施策の名前を押すと左の欄で直せる。最後に「＋ 施策を足す」を置く。
 * 「中身を見る」で開くと、凡例がそのまま表の見出しになり、施策ごとに変えた値と結果（グラフで選んでいる要素の値）を並べる
 */
function ScenarioLegend({
  compare,
  model,
  times,
  visible,
  at,
  unit,
  editing,
  onEdit,
  onFocus,
}: {
  compare: CompareRuns;
  model: ModelJSON;
  times: number[];
  /** グラフで選んでいる要素（結果の行） */
  visible: string[];
  /** グラフにカーソルを乗せている時点。なければ最後の時点 */
  at?: number;
  unit: string;
  editing?: string;
  onEdit?(name?: string): void;
  onFocus?(name: string | undefined): void;
}) {
  const [open, setOpenState] = useState(loadMatrixOpen);
  // カーソルを乗せたまま凡例が消えたら（重ねない・別のモデル）、外したことにする
  useEffect(() => () => onFocus?.(undefined), [onFocus]);
  const [showAll, setShowAll] = useState(false);
  const setOpen = (o: boolean) => {
    setOpenState(o);
    saveMatrixOpen(o);
  };
  // 重ねている施策がない（どれも実行できなかった・出していない）ときは、表にしても空なので開かない
  const canOpen = compare.runs.length > 1;
  const isOpen = open && canOpen;
  const isEditing = (n: string) => editing !== undefined && editing.toLowerCase() === n.toLowerCase();
  // 実行できなかった施策と、出していない施策の名前も、押すと直せる
  const nameButton = (n: string) =>
    onEdit ? (
      <button className="link inline-link" onClick={() => onEdit(n)} title={`施策「${n}」を左の欄で直します`}>
        {n}
      </button>
    ) : (
      n
    );
  // 凡例の 1 つ分。閉じているときは帯に並べ、開いているときは表の列の見出しにする（見出しにイベントを足すときは、ここに足す）
  const chip = (r: CompareRun, k: number) => {
    // カーソルを乗せている間（キーボードで選んでいる間も）、図の変えた要素に札を付ける
    const focus =
      r.baseline || !onFocus
        ? {}
        : { onMouseEnter: () => onFocus(r.name), onMouseLeave: () => onFocus(undefined), onFocus: () => onFocus(r.name), onBlur: () => onFocus(undefined) };
    const label = (
      <>
        <LineSwatch color={runColor(r, k)} dashed={r.baseline} />
        <span className="legend-name">{r.name}</span>
        {!r.baseline && (
          <span className="scenario-count" title="この施策で変えた値の数">
            <span aria-hidden="true">{Object.keys(r.values).length}</span>
            <span className="visually-hidden">（変えた値 {Object.keys(r.values).length} 件）</span>
          </span>
        )}
      </>
    );
    return r.baseline || !onEdit ? (
      <span className="scenario-chip-label" {...focus}>
        {label}
      </span>
    ) : (
      <button className={`scenario-chip-button ${isEditing(r.name) ? "on" : ""}`} onClick={() => onEdit(r.name)} aria-pressed={isEditing(r.name)} {...focus}>
        {label}
      </button>
    );
  };
  const addButton = onEdit && (
    <button className="link" onClick={() => onEdit()} title={`値を変えた施策を足し、「${BASELINE_NAME}」と重ねて比べます`}>
      ＋ 施策を足す
    </button>
  );
  const toggle = (
    <button className="link scenario-toggle" aria-expanded={open} onClick={() => setOpen(!open)} title="施策ごとに、変えた値と結果を表で比べます">
      {open ? "▾ 中身を閉じる" : "▸ 中身を見る"}
    </button>
  );
  return (
    <div className={`scenario-bar ${isOpen ? "open" : ""}`}>
      <div className="scenario-head">
        {isOpen ? (
          <ScenarioMatrix compare={compare} model={model} times={times} visible={visible} at={at} unit={unit} chip={chip} showAll={showAll} onShowAll={setShowAll} />
        ) : (
          <ul className="scenario-legend" aria-label="重ねている施策">
            {compare.runs.map((r, k) => (
              <li key={k} className="scenario-chip" title={`${r.name}\n${describeRun(r)}`}>
                {chip(r, k)}
              </li>
            ))}
            {addButton && <li className="scenario-chip">{addButton}</li>}
          </ul>
        )}
        <div className="scenario-tools">
          {isOpen && addButton}
          {canOpen && toggle}
        </div>
      </div>
      {compare.failed.map((f) => (
        <p key={f.name} className="scenario-note error-text" title={f.error}>
          施策「{nameButton(f.name)}」は実行できませんでした: {f.error}
        </p>
      ))}
      {compare.omitted.length > 0 && (
        <p className="scenario-note">
          同時に重ねられる施策は {MAX_SERIES} つまでです。
          {compare.omitted.map((n) => (
            <span key={n}>「{nameButton(n)}」</span>
          ))}
          は出していません
        </p>
      )}
    </div>
  );
}

/**
 * 施策の中身の表。列は凡例と同じ並び（「何もしない場合」と、重ねている施策）。
 * 行は、どれかの施策で変えた値と、結果（グラフで選んでいる要素の、ある時点の値）
 */
function ScenarioMatrix({
  compare,
  model,
  times,
  visible,
  at,
  unit,
  chip,
  showAll,
  onShowAll,
}: {
  compare: CompareRuns;
  model: ModelJSON;
  times: number[];
  visible: string[];
  at?: number;
  unit: string;
  chip(r: CompareRun, k: number): React.ReactNode;
  showAll: boolean;
  onShowAll(all: boolean): void;
}) {
  const runs = compare.runs;
  const rows = useMemo(() => valueRows(model, runs), [model, runs]);
  const results = resultRows(runs, times, visible, at);
  const folding = rows.length > MATRIX_ROWS;
  const shown = folding && !showAll ? rows.slice(0, MATRIX_ROWS) : rows;
  const colSpan = runs.length + 1;
  return (
    <div className="scenario-matrix-scroll">
      <table className="scenario-matrix" aria-label="施策の中身">
        <thead>
          <tr>
            <th scope="col" className="matrix-corner">
              変えた値
            </th>
            {runs.map((r, k) => (
              <th key={k} scope="col" title={`${r.name}\n${describeRun(r)}`}>
                <div className="scenario-chip">{chip(r, k)}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && runs.length > 1 && (
            <tr>
              <td colSpan={colSpan} className="matrix-empty">
                どの施策も値を変えていません
              </td>
            </tr>
          )}
          {shown.map((row) => (
            <tr key={row.element}>
              <th scope="row" title={row.element}>
                <span className="matrix-element">{row.element}</span>
                {row.initial && <small className="matrix-sub">初期値</small>}
              </th>
              {row.cells.map((c, k) =>
                k === 0 ? (
                  <td key={k} className="matrix-base" title={c.value}>
                    {c.value ?? "—"}
                  </td>
                ) : c.changed ? (
                  <td key={k} className="matrix-changed" style={{ "--run-color": runColor(runs[k]!, k) } as React.CSSProperties} title={c.value}>
                    {c.value}
                    {c.change && <small className="matrix-change">{c.change}</small>}
                  </td>
                ) : (
                  <td key={k} className="matrix-same" title="この施策では変えていません">
                    —
                  </td>
                ),
              )}
            </tr>
          ))}
          {folding && (
            <tr>
              <td colSpan={colSpan} className="matrix-fold">
                <button className="link" onClick={() => onShowAll(!showAll)}>
                  {showAll ? "畳む" : `ほか ${rows.length - MATRIX_ROWS} 件`}
                </button>
              </td>
            </tr>
          )}
          {results.map((row, j) => (
            <tr key={row.element} className={`matrix-result ${j === 0 ? "first" : ""}`}>
              <th scope="row" title={`${row.element}（${formatTime(row.time)} ${unit}）の結果`}>
                <span className="matrix-element">{row.element}</span>
                <small className="matrix-sub">
                  （{formatTime(row.time)} {unit}）
                </small>
              </th>
              {row.cells.map((c, k) => (
                <td key={k}>
                  {formatValue(c.value)}
                  {c.change && <small className="matrix-change">{c.change}</small>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 凡例の線の見本。点線も見分けられるように、四角ではなく線で描く */
function LineSwatch({ color, dashed }: { color: string; dashed?: boolean }) {
  return (
    <svg className="line-swatch" width="18" height="10" aria-hidden="true">
      <line x1="1" y1="5" x2="17" y2="5" stroke={color} strokeWidth={2} strokeDasharray={dashed ? "3 2" : undefined} />
    </svg>
  );
}

/**
 * 1 つの要素について、「何もしない場合」と施策を重ねた小さなグラフ。
 * カーソルを乗せている時点を onHover で知らせる（施策の中身の表に出す）。知らせるたびにほかのグラフを描き直さないよう memo にする
 */
const CompareChart = memo(function CompareChart({
  name,
  times,
  runs,
  unit,
  scale,
  actual,
  onHover,
}: {
  name: string;
  times: number[];
  runs: CompareRun[];
  unit: string;
  scale: Scale;
  actual?: ActualDataResult;
  onHover(t: number | undefined): void;
}) {
  // 行には時刻と行の番号（i）を持たせる。ツールチップは正規化していても、番号から元の値を出す
  // 実際のデータの点も同じ行に入れる（キーは a）。正規化するときは、どの施策も通した最小と最大を目盛りにする
  const data = useMemo(() => {
    const raw = runs.map((r) => r.series[name] ?? []);
    const series = scale === "normalized" ? normalizeTogether(raw) : raw;
    const rows = times.map((t, i) => {
      const row: Record<string, number | null> = { t, i };
      series.forEach((values, k) => (row[`r${k}`] = values[i] ?? null));
      return row;
    });
    const values = actual?.series[name];
    if (!values) return rows;
    const scaled = scale === "normalized" ? normalizeLike(values, raw.flat()) : values;
    const points = actual!.times.flatMap((t, i) => (scaled[i] == null ? [] : [{ t, v: scaled[i]! }]));
    return withActualPoints(rows, new Map([["a", points]]), runs.map((_, k) => `r${k}`));
  }, [name, times, runs, scale, actual]);
  return (
    <figure className="compare-cell">
      <figcaption title={name}>{name}</figcaption>
      <div className="compare-chart">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            margin={{ top: 4, right: 16, bottom: 4, left: 0 }}
            onMouseMove={(s) => onHover(s.isTooltipActive && s.activeTooltipIndex != null ? (data[Number(s.activeTooltipIndex)]?.t ?? undefined) : undefined)}
            onMouseLeave={() => onHover(undefined)}
          >
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              domain={["dataMin", "dataMax"]}
              tick={{ fill: "var(--text-secondary)", fontSize: 12 }}
              tickFormatter={(v: number) => formatTime(v)}
              stroke="var(--axis)"
              height={24}
            />
            {yAxis(scale)}
            <Tooltip
              cursor={{ stroke: "var(--text-muted)", strokeWidth: 1 }}
              content={(p: TooltipContentProps) => <CompareTooltip {...p} unit={unit} name={name} runs={runs} actual={actual} />}
              isAnimationActive={false}
            />
            {runs.map((r, k) => (
              <Line
                key={k}
                type="linear"
                dataKey={`r${k}`}
                name={r.name}
                stroke={runColor(r, k)}
                strokeWidth={2}
                strokeDasharray={r.baseline ? BASELINE_DASH : undefined}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface-1)" }}
                isAnimationActive={false}
                connectNulls={false}
              />
            ))}
            {actual?.series[name] && (
              <Line
                type="linear"
                dataKey="a"
                name={`${name}（実際）`}
                stroke="none"
                dot={{ r: 3.5, fill: "var(--surface-1)", stroke: ACTUAL_COMPARE_COLOR, strokeWidth: 2 }}
                activeDot={false}
                legendType="none"
                tooltipType="none"
                isAnimationActive={false}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
});

/** 施策を重ねたグラフのツールチップ。正規化していても実際の値を出す */
function CompareTooltip(p: TooltipContentProps & { unit: string; name: string; runs: CompareRun[]; actual?: ActualDataResult }) {
  if (!p.active || !p.payload?.length) return null;
  const row = p.payload[0]!.payload as Record<string, number | null>;
  // 同じ時刻の実際のデータがあれば、最後に出す
  const j = p.actual?.times.findIndex((t) => sameTime(t, row.t!)) ?? -1;
  const actualValue = j >= 0 ? p.actual!.series[p.name]?.[j] : undefined;
  return (
    <div className="tooltip">
      <div className="tooltip-title">
        {p.name}（{formatTime(row.t)} {p.unit}）
      </div>
      {p.runs.map((r, k) => (
        <div key={k} className="tooltip-row">
          <LineSwatch color={runColor(r, k)} dashed={r.baseline} />
          <span className="tooltip-name">{r.name}</span>
          <span className="tooltip-value">{formatValue(r.series[p.name]?.[row.i!])}</span>
        </div>
      ))}
      {actualValue != null && (
        <div className="tooltip-row">
          <span className="tooltip-actual-mark" style={{ borderColor: ACTUAL_COMPARE_COLOR }} />
          <span className="tooltip-name">実際のデータ</span>
          <span className="tooltip-value">{formatValue(actualValue)}</span>
        </div>
      )}
    </div>
  );
}

/**
 * 要素を選ぶ一覧。ボタンで開け閉めする。
 * 種類ごとにまとめ、上の欄で名前を絞り込める。Esc か一覧の外を押すと閉じる
 */
function SeriesPicker({
  candidates,
  visible,
  colorOf,
  plain,
  onToggle,
}: {
  candidates: SeriesCandidate[];
  visible: string[];
  colorOf(n: string): string;
  /** 要素に色を付けない（施策を重ねているとき） */
  plain?: boolean;
  onToggle(n: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const popoverId = useId();
  const groups = useMemo(() => groupCandidates(candidates, query), [candidates, query]);
  const full = visible.length >= MAX_SERIES;

  const close = (focusButton: boolean) => {
    setOpen(false);
    setQuery("");
    if (focusButton) buttonRef.current?.focus();
  };

  // 一覧の外を押したら閉じる
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  // 一覧はグラフの欄の中に収める。
  // 横：ふだんはボタンの左端から開き、欄（と画面）の右端からはみ出すぶんだけ左へずらす。欄が狭ければ幅も縮める
  // 縦：欄の下の端まで（はみ出すぶんは一覧の中でスクロールする）
  // 絞り込み欄へのフォーカスは位置を決めてから移す。先に移すと、はみ出した一覧に合わせてブラウザが横にスクロールしてしまう
  useLayoutEffect(() => {
    if (!open) return;
    const fit = () => {
      const panel = rootRef.current?.closest(".chart-panel");
      const button = buttonRef.current;
      const popover = popoverRef.current;
      if (!panel || !button || !popover) return;
      const p = panel.getBoundingClientRect();
      const b = button.getBoundingClientRect();
      const left = p.left + 16;
      const right = Math.min(p.right, document.documentElement.clientWidth) - 16;
      const width = Math.min(320, right - left);
      const x = Math.max(left, Math.min(b.left, right - width));
      popover.style.width = `${width}px`;
      popover.style.left = `${x - b.left}px`;
      popover.style.maxHeight = `${Math.min(360, Math.max(160, p.bottom - b.bottom - 12))}px`;
    };
    fit();
    filterRef.current?.focus({ preventScroll: true });
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [open]);

  return (
    <div
      className="series-picker"
      ref={rootRef}
      onKeyDown={(e) => {
        // 日本語の変換中の Esc は変換の取り消しなので、閉じない
        if (e.key === "Escape" && open && !e.nativeEvent.isComposing) {
          e.stopPropagation();
          close(true);
        }
      }}
      onBlur={(e) => {
        // Tab で一覧の外へ移ったら閉じる。
        // 移り先がない（一覧の中の文字や余白を押した）ときは閉じない。外を押したときは pointerdown のほうで閉じる
        if (open && e.relatedTarget && !rootRef.current?.contains(e.relatedTarget as Node)) close(false);
      }}
    >
      <button
        ref={buttonRef}
        className="toolbar-button picker-button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? popoverId : undefined}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        要素を選ぶ（{visible.length}/{MAX_SERIES}）
      </button>
      {open && (
        // tabIndex：見出しや余白を押したときもフォーカスを一覧の中に置き、Esc と Tab で閉じられるようにする
        <div id={popoverId} className="series-popover" role="dialog" aria-label="グラフに出す要素" tabIndex={-1} ref={popoverRef}>
          <input
            ref={filterRef}
            className="series-filter"
            type="search"
            placeholder="名前で絞り込む"
            aria-label="名前で絞り込む"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {full && <p className="series-note">同時に出せるのは {MAX_SERIES} 本までです。1 本外すと選べます</p>}
          <div className="series-groups">
            {groups.length === 0 && <p className="series-note">合う名前がありません</p>}
            {groups.map((g) => (
              <fieldset key={g.type} className="series-group">
                <legend>
                  {g.label}
                  <span className="muted">（{g.items.length}）</span>
                </legend>
                {g.items.map((c) => {
                  const on = visible.includes(c.name);
                  const disabled = !on && full;
                  return (
                    <label key={c.name} className={`series-option ${disabled ? "full" : ""}`} title={disabled ? `同時に出せるのは ${MAX_SERIES} 本までです` : c.name}>
                      <input type="checkbox" checked={on} disabled={disabled} onChange={() => onToggle(c.name)} />
                      {!plain && <span className="swatch" style={{ background: on ? colorOf(c.name) : "transparent" }} />}
                      <span className="series-option-name">{c.name}</span>
                    </label>
                  );
                })}
              </fieldset>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ChartTooltip(
  p: TooltipContentProps & { unit: string; visible: string[]; run: RunResult; actual?: ActualDataResult; colorOf(n: string): string },
) {
  if (!p.active || !p.payload?.length) return null;
  const row = p.payload[0]!.payload as Record<string, number | null>;
  // 同じ時刻の実際のデータがあれば、モデルの値と並べて出す
  const j = p.actual?.times.findIndex((t) => sameTime(t, row.t!)) ?? -1;
  return (
    <div className="tooltip">
      <div className="tooltip-title">
        {formatTime(row.t)} {p.unit}
      </div>
      {p.visible.map((n) => (
        <div key={n} className="tooltip-row">
          <span className="swatch" style={{ background: p.colorOf(n) }} />
          <span className="tooltip-name">{n}</span>
          <span className="tooltip-value">{formatValue(p.run.series[n]?.[row.i!])}</span>
          {j >= 0 && p.actual!.series[n]?.[j] != null && (
            <>
              <span className="tooltip-actual-mark" style={{ borderColor: p.colorOf(n) }} />
              <span className="tooltip-name muted">実際のデータ</span>
              <span className="tooltip-value">{formatValue(p.actual!.series[n][j])}</span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
