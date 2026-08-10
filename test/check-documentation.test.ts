import { describe, expect, test } from "bun:test";

import { auditDocumentation } from "../scripts/check-documentation.js";

function completeRepository(): Map<string, string> {
  const files: Map<string, string> = new Map<string, string>([
    ["AGENTS.md", "# Agents\n"],
    ["CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n"],
    ["CLAUDE.md", "@AGENTS.md\n"],
    ["CODE_OF_CONDUCT.md", "# Conduct\n"],
    ["CONTRIBUTING.md", "# Contributing\n"],
    ["LICENSE", "Elastic License 2.0\nhttps://www.elastic.co/licensing/elastic-license\n"],
    // biome-ignore lint/security/noSecrets: This is synthetic Markdown, not credential material.
    ["README.md", "# Murmur\n\n[Architecture](docs/architecture.md)\n"],
    ["SECURITY.md", "# Security\n"],
    ["SUPPORT.md", "# Support\n"],
    ["VERSION", "1.2.3.4\n"],
    ["package.json", '{"version":"1.2.3.4"}\n'],
    [".env.example", "MURMUR_DATABASE_URL=\n"],
    [".github/CODEOWNERS", "* @owner\n"],
    [".github/pull_request_template.md", "# Pull request\n"],
    [".github/ISSUE_TEMPLATE/bug.yml", "name: Bug\n"],
    [".github/ISSUE_TEMPLATE/config.yml", "blank_issues_enabled: false\n"],
    [".github/ISSUE_TEMPLATE/feature.yml", "name: Feature\n"],
    ["docs/architecture.md", "# Architecture\n"],
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
    expect(auditDocumentation(completeRepository())).toEqual([]);
  });

  test("rejects missing required contracts and broken repository links", (): void => {
    const files: Map<string, string> = completeRepository();
    files.delete("SECURITY.md");
    files.set("README.md", "[missing](docs/missing.md)\n");
    const errors: readonly string[] = auditDocumentation(files);
    expect(errors).toContain("required repository contract is missing or empty: SECURITY.md");
    expect(errors).toContain("README.md links to missing repository file: docs/missing.md");
  });

  test("rejects version, license, and Claude contract drift", (): void => {
    const files: Map<string, string> = completeRepository();
    files.set("VERSION", "9.9.9.9\n");
    files.set("LICENSE", "MIT\n");
    files.set("CLAUDE.md", "# Claude\n");
    const errors: readonly string[] = auditDocumentation(files);
    expect(errors.some((error: string): boolean => error.startsWith("VERSION"))).toBe(true);
    expect(errors).toContain(
      "LICENSE must contain the canonical Elastic License 2.0 notice and URL",
    );
    expect(errors).toContain("CLAUDE.md must import the authoritative AGENTS.md contract");
  });
});
