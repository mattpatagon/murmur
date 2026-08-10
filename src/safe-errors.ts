import {
  createOperationalLogger,
  type StructuredLogger,
} from "./observability/structured-logger.js";
import { redactSensitiveText } from "./redaction.js";

let defaultLogger: StructuredLogger | null = null;
const SAFE_ERROR_CLASS: RegExp = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u;

function operationalLogger(): StructuredLogger {
  if (defaultLogger === null) defaultLogger = createOperationalLogger();
  return defaultLogger;
}

export function safeErrorMessage(error: unknown): string {
  const message: string = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(message);
}

export function logSafeError(context: string, error: unknown): void {
  const candidate: string = error instanceof Error ? error.constructor.name : typeof error;
  const errorClass: string = SAFE_ERROR_CLASS.test(candidate) ? candidate : "Error";
  operationalLogger().error("operation.failed", {
    context,
    error_class: errorClass,
  });
}
