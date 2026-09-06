import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  auditWebsite,
  MAXIMUM_FONT_BYTES,
  MAXIMUM_JAVASCRIPT_GZIP_BYTES,
  readWebsiteFiles,
  type WebsiteAudit,
  websiteOrigin,
  websiteRevision,
} from "../scripts/verify-website.js";

const ORIGIN: string = "https://usemurmur.dev";
const PAGE_ROUTES: ReadonlyMap<string, string> = new Map<string, string>([
  ["index.html", "/"],
  ["how-it-works/index.html", "/how-it-works/"],
  ["get-started/index.html", "/get-started/"],
  ["security/index.html", "/security/"],
  ["license/index.html", "/license/"],
  ["404.html", "/404.html"],
]);

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function pageHtml(route: string, body: string = ""): string {
  return `<!doctype html><html lang="en"><head>
    <title>Murmur — shared context for agents</title>
    <meta name="description" content="Durable coordination across coding agents.">
    <link rel="canonical" href="${ORIGIN}${route}">
    <meta property="og:url" content="${ORIGIN}${route}">
    <meta property="og:image" content="${ORIGIN}/social.png">
    ${route === "/404.html" ? '<meta name="robots" content="noindex">' : ""}
    <link rel="stylesheet" href="/assets/site.css">
    </head><body><main id="main"><h1>Independent agents. Shared context.</h1>
    <a href="/get-started/#connect">Connect your agents</a><section id="connect">Setup</section>
    ${body}</main></body></html>`;
}

function completeWebsite(): Map<string, Uint8Array> {
  const files: Map<string, Uint8Array> = new Map<string, Uint8Array>([
    ["robots.txt", bytes(`User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`)],
    ["version.json", bytes(JSON.stringify({ revision: "development" }))],
    [
      "_headers",
      bytes("/*\n  X-Content-Type-Options: nosniff\n  Cache-Control: public, no-transform\n"),
    ],
    ["social.png", new Uint8Array([137, 80, 78, 71])],
    ["assets/site.css", bytes('@font-face{font-family:Demo;src:url("./font.woff2")}')],
    ["assets/font.woff2", new Uint8Array([119, 79, 70, 50])],
    ["assets/app.js", bytes('console.log("sample");')],
  ]);
  for (const [path, route] of PAGE_ROUTES) files.set(path, bytes(pageHtml(route)));
  const urls: string = [...PAGE_ROUTES.values()]
    .filter((route: string): boolean => route !== "/404.html")
    .map((route: string): string => `<url><loc>${ORIGIN}${route}</loc></url>`)
    .join("");
  files.set("sitemap.xml", bytes(`<urlset>${urls}</urlset>`));
  return files;
}

function noisyBytes(length: number): Uint8Array {
  const data: Uint8Array = new Uint8Array(length);
  let seed: number = 123456789;
  for (let index: number = 0; index < data.length; index += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    data[index] = seed >>> 24;
  }
  return data;
}

describe("website artifact verification", (): void => {
  test("accepts complete static pages with working cross-page anchors and CSS assets", async (): Promise<void> => {
    const audit: WebsiteAudit = await auditWebsite(completeWebsite());
    expect(audit.errors).toEqual([]);
    expect(audit.pages).toBe(6);
    expect(audit.javascriptGzipBytes).toBeGreaterThan(0);
    expect(audit.fontBytes).toBe(4);
  });

  test("requires the license page even when no navigation link points to it", async (): Promise<void> => {
    const files: Map<string, Uint8Array> = completeWebsite();
    files.delete("license/index.html");
    expect((await auditWebsite(files)).errors).toContain(
      "Missing required page: license/index.html",
    );
  });

  test("checks the component and renderer assets used by Astro React islands", async (): Promise<void> => {
    const files: Map<string, Uint8Array> = completeWebsite();
    files.set("assets/component.js", bytes("export default function Component() {}"));
    files.set("assets/renderer.js", bytes("export default function render() {}"));
    files.set(
      "index.html",
      bytes(
        pageHtml(
          "/",
          '<astro-island component-url="/assets/component.js" renderer-url="/assets/renderer.js"></astro-island>',
        ),
      ),
    );
    expect((await auditWebsite(files)).errors).toEqual([]);
    files.delete("assets/component.js");
    files.delete("assets/renderer.js");
    const audit: WebsiteAudit = await auditWebsite(files);
    expect(audit.errors).toContain("index.html: missing internal target /assets/component.js");
    expect(audit.errors).toContain("index.html: missing internal target /assets/renderer.js");
  });

  test("finds missing required pages, linked assets, CSS fonts, and anchors", async (): Promise<void> => {
    const files: Map<string, Uint8Array> = completeWebsite();
    files.delete("security/index.html");
    files.delete("assets/font.woff2");
    files.set(
      "index.html",
      bytes(
        pageHtml(
          "/",
          // biome-ignore lint/security/noSecrets: Static broken-link HTML exercises missing page assets and fragments.
          '<a href="/get-started/#absent">Broken</a>' +
            '<script src="/assets/missing.js"></script>',
        ),
      ),
    );
    const audit: WebsiteAudit = await auditWebsite(files);
    expect(audit.errors).toContain("Missing required page: security/index.html");
    expect(audit.errors).toContain("assets/site.css: missing internal target /assets/font.woff2");
    expect(audit.errors).toContain("index.html: missing internal target /assets/missing.js");
    expect(audit.errors).toContain("index.html: missing anchor in get-started/index.html");
  });

  test("rejects unusable metadata, duplicate headings, and an indexable error page", async (): Promise<void> => {
    const files: Map<string, Uint8Array> = completeWebsite();
    files.set(
      "index.html",
      bytes(
        pageHtml("/")
          .replace(/<title>[^<]+<\/title>/u, "")
          // biome-ignore lint/security/noSecrets: This is a public HTML attribute in a missing-metadata fixture.
          .replace('name="description"', 'name="other"')
          .replace('rel="canonical"', 'rel="other"')
          .replace("<h1>", "<h1>Extra</h1><h1>"),
      ),
    );
    files.set(
      "404.html",
      bytes(pageHtml("/404.html").replace('content="noindex"', 'content="index"')),
    );
    const audit: WebsiteAudit = await auditWebsite(files);
    expect(audit.errors).toContain("index.html: missing page title");
    expect(audit.errors).toContain("index.html: missing description");
    expect(audit.errors).toContain("index.html: canonical URL does not match its public route");
    expect(audit.errors).toContain("index.html: expected exactly one h1");
    expect(audit.errors).toContain("404.html: the error page must be marked noindex");
  });

  test("validates URL encodings and protocols without contacting external services", async (): Promise<void> => {
    const files: Map<string, Uint8Array> = completeWebsite();
    files.set(
      "index.html",
      bytes(
        pageHtml(
          "/",
          [
            // biome-ignore lint/security/noSecrets: A literal unsafe-scheme fixture contains no credential and is never executed.
            '<a href="javascript:alert(1)">Unsafe</a>',
            '<a href="/%zz">Invalid</a>',
            '<a href="https://external.example/">External</a>',
            '<a href="mailto:support@example.com">Email</a>',
          ].join(""),
        ),
      ),
    );
    const audit: WebsiteAudit = await auditWebsite(files);
    expect(audit.errors).toContain("index.html: unsupported asset or link protocol");
    expect(audit.errors).toContain("index.html: invalid URL encoding");
    expect(audit.errors).toHaveLength(2);
  });

  test("requires sitemap coverage, the public robots reference, and Pages headers", async (): Promise<void> => {
    const files: Map<string, Uint8Array> = completeWebsite();
    files.delete("robots.txt");
    files.delete("_headers");
    files.set("sitemap.xml", bytes(`<urlset><url><loc>${ORIGIN}/</loc></url></urlset>`));
    const audit: WebsiteAudit = await auditWebsite(files);
    expect(audit.errors).toContain("robots.txt must advertise the public sitemap");
    expect(audit.errors).toContain("get-started/index.html: missing from sitemap");
    expect(audit.errors).toContain(
      "Cloudflare _headers must include X-Content-Type-Options: nosniff",
    );
    files.set("robots.txt", bytes(`Sitemap: ${ORIGIN}/sitemap-missing.xml\n`));
    expect((await auditWebsite(files)).errors).toContain(
      "robots.txt must advertise the public sitemap",
    );
  });

  test("rejects headers that permit proxy analytics injection", async (): Promise<void> => {
    const files: Map<string, Uint8Array> = completeWebsite();
    for (const headers of [
      "/*\n  X-Content-Type-Options: nosniff\n",
      "/*\n  X-Content-Type-Options: nosniff\n/_astro/*\n  Cache-Control: public, no-transform\n",
      "/*\n  X-Content-Type-Options: nosniff\n  Cache-Control: public, no-transform-extra\n",
      "/*\n  X-Content-Type-Options: nosniff\n  Cache-Control: public, no-transform\n  ! Cache-Control\n",
      "/*\n  Cache-Control: public\n/*\n  Cache-Control: no-transform\n",
    ]) {
      files.set("_headers", bytes(headers));
      expect((await auditWebsite(files)).errors).toContain(
        "Cloudflare _headers must disable proxy transformations globally with public, no-transform",
      );
    }
    files.set(
      "_headers",
      bytes(
        "# Website privacy\r\n/*\r\n  X-Content-Type-Options: nosniff\r\n  Cache-Control: Public, No-Transform\r\n",
      ),
    );
    expect((await auditWebsite(files)).errors).toHaveLength(0);
  });

  test("accepts an Astro sitemap index and verifies its child sitemap", async (): Promise<void> => {
    const files: Map<string, Uint8Array> = completeWebsite();
    const sitemap: Uint8Array | undefined = files.get("sitemap.xml");
    if (sitemap === undefined) throw new Error("Fixture sitemap is missing");
    files.delete("sitemap.xml");
    files.set("sitemap-0.xml", sitemap);
    files.set(
      "sitemap-index.xml",
      bytes(`<sitemapindex><sitemap><loc>${ORIGIN}/sitemap-0.xml</loc></sitemap></sitemapindex>`),
    );
    files.set("robots.txt", bytes(`Sitemap: ${ORIGIN}/sitemap-index.xml\n`));
    expect((await auditWebsite(files)).errors).toEqual([]);
    files.delete("sitemap-0.xml");
    expect((await auditWebsite(files)).errors).toContain(
      "sitemap-index.xml: missing internal target /sitemap-0.xml",
    );
  });

  test("orphan sitemap files cannot satisfy coverage for an empty advertised index", async (): Promise<void> => {
    const files: Map<string, Uint8Array> = completeWebsite();
    const content: Uint8Array | undefined = files.get("sitemap.xml");
    if (content === undefined) throw new Error("Fixture sitemap is missing");
    files.delete("sitemap.xml");
    files.set("sitemap-orphan.xml", content);
    files.set("sitemap-index.xml", bytes("<sitemapindex></sitemapindex>"));
    files.set("robots.txt", bytes(`Sitemap: ${ORIGIN}/sitemap-index.xml\n`));
    const audit: WebsiteAudit = await auditWebsite(files);
    expect(audit.errors).toContain("index.html: missing from sitemap");
    expect(audit.errors).toContain("license/index.html: missing from sitemap");
  });

  test("follows reachable child sitemaps independently of their filename", async (): Promise<void> => {
    const files: Map<string, Uint8Array> = completeWebsite();
    const content: Uint8Array | undefined = files.get("sitemap.xml");
    if (content === undefined) throw new Error("Fixture sitemap is missing");
    files.delete("sitemap.xml");
    files.set("metadata/pages.xml", content);
    files.set(
      "sitemap-index.xml",
      bytes(
        `<sitemapindex><sitemap><loc>${ORIGIN}/metadata/pages.xml</loc></sitemap></sitemapindex>`,
      ),
    );
    files.set("robots.txt", bytes(`Sitemap: ${ORIGIN}/sitemap-index.xml\n`));
    expect((await auditWebsite(files)).errors).toEqual([]);
  });

  test("rejects cyclic indexes and malformed sitemap XML without external entity resolution", async (): Promise<void> => {
    const files: Map<string, Uint8Array> = completeWebsite();
    files.set(
      "sitemap-index.xml",
      bytes(
        `<sitemapindex><sitemap><loc>${ORIGIN}/sitemap-index.xml</loc></sitemap></sitemapindex>`,
      ),
    );
    files.set("robots.txt", bytes(`Sitemap: ${ORIGIN}/sitemap-index.xml\n`));
    expect((await auditWebsite(files)).errors).toContain(
      "sitemap-index.xml: cyclic sitemap reference",
    );
    files.delete("sitemap-index.xml");
    files.set("robots.txt", bytes(`Sitemap: ${ORIGIN}/sitemap.xml\n`));
    for (const malformed of [
      `<urlset><url><loc>${ORIGIN}/</loc></sitemap></urlset>`,
      '<!DOCTYPE urlset SYSTEM "https://example.invalid/entity"><urlset></urlset>',
      // biome-ignore lint/security/noSecrets: Static malformed XML exercises entity rejection; it contains no credentials.
      "<urlset><url><loc>&unknown;</loc></url></urlset>",
      `<urlset><url><loc>${ORIGIN}/</loc></url>`,
    ]) {
      files.set("sitemap.xml", bytes(malformed));
      expect((await auditWebsite(files)).errors).toContain(
        "sitemap.xml: malformed or oversized sitemap document",
      );
    }
  });

  test("validates and matches the version marker to the explicitly expected revision", async (): Promise<void> => {
    const files: Map<string, Uint8Array> = completeWebsite();
    const revision: string = "a".repeat(40);
    files.set("version.json", bytes(JSON.stringify({ revision })));
    expect((await auditWebsite(files, websiteOrigin(ORIGIN), revision)).errors).toEqual([]);
    expect((await auditWebsite(files)).errors).toContain(
      "version.json does not match WEBSITE_REVISION",
    );
    files.set("version.json", bytes(JSON.stringify({ revision: "b".repeat(40) })));
    expect((await auditWebsite(files, websiteOrigin(ORIGIN), revision)).errors).toContain(
      "version.json does not match WEBSITE_REVISION",
    );
  });

  test("requires bounded strict version JSON and rejects malformed markers safely", async (): Promise<void> => {
    const files: Map<string, Uint8Array> = completeWebsite();
    files.delete("version.json");
    expect((await auditWebsite(files)).errors).toContain("Missing version.json");
    files.set("version.json", bytes("{"));
    expect((await auditWebsite(files)).errors).toContain(
      "version.json must contain valid UTF-8 JSON",
    );
    files.set("version.json", new Uint8Array([255]));
    expect((await auditWebsite(files)).errors).toContain(
      "version.json must contain valid UTF-8 JSON",
    );
    for (const invalid of [
      null,
      [],
      {},
      { revision: 12 },
      { revision: "short" },
      { revision: "development", extra: true },
    ]) {
      files.set("version.json", bytes(JSON.stringify(invalid)));
      expect((await auditWebsite(files)).errors).toContain(
        "version.json must contain only a valid revision",
      );
    }
    files.set("version.json", bytes(" ".repeat(4097)));
    expect((await auditWebsite(files)).errors).toContain(
      "version.json exceeds the 4 KiB response limit",
    );
  });

  test("validates WEBSITE_REVISION without echoing malformed values", (): void => {
    expect(websiteRevision(undefined)).toBe("development");
    expect(websiteRevision("a".repeat(40))).toBe("a".repeat(40));
    for (const invalid of ["", "main", "a".repeat(39), "A".repeat(40), "a".repeat(41)]) {
      expect((): string => websiteRevision(invalid)).toThrow(
        "WEBSITE_REVISION must be development or a full lowercase Git commit hash",
      );
    }
  });

  test("enforces JavaScript and font budgets, including the font boundary", async (): Promise<void> => {
    const files: Map<string, Uint8Array> = completeWebsite();
    files.set("assets/font.woff2", new Uint8Array(MAXIMUM_FONT_BYTES));
    expect((await auditWebsite(files)).errors).toEqual([]);
    files.set("assets/font.woff2", new Uint8Array(MAXIMUM_FONT_BYTES + 1));
    files.set("assets/app.js", noisyBytes(MAXIMUM_JAVASCRIPT_GZIP_BYTES * 2));
    const audit: WebsiteAudit = await auditWebsite(files);
    expect(audit.errors).toContain("Fonts exceed the 250 KiB asset budget");
    expect(audit.errors).toContain("JavaScript exceeds the 100 KiB gzip budget");
  });

  test("rejects invalid canonical origins without echoing credential material", (): void => {
    const authenticatedOrigin: URL = new URL("https://example.com/");
    authenticatedOrigin.username = "fixture-user";
    authenticatedOrigin.password = "fixture-password";
    expect(websiteOrigin(undefined).origin).toBe(ORIGIN);
    expect(websiteOrigin("https://www.example.com/").origin).toBe("https://www.example.com");
    for (const invalid of [
      "",
      "http://example.com",
      "https://example.com/path",
      "https://example.com/?a=b",
      "https://example.com/#fragment",
      authenticatedOrigin.href,
    ]) {
      expect((): URL => websiteOrigin(invalid)).toThrow("WEBSITE_SITE_URL must be an HTTPS origin");
    }
  });

  test("reads nested build artifacts using portable filesystem paths", (): void => {
    const directory: string = mkdtempSync(join(tmpdir(), "murmur-website-"));
    try {
      mkdirSync(join(directory, "get-started"));
      writeFileSync(join(directory, "get-started", "index.html"), "setup");
      expect(
        new TextDecoder().decode(readWebsiteFiles(directory).get("get-started/index.html")),
      ).toBe("setup");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("rejects oversized artifacts before reading their content", (): void => {
    const directory: string = mkdtempSync(join(tmpdir(), "murmur-website-bounds-"));
    try {
      writeFileSync(join(directory, "oversized.bin"), new Uint8Array(5 * 1024 * 1024 + 1));
      expect((): ReadonlyMap<string, Uint8Array> => readWebsiteFiles(directory)).toThrow(
        "Website build exceeds the bounded artifact census",
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
