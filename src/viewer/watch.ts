import { watch, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

// 作業フォルダの監視。サブフォルダの中（何段でも）のファイルの変更と、フォルダを作ったり消したりしたことに気づく。
// fs.watch の recursive が使えるかは Node の版と OS で違うので、使えなければフォルダごとに見張る。

export interface TreeWatcher {
  /** recursive で見張っているか（false ならフォルダごとに見張っている） */
  recursive: boolean;
  close(): void;
}

/** 見張るのをやめたときに知らせる（拾わないと、Windows で見張っているフォルダが消されたときにプロセスごと止まる） */
const onWatchError = (e: unknown) => console.error(`作業フォルダを監視できなくなりました: ${(e as Error).message}`);

/**
 * dir の中を見張り、変わったファイルやフォルダを onChange で知らせる。file は dir からの相対パス（区切りは /）。
 * 先頭が . のフォルダの中は見張らない。options.recursive に false を渡すと、recursive を使わずにフォルダごとに見張る（テスト用）
 */
export function watchTree(dir: string, onChange: (file: string) => void, options: { recursive?: boolean } = {}): TreeWatcher {
  if (options.recursive !== false) {
    try {
      const w = watch(dir, { recursive: true }, (_event, file) => file && onChange(file.toString().split(path.sep).join("/")));
      w.on("error", onWatchError);
      return { recursive: true, close: () => w.close() };
    } catch {
      // recursive が使えない（ERR_FEATURE_UNAVAILABLE_ON_PLATFORM など）。フォルダごとに見張る
    }
  }
  return watchEachFolder(dir, onChange);
}

/** フォルダごとに fs.watch で見張る。フォルダが増えたり減ったりしたら、見張るフォルダを合わせ直す */
function watchEachFolder(dir: string, onChange: (file: string) => void): TreeWatcher {
  const watchers = new Map<string, FSWatcher>();
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  const resync = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void sync(), 100);
  };
  const add = (rel: string) => {
    if (watchers.has(rel)) return;
    try {
      const w = watch(path.join(dir, rel), (_event, file) => {
        onChange(file ? (rel ? `${rel}/${file.toString()}` : file.toString()) : rel);
        // 中にフォルダができたり消えたりしたかもしれない
        resync();
      });
      w.on("error", (e) => {
        w.close();
        watchers.delete(rel);
        if (!rel) onWatchError(e);
        resync();
      });
      watchers.set(rel, w);
    } catch {
      // 見張る前に消えたフォルダ
    }
  };
  // announce: 新しく見張り始めたフォルダを知らせる（始めたときは、もとからあるフォルダなので知らせない）
  const sync = async (announce = true) => {
    if (closed) return;
    const found = new Set([""]);
    const walk = async (rel: string) => {
      const entries = await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".")) continue;
        const sub = rel ? `${rel}/${e.name}` : e.name;
        found.add(sub);
        await walk(sub);
      }
    };
    await walk("");
    if (closed) return;
    for (const [rel, w] of watchers) {
      if (found.has(rel)) continue;
      w.close();
      watchers.delete(rel);
    }
    for (const rel of found) {
      if (watchers.has(rel)) continue;
      add(rel);
      // 見張り始める前に、中のファイルが変わっていたかもしれないので知らせる
      if (announce) onChange(rel);
    }
  };
  add("");
  void sync(false);
  return {
    recursive: false,
    close: () => {
      closed = true;
      clearTimeout(timer);
      for (const w of watchers.values()) w.close();
      watchers.clear();
    },
  };
}
