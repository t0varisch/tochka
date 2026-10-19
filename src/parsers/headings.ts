// Распознавание заголовков глав в простом тексте и склейка многострочных заголовков.

const KEYWORD_RE =
	/^(глава|часть|книга|раздел|пролог|эпилог|предисловие|послесловие|введение|заключение|chapter|part|prologue|epilogue)(?![\p{L}\p{N}])/iu;
// После «глава/часть/книга/раздел/chapter/part» должен идти номер, а не продолжение фразы
const NUMBERED_KEYWORD_RE = /^(глава|часть|книга|раздел|chapter|part)$/i;
const NUMBER_TOKEN_RE =
	/^(\d+|[IVXLCDM]+|перв|втор|трет|четв[её]рт|пят|шест|седьм|восьм|девят|десят|одиннадцат|двенадцат|тринадцат|четырнадцат|пятнадцат|шестнадцат|семнадцат|восемнадцат|девятнадцат|двадцат|тридцат|сорок|пятидесят|шестидесят|семидесят|восьмидесят|девяност|сот|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|final|заключительн|последн)/i;
export const TOP_LEVEL_RE = /^(часть|книга|part)$/i;
const BARE_NUMBER_RE = /^(?:[IVXLC]{1,7}|\d{1,3})\.?$/;

/** Похож ли короткий абзац на заголовок главы. Возвращает ключевое слово или "#" для голого номера. */
export function headingKind(p: string): string | null {
	if (p.length >= 80) return null;
	if (BARE_NUMBER_RE.test(p)) return "#";
	const m = KEYWORD_RE.exec(p);
	if (!m) return null;
	const word = m[1].toLowerCase();
	const rest = p.slice(m[0].length).replace(/^[\s\u00A0.:—–-]+/, "");
	if (NUMBERED_KEYWORD_RE.test(word)) {
		if (!rest) return word;
		const token = rest.split(/[\s\u00A0.:,;—–-]+/)[0];
		return NUMBER_TOKEN_RE.test(token) ? word : null;
	}
	// пролог/эпилог/введение…: короткий заголовок, не начало фразы
	if (!rest) return word;
	if (rest.split(/\s+/).length > 8) return null;
	if (/[,;!?]$/.test(p) || (/\.$/.test(p) && !/^\p{L}+\.$/u.test(p))) return null;
	return word;
}

/**
 * Склеивает строки заголовка в одну строку для оглавления:
 * «Глава 1» + «Начало» → «Глава 1. Начало»; «Скрывай» + «свои намерения» → «Скрывай свои намерения».
 */
export function joinTitleLines(lines: string[], max = 150): string {
	let t = "";
	for (const l of lines) {
		if (!t) {
			t = l;
			continue;
		}
		let sep: string;
		if (/[.!?…:;]$/.test(t)) sep = " ";
		else if (/[,—–-]$/.test(t) || /^[\p{Ll}(]/u.test(l)) sep = " ";
		else if (headingKind(t) || /(^|\s)(\d+|[IVXLCDM]+)\.?$/.test(t)) sep = ". ";
		else if (!/\p{Ll}/u.test(t) && !/\p{Ll}/u.test(l)) sep = " ";
		else sep = ". ";
		t += sep + l;
	}
	return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}
