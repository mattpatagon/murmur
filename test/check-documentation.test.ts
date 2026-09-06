import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { auditDocumentation } from "../scripts/check-documentation.js";

function completeRepository(): Map<string, string> {
  const files: Map<string, string> = new Map<string, string>([
    ["AGENTS.md", "# Agents\n"],
    ["CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n"],
    ["CLAUDE.md", "@AGENTS.md\n"],
    ["CODE_OF_CONDUCT.md", "# Conduct\n"],
    ["CONTRIBUTING.md", "# Contributing\n"],
    ["LICENSE", readFileSync("LICENSE", "utf8")],
    [
      "README.md",
      // biome-ignore lint/security/noSecrets: This is synthetic Markdown, not credential material.
      "# Murmur\n\n[Architecture](docs/architecture.md)\n\n![Diagram](docs/architecture.png)\n",
    ],
    ["SECURITY.md", "# Security\n"],
    ["SUPPORT.md", "# Support\n"],
    ["VERSION", "1.2.3.4\n"],
    ["package.json", '{"version":"1.2.3.4"}\n'],
    [".env.example", "MURMUR_DATABASE_URL=\n"],
    [".gitattributes", "* text=auto eol=lf\n"],
    [".github/CODEOWNERS", "* @owner\n"],
    [".github/pull_request_template.md", "# Pull request\n"],
    [".github/ISSUE_TEMPLATE/bug.yml", "name: Bug\n"],
    [".github/ISSUE_TEMPLATE/config.yml", "blank_issues_enabled: false\n"],
    [".github/ISSUE_TEMPLATE/feature.yml", "name: Feature\n"],
    ["docs/architecture.md", "# Architecture\n"],
    ["docs/architecture.png", "[binary file]"],
    ["docs/hosted-deployment.md", "# Deployment\n"],
    ["docs/observability.md", "# Observability\n"],
    ["docs/operator-recovery.md", "# Recovery\n"],
    ["docs/platform-support.md", "# Platforms\n"],
    ["docs/upgrading.md", "# Upgrading\n"],
  ]);
  return files;
}

describe("documentation policy", (): void => {
  test("accepts a complete repository contract with valid local links", (): void => {
    const files: Map<string, string> = completeRepository();
    files.set(
      "website/src/pages/index.md",
      // biome-ignore lint/security/noSecrets: Static public-link fixtures contain no credential material.
      "# Website\n\n[Setup](/get-started/)\n\n[Notices](/third-party-notices.txt)\n",
    );
    expect(auditDocumentation(files)).toEqual([]);
  });

  test("rejects missing required contracts and broken repository links", (): void => {
    const files: Map<string, string> = completeRepository();
    files.delete("SECURITY.md");
    files.set("README.md", "[missing](docs/missing.md)\n");
    const errors: readonly string[] = auditDocumentation(files);
    expect(errors).toContain("required repository contract is missing or empty: SECURITY.md");
    expect(errors).toContain("README.md links to missing repository file: docs/missing.md");
  });

  test("rejects an altered MIT grant with its heading and copyright intact", (): void => {
    const files: Map<string, string> = completeRepository();
    const license: string = readFileSync("LICENSE", "utf8");
    files.set("LICENSE", license.replace("free of charge", "for a fee"));
    expect(auditDocumentation(files)).toContain(
      "LICENSE must match the approved MIT license text byte-for-byte",
    );
  });

  test("rejects version, license, and Claude contract drift", (): void => {
    const files: Map<string, string> = completeRepository();
    files.set("VERSION", "9.9.9.9\n");
    files.set("LICENSE", "MIT\n");
    files.set("CLAUDE.md", "# Claude\n");
    const errors: readonly string[] = auditDocumentation(files);
    expect(errors.some((error: string): boolean => error.startsWith("VERSION"))).toBe(true);
    expect(errors).toContain("LICENSE must match the approved MIT license text byte-for-byte");
    expect(errors).toContain("CLAUDE.md must import the authoritative AGENTS.md contract");
  });
});
