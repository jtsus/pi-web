"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { MarkdownBody } from "./MarkdownBody";
import type {
  PullRequestDetail,
  PullRequestListResponse,
  PullRequestMergeMethod,
  PullRequestScope,
  PullRequestSummary,
} from "@/lib/pr-types";
import {
  PR_SCOPE_AUTO_REFRESH_MS,
  PR_SCOPE_STORAGE_KEY,
  formatDiffStat,
  formatRelativeTime,
  parsePullRequestScope,
} from "@/lib/pr-view";

interface Props {
  sessionId: string | null;
  cwd: string | null;
  /** Only a visible panel polls: a hidden tab must not spend API quota. */
  active: boolean;
}

function readStoredScope(): PullRequestScope {
  if (typeof window === "undefined") return "session";
  try {
    return parsePullRequestScope(window.localStorage.getItem(PR_SCOPE_STORAGE_KEY)) ?? "session";
  } catch {
    return "session";
  }
}

const CHECK_DOT: Record<PullRequestSummary["checks"], string> = {
  passing: "#2ea043",
  failing: "#d1242f",
  pending: "#bf8700",
  none: "var(--text-dim)",
};

function checkTitle(checks: PullRequestSummary["checks"], t: (key: string) => string): string {
  return t(`prs.checks.${checks}`);
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  const parsed = text ? JSON.parse(text) as T & { error?: string } : null;
  if (!response.ok) {
    const message = parsed && typeof parsed === "object" && "error" in parsed && parsed.error
      ? String(parsed.error)
      : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return parsed as T;
}

export function PullRequestRow({
  pr,
  onOpen,
  t,
}: {
  pr: PullRequestSummary;
  onOpen: () => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        width: "100%",
        padding: "10px 12px",
        background: "transparent",
        border: "none",
        borderBottom: "1px solid var(--border)",
        color: "var(--text)",
        textAlign: "left",
        cursor: "pointer",
      }}
      onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
    >
      <span
        title={checkTitle(pr.checks, t)}
        style={{
          width: 8,
          height: 8,
          marginTop: 6,
          borderRadius: 999,
          background: CHECK_DOT[pr.checks],
          flexShrink: 0,
        }}
      />
      <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: 1 }}>
        <span style={{ display: "flex", gap: 6, alignItems: "baseline", minWidth: 0 }}>
          <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>#{pr.number}</span>
          <span
            style={{
              fontSize: 13,
              fontWeight: 500,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {pr.title}
          </span>
          {pr.draft && (
            <span style={{ fontSize: 10, color: "var(--text-dim)", border: "1px solid var(--border)", borderRadius: 4, padding: "0 4px", flexShrink: 0 }}>
              {t("prs.draft")}
            </span>
          )}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {[pr.head && pr.base ? `${pr.head} → ${pr.base}` : pr.head, pr.author, formatRelativeTime(pr.updatedAt)]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
      <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
        {formatDiffStat(pr.additions, pr.deletions)}
      </span>
    </button>
  );
}

export function DiffPatch({ patch }: { patch: string }) {
  return (
    <pre
      style={{
        margin: 0,
        padding: "8px 10px",
        background: "var(--tool-bg)",
        borderTop: "1px solid var(--border)",
        fontSize: 11,
        lineHeight: 1.5,
        overflowX: "auto",
        maxHeight: 320,
        overflowY: "auto",
        fontFamily: "var(--font-mono), ui-monospace, monospace",
      }}
    >
      {patch.split("\n").map((line, index) => (
        <div
          key={index}
          style={{
            color: line.startsWith("+") ? "#2ea043" : line.startsWith("-") ? "#d1242f" : "var(--text-muted)",
            whiteSpace: "pre",
          }}
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

export function PullRequestDetailView({
  detail,
  busy,
  onBack,
  onMerge,
  t,
}: {
  detail: PullRequestDetail;
  busy: boolean;
  onBack: () => void;
  onMerge: (method: PullRequestMergeMethod) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);

  const toggle = (filename: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)", display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
        <button
          type="button"
          onClick={onBack}
          title={t("prs.back")}
          aria-label={t("prs.back")}
          style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 0 }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>#{detail.number}</span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {detail.title}
        </span>
        <a
          href={detail.url}
          target="_blank"
          rel="noreferrer noopener"
          style={{ fontSize: 11, color: "var(--accent)", textDecoration: "none", flexShrink: 0 }}
        >
          {t("prs.openOnGitHub")}
        </a>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 12px 20px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, fontSize: 11, color: "var(--text-muted)", marginBottom: 10 }}>
          <span>{detail.head} → {detail.base}</span>
          <span>{formatDiffStat(detail.additions, detail.deletions)}</span>
          <span>{t("prs.changedFiles", { count: detail.changedFiles ?? detail.files.length })}</span>
          <span style={{ color: CHECK_DOT[detail.checks] }}>{checkTitle(detail.checks, t)}</span>
          {detail.approvals > 0 && <span>{t("prs.approvals", { count: detail.approvals })}</span>}
          {detail.changesRequested > 0 && <span style={{ color: "#d1242f" }}>{t("prs.changesRequested", { count: detail.changesRequested })}</span>}
          {detail.worktree && <span title={detail.worktree}>{t("prs.worktree")}</span>}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          {confirming ? (
            <>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("prs.mergeConfirm")}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => { setConfirming(false); onMerge("squash"); }}
                style={{ fontSize: 12, padding: "4px 10px", borderRadius: 5, border: "1px solid var(--accent)", background: "var(--accent)", color: "var(--accent-contrast)", cursor: busy ? "wait" : "pointer" }}
              >
                {t("prs.mergeSquash")}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                style={{ fontSize: 12, padding: "4px 10px", borderRadius: 5, border: "1px solid var(--border)", background: "none", color: "var(--text-muted)", cursor: "pointer" }}
              >
                {t("prs.cancel")}
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy || detail.mergeable === false}
              onClick={() => setConfirming(true)}
              title={detail.mergeable === false ? t("prs.notMergeable") : t("prs.merge")}
              style={{
                fontSize: 12,
                padding: "4px 12px",
                borderRadius: 5,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "var(--accent-contrast)",
                cursor: busy || detail.mergeable === false ? "not-allowed" : "pointer",
                opacity: busy || detail.mergeable === false ? 0.6 : 1,
              }}
            >
              {busy ? t("prs.merging") : t("prs.merge")}
            </button>
          )}
        </div>

        {detail.body?.trim() ? (
          <div style={{ fontSize: 13, color: "var(--text)", marginBottom: 14 }}>
            <MarkdownBody>{detail.body}</MarkdownBody>
          </div>
        ) : null}

        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.4, margin: "4px 0 6px" }}>
          {t("prs.files", { count: detail.files.length })}
        </div>
        <div style={{ border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
          {detail.files.map((file) => (
            <div key={file.filename} style={{ borderBottom: "1px solid var(--border)" }}>
              <button
                type="button"
                onClick={() => toggle(file.filename)}
                disabled={!file.patch}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  width: "100%",
                  padding: "6px 10px",
                  background: "none",
                  border: "none",
                  color: "var(--text)",
                  fontSize: 12,
                  textAlign: "left",
                  cursor: file.patch ? "pointer" : "default",
                }}
              >
                <span style={{ color: "var(--text-dim)", width: 12, flexShrink: 0 }}>{file.patch ? (expanded.has(file.filename) ? "−" : "+") : ""}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono), ui-monospace, monospace", fontSize: 11 }}>
                  {file.filename}
                </span>
                <span style={{ color: "var(--text-dim)", fontSize: 11, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                  +{file.additions} −{file.deletions}
                </span>
              </button>
              {file.patch && expanded.has(file.filename) ? <DiffPatch patch={file.patch} /> : null}
            </div>
          ))}
        </div>
        {detail.filesTruncated ? (
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 8 }}>{t("prs.diffTruncated")}</div>
        ) : null}
      </div>
    </div>
  );
}

export interface PullRequestListProps {
  prs: PullRequestSummary[];
  scope: PullRequestScope;
  repo: string | null;
  error: string | null;
  loading: boolean;
  notice: string | null;
  onOpen: (pr: PullRequestSummary) => void;
  onScopeChange: (scope: PullRequestScope) => void;
  onRefresh: () => void;
}

/** The list chrome, independent of fetching so it can be rendered in tests. */
export function PullRequestList({
  prs,
  scope,
  repo,
  error,
  loading,
  notice,
  onOpen,
  onScopeChange,
  onRefresh,
}: PullRequestListProps) {
  const { t } = useI18n();

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }} role="tablist" aria-label={t("prs.scopeLabel")}>
          {(["session", "all"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={scope === option}
              onClick={() => onScopeChange(option)}
              style={{
                fontSize: 11,
                padding: "3px 8px",
                border: "none",
                background: scope === option ? "var(--bg-selected)" : "none",
                color: scope === option ? "var(--text)" : "var(--text-muted)",
                cursor: "pointer",
              }}
            >
              {option === "session" ? t("prs.scopeSession") : t("prs.scopeAll")}
            </button>
          ))}
        </div>
        {repo ? (
          <span title={repo} style={{ fontSize: 10, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
            {repo}
          </span>
        ) : <span style={{ flex: 1 }} />}
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          title={t("prs.refresh")}
          aria-label={t("prs.refresh")}
          style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, background: "none", border: "none", color: loading ? "var(--text-dim)" : "var(--text-muted)", cursor: loading ? "wait" : "pointer", padding: 0, flexShrink: 0 }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-3-6.7M21 3v6h-6" />
          </svg>
        </button>
      </div>

      {notice ? (
        <div style={{ padding: "6px 12px", fontSize: 11, color: "var(--text)", background: "var(--bg-panel)", borderBottom: "1px solid var(--border)" }}>
          {notice}
        </div>
      ) : null}
      {error && !prs.length ? (
        <div style={{ padding: "10px 12px", fontSize: 11, color: "var(--text-muted)", lineHeight: 1.6 }}>{error}</div>
      ) : null}

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {prs.map((pr) => (
          <PullRequestRow key={`${pr.repo}#${pr.number}`} pr={pr} onOpen={() => onOpen(pr)} t={t} />
        ))}
        {!prs.length && !error ? (
          <div style={{ padding: "16px 12px", fontSize: 12, color: "var(--text-dim)", lineHeight: 1.7 }}>
            {scope === "session" ? t("prs.emptySession") : t("prs.emptyAll")}
          </div>
        ) : null}
        {loading && !prs.length ? (
          <div style={{ padding: "0 12px 12px", fontSize: 11, color: "var(--text-dim)" }}>{t("prs.loading")}</div>
        ) : null}
      </div>
      <div style={{ padding: "4px 10px", borderTop: "1px solid var(--border)", fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>
        {t("prs.hint")}
      </div>
    </div>
  );
}

export function PullRequestPanel({ sessionId, cwd, active }: Props) {
  const { t } = useI18n();
  const [scope, setScope] = useState<PullRequestScope>(readStoredScope);
  const [data, setData] = useState<PullRequestListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openNumber, setOpenNumber] = useState<number | null>(null);
  const [detail, setDetail] = useState<PullRequestDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [merging, setMerging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    try {
      window.localStorage.setItem(PR_SCOPE_STORAGE_KEY, scope);
    } catch {
      // Private mode: the scope simply does not persist.
    }
  }, [scope]);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    const params = new URLSearchParams({ scope });
    if (sessionId) params.set("session", sessionId);
    if (cwd) params.set("cwd", cwd);
    setLoading(true);
    try {
      const response = await fetch(`/api/prs?${params.toString()}`, { cache: "no-store" });
      const payload = await readJson<PullRequestListResponse>(response);
      if (requestId !== requestIdRef.current) return;
      setData(payload);
      setError(payload.error ? payload.error.message : null);
    } catch (fetchError) {
      if (requestId !== requestIdRef.current) return;
      setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [cwd, scope, sessionId]);

  useEffect(() => {
    if (!active) return;
    void load();
    const timer = setInterval(() => { void load(); }, PR_SCOPE_AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [active, load]);

  // Switching chat or scope invalidates an open detail view.
  useEffect(() => {
    setOpenNumber(null);
    setDetail(null);
    setNotice(null);
  }, [sessionId, scope]);

  const openDetail = useCallback(async (pr: PullRequestSummary) => {
    setOpenNumber(pr.number);
    setDetail(null);
    setNotice(null);
    setDetailLoading(true);
    try {
      const params = new URLSearchParams({ repo: pr.repo });
      if (sessionId) params.set("session", sessionId);
      const response = await fetch(`/api/prs/${pr.number}?${params.toString()}`, { cache: "no-store" });
      setDetail(await readJson<PullRequestDetail>(response));
    } catch (fetchError) {
      setNotice(fetchError instanceof Error ? fetchError.message : String(fetchError));
    } finally {
      setDetailLoading(false);
    }
  }, [sessionId]);

  const merge = useCallback(async (method: PullRequestMergeMethod) => {
    if (!detail) return;
    setMerging(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/prs/${detail.number}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: detail.repo, method }),
      });
      const result = await readJson<{ merged: boolean; message: string }>(response);
      if (result.merged) {
        setNotice(t("prs.merged"));
        setOpenNumber(null);
        setDetail(null);
        await load();
      } else {
        setNotice(result.message || t("prs.mergeFailed"));
      }
    } catch (mergeError) {
      setNotice(mergeError instanceof Error ? mergeError.message : String(mergeError));
    } finally {
      setMerging(false);
    }
  }, [detail, load, t]);

  const prs = useMemo(() => data?.prs ?? [], [data]);

  if (openNumber !== null) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        {notice ? (
          <div style={{ padding: "6px 12px", fontSize: 11, color: "var(--text)", background: "var(--bg-panel)", borderBottom: "1px solid var(--border)" }}>
            {notice}
          </div>
        ) : null}
        {detail ? (
          <PullRequestDetailView
            detail={detail}
            busy={merging}
            onBack={() => { setOpenNumber(null); setDetail(null); setNotice(null); }}
            onMerge={(method) => { void merge(method); }}
            t={t}
          />
        ) : (
          <div style={{ padding: 16, fontSize: 12, color: "var(--text-dim)" }}>
            {detailLoading ? t("prs.loading") : t("prs.loadFailed")}
          </div>
        )}
      </div>
    );
  }

  return (
    <PullRequestList
      prs={prs}
      scope={scope}
      repo={data?.repo ?? null}
      error={error}
      loading={loading}
      notice={notice}
      onOpen={(pr) => { void openDetail(pr); }}
      onScopeChange={setScope}
      onRefresh={() => { void load(); }}
    />
  );
}
