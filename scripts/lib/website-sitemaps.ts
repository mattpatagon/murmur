import { websiteArtifactPath } from "./website-markdown.js";

type SitemapDocument = {
  readonly kind: "urlset" | "sitemapindex";
  readonly locations: readonly string[];
};

export type SitemapAudit = {
  readonly errors: readonly string[];
  readonly urls: ReadonlySet<string>;
};

const MAXIMUM_SITEMAP_FILES: number = 64;
const MAXIMUM_SITEMAP_BYTES: number = 1_048_576;
const MAXIMUM_SITEMAP_LOCATIONS: number = 2_000;
const MAXIMUM_TOTAL_LOCATIONS: number = 10_000;

function decodeXmlText(value: string): string | null {
  if (/&(?!amp;|lt;|gt;|apos;|quot;)/u.test(value)) return null;
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .trim();
}

function parseSitemap(content: Uint8Array): SitemapDocument | null {
  if (content.byteLength > MAXIMUM_SITEMAP_BYTES) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content).trim();
  } catch {
    return null;
  }
  // This generated format permits no DTD, external entity, or executable XML instruction.
  text = text.replace(
    /^<\?xml\s+version=(["'])1\.0\1(?:\s+encoding=(["'])UTF-8\2)?\s*\?>\s*/iu,
    "",
  );
  const root: RegExpMatchArray | null = text.match(
    /^<(urlset|sitemapindex)(?:\s+xmlns=(["'])http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9\2)?\s*>([\s\S]*)<\/\1>$/u,
  );
  if (root === null) return null;
  const kind: string | undefined = root[1];
  const body: string | undefined = root[3];
  if ((kind !== "urlset" && kind !== "sitemapindex") || body === undefined) return null;
  const entries: string = body.trim();
  const pattern: RegExp =
    kind === "urlset"
      ? /\s*<url>\s*<loc>([^<]+)<\/loc>\s*(?:(?:<lastmod>[^<]*<\/lastmod>|<changefreq>[^<]*<\/changefreq>|<priority>[^<]*<\/priority>)\s*)*<\/url>\s*/guy
      : /\s*<sitemap>\s*<loc>([^<]+)<\/loc>\s*(?:<lastmod>[^<]*<\/lastmod>\s*)?<\/sitemap>\s*/guy;
  const locations: string[] = [];
  while (pattern.lastIndex < entries.length) {
    const match: RegExpExecArray | null = pattern.exec(entries);
    if (match === null || locations.length >= MAXIMUM_SITEMAP_LOCATIONS) return null;
    const raw: string | undefined = match[1];
    if (raw === undefined) return null;
    const location: string | null = decodeXmlText(raw);
    if (location === null || location === "") return null;
    locations.push(location);
  }
  return { kind, locations };
}

function sitemapTarget(
  value: string,
  source: string,
  origin: URL,
  files: ReadonlyMap<string, Uint8Array>,
  errors: string[],
): { readonly url: URL; readonly path: string } | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    errors.push(`${source}: malformed sitemap URL`);
    return null;
  }
  if (url.origin !== origin.origin) {
    errors.push(`${source}: sitemap URL has the wrong origin`);
    return null;
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    errors.push(`${source}: sitemap URLs cannot contain credentials, queries, or fragments`);
    return null;
  }
  let path: string;
  try {
    path = decodeURIComponent(url.pathname).slice(1);
  } catch {
    errors.push(`${source}: invalid sitemap URL encoding`);
    return null;
  }
  const artifactPath: string | null = websiteArtifactPath(path, files);
  if (artifactPath === null) {
    errors.push(`${source}: missing internal target ${url.pathname}`);
    return null;
  }
  path = artifactPath;
  return { path, url };
}

export function auditWebsiteSitemaps(
  files: ReadonlyMap<string, Uint8Array>,
  origin: URL,
): SitemapAudit {
  const errors: string[] = [];
  const urls: Set<string> = new Set<string>();
  const visited: Set<string> = new Set<string>();
  const active: Set<string> = new Set<string>();
  let locationCount: number = 0;
  const root: string = files.has("sitemap-index.xml") ? "sitemap-index.xml" : "sitemap.xml";
  const robotsBytes: Uint8Array | undefined = files.get("robots.txt");
  let robots: string = "";
  if (robotsBytes !== undefined && robotsBytes.byteLength <= MAXIMUM_SITEMAP_BYTES) {
    try {
      robots = new TextDecoder("utf-8", { fatal: true }).decode(robotsBytes);
    } catch {
      errors.push("robots.txt must contain valid UTF-8");
    }
  }
  if (
    !robots
      .split(/\r?\n/u)
      .some((line: string): boolean => line.trim() === `Sitemap: ${origin.origin}/${root}`)
  ) {
    errors.push("robots.txt must advertise the public sitemap");
  }

  function visit(path: string, depth: number): void {
    if (active.has(path)) {
      errors.push(`${path}: cyclic sitemap reference`);
      return;
    }
    if (visited.has(path)) return;
    if (visited.size >= MAXIMUM_SITEMAP_FILES || depth > 16) {
      errors.push("Sitemap traversal exceeds its bounded file or depth limit");
      return;
    }
    visited.add(path);
    const content: Uint8Array | undefined = files.get(path);
    if (content === undefined) {
      errors.push("Missing sitemap.xml or sitemap-index.xml");
      return;
    }
    const document: SitemapDocument | null = parseSitemap(content);
    if (document === null) {
      errors.push(`${path}: malformed or oversized sitemap document`);
      return;
    }
    active.add(path);
    for (const value of document.locations) {
      locationCount += 1;
      if (locationCount > MAXIMUM_TOTAL_LOCATIONS) {
        errors.push("Sitemap traversal exceeds its bounded location limit");
        break;
      }
      const target: ReturnType<typeof sitemapTarget> = sitemapTarget(
        value,
        path,
        origin,
        files,
        errors,
      );
      if (target === null) continue;
      if (document.kind === "sitemapindex") {
        if (!target.path.endsWith(".xml")) {
          errors.push(`${path}: sitemap indexes must reference XML documents`);
          continue;
        }
        visit(target.path, depth + 1);
      } else {
        if (!target.path.endsWith(".html")) {
          errors.push(`${path}: page sitemaps must reference HTML pages`);
          continue;
        }
        urls.add(target.url.href);
      }
    }
    active.delete(path);
  }

  visit(root, 0);
  return { errors, urls };
}
