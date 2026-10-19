import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
	// Относительные пути: приложение работает из любой подпапки (GitHub Pages)
	base: "./",
	build: { target: "es2020" },
	plugins: [
		VitePWA({
			registerType: "autoUpdate",
			includeAssets: ["icon.svg", "apple-touch-icon.png"],
			manifest: {
				name: "Точка — чтение по слову",
				short_name: "Точка",
				description: "Читалка по одному слову: FB2, EPUB, TXT, PDF",
				lang: "ru",
				start_url: "./",
				scope: "./",
				display: "standalone",
				background_color: "#1b1e24",
				theme_color: "#1b1e24",
				icons: [
					{ src: "icon-192.png", sizes: "192x192", type: "image/png" },
					{ src: "icon-512.png", sizes: "512x512", type: "image/png" },
					{ src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
				],
			},
			workbox: {
				globPatterns: ["**/*.{js,mjs,css,html,woff2,png,svg}"],
				// pdf.js с воркером весит больше стандартных 2 МБ
				maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
			},
		}),
	],
});
