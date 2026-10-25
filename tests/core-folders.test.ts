import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { ModelStore, StoreError, checkFolderName, checkModelName, emptyModel, folderOf } from "../src/core/index.js";
import { tempDir } from "./helpers.js";

const exists = (p: string) => stat(p).then(
  () => true,
  () => false,
);

describe("フォルダを含むモデル名", () => {
  test("作業フォルダからの相対パス（/ 区切り、.json なし）にそろえる", () => {
    expect(checkModelName("coffee-cooling")).toBe("coffee-cooling");
    expect(checkModelName("ブルックスの法則/brooks_law_detailed")).toBe("ブルックスの法則/brooks_law_detailed");
    expect(checkModelName(" a/b/c.json ")).toBe("a/b/c");
    expect(folderOf("a/b/c")).toBe("a/b");
    expect(folderOf("c")).toBe("");
    expect(checkFolderName("a/b/")).toBe("a/b");
  });

  test("作業フォルダの外や隠しフォルダを指す名前は拒否する", () => {
    for (const bad of ["../x", "a/../../x", "/x", "C:/x", "c:x", "a\\b", "..\\x", "a//b", ".git/x", "a/.hidden", "a/b.slides", " a /b", "t./m", "a/m.", "a/b ./m"]) {
      expect(() => checkModelName(bad), bad).toThrow(StoreError);
    }
    for (const bad of ["", "/", "..", "../x", "a/..", "/abs", "C:/x", "a\\b", ".git", "a/.cache", "t.", "a/b."]) {
      expect(() => checkFolderName(bad), bad).toThrow(StoreError);
    }
  });
});

describe("フォルダに分けたモデルの一覧", () => {
  test("サブフォルダの中も（何段でも）たどり、モデルのあるフォルダと空のフォルダだけを出す", async () => {
    const dir = await tempDir();
    const store = new ModelStore(dir);
    await store.write("coffee-cooling", emptyModel("コーヒー"));
    await store.write("ブルックスの法則/brooks_law", emptyModel("ブルックスの法則"));
    await store.write("ブルックスの法則/brooks_law_detailed", emptyModel("詳しい版"));
    await store.write("事例/在庫/bullwhip", emptyModel("ブルウィップ"));
    // 付属のファイルはモデルとして出さない
    await store.writeData("ブルックスの法則/brooks_law", "Month,x\n0,1\n");
    // 削除したスライドの機能の筋書き（<名前>.slides.json）が残っていても、モデルとして出さない
    await writeFile(path.join(dir, "coffee-cooling.slides.json"), JSON.stringify({ slides: [] }));
    // モデル以外のファイルだけがあるフォルダ（書き出し先）は出さない。その中の空のフォルダも出さない
    await mkdir(path.join(dir, "exports", "brooks_law", "images"), { recursive: true });
    await mkdir(path.join(dir, "exports", "空"), { recursive: true });
    await writeFile(path.join(dir, "exports", "brooks_law", "diagram.png"), "png");
    await mkdir(path.join(dir, "output"));
    await writeFile(path.join(dir, "output", "run.csv"), "t,x\n");
    // 空のフォルダ（空のサブフォルダだけがあるもの、OS が作るファイルだけがあるものも）は出す
    await mkdir(path.join(dir, "新しい/下"), { recursive: true });
    await mkdir(path.join(dir, "mac"));
    await writeFile(path.join(dir, "mac", ".DS_Store"), "");
    // 先頭が . のフォルダは出さず、中のモデルも読まない
    await mkdir(path.join(dir, ".hidden"));
    await writeFile(path.join(dir, ".hidden", "x.json"), JSON.stringify(emptyModel("x")));

    const tree = await store.tree();
    expect(tree.models.map((m) => [m.name, m.folder, m.title])).toEqual([
      ["coffee-cooling", "", "コーヒー"],
      ["ブルックスの法則/brooks_law", "ブルックスの法則", "ブルックスの法則"],
      ["ブルックスの法則/brooks_law_detailed", "ブルックスの法則", "詳しい版"],
      ["事例/在庫/bullwhip", "事例/在庫", "ブルウィップ"],
    ]);
    expect(tree.folders).toEqual([
      { name: "mac", models: 0 },
      { name: "ブルックスの法則", models: 2 },
      { name: "事例", models: 1 },
      { name: "事例/在庫", models: 1 },
      { name: "新しい", models: 0 },
      { name: "新しい/下", models: 0 },
    ]);
    expect((await store.list()).map((m) => m.name)).toEqual(tree.models.map((m) => m.name));
  });

  test("フォルダの中のモデルも、付属のファイルといっしょに読み書きできる", async () => {
    const dir = await tempDir();
    const store = new ModelStore(dir);
    await store.write("a/b/m", emptyModel("M"));
    expect(await exists(path.join(dir, "a", "b", "m.json"))).toBe(true);
    expect((await store.read("a/b/m")).name).toBe("M");
    await store.writeData("a/b/m", "t,x\n0,1\n");
    expect(store.dataPathOf("a/b/m")).toBe(path.join(dir, "a", "b", "m.data.csv"));
    expect(await store.readData("a/b/m")).toMatch(/t,x/);
    await expect(store.read("a/b/none")).rejects.toThrow(/あるモデル: a\/b\/m/);
  });
});

describe("モデルとフォルダの操作", () => {
  async function setup() {
    const dir = await tempDir();
    const store = new ModelStore(dir);
    await store.write("brooks_law", emptyModel("B"));
    await store.writeData("brooks_law", "Month,x\n0,1\n");
    return { dir, store };
  }

  test("モデルを動かすと、付属のファイルもいっしょに動き、行き先のフォルダがなければ作る", async () => {
    const { dir, store } = await setup();
    const r = await store.moveModel("brooks_law", "ブルックスの法則/brooks_law");
    expect(r).toMatchObject({ from: "brooks_law", to: "ブルックスの法則/brooks_law" });
    expect((await readdir(path.join(dir, "ブルックスの法則"))).sort()).toEqual(["brooks_law.data.csv", "brooks_law.json"]);
    expect(await exists(path.join(dir, "brooks_law.json"))).toBe(false);
    expect(await exists(path.join(dir, "brooks_law.data.csv"))).toBe(false);
    // 名前を変える
    await store.moveModel("ブルックスの法則/brooks_law", "ブルックスの法則/基本");
    expect((await store.list()).map((m) => m.name)).toEqual(["ブルックスの法則/基本"]);
    expect(await store.readData("ブルックスの法則/基本")).toMatch(/Month/);
  });

  test("行き先に同じ名前のモデルや付属のファイルがあれば、動かさない", async () => {
    const { dir, store } = await setup();
    await store.write("other", emptyModel("O"));
    await expect(store.moveModel("brooks_law", "other")).rejects.toThrow(/同じ名前/);
    // モデルはなくても、残った付属のファイルがあれば断る（上書きしない）
    await writeFile(path.join(dir, "orphan.data.csv"), "t,x\n");
    await expect(store.moveModel("brooks_law", "orphan")).rejects.toThrow(/orphan\.data\.csv/);
    await expect(store.moveModel("none", "x")).rejects.toThrow(/見つかりません/);
    await expect(store.moveModel("brooks_law", "../x")).rejects.toThrow(StoreError);
    expect(await exists(path.join(dir, "brooks_law.json"))).toBe(true);
  });

  test("モデルを消すと、付属のファイルもいっしょに消え、exports/ に書き出したファイルは残る", async () => {
    const { dir, store } = await setup();
    await mkdir(path.join(dir, "exports", "brooks_law"), { recursive: true });
    await writeFile(path.join(dir, "exports", "brooks_law", "diagram.png"), "png");
    const r = await store.removeModel("brooks_law");
    expect(r.files.map((f) => path.basename(f)).sort()).toEqual(["brooks_law.data.csv", "brooks_law.json"]);
    expect((await readdir(dir)).sort()).toEqual(["exports"]);
    expect(await readFile(path.join(dir, "exports", "brooks_law", "diagram.png"), "utf8")).toBe("png");
    await expect(store.removeModel("brooks_law")).rejects.toThrow(/見つかりません/);
  });

  test("フォルダを作り、中のモデルごと動かし、空のフォルダだけを消す", async () => {
    const { dir, store } = await setup();
    expect(await store.createFolder("事例/在庫")).toMatchObject({ folder: "事例/在庫", created: true });
    expect(await store.createFolder("事例/在庫")).toMatchObject({ created: false });
    expect((await store.tree()).folders).toEqual([
      { name: "事例", models: 0 },
      { name: "事例/在庫", models: 0 },
    ]);
    await store.moveModel("brooks_law", "ブルックスの法則/brooks_law");
    // フォルダを動かすと、中のモデルと付属のファイルもいっしょに動く
    const moved = await store.moveFolder("ブルックスの法則", "事例/ブルックスの法則");
    expect(moved.models).toEqual(["事例/ブルックスの法則/brooks_law"]);
    expect(await store.readData("事例/ブルックスの法則/brooks_law")).toMatch(/Month/);
    await expect(store.moveFolder("事例", "事例/下")).rejects.toThrow(/その中のフォルダ/);
    await expect(store.moveFolder("事例/在庫", "事例/ブルックスの法則")).rejects.toThrow(/同じ名前/);
    await expect(store.moveFolder("ない", "x")).rejects.toThrow(/見つかりません/);
    // 中にファイルがあるフォルダは消さない
    await expect(store.removeFolder("事例")).rejects.toThrow(/ファイルがある/);
    expect(await exists(path.join(dir, "事例", "ブルックスの法則", "brooks_law.json"))).toBe(true);
    // 空のフォルダは、空のサブフォルダと OS が作るファイルごと消す
    await mkdir(path.join(dir, "事例", "在庫", "下"));
    await writeFile(path.join(dir, "事例", "在庫", "Thumbs.db"), "");
    await store.removeFolder("事例/在庫");
    expect(await exists(path.join(dir, "事例", "在庫"))).toBe(false);
    await expect(store.removeFolder("..")).rejects.toThrow(StoreError);
  });

  test("以前の筋書き（<名前>.slides.json）だけが残ったフォルダは、空のフォルダとして出し、消せる", async () => {
    const { dir, store } = await setup();
    await store.moveModel("brooks_law", "事例/brooks_law");
    await writeFile(path.join(dir, "事例", "brooks_law.slides.json"), JSON.stringify({ slides: [] }));
    await store.removeModel("事例/brooks_law");
    expect((await store.tree()).folders).toEqual([{ name: "事例", models: 0 }]);
    await store.removeFolder("事例");
    expect(await exists(path.join(dir, "事例"))).toBe(false);
  });

  test.runIf(process.platform === "win32" || process.platform === "darwin")("大文字と小文字だけを変える名前の変更もできる", async () => {
    const { dir, store } = await setup();
    await store.moveModel("brooks_law", "Brooks_Law");
    expect((await readdir(dir)).sort()).toEqual(["Brooks_Law.data.csv", "Brooks_Law.json"]);
    await store.createFolder("abc");
    await store.moveFolder("abc", "ABC");
    expect(await readdir(dir)).toContain("ABC");
  });
});
