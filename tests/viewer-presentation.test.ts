import { describe, expect, test } from "vitest";
import { SLIDE_KIND_LABEL, emptyModel, upsertElements } from "../src/core/index.js";
import { KIND_LABEL, changeFrom, nextSlide, scenarioChanges, slideIndexFrom, valueAt } from "../web/src/presentation.js";

describe("発表モード", () => {
  test("スライドの種類の呼び名はサーバーと同じ", () => {
    expect(KIND_LABEL).toEqual(SLIDE_KIND_LABEL);
  });

  test("アドレスの slide=（1 から）を、範囲に収めたスライドの番号（0 から）にする", () => {
    expect(slideIndexFrom("?view=present&slide=3", 5)).toBe(2);
    expect(slideIndexFrom("?view=present&slide=9", 5)).toBe(4);
    expect(slideIndexFrom("?view=present", 5)).toBe(0);
    expect(slideIndexFrom("?slide=abc", 5)).toBe(0);
  });

  test("← → などのキーで進んだり戻ったりする。端では止まる", () => {
    expect(nextSlide("ArrowRight", 0, 3)).toBe(1);
    expect(nextSlide("ArrowRight", 2, 3)).toBe(2);
    expect(nextSlide("ArrowLeft", 0, 3)).toBe(0);
    expect(nextSlide("PageUp", 2, 3)).toBe(1);
    expect(nextSlide(" ", 1, 3)).toBe(2);
    expect(nextSlide("End", 0, 3)).toBe(2);
    expect(nextSlide("Home", 2, 3)).toBe(0);
    expect(nextSlide("a", 1, 3)).toBeUndefined();
    expect(nextSlide("ArrowRight", 0, 0)).toBeUndefined();
  });

  test("注目する時点の値は、刻みの間なら前後から直線で補う", () => {
    const times = [0, 1, 2];
    expect(valueAt(times, [10, 20, 40], 2)).toBe(40);
    expect(valueAt(times, [10, 20, 40], 1.5)).toBe(30);
    expect(valueAt(times, [10, null, 40], 0.5)).toBeNull();
    expect(valueAt(times, [10, 20, 40], 3)).toBeNull();
    expect(valueAt(times, undefined, 1)).toBeNull();
  });

  test("「何もしない場合」と比べた変化", () => {
    expect(changeFrom(200, 122)).toBe("−39%");
    expect(changeFrom(200, 230)).toBe("+15%");
    expect(changeFrom(200, 200.4)).toBe("±0%");
    expect(changeFrom(0, 1)).toBe("");
    expect(changeFrom(null, 1)).toBe("");
  });

  test("解決案に出す、施策で変える値といまの値", () => {
    const m = emptyModel("m");
    upsertElements(m, [
      { type: "STOCK", name: "Population", behavior: { initial_value: 100 } },
      { type: "VARIABLE", name: "Birth Rate", behavior: { value: 0.03 } },
    ]);
    const changes = scenarioChanges(m, { name: "支援", values: { "birth rate": 0.02, Population: 120 } });
    expect(changes).toEqual([
      { name: "birth rate", before: 0.03, after: 0.02 },
      { name: "Population", before: 100, after: 120 },
    ]);
    expect(scenarioChanges(m, undefined)).toEqual([]);
  });
});
