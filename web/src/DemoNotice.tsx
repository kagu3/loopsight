// デモサイト（npm run build:demo）だけに出す説明。変更は保存されないことと、本来の使い方、入れ方とソースへのリンク

/** ソース（GitHub）。AGPL のため、デモからもソースへたどれるようにする */
export const SOURCE_URL = "https://github.com/kagu3/loopsight";
/** npm で入れる手順 */
export const INSTALL_URL = "https://github.com/kagu3/loopsight/blob/main/docs/getting-started.md";

export function DemoNotice() {
  return (
    <section className="panel demo-notice" aria-label="デモについて">
      <p>
        <strong>これはデモです。</strong>変更は保存されません（ページを読み直すと元の sample に戻ります）。
      </p>
      <p className="muted">
        本来は、AI（Claude など）がモデルを作り、人はこの画面で図とグラフを見て確かめ、値や式を手直しします。
      </p>
      <p className="demo-links">
        <a href={INSTALL_URL} target="_blank" rel="noreferrer">
          npm で入れる手順
        </a>
        <a href={SOURCE_URL} target="_blank" rel="noreferrer">
          ソース（GitHub）
        </a>
      </p>
    </section>
  );
}
