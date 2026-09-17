import type { MetadataRoute } from "next";

const SITE_URL = "https://simplassist.com";

const SITEMAP_PATHS = [
  "",
  "/ai-chatbot-for-small-business",
  "/ai-receptionist-for-small-business",
  "/support",
  "/support/setup-fee",
  "/privacy",
  "/terms",
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  return SITEMAP_PATHS.map((path) => ({ url: `${SITE_URL}${path}` }));
}
