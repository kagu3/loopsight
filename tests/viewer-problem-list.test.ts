import { describe, expect, test } from "vitest";
import type { ModelResponse } from "../src/viewer/api.js";
import { countProblems, describeProblemCount, listProblems, stripCount } from "../web/src/problemList.js";

// 「問題」の一覧に関係するところだけを持つモデルの応答
const response = (over: Partial<ModelResponse>): ModelResponse =>
  ({ validation: { ok: true, errors: [], warnings: [] }, ...over }) as ModelResponse;

describe("左の欄の「問題」の一覧と、たたんだ帯の件数", () => {
  test("検証のエラーと警告、実行のエラー、実際のデータの警告を、エラーを先にして並べる", () => {
    const problems = listProblems(
      response({
        validation: { ok: false, errors: [{ message: "e1" }], warnings: [{ message: "w1" }] },
        run_error: { message: "実行できません", issues: [{ message: "e2" }] },
        actual: { issues: [{ message: "w2" }] } as unknown as ModelResponse["actual"],
      }),
    );
    expect(problems.map((p) => [p.level, p.issue.message])).toEqual([
      ["error", "e1"],
      ["error", "e2"],
      ["warning", "w1"],
      ["warning", "w2"],
    ]);
    expect(countProblems(problems)).toEqual({ errors: 2, warnings: 2 });
  });

  test("実行のエラーに中身の一覧がなければ、そのメッセージを 1 件のエラーとして数える", () => {
    const problems = listProblems(response({ run_error: { message: "実行できません", issues: [] } }));
    expect(problems).toEqual([{ level: "error", issue: { message: "実行できません" } }]);
  });

  test("件数の言い方。問題がなければ空（帯には何も出さない）", () => {
    expect(describeProblemCount({ errors: 2, warnings: 1 })).toBe("エラー 2 件、警告 1 件");
    expect(describeProblemCount({ errors: 0, warnings: 3 })).toBe("警告 3 件");
    expect(describeProblemCount({ errors: 1, warnings: 0 })).toBe("エラー 1 件");
    expect(describeProblemCount(countProblems(listProblems(response({}))))).toBe("");
  });

  test("帯の件数は 100 以上を「99+」に丸める（言い方のほうは実数のまま）", () => {
    expect(stripCount(1)).toBe("1");
    expect(stripCount(99)).toBe("99");
    expect(stripCount(100)).toBe("99+");
    expect(stripCount(1234)).toBe("99+");
    expect(describeProblemCount({ errors: 120, warnings: 0 })).toBe("エラー 120 件");
  });
});
