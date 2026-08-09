import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";

import { parseDatabaseUrl } from "./database-url.js";

export type PostgresTlsConfiguration =
  | { readonly mode: "insecure" }
  | { readonly mode: "verify-system" }
  | { readonly certificateAuthority: string; readonly mode: "verify-full" };

export type PostgresSslOptions =
  | false
  | {
      readonly ca?: string;
      readonly rejectUnauthorized: true;
      readonly servername?: string;
    };

export function postgresTlsConfiguration(environment: NodeJS.ProcessEnv): PostgresTlsConfiguration {
  const certificatePath: string | undefined = environment["MURMUR_DATABASE_CA_PATH"];
  const insecureValue: string | undefined = environment["MURMUR_DATABASE_TLS_INSECURE"];
  if (
    insecureValue !== undefined &&
    insecureValue !== "" &&
    insecureValue !== "0" &&
    insecureValue !== "1"
  ) {
    throw new Error("MURMUR_DATABASE_TLS_INSECURE must be 0 or 1");
  }
  if (insecureValue === "1") {
    if (certificatePath !== undefined && certificatePath !== "") {
      throw new Error("MURMUR_DATABASE_CA_PATH cannot be combined with insecure database TLS");
    }
    return { mode: "insecure" };
  }
  return certificatePath === undefined || certificatePath === ""
    ? { mode: "verify-system" }
    : {
        certificateAuthority: readFileSync(resolve(certificatePath), "utf8"),
        mode: "verify-full",
      };
}

export function postgresSslOptions(
  databaseUrl: string,
  configuration: PostgresTlsConfiguration,
): PostgresSslOptions {
  if (configuration.mode === "insecure") return false;
  const url: URL = parseDatabaseUrl(databaseUrl);
  const hostname: string = url.hostname.replace(/^\[|\]$/gu, "");
  return {
    ...(configuration.mode === "verify-full" ? { ca: configuration.certificateAuthority } : {}),
    rejectUnauthorized: true,
    ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
  };
}
