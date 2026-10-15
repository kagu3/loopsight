import { describe, expect, test } from "vitest";
import { checkDiagram, emptyModel, upsertElements, type ElementPatch, type ModelJSON } from "../src/core/index.js";

/** ストック S（中心 350, 120）と、左の雲から S に入る横向きのフロー「流入」（弁の中心 225, 120）に、要素を足したモデル */
function model(extra: ElementPatch[]): ModelJSON {
  const m = emptyModel("check");
  upsertElements(m, [
    { type: "STOCK", name: "S", behavior: { initial_value: 0 }, display: { coordinates: [300, 100] } },
    { type: "FLOW", name: "流入", from: null, to: "S", behavior: { value: 1 }, display: { from_coordinates: [100, 120] } },
    ...extra,
  ]);
  return m;
}

/** 中心が (cx, cy) の変数（120×50） */
const variable = (name: string, cx: number, cy: number): ElementPatch => ({
  type: "VARIABLE",
  name,
  behavior: { value: 1 },
  display: { coordinates: [cx - 60, cy - 25] },
});
const link = (from: string, to: string): ElementPatch => ({ type: "LINK", from, to });

describe("線がフローの名前の上を通るところ", () => {
  test("弁の真下から入るリンクは、弁の下の名前を横切るので知らせる", () => {
    const c = checkDiagram(model([variable("V", 225, 275), link("V", "流入")]));
    expect(c.lines_through_labels).toEqual(["リンク V → 流入 が フロー 流入 の名前の上を通る"]);
  });

  test("名前のない側（上）から入るリンクは知らせない", () => {
    const c = checkDiagram(model([variable("V", 225, -40), link("V", "流入")]));
    expect(c.lines_through_labels).toEqual([]);
  });
});

describe("1 か所に集まる線", () => {
  test("1 つの弁に 5 本以上のリンクが入ると知らせる", () => {
    const names = ["A", "B", "C", "D", "E"];
    const around = names.map((n, i) => {
      const t = (i / names.length) * 2 * Math.PI;
      return variable(n, 225 + Math.cos(t) * 250, 120 + Math.sin(t) * 250);
    });
    const c = checkDiagram(model([...around, ...names.map((n) => link(n, "流入"))]));
    expect(c.converging_lines.some((s) => s.startsWith("フロー 流入 の弁 に 5 本のリンクが 1 点に集まる"))).toBe(true);
  });

  test("4 本までは知らせない", () => {
    const names = ["A", "B", "C", "D"];
    const around = names.map((n, i) => {
      const t = (i / names.length) * 2 * Math.PI + Math.PI / 4; // フローの線（左右）と向きがそろわないよう斜めに置く
      return variable(n, 225 + Math.cos(t) * 250, 120 + Math.sin(t) * 250);
    });
    const c = checkDiagram(model([...around, ...names.map((n) => link(n, "流入"))]));
    expect(c.converging_lines).toEqual([]);
  });

  test("1 つの要素にほぼ同じ向きでつながる線を知らせる", () => {
    // S の真下に 2 つ並べると、2 本のリンクは同じ向きから S に入る
    const c = checkDiagram(model([variable("近い", 350, 260), variable("遠い", 350, 420), link("近い", "S"), link("遠い", "S")]));
    expect(c.converging_lines).toHaveLength(1);
    expect(c.converging_lines[0]).toMatch(/^S に 2 本の線がほぼ同じ向き（0° の幅）でつながる：/);
    expect(c.converging_lines[0]).toContain("リンク 近い → S");
    expect(c.converging_lines[0]).toContain("リンク 遠い → S");
  });

  test("違う向きでつながる線は知らせない", () => {
    const c = checkDiagram(model([variable("下", 350, 260), variable("右", 550, 120), link("下", "S"), link("右", "S")]));
    expect(c.converging_lines).toEqual([]);
  });

  test("±180° をまたいでそろう線も 1 つのまとまりとして知らせる", () => {
    // X の左に置いた 2 つから入るリンクは、X から見て 180° のすぐ上と、-180° のすぐ下の向きになる
    const c = checkDiagram(model([variable("X", 1200, 400), variable("A", 950, 290), variable("B", 800, 286), link("A", "X"), link("B", "X")]));
    expect(c.converging_lines).toHaveLength(1);
    expect(c.converging_lines[0]).toMatch(/^X に 2 本の線がほぼ同じ向き（\d+° の幅）でつながる：/);
    expect(c.converging_lines[0]).toContain("リンク A → X");
    expect(c.converging_lines[0]).toContain("リンク B → X");
  });

  test("フローの線とリンクがそろうところも知らせる", () => {
    // 左上の V から S に入るリンクは、曲がって左から S に入るので、フロー「流入」の線と重なる
    const c = checkDiagram(model([variable("V", 100, 30), link("V", "S")]));
    expect(c.converging_lines).toHaveLength(1);
    expect(c.converging_lines[0]).toMatch(/^S に 2 本の線がほぼ同じ向き（0° の幅）でつながる：/);
    expect(c.converging_lines[0]).toContain("フロー 流入（弁 → S）");
    expect(c.converging_lines[0]).toContain("リンク V → S");
  });

  test("向きが少しずつずれた線は、1 つの大きなまとまりにしない", () => {
    // 10° おきに 6 本。となりどうしは近いが、全体では 50° 開いているので「ほぼ同じ向き」とは言えない
    const names = ["A", "B", "C", "D", "E", "F"];
    const around = names.map((n, i) => {
      const t = ((i * 10) / 180) * Math.PI;
      return variable(n, 1500 + Math.cos(t) * 500, 400 + Math.sin(t) * 500);
    });
    const c = checkDiagram(model([variable("X", 1500, 400), ...around, ...names.map((n) => link(n, "X"))]));
    expect(c.converging_lines).toHaveLength(3);
    for (const s of c.converging_lines) expect(s).toMatch(/^X に 2 本の線がほぼ同じ向き（10° の幅）でつながる：/);
  });
});
