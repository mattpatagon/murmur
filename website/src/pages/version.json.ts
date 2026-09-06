import type { APIRoute } from "astro";

export const GET: APIRoute = (): Response => {
  const revision: string = process.env["WEBSITE_REVISION"] ?? "development";
  if (revision !== "development" && !/^[a-f0-9]{40}$/u.test(revision)) {
    throw new Error("WEBSITE_REVISION must be a full Git commit hash");
  }
  return new Response(JSON.stringify({ revision }), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};
