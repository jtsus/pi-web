import { NextRequest } from "next/server";
import { jsonResponse } from "@/lib/json-response";
import { PullRequestRequestError, pullRequestDetail } from "@/lib/pr-server";

interface RouteContext {
  params: Promise<{ number: string }>;
}

/** GET /api/prs/[number]?repo=owner/name&session=<id> — overview, files and diffs. */
export async function GET(request: NextRequest, context: RouteContext) {
  const { number: rawNumber } = await context.params;
  const number = Number(rawNumber);
  if (!Number.isInteger(number) || number <= 0) {
    return jsonResponse(request, { error: "Pull request number must be a positive integer" }, { status: 400 });
  }

  const params = request.nextUrl.searchParams;
  const repo = params.get("repo")?.trim() ?? "";
  const sessionId = params.get("session")?.trim() || null;

  try {
    const detail = await pullRequestDetail({ repo, number, sessionId });
    return jsonResponse(request, detail, { headers: { "Cache-Control": "no-store" } });
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
