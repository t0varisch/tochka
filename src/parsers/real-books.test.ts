// Прогон на настоящих книгах. Включается переменной REAL_BOOKS="путь1;путь2;…" (файлы только читаются).
import { describe, expect, it } from "vitest";
import type { ParsedBook } from "../types";
import { parseFile, type PdfjsModule } from "./index";

const env = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const paths = (env.REAL_BOOKS ?? "")
	.split(";")
	.map((s) => s.trim())
	.filter(Boolean);

// node:fs без @types/node
const FS = "node:fs";
interface Fs {
	readFileSync(p: string): Uint8Array;
	writeFileSync(p: string, data: string): void;
}
async function readBytes(path: string): Promise<Uint8Array> {
	const fs = (await import(/* @vite-ignore */ FS)) as Fs;
	return new Uint8Array(fs.readFileSync(path));
}

/** REAL_BOOKS_DUMP=папка — сохранить абзацы и оглавление каждой книги в текстовый файл для просмотра. */
async function dump(name: string, book: ParsedBook): Promise<void> {
	const dir = env.REAL_BOOKS_DUMP;
	if (!dir) return;
	const fs = (await import(/* @vite-ignore */ FS)) as Fs;
	const toc = book.toc.map((e) => `${"  ".repeat(e.level)}${e.title} → #${e.paragraph}`).join("\n");
	const text = book.paragraphs.map((p, i) => `#${i}\t${p}`).join("\n");
	fs.writeFileSync(`${dir}/${name.replace(/[^\p{L}\p{N}._-]+/gu, "_")}.txt`, `${book.title}\n${book.author}\n\nTOC\n${toc}\n\nTEXT\n${text}\n`);
}

const loadLegacyPdfjs = async () => (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsModule;

// Как в задаче, но не ловит e-mail и адреса в угловых скобках (<name@site.com>, <www.site.com>) —
// они встречаются в тексте книг.
const TAG_RE = /<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s[^>]{0,40})?\/?>/;
const BASE64_RE = /[A-Za-z0-9+/]{80,}/;

describe.skipIf(!paths.length)("настоящие книги", () => {
	for (const path of paths) {
		const name = path.split(/[\\/]/).pop()!;
		it(name, async () => {
			const bytes = await readBytes(path);
			const t0 = performance.now();
			const book = await parseFile(new File([bytes as BlobPart], name), { pdfjs: loadLegacyPdfjs });
			const ms = Math.round(performance.now() - t0);
			const words = book.paragraphs.reduce((n, p) => n + p.split(/[\t\n\v\f\r ]+/).filter(Boolean).length, 0);
			const lines = [
				`=== ${name}`,
				`title: ${book.title}`,
				`author: ${book.author}`,
				`format: ${book.format}; paragraphs: ${book.paragraphs.length}; words: ${words}; toc: ${book.toc.length}; ms: ${ms}`,
				...book.toc.slice(0, 5).map((e) => `  [${e.level}] ${e.title} → #${e.paragraph}: ${book.paragraphs[e.paragraph]?.slice(0, 60)}`),
				`text: ${book.paragraphs.join(" ¶ ").slice(0, 300)}`,
			];
			console.log(lines.join("\n"));
			await dump(name, book);

			const tagged = book.paragraphs.filter((p) => TAG_RE.test(p));
			const base64 = book.paragraphs.filter((p) => BASE64_RE.test(p));
			expect(tagged.slice(0, 3)).toEqual([]);
			expect(base64.slice(0, 3)).toEqual([]);
			expect(book.paragraphs.length).toBeGreaterThan(0);
			for (const e of book.toc) expect(e.paragraph).toBeLessThan(book.paragraphs.length);
		});
	}
});
