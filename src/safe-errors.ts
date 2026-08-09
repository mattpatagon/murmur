const DATABASE_URL_CREDENTIALS: RegExp = /(postgres(?:ql)?:\/\/)[^\s/@]*@/giu;

export function safeErrorMessage(error: unknown): string {
  const message: string = error instanceof Error ? error.message : String(error);
  return message.replace(DATABASE_URL_CREDENTIALS, "$1[redacted]@");
}

export function logSafeError(context: string, error: unknown): void {
  console.error(`${context}: ${safeErrorMessage(error)}`);
}
