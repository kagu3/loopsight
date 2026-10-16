import { ReactFlowProvider } from "@xyflow/react";
import { useMemo } from "react";
import type { ModelResponse, Slide } from "../../src/viewer/api.js";
import { toGraph } from "../../src/core/diagram.js";
import { Diagram } from "./Diagram.js";

// 発表モードの「原因」のスライドの中身。左にストックとフローの図、右にループを作る要素の名前と、強めるループか釣り合わせるループか。
// 図は作業画面と同じ描き方で、ループの要素に枠を付けるだけにしている（線までは目立たせない）。
// 発表モードでは動かさないので、図は押したり動かしたりできないようにする。

type CauseSlideData = Extract<Slide, { kind: "cause" }>;

const POLARITY_LABEL = { R: "強めるループ", B: "釣り合わせるループ" } as const;
const POLARITY_NOTE = {
  R: "ひと回りするたびに、変化がさらに大きくなります",
  B: "ひと回りするたびに、変化を打ち消して元に戻そうとします",
} as const;

const noSelect = () => undefined;
const noMove = async () => undefined;

export function CauseSlide({ slide, data }: { slide: CauseSlideData; data: ModelResponse }) {
  const graph = useMemo(() => toGraph(data.model), [data.model]);
  const names = slide.loop.elements;
  const known = new Set(data.model.elements.filter((e) => e.name).map((e) => e.name!.toLowerCase()));
  // ループの要素に枠を付ける（図の「変わった要素」の枠を使う。発表モードでは消えないようにしてある）
  const loop = useMemo(() => new Set(names.map((n) => n.toLowerCase())), [names]);
  return (
    <div className="slide-body cause-body">
      <div className="cause-diagram">
        <ReactFlowProvider>
          <Diagram graph={graph} modelName={data.name} changed={loop} values={{}} onSelect={noSelect} onMove={noMove} embed />
        </ReactFlowProvider>
      </div>
      <aside className={`loop-card loop-${slide.loop.polarity}`}>
        <div className="loop-badge">
          <span className="loop-letter">{slide.loop.polarity}</span>
          <span>{POLARITY_LABEL[slide.loop.polarity]}</span>
        </div>
        <ol className="loop-path">
          {(names.length ? [...names, names[0]!] : []).map((n, i) => (
            <li key={i} className={known.has(n.toLowerCase()) ? "" : "missing"} title={known.has(n.toLowerCase()) ? undefined : "モデルにない名前です"}>
              {n}
            </li>
          ))}
        </ol>
        <p className="loop-note">{POLARITY_NOTE[slide.loop.polarity]}</p>
      </aside>
    </div>
  );
}
