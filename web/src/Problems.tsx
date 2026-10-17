import type { ModelResponse } from "../../src/viewer/api.js";
import { listProblems } from "./problemList.js";

// 検証のエラーと警告の一覧。要素の名前を押すと、その要素を選ぶ
export function Problems({ data, onSelect }: { data: ModelResponse; onSelect(name: string): void }) {
  const issues = listProblems(data);
  if (!issues.length) return null;
  return (
    <section className="panel">
      <h2>問題</h2>
      <ul className="issues">
        {issues.map(({ level, issue }, i) => (
          <li key={i} className={level}>
            <span className="issue-level">{level === "error" ? "エラー" : "警告"}</span>
            {issue.element ? (
              <button className="link" onClick={() => onSelect(issue.element!)}>
                {issue.element}
              </button>
            ) : null}
            <span>{issue.message}</span>
            {issue.hint && <span className="muted"> {issue.hint}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
