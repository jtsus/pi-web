"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

interface DeploymentState {
  environment: string;
  namespace: string;
  webImage: string | null;
  apiImage: string | null;
  webReady: number;
  apiReady: number;
  updatedAt: string | null;
}

const REFRESH_MS = 15_000;

/** `ghcr.io/jtsus/phone-order-web:abc123` -> `abc123`, so the table stays readable. */
function shortImage(image: string | null): string {
  if (!image) return "—";
  const tag = image.includes("@") ? image.split("@")[1] : image.split(":").pop();
  return (tag ?? image).slice(0, 12);
}

function healthy(state: DeploymentState): boolean {
  return state.webReady > 0 && state.apiReady > 0;
}

/**
 * What is actually running in each environment. Cluster-only: the tab reports
 * live namespaces, not CI history, so a green row means the pods are up with
 * that image right now.
 */
export function DeploymentsPanel({ cwd, active }: { cwd: string | null; active: boolean }) {
  const { t } = useI18n();
  const [environments, setEnvironments] = useState<DeploymentState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<null | { from: string; to: string }>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/deployments", { cache: "no-store" });
      const payload = await response.json() as { environments?: DeploymentState[]; error?: string };
      if (!response.ok) {
        setError(payload.error ?? `HTTP ${response.status}`);
        return;
      }
      setError(null);
      setEnvironments(payload.environments ?? []);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void load();
    const timer = setInterval(() => { void load(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [active, load]);

  const sync = useCallback(async (from: string, to: string) => {
    if (!cwd) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/deployments/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, from, to }),
      });
      const result = await response.json() as { merged?: boolean; sha?: string; error?: string };
      if (result.merged) {
        setNotice(t("deployments.synced", { from, to, sha: (result.sha ?? "").slice(0, 8) }));
        await load();
      } else {
        setNotice(result.error ?? t("deployments.syncFailed"));
      }
    } catch (syncError) {
      setNotice(syncError instanceof Error ? syncError.message : String(syncError));
    } finally {
      setBusy(false);
    }
  }, [cwd, load, t]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)", display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{t("deployments.title")}</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => { void load(); }}
          style={{ fontSize: 11, padding: "3px 9px", borderRadius: 5, border: "1px solid var(--border)", background: "none", color: "var(--text-muted)", cursor: "pointer" }}
        >
          {t("deployments.refresh")}
        </button>
      </div>

      {notice ? (
        <div style={{ padding: "6px 12px", fontSize: 11, color: "var(--text)", background: "var(--bg-panel)", borderBottom: "1px solid var(--border)" }}>{notice}</div>
      ) : null}
      {error ? (
        <div style={{ padding: "6px 12px", fontSize: 11, color: "var(--danger, #d1242f)", borderBottom: "1px solid var(--border)" }}>{error}</div>
      ) : null}

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 12px 20px" }}>
        {loading && environments.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("deployments.loading")}</div>
        ) : null}

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {environments.map((env) => (
            <div key={env.namespace} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "10px 12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: healthy(env) ? "#2ea043" : "#d1242f" }} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>{env.environment}</span>
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{env.namespace}</span>
                <span style={{ flex: 1 }} />
                <a
                  href={env.environment === "staging" ? "https://staging.trykovo.ai" : "https://trykovo.ai"}
                  target="_blank"
                  rel="noreferrer noopener"
                  style={{ fontSize: 11, color: "var(--accent)", textDecoration: "none" }}
                >
                  {t("deployments.open")}
                </a>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 12px", fontSize: 11, color: "var(--text-muted)" }}>
                <span>web</span>
                <span style={{ fontFamily: "var(--font-mono), monospace" }}>
                  {shortImage(env.webImage)} · {env.webReady} ready
                </span>
                <span>api</span>
                <span style={{ fontFamily: "var(--font-mono), monospace" }}>
                  {shortImage(env.apiImage)} · {env.apiReady} ready
                </span>
              </div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          {confirming ? (
            <>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                {t("deployments.syncConfirm", { from: confirming.from, to: confirming.to })}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => { const c = confirming; setConfirming(null); if (c) void sync(c.from, c.to); }}
                style={{ fontSize: 12, padding: "4px 10px", borderRadius: 5, border: "1px solid var(--accent)", background: "var(--accent)", color: "var(--accent-contrast)", cursor: busy ? "wait" : "pointer" }}
              >
                {t("deployments.confirm")}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(null)}
                style={{ fontSize: 12, padding: "4px 10px", borderRadius: 5, border: "1px solid var(--border)", background: "none", color: "var(--text-muted)", cursor: "pointer" }}
              >
                {t("deployments.cancel")}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                disabled={busy || !cwd}
                title={cwd ? undefined : t("deployments.noCwd")}
                onClick={() => setConfirming({ from: "main", to: "staging" })}
                style={{ fontSize: 12, padding: "4px 10px", borderRadius: 5, border: "1px solid var(--border)", background: "none", color: "var(--text)", cursor: busy || !cwd ? "not-allowed" : "pointer", opacity: busy || !cwd ? 0.6 : 1 }}
              >
                {t("deployments.stagingFromMain")}
              </button>
              <button
                type="button"
                disabled={busy || !cwd}
                title={cwd ? undefined : t("deployments.noCwd")}
                onClick={() => setConfirming({ from: "staging", to: "main" })}
                style={{ fontSize: 12, padding: "4px 10px", borderRadius: 5, border: "1px solid var(--border)", background: "none", color: "var(--text)", cursor: busy || !cwd ? "not-allowed" : "pointer", opacity: busy || !cwd ? 0.6 : 1 }}
              >
                {t("deployments.mainFromStaging")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
