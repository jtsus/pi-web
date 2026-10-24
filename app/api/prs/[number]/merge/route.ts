import { NextRequest } from "next/server";
import { jsonResponse } from "@/lib/json-response";
import { mergePullRequest, PullRequestRequestError } from "@/lib/pr-server";
import { PULL_REQUEST_MERGE_METHODS, type PullRequestMergeMethod } from "@/lib/pr-types";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

interface RouteContext {
  params: Promise<{ number: string }>;
}

/**
 * POST /api/prs/[number]/merge  { repo, method? }
 *
 * Merging rewrites the remote branch, so it gets the same origin and content-type
 * checks as the other writing routes in this app.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  if (!isApiRequestAllowed(request)) {
    return jsonResponse(request, { error: "Forbidden" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return jsonResponse(request, { error: "Content-Type must be application/json" }, { status: 415 });
  }

  const { number: rawNumber } = await context.params;
  const number = Number(rawNumber);
  if (!Number.isInteger(number) || number <= 0) {
    return jsonResponse(request, { error: "Pull request number must be a positive integer" }, { status: 400 });
  }

  let body: { repo?: unknown; method?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, { error: "Invalid JSON body" }, { status: 400 });
  }

  const repo = typeof body.repo === "string" ? body.repo.trim() : "";
  if (!repo) return jsonResponse(request, { error: "repo is required" }, { status: 400 });

  const requested = typeof body.method === "string" ? body.method : "squash";
  const method: PullRequestMergeMethod = PULL_REQUEST_MERGE_METHODS.includes(requested as PullRequestMergeMethod)
    ? requested as PullRequestMergeMethod
    : "squash";

  try {
    const result = await mergePullRequest({ repo, number, method });
    return jsonResponse(request, result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PullRequestRequestError) {
      return jsonResponse(request, { error: error.message, code: error.code }, { status: error.status });
    }
    const status = typeof error === "object" && error && "status" in error
      ? Number((error as { status: unknown }).status)
      : 500;
    return jsonResponse(
      request,
      { error: error instanceof Error ? error.message : String(error) },
      { status: status >= 400 && status < 600 ? status : 500 },
    );
  }
}
