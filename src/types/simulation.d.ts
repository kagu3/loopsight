// `simulation@9` の package.json が指す型定義（types/api/Model.d.ts）が実在しないため、
// このプロジェクトで使う部分だけを宣言する。
declare module "simulation" {
  export interface Primitive {
    readonly id: string;
    name: string;
  }

  export class Link implements Primitive {
    readonly id: string;
    name: string;
  }

  export class Results {
    timeUnits: string | undefined;
    times(): number[];
    series(primitive: Primitive): unknown[];
    value(primitive: Primitive, time?: number): unknown;
  }

  export class Model {
    name: string;
    simulate(): Results;
    find(selector?: (p: Primitive) => boolean): Primitive[];
  }

  export function loadModelJSON(data: object): Model;
  export function toModelJSON(model: Model): Record<string, unknown>;
}
