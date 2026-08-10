const DATABASE_URL_CREDENTIALS: RegExp = /(postgres(?:ql)?:\/\/)[^\s/@]*@/giu;
const MURMUR_CREDENTIAL: RegExp =
  /(?<![A-Za-z0-9_-])(?:mur_(?:(?:op|boot)_)?[A-Za-z0-9_-]{8,32}_[A-Za-z0-9_-]{43}|[a-f0-9]{64})(?![A-Za-z0-9_-])/gu;

export function redactSensitiveText(value: string): string {
  return value
    .replace(DATABASE_URL_CREDENTIALS, "$1[redacted]@")
    .replace(MURMUR_CREDENTIAL, "[redacted-token]");
}
