export function parseDatabaseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch (_error: unknown) {
    throw new Error("The configured Postgres database URL is invalid");
  }
}
