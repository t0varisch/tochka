// Простой текст: кодировка, абзацы (пустые строки, отступы, жёсткий перенос), оглавление по заголовкам.
import type { BookFormat, ParsedBook, TocEntry } from "../types";
import { decodeText } from "./decode";
import { cleanParagraph, joinLines, median, percentile, titleFromFileName } from "./util";
import { TOP_LEVEL_RE, headingKind, joinTitleLines } from "./headings";
import { dropPrintedToc } from "./postprocess";

/**
 * Оглавление по заголовкам среди абзацев.
 * bareNumbers: считать ли заголовком строку из одного номера («IV», «12») — для TXT да,
 * для PDF и прочих запасным вариантом нет (там это обычно мусор распознавания или номера страниц).
 */
export function detectToc(paragraphs: string[], bareNumbers = true): TocEntry[] {
	const found: { i: number; kind: string }[] = [];
	for (let i = 0; i < paragraphs.length; i++) {
		const kind = headingKind(paragraphs[i]);
		if (kind && (bareNumbers || kind !== "#")) found.push({ i, kind });
	}
	// много голых номеров подряд — скорее номера страниц, не главы
	const bare = found.filter((f) => f.kind === "#").length;
	const list = bare > 300 ? found.filter((f) => f.kind !== "#") : found;
	const hasTop = list.some((f) => TOP_LEVEL_RE.test(f.kind));
	const toc: TocEntry[] = [];
	for (const { i, kind } of list) {
		let title = paragraphs[i];
		// «Глава 1» + короткое название следующей строкой → «Глава 1. Название»
		const next = paragraphs[i + 1];
		if (next && next.length < 100 && !headingKind(next) && !/[.!?…,;:]$/.test(next) && !/^[—–-]/.test(next)) {
			title = joinTitleLines([title, next]);
		}
		const level = TOP_LEVEL_RE.test(kind) ? 0 : hasTop ? 1 : 0;
		toc.push({ title, level, paragraph: i });
	}
	return toc;
}

function leadingWidth(line: string): number {
	const m = /^[ \t\u00A0\u3000]*/.exec(line)![0];
	let w = 0;
	for (const ch of m) w += ch === "\t" ? 4 : 1;
	return w;
}

const SENTENCE_END_RE = /[.!?…]["'»”’)\]]*$/;

/** Делит простой текст на абзацы. */
export function splitPlainText(raw: string): string[] {
	const lines = raw
		.replace(/\r\n?/g, "\n")
		.replace(/\f/g, "\n")
		.split("\n")
		.map((l) => l.replace(/[ \t\u00A0\u3000]+$/, ""));
	const nonEmpty = lines.filter((l) => l.trim().length > 0);
	if (!nonEmpty.length) return [];

	// общий отступ всего файла — не признак абзаца
	let minIndent = Infinity;
	for (const l of nonEmpty) minIndent = Math.min(minIndent, leadingWidth(l));
	const indents = lines.map((l) => (l.trim() ? leadingWidth(l) - minIndent : 0));
	const texts = lines.map((l) => l.trim());

	const lens = nonEmpty.map((l) => l.trim().length);
	const longShare = lens.filter((n) => n > 100).length / lens.length;
	const wrapped = lens.length >= 5 && longShare < 0.05 && median(lens) >= 35;
	if (!wrapped) return nonEmpty.map(cleanParagraph).filter(Boolean);

	const width = percentile(lens, 0.9);
	const indented = indents.filter((n, i) => texts[i] && n >= 2).length;
	const indentMode = indented >= nonEmpty.length * 0.04 && indented <= nonEmpty.length * 0.85;
	let blocks = 0;
	for (let i = 0; i < lines.length; i++) if (texts[i] && (i === 0 || !texts[i - 1])) blocks++;
	const blankMode = !indentMode && blocks >= 3 && blocks >= nonEmpty.length / 25;

	const out: string[] = [];
	let cur: string[] = [];
	const flush = () => {
		if (!cur.length) return;
		// блок из одних коротких строк (стихи, список) — каждая строка отдельно
		if (cur.length >= 2 && Math.max(...cur.map((l) => l.length)) < width * 0.7) {
			for (const l of cur) out.push(cleanParagraph(l));
		} else {
			out.push(cleanParagraph(cur.reduce((acc, l) => joinLines(acc, l), "")));
		}
		cur = [];
	};

	for (let i = 0; i < lines.length; i++) {
		const t = texts[i];
		if (!t) {
			flush();
			continue;
		}
		if (headingKind(cleanParagraph(t))) {
			flush();
			out.push(cleanParagraph(t));
			continue;
		}
		if (cur.length) {
			const prev = cur[cur.length - 1];
			let brk = false;
			if (indentMode && indents[i] >= 2) brk = true;
			else if (!indentMode && !blankMode && prev.length < width * 0.75 && SENTENCE_END_RE.test(prev)) brk = true;
			if (brk) flush();
		}
		cur.push(t);
	}
	flush();
	return out.filter(Boolean);
}

/** Книга из готовой строки. */
export function bookFromText(text: string, title: string, format: BookFormat): ParsedBook {
	const paragraphs = splitPlainText(text);
	return dropPrintedToc({ title, author: "", format, paragraphs, toc: detectToc(paragraphs) });
}

/** Разбор TXT-файла. */
export function parseTxt(bytes: Uint8Array, fileName: string): ParsedBook {
	const { text } = decodeText(bytes);
	return bookFromText(text, titleFromFileName(fileName), "txt");
}
