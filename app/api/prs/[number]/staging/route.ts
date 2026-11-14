import { NextRequest } from "next/server";
import { jsonResponse } from "@/lib/json-response";
import {
  mergePullRequestToStaging,
  PullRequestRequestError,
  revertPullRequestFromStaging,
} from "@/lib/pr-server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

interface RouteContext {
  params: Promise<{ number: string }>;
}

function fail(request: NextRequest, error: unknown) {
  if (error instanceof PullRequestRequestError) {
    return jsonResponse(request, { error: error.message, code: error.code }, { status: error.status });
  }
  return jsonResponse(
    request,
    { error: error instanceof Error ? error.message : String(error) },
    { status: 409 },
  );
}

async function readBody(request: NextRequest): Promise<{ repo?: string; cwd?: string }> {
  try {
    const body = await request.json() as { repo?: unknown; cwd?: unknown };
    return {
      repo: typeof body.repo === "string" ? body.repo.trim() : undefined,
      cwd: typeof body.cwd === "string" ? body.cwd.trim() : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * POST /api/prs/[number]/staging  { repo, cwd }
 *
 * A real merge commit of the pull request's head into `staging`, pushed from a
 * throwaway worktree so a conflict aborts and leaves staging untouched.
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
  const { repo, cwd } = await readBody(request);
  if (!repo) return jsonResponse(request, { error: "repo is required" }, { status: 400 });
  if (!cwd) return jsonResponse(request, { error: "cwd is required" }, { status: 400 });
  try {
    const result = await mergePullRequestToStaging({ repo, number, cwd });
    return jsonResponse(request, result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return fail(request, error);
  }
}

/** DELETE /api/prs/[number]/staging  { cwd } — revert the recorded staging merge. */
export async function DELETE(request: NextRequest, context: RouteContext) {
  if (!isApiRequestAllowed(request)) return jsonResponse(request, { error: "Forbidden" }, { status: 403 });
  const { number: rawNumber } = await context.params;
  const number = Number(rawNumber);
  if (!Number.isInteger(number) || number <= 0) {
    return jsonResponse(request, { error: "Pull request number must be a positive integer" }, { status: 400 });
  }
  const { repo, cwd } = await readBody(request);
  if (!cwd) return jsonResponse(request, { error: "cwd is required" }, { status: 400 });
  try {
    const result = await revertPullRequestFromStaging({ number, cwd, repo });
    return jsonResponse(request, result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return fail(request, error);
  }
}
