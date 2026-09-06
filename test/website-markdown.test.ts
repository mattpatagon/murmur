import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  auditWebsiteMarkdown,
  MARKDOWN_ALTERNATES,
  markdownPathForHtml,
  publicRouteForHtml,
} from "../scripts/lib/website-markdown.js";

const MARKDOWN_PAGE: string = [
  "---",
  "layout: ../layouts/Page.astro",
  'title: "Murmur"',
  "---",
  "",
  "# Durable coordination",
  "",
].join("\n");
const HEADERS: string = [
  "/*",
  "  X-Content-Type-Options: nosniff",
  "  Cache-Control: public, no-transform",
  "",
  "/*.md",
  "  Content-Type: text/markdown; charset=utf-8",
  "  X-Robots-Tag: noindex",
  "",
].join("\n");

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function markdownArtifacts(): Map<string, Uint8Array> {
  const files: Map<string, Uint8Array> = new Map<string, Uint8Array>([
    ["_headers", bytes(HEADERS)],
  ]);
  for (const alternate of MARKDOWN_ALTERNATES) {
    files.set(alternate.rawPath, bytes(MARKDOWN_PAGE));
  }
  return files;
}

describe("website Markdown publication", (): void => {
  test("uses clean HTML routes whose Markdown source is the literal .md suffix", (): void => {
    expect(publicRouteForHtml("index.html")).toBe("/");
    expect(publicRouteForHtml("how-it-works.html")).toBe("/how-it-works");
    expect(markdownPathForHtml("how-it-works.html")).toBe("how-it-works.md");
    expect(publicRouteForHtml("how-it-works/index.html")).toBeNull();
  });

  test("maps only the bounded HTML page set to Markdown alternates", (): void => {
    expect(markdownPathForHtml("index.html")).toBe("index.md");
    expect(markdownPathForHtml("unregistered.html")).toBeNull();
  });

  test("the Markdown license page contains the canonical repository license", (): void => {
    const page: string = readFileSync(join(process.cwd(), "website/src/pages/license.md"), "utf8");
    const license: string = readFileSync(join(process.cwd(), "LICENSE"), "utf8");
    const fenced: RegExpMatchArray | null = page.match(/```text\n([\s\S]*?)\n```/u);
    const body: string | undefined = fenced === null ? undefined : fenced[1];
    if (body === undefined) throw new Error("Markdown license fence is missing");
    expect(`${body}\n`).toBe(license);
  });

  test("requires bounded, valid UTF-8 Markdown with its publication headers", (): void => {
    const files: Map<string, Uint8Array> = markdownArtifacts();
    files.delete("license.md");
    files.set("security.md", new Uint8Array([255]));
    files.set("_headers", bytes("/*\n  Cache-Control: public, no-transform\n"));
    const errors: readonly string[] = auditWebsiteMarkdown(files);
    expect(errors).toContain("Missing required Markdown source: license.md");
    expect(errors).toContain("security.md: Markdown source must be valid UTF-8");
    expect(errors).toContain(
      "Cloudflare _headers must serve Markdown as text/markdown with an X-Robots-Tag: noindex rule",
    );
  });

  test("requires each published Markdown artifact to match its authored source", (): void => {
    const files: Map<string, Uint8Array> = markdownArtifacts();
    const sources: Map<string, Uint8Array> = new Map<string, Uint8Array>();
    for (const alternate of MARKDOWN_ALTERNATES) {
      sources.set(alternate.rawPath, bytes(MARKDOWN_PAGE));
    }
    expect(auditWebsiteMarkdown(files, sources)).toEqual([]);
    sources.set("index.md", bytes(`${MARKDOWN_PAGE}Changed\n`));
    expect(auditWebsiteMarkdown(files, sources)).toContain(
      "index.md: published Markdown differs from its authored source",
    );
  });

  test("rejects oversized and structurally invalid Markdown artifacts", (): void => {
    const files: Map<string, Uint8Array> = markdownArtifacts();
    files.set("index.md", new Uint8Array(512 * 1024 + 1));
    files.set("how-it-works.md", bytes("---\ntitle: Murmur\n---\n\n# Missing layout\n"));
    files.set(
      "get-started.md",
      bytes("---\nlayout: ../layouts/Page.astro\n---\n\n## Missing level-one heading\n"),
    );
    const errors: readonly string[] = auditWebsiteMarkdown(files);
    expect(errors).toContain("index.md: Markdown source exceeds the 512 KiB limit");
    expect(errors).toContain(
      "how-it-works.md: Markdown source must include the page layout frontmatter",
    );
    expect(errors).toContain("get-started.md: Markdown source must include one level-one heading");
  });

  test("detects same-length corruption and missing authored sources", (): void => {
    const files: Map<string, Uint8Array> = markdownArtifacts();
    const sources: Map<string, Uint8Array> = new Map<string, Uint8Array>();
    for (const alternate of MARKDOWN_ALTERNATES) {
      sources.set(alternate.rawPath, bytes(MARKDOWN_PAGE));
    }
    sources.set("index.md", bytes(MARKDOWN_PAGE.replace("Durable", "Mutable")));
    sources.delete("security.md");
    const errors: readonly string[] = auditWebsiteMarkdown(files, sources);
    expect(errors).toContain("index.md: published Markdown differs from its authored source");
    expect(errors).toContain("security.md: published Markdown differs from its authored source");
  });
});
