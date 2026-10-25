// 図だけを画像（SVG と PNG）にする（資料に貼る用）。ビューアの図の「書き出す」ボタンと、MCP の export_diagram（ヘッドレスのブラウザ）の両方で使う。
// 図を描き直さず、画面に描いた図（React Flow のノードと線）の DOM を、そのまま SVG の図形と文字に写す。
// 図に部品が増えても（グループの囲み、注釈、遅れの印など）、図の中に描いたものは書き出しにも入る。
// 図の外の札（ループの名前など、React Flow の Panel）は、図の上か下の同じ側（左・右・真ん中）に並べる（グループの凡例は下の真ん中）。
//
// 決まり：
// - 背景は白で、いつも明るい配色にする（暗い表示で見ていても）。書き出す間だけ、明るい配色のトークンに切り替えて色を読む
// - 操作のための部品（全体図、ズームのボタン、背景の点、図の右上・左上の道具、式の箱、線を引く口、フローの端のつまみ）は入れない
// - 操作の状態（選んだ要素の枠と、それでほかを薄くする表示、変わったところの光り、編集中の印）は外す。
//   「値を表示」の値や、目立たせたループ、シナリオの札は、見ているまま入れる
// - ズームや見ている場所にはよらず、図全体を図の座標（ズーム 1 倍の大きさ）で書き出す
// - 文字は <text> にする（拡大してもぼやけない）。フォントが開く環境で変わっても崩れにくいよう、
//   画面で測った幅を textLength で決め、日本語のフォントを後ろに並べる

export interface DiagramImage {
  svg: string;
  /** SVG の幅と高さ（px。図の座標と同じ） */
  width: number;
  height: number;
}

export interface ExportOptions {
  /** 選んでいる要素による表示（枠と、ほかを薄くする表示）を外す。ループを目立たせているときは、薄くする表示はループのものなので外さない */
  dropSelection?: boolean;
  /** 図の線の数（グラフの線の数）。描かれた線がこれより少なければ、描き終わるまで少し待つ */
  edges?: number;
}

/** 書き出した SVG と PNG。scale は PNG の倍率（大きすぎる図では、上限に合わせて下げる） */
export interface ExportedDiagram extends DiagramImage {
  png: Blob;
  scale: number;
}

/** 背景の色（白）。書き出す間は、図の地の色（--surface-1）もこの色にする（弁や雲の塗り、薄くした色が白になじむように） */
const BACKGROUND = "#ffffff";
/** 図のまわりの余白 */
const PADDING = 16;
/** 図と、図の外の札のあいだ */
const PANEL_GAP = 12;
/** PNG の長い辺の上限（ブラウザの canvas の上限より小さく） */
const MAX_PNG_SIDE = 8000;

/** 書き出さない部品（操作のためのもの）。新しい部品も、data-export="skip" を付けると書き出さない */
const SKIP = [
  ".react-flow__handle",
  ".react-flow__edge-interaction",
  ".react-flow__background",
  ".react-flow__controls",
  ".react-flow__minimap",
  ".react-flow__attribution",
  ".flow-end-grip",
  ".flow-end-drag",
  ".edit-tools",
  ".top-right-tools",
  ".formula-card",
  "[data-export='skip']",
].join(",");
/** 操作の状態を表すクラス。書き出す間だけ外す */
const OPERATION_CLASSES = ["is-selected", "is-changed", "is-link-from", "is-drop-target", "is-grabbed"];

/** 画面のフォントの後ろに足すフォント。画面のフォントがない環境（ほかの OS やスライドのアプリ）でも、日本語の読めるフォントに落ちるように */
const FONT_FALLBACK = ["Segoe UI", "Yu Gothic UI", "Yu Gothic", "Meiryo", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Noto Sans CJK JP"];
/** 総称のフォント名など、ブラウザでしか通じないか、それ以降のフォントが使われなくなる名前 */
const GENERIC_FONTS = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "-apple-system", "blinkmacsystemfont", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded", "emoji", "math", "fangsong"]);

/**
 * SVG に書くフォントの並び。画面のフォントから総称の名前を除き、日本語のフォントを足して、最後に sans-serif を 1 つだけ置く
 * （総称が途中にあると、そこで決まって後ろのフォントが使われない。system-ui などはブラウザ以外で読めないことがある）
 */
export function svgFontFamily(css: string): string {
  const names = css.split(",").map((f) => f.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  const specific = [...names, ...FONT_FALLBACK].filter((f) => !GENERIC_FONTS.has(f.toLowerCase()));
  const unique = specific.filter((f, i) => specific.findIndex((g) => g.toLowerCase() === f.toLowerCase()) === i);
  return [...unique.map((f) => (/^[\w-]+$/.test(f) ? f : `'${f}'`)), "sans-serif"].join(", ");
}

/** 図（React Flow の .react-flow の要素）を SVG にする */
export function diagramToSVG(root: HTMLElement, options: ExportOptions = {}): DiagramImage {
  return withExportLook(root, options, () => serialize(root));
}

/** 図を SVG と PNG（scale 倍）にする */
export async function exportDiagram(root: HTMLElement, options: ExportOptions & { scale?: number } = {}): Promise<ExportedDiagram> {
  await waitForEdges(root, options.edges ?? 0);
  const image = diagramToSVG(root, options);
  const { png, scale } = await svgToPNG(image, options.scale ?? 2);
  return { ...image, png, scale };
}

/** 線を描き終わるまで待つ時間の上限 */
const EDGE_WAIT_MS = 3000;

/**
 * 図の線が描かれるまで待つ。React Flow は、要素を選んだ直後などに線を描き直すことがあり、その間は線が DOM からなくなる（そのまま書き出すと線のない画像になる）。
 * 待っても足りなければ、例外にする
 */
async function waitForEdges(root: HTMLElement, expected: number): Promise<void> {
  const drawn = () => root.querySelectorAll(".react-flow__edge-path").length;
  const frame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));
  if (drawn() >= expected) return;
  const started = performance.now();
  while (drawn() < expected) {
    if (performance.now() - started > EDGE_WAIT_MS) throw new Error(`図の線がまだ描かれていません（${expected} 本のうち ${drawn()} 本）。少し待ってから、もう一度書き出してください。`);
    await new Promise((r) => setTimeout(r, 50));
  }
  // 描き終えた直後の位置が落ち着くのを待つ
  await frame();
  await frame();
}

/** SVG を PNG にする。ブラウザに SVG をそのまま描かせるので、拡大してもぼやけない（文字も図形も scale 倍の解像度で描く） */
export async function svgToPNG(image: DiagramImage, scale: number): Promise<{ png: Blob; scale: number }> {
  const s = Math.max(0.1, Math.min(scale, MAX_PNG_SIDE / Math.max(image.width, image.height)));
  const url = URL.createObjectURL(new Blob([image.svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(image.width * s);
    canvas.height = Math.round(image.height * s);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG にできませんでした。"))), "image/png"));
    return { png, scale: s };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Blob を base64 の文字列にする（サーバーや MCP に送るため） */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/**
 * 書き出す間だけ、明るい配色にし、操作の状態のクラスを外す。色の移り変わり（transition）も止める（止めないと、切り替える前の色が読める）。
 * どれも同じ流れの中で戻すので、画面には出ない
 */
function withExportLook<T>(root: HTMLElement, options: ExportOptions, f: () => T): T {
  const html = document.documentElement;
  const theme = html.getAttribute("data-theme");
  const surface = html.style.getPropertyValue("--surface-1");
  const still = document.createElement("style");
  still.textContent = "*, *::before, *::after { transition: none !important; animation: none !important; }";
  document.head.appendChild(still);
  const strip = options.dropSelection ? [...OPERATION_CLASSES, "is-dimmed"] : OPERATION_CLASSES;
  const classes: [Element, string][] = [];
  for (const el of root.querySelectorAll(strip.map((c) => `.${c}`).join(","))) {
    classes.push([el, el.getAttribute("class") ?? ""]);
    el.classList.remove(...strip);
  }
  // React Flow は暗い表示で .dark を付ける（React Flow の部品の色が変わる）
  const dark = root.classList.contains("dark");
  if (dark) root.classList.replace("dark", "light");
  html.setAttribute("data-theme", "light");
  html.style.setProperty("--surface-1", BACKGROUND);
  try {
    return f();
  } finally {
    if (surface) html.style.setProperty("--surface-1", surface);
    else html.style.removeProperty("--surface-1");
    if (theme === null) html.removeAttribute("data-theme");
    else html.setAttribute("data-theme", theme);
    if (dark) root.classList.replace("light", "dark");
    for (const [el, cls] of classes) el.setAttribute("class", cls);
    // 戻した見た目を、移り変わりを止めたまま決めてから、止めるのをやめる
    void getComputedStyle(root).color;
    still.remove();
  }
}

// ---- DOM を SVG に写す ----

/** 画面の座標を、書き出す座標に直す決まり。図の中は図の座標（ズームを戻す）、図の外の札は札の左上からの px */
interface Frame {
  ox: number;
  oy: number;
  /** 画面の px → 書き出す座標の倍率（1 / ズーム） */
  k: number;
}

/** 書き出す SVG の部品と、その範囲 */
class Out {
  parts: string[] = [];
  minX = Infinity;
  minY = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;
  push(s: string) {
    this.parts.push(s);
  }
  cover(x: number, y: number, w: number, h: number) {
    if (!(w > 0 || h > 0)) return;
    this.minX = Math.min(this.minX, x);
    this.minY = Math.min(this.minY, y);
    this.maxX = Math.max(this.maxX, x + w);
    this.maxY = Math.max(this.maxY, y + h);
  }
  get empty() {
    return this.minX === Infinity;
  }
}

/** SVG の中の id（線の矢じりなど）。React Flow の id には記号が多く、ほかのアプリで読めないことがあるので、短い名前に付け替える */
class Ids {
  map = new Map<string, string>();
  of(id: string) {
    if (!this.map.has(id)) this.map.set(id, `d${this.map.size + 1}`);
    return this.map.get(id)!;
  }
  /** 属性の中の url(#...) を付け替える。React Flow の id は var(--link) のようにかっこを含むので、引用符があれば引用符まで読む */
  rewrite(value: string) {
    return value.replace(/url\((?:(['"])#(.*?)\1|#([^)'"]+))\)/g, (_, _q, quoted: string | undefined, bare: string | undefined) => `url(#${this.of(quoted ?? bare ?? "")})`);
  }
}

const num = (v: number) => String(Math.round(v * 100) / 100);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const px = (v: string) => parseFloat(v) || 0;

/** 札を置く側。React Flow の Panel の position（top-left、bottom-center など）の横の位置 */
type Side = "left" | "right" | "center";
const SIDES: readonly Side[] = ["left", "right", "center"];

function serialize(root: HTMLElement): DiagramImage {
  const ids = new Ids();
  const defs: string[] = [];
  const viewport = root.querySelector<HTMLElement>(".react-flow__viewport");
  if (!viewport) throw new Error("図が見つかりません。");
  const zoom = new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a || 1;
  const origin = viewport.getBoundingClientRect();
  const body = new Out();
  const frame = { ox: origin.left, oy: origin.top, k: 1 / zoom };
  // 重ねる順（z-index）が負のノード（グループの囲み）は、画面では線より後ろに回るので、線より先に描く
  const behind = new Set([...viewport.querySelectorAll<HTMLElement>(".react-flow__node")].filter((n) => (Number(getComputedStyle(n).zIndex) || 0) < 0));
  for (const n of behind) walk(n, frame, body, ids, defs);
  walk(viewport, frame, body, ids, defs, behind);

  // 図の外の札（ループの名前など）。操作の道具は除く
  const panels = [...root.querySelectorAll<HTMLElement>(".react-flow__panel")].flatMap((el) => {
    if (el.closest(SKIP) || getComputedStyle(el).display === "none") return [];
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return [];
    const out = new Out();
    walk(el, { ox: r.left, oy: r.top, k: 1 }, out, ids, defs);
    const side: Side = el.classList.contains("right") ? "right" : el.classList.contains("center") ? "center" : "left";
    return [{ out, w: r.width, h: r.height, bottom: el.classList.contains("bottom"), side }];
  });
  const stack = (bottom: boolean, side: Side) => panels.filter((p) => p.bottom === bottom && p.side === side);
  const height = (list: typeof panels) => list.reduce((s, p) => s + p.h + PANEL_GAP, 0);
  const width = (list: typeof panels) => Math.max(0, ...list.map((p) => p.w));
  const rowH = (bottom: boolean) => Math.max(...SIDES.map((side) => height(stack(bottom, side))));
  // 左右の札と真ん中の札が重ならない幅（真ん中の札は、左右の広いほうの札の外に置ける幅を取る）
  const rowW = (bottom: boolean) => {
    const [l, r, c] = SIDES.map((side) => width(stack(bottom, side)));
    return c ? c + 2 * (Math.max(l!, r!) + (l || r ? PANEL_GAP : 0)) : l! + r! + PANEL_GAP;
  };
  const topH = rowH(false);
  const bottomH = rowH(true);
  const bodyW = body.empty ? 0 : body.maxX - body.minX;
  const bodyH = body.empty ? 0 : body.maxY - body.minY;
  const innerW = Math.max(bodyW, rowW(false), rowW(true));
  const W = Math.ceil(innerW + PADDING * 2);
  const H = Math.ceil(topH + bodyH + bottomH + PADDING * 2);

  const parts: string[] = [];
  // 図は、札の下に、左右の真ん中にそろえて置く
  if (!body.empty) {
    const dx = PADDING + (innerW - bodyW) / 2 - body.minX;
    const dy = PADDING + topH - body.minY;
    parts.push(`<g transform="translate(${num(dx)} ${num(dy)})">`, ...body.parts, "</g>");
  }
  for (const bottom of [false, true]) {
    for (const side of SIDES) {
      let y = bottom ? PADDING + topH + bodyH + PANEL_GAP : PADDING;
      for (const p of stack(bottom, side)) {
        const x = side === "right" ? W - PADDING - p.w : side === "center" ? (W - p.w) / 2 : PADDING;
        parts.push(`<g transform="translate(${num(x)} ${num(y)})">`, ...p.out.parts, "</g>");
        y += p.h + PANEL_GAP;
      }
    }
  }
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    defs.length ? `<defs>${defs.join("")}</defs>` : "",
    `<rect x="0" y="0" width="${W}" height="${H}" fill="${BACKGROUND}"/>`,
    ...parts,
    "</svg>",
  ].join("\n");
  return { svg, width: W, height: H };
}

/** 子を、重ねる順（z-index）に並べる。同じなら DOM の順 */
function paintOrder(el: Element): ChildNode[] {
  const z = (n: ChildNode) => {
    if (!(n instanceof Element)) return 0;
    const cs = getComputedStyle(n);
    return cs.position !== "static" && cs.zIndex !== "auto" ? Number(cs.zIndex) || 0 : 0;
  };
  return [...el.childNodes].map((n, i) => ({ n, i, z: z(n) })).sort((a, b) => a.z - b.z || a.i - b.i).map((x) => x.n);
}

/** skip：先に描いたので飛ばす要素（線より後ろに描くグループの囲み） */
function walk(el: Element, f: Frame, out: Out, ids: Ids, defs: string[], skip?: ReadonlySet<Element>): void {
  if (el.matches(SKIP) || skip?.has(el)) return;
  if (el instanceof SVGSVGElement) return svgRoot(el, f, out, ids, defs);
  if (!(el instanceof HTMLElement)) return;
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden") return;
  const opacity = px(cs.opacity);
  if (opacity <= 0) return;
  if (opacity < 1) out.push(`<g opacity="${num(opacity)}">`);
  box(el, cs, f, out);
  for (const n of paintOrder(el)) {
    if (n instanceof Text) text(n, cs, f, out);
    else if (n instanceof Element) walk(n, f, out, ids, defs, skip);
  }
  if (opacity < 1) out.push("</g>");
}

/** 角の丸み（横、縦）。% は箱の幅と高さに対して */
function radius(v: string, w: number, h: number): [number, number] {
  const [a = "0", b = a] = v.split(" ");
  const r = (s: string, base: number) => (s.endsWith("%") ? (parseFloat(s) / 100) * base : px(s));
  return [r(a, w), r(b, h)];
}

/** 角の丸い四角の形（4 つの角の丸みが違ってもよい）。inset だけ内側に寄せる（線の太さの半分） */
function roundedShape(x: number, y: number, w: number, h: number, radii: [number, number][], inset: number, attrs: string): string {
  x += inset;
  y += inset;
  w -= inset * 2;
  h -= inset * 2;
  if (w <= 0 || h <= 0) return "";
  // 丸みが辺に入りきらないときは、CSS と同じく全体を縮める
  const [tl, tr, br, bl] = radii.map(([rx, ry]) => [Math.max(0, rx - inset), Math.max(0, ry - inset)] as [number, number]);
  const s = Math.min(1, w / (tl[0] + tr[0] || 1), w / (bl[0] + br[0] || 1), h / (tl[1] + bl[1] || 1), h / (tr[1] + br[1] || 1));
  const c = [tl, tr, br, bl].map(([rx, ry]) => [rx * s, ry * s] as [number, number]);
  if (c.every(([rx, ry]) => rx === c[0]![0] && ry === c[0]![1])) {
    const [rx, ry] = c[0]!;
    const round = rx > 0 && ry > 0 ? ` rx="${num(rx)}" ry="${num(ry)}"` : "";
    return `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}"${round} ${attrs}/>`;
  }
  const [a, b, d, e] = c as [[number, number], [number, number], [number, number], [number, number]];
  const arc = ([rx, ry]: [number, number], ex: number, ey: number) => (rx > 0 && ry > 0 ? `A${num(rx)} ${num(ry)} 0 0 1 ${num(ex)} ${num(ey)}` : `L${num(ex)} ${num(ey)}`);
  const path = [
    `M${num(x + a[0])} ${num(y)}`,
    `H${num(x + w - b[0])}`,
    arc(b, x + w, y + b[1]),
    `V${num(y + h - d[1])}`,
    arc(d, x + w - d[0], y + h),
    `H${num(x + e[0])}`,
    arc(e, x, y + h - e[1]),
    `V${num(y + a[1])}`,
    arc(a, x + a[0], y),
    "Z",
  ].join(" ");
  return `<path d="${path}" ${attrs}/>`;
}

/** 線の種類（点線など）を stroke-dasharray に */
function dash(style: string, width: number): string {
  if (style === "dashed") return ` stroke-dasharray="${num(width * 3)} ${num(width * 2)}"`;
  if (style === "dotted") return ` stroke-dasharray="0 ${num(width * 2)}" stroke-linecap="round"`;
  return "";
}

/** HTML の箱の塗り・枠線・外枠（outline） */
function box(el: HTMLElement, cs: CSSStyleDeclaration, f: Frame, out: Out): void {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const x = (r.left - f.ox) * f.k;
  const y = (r.top - f.oy) * f.k;
  const w = r.width * f.k;
  const h = r.height * f.k;
  const radii = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map((v) => radius(v, w, h));
  const fill = paint(cs.backgroundColor);
  const sides = (["Top", "Right", "Bottom", "Left"] as const).map((s) => ({
    w: cs.getPropertyValue(`border-${s.toLowerCase()}-style`) === "none" ? 0 : px(cs.getPropertyValue(`border-${s.toLowerCase()}-width`)),
    style: cs.getPropertyValue(`border-${s.toLowerCase()}-style`),
    color: paint(cs.getPropertyValue(`border-${s.toLowerCase()}-color`)),
  }));
  const visible = sides.filter((s) => s.w > 0 && s.color);
  const uniform = visible.length === 4 && visible.every((s) => s.w === visible[0]!.w && s.style === visible[0]!.style && s.color === visible[0]!.color);
  if (fill || visible.length) out.cover(x, y, w, h);
  if (uniform) {
    const s = visible[0]!;
    out.push(roundedShape(x, y, w, h, radii, s.w / 2, `${fill ? fill.attr("fill") : 'fill="none"'} ${s.color!.attr("stroke")} stroke-width="${num(s.w)}"${dash(s.style, s.w)}`));
  } else {
    if (fill) out.push(roundedShape(x, y, w, h, radii, 0, fill.attr("fill")));
    // 辺ごとに違う枠線は、角を丸めずに 1 本ずつ引く
    const [top, right, bottom, left] = sides;
    const line = (s: (typeof sides)[number], x1: number, y1: number, x2: number, y2: number) =>
      s.w > 0 && s.color && out.push(`<line x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" ${s.color.attr("stroke")} stroke-width="${num(s.w)}"${dash(s.style, s.w)}/>`);
    line(top!, x, y + top!.w / 2, x + w, y + top!.w / 2);
    line(right!, x + w - right!.w / 2, y, x + w - right!.w / 2, y + h);
    line(bottom!, x, y + h - bottom!.w / 2, x + w, y + h - bottom!.w / 2);
    line(left!, x + left!.w / 2, y, x + left!.w / 2, y + h);
  }
  // 外枠（シナリオで変えた要素の点線の枠など）。React Flow のノードの外枠（キーボードで選んだときの印）は描かない
  const ow = cs.outlineStyle === "none" || el.classList.contains("react-flow__node") ? 0 : px(cs.outlineWidth);
  const oc = paint(cs.outlineColor);
  if (ow > 0 && oc) {
    const grow = px(cs.outlineOffset) + ow;
    const outer = radii.map(([rx, ry]) => [rx > 0 ? rx + grow : 0, ry > 0 ? ry + grow : 0] as [number, number]);
    out.cover(x - grow, y - grow, w + grow * 2, h + grow * 2);
    out.push(roundedShape(x - grow, y - grow, w + grow * 2, h + grow * 2, outer, ow / 2, `fill="none" ${oc.attr("stroke")} stroke-width="${num(ow)}"${dash(cs.outlineStyle, ow)}`));
  }
}

/** 文字の高さのうち、上端から並びの基準の線（ベースライン）までの割合。フォントごとに canvas で測る */
const ascentCache = new Map<string, number>();
let measureCtx: CanvasRenderingContext2D | null | undefined;
function ascentRatio(cs: CSSStyleDeclaration): number {
  const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  let v = ascentCache.get(font);
  if (v === undefined) {
    measureCtx ??= document.createElement("canvas").getContext("2d");
    v = 0.8;
    if (measureCtx) {
      measureCtx.font = font;
      const m = measureCtx.measureText("あA");
      if (m.fontBoundingBoxAscent > 0) v = m.fontBoundingBoxAscent / (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent);
    }
    ascentCache.set(font, v);
  }
  return v;
}

/** 文字。行ごとに 1 つの <text> にする。画面で 1 文字ずつ位置を測り、折り返した行を分ける */
function text(node: Text, cs: CSSStyleDeclaration, f: Frame, out: Out): void {
  const data = node.data;
  if (!data.trim()) return;
  const fill = paint(cs.color);
  if (!fill) return;
  const range = document.createRange();
  type Run = { text: string; left: number; right: number; top: number; height: number };
  const runs: Run[] = [];
  let i = 0;
  for (const ch of data) {
    range.setStart(node, i);
    range.setEnd(node, i + ch.length);
    i += ch.length;
    const r = range.getClientRects()[0];
    if (!r || (r.width === 0 && /\s/.test(ch))) continue;
    const last = runs.at(-1);
    if (last && Math.abs(r.top - last.top) < r.height / 2 && r.left >= last.right - 1) {
      last.text += ch;
      last.right = r.right;
    } else runs.push({ text: ch, left: r.left, right: r.right, top: r.top, height: r.height });
  }
  const ratio = ascentRatio(cs);
  const family = svgFontFamily(cs.fontFamily);
  const weight = cs.fontWeight !== "400" ? ` font-weight="${cs.fontWeight}"` : "";
  const style = cs.fontStyle !== "normal" ? ` font-style="${cs.fontStyle}"` : "";
  for (const run of runs) {
    const t = run.text.replace(/\s+$/, "");
    if (!t) continue;
    const x = (run.left - f.ox) * f.k;
    const y = (run.top - f.oy) * f.k;
    const w = (run.right - run.left) * f.k;
    const h = run.height * f.k;
    out.cover(x, y, w, h);
    out.push(
      `<text x="${num(x)}" y="${num(y + h * ratio)}" font-family="${esc(family)}" font-size="${num(px(cs.fontSize))}"${weight}${style} ${fill.attr("fill")} textLength="${num(w)}" lengthAdjust="spacingAndGlyphs" xml:space="preserve">${esc(t)}</text>`,
    );
  }
}

// ---- 図の中の SVG（線、弁、雲） ----

/** SVG の図形に写す、見た目のプロパティ */
const SVG_PAINT = ["fill", "stroke"] as const;
const SVG_PROPS = ["stroke-width", "stroke-dasharray", "stroke-dashoffset", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit"] as const;
const SVG_TEXT_PROPS = ["font-size", "font-weight", "font-style", "text-anchor", "dominant-baseline"] as const;
/** 写さない属性（見た目は計算した値で入れ直す） */
const DROP_ATTRS = /^(class|style|id|tabindex|role|aria-.*|data-.*|on.*)$/i;
/** 写さない要素 */
const DROP_TAGS = new Set(["title", "desc", "foreignObject", "script", "style"]);

/** <svg> を、同じ位置に置いた <g> にする（入れ子の <svg> は読めないアプリがあるため） */
function svgRoot(el: SVGSVGElement, f: Frame, out: Out, ids: Ids, defs: string[]): void {
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden" || px(cs.opacity) <= 0) return;
  const r = el.getBoundingClientRect();
  const x = (r.left - f.ox) * f.k;
  const y = (r.top - f.oy) * f.k;
  const parts = x || y ? [`translate(${num(x)} ${num(y)})`] : [];
  const vb = el.viewBox.baseVal;
  if (vb && vb.width > 0 && vb.height > 0 && r.width > 0 && r.height > 0) {
    // viewBox は、真ん中にそろえて縦横の比を保つ（preserveAspectRatio の既定）
    const w = r.width * f.k;
    const h = r.height * f.k;
    const s = Math.min(w / vb.width, h / vb.height);
    const dx = (w - vb.width * s) / 2;
    const dy = (h - vb.height * s) / 2;
    if (dx || dy) parts.push(`translate(${num(dx)} ${num(dy)})`);
    if (Math.abs(s - 1) > 1e-6) parts.push(`scale(${Math.round(s * 10000) / 10000})`);
    if (vb.x || vb.y) parts.push(`translate(${num(-vb.x)} ${num(-vb.y)})`);
  }
  const inner = [...el.childNodes].map((n) => (n instanceof SVGElement ? svgChild(n, f, out, ids, defs, false) : "")).join("");
  if (!inner) return;
  const opacity = px(cs.opacity);
  const attrs = (parts.length ? ` transform="${parts.join(" ")}"` : "") + (opacity < 1 ? ` opacity="${num(opacity)}"` : "");
  out.push(attrs ? `<g${attrs}>${inner}</g>` : inner);
}

/** 既定の値（書かなくても同じなので省く） */
const SVG_DEFAULTS: Record<string, string> = { "stroke-dashoffset": "0", "stroke-linecap": "butt", "stroke-linejoin": "miter", "stroke-miterlimit": "4" };

/**
 * SVG の要素を写した文字列を返す。inDefs は矢じりなどの定義の中（範囲に数えない）。
 * 定義（<defs>）の中身は、SVG の先頭の <defs> にまとめる（defs に足して、ここでは何も返さない）
 */
function svgChild(el: SVGElement, f: Frame, out: Out, ids: Ids, defs: string[], inDefs: boolean): string {
  const tag = el.localName;
  if (DROP_TAGS.has(tag) || el.matches(SKIP)) return "";
  if (tag === "defs") {
    for (const n of el.childNodes) if (n instanceof SVGElement) defs.push(svgChild(n, f, out, ids, defs, true));
    return "";
  }
  const cs = getComputedStyle(el);
  if (!inDefs && (cs.display === "none" || cs.visibility === "hidden")) return "";
  const opacity = px(cs.opacity);
  if (!inDefs && opacity <= 0) return "";

  const attrs: string[] = [];
  // id は、定義（矢じりなど）にだけ残す（線から url(#...) で指す）
  if (el.id && inDefs) attrs.push(`id="${ids.of(el.id)}"`);
  for (const a of el.attributes) {
    if (DROP_ATTRS.test(a.name) || SVG_PAINT.includes(a.name as never) || SVG_PROPS.includes(a.name as never)) continue;
    let v = ids.rewrite(a.value);
    // 線の終わりの矢じりの向き。auto-start-reverse（SVG 2）は読めないアプリがあるので、同じ向きになる auto にする
    if (tag === "marker" && a.name === "orient" && v === "auto-start-reverse") v = "auto";
    attrs.push(`${a.name}="${esc(v)}"`);
  }
  if (tag !== "marker" && tag !== "g") {
    for (const p of SVG_PAINT) {
      const v = cs.getPropertyValue(p);
      const c = v === "none" ? undefined : paint(v);
      attrs.push(c ? c.attr(p) : `${p}="none"`);
    }
    if (cs.getPropertyValue("stroke") !== "none") {
      for (const p of SVG_PROPS) {
        const v = cs.getPropertyValue(p).replace(/px/g, "").replace(/,\s*/g, " ");
        if (!v || v === "none" || v === "normal" || SVG_DEFAULTS[p] === v) continue;
        attrs.push(`${p}="${esc(v)}"`);
      }
    }
  }
  if (opacity < 1) attrs.push(`opacity="${num(opacity)}"`);
  if (tag === "text" || tag === "tspan") {
    attrs.push(`font-family="${esc(svgFontFamily(cs.fontFamily))}"`);
    for (const p of SVG_TEXT_PROPS) {
      const v = cs.getPropertyValue(p);
      if (v && v !== "normal" && v !== "auto" && v !== "start" && !(p === "font-weight" && v === "400")) attrs.push(`${p}="${esc(v.replace(/px$/, ""))}"`);
    }
  }
  if (!inDefs && el instanceof SVGGraphicsElement && tag !== "g") {
    const r = el.getBoundingClientRect();
    out.cover((r.left - f.ox) * f.k, (r.top - f.oy) * f.k, r.width * f.k, r.height * f.k);
  }
  const inner = [...el.childNodes]
    .map((n) => (n instanceof SVGElement ? svgChild(n, f, out, ids, defs, inDefs || tag === "marker") : n instanceof Text ? esc(n.data) : ""))
    .join("");
  if (tag === "g" && !inner) return "";
  return `<${tag}${attrs.length ? " " + attrs.join(" ") : ""}>${inner}</${tag}>`;
}

// ---- 色 ----

interface Paint {
  /** fill="#rrggbb"（透けるなら fill-opacity も） */
  attr(name: string): string;
}

const paintCache = new Map<string, Paint | undefined>();
let colorCtx: CanvasRenderingContext2D | null | undefined;

/**
 * CSS の色を、どのアプリでも読める #rrggbb と不透明度にする。透明なら undefined。
 * color-mix() の結果（color(srgb ...)）などは、ブラウザに 1 点だけ塗らせて読む
 */
function paint(css: string): Paint | undefined {
  if (paintCache.has(css)) return paintCache.get(css);
  let rgba: [number, number, number, number] | undefined;
  const m = css.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    rgba = [Number(m[1]), Number(m[2]), Number(m[3]), a];
  } else if (css && css !== "none" && css !== "transparent") {
    colorCtx ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (colorCtx) {
      colorCtx.clearRect(0, 0, 1, 1);
      colorCtx.fillStyle = "#000";
      colorCtx.fillStyle = css;
      colorCtx.fillRect(0, 0, 1, 1);
      const d = colorCtx.getImageData(0, 0, 1, 1).data;
      rgba = [d[0]!, d[1]!, d[2]!, d[3]! / 255];
    }
  }
  const hex = rgba && rgba[3] > 0 ? "#" + rgba.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("") : undefined;
  const a = rgba?.[3] ?? 0;
  const p = hex ? { attr: (name: string) => `${name}="${hex}"${a < 1 ? ` ${name}-opacity="${num(a)}"` : ""}` } : undefined;
  paintCache.set(css, p);
  return p;
}
