import process from "node:process";

import packageMetadata from "../../package.json" with { type: "json" };
import { redactSensitiveText } from "../redaction.js";

export type LogValue = boolean | null | number | string;
export type LogFields = Readonly<Record<string, LogValue>>;

export type LogOutput = {
  error(line: string): void;
  info(line: string): void;
};

type DeploymentContext = {
  readonly commit_sha: string;
  readonly environment: string;
  readonly instance_id: string;
  readonly region: string;
  readonly runtime: string;
  readonly runtime_version: string;
  readonly service: string;
  readonly service_version: string;
};

const SYSTEM_LOG_OUTPUT: LogOutput = {
  error: (line: string): void => {
    console.error(line);
  },
  info: (line: string): void => {
    console.log(line);
  },
};

export class InvalidLogLevelError extends Error {
  public constructor() {
    super("MURMUR_LOG_LEVEL must be 'info' or 'off'");
    this.name = "InvalidLogLevelError";
  }
}

function firstEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  names: readonly string[],
  fallback: string,
): string {
  let index: number = 0;
  while (index < names.length) {
    const name: string | undefined = names[index];
    if (name === undefined) throw new Error("A deployment environment key disappeared");
    const value: string | undefined = environment[name];
    if (value !== undefined && value.length > 0) return value;
    index += 1;
  }
  return fallback;
}

function deploymentContext(environment: NodeJS.ProcessEnv): DeploymentContext {
  return {
    commit_sha: firstEnvironmentValue(environment, ["MURMUR_COMMIT_SHA", "GITHUB_SHA"], "unknown"),
    environment: firstEnvironmentValue(
      environment,
      ["MURMUR_ENVIRONMENT", "NODE_ENV"],
      "development",
    ),
    instance_id: firstEnvironmentValue(environment, ["K_REVISION", "HOSTNAME"], "unknown"),
    region: firstEnvironmentValue(
      environment,
      ["MURMUR_REGION", "CLOUD_RUN_REGION", "GOOGLE_CLOUD_REGION"],
      "unknown",
    ),
    runtime: "bun",
    runtime_version: Bun.version,
    service: "murmur",
    service_version: packageMetadata.version,
  };
}

function loggingEnabled(environment: NodeJS.ProcessEnv): boolean {
  const configured: string | undefined = environment["MURMUR_LOG_LEVEL"];
  if (configured === undefined || configured.length === 0 || configured === "info") return true;
  if (configured === "off") return false;
  throw new InvalidLogLevelError();
}

function redactedRecord(
  record: Readonly<Record<string, LogValue>>,
): Readonly<Record<string, LogValue>> {
  return Object.fromEntries(
    Object.entries(record).map((entry: [string, LogValue]): [string, LogValue] => [
      entry[0],
      typeof entry[1] === "string" ? redactSensitiveText(entry[1]) : entry[1],
    ]),
  );
}

export class StructuredLogger {
  private readonly context: DeploymentContext;
  private readonly enabled: boolean;
  private readonly output: LogOutput;

  public constructor(
    environment: NodeJS.ProcessEnv,
    output: LogOutput = SYSTEM_LOG_OUTPUT,
    enabled: boolean = loggingEnabled(environment),
  ) {
    this.context = deploymentContext(environment);
    this.enabled = enabled;
    this.output = output;
  }

  private emit(severity: "ERROR" | "INFO", event: string, fields: LogFields): void {
    if (!this.enabled) return;
    const record: Readonly<Record<string, LogValue>> = {
      timestamp: new Date().toISOString(),
      severity,
      event,
      message: event,
      ...this.context,
      ...fields,
    };
    const line: string = JSON.stringify(redactedRecord(record));
    if (severity === "ERROR") this.output.error(line);
    else this.output.info(line);
  }

  public error(event: string, fields: LogFields): void {
    this.emit("ERROR", event, fields);
  }

  public info(event: string, fields: LogFields): void {
    this.emit("INFO", event, fields);
  }
}

export function createOperationalLogger(
  environment: NodeJS.ProcessEnv = process.env,
): StructuredLogger {
  const enabled: boolean = environment["MURMUR_LOG_LEVEL"] !== "off";
  return new StructuredLogger(environment, SYSTEM_LOG_OUTPUT, enabled);
}
