import { NextRequest } from "next/server";
import { jsonResponse } from "@/lib/json-response";
import { PullRequestRequestError, syncBranch } from "@/lib/pr-server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

/**
 * POST /api/deployments/sync  { cwd, from, to }
 *
 * Catches one long-lived branch up to another: `from: main, to: staging` syncs
 * staging down from main; `from: staging, to: main` promotes staging to
 * production. Publishing either branch is what triggers the deploy workflow, so
 * this is the only writing endpoint the deployments tab uses.
 */
export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) return jsonResponse(request, { error: "Forbidden" }, { status: 403 });
  if (!hasJsonContentType(request)) {
    return jsonResponse(request, { error: "Content-Type must be application/json" }, { status: 415 });
  }

  let body: { cwd?: unknown; from?: unknown; to?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, { error: "Invalid JSON body" }, { status: 400 });
  }

  const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
  const from = typeof body.from === "string" ? body.from.trim() : "";
  const to = typeof body.to === "string" ? body.to.trim() : "";
  if (!cwd || !from || !to) {
    return jsonResponse(request, { error: "cwd, from and to are required" }, { status: 400 });
  }

  try {
    const result = await syncBranch({ cwd, from, to });
    return jsonResponse(request, result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PullRequestRequestError) {
      return jsonResponse(request, { error: error.message, code: error.code }, { status: error.status });
    }
    return jsonResponse(
      request,
      { error: error instanceof Error ? error.message : String(error) },
      { status: 409 },
    );
  }
}
