import { describe, expect, it } from "vitest";
import { parseFile, type PdfjsModule } from "./index";
import { buildPdf, fileFrom, type PdfLine } from "./test-fixtures";

const legacy = async () => (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsModule;

/** Строки тела страницы: [отступ?, текст] сверху вниз с шагом 14. */
function body(lines: [boolean, string][], top = 660): PdfLine[] {
	return lines.map(([indent, text], i) => ({ text, x: indent ? 90 : 72, y: top - i * 14 }));
}

function page(n: number, lines: PdfLine[]): PdfLine[] {
	return [{ text: "THE TEST BOOK", x: 250, y: 760, size: 9 }, ...lines, { text: String(n), x: 300, y: 40, size: 9 }];
}

const heading = (text: string): PdfLine => ({ text, x: 72, y: 700, size: 18 });

const PAGES: PdfLine[][] = [
	page(1, [
		heading("Chapter One"),
		...body([
			[true, "This is the first paragraph of the test book. It has several lines of text"],
			[false, "that wrap across the page so that the parser can join them into one para-"],
			[false, "graph and remove the hyphen at the end of the previous line. The last"],
			[false, "line is short."],
			[true, "The second paragraph starts with an indent. It also continues on the next"],
			[false, "line and ends here."],
			[true, "A third paragraph begins near the bottom of the first page and its text"],
			[false, "continues on the following page without any break in the middle of the"],
		]),
	]),
	page(2, body([
		[false, "sentence, which must be joined with the previous page into one paragraph."],
		[true, "Fourth paragraph on the second page, written to have a few more lines of"],
		[false, "ordinary text so that the page has enough lines to measure the margins and"],
		[false, "the typical line spacing of the body text on this page of the document."],
	], 700)),
	page(3, [
		heading("Chapter Two"),
		...body([
			[true, "The second chapter opens with this paragraph, which again contains enough"],
			[false, "words to fill a couple of lines and to give the parser something to read."],
			[true, "Final paragraph of the chapter is right here and it is the last one, and"],
			[false, "it ends here."],
		]),
	]),
	page(4, body([
		[true, "Page four holds an extra paragraph to make the running header repeat on"],
		[false, "enough pages, so that it is recognised and removed from the final text."],
		[false, "One more line keeps the page measurable for margins and line spacing."],
	], 700)),
	page(5, body([
		[true, "Page five is the last page and ends the book with one more short note and"],
		[false, "says goodbye and thank you for reading this small synthetic test file, the"],
		[false, "end."],
	], 700)),
];

describe("PDF", () => {
	it("строки → абзацы; колонтитулы и номера страниц убраны; оглавление из закладок", async () => {
		const pdf = buildPdf({
			pages: PAGES,
			title: "Test Book PDF",
			author: "Jane Roe",
			outline: [
				{ title: "Chapter One", page: 0, y: 720 },
				{ title: "Chapter Two", page: 2, y: 720 },
			],
		});
		const progress: number[] = [];
		const book = await parseFile(fileFrom(pdf, "test.pdf"), { pdfjs: legacy, onProgress: (f) => progress.push(f) });
		expect(book.format).toBe("pdf");
		expect(book.title).toBe("Test Book PDF");
		expect(book.author).toBe("Jane Roe");
		expect(book.paragraphs).toEqual([
			"Chapter One",
			"This is the first paragraph of the test book. It has several lines of text that wrap across the page so that the parser can join them into one paragraph and remove the hyphen at the end of the previous line. The last line is short.",
			"The second paragraph starts with an indent. It also continues on the next line and ends here.",
			"A third paragraph begins near the bottom of the first page and its text continues on the following page without any break in the middle of the sentence, which must be joined with the previous page into one paragraph.",
			"Fourth paragraph on the second page, written to have a few more lines of ordinary text so that the page has enough lines to measure the margins and the typical line spacing of the body text on this page of the document.",
			"Chapter Two",
			"The second chapter opens with this paragraph, which again contains enough words to fill a couple of lines and to give the parser something to read.",
			"Final paragraph of the chapter is right here and it is the last one, and it ends here.",
			"Page four holds an extra paragraph to make the running header repeat on enough pages, so that it is recognised and removed from the final text. One more line keeps the page measurable for margins and line spacing.",
			"Page five is the last page and ends the book with one more short note and says goodbye and thank you for reading this small synthetic test file, the end.",
		]);
		expect(book.toc).toEqual([
			{ title: "Chapter One", level: 0, paragraph: 0 },
			{ title: "Chapter Two", level: 0, paragraph: 5 },
		]);
		expect(progress.length).toBeGreaterThanOrEqual(5);
		expect(progress.at(-1)).toBe(1);
		for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);
	});

	it("пустые метаданные → название из имени файла", async () => {
		const pdf = buildPdf({ pages: PAGES, title: "untitled" });
		const book = await parseFile(fileFrom(pdf, "Моя книга.pdf"), { pdfjs: legacy });
		expect(book.title).toBe("Моя книга");
		expect(book.author).toBe("");
	});

	it("PDF без текста — ошибка про скан", async () => {
		const pdf = buildPdf({ pages: [[], [], []] });
		await expect(parseFile(fileFrom(pdf, "scan.pdf"), { pdfjs: legacy })).rejects.toThrow("В PDF нет текста — похоже, это скан");
	});

	it("не PDF с расширением .pdf — понятная ошибка", async () => {
		await expect(parseFile(fileFrom(new Uint8Array([1, 2, 3, 0, 0, 5]), "broken.pdf"), { pdfjs: legacy })).rejects.toThrow(/повреждён/);
	});
});
