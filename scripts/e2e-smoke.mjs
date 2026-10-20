// Прогон по живому приложению: библиотека → загрузка книги → чтение → пауза → оглавление → настройки.
// Снимки в test-output/. Запуск: npm run build && npx vite preview --port 4173 & BOOK=путь node scripts/e2e-smoke.mjs
import { mkdirSync } from "node:fs";
import { chromium, webkit } from "@playwright/test";

const base = process.env.BASE ?? "http://localhost:4173/";
const book = process.env.BOOK;
if (!book) throw new Error("BOOK=<путь к книге>");
const tag = process.env.TAG ?? "run";
const out = `test-output/${tag}`;
mkdirSync(out, { recursive: true });

const sizes = (process.env.SIZES ?? "390x844,320x640,1280x800").split(",").map((s) => s.split("x").map(Number));
// BROWSER=webkit — движок Safari
const browser = process.env.BROWSER === "webkit" ? await webkit.launch() : await chromium.launch({ channel: "chrome" });
const problems = [];

for (const [w, hgt] of sizes) {
	const name = `${w}`;
	const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, deviceScaleFactor: 1, hasTouch: w < 768, isMobile: process.env.BROWSER === "webkit" && w < 768 });
	const page = await ctx.newPage();
	page.on("console", (m) => m.type() === "error" && problems.push(`[${name}] console: ${m.text()}`));
	page.on("pageerror", (e) => problems.push(`[${name}] pageerror: ${e.message}`));
	await page.goto(base);
	await page.waitForSelector(".library");
	await page.screenshot({ path: `${out}/${name}-1-library-empty.png` });

	await page.setInputFiles('input[type="file"]', book);
	await page.waitForSelector(".reader", { timeout: 120000 });
	await page.waitForTimeout(600);
	await page.screenshot({ path: `${out}/${name}-2-reader-start.png` });

	// Чтение: слова меняются, красная буква на засечке
	await page.click(".play");
	const seen = new Set();
	let maxOff = 0;
	let overflow = 0;
	for (let i = 0; i < 25; i++) {
		await page.waitForTimeout(90);
		const r = await page.evaluate(() => {
			const stage = document.querySelector(".stage").getBoundingClientRect();
			const p = document.querySelector(".word .p").getBoundingClientRect();
			const wEl = document.querySelector(".word").getBoundingClientRect();
			const anchor = parseFloat(getComputedStyle(document.querySelector(".reader")).getPropertyValue("--anchor"));
			return {
				text: document.querySelector(".word").textContent,
				off: Math.abs(p.left + p.width / 2 - (stage.left + anchor)),
				out: wEl.left < stage.left - 1 || wEl.right > stage.right + 1,
			};
		});
		seen.add(r.text);
		maxOff = Math.max(maxOff, r.off);
		if (r.out) overflow++;
	}
	await page.screenshot({ path: `${out}/${name}-3-playing.png` });
	await page.click(".play");
	await page.waitForTimeout(300);
	await page.screenshot({ path: `${out}/${name}-4-paused.png` });
	if (seen.size < 5) problems.push(`[${name}] слова почти не менялись: ${[...seen].join(" | ")}`);
	if (maxOff > 1.5) problems.push(`[${name}] красная буква съезжает с засечки на ${maxOff.toFixed(1)}px`);
	if (overflow) problems.push(`[${name}] слово вылезало за край ${overflow} раз`);

	// Оглавление
	await page.click('button[aria-label="Оглавление и закладки"]');
	await page.waitForTimeout(400);
	await page.screenshot({ path: `${out}/${name}-5-toc.png` });
	const tocCount = await page.locator(".toc-item").count();
	const second = page.locator(".toc-item").nth(Math.min(2, Math.max(0, tocCount - 1)));
	if (tocCount > 0) {
		await second.click();
		await page.waitForTimeout(400);
	} else {
		await page.keyboard.press("Escape");
	}
	await page.screenshot({ path: `${out}/${name}-6-after-toc-jump.png` });

	// Закладка
	await page.click('button[aria-label="Закладка здесь"]');
	await page.waitForTimeout(300);

	// Настройки → тема «Бумага», шрифт с засечками
	await page.click('.topbar button[aria-label="Настройки"]');
	await page.waitForTimeout(400);
	await page.screenshot({ path: `${out}/${name}-7-settings.png`, fullPage: false });
	await page.click('.segmented button:text-is("Бумага")');
	await page.click('.segmented button:text-is("С засечками")');
	await page.keyboard.press("Escape");
	await page.waitForTimeout(400);
	await page.screenshot({ path: `${out}/${name}-8-paper-serif.png` });

	const hScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
	if (hScroll) problems.push(`[${name}] горизонтальная прокрутка на экране чтения`);

	await page.click('button[aria-label="К библиотеке"]');
	await page.waitForSelector(".library .book");
	await page.waitForTimeout(300);
	await page.screenshot({ path: `${out}/${name}-9-library.png` });
	const hScroll2 = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
	if (hScroll2) problems.push(`[${name}] горизонтальная прокрутка в библиотеке`);

	console.log(`[${name}] слов увидено: ${seen.size}, сдвиг буквы: ${maxOff.toFixed(2)}px, пунктов оглавления: ${tocCount}`);
	await ctx.close();
}

await browser.close();
console.log(problems.length ? `ПРОБЛЕМЫ:\n${problems.join("\n")}` : "Проблем не найдено");
