import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  fetchAccessAudit,
  subscribeAccessAudit,
  type AccessAuditEntry,
  type AccessAuditSnapshot,
} from "../audit-api";
import "./access-audit.css";

const operationLabels: Record<AccessAuditEntry["operation"], string> = {
  "auth.local": "ローカル認証",
  "auth.device": "リモート端末認証",
  "auth.logout": "リモート端末ログアウト",
  "audit.read": "監査ログ閲覧",
};

const outcomeLabels: Record<AccessAuditEntry["outcome"], string> = {
  allowed: "許可",
  denied: "拒否",
  rate_limited: "制限中",
};

const timeFormatter = new Intl.DateTimeFormat("ja-JP", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function AccessAudit() {
  const [snapshot, setSnapshot] = useState<AccessAuditSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const reload = useCallback(async (showLoading = true) => {
    const currentGeneration = ++generation.current;
    if (showLoading) setLoading(true);
    try {
      const next = await fetchAccessAudit();
      if (generation.current !== currentGeneration) return;
      setSnapshot(next);
      setError(null);
    } catch {
      if (generation.current === currentGeneration) setError("監査ログを取得できませんでした。接続を確認して再読込してください。");
    } finally {
      if (generation.current === currentGeneration) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const unsubscribe = subscribeAccessAudit(() => void reload(false));
    return () => {
      generation.current += 1;
      unsubscribe();
    };
  }, [reload]);

  const current = snapshot?.currentAccess;
  const accessMode = current?.local === false ? "REMOTE" : current?.local === true ? "LOCAL" : "OWNER";

  return (
    <section class="access-audit" aria-labelledby="access-audit-title" aria-busy={loading}>
      <header class="access-audit__gate">
        <div class={`access-audit__signal is-${accessMode.toLowerCase()}`} aria-hidden="true"><span /></div>
        <div class="access-audit__title">
          <p>ACCESS DESK / OWNER ONLY</p>
          <h2 id="access-audit-title">Remote access &amp; audit</h2>
        </div>
        <div class="access-audit__current">
          <span>SESSION · {accessMode}</span>
          <strong>{current?.deviceName ?? "確認中"}</strong>
          <small>{current === null || current === undefined ? "所有者セッションを確認しています" : current.local ? "この端末から安全に接続中" : "認証済みリモート端末から接続中"}</small>
        </div>
        <button type="button" onClick={() => void reload()} disabled={loading}>{loading ? "読込中" : "再読込"}</button>
      </header>

      <div class="access-audit__rail">
        <div class="access-audit__rail-head" aria-hidden="true">
          <span>TIME</span><span>DEVICE</span><span>OPERATION</span><span>RESULT</span>
        </div>
        {error !== null ? (
          <div class="access-audit__message is-error" role="alert"><b>ACCESS LOG OFFLINE</b><span>{error}</span></div>
        ) : snapshot?.records.length === 0 ? (
          <div class="access-audit__message"><b>NO ACTIVITY</b><span>表示できるアクセス履歴はまだありません。</span></div>
        ) : (
          <ol aria-label="アクセス監査ログ">
            {(snapshot?.records ?? []).map((record, index) => (
              <li key={`${record.occurredAt}-${record.operation}-${index}`}>
                <time dateTime={record.occurredAt}>{formatTime(record.occurredAt)}</time>
                <span class="access-audit__device"><i class={record.local ? "is-local" : "is-remote"} />{record.deviceName ?? (record.local ? "このMac" : "Remote device")}</span>
                <span>{operationLabels[record.operation]}</span>
                <span class={`access-audit__outcome is-${record.outcome}`}>{outcomeLabels[record.outcome]}</span>
              </li>
            ))}
          </ol>
        )}
      </div>

      <footer>端末名・接続元・操作・結果・時刻のみ表示。認証情報はこの画面に保存しません。</footer>
    </section>
  );
}

function formatTime(timestamp: string): string {
  return timeFormatter.format(new Date(timestamp)).replaceAll("/", ".");
}
