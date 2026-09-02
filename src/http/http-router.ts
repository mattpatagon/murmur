import type { MurmurReleaseMetadata } from "../domain/upgrade-contracts.js";
import type {
  HttpObservability,
  RequestObservation,
} from "../observability/request-observation.js";
import { logSafeError } from "../safe-errors.js";
import { isConnectorOAuthPath } from "./connector-oauth.js";
import { HEALTH_PATH, MCP_PATH, RELEASE_PATH, TENANT_REGISTRATION_PATH } from "./http-config.js";
import { jsonResponse } from "./http-request.js";

export type McpRequestHandler = (
  request: Request,
  observation: RequestObservation,
) => Promise<Response>;

export function createHttpRequestHandler(
  observability: HttpObservability,
  handleMcpRequest: McpRequestHandler,
  handleTenantRegistration: McpRequestHandler | null = null,
  releaseMetadata: MurmurReleaseMetadata | null = null,
  handleConnectorOAuth: McpRequestHandler | null = null,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const observation: RequestObservation = observability.observe(request);
    let response: Response;
    try {
      const url: URL = new URL(request.url);
      if (url.pathname === "/" || url.pathname === HEALTH_PATH) {
        if (request.method !== "GET") {
          response = new Response(null, {
            headers: { allow: "GET" },
            status: 405,
          });
        } else {
          response = jsonResponse(200, { service: "murmur", status: "ok" });
        }
      } else if (url.pathname === RELEASE_PATH) {
        if (request.method !== "GET") {
          response = new Response(null, { headers: { allow: "GET" }, status: 405 });
        } else {
          response =
            releaseMetadata === null
              ? jsonResponse(503, { error: "Release metadata unavailable" })
              : jsonResponse(200, {
                  revision: releaseMetadata.revision,
                  version: releaseMetadata.version,
                });
        }
      } else if (url.pathname === TENANT_REGISTRATION_PATH) {
        response =
          handleTenantRegistration === null
            ? jsonResponse(404, { error: "Not found" })
            : await handleTenantRegistration(request, observation);
      } else if (isConnectorOAuthPath(url.pathname)) {
        response =
          handleConnectorOAuth === null
            ? jsonResponse(404, { error: "Not found" })
            : await handleConnectorOAuth(request, observation);
      } else if (url.pathname !== MCP_PATH) {
        response = jsonResponse(404, { error: "Not found" });
      } else {
        response = await handleMcpRequest(request, observation);
      }
    } catch (error: unknown) {
      observation.recordError(error);
      logSafeError("Murmur HTTP request failed", error);
      response = jsonResponse(500, { error: "Internal server error" });
    }
    return observation.track(response);
  };
}
