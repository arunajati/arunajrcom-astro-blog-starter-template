// @ts-check
import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";

import cloudflare from "@astrojs/cloudflare";

// https://astro.build/config
export default defineConfig({
	site: "https://arunajr.com",
	redirects: {
		"/blog/cara-mencatat-pengelaran-harian-otomatis-dari-iphone-ke-google-sheets/":
			"/blog/cara-mencatat-pengeluaran-harian-otomatis-dari-iphone-ke-google-sheets/",
	},
	integrations: [mdx(), sitemap()],
	adapter: cloudflare({
		platformProxy: {
			enabled: true,
		},
	}),
});
