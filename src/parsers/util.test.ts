import { describe, expect, it } from "vitest";
import { joinTitleLines } from "./headings";
import { GAP, authorFromFileName, cleanParagraph, isNoteMarker, joinLines, titleFromFileName } from "./util";

const NBSP = "\u00A0";

describe("cleanParagraph", () => {
	it("схлопывает ASCII-пробелы и сохраняет неразрывный", () => {
		expect(cleanParagraph("  Привет,\t\n  мир  ")).toBe("Привет, мир");
		expect(cleanParagraph(`—${NBSP}Привет`)).toBe(`—${NBSP}Привет`);
		expect(cleanParagraph(`10${NBSP}000 рублей`)).toBe(`10${NBSP}000 рублей`);
	});

	it("убирает мягкий перенос и символы нулевой ширины", () => {
		expect(cleanParagraph("при\u00ADвет\u200B мир\uFEFF")).toBe("привет мир");
	});

	it("неразрывный рядом с обычным пробелом не даёт пустого слова", () => {
		const p = cleanParagraph(`слово ${NBSP} слово`);
		expect(p).toBe("слово слово");
		expect(p.split(" ").every((w) => w.trim().length > 0)).toBe(true);
	});

	it("юникод-пробелы", () => {
		expect(cleanParagraph("a\u2003b\u3000c")).toBe("a b c");
		expect(cleanParagraph("10\u2009000")).toBe(`10${NBSP}000`);
		expect(cleanParagraph("a\u202Fb")).toBe(`a${NBSP}b`);
	});

	it("метка вырезанной сноски не оставляет пробела перед знаком препинания", () => {
		expect(cleanParagraph(`архетипов\u200A${GAP}. Дальше`)).toBe("архетипов. Дальше");
		expect(cleanParagraph(`знаком ${GAP} , можно`)).toBe("знаком, можно");
		expect(cleanParagraph(`слово ${GAP} слово`)).toBe("слово слово");
	});
});

describe("joinLines", () => {
	it("снимает перенос слова", () => {
		expect(joinLines("большое приве-", "тствие всем")).toBe("большое приветствие всем");
		expect(joinLines("infor-", "mation")).toBe("information");
	});
	it("оставляет дефис в словах через дефис", () => {
		expect(joinLines("кто-", "то пришёл")).toBe("кто-то пришёл");
		expect(joinLines("сказал по-", "русски")).toBe("сказал по-русски");
		expect(joinLines("Нью-", "Йорк")).toBe("Нью-Йорк");
	});
	it("обычные строки через пробел", () => {
		expect(joinLines("первая строка", "вторая")).toBe("первая строка вторая");
	});
});

describe("мелочи", () => {
	it("маркеры сносок", () => {
		for (const m of ["1", "[1]", "{12}", "*", "**", "(3)", "4)", "[a]", "†"]) expect(isNoteMarker(m)).toBe(true);
		for (const m of ["слово", "1999 год", "[длинный текст]", ""]) expect(isNoteMarker(m)).toBe(false);
	});

	it("название из имени файла", () => {
		expect(titleFromFileName("Krol_Teoriya-kast-i-roley.bakGOQ.582116.fb2")).toBe("Krol Teoriya-kast-i-roley");
		expect(titleFromFileName("Книга.fb2.zip")).toBe("Книга");
		expect(titleFromFileName("Confidential (John Nolan) (z-library.sk, 1lib.sk, z-lib.sk).pdf")).toBe("Confidential (John Nolan)");
		expect(authorFromFileName("Confidential (John Nolan) (z-library.sk, 1lib.sk, z-lib.sk).pdf")).toBe("John Nolan");
		expect(authorFromFileName("Просто книга (2-е издание).pdf")).toBe("");
	});

	it("склейка строк заголовка", () => {
		expect(joinTitleLines(["Глава 1", "Начало пути"])).toBe("Глава 1. Начало пути");
		expect(joinTitleLines(["Скрывай", "свои намерения"])).toBe("Скрывай свои намерения");
		expect(joinTitleLines(["ИСПОЛЬЗУЙ ПРИМАНКИ", "И ОТВЛЕКАЮЩИЕ МАНЕВРЫ,", "ЧТОБЫ СБИТЬ"])).toBe(
			"ИСПОЛЬЗУЙ ПРИМАНКИ И ОТВЛЕКАЮЩИЕ МАНЕВРЫ, ЧТОБЫ СБИТЬ",
		);
		expect(joinTitleLines(["Часть I", "Юные годы"])).toBe("Часть I. Юные годы");
	});
});
