import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";
import type { ChangeEvent, ModelResponse, Slide, SlideDeck } from "../../src/viewer/api.js";
import { fetchModel } from "./api.js";
import { withActualPoints, type ChartRow } from "./actualPoints.js";
import { CauseSlide } from "./CauseSlide.js";
import { TIME_UNIT_LABEL, formatTime, formatValue } from "./Chart.js";
import { KIND_LABEL, changeFrom, isPrintFrom, nextSlide, scenarioChanges, slideIndexFrom, valueAt } from "./presentation.js";
import { BASELINE_NAME } from "./scenarios.js";

// 発表モード（?view=present#<モデル名>）。会議で、SD を知らない人にスライドを順に見せる。
// 筋書き（<モデル名>.slides.json）は AI が MCP の set_slides で作る。この画面では作らない。
// 16:9 の枠に大きな文字で 1 枚ずつ出し、← → で進む。式や編集の欄、問題の一覧は出さない。グラフの縦軸は実際の値。
// AI が筋書きやモデルを直すと、変更の知らせ（Server-Sent Events）で読み直して、その場で変わる。
// 何枚目かはアドレスの slide= に入れる（読み直しても同じスライドから。MCP の view_slides もこれで切り替える）。
// print=1 を付けると、すべてのスライドを縦に並べ、1 枚を 1 ページにして印刷できる形にする（MCP の export_slides が PDF にする）。

/** 文字やグラフの大きさの基準にする枠の幅。実際の枠の幅との比で、グラフの文字も大きくする */
const BASE_WIDTH = 1280;

const nameFromHash = () => decodeURIComponent(location.hash.replace(/^#/, ""));
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function Present() {
  const [name, setName] = useState(nameFromHash());
  const [data, setData] = useState<ModelResponse>();
  const [error, setError] = useState<string>();
  const deck = data?.slides?.deck;
  const count = deck?.slides.length ?? 0;
  const [index, setIndex] = useState(() => slideIndexFrom(location.search, Number.MAX_SAFE_INTEGER));
  const shown = Math.min(index, Math.max(count - 1, 0));
  const [print] = useState(() => isPrintFrom(location.search));
  const nameRef = useRef(name);
  nameRef.current = name;
  // 読み込みの番号。古い読み込みの結果が、あとから来ても使わない
  const loadSeq = useRef(0);

  const load = useCallback(async (model: string) => {
    if (!model) return;
    const seq = ++loadSeq.current;
    try {
      const next = await fetchModel(model);
      if (seq !== loadSeq.current || !sameName(nameRef.current, model)) return;
      setData(next);
      setError(undefined);
    } catch (e) {
      if (seq === loadSeq.current) setError(`モデル "${model}" を読めません: ${(e as Error).message}`);
    }
  }, []);

  // 変更の知らせ。開いているモデル（筋書きと実際のデータを含む）が変わったら読み直す
  useEffect(() => {
    const es = new EventSource("/api/events");
    let lost = false;
    es.onopen = () => {
      if (lost) void load(nameRef.current);
      lost = false;
    };
    es.onerror = () => {
      lost = true;
    };
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data as string) as ChangeEvent;
      if (!sameName(ev.name, nameRef.current)) return;
      if (ev.type === "changed") void load(nameRef.current);
      else setError(`モデル "${ev.name}" のファイルが消えました。`);
    };
    const onHash = () => setName(nameFromHash());
    // view_slides は、開き直さずにアドレスの slide= を変えてスライドを切り替える
    const onPop = () => setIndex(slideIndexFrom(location.search, Number.MAX_SAFE_INTEGER));
    window.addEventListener("hashchange", onHash);
    window.addEventListener("popstate", onPop);
    return () => {
      es.close();
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("popstate", onPop);
    };
  }, [load]);

  useEffect(() => {
    setData(undefined);
    void load(name);
  }, [name, load]);

  // 何枚目かをアドレスに残す
  useEffect(() => {
    if (!count) return;
    const url = new URL(location.href);
    if (url.searchParams.get("slide") === String(shown + 1)) return;
    url.searchParams.set("slide", String(shown + 1));
    history.replaceState(null, "", url);
  }, [shown, count]);

  const go = useCallback((i: number) => setIndex(i), []);
  useEffect(() => {
    // 印刷の形では、キーでスライドを切り替えない
    if (print) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.toLowerCase() === "f") {
        e.preventDefault();
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen().catch(() => undefined);
        return;
      }
      const next = nextSlide(e.key, shown, count);
      if (next === undefined) return;
      e.preventDefault();
      go(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, count, go, print]);

  // 枠の幅。グラフの文字の大きさを、枠に合わせて変えるため（印刷の形では、並べた枠の幅はどれも同じ）
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    if (!stage) return;
    const update = () => setScale(stage.clientWidth / BASE_WIDTH || 1);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [stage]);

  useEffect(() => {
    const title = deck?.title || data?.model.name || name;
    document.title = title ? `${title} - 発表` : "発表";
  }, [deck, data, name]);

  let content: ReactNode;
  if (error) content = <StageMessage text={error} />;
  else if (!name) content = <StageMessage text="アドレスの # のあとに、モデルの名前を付けて開いてください（例：?view=present#population）。" />;
  else if (!data) content = <StageMessage text="読み込んでいます…" />;
  else if (!data.slides) {
    content = <StageMessage text={`このモデルには会議資料の筋書きがありません。AI に「会議資料を作って」と頼むと、筋書き（${name}.slides.json）ができて、ここに出ます。`} />;
  } else if (!deck) content = <StageMessage text={data.slides.issues[0]?.message ?? "筋書きを読めません。"} />;
  else if (!count) content = <StageMessage text="筋書きにスライドがありません。" />;
  else if (print) {
    return (
      <div className="present-print">
        {deck.slides.map((_, i) => (
          <div key={i} className="stage" ref={i === 0 ? setStage : undefined} style={{ "--u": scale } as CSSProperties}>
            <SlideView deck={deck} index={i} data={data} scale={scale} />
          </div>
        ))}
      </div>
    );
  } else content = <SlideView key={shown} deck={deck} index={shown} data={data} scale={scale} />;

  return (
    <div className="present">
      <div className="stage" ref={setStage} style={{ "--u": scale } as CSSProperties}>
        {content}
      </div>
      {count > 0 && (
        <nav className="present-nav" aria-label="スライドの移動">
          <button onClick={() => go(Math.max(shown - 1, 0))} disabled={shown === 0} aria-label="前のスライド">
            ‹
          </button>
          <span>
            {shown + 1} / {count}
          </span>
          <button onClick={() => go(Math.min(shown + 1, count - 1))} disabled={shown === count - 1} aria-label="次のスライド">
            ›
          </button>
          <span className="present-hint">← → で進む・F で全画面</span>
        </nav>
      )}
    </div>
  );
}

function StageMessage({ text }: { text: string }) {
  return (
    <div className="slide slide-message-only">
      <p className="stage-message">{text}</p>
    </div>
  );
}

/** 1 枚のスライド。見出しと「言いたいこと」の下に、種類ごとの中身を出す */
function SlideView({ deck, index, data, scale }: { deck: SlideDeck; index: number; data: ModelResponse; scale: number }) {
  const slide = deck.slides[index]!;
  return (
    <section className={`slide slide-${slide.kind}`} data-index={index + 1} data-ready="1">
      <header className="slide-head">
        <span className="slide-kind">{KIND_LABEL[slide.kind]}</span>
        <h1 className="slide-title">{slide.title}</h1>
        {slide.kind !== "conclusion" && <p className="slide-message">{slide.message}</p>}
      </header>
      {slide.kind === "problem" ? (
        <ProblemBody slide={slide} data={data} scale={scale} />
      ) : slide.kind === "cause" ? (
        <CauseSlide slide={slide} data={data} />
      ) : slide.kind === "solution" ? (
        <SolutionBody slide={slide} data={data} />
      ) : slide.kind === "compare" ? (
        <CompareBody slide={slide} data={data} scale={scale} />
      ) : (
        <div className="slide-body conclusion-body">
          <p className="conclusion-message">{slide.message}</p>
        </div>
      )}
      <footer className="slide-foot">
        <span>{deck.title ?? data.model.name ?? data.name}</span>
        <span>
          {index + 1} / {deck.slides.length}
        </span>
      </footer>
    </section>
  );
}

/** モデルの要素名の表記（大文字と小文字は区別しない）。なければ undefined */
function elementName(data: ModelResponse, name: string): string | undefined {
  return data.model.elements.find((e) => e.type !== "LINK" && e.name && sameName(e.name, name))?.name;
}

function unitOf(data: ModelResponse): string {
  const u = data.run?.time_units ?? data.model.simulation?.time_units ?? "";
  return TIME_UNIT_LABEL[u.toLowerCase()] ?? u;
}

/** 問題：注目する要素ごとに、モデルの線と実際のデータの点。「今」に縦の線 */
function ProblemBody({ slide, data, scale }: { slide: Extract<Slide, { kind: "problem" }>; data: ModelResponse; scale: number }) {
  const run = data.run;
  if (!run) return <BodyNote text="モデルにエラーがあるため、グラフを出せません。" />;
  const withData = (n: string) => (slide.data ? slide.data.some((d) => sameName(d, n)) : true);
  return (
    <div className={`slide-body chart-grid n${Math.min(slide.elements.length, 4)}`}>
      {slide.elements.map((raw) => {
        const n = elementName(data, raw);
        const values = n ? data.actual?.series[n] : undefined;
        const points = n && values && withData(n) ? data.actual!.times.flatMap((t, i) => (values[i] == null ? [] : [{ t, v: values[i]! }])) : [];
        return (
          <figure key={raw} className="slide-chart">
            <figcaption>
              {raw}
              {points.length > 0 && (
                <span className="slide-legend">
                  <span className="legend-line" />
                  モデル
                  <span className="legend-dot" />
                  実際のデータ
                </span>
              )}
            </figcaption>
            {n && run.series[n] ? (
              <SlideChart
                times={run.times}
                lines={[{ key: "m", name: n, values: run.series[n]!, color: "var(--series-1)" }]}
                points={points}
                mark={slide.now === undefined ? undefined : { t: slide.now, label: "今" }}
                unit={unitOf(data)}
                scale={scale}
              />
            ) : (
              <BodyNote text={`「${raw}」がモデルにありません。`} />
            )}
          </figure>
        );
      })}
    </div>
  );
}

/** 解決案：シナリオの名前と説明、変える値 */
function SolutionBody({ slide, data }: { slide: Extract<Slide, { kind: "solution" }>; data: ModelResponse }) {
  const scenario = data.scenarios?.find((s) => sameName(s.name, slide.scenario));
  const changes = scenarioChanges(data.model, scenario);
  if (!scenario) return <BodyNote text={`シナリオ「${slide.scenario}」がモデルにありません。`} />;
  return (
    <div className="slide-body solution-body">
      <div className="solution-card">
        <p className="solution-name">{scenario.name}</p>
        {scenario.description && <p className="solution-description">{scenario.description}</p>}
      </div>
      {changes.length > 0 && (
        <table className="solution-changes">
          <thead>
            <tr>
              <th>変えるもの</th>
              <th>いま</th>
              <th>このシナリオ</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((c) => (
              <tr key={c.name}>
                <td>{c.name}</td>
                <td>{showValue(c.before)}</td>
                <td className="after">{showValue(c.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** 変える値。式は見せない（発表モードには式を出さない）ので、数でなければ「計算で決まる」とだけ出す */
function showValue(v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? formatValue(n) : "計算で決まる";
}

/** 比較：要素ごとに「元のモデル」とシナリオを重ね、注目する時点の値を並べる */
function CompareBody({ slide, data, scale }: { slide: Extract<Slide, { kind: "compare" }>; data: ModelResponse; scale: number }) {
  const run = data.run;
  const runs = useMemo(() => {
    if (!run) return [];
    const out = [{ name: BASELINE_NAME, series: run.series as Record<string, (number | null)[]> | undefined, baseline: true, note: "" }];
    for (const name of slide.scenarios) {
      const s = data.scenarios?.find((x) => sameName(x.name, name));
      const note = !s ? "モデルにありません" : s.error ? "実行できませんでした" : s.skipped ? "ビューアで実行していません" : "";
      out.push({ name: s?.name ?? name, series: s?.series, baseline: false, note });
    }
    return out;
  }, [run, data.scenarios, slide.scenarios]);
  if (!run) return <BodyNote text="モデルにエラーがあるため、グラフを出せません。" />;
  const at = slide.at ?? run.times.at(-1)!;
  const unit = unitOf(data);
  const colorOf = (k: number) => (k === 0 ? "var(--text-muted)" : `var(--series-${((k - 1) % 8) + 1})`);
  return (
    <div className={`slide-body chart-grid n${Math.min(slide.elements.length, 4)}`}>
      {slide.elements.map((raw) => {
        const n = elementName(data, raw);
        if (!n || !run.series[n]) {
          return (
            <figure key={raw} className="slide-chart">
              <figcaption>{raw}</figcaption>
              <BodyNote text={`「${raw}」がモデルにありません。`} />
            </figure>
          );
        }
        const base = valueAt(run.times, run.series[n], at);
        return (
          <figure key={raw} className="slide-chart compare">
            <figcaption>{n}</figcaption>
            <SlideChart
              times={run.times}
              lines={runs.flatMap((r, k) => (r.series?.[n] ? [{ key: `r${k}`, name: r.name, values: r.series[n]!, color: colorOf(k), dashed: r.baseline }] : []))}
              mark={{ t: at, label: `${formatTime(at)} ${unit}` }}
              unit={unit}
              scale={scale}
            />
            <ul className="compare-values" aria-label={`${formatTime(at)} ${unit}の値`}>
              {runs.map((r, k) => {
                const v = r.series ? valueAt(run.times, r.series[n], at) : null;
                return (
                  <li key={k} className={r.baseline ? "baseline" : ""}>
                    <svg className="line-swatch" width="22" height="10" aria-hidden="true">
                      <line x1="1" y1="5" x2="21" y2="5" stroke={colorOf(k)} strokeWidth={3} strokeDasharray={r.baseline ? "4 3" : undefined} />
                    </svg>
                    <span className="compare-name">{r.name}</span>
                    {r.note ? (
                      <span className="compare-note">{r.note}</span>
                    ) : (
                      <>
                        <span className="compare-value">{formatValue(v)}</span>
                        {!r.baseline && <span className="compare-change">{changeFrom(base, v)}</span>}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </figure>
        );
      })}
    </div>
  );
}

function BodyNote({ text }: { text: string }) {
  return <p className="slide-note">{text}</p>;
}

interface SlideLine {
  key: string;
  name: string;
  values: (number | null)[];
  color: string;
  dashed?: boolean;
}

/** スライドのグラフ。縦軸は実際の値。points は実際のデータ、mark は縦の線（「今」や注目する時点） */
function SlideChart({
  times,
  lines,
  points = [],
  mark,
  unit,
  scale,
}: {
  times: number[];
  lines: SlideLine[];
  points?: { t: number; v: number }[];
  mark?: { t: number; label: string };
  unit: string;
  scale: number;
}) {
  const rows = useMemo(() => {
    const base: ChartRow[] = times.map((t, i) => {
      const row: ChartRow = { t, i };
      for (const l of lines) row[l.key] = l.values[i] ?? null;
      return row;
    });
    return withActualPoints(base, points.length ? new Map([["a", points]]) : new Map(), lines.map((l) => l.key));
  }, [times, lines, points]);
  const font = Math.round(15 * scale);
  const tick = { fill: "var(--text-secondary)", fontSize: font };
  return (
    <div className="slide-chart-area">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: font * 1.6, right: font * 2, bottom: 4, left: 4 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            domain={["dataMin", "dataMax"]}
            tick={tick}
            tickFormatter={(v: number) => formatTime(v)}
            stroke="var(--axis)"
            height={font * 2.6}
            label={{ value: `時間（${unit}）`, position: "insideBottomRight", offset: 0, fill: "var(--text-secondary)", fontSize: font }}
          />
          <YAxis tick={tick} stroke="var(--axis)" tickFormatter={(v: number) => formatValue(v)} width={font * 5} />
          {mark && (
            <ReferenceLine
              x={mark.t}
              stroke="var(--text-secondary)"
              strokeDasharray="6 4"
              label={{ value: mark.label, position: "top", fill: "var(--text-primary)", fontSize: font, fontWeight: 600 }}
            />
          )}
          {lines.map((l) => (
            <Line
              key={l.key}
              type="linear"
              dataKey={l.key}
              name={l.name}
              stroke={l.color}
              strokeWidth={Math.max(2, 3.5 * scale)}
              strokeDasharray={l.dashed ? "8 6" : undefined}
              dot={false}
              activeDot={false}
              isAnimationActive={false}
              connectNulls={false}
            />
          ))}
          {points.length > 0 && (
            <Line
              type="linear"
              dataKey="a"
              stroke="none"
              dot={{ r: Math.max(3.5, 6 * scale), fill: "var(--surface-1)", stroke: "var(--text-primary)", strokeWidth: Math.max(2, 2.5 * scale) }}
              activeDot={false}
              legendType="none"
              isAnimationActive={false}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
