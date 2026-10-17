import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from "recharts";
import type { ActualDataResult, ModelJSON, RunResult, ScenarioPatch, ScenarioRunResult } from "../../src/viewer/api.js";
import { sameTime, withActualPoints } from "./actualPoints.js";
import { renamedName } from "./editing.js";
import { normalize, normalizeLike, normalizeTogether } from "./normalize.js";
import {
  addableValues,
  BASELINE_NAME,
  canEditValue,
  cellPatchOf,
  compareRuns,
  copyNameOf,
  describeRun,
  nameKey,
  newScenarioPatchOf,
  resultRows,
  scenarioName,
  valueRows,
  type CompareRun,
  type CompareRuns,
  type MatrixCell,
} from "./scenarios.js";
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

/** 線の色の割り当てを、名前を変えたあとの名前にする */
const renamedKeys = (slots: Map<string, number>, renamed: [string, string][]) => new Map([...slots].map(([n, slot]) => [renamedName(n, renamed), slot]));

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
  /** いまの版で名前の変わった要素の [前の名前, 新しい名前]。グラフに出している要素を新しい名前で出し続ける */
  renamed?: [string, string][];
  /** 左の欄で直している施策の名前（凡例で目立たせる） */
  editingScenario?: string;
  /** 施策の編集欄を開く。name がなければ施策を足す */
  onEditScenario?(name?: string): void;
  /** 施策を直す（MCP の set_scenarios と同じ形）。失敗したらエラーの文を返す。あれば、施策の中身の表で値をその場で直せる */
  onSaveScenario?(patch: ScenarioPatch): Promise<string | undefined>;
  /** すべての施策で、その要素の値を変えないことにする（施策の中身の表の行を消す）。失敗したらエラーの文を返す */
  onRemoveScenarioValue?(element: string): Promise<string | undefined>;
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

export function Chart({ modelName, model, run, scenarios, actual, renamed, editingScenario, onEditScenario, onSaveScenario, onRemoveScenarioValue, onFocusScenario }: ChartProps) {
  const candidates = useMemo(() => candidatesOf(model, run), [model, run]);
  const names = useMemo(() => candidates.map((c) => c.name), [candidates]);
  // グラフに出す要素と線の色。名前を変えた版を受け取った描画では、下の effect が直すまで、前の名前のままになっている
  const [chosen, setVisible] = useState<string[]>(() => defaultVisible(model, names));
  const [chosenSlots, setSlots] = useState<Map<string, number>>(() => assignSlots(chosen, new Map()));
  // そのあいだも線が消えないように、描くときは新しい名前に読み替える
  const visible = useMemo(() => (renamed?.length ? chosen.map((n) => renamedName(n, renamed)) : chosen), [chosen, renamed]);
  const slots = useMemo(() => (renamed?.length ? renamedKeys(chosenSlots, renamed) : chosenSlots), [chosenSlots, renamed]);
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

  // 別のモデルを開いたら選び直す。同じモデルの更新では、名前の変わった要素は新しい名前にし、消えた要素だけ外す
  const [shownModel, setShownModel] = useState(modelName);
  useEffect(() => {
    if (shownModel !== modelName) {
      setShownModel(modelName);
      const v = defaultVisible(model, names);
      setVisible(v);
      setSlots(assignSlots(v, new Map()));
      return;
    }
    const pairs = renamed ?? [];
    const keep = chosen.map((n) => renamedName(n, pairs)).filter((n) => names.includes(n));
    if (keep.length !== chosen.length || keep.some((n, i) => n !== chosen[i])) {
      const v = keep.length ? keep : defaultVisible(model, names);
      setVisible(v);
      // 線の色は、名前を変えても同じにする
      setSlots((s) => assignSlots(v, renamedKeys(s, pairs)));
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
          // 表で足した行は、モデルごとに持つ（別のモデルを開いたら持ち越さない）
          key={modelName}
          compare={compare}
          model={model}
          times={run.times}
          visible={visible}
          at={view === "chart" ? hoverTime : undefined}
          unit={unit}
          editing={editingScenario}
          onEdit={onEditScenario}
          onSave={onSaveScenario}
          onRemoveValue={onRemoveScenarioValue}
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
 * 「中身を見る」で開くと、凡例がそのまま表の見出しになり、施策ごとに変えた値と結果（グラフで選んでいる要素の値）を並べる。
 * onSave があれば、表の施策の値をその場で直せる。onRemoveValue があれば、表の行（変える値）を消せる
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
  onSave,
  onRemoveValue,
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
  onSave?(patch: ScenarioPatch): Promise<string | undefined>;
  onRemoveValue?(element: string): Promise<string | undefined>;
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
          <ScenarioMatrix
            compare={compare}
            model={model}
            times={times}
            visible={visible}
            at={at}
            unit={unit}
            chip={chip}
            showAll={showAll}
            onShowAll={setShowAll}
            onSave={onSave}
            onRemoveValue={onRemoveValue}
          />
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
 * 行は、どれかの施策で変えた値と、結果（グラフで選んでいる要素の、ある時点の値）。
 * onSave があれば、変えた値の行の施策の列（「—」も）をその場で直せる。「何もしない場合」の列と結果の行は直せない。
 * また、見出しの右端の「＋」で施策を足し、施策の見出しの「複製」で同じ値の施策を作れる（名前を付けて Enter で保存する）。
 * 変えた値の行の下の「＋ 値を追加」で、どの施策でも変えていない値の行（全部「—」）を足せる。足した行は消すまで残す（モデルには保存しない）。
 * onRemoveValue があれば、行の名前にカーソルを乗せると出る × で、すべての施策でその値を変えないことにして行を消せる
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
  onSave,
  onRemoveValue,
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
  onSave?(patch: ScenarioPatch): Promise<string | undefined>;
  onRemoveValue?(element: string): Promise<string | undefined>;
}) {
  const runs = compare.runs;
  // 「＋ 値を追加」で足した行の要素（モデルの表記）。値を入れて施策で変えた行になっても、消すまで残す
  const [added, setAdded] = useState<string[]>([]);
  // 足した行の要素がモデルから消えたら（名前が変わったときも）、その行も外す
  useEffect(() => setAdded((a) => (a.every((n) => canEditValue(model, n)) ? a : a.filter((n) => canEditValue(model, n)))), [model]);
  const rows = useMemo(() => valueRows(model, runs, added), [model, runs, added]);
  const results = resultRows(runs, times, visible, at);
  const folding = rows.length > MATRIX_ROWS;
  const shown = folding && !showAll ? rows.slice(0, MATRIX_ROWS) : rows;
  // 名前を付けている途中の、足す施策の列。source は複製元の施策の名前（「＋」で足すときは undefined）
  const [adding, setAdding] = useState<{ source?: string; initial: string }>();
  const tableRef = useRef<HTMLTableElement>(null);
  // 仮の列を閉じたら、キーボードで続けられるようフォーカスを移す。保存したら表に、取りやめたら押した「＋」か「複製」に戻す。
  // 移すのは、フォーカスがまだ名前の欄（か、欄が消えて body）にあるときだけ。ほかを押して欄から外れたときは動かさない
  const refocus = useRef<{ cancel: boolean; source?: string } | undefined>(undefined);
  useEffect(() => {
    const target = refocus.current;
    if (adding || !target) return;
    refocus.current = undefined;
    const table = tableRef.current;
    const a = document.activeElement;
    if (!table || !(!a || a === document.body || table.contains(a))) return;
    const button = !target.cancel
      ? undefined
      : target.source === undefined
        ? table.querySelector<HTMLButtonElement>(".matrix-add button")
        : [...table.querySelectorAll<HTMLButtonElement>("button.matrix-copy")].find((b) => b.dataset.scenario === target.source);
    (button ?? table).focus({ preventScroll: true });
  }, [adding]);
  // 見出しの右端の「＋」（足す途中は名前の欄）の列。本文の行にも空のマスを置き、行の線を右端まで引く
  const extraCol = onSave ? 1 : 0;
  const colSpan = runs.length + 1 + extraCol;
  const sourceIndex = adding?.source === undefined ? -1 : runs.findIndex((r) => !r.baseline && r.name === adding.source);
  // 施策はグラフに重ねられる数（色の数）まで。名前のない施策や実行できなかった施策も 1 つに数える
  const savedNames = (model.scenarios ?? []).map(scenarioName);
  const full = savedNames.length >= MAX_SERIES;
  const fullNote = `グラフに重ねられる施策は ${MAX_SERIES} つまでです。凡例の施策を押して、左の欄で使わない施策を消すと足せます`;
  const startAdding = (source?: string) => setAdding({ source, initial: source === undefined ? "" : copyNameOf(source, savedNames) });
  // 名前を決めたら、施策を足して保存する。保存できたら仮の列を閉じ（足した施策の列に替わる）、表にフォーカスを移す
  const saveNew = async (name: string): Promise<string | undefined> => {
    // 名前を付けているあいだに、ほかのところ（AI など）で施策が足されて上限に達したら送らない
    if (full) return fullNote;
    let patch: ScenarioPatch;
    try {
      patch = newScenarioPatchOf(model, name, adding?.source);
    } catch (e) {
      return (e as Error).message;
    }
    const err = onSave ? await onSave(patch) : undefined;
    if (!err) {
      refocus.current = { cancel: false };
      setAdding(undefined);
    }
    return err;
  };
  const cancelAdding = () => {
    refocus.current = { cancel: true, source: adding?.source };
    setAdding(undefined);
  };
  // 「＋ 値を追加」で選んでいる途中か。足したら、その行の最初の施策のマスにフォーカスを移す（そのまま Enter で値を入れられる）
  const [picking, setPicking] = useState(false);
  // 選び欄で選んでいる要素（まだ足していない）。閉じた選び欄で ↓ ↑ や頭文字を押すと、その場で change が起きる（Windows）ので、
  // キーで選んでいる間は足さず、Enter で決める。マウスで一覧から選んだときは、そのまま足す。欄から外れたら取りやめる
  const [pick, setPick] = useState("");
  const keyed = useRef(false);
  const focusRow = useRef<string | undefined>(undefined);
  useEffect(() => {
    const element = focusRow.current;
    if (element === undefined) return;
    focusRow.current = undefined;
    const tr = [...(tableRef.current?.querySelectorAll<HTMLTableRowElement>("tr[data-element]") ?? [])].find((t) => t.dataset.element === element);
    tr?.querySelector<HTMLElement>("td.matrix-editable")?.focus();
  }, [added]);
  const addables = onSave ? addableValues(model, rows) : [];
  const closePicker = (focusTable: boolean) => {
    setPicking(false);
    setPick("");
    keyed.current = false;
    if (focusTable) tableRef.current?.focus({ preventScroll: true });
  };
  const addRow = (element: string) => {
    closePicker(false);
    if (!element) return;
    const next = [...added, element];
    // 足した行が畳んだところに入るなら、全部を開いて見せる
    if (valueRows(model, runs, next).findIndex((r) => nameKey(r.element) === nameKey(element)) >= MATRIX_ROWS) onShowAll(true);
    focusRow.current = element;
    setAdded(next);
  };
  // 行を消す。すべての施策でその値を変えないことにし（保存は App が 1 回にまとめる）、足した行なら外す
  const removeRow = (element: string) => {
    setAdded((a) => a.filter((n) => nameKey(n) !== nameKey(element)));
    // 押した × は行ごと消えるので、キーボードで続けられるよう表にフォーカスを移しておく
    tableRef.current?.focus({ preventScroll: true });
    void onRemoveValue?.(element);
  };
  // マスに入れた文字を、その施策の変更にして送る。書けない値ならエラーの文を返す（送らない）
  const saveValue = (r: CompareRun, element: string) => async (text: string) => {
    let patch: ScenarioPatch | undefined;
    try {
      patch = cellPatchOf(model, r.name, element, text);
    } catch (e) {
      return (e as Error).message;
    }
    return patch && onSave ? onSave(patch) : undefined;
  };
  return (
    <div className="scenario-matrix-scroll">
      <table className="scenario-matrix" aria-label="施策の中身" tabIndex={-1} ref={tableRef}>
        <thead>
          <tr>
            <th scope="col" className="matrix-corner">
              変えた値
            </th>
            {runs.map((r, k) => (
              <th key={k} scope="col" title={`${r.name}\n${describeRun(r)}`}>
                <div className="scenario-chip">
                  {chip(r, k)}
                  {onSave && !r.baseline && !adding && (
                    <button
                      className="matrix-copy"
                      data-scenario={r.name}
                      onClick={() => !full && startAdding(r.name)}
                      aria-disabled={full}
                      aria-label={`施策「${r.name}」を複製`}
                      title={full ? fullNote : "同じ値の施策を作ります"}
                    >
                      複製
                    </button>
                  )}
                </div>
              </th>
            ))}
            {adding ? (
              <NewScenarioHeader key={adding.source ?? ""} initial={adding.initial} copy={adding.source !== undefined} onSave={saveNew} onCancel={cancelAdding} />
            ) : (
              onSave && (
                <th scope="col" className="matrix-add">
                  <button onClick={() => !full && startAdding()} aria-disabled={full} aria-label="施策を足す" title={full ? fullNote : "施策を足します（名前を付けて Enter）"}>
                    ＋
                  </button>
                </th>
              )
            )}
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
            <tr key={row.element} data-element={row.element}>
              <th scope="row" title={row.element} className={onRemoveValue ? "matrix-row-head" : undefined}>
                <span className="matrix-element">{row.element}</span>
                {row.initial && <small className="matrix-sub">初期値</small>}
                {/* モデルにない要素の値は保存できない（サーバーが受け付けない）ので、消す × も出さない */}
                {onRemoveValue && canEditValue(model, row.element) && (
                  <button
                    className="matrix-remove-row"
                    onClick={() => removeRow(row.element)}
                    aria-label={`「${row.element}」の行を消す`}
                    title="すべての施策で、この値を変えないことにして行を消します（Ctrl+Z で戻せます）"
                  >
                    ×
                  </button>
                )}
              </th>
              {/* マスの key は施策の名前（施策の列が減っても、入力している途中の状態が隣の列に移らないように） */}
              {row.cells.map((c, k) =>
                k === 0 ? (
                  <td key={runs[k]!.name} className="matrix-base" title={c.value}>
                    {c.value ?? "—"}
                  </td>
                ) : onSave && canEditValue(model, row.element) ? (
                  <ScenarioValueCell key={runs[k]!.name} cell={c} color={runColor(runs[k]!, k)} label={`${runs[k]!.name}の「${row.element}」の値`} onSave={saveValue(runs[k]!, row.element)} />
                ) : c.changed ? (
                  <td key={runs[k]!.name} className="matrix-changed" style={{ "--run-color": runColor(runs[k]!, k) } as React.CSSProperties} title={c.value}>
                    {c.value}
                    {c.change && <small className="matrix-change">{c.change}</small>}
                  </td>
                ) : (
                  <td key={runs[k]!.name} className="matrix-same" title="この施策では変えていません">
                    —
                  </td>
                ),
              )}
              {adding ? <NewScenarioCell value={sourceIndex > 0 ? row.cells[sourceIndex]?.value : undefined} /> : extraCol > 0 && <td />}
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
          {onSave && (
            <tr>
              <td colSpan={colSpan} className="matrix-add-row">
                {picking ? (
                  <select
                    className="matrix-select"
                    value={pick}
                    onChange={(e) => {
                      setPick(e.target.value);
                      if (!keyed.current) addRow(e.target.value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        if (pick) addRow(pick);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        closePicker(true);
                      } else keyed.current = true;
                    }}
                    onKeyUp={() => (keyed.current = false)}
                    onBlur={() => closePicker(false)}
                    autoFocus
                    aria-label="表に足す値"
                    title="↓ ↑ で選んで Enter で足す、Esc でやめる"
                  >
                    <option value="">値を選ぶ…</option>
                    {addables.map((e) => (
                      <option key={e.name} value={e.name}>
                        {e.name}
                        {e.type === "STOCK" ? "（初期値）" : ""}
                      </option>
                    ))}
                  </select>
                ) : (
                  <button
                    className="link"
                    onClick={() => addables.length > 0 && setPicking(true)}
                    aria-disabled={addables.length === 0}
                    title={addables.length ? "どの施策でも変えていない値を、比べる行に足します" : "施策で変えられる値は、すべて表にあります"}
                  >
                    ＋ 値を追加
                  </button>
                )}
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
              {/* 足す施策の結果は、保存して実行するまでわからない */}
              {adding ? <td className="matrix-same" /> : extraCol > 0 && <td />}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 施策の中身の表で、足す施策の列の見出し。名前を入れて Enter（か欄から外れる）で保存し、Esc で取りやめる。
 * 名前が空のまま欄から外れたときも取りやめる。名前が使えない・保存に失敗したときは、その場で知らせて列を残す（保存しない）
 */
function NewScenarioHeader({ initial, copy, onSave, onCancel }: { initial: string; copy: boolean; onSave(name: string): Promise<string | undefined>; onCancel(): void }) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  // 保存しているあいだと閉じたあとは、欄から外れたこと（blur）で、もう一度送らない
  const busy = useRef(false);
  const closed = useRef(false);
  const commit = async () => {
    if (busy.current || closed.current) return;
    busy.current = true;
    setSaving(true);
    const err = await onSave(name);
    busy.current = false;
    // 保存できたら、この列は消える（足した施策の列に替わる）
    if (err) {
      setSaving(false);
      setError(err);
    } else closed.current = true;
  };
  const cancel = () => {
    if (busy.current) return;
    closed.current = true;
    onCancel();
  };
  return (
    <th scope="col" className="matrix-new">
      <input
        className="matrix-input matrix-name"
        value={name}
        size={Math.min(Math.max(name.length + 2, 12), 28)}
        placeholder={copy ? "複製した施策の名前" : "新しい施策の名前"}
        onChange={(e) => {
          setName(e.target.value);
          setError(undefined);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        onBlur={() => {
          // 名前が空なら取りやめる。知らせを出しているあいだは、外れても送り直さない（直して Enter か、Esc でやめる）
          if (!name.trim()) cancel();
          else if (!error) void commit();
        }}
        onFocus={(e) => e.currentTarget.select()}
        readOnly={saving}
        autoFocus
        aria-label={copy ? "複製した施策の名前" : "足す施策の名前"}
        aria-invalid={!!error}
        title="Enter で決める、Esc でやめる"
      />
      {error && (
        <span className="matrix-error" role="alert">
          {error}
        </span>
      )}
    </th>
  );
}

/** 足す施策の列の、変えた値のマス。複製なら複製元の値、「＋」で足すなら「—」。名前を決めて保存してから直せる */
function NewScenarioCell({ value }: { value?: string }) {
  return value === undefined ? (
    <td className="matrix-same" title="この施策では変えていません">
      —
    </td>
  ) : (
    <td className="matrix-new-value" title={value}>
      {value}
    </td>
  );
}

/**
 * 施策の中身の表の、施策の値のマス。押す（Enter）と入力欄になり、Enter か欄から外れると保存し、Esc で取りやめる。
 * 空にして確定するか × を押すと、その施策ではその値を変えない（「—」に戻る）。
 * × はカーソルを乗せたとき（フォーカスしたとき）だけ出す。普段の見た目は、直せないマスと同じ
 */
function ScenarioValueCell({ cell, color, label, onSave }: { cell: MatrixCell; color: string; label: string; onSave(text: string): Promise<string | undefined> }) {
  // 入れている途中の文字。undefined なら入力欄を出していない
  const [draft, setDraft] = useState<string>();
  // 書き始めたときの値。確定するときに、そのあいだに AI などがこの値を変えていないか比べる
  const [base, setBase] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const cellRef = useRef<HTMLTableCellElement>(null);
  // 保存しているあいだと閉じたあとは、欄から外れたこと（blur）で、もう一度送らない
  const busy = useRef(false);
  const closed = useRef(true);
  // 一度知らせたあと（ほかで変わっていた・保存に失敗した）は、次の確定では比べずに送る
  const checked = useRef(false);
  // 入力欄を閉じたあと（× を押したあとも）、キーボードで続けられるようマスにフォーカスを戻す。マスが描き直されてから戻す。
  // 戻すのは、フォーカスがまだこのマスの中にある（入力欄が消えて body に落ちた）ときだけ。ほかへ移していたら動かさない
  const refocus = useRef(false);
  const table = useRef<HTMLTableElement | null>(null);
  const focusLost = () => {
    const a = document.activeElement;
    return !a || a === document.body || !!cellRef.current?.contains(a);
  };
  useEffect(() => {
    if (draft !== undefined || !refocus.current || busy.current) return;
    refocus.current = false;
    if (focusLost()) cellRef.current?.focus();
  });
  // 値を消して行ごとなくなったときは、表にフォーカスを移す
  useEffect(
    () => () => {
      const t = table.current;
      if (refocus.current && t?.isConnected && focusLost()) t.focus();
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const start = () => {
    closed.current = false;
    checked.current = false;
    setDraft(cell.value ?? "");
    setBase(cell.value);
    setError(undefined);
  };
  const close = (focusCell: boolean) => {
    closed.current = true;
    refocus.current = focusCell;
    setDraft(undefined);
    setError(undefined);
  };
  const save = async (text: string): Promise<string | undefined> => {
    busy.current = true;
    table.current = cellRef.current?.closest("table") ?? null;
    setSaving(true);
    const err = await onSave(text);
    busy.current = false;
    setSaving(false);
    return err;
  };
  const commit = async (focusCell: boolean) => {
    if (closed.current || busy.current || draft === undefined) return;
    // 何も変えていなければ、比べずにそのまま閉じる
    if (draft.trim() === (base ?? "").trim()) {
      close(focusCell);
      return;
    }
    if (!checked.current && cell.value !== base) {
      // 書いているあいだに、この値がほかで変わった。黙って上書きせず、一度知らせる
      checked.current = true;
      setError("書いているあいだに、ほかのところ（AI など）でこの値が変わりました。もう一度確定すると、この欄の値で上書きします。");
      return;
    }
    // 行ごとなくなったとき（空にした）にも表へフォーカスを移せるよう、送る前から覚えておく
    refocus.current = focusCell;
    const err = await save(draft);
    if (err) {
      refocus.current = false;
      checked.current = true;
      setError(err);
    } else close(focusCell);
  };
  // × で、この施策ではこの値を変えないことにする
  const clear = async () => {
    if (busy.current) return;
    refocus.current = true;
    const err = await save("");
    setError(err);
  };

  const style = cell.changed ? ({ "--run-color": color } as React.CSSProperties) : undefined;
  const errorNote = error && (
    <span className="matrix-error" role="alert">
      {error}
    </span>
  );
  if (draft !== undefined) {
    return (
      <td className={`matrix-editing ${cell.changed ? "matrix-changed" : ""}`} style={style} ref={cellRef}>
        <input
          className="matrix-input code"
          value={draft}
          size={Math.min(Math.max(draft.length + 2, 8), 28)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") {
              e.preventDefault();
              void commit(true);
            } else if (e.key === "Escape") {
              e.preventDefault();
              close(true);
            }
          }}
          onBlur={() => void commit(false)}
          onFocus={(e) => e.currentTarget.select()}
          readOnly={saving}
          autoFocus
          aria-label={label}
          aria-invalid={!!error}
          title="Enter で保存、Esc でやめる。空にすると、この施策ではこの値を変えません"
        />
        {errorNote}
      </td>
    );
  }
  return (
    <td
      ref={cellRef}
      className={`matrix-editable ${cell.changed ? "matrix-changed" : "matrix-same"} ${error ? "matrix-editing" : ""}`}
      style={style}
      tabIndex={0}
      title={cell.changed ? `${cell.value}\n押すと直せます` : "この施策では変えていません。押すと値を変えられます"}
      aria-label={`${label}：${cell.changed ? cell.value : "変えていません"}`}
      onClick={start}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && e.key === "Enter") {
          e.preventDefault();
          start();
        } else if (e.key === "Delete" || e.key === "Backspace") {
          // 変えた値なら、その値を消す（× と同じ）。図で選んでいる要素を消さないよう、ここで止める
          e.preventDefault();
          e.stopPropagation();
          if (cell.changed && !e.repeat) void clear();
        }
      }}
    >
      {cell.changed ? (
        <>
          <button
            className="matrix-clear"
            onClick={(e) => {
              e.stopPropagation();
              void clear();
            }}
            disabled={saving}
            aria-label={`${label}を変えないことにする`}
            title="この施策ではこの値を変えない（「—」に戻す）"
          >
            ×
          </button>
          {cell.value}
          {cell.change && <small className="matrix-change">{cell.change}</small>}
        </>
      ) : (
        "—"
      )}
      {errorNote}
    </td>
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
