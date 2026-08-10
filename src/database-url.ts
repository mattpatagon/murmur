export class InvalidDatabaseUrlError extends Error {
  public constructor() {
    super("The configured Postgres database URL is invalid");
    this.name = "InvalidDatabaseUrlError";
  }
}

export function parseDatabaseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch (_error: unknown) {
    throw new InvalidDatabaseUrlError();
  }
}
