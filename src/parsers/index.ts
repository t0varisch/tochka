// Точка входа парсеров: формат по содержимому (сигнатуры), затем по расширению.
import type { ParsedBook } from "../types";
import { detectUtf16NoBom, latin1Head } from "./decode";
import { parseFb2 } from "./fb2";
import { dropPrintedToc } from "./postprocess";
import { bookFromText, detectToc, parseTxt } from "./txt";
import { BookParseError, ERR_BROKEN, ERR_EMPTY, ERR_UNKNOWN, cleanParagraph } from "./util";
import type { PdfjsSource } from "./pdf";

export { BookParseError } from "./util";
export type { PdfjsModule, PdfjsSource } from "./pdf";

export interface ParseOptions {
	/** Доля выполненной работы 0..1 */
	onProgress?: (fraction: number) => void;
	/** Название текущего шага разбора (сейчас — только PDF). */
	onStage?: (stage: string) => void;
	/** Только для тестов в Node: своя сборка pdf.js (legacy). */
	pdfjs?: PdfjsSource;
}

type Sniffed = "zip" | "pdf" | "fb2" | "ole" | "rtf" | "mobi" | "djvu" | "unknown";

/** Формат по первым байтам. */
export function sniffFormat(b: Uint8Array): Sniffed {
	if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7)) return "zip";
	const head = latin1Head(b, 4096);
	if (head.slice(0, 1024).includes("%PDF-")) return "pdf";
	if (/<(?:[\w.-]+:)?FictionBook[\s>]/.test(head)) return "fb2";
	if (b.length >= 4 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return "ole";
	if (head.startsWith("{\\rtf")) return "rtf";
	if (latin1Head(b.subarray(60, 68), 8) === "BOOKMOBI") return "mobi";
	if (head.startsWith("AT&TFORM")) return "djvu";
	return "unknown";
}

/** Похоже ли на текст: нет нулевых байтов (кроме UTF-16). */
function looksLikeText(b: Uint8Array): boolean {
	const n = Math.min(b.length, 8192);
	if (n === 0) return false;
	if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) return true;
	let zeros = 0;
	let ctrl = 0;
	for (let i = 0; i < n; i++) {
		if (b[i] === 0) zeros++;
		else if (b[i] < 9 || (b[i] > 13 && b[i] < 32)) ctrl++;
	}
	if (zeros && detectUtf16NoBom(b)) return true;
	return zeros === 0 && ctrl < n * 0.01;
}

async function readBytes(file: Blob): Promise<Uint8Array> {
	if (typeof file.arrayBuffer === "function") return new Uint8Array(await file.arrayBuffer());
	return new Promise((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
		r.onerror = () => reject(r.error);
		r.readAsArrayBuffer(file);
	});
}

function extOf(name: string): string {
	const m = /\.([a-z0-9]+)$/i.exec(name);
	return m ? m[1].toLowerCase() : "";
}

const UNSUPPORTED: Partial<Record<Sniffed, string>> = {
	ole: "Файлы Word (DOC) не поддерживаются — сохраните книгу как FB2, EPUB или TXT",
	rtf: "Файлы RTF не поддерживаются — сохраните книгу как FB2, EPUB или TXT",
	mobi: "Формат MOBI/AZW не поддерживается — нужна книга в FB2, EPUB, TXT или PDF",
	djvu: "Формат DjVu не поддерживается — это скан, в нём нет текста",
};

async function parseZip(bytes: Uint8Array, name: string, onProgress?: (f: number) => void): Promise<ParsedBook> {
	const epub = await import("./epub");
	let zip;
	try {
		zip = await epub.loadZip(bytes);
	} catch (e) {
		throw new BookParseError("Архив повреждён — не удалось его открыть", { cause: e });
	}
	if (epub.isEpubZip(zip)) return epub.parseEpubZip(zip, name, onProgress);
	const files = Object.values(zip.files).filter((f) => !f.dir && !/(^|\/)(__MACOSX|\.)/.test(f.name));
	// FB2 внутри zip (.fb2.zip)
	const fb2 = files.find((f) => /\.fb2$/i.test(f.name));
	if (fb2) return parseFb2(await fb2.async("uint8array"), fb2.name);
	for (const f of files.filter((f) => /\.xml$/i.test(f.name))) {
		const b = await f.async("uint8array");
		if (sniffFormat(b) === "fb2") return parseFb2(b, f.name);
	}
	if (files.some((f) => f.name === "word/document.xml")) {
		throw new BookParseError("Файлы Word (DOCX) не поддерживаются — сохраните книгу как FB2, EPUB или TXT");
	}
	const epubInside = files.find((f) => /\.epub$/i.test(f.name));
	if (epubInside) return epub.parseEpub(await epubInside.async("uint8array"), epubInside.name, onProgress);
	const txt = files.find((f) => /\.txt$/i.test(f.name));
	if (txt) return parseTxt(await txt.async("uint8array"), txt.name);
	throw new BookParseError("В архиве нет книги в формате FB2, EPUB или TXT");
}

async function parseBytes(bytes: Uint8Array, name: string, opts: ParseOptions): Promise<ParsedBook> {
	const kind = sniffFormat(bytes);
	const ext = extOf(name);
	if (kind === "zip") return parseZip(bytes, name, opts.onProgress);
	if (kind === "pdf") {
		const { parsePdf } = await import("./pdf");
		return parsePdf(bytes, name, { onProgress: opts.onProgress, onStage: opts.onStage, pdfjs: opts.pdfjs });
	}
	if (kind === "fb2") return parseFb2(bytes, name);
	const unsupported = UNSUPPORTED[kind];
	if (unsupported) throw new BookParseError(unsupported);

	// содержимое не узнали — смотрим на расширение
	if (ext === "fb2") return parseFb2(bytes, name);
	if (ext === "epub" || ext === "zip") throw new BookParseError("Файл повреждён — это не архив EPUB/ZIP");
	if (ext === "pdf") throw new BookParseError("Файл повреждён — это не PDF");
	if (ext === "docx" || ext === "doc") throw new BookParseError(UNSUPPORTED.ole!);
	if (ext === "txt" || ext === "text" || ext === "md" || looksLikeText(bytes)) return parseTxt(bytes, name);
	throw new BookParseError(ERR_UNKNOWN);
}

/**
 * Разбирает файл книги: FB2 (в т.ч. .fb2.zip), EPUB, PDF, TXT.
 * Ошибки — BookParseError с текстом для пользователя.
 */
export async function parseFile(file: File, opts: ParseOptions = {}): Promise<ParsedBook> {
	let bytes: Uint8Array;
	try {
		bytes = await readBytes(file);
	} catch (e) {
		throw new BookParseError("Не удалось прочитать файл", { cause: e });
	}
	if (!bytes.length) throw new BookParseError("Файл пустой");
	let book: ParsedBook;
	try {
		book = dropPrintedToc(await parseBytes(bytes, file.name, opts));
	} catch (e) {
		if (e instanceof BookParseError) throw e;
		throw new BookParseError(ERR_BROKEN, { cause: e });
	}
	if (!book.paragraphs.length) throw new BookParseError(ERR_EMPTY);
	// нет оглавления в файле — ищем заголовки «Глава 1», «Часть II», «Пролог» в тексте
	if (!book.toc.length) opts.onStage?.("ищу главы");
	if (!book.toc.length) book.toc = detectToc(book.paragraphs, book.format === "txt" || book.format === "text");
	opts.onProgress?.(1);
	return book;
}

/** Вставленный текст: абзацы как в TXT. Без названия — первые слова текста. */
export function parseText(text: string, title?: string): ParsedBook {
	let name = cleanParagraph(title ?? "");
	const book = bookFromText(text, "", "text");
	if (!name) {
		const first = book.paragraphs[0] ?? "";
		name = first.length > 60 ? first.slice(0, 60).replace(/\s+\S*$/, "") + "…" : first;
	}
	book.title = name || "Без названия";
	return book;
}
