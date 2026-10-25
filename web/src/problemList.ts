// 左の欄の「問題」に並べるもの（検証のエラーと警告など）。React に依存しない（テストから直接使う）
import type { Issue, ModelResponse } from "../../src/viewer/api.js";

export interface Problem {
  level: "error" | "warning";
  issue: Issue;
}

/** 「問題」の一覧。エラーを先に、警告をあとに並べる */
export function listProblems(data: ModelResponse): Problem[] {
  return [
    ...data.validation.errors.map((issue) => ({ level: "error" as const, issue })),
    ...(data.run_error ? (data.run_error.issues.length ? data.run_error.issues : [{ message: data.run_error.message }]) : []).map((issue) => ({
      level: "error" as const,
      issue,
    })),
    ...data.validation.warnings.map((issue) => ({ level: "warning" as const, issue })),
    ...(data.actual?.issues ?? []).map((issue) => ({ level: "warning" as const, issue })),
  ];
}

/** エラーと警告の件数 */
export function countProblems(problems: Problem[]): { errors: number; warnings: number } {
  const errors = problems.filter((p) => p.level === "error").length;
  return { errors, warnings: problems.length - errors };
}

/** 帯（幅 28px）に出す件数。100 以上は「99+」に丸める（はみ出さないように） */
export function stripCount(n: number): string {
  return n > 99 ? "99+" : String(n);
}

/** 件数の言い方（例：「エラー 2 件、警告 1 件」）。どちらもなければ空 */
export function describeProblemCount({ errors, warnings }: { errors: number; warnings: number }): string {
  return [errors ? `エラー ${errors} 件` : "", warnings ? `警告 ${warnings} 件` : ""].filter(Boolean).join("、");
}
