import type { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import type { MurmurApplication } from "../mcp/murmur-application.js";

export type RemoteSession = {
  activeResponses: number;
  readonly application: MurmurApplication;
  lastSeenAt: number;
  readonly principalIdentity: string;
  readonly tenantId: string | null;
  readonly tokenId: string | null;
  readonly transport: WebStandardStreamableHTTPServerTransport;
};
