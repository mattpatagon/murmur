#!/usr/bin/env bun

import process from "node:process";

import { TenantId } from "../src/domain/value-objects.js";

const FAILURE_MESSAGE: string = "Cannot select a distinct verification tenant";

export function selectVerificationTenant(
  encryptedTenant: unknown,
  foundingTenant: unknown,
  secondaryTenant: unknown,
): string {
  const target: string = TenantId.parse(encryptedTenant).value.toLowerCase();
  const founding: string = TenantId.parse(foundingTenant).value.toLowerCase();
  const secondary: string = TenantId.parse(secondaryTenant).value.toLowerCase();
  if (founding !== target) return founding;
  if (secondary !== target) return secondary;
  throw new Error(FAILURE_MESSAGE);
}

function main(): void {
  if (process.argv.length !== 5) throw new Error(FAILURE_MESSAGE);
  const tenant: string = selectVerificationTenant(
    process.argv[2],
    process.argv[3],
    process.argv[4],
  );
  process.stdout.write(`${tenant}\n`);
}

if (import.meta.main) {
  try {
    main();
  } catch (_error: unknown) {
    process.stderr.write(`${FAILURE_MESSAGE}\n`);
    process.exitCode = 1;
  }
}
