// Определение кодировки: BOM, объявление в XML/HTML, проверка UTF-8, угадывание кириллицы.

export type Utf = "utf-8" | "utf-16le" | "utf-16be";

export interface Decoded {
	text: string;
	encoding: string;
}

/** BOM в начале файла. */
export function detectBom(b: Uint8Array): { encoding: Utf; length: number } | null {
	if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { encoding: "utf-8", length: 3 };
	if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return { encoding: "utf-16le", length: 2 };
	if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return { encoding: "utf-16be", length: 2 };
	return null;
}

/** UTF-16 без BOM: по нулевым байтам (латиница) и 0x04 (кириллица) на чётных/нечётных местах. */
export function detectUtf16NoBom(b: Uint8Array): Utf | null {
	const n = Math.min(b.length, 4096) & ~1;
	if (n < 8) return null;
	let evenHi = 0;
	let oddHi = 0;
	for (let i = 0; i < n; i += 2) {
		if (b[i] === 0 || b[i] === 4) evenHi++;
		if (b[i + 1] === 0 || b[i + 1] === 4) oddHi++;
	}
	const half = n / 2;
	if (oddHi > half * 0.6 && evenHi < half * 0.1) return "utf-16le";
	if (evenHi > half * 0.6 && oddHi < half * 0.1) return "utf-16be";
	return null;
}

/** Первые байты как latin1 (без нулевых байтов — чтобы ASCII в UTF-16 тоже читался). */
export function latin1Head(b: Uint8Array, n = 1024): string {
	const end = Math.min(b.length, n);
	let s = "";
	for (let i = 0; i < end; i++) if (b[i] !== 0) s += String.fromCharCode(b[i]);
	return s;
}

const ALIASES: Record<string, string> = {
	"win-1251": "windows-1251",
	win1251: "windows-1251",
	windows1251: "windows-1251",
	"cp-1251": "windows-1251",
	"windows-cp1251": "windows-1251",
	koi8r: "koi8-r",
	"koi-8r": "koi8-r",
	"koi8-u": "koi8-u",
	utf8: "utf-8",
	"utf-16": "utf-16le",
	utf16: "utf-16le",
	"dos-866": "ibm866",
	"cp-866": "ibm866",
};

/** Ярлык кодировки, понятный TextDecoder, или null. */
export function normalizeEncodingLabel(label: string | null | undefined): string | null {
	if (!label) return null;
	let l = label.trim().toLowerCase();
	l = ALIASES[l] ?? l;
	try {
		return new TextDecoder(l).encoding;
	} catch {
		return null;
	}
}

/** Кодировка из объявления XML (`encoding="…"`) или из `<meta charset>` в первых байтах. */
export function sniffDeclaredEncoding(b: Uint8Array): string | null {
	const head = latin1Head(b, 2048);
	const xml = /^\s*<\?xml[^>]*?\bencoding\s*=\s*["']\s*([A-Za-z0-9._:-]+)\s*["']/i.exec(head);
	if (xml) return xml[1];
	const meta = /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9._:-]+)/i.exec(head);
	if (meta) return meta[1];
	return null;
}

function hasNonAscii(b: Uint8Array): boolean {
	for (let i = 0; i < b.length; i++) if (b[i] >= 0x80) return true;
	return false;
}

/**
 * Пробует UTF-8. Строго, но прощает обрезанный хвост и единичные битые байты
 * (на фоне большого числа корректных не-ASCII символов). Иначе null.
 */
export function tryUtf8(b: Uint8Array): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(b);
	} catch {
		const s = new TextDecoder("utf-8").decode(b);
		let bad = 0;
		let good = 0;
		for (let i = 0; i < s.length; i++) {
			const c = s.charCodeAt(i);
			if (c === 0xfffd) bad++;
			else if (c >= 0x80) good++;
		}
		if (bad <= 3 && good >= bad * 50) return s.replace(/�/g, "");
		if (good > 0 && bad / (good + bad) < 0.001) return s.replace(/�/g, "");
		return null;
	}
}

const COMMON_RU = "оеаинтсрвл";

/** Сколько символов строки — частые строчные русские буквы. */
function cyrillicScore(s: string): number {
	let n = 0;
	for (let i = 0; i < s.length; i++) if (COMMON_RU.includes(s[i])) n++;
	return n;
}

/**
 * Однобайтовая кодировка для текста не в UTF-8: windows-1251, koi8-r или ibm866
 * (по частоте строчных русских букв), windows-1252 — если кириллицы не видно.
 */
export function guessSingleByte(b: Uint8Array): string {
	const sample = b.subarray(0, Math.min(b.length, 128 * 1024));
	let high = 0;
	for (let i = 0; i < sample.length; i++) if (sample[i] >= 0x80) high++;
	if (high === 0) return "windows-1251";
	let best = "windows-1251";
	let bestScore = -1;
	for (const enc of ["windows-1251", "koi8-r", "ibm866"]) {
		const score = cyrillicScore(new TextDecoder(enc).decode(sample));
		if (score > bestScore) {
			best = enc;
			bestScore = score;
		}
	}
	// русский текст: эти 10 букв — около двух третей всех букв
	if (bestScore < high * 0.15) return "windows-1252";
	return best;
}

function decodeWith(b: Uint8Array, encoding: string): string {
	return new TextDecoder(encoding).decode(b);
}

/** Простой текст: BOM → UTF-16 без BOM → UTF-8 → угадывание кириллицы. */
export function decodeText(b: Uint8Array): Decoded {
	const bom = detectBom(b);
	if (bom) return { text: decodeWith(b.subarray(bom.length), bom.encoding), encoding: bom.encoding };
	const u16 = detectUtf16NoBom(b);
	if (u16) return { text: decodeWith(b, u16), encoding: u16 };
	if (!hasNonAscii(b)) return { text: decodeWith(b, "utf-8"), encoding: "utf-8" };
	const utf8 = tryUtf8(b);
	if (utf8 !== null) return { text: utf8, encoding: "utf-8" };
	const enc = guessSingleByte(b);
	return { text: decodeWith(b, enc), encoding: enc };
}

/**
 * XML/HTML: BOM → UTF-16 без BOM → корректный UTF-8 (даже если объявлено другое) →
 * объявленная кодировка → угадывание.
 */
export function decodeMarkup(b: Uint8Array): Decoded {
	const bom = detectBom(b);
	if (bom) return { text: decodeWith(b.subarray(bom.length), bom.encoding), encoding: bom.encoding };
	const u16 = detectUtf16NoBom(b);
	if (u16) return { text: decodeWith(b, u16), encoding: u16 };
	if (!hasNonAscii(b)) return { text: decodeWith(b, "utf-8"), encoding: "utf-8" };
	const declared = normalizeEncodingLabel(sniffDeclaredEncoding(b));
	// UTF-8 с не-ASCII байтами почти никогда не бывает случайно валидным в cp1251/koi8
	const utf8 = tryUtf8(b);
	if (utf8 !== null) return { text: utf8, encoding: "utf-8" };
	if (declared && declared !== "utf-8" && !declared.startsWith("utf-16")) {
		return { text: decodeWith(b, declared), encoding: declared };
	}
	const enc = guessSingleByte(b);
	return { text: decodeWith(b, enc), encoding: enc };
}
