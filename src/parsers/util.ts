// Общие помощники парсеров: ошибка для пользователя, чистка абзаца, склейка строк, имя из файла.

/** Ошибка с понятным пользователю текстом на русском. */
export class BookParseError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "BookParseError";
	}
}

export const ERR_DRM = "Книга защищена DRM — такие не открываются";
export const ERR_SCAN = "В PDF нет текста — похоже, это скан";
export const ERR_UNKNOWN = "Не удалось распознать формат файла";
export const ERR_EMPTY = "В книге не нашлось текста";
export const ERR_BROKEN = "Не удалось прочитать книгу — файл повреждён или в неподдерживаемом формате";

// Невидимые символы: мягкий перенос, нулевой ширины, направление текста, BOM
const INVISIBLE_RE = /[\u00AD\u200B-\u200F\u2060\uFEFF]/g;
// Управляющие символы, кроме пробельных ASCII
const CONTROL_RE = /[\u0000-\u0008\u000E-\u001F\u007F]/g;
// Неразрывные по смыслу пробелы → U+00A0
const NBSP_LIKE_RE = /[\u2007\u202F]/g;
// Разрывные юникод-пробелы → обычный пробел (читалка режет только по ASCII)
const SPACE_LIKE_RE = /[\u0085\u1680\u2000-\u2006\u2008-\u200A\u2028\u2029\u205F\u3000]/g;
const ASCII_WS_RE = /[\t\n\v\f\r ]+/g;

/**
 * Метка на месте вырезанной сноски или картинки. Пробел перед ней убирается,
 * если дальше знак препинания: «архетипов [1].» → «архетипов.», а не «архетипов .».
 */
export const GAP = String.fromCharCode(0xe000);
const GAP_RE = new RegExp(GAP, "g");
const GAP_BEFORE_PUNCT_RE = new RegExp("\\s*" + GAP + "+\\s*(?=[.,;:!?…»)\\]”])", "g");

/**
 * Приводит абзац к виду, который ждёт читалка: схлопывает ASCII-пробелы,
 * сохраняет U+00A0, убирает мягкие переносы и символы нулевой ширины.
 */
export function cleanParagraph(s: string): string {
	if (!s) return "";
	if (s.includes(GAP)) s = s.replace(GAP_BEFORE_PUNCT_RE, "").replace(GAP_RE, "");
	return s
		.replace(INVISIBLE_RE, "")
		.replace(CONTROL_RE, "")
		// тонкий пробел между цифрами («10 000») склеивает число
		.replace(/(\d)[\u2009\u200A](?=\d)/g, "$1\u00A0")
		.replace(NBSP_LIKE_RE, "\u00A0")
		.replace(SPACE_LIKE_RE, " ")
		.replace(ASCII_WS_RE, " ")
		// неразрывный рядом с обычным пробелом не должен давать «пустое слово»
		.replace(/[ \u00A0]* [ \u00A0]*/g, " ")
		.replace(/\u00A0{2,}/g, "\u00A0")
		.trim();
}

// Слова, которые пишутся через дефис: при переносе дефис оставляем
const HYPHEN_SUFFIXES = new Set(["то", "либо", "нибудь", "ка", "таки", "де"]);
const HYPHEN_PREFIXES = new Set(["по", "кое", "кой", "из", "во", "в", "северо", "юго", "пол", "экс", "вице", "лейб", "обер", "унтер", "штаб"]);

/** Склеивает две строки сверстанного текста, убирая перенос слова. */
export function joinLines(prev: string, next: string): string {
	const a = prev.replace(/[ \t]+$/, "");
	const b = next.replace(/^[ \t]+/, "");
	if (!a) return b;
	if (!b) return a;
	// мягкий перенос в конце строки — просто склеить
	if (a.endsWith("\u00AD")) return a.slice(0, -1) + b;
	const hyph = /(\p{L}+)[-‐‑]$/u.exec(a);
	if (hyph && /^\p{Ll}/u.test(b)) {
		const before = hyph[1].toLowerCase();
		const after = /^\p{L}+/u.exec(b)?.[0].toLowerCase() ?? "";
		if (HYPHEN_SUFFIXES.has(after) || HYPHEN_PREFIXES.has(before)) return a + b;
		return a.slice(0, -1) + b;
	}
	// дефис перед заглавной — составное имя («Нью-» + «Йорк»): дефис оставляем, без пробела
	if (hyph && /^\p{Lu}/u.test(b)) return a + b;
	// тире вплотную к слову (английская вёрстка) — без пробела
	if (/\p{L}[—]$/u.test(a)) return a + b;
	return a + " " + b;
}

const NOTE_MARKER_RE = /^(?:\[[^\]]{1,6}\]|\{[^}]{1,6}\}|\(\d{1,4}\)|\d{1,4}\)?|\*{1,4}|[†‡§]{1,3})$/;

/** Похоже ли на маркер сноски: «1», «[1]», «{1}», «*», «(1)», «1)». */
export function isNoteMarker(text: string): boolean {
	const t = text.replace(/[\s\u00A0]+/g, "");
	return t.length > 0 && t.length <= 8 && NOTE_MARKER_RE.test(t);
}

/** Название из имени файла: без расширений, без хвостов z-library, «_» → пробел. */
export function titleFromFileName(fileName: string): string {
	let s = (fileName || "").split(/[\\/]/).pop() ?? "";
	for (let i = 0; i < 3; i++) {
		const next = s.replace(/\.(fb2|epub|zip|txt|text|pdf|md)$/i, "");
		if (next === s) break;
		s = next;
	}
	s = s.replace(/\s*\((?:[^()]*\b(?:z-?lib|1lib|libgen|z-library)\b[^()]*)\)/gi, "");
	// хвост флибусты/литрес вида «.bakGOQ.582116»
	s = s.replace(/\.[A-Za-z0-9]{5,8}\.\d{3,}$/, "").replace(/\.\d{4,}$/, "");
	s = cleanParagraph(s.replace(/_+/g, " "));
	return s || "Без названия";
}

/** Автор из имени вида «Название (Автор) (z-library…)», если такой хвост есть. */
export function authorFromFileName(fileName: string): string {
	const base = (fileName || "").split(/[\\/]/).pop() ?? "";
	if (!/z-?lib|1lib|libgen|z-library/i.test(base)) return "";
	const cleaned = base.replace(/\.(pdf|epub|fb2|txt|zip)$/i, "").replace(/\s*\((?:[^()]*\b(?:z-?lib|1lib|libgen|z-library)\b[^()]*)\)/gi, "");
	const m = /\(([^()]{2,80})\)\s*$/.exec(cleaned);
	return m ? cleanParagraph(m[1]) : "";
}

/** Убирает из названия автора, вытащенного из имени файла. */
export function stripAuthorFromTitle(title: string, author: string): string {
	if (!author) return title;
	const t = title.replace(new RegExp("\\s*\\(" + author.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\)\\s*$"), "");
	return t || title;
}

/** Медиана массива чисел (0 для пустого). */
export function median(values: number[]): number {
	if (!values.length) return 0;
	const s = [...values].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Перцентиль (0..1) массива чисел. */
export function percentile(values: number[], p: number): number {
	if (!values.length) return 0;
	const s = [...values].sort((a, b) => a - b);
	const i = Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))));
	return s[i];
}
