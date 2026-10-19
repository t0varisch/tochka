// Общая доводка книги после разбора: убрать напечатанное оглавление («Содержание» со списком глав).
import type { ParsedBook, TocEntry } from "../types";

const TOC_HEAD_RE = /^(содержание|оглавление|contents|table of contents)\.?$/i;
const PAGE_REF_RE = /[\s.…·_]+(\d{1,4}|[ivxlcdm]{1,7})$/i;

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, "");
const stripPageRef = (s: string) => s.replace(/[\s.…·_–—-]*(\d{1,4}|[ivxlcdm]{1,7})\s*$/i, "");

/** Похожа ли строка на пункт напечатанного оглавления. */
function isTocLine(p: string, titles: Set<string>, prefixes: string[]): boolean {
	if (p.length > 300 || !/\p{L}/u.test(p)) return false;
	const a = norm(p);
	const b = norm(stripPageRef(p));
	if (titles.has(a) || titles.has(b)) return true;
	if (b.length >= 8 && prefixes.some((t) => t.startsWith(b) || b.startsWith(t))) return true;
	// строка с номером страницы в конце
	return PAGE_REF_RE.test(p) && p.length < 300;
}

/**
 * Убирает напечатанное оглавление: заголовок «Содержание/Оглавление/Contents» и идущий за ним
 * список строк, совпадающих с заголовками глав или кончающихся номером страницы (не меньше трёх).
 */
export function dropPrintedToc(book: ParsedBook): ParsedBook {
	const { paragraphs, toc } = book;
	const heads: number[] = [];
	for (let i = 0; i < paragraphs.length; i++) if (paragraphs[i].length < 40 && TOC_HEAD_RE.test(paragraphs[i].trim())) heads.push(i);
	if (!heads.length) return book;

	const titles = new Set<string>();
	for (const e of toc) {
		titles.add(norm(e.title));
		const p = paragraphs[e.paragraph];
		if (p) titles.add(norm(p));
	}
	titles.delete("");
	const prefixes = [...titles].filter((t) => t.length >= 8);

	const drop = new Set<number>();
	for (const i of heads) {
		if (drop.has(i)) continue;
		let last = i;
		let matched = 0;
		let misses = 0;
		const seen = new Set<string>();
		for (let j = i + 1; j < paragraphs.length; j++) {
			const key = norm(stripPageRef(paragraphs[j]));
			// тот же заголовок второй раз — оглавление кончилось, пошёл текст
			if (seen.has(key)) break;
			if (isTocLine(paragraphs[j], titles, prefixes)) {
				seen.add(key);
				last = j;
				matched++;
				misses = 0;
			} else if (paragraphs[j].length < 100 && misses < 2) {
				misses++;
			} else break;
		}
		if (matched >= 3) for (let k = i; k <= last; k++) drop.add(k);
	}
	if (!drop.size) return book;

	// пересчёт индексов оглавления
	const shift: number[] = new Array(paragraphs.length);
	let removed = 0;
	for (let i = 0; i < paragraphs.length; i++) {
		shift[i] = removed;
		if (drop.has(i)) removed++;
	}
	const newToc: TocEntry[] = [];
	for (const e of toc) {
		if (drop.has(e.paragraph)) continue;
		newToc.push({ ...e, paragraph: e.paragraph - shift[e.paragraph] });
	}
	return { ...book, paragraphs: paragraphs.filter((_, i) => !drop.has(i)), toc: newToc };
}
