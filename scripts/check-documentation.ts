import process from "node:process";
import { posix } from "node:path";

import { z } from "zod";

import { repositoryFileCandidates, type FileCandidate } from "./check-file-lines.js";

const REQUIRED_FILES: readonly string[] = [
  "AGENTS.md",
  "CHANGELOG.md",
  "CLAUDE.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "SUPPORT.md",
  "VERSION",
  ".env.example",
  ".github/CODEOWNERS",
  ".github/pull_request_template.md",
  ".github/ISSUE_TEMPLATE/bug.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/ISSUE_TEMPLATE/feature.yml",
  "docs/architecture.md",
  "docs/hosted-deployment.md",
  "docs/observability.md",
  "docs/operator-recovery.md",
  "docs/platform-support.md",
  "docs/upgrading.md",
];

const PackageVersionSchema: z.ZodObject<{ version: z.ZodString }> = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+\.\d+$/u),
});

function linkTarget(rawTarget: string): string | null {
  if (
    rawTarget.startsWith("#") ||
    rawTarget.startsWith("https://") ||
    rawTarget.startsWith("http://") ||
    rawTarget.startsWith("mailto:")
  ) {
    return null;
  }
  const fragmentIndex: number = rawTarget.indexOf("#");
  const withoutFragment: string =
    fragmentIndex === -1 ? rawTarget : rawTarget.slice(0, fragmentIndex);
  if (withoutFragment === "") return null;
  return withoutFragment;
}

function auditMarkdownLinks(
  path: string,
  contents: string,
  files: ReadonlyMap<string, string>,
  errors: string[],
): void {
  const pattern: RegExp = /\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/gu;
  let match: RegExpExecArray | null = pattern.exec(contents);
  while (match !== null) {
    const rawTarget: string | undefined = match[1];
    if (rawTarget === undefined) throw new Error("The Markdown-link parser lost its target");
    const target: string | null = linkTarget(rawTarget);
    if (target !== null) {
      const resolved: string = posix.normalize(posix.join(posix.dirname(path), target));
      if (resolved.startsWith("../") || resolved === "..") {
        errors.push(`${path} links outside the repository: ${rawTarget}`);
      } else if (!files.has(resolved)) {
        errors.push(`${path} links to missing repository file: ${rawTarget}`);
      }
    }
    match = pattern.exec(contents);
  }
}

export function auditDocumentation(files: ReadonlyMap<string, string>): readonly string[] {
  const errors: string[] = [];
  REQUIRED_FILES.forEach((path: string): void => {
    const contents: string | undefined = files.get(path);
    if (contents === undefined || contents.trim() === "") {
      errors.push(`required repository contract is missing or empty: ${path}`);
    }
  });

  files.forEach((contents: string, path: string): void => {
    if (path.endsWith(".md")) auditMarkdownLinks(path, contents, files, errors);
  });

  const claude: string | undefined = files.get("CLAUDE.md");
  if (claude !== undefined && !claude.includes("@AGENTS.md")) {
    errors.push("CLAUDE.md must import the authoritative AGENTS.md contract");
  }
  const license: string | undefined = files.get("LICENSE");
  if (
    license !== undefined &&
    (!license.startsWith("Elastic License 2.0\n") ||
      !license.includes("https://www.elastic.co/licensing/elastic-license"))
  ) {
    errors.push("LICENSE must contain the canonical Elastic License 2.0 notice and URL");
  }

  const packageJsonText: string | undefined = files.get("package.json");
  const versionText: string | undefined = files.get("VERSION");
  const changelog: string | undefined = files.get("CHANGELOG.md");
  if (packageJsonText !== undefined && versionText !== undefined && changelog !== undefined) {
    let rawManifest: unknown;
    try {
      rawManifest = JSON.parse(packageJsonText);
    } catch (error: unknown) {
      const detail: string = error instanceof Error ? error.message : String(error);
      errors.push(`package.json is not valid JSON: ${detail}`);
      return errors.sort((left: string, right: string): number => left.localeCompare(right));
    }
    const parsed: ReturnType<typeof PackageVersionSchema.safeParse> =
      PackageVersionSchema.safeParse(rawManifest);
    if (!parsed.success) {
      errors.push("package.json version must use Murmur's four-component release format");
    } else {
      const version: string = versionText.trim();
      if (version !== parsed.data.version) {
        errors.push(`VERSION '${version}' does not match package.json '${parsed.data.version}'`);
      }
      if (!changelog.includes(`## [${version}]`) && !changelog.includes("## [Unreleased]")) {
        errors.push(`CHANGELOG.md has no release or Unreleased entry for version ${version}`);
      }
    }
  }

  return errors.sort((left: string, right: string): number => left.localeCompare(right));
}

function documentationFiles(candidates: readonly FileCandidate[]): ReadonlyMap<string, string> {
  const decoder: TextDecoder = new TextDecoder("utf-8", { fatal: true });
  const files: Map<string, string> = new Map<string, string>();
  candidates.forEach((candidate: FileCandidate): void => {
    try {
      files.set(candidate.path, decoder.decode(candidate.content));
    } catch (_error: unknown) {
      if (REQUIRED_FILES.includes(candidate.path) || candidate.path.endsWith(".md")) {
        throw new Error(`Documentation file is not valid UTF-8: ${candidate.path}`);
      }
    }
  });
  return files;
}

function main(): void {
  try {
    const files: ReadonlyMap<string, string> = documentationFiles(repositoryFileCandidates());
    const errors: readonly string[] = auditDocumentation(files);
    if (errors.length > 0) {
      errors.forEach((error: string): void => {
        process.stderr.write(`Documentation policy: ${error}\n`);
      });
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `Documentation policy passed for ${files.size} repository files and local links.\n`,
    );
  } catch (error: unknown) {
    const detail: string = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Documentation policy failed: ${detail}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
