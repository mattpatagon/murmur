import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

const site: string = process.env["WEBSITE_SITE_URL"] ?? "https://usemurmur.dev";
if (!URL.canParse(site)) throw new Error("WEBSITE_SITE_URL must be a valid HTTPS origin");
const siteUrl: URL = new URL(site);
if (
  siteUrl.protocol !== "https:" ||
  siteUrl.username !== "" ||
  siteUrl.password !== "" ||
  siteUrl.pathname !== "/" ||
  siteUrl.search !== "" ||
  siteUrl.hash !== ""
)
  throw new Error("WEBSITE_SITE_URL must be an HTTPS origin without credentials or a path");

export default defineConfig({
  build: { format: "file" },
  site: siteUrl.origin,
  output: "static",
  trailingSlash: "never",
  integrations: [react()],
  vite: { plugins: [tailwindcss()] },
});
