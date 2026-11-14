import { NextRequest } from "next/server";
import { jsonResponse } from "@/lib/json-response";
import { listDeployments } from "@/lib/pr-server";
import { isApiRequestAllowed } from "@/lib/request-security";

/**
 * GET /api/deployments
 *
 * What is actually running in each environment, read from the cluster: image
 * SHA and ready replicas per namespace. Read-only by design — the deployment tab
 * never mutates a cluster.
 */
export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) return jsonResponse(request, { error: "Forbidden" }, { status: 403 });
  try {
    const environments = await listDeployments();
    return jsonResponse(request, { environments }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonResponse(
      request,
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
