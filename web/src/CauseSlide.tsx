import { ReactFlowProvider } from "@xyflow/react";
import { useMemo } from "react";
import type { ModelResponse, Slide } from "../../src/viewer/api.js";
import { toGraph } from "../../src/core/diagram.js";
import { LOOP_KIND_LABEL, type LoopView } from "../../src/core/loops.js";
import { Diagram } from "./Diagram.js";

// 発表モードの「原因」のスライドの中身。左にストックとフローの図、右にループをひと回りする要素の名前と説明。
// 図は作業画面と同じ描き方で、ループの要素と線だけを目立たせてほかを薄くし、図の左上にループの名前と R / B を出す
// （Diagram の loop。MCP の view_diagram の loop と同じ表示）。
// R / B はスライドに保存したもの。モデルのリンクの極性と合わないときや、ループになっていないときは、
// set_slides の結果と、作業画面の「問題」の欄で知らせる（core の checkSlides）。ループになっていなくても、つながるところだけは目立たせる。
// 発表モードでは動かさないので、図は押したり動かしたりできないようにする。

type CauseSlideData = Extract<Slide, { kind: "cause" }>;

const POLARITY_NOTE = {
  R: "ひと回りするたびに、変化がさらに大きくなります",
  B: "ひと回りするたびに、変化を打ち消して元に戻そうとします",
} as const;

/** これより要素の多いループは、名前を縦に並べずに横に続ける（スライドに収まるように） */
const LONG_LOOP = 4;

const noSelect = () => undefined;
const noMove = async () => undefined;
const noChanged = new Set<string>();

export function CauseSlide({ slide, data }: { slide: CauseSlideData; data: ModelResponse }) {
  const graph = useMemo(() => toGraph(data.model), [data.model]);
  const names = slide.loop.elements;
  const polarity = slide.loop.polarity;
  const known = new Set(data.model.elements.filter((e) => e.name).map((e) => e.name!.toLowerCase()));
  // スライドの見出しがループの説明になっているので、図の札には種類の名前（強めるループなど）を出す
  const loop = useMemo<LoopView>(() => ({ name: LOOP_KIND_LABEL[polarity], kind: polarity, elements: names }), [names, polarity]);
  return (
    <div className="slide-body cause-body">
      <div className="cause-diagram">
        <ReactFlowProvider>
          <Diagram graph={graph} modelName={data.name} changed={noChanged} values={{}} onSelect={noSelect} onMove={noMove} embed loop={loop} />
        </ReactFlowProvider>
      </div>
      <aside className={`loop-card loop-${polarity.toLowerCase()}`}>
        <ol className={names.length > LONG_LOOP ? "loop-path is-long" : "loop-path"}>
          {(names.length ? [...names, names[0]!] : []).map((n, i) => (
            <li key={i} className={known.has(n.toLowerCase()) ? "" : "missing"} title={known.has(n.toLowerCase()) ? undefined : "モデルにない名前です"}>
              {n}
            </li>
          ))}
        </ol>
        <p className="loop-note">{POLARITY_NOTE[polarity]}</p>
      </aside>
    </div>
  );
}
