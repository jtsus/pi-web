import { NextRequest } from "next/server";
import { jsonResponse } from "@/lib/json-response";
import { closePullRequest, PullRequestRequestError } from "@/lib/pr-server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

interface RouteContext {
  params: Promise<{ number: string }>;
}

/**
 * POST /api/prs/[number]/close  { repo }
 *
 * Closing does not touch git, but it does change remote state, so it keeps the
 * same origin and content-type checks as the merge route.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  if (!isApiRequestAllowed(request)) return jsonResponse(request, { error: "Forbidden" }, { status: 403 });
  if (!hasJsonContentType(request)) {
    return jsonResponse(request, { error: "Content-Type must be application/json" }, { status: 415 });
  }
  const { number: rawNumber } = await context.params;
  const number = Number(rawNumber);
  if (!Number.isInteger(number) || number <= 0) {
    return jsonResponse(request, { error: "Pull request number must be a positive integer" }, { status: 400 });
  }
  let body: { repo?: unknown } = {};
  try { body = await request.json(); } catch { return jsonResponse(request, { error: "Invalid JSON body" }, { status: 400 }); }
  const repo = typeof body.repo === "string" ? body.repo.trim() : "";
  if (!repo) return jsonResponse(request, { error: "repo is required" }, { status: 400 });
  try {
    const result = await closePullRequest({ repo, number });
    return jsonResponse(request, result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PullRequestRequestError) {
      return jsonResponse(request, { error: error.message, code: error.code }, { status: error.status });
    }
    return jsonResponse(
      request,
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
