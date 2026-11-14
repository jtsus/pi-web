import { NextRequest } from "next/server";
import { getAllowedFileRoots, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { jsonResponse } from "@/lib/json-response";
import { listPullRequests } from "@/lib/pr-server";
import { parsePullRequestScope } from "@/lib/pr-view";

/**
 * GET /api/prs?scope=session|all&session=<id>&cwd=<path>
 *
 * `session` scope needs the chat, `all` only needs the project directory. The
 * cwd travels through the same allowed-roots check as the git and file routes,
 * because it decides which repository we read.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const scope = parsePullRequestScope(params.get("scope")) ?? "session";
  const sessionId = params.get("session")?.trim() || null;
  const rawCwd = params.get("cwd")?.trim() || null;

  const cwd = rawCwd;
  if (cwd) {
    if (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd)) {
      return jsonResponse(request, { error: "cwd must be an absolute path" }, { status: 400 });
    }
    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots)) {
      return jsonResponse(request, { error: "Access denied" }, { status: 403 });
    }
  }

  if (scope === "session" && !sessionId) {
    // A chat with no PRs yet has no session id in the URL either: that is an
    // empty list, not an error the panel should shout about.
    return jsonResponse(request, {
      scope,
      sessionId: null,
      cwd,
      repo: null,
      prs: [],
    });
  }

  const response = await listPullRequests({ sessionId, cwd, scope });
  return jsonResponse(request, response, {
    headers: { "Cache-Control": "no-store" },
  });
}
