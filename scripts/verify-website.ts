import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { gzipSync } from "node:zlib";

import { z } from "zod";

import { compareText } from "./lib/deterministic-order.js";
import {
  auditWebsiteMarkdown,
  markdownPathForHtml,
  readWebsiteMarkdownSources,
} from "./lib/website-markdown.js";
import { auditWebsiteSitemaps, type SitemapAudit } from "./lib/website-sitemaps.js";

const DEFAULT_ORIGIN: string = "https://usemurmur.dev";
const REQUIRED_PAGES: readonly string[] = [
  "index.html",
  "how-it-works/index.html",
  "get-started/index.html",
  "security/index.html",
  "license/index.html",
  "404.html",
];
const MAXIMUM_FILES: number = 2_000;
const MAXIMUM_FILE_BYTES: number = 5 * 1024 * 1024;
const MAXIMUM_TOTAL_BYTES: number = 50 * 1024 * 1024;
export const MAXIMUM_JAVASCRIPT_GZIP_BYTES: number = 100 * 1024;
export const MAXIMUM_FONT_BYTES: number = 250 * 1024;
const RevisionSchema: z.ZodType<string> = z.union([
  z.literal("development"),
  z.string().regex(/^[a-f0-9]{40}$/u),
]);
const VersionMarkerSchema: z.ZodType<{ readonly revision: string }> = z.strictObject({
  revision: RevisionSchema,
});

type HtmlElement = { getAttribute(name: string): string | null };
type HtmlText = { readonly text: string };
type Reference = { readonly fragment: boolean; readonly value: string };
type Metadata = {
  description: string | null;
  canonical: string | null;
  markdownAlternate: string | null;
  socialUrl: string | null;
  socialImage: string | null;
  robots: string | null;
  language: string | null;
};
type Page = {
  readonly path: string;
  readonly url: URL;
  readonly ids: ReadonlySet<string>;
  readonly references: readonly Reference[];
};

export type WebsiteAudit = {
  readonly errors: readonly string[];
  readonly fontBytes: number;
  readonly javascriptGzipBytes: number;
  readonly pages: number;
};

export function websiteOrigin(value: string | undefined): URL {
  const parsed: z.ZodSafeParseResult<string> = z.url().safeParse(value ?? DEFAULT_ORIGIN);
  if (!parsed.success) throw new Error("WEBSITE_SITE_URL must be an HTTPS origin");
  const url: URL = new URL(parsed.data);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("WEBSITE_SITE_URL must be an HTTPS origin without credentials or a path");
  }
  return url;
}

export function websiteRevision(value: string | undefined): string {
  const result: z.ZodSafeParseResult<string> = RevisionSchema.safeParse(value ?? "development");
  if (!result.success) {
    throw new Error("WEBSITE_REVISION must be development or a full lowercase Git commit hash");
  }
  return result.data;
}

function auditVersionMarker(
  files: ReadonlyMap<string, Uint8Array>,
  revision: string,
): readonly string[] {
  const content: Uint8Array | undefined = files.get("version.json");
  if (content === undefined) return ["Missing version.json"];
  if (content.byteLength > 4096) return ["version.json exceeds the 4 KiB response limit"];
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
  } catch {
    return ["version.json must contain valid UTF-8 JSON"];
  }
  const result: ReturnType<typeof VersionMarkerSchema.safeParse> =
    VersionMarkerSchema.safeParse(value);
  if (!result.success) return ["version.json must contain only a valid revision"];
  return result.data.revision === revision ? [] : ["version.json does not match WEBSITE_REVISION"];
}

function pagePath(path: string): string {
  if (path === "index.html") return "/";
  return `/${path.endsWith("/index.html") ? path.slice(0, -10) : path}`;
}

function readText(files: ReadonlyMap<string, Uint8Array>, path: string): string {
  const bytes: Uint8Array | undefined = files.get(path);
  if (bytes === undefined) return "";
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function inspectPage(
  path: string,
  html: string,
  origin: URL,
  errors: string[],
): Promise<Page> {
  const url: URL = new URL(pagePath(path), origin);
  const ids: Set<string> = new Set<string>();
  const references: Reference[] = [];
  let title: string = "";
  const metadata: Metadata = {
    canonical: null,
    description: null,
    language: null,
    markdownAlternate: null,
    robots: null,
    socialImage: null,
    socialUrl: null,
  };
  let headings: number = 0;
  let mainElements: number = 0;
  const rewriter: HTMLRewriter = new HTMLRewriter()
    .on("html", {
      element(element: HtmlElement): void {
        metadata.language = element.getAttribute("lang");
      },
    })
    .on("title", {
      text(text: HtmlText): void {
        title += text.text;
      },
    })
    .on("h1", {
      element(): void {
        headings += 1;
      },
    })
    .on("main", {
      element(): void {
        mainElements += 1;
      },
    })
    .on("[id]", {
      element(element: HtmlElement): void {
        const id: string | null = element.getAttribute("id");
        if (id !== null) {
          if (ids.has(id)) errors.push(`${path}: duplicate element ID`);
          ids.add(id);
        }
      },
    })
    .on("meta", {
      element(element: HtmlElement): void {
        const name: string | null = element.getAttribute("name");
        const property: string | null = element.getAttribute("property");
        const content: string | null = element.getAttribute("content");
        if (name === "description") metadata.description = content;
        if (name === "robots") metadata.robots = content;
        if (property === "og:url") metadata.socialUrl = content;
        if (property === "og:image") metadata.socialImage = content;
      },
    })
    .on("link", {
      element(element: HtmlElement): void {
        const rel: string | null = element.getAttribute("rel");
        if (rel === "canonical") metadata.canonical = element.getAttribute("href");
        if (rel === "alternate" && element.getAttribute("type") === "text/markdown") {
          metadata.markdownAlternate = element.getAttribute("href");
        }
      },
    });
  for (const attribute of ["href", "src", "poster", "component-url", "renderer-url"]) {
    rewriter.on(`[${attribute}]`, {
      element(element: HtmlElement): void {
        const value: string | null = element.getAttribute(attribute);
        if (value !== null) references.push({ fragment: attribute === "href", value });
      },
    });
  }
  rewriter.on("[srcset]", {
    element(element: HtmlElement): void {
      const value: string | null = element.getAttribute("srcset");
      if (value === null || value.startsWith("data:")) return;
      for (const candidate of value.split(",")) {
        const target: string | undefined = candidate.trim().split(/\s+/u)[0];
        if (target !== undefined && target !== "")
          references.push({ fragment: false, value: target });
      }
    },
  });
  await rewriter.transform(new Response(html)).text();
  if (title.trim() === "") errors.push(`${path}: missing page title`);
  if (metadata.description === null || metadata.description.trim() === "")
    errors.push(`${path}: missing description`);
  if (metadata.language === null || metadata.language.trim() === "")
    errors.push(`${path}: missing document language`);
  if (headings !== 1) errors.push(`${path}: expected exactly one h1`);
  if (mainElements !== 1) errors.push(`${path}: expected exactly one main landmark`);
  if (metadata.canonical !== url.href)
    errors.push(`${path}: canonical URL does not match its public route`);
  const markdownPath: string | null = markdownPathForHtml(path);
  if (
    markdownPath === null ||
    metadata.markdownAlternate !== new URL(`/${markdownPath}`, origin).href
  ) {
    errors.push(`${path}: Markdown alternate does not match its public source route`);
  }
  if (metadata.socialUrl !== url.href)
    errors.push(`${path}: Open Graph URL does not match its public route`);
  if (metadata.socialImage === null || metadata.socialImage === "") {
    errors.push(`${path}: missing Open Graph image`);
  } else {
    references.push({ fragment: false, value: metadata.socialImage });
  }
  if (path === "404.html" && (metadata.robots === null || !metadata.robots.includes("noindex"))) {
    errors.push(`${path}: the error page must be marked noindex`);
  }
  return { ids, path, references, url };
}

function localTarget(
  value: string,
  base: URL,
  files: ReadonlyMap<string, Uint8Array>,
  errors: string[],
  source: string,
): { readonly path: string; readonly hash: string } | null {
  let target: URL;
  try {
    target = new URL(value, base);
  } catch {
    errors.push(`${source}: malformed asset or link URL`);
    return null;
  }
  if (["mailto:", "tel:", "data:"].includes(target.protocol)) return null;
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    errors.push(`${source}: unsupported asset or link protocol`);
    return null;
  }
  if (target.origin !== base.origin) return null;
  let path: string;
  let hash: string;
  try {
    path = decodeURIComponent(target.pathname).slice(1);
    hash = decodeURIComponent(target.hash.slice(1));
  } catch {
    errors.push(`${source}: invalid URL encoding`);
    return null;
  }
  if (!files.has(path)) path = `${path}${path.endsWith("/") || path === "" ? "" : "/"}index.html`;
  if (!files.has(path)) {
    errors.push(`${source}: missing internal target ${target.pathname}`);
    return null;
  }
  return { hash, path };
}

function preventsProxyTransformations(headers: string): boolean {
  let path: string = "";
  let globalRules: number = 0;
  const directives: Set<string> = new Set<string>();
  for (const line of headers.split(/\r?\n/u)) {
    const trimmed: string = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (/^\S/u.test(line)) {
      path = trimmed;
      if (path === "/*") globalRules += 1;
      continue;
    }
    if (path !== "/*") continue;
    if (trimmed.toLowerCase() === "! cache-control") return false;
    const separator: number = trimmed.indexOf(":");
    if (trimmed.slice(0, separator).toLowerCase() !== "cache-control") continue;
    for (const directive of trimmed.slice(separator + 1).split(",")) {
      directives.add(directive.trim().toLowerCase());
    }
  }
  return globalRules === 1 && directives.has("public") && directives.has("no-transform");
}

export async function auditWebsite(
  files: ReadonlyMap<string, Uint8Array>,
  origin: URL = websiteOrigin(undefined),
  expectedRevision: string = "development",
  markdownSources: ReadonlyMap<string, Uint8Array> | null = null,
): Promise<WebsiteAudit> {
  const errors: string[] = [
    ...auditVersionMarker(files, websiteRevision(expectedRevision)),
    ...auditWebsiteMarkdown(files, markdownSources),
  ];
  const pages: Map<string, Page> = new Map<string, Page>();
  let javascriptGzipBytes: number = 0;
  let fontBytes: number = 0;
  for (const required of REQUIRED_PAGES) {
    if (!files.has(required)) errors.push(`Missing required page: ${required}`);
  }
  for (const path of [...files.keys()].sort(compareText)) {
    const content: Uint8Array | undefined = files.get(path);
    if (content === undefined) throw new Error("Website artifact disappeared during its audit");
    if (path.endsWith(".html"))
      pages.set(path, await inspectPage(path, readText(files, path), origin, errors));
    if (path.endsWith(".js") || path.endsWith(".mjs"))
      javascriptGzipBytes += gzipSync(content).byteLength;
    if (/\.(?:woff2?|ttf|otf)$/u.test(path)) fontBytes += content.byteLength;
    if (path.endsWith(".css")) {
      const pattern: RegExp = /url\(\s*["']?([^"')\s]+)["']?\s*\)/gu;
      const css: string = readText(files, path);
      for (const match of css.matchAll(pattern)) {
        const value: string | undefined = match[1];
        if (value !== undefined)
          localTarget(value, new URL(`/${path}`, origin), files, errors, path);
      }
    }
  }
  for (const page of pages.values()) {
    for (const reference of page.references) {
      const target: ReturnType<typeof localTarget> = localTarget(
        reference.value,
        page.url,
        files,
        errors,
        page.path,
      );
      if (target === null || !reference.fragment || target.hash === "") continue;
      const destination: Page | undefined = pages.get(target.path);
      if (destination !== undefined && !destination.ids.has(target.hash))
        errors.push(`${page.path}: missing anchor in ${target.path}`);
    }
  }
  const sitemap: SitemapAudit = auditWebsiteSitemaps(files, origin);
  errors.push(...sitemap.errors);
  for (const page of pages.values()) {
    if (page.path !== "404.html" && !sitemap.urls.has(page.url.href))
      errors.push(`${page.path}: missing from sitemap`);
    if (page.path === "404.html" && sitemap.urls.has(page.url.href))
      errors.push("404.html: the error page must not appear in the sitemap");
  }
  if (!/X-Content-Type-Options:\s*nosniff/iu.test(readText(files, "_headers")))
    errors.push("Cloudflare _headers must include X-Content-Type-Options: nosniff");
  if (!preventsProxyTransformations(readText(files, "_headers")))
    errors.push(
      "Cloudflare _headers must disable proxy transformations globally with public, no-transform",
    );
  if (javascriptGzipBytes > MAXIMUM_JAVASCRIPT_GZIP_BYTES)
    errors.push("JavaScript exceeds the 100 KiB gzip budget");
  if (fontBytes > MAXIMUM_FONT_BYTES) errors.push("Fonts exceed the 250 KiB asset budget");
  return {
    errors: [...new Set<string>(errors)].sort(compareText),
    fontBytes,
    javascriptGzipBytes,
    pages: pages.size,
  };
}

export function readWebsiteFiles(directory: string): ReadonlyMap<string, Uint8Array> {
  const files: Map<string, Uint8Array> = new Map<string, Uint8Array>();
  let totalBytes: number = 0;
  let entries: number = 0;
  function visit(relative: string, depth: number): void {
    if (depth > 64) throw new Error("Website build exceeds the bounded artifact census");
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      entries += 1;
      if (entries > MAXIMUM_FILES)
        throw new Error("Website build exceeds the bounded artifact census");
      const path: string = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error("Website build must not contain symbolic links");
      if (entry.isDirectory()) {
        visit(path, depth + 1);
      } else if (entry.isFile()) {
        const size: number = statSync(join(directory, path)).size;
        totalBytes += size;
        if (
          size > MAXIMUM_FILE_BYTES ||
          totalBytes > MAXIMUM_TOTAL_BYTES ||
          files.size >= MAXIMUM_FILES
        )
          throw new Error("Website build exceeds the bounded artifact census");
        files.set(path, readFileSync(join(directory, path)));
      }
    }
  }
  visit("", 0);
  return files;
}

async function main(): Promise<void> {
  try {
    const audit: WebsiteAudit = await auditWebsite(
      readWebsiteFiles(join(process.cwd(), "website", "dist")),
      websiteOrigin(process.env["WEBSITE_SITE_URL"]),
      websiteRevision(process.env["WEBSITE_REVISION"]),
      readWebsiteMarkdownSources(join(process.cwd(), "website", "src", "pages")),
    );
    if (audit.errors.length > 0) {
      for (const error of audit.errors) process.stderr.write(`Website verification: ${error}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `Website verified: ${audit.pages} pages, ${audit.javascriptGzipBytes} gzip JavaScript bytes, ${audit.fontBytes} font bytes.\n`,
    );
  } catch {
    process.stderr.write(
      "Website verification failed: build the site and check WEBSITE_SITE_URL, WEBSITE_REVISION, and the artifact bounds.\n",
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
