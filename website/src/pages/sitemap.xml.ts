import type { APIRoute } from "astro";

export const GET: APIRoute = ({ site }: Parameters<APIRoute>[0]): Response => {
  if (site === undefined) throw new Error("The website canonical URL is required");
  const paths: readonly string[] = ["/", "/how-it-works", "/get-started", "/security", "/license"];
  const entries: string = paths
    .map((path: string): string => `<url><loc>${new URL(path, site).href}</loc></url>`)
    .join("");
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`,
    {
      headers: { "Content-Type": "application/xml; charset=utf-8" },
    },
  );
};
