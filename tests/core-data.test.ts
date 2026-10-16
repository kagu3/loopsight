import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  ImportError,
  ModelStore,
  checkActualData,
  dataToCSV,
  emptyModel,
  namesByElement,
  parseDataCSV,
  renamesSince,
  upsertElements,
} from "../src/core/index.js";
import { tempDir } from "./helpers.js";

function population() {
  const m = emptyModel("人口モデル", { time_length: 10 });
  upsertElements(m, [
    { type: "STOCK", name: "Population", behavior: { initial_value: 100 } },
    { type: "VARIABLE", name: "Birth Rate", behavior: { value: 0.1 } },
    { type: "FLOW", name: "Births", to: "Population", behavior: { value: "[Population]*[Birth Rate]" } },
  ]);
  return m;
}

describe("実際のデータの CSV を読む", () => {
  test("1 列目が時刻、ほかの列が要素。空欄は値なし。時刻の順に並べる", () => {
    const d = parseDataCSV("Year,Population,Births\n2,120,\n0,100,10\n1,110,11\n");
    expect(d.time_label).toBe("Year");
    expect(d.times).toEqual([0, 1, 2]);
    expect(d.columns).toEqual([
      { name: "Population", values: [100, 110, 120] },
      { name: "Births", values: [10, 11, null] },
    ]);
  });

  test("Excel から貼ったタブ区切り、BOM、CRLF、囲み、桁区切り、末尾の空の列と空行を読む", () => {
    const tab = parseDataCSV("﻿時刻\t人口\t\r\n0\t1,000\t\r\n1\t1,100\t\r\n\t\t\r\n");
    expect(tab.columns).toEqual([{ name: "人口", values: [1000, 1100] }]);
    const quoted = parseDataCSV('Time,"Population, total"\n0,"1,234.5"\n');
    expect(quoted.columns).toEqual([{ name: "Population, total", values: [1234.5] }]);
  });

  test("読めないものは、どこがおかしいかを添えて断る", () => {
    expect(() => parseDataCSV("")).toThrow(ImportError);
    expect(() => parseDataCSV("Time\n0\n")).toThrow(/要素の列/);
    expect(() => parseDataCSV("Time,A\nx,1\n")).toThrow(/2 行目の時刻/);
    expect(() => parseDataCSV("Time,A\n0,abc\n")).toThrow(/"A" の値 "abc"/);
    expect(() => parseDataCSV("Time,A,a\n0,1,2\n")).toThrow(/2 つ/);
    expect(() => parseDataCSV("Time,,B\n0,1,2\n")).toThrow(/2 列目の見出し/);
  });

  test("CSV に書き戻すと同じ内容に読める", () => {
    const d = parseDataCSV('Time,"A,B",C\n0,1,\n0.5,2,3\n');
    expect(parseDataCSV(dataToCSV(d))).toEqual(d);
  });
});

describe("実際のデータをモデルと照らし合わせる", () => {
  test("要素名と合わない列は「もしかして」を付けて知らせる。合う列は要素の表記にそろえる", () => {
    const d = parseDataCSV("Time,population,Birth Rat,Unknown\n0,1,2,3\n");
    const issues = checkActualData(population(), d);
    expect(d.columns.map((c) => c.name)).toEqual(["Population", "Birth Rat", "Unknown"]);
    expect(issues).toHaveLength(2);
    expect(issues[0]!.message).toMatch(/"Birth Rat"/);
    expect(issues[0]!.hint).toMatch(/もしかして "Birth Rate"/);
    expect(issues[1]!.hint).toMatch(/要素名にそろえて/);
  });

  test("時刻がシミュレーションの期間と重ならなければ知らせる", () => {
    const issues = checkActualData(population(), parseDataCSV("Year,Population\n2020,1\n2021,2\n"));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toMatch(/2020 から 2021.*0 から 10/);
    expect(checkActualData(population(), parseDataCSV("Year,Population\n5,1\n20,2\n"))).toEqual([]);
  });

  test("名前を変えた要素を調べ、ファイルの列名も直す（データがなければ何もしない）", async () => {
    const store = new ModelStore(await tempDir());
    const m = population();
    const before = namesByElement(m);
    upsertElements(m, [
      { name: "Population", rename_to: "人口" },
      { name: "Birth Rate", behavior: { value: 0.2 } },
    ]);
    const renames = renamesSince(m, before);
    expect(renames).toEqual([["Population", "人口"]]);
    expect(await store.renameDataColumns("pop", renames)).toEqual({});

    await writeFile(store.dataPathOf("pop"), "Year,population,Births\n0,100,10\n", "utf8");
    expect((await store.renameDataColumns("pop", renames)).note).toMatch(/pop\.data\.csv/);
    expect(await readFile(store.dataPathOf("pop"), "utf8")).toBe("Year,人口,Births\n0,100,10\n");
    // 合う列がなければ書き換えない
    expect(await store.renameDataColumns("pop", [["Other", "X"]])).toEqual({});
  });

  test("列名を直すときは見出しの行だけを書き換え、値の表記や行の順はそのまま残す", async () => {
    const store = new ModelStore(await tempDir());
    const text = '﻿\r\nYear,"Population",Births,\r\n2,"1,200",1.50,\r\n0,1000,,x\r\n';
    await writeFile(store.dataPathOf("pop"), text, "utf8");
    await store.renameDataColumns("pop", [["population", "人口, 合計"]]);
    expect(await readFile(store.dataPathOf("pop"), "utf8")).toBe('﻿\r\nYear,"人口, 合計",Births,\r\n2,"1,200",1.50,\r\n0,1000,,x\r\n');
    // タブ区切りはタブ区切りのまま
    await writeFile(store.dataPathOf("tab"), "Year\tPopulation\n0\t1\n", "utf8");
    await store.renameDataColumns("tab", [["Population", "人口"]]);
    expect(await readFile(store.dataPathOf("tab"), "utf8")).toBe("Year\t人口\n0\t1\n");
  });

  test("列名を直せないときは、例外を投げずに知らせる文を返す", async () => {
    const store = new ModelStore(await tempDir());
    // 変えると列名が重なる
    await writeFile(store.dataPathOf("pop"), "Year,Population,人口\n0,1,2\n", "utf8");
    expect((await store.renameDataColumns("pop", [["Population", "人口"]])).warning).toMatch(/直せませんでした.*2 つ/);
    // 見出しが読めない（書きかけ）
    await writeFile(store.dataPathOf("pop"), 'Year,"Population\n0,1\n', "utf8");
    expect((await store.renameDataColumns("pop", [["Population", "人口"]])).warning).toMatch(/直せませんでした/);
    // ファイルがほかのアプリで開かれていて書けない
    await writeFile(store.dataPathOf("pop"), "Year,Population\n0,1\n", "utf8");
    store.writeTextFile = async () => {
      throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    };
    expect((await store.renameDataColumns("pop", [["Population", "人口"]])).warning).toMatch(/EBUSY.*Excel/);
    expect(await readFile(store.dataPathOf("pop"), "utf8")).toBe("Year,Population\n0,1\n");
  });

  test("データのファイルはモデルの一覧に出さない", async () => {
    const store = new ModelStore(await tempDir());
    await store.write("pop", population());
    await store.writeData("pop", "Time,Population\n0,1\n");
    expect((await store.list()).map((m) => m.name)).toEqual(["pop"]);
  });
});
