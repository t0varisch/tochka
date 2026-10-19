// Рисует PNG-иконки из public/icon.svg (нужен Chrome). Запуск: node scripts/make-icons.mjs
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const svg = readFileSync("public/icon.svg", "utf8");
const square = svg.replace(' rx="112"', "");
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
for (const [name, size, src] of [
	["icon-192.png", 192, svg],
	["icon-512.png", 512, svg],
	["icon-maskable-512.png", 512, square],
	["apple-touch-icon.png", 180, square],
]) {
	await page.setViewportSize({ width: size, height: size });
	await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${src}`);
	await page.screenshot({ path: `public/${name}`, omitBackground: true });
}
await browser.close();
