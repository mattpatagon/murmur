import type { HostedAuthenticator } from "../hosted/authenticator.js";
import type { HttpObservability } from "../observability/request-observation.js";
import type { MurmurApplication } from "../mcp/murmur-application.js";
import type { TimeSource } from "./http-capacity.js";
import type { HostedApplicationRequest } from "./murmur-application-factory.js";

export type MurmurHttpServer = {
  readonly mcpUrl: URL;
  readonly port: number;
  readonly registrationUrl: URL;
  stop(): Promise<void>;
};

export type HttpServerDependencies = {
  readonly applicationFactory?:
    | ((request: HostedApplicationRequest) => Promise<MurmurApplication>)
    | undefined;
  readonly authenticator?: HostedAuthenticator;
  readonly observability?: HttpObservability;
  readonly timeSource?: TimeSource;
};
