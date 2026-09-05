import type { APIRoute } from "astro";

export const GET: APIRoute = ({ site }: Parameters<APIRoute>[0]): Response => {
  if (site === undefined) throw new Error("The website canonical URL is required");
  return new Response(`User-agent: *\nAllow: /\nSitemap: ${new URL("sitemap.xml", site)}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
