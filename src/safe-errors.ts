import {
  createOperationalLogger,
  type StructuredLogger,
} from "./observability/structured-logger.js";
import { redactSensitiveText } from "./redaction.js";

let defaultLogger: StructuredLogger | null = null;

function operationalLogger(): StructuredLogger {
  if (defaultLogger === null) defaultLogger = createOperationalLogger();
  return defaultLogger;
}

export function safeErrorMessage(error: unknown): string {
  const message: string = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(message);
}

export function logSafeError(context: string, error: unknown): void {
  const errorMessage: string = safeErrorMessage(error);
  operationalLogger().error("operation.failed", {
    context,
    error_class: error instanceof Error ? error.constructor.name : typeof error,
    error_message: errorMessage,
    message: `${context}: ${errorMessage}`,
  });
}
