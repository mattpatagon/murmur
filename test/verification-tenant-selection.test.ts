import { expect, test } from "bun:test";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { selectVerificationTenant } from "../scripts/select-verification-tenant.js";

const FOUNDING: string = "00000000-0000-4000-8000-000000000001";
const SECONDARY: string = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER: string = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FAILURE: string = "Cannot select a distinct verification tenant\n";
const SCRIPT: string = fileURLToPath(
  new URL("../scripts/select-verification-tenant.ts", import.meta.url),
);

function runSelection(arguments_: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [SCRIPT, ...arguments_], {
    encoding: "utf8",
    timeout: 5_000,
  });
}

test("encrypted owner equal to secondary uses the distinct founding context", (): void => {
  expect(selectVerificationTenant(SECONDARY, FOUNDING, SECONDARY)).toBe(FOUNDING);
});

test("encrypted owner equal to founding uses the distinct secondary context", (): void => {
  expect(selectVerificationTenant(FOUNDING, FOUNDING, SECONDARY)).toBe(SECONDARY);
});

test("encrypted owner outside both candidates prefers founding deterministically", (): void => {
  expect(selectVerificationTenant(OTHER, FOUNDING, SECONDARY)).toBe(FOUNDING);
});

test("UUID case cannot disguise an equal owner and output is canonical lowercase", (): void => {
  expect(selectVerificationTenant(SECONDARY.toUpperCase(), SECONDARY, OTHER.toUpperCase())).toBe(
    OTHER,
  );
  expect((): string =>
    selectVerificationTenant(SECONDARY.toUpperCase(), SECONDARY, SECONDARY.toUpperCase()),
  ).toThrow("Cannot select a distinct verification tenant");
});

test("no distinct candidate fails closed", (): void => {
  expect((): string => selectVerificationTenant(FOUNDING, FOUNDING, FOUNDING)).toThrow(
    "Cannot select a distinct verification tenant",
  );
});

test("every candidate and the encrypted owner must be valid UUID values", (): void => {
  const invalidValues: readonly unknown[] = [undefined, null, 7, "", "not-a-uuid"];
  for (const invalid of invalidValues) {
    expect((): string => selectVerificationTenant(invalid, FOUNDING, SECONDARY)).toThrow();
    expect((): string => selectVerificationTenant(OTHER, invalid, SECONDARY)).toThrow();
    expect((): string => selectVerificationTenant(OTHER, FOUNDING, invalid)).toThrow();
  }
});

test("native CLI prints only the canonical distinct UUID", (): void => {
  const cases: readonly { readonly arguments: readonly string[]; readonly expected: string }[] = [
    { arguments: [SECONDARY, FOUNDING, SECONDARY], expected: FOUNDING },
    { arguments: [FOUNDING, FOUNDING, SECONDARY.toUpperCase()], expected: SECONDARY },
    { arguments: [OTHER, FOUNDING, SECONDARY], expected: FOUNDING },
    {
      arguments: [SECONDARY.toUpperCase(), SECONDARY, OTHER.toUpperCase()],
      expected: OTHER,
    },
  ];
  for (const scenario of cases) {
    const result: SpawnSyncReturns<string> = runSelection(scenario.arguments);
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${scenario.expected}\n`);
    expect(result.stderr).toBe("");
  }
});

test("native CLI rejects invalid arguments without echoing input or emitting a context", (): void => {
  const privateInput: string = "private-invalid-tenant-'";
  const invalidCases: readonly (readonly string[])[] = [
    [],
    [OTHER, FOUNDING],
    [OTHER, FOUNDING, SECONDARY, privateInput],
    [privateInput, FOUNDING, SECONDARY],
    [OTHER, privateInput, SECONDARY],
    [OTHER, FOUNDING, privateInput],
    [FOUNDING, FOUNDING, FOUNDING],
    [SECONDARY.toUpperCase(), SECONDARY, SECONDARY.toUpperCase()],
  ];
  for (const arguments_ of invalidCases) {
    const result: SpawnSyncReturns<string> = runSelection(arguments_);
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(FAILURE);
    expect(result.stderr).not.toContain(privateInput);
  }
});
