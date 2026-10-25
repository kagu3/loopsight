import { readdir } from "node:fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ModelStore, emptyModel } from "../src/core/index.js";
import { tempDir } from "./helpers.js";

// ほかのアプリ（Excel など）がファイルを開いていて、動かしたり消したりできないときの代わりに、
// 名前の終わりが busy に合うファイルの rename と unlink を失敗させる
const busy = vi.hoisted(() => ({ suffix: undefined as string | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  const fail = (p: unknown) => {
    if (busy.suffix && String(p).endsWith(busy.suffix)) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
  };
  return {
    ...fs,
    rename: async (from: string, to: string) => {
      fail(from);
      return fs.rename(from, to);
    },
    unlink: async (p: string) => {
      fail(p);
      return fs.unlink(p);
    },
  };
});

afterEach(() => {
  busy.suffix = undefined;
});

async function setup() {
  const dir = await tempDir();
  const store = new ModelStore(dir);
  await store.write("m", emptyModel("M"));
  await store.writeData("m", "t,x\n0,1\n");
  return { dir, store };
}

describe("付属のファイルを動かせない・消せないとき", () => {
  test("モデルを動かさず、途中まで動かしたファイルは元に戻す", async () => {
    const { dir, store } = await setup();
    busy.suffix = "m.json";
    await expect(store.moveModel("m", "x/m")).rejects.toThrow(/m\.json を動かせなかった.*開かれていないか/);
    busy.suffix = undefined;
    // 動かすために作ったフォルダも残さない
    expect((await readdir(dir)).sort()).toEqual(["m.data.csv", "m.json"]);
  });

  test("付属のファイルを消せなければ、モデルは消さない", async () => {
    const { dir, store } = await setup();
    busy.suffix = "m.data.csv";
    await expect(store.removeModel("m")).rejects.toThrow(/m\.data\.csv を消せなかったため、モデルは消していません/);
    busy.suffix = undefined;
    expect((await readdir(dir)).sort()).toEqual(["m.data.csv", "m.json"]);
    expect((await store.list()).map((x) => x.name)).toEqual(["m"]);
  });
});
