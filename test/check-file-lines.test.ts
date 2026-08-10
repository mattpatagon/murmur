import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  auditFileLines,
  countFileLines,
  type FileCandidate,
  type FileLineAudit,
  type OversizedFileException,
} from "../scripts/check-file-lines.js";

function candidate(path: string, content: string): FileCandidate {
  return { content: Buffer.from(content, "utf8"), path };
}

test("counts empty, unterminated, CRLF, and trailing-newline files", (): void => {
  expect(countFileLines("")).toBe(0);
  expect(countFileLines("one")).toBe(1);
  expect(countFileLines("one\ntwo\n")).toBe(2);
  expect(countFileLines("one\r\ntwo\r\n")).toBe(2);
});

test("accepts exactly five hundred lines and rejects five hundred one", (): void => {
  const accepted: FileCandidate = candidate("accepted.ts", "line\n".repeat(500));
  const rejected: FileCandidate = candidate("rejected.ts", "line\n".repeat(501));
  const audit: FileLineAudit = auditFileLines([accepted, rejected], new Map());
  expect(audit.checkedTextFiles).toBe(2);
  expect(audit.errors).toEqual([
    "rejected.ts has 501 lines; authored text files may contain at most 500",
  ]);
});

test("ignores binary files without creating a file-size bypass for text", (): void => {
  const binary: FileCandidate = {
    content: Uint8Array.from([137, 80, 78, 71, 0, 255]),
    path: "asset.png",
  };
  const audit: FileLineAudit = auditFileLines([binary], new Map());
  expect(audit).toEqual({ checkedTextFiles: 0, errors: [], pinnedExceptions: 0 });
});

test("accepts an oversized file only when its path and hash are pinned", (): void => {
  const file: FileCandidate = candidate("migration.sql", "select 1;\n".repeat(501));
  const hash: string = createHash("sha256").update(file.content).digest("hex");
  const exceptions: ReadonlyMap<string, OversizedFileException> = new Map([
    ["migration.sql", { reason: "already applied", sha256: hash }],
  ]);
  const audit: FileLineAudit = auditFileLines([file], exceptions);
  expect(audit.errors).toEqual([]);
  expect(audit.pinnedExceptions).toBe(1);
});

test("rejects changed or missing pinned exceptions", (): void => {
  const file: FileCandidate = candidate("migration.sql", "select 2;\n".repeat(501));
  const exceptions: ReadonlyMap<string, OversizedFileException> = new Map([
    ["migration.sql", { reason: "already applied", sha256: "0".repeat(64) }],
    ["missing.sql", { reason: "already applied", sha256: "1".repeat(64) }],
  ]);
  const audit: FileLineAudit = auditFileLines([file], exceptions);
  expect(audit.errors).toHaveLength(2);
  expect(audit.errors[0]).toContain("no longer matches its pinned SHA-256");
  expect(audit.errors[1]).toContain("missing.sql");
});
