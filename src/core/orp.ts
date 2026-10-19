// Точка опоры (красная буква). Правило длины — как у Spritz и Speeedy (MIT, © 2026 Speeedy):
// 1 буква → 0, 2–5 → 1, 6–9 → 2, дальше → 3 (индекс буквы без учёта знаков вокруг слова).

export interface OrpParts {
	before: string;
	pivot: string;
	after: string;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

export function orpIndex(letters: number): number {
	if (letters <= 1) return 0;
	if (letters <= 5) return 1;
	if (letters <= 9) return 2;
	return 3;
}

export function splitOrp(text: string): OrpParts {
	const chars = Array.from(text);
	let first = -1;
	let last = -1;
	let letters = 0;
	for (let i = 0; i < chars.length; i++) {
		if (WORD_CHAR.test(chars[i])) {
			if (first < 0) first = i;
			last = i;
		}
	}
	if (first < 0) {
		// Одна пунктуация: опора — середина
		const mid = Math.floor((chars.length - 1) / 2);
		return {
			before: chars.slice(0, mid).join(""),
			pivot: chars[mid] ?? "",
			after: chars.slice(mid + 1).join(""),
		};
	}
	for (let i = first; i <= last; i++) if (WORD_CHAR.test(chars[i])) letters++;
	const target = orpIndex(letters);
	let seen = 0;
	let pivotAt = first;
	for (let i = first; i <= last; i++) {
		if (!WORD_CHAR.test(chars[i])) continue;
		if (seen === target) {
			pivotAt = i;
			break;
		}
		seen++;
	}
	return {
		before: chars.slice(0, pivotAt).join(""),
		pivot: chars[pivotAt],
		after: chars.slice(pivotAt + 1).join(""),
	};
}
