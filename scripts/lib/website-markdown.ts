import { readFileSync } from "node:fs";
import { join } from "node:path";

export type MarkdownAlternate = {
  readonly htmlPath: string;
  readonly publicRoute: string;
  readonly rawPath: string;
  readonly sourceName: string;
};

export const MARKDOWN_ALTERNATES: readonly MarkdownAlternate[] = [
  {
    htmlPath: "index.html",
    publicRoute: "/",
    rawPath: "index.md",
    sourceName: "index.md",
  },
  {
    htmlPath: "how-it-works.html",
    publicRoute: "/how-it-works",
    rawPath: "how-it-works.md",
    sourceName: "how-it-works.md",
  },
  {
    htmlPath: "get-started.html",
    publicRoute: "/get-started",
    rawPath: "get-started.md",
    sourceName: "get-started.md",
  },
  {
    htmlPath: "security.html",
    publicRoute: "/security",
    rawPath: "security.md",
    sourceName: "security.md",
  },
  {
    htmlPath: "license.html",
    publicRoute: "/license",
    rawPath: "license.md",
    sourceName: "license.md",
  },
  {
    htmlPath: "404.html",
    publicRoute: "/404.html",
    rawPath: "404.html.md",
    sourceName: "404.md",
  },
];

const MAXIMUM_MARKDOWN_BYTES: number = 512 * 1024;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index: number = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function hasMarkdownHeaders(headers: string): boolean {
  let path: string = "";
  let contentType: boolean = false;
  let noindex: boolean = false;
  for (const line of headers.split(/\r?\n/u)) {
    const trimmed: string = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (/^\S/u.test(line)) {
      path = trimmed;
      continue;
    }
    if (path !== "/*.md") continue;
    const normalized: string = trimmed.toLowerCase();
    if (normalized === "content-type: text/markdown; charset=utf-8") contentType = true;
    if (normalized === "x-robots-tag: noindex") noindex = true;
  }
  return contentType && noindex;
}

export function markdownPathForHtml(htmlPath: string): string | null {
  for (const alternate of MARKDOWN_ALTERNATES) {
    if (alternate.htmlPath === htmlPath) return alternate.rawPath;
  }
  return null;
}

export function publicRouteForHtml(htmlPath: string): string | null {
  for (const alternate of MARKDOWN_ALTERNATES) {
    if (alternate.htmlPath === htmlPath) return alternate.publicRoute;
  }
  return null;
}

export function websiteArtifactPath(
  publicPath: string,
  files: ReadonlyMap<string, Uint8Array>,
): string | null {
  if (files.has(publicPath)) return publicPath;
  const htmlPath: string = publicPath === "" ? "index.html" : `${publicPath}.html`;
  return files.has(htmlPath) ? htmlPath : null;
}

export function readWebsiteMarkdownSources(directory: string): ReadonlyMap<string, Uint8Array> {
  const sources: Map<string, Uint8Array> = new Map<string, Uint8Array>();
  for (const alternate of MARKDOWN_ALTERNATES) {
    sources.set(alternate.rawPath, readFileSync(join(directory, alternate.sourceName)));
  }
  return sources;
}

export function auditWebsiteMarkdown(
  files: ReadonlyMap<string, Uint8Array>,
  sources: ReadonlyMap<string, Uint8Array> | null = null,
): readonly string[] {
  const errors: string[] = [];
  for (const alternate of MARKDOWN_ALTERNATES) {
    const content: Uint8Array | undefined = files.get(alternate.rawPath);
    if (content === undefined) {
      errors.push(`Missing required Markdown source: ${alternate.rawPath}`);
      continue;
    }
    if (content.byteLength > MAXIMUM_MARKDOWN_BYTES) {
      errors.push(`${alternate.rawPath}: Markdown source exceeds the 512 KiB limit`);
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      errors.push(`${alternate.rawPath}: Markdown source must be valid UTF-8`);
      continue;
    }
    if (!text.startsWith("---\n") || !text.includes("\nlayout: ../layouts/Page.astro\n")) {
      errors.push(`${alternate.rawPath}: Markdown source must include the page layout frontmatter`);
    }
    if (!/^# [^#\r\n].*$/mu.test(text)) {
      errors.push(`${alternate.rawPath}: Markdown source must include one level-one heading`);
    }
    if (sources !== null) {
      const source: Uint8Array | undefined = sources.get(alternate.rawPath);
      if (source === undefined || !sameBytes(content, source)) {
        errors.push(`${alternate.rawPath}: published Markdown differs from its authored source`);
      }
    }
  }
  const headers: Uint8Array | undefined = files.get("_headers");
  const headerText: string =
    headers === undefined ? "" : new TextDecoder("utf-8", { fatal: false }).decode(headers);
  if (!hasMarkdownHeaders(headerText)) {
    errors.push(
      "Cloudflare _headers must serve Markdown as text/markdown with an X-Robots-Tag: noindex rule",
    );
  }
  return errors;
}
