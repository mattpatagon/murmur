import type { APIContext, APIRoute } from "astro";

import errorSource from "./404.md?raw";
import setupSource from "./get-started.md?raw";
import mechanismSource from "./how-it-works.md?raw";
import homeSource from "./index.md?raw";
import licenseSource from "./license.md?raw";
import securitySource from "./security.md?raw";

type RawPageRoute = {
  readonly params: { readonly page: string };
  readonly props: { readonly source: string };
};

export function getStaticPaths(): readonly RawPageRoute[] {
  return [
    { params: { page: "index" }, props: { source: homeSource } },
    { params: { page: "how-it-works" }, props: { source: mechanismSource } },
    { params: { page: "get-started" }, props: { source: setupSource } },
    { params: { page: "security" }, props: { source: securitySource } },
    { params: { page: "license" }, props: { source: licenseSource } },
    { params: { page: "404.html" }, props: { source: errorSource } },
  ];
}

export const GET: APIRoute = (context: APIContext): Response => {
  const source: unknown = context.props["source"];
  if (typeof source !== "string") {
    return new Response("Markdown source is unavailable.\n", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      status: 500,
    });
  }
  return new Response(source, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "X-Robots-Tag": "noindex",
    },
  });
};
