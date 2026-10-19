import { describe, expect, it } from "vitest";
import { parseFb2, parseFb2String } from "./fb2";
import { parseFile } from "./index";
import { encodeSingleByte, fileFrom, makeZip, utf8 } from "./test-fixtures";

const BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==".repeat(40);

function fb2Xml(opts: { notesName?: string } = {}): string {
	const notesAttr = opts.notesName === undefined ? ` name="notes"` : opts.notesName ? ` name="${opts.notesName}"` : "";
	return `<?xml version="1.0" encoding="windows-1251"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<stylesheet type="text/css">p { text-indent: 1em }</stylesheet>
<description>
 <title-info>
  <genre>prose_classic</genre>
  <author><first-name>Лев</first-name><middle-name>Николаевич</middle-name><last-name>Толстой</last-name></author>
  <author><nickname>Аноним</nickname></author>
  <book-title>Тестовая книга</book-title>
  <annotation><p>СЛУЖЕБНАЯ АННОТАЦИЯ</p></annotation>
  <coverpage><image l:href="#cover.jpg"/></coverpage>
  <lang>ru</lang>
 </title-info>
 <document-info><author><nickname>Конвертер</nickname></author><program-used>FictionBook Editor</program-used><id>ABC-123</id></document-info>
 <publish-info><publisher>СЛУЖЕБНОЕ ИЗДАТЕЛЬСТВО</publisher></publish-info>
</description>
<body>
 <title><p>Лев Толстой</p><p>Тестовая книга</p></title>
 <epigraph><p>Эпиграф к книге.</p><text-author>Мудрец</text-author></epigraph>
 <section id="p1">
  <title><p>Часть первая</p><p>Начало</p></title>
  <section id="c1">
   <title><p>Глава 1</p></title>
   <p>Первый абзац <emphasis>с курсивом</emphasis> и <strong>жирным</strong> текстом <a l:href="#n1" type="note">[1]</a>.</p>
   <empty-line/>
   <p>Второй абзац со сноской без типа<a l:href="#n2">2</a> и обычной <a l:href="http://example.com">ссылкой</a>.</p>
   <image l:href="#pic.png"/>
   <poem><title><p>Стих</p></title><stanza><v>Строка один,</v><v>строка два.</v></stanza><text-author>Поэт</text-author></poem>
   <cite><p>Цитата из книги.</p><text-author>Автор цитаты</text-author></cite>
   <subtitle>* * *</subtitle>
   <table><tr><th>Заголовок</th><td>Ячейка</td></tr></table>
  </section>
  <section id="c2">
   <title><p>Глава 2</p><p>Продолжение</p></title>
   <section><title><p>Подглава 2.1</p></title><p>Текст подглавы с неразрывным&#160;пробелом и мяг&#173;ким переносом.</p></section>
  </section>
 </section>
 <section id="p2">
  <title><p>Часть вторая</p></title>
  <p>Последний абзац книги.</p>
 </section>
</body>
<body${notesAttr}>
 <title><p>Примечания</p></title>
 <section id="n1"><title><p>1</p></title><p>ТЕКСТ СНОСКИ ОДИН</p></section>
 <section id="n2"><title><p>2</p></title><p>ТЕКСТ СНОСКИ ДВА</p></section>
</body>
<binary id="cover.jpg" content-type="image/jpeg">${BASE64}</binary>
<binary id="pic.png" content-type="image/png">${BASE64}</binary>
</FictionBook>`;
}

const EXPECTED = [
	"Лев Толстой",
	"Тестовая книга",
	"Эпиграф к книге.",
	"Мудрец",
	"Часть первая",
	"Начало",
	"Глава 1",
	"Первый абзац с курсивом и жирным текстом.",
	"Второй абзац со сноской без типа и обычной ссылкой.",
	"Стих",
	"Строка один,",
	"строка два.",
	"Поэт",
	"Цитата из книги.",
	"Автор цитаты",
	"* * *",
	"Заголовок",
	"Ячейка",
	"Глава 2",
	"Продолжение",
	"Подглава 2.1",
	"Текст подглавы с неразрывным\u00A0пробелом и мягким переносом.",
	"Часть вторая",
	"Последний абзац книги.",
];

const EXPECTED_TOC = [
	{ title: "Часть первая. Начало", level: 0, paragraph: 4 },
	{ title: "Глава 1", level: 1, paragraph: 6 },
	{ title: "Глава 2. Продолжение", level: 1, paragraph: 18 },
	{ title: "Подглава 2.1", level: 2, paragraph: 20 },
	{ title: "Часть вторая", level: 0, paragraph: 22 },
];

function assertClean(paragraphs: string[]): void {
	const all = paragraphs.join("\n");
	for (const bad of ["СЛУЖЕБН", "Конвертер", "FictionBook Editor", "ABC-123", "СНОСКИ", "Примечания", "text-indent", "iVBOR", "[1]"]) {
		expect(all).not.toContain(bad);
	}
	expect(all).not.toMatch(/<\/?[a-zA-Z][^>]{0,40}>/);
	expect(all).not.toMatch(/[A-Za-z0-9+/]{80,}/);
	for (const p of paragraphs) {
		expect(p).toBe(p.trim());
		expect(p).not.toMatch(/[\t\n\r]| {2}|\u00AD/);
		expect(p.length).toBeGreaterThan(0);
	}
}

describe("FB2", () => {
	it("windows-1251: текст, автор, оглавление; без служебного, сносок и base64", () => {
		const bytes = encodeSingleByte(fb2Xml(), "windows-1251");
		const book = parseFb2(bytes, "book.fb2");
		expect(book.title).toBe("Тестовая книга");
		expect(book.author).toBe("Лев Николаевич Толстой, Аноним");
		expect(book.format).toBe("fb2");
		expect(book.paragraphs).toEqual(EXPECTED);
		expect(book.toc).toEqual(EXPECTED_TOC);
		assertClean(book.paragraphs);
		for (const e of book.toc) expect(e.title.startsWith(book.paragraphs[e.paragraph])).toBe(true);
	});

	it("тело сносок без имени тоже пропускается (на его секции ведут ссылки-сноски)", () => {
		const book = parseFb2(encodeSingleByte(fb2Xml({ notesName: "" }), "windows-1251"));
		expect(book.paragraphs).toEqual(EXPECTED);
	});

	it("тело name=comments пропускается", () => {
		const book = parseFb2(encodeSingleByte(fb2Xml({ notesName: "comments" }), "windows-1251"));
		expect(book.paragraphs).toEqual(EXPECTED);
	});

	it("битый XML открывается через запасной разбор, теги не просачиваются", () => {
		const xml = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info><author><last-name>Иванов</last-name></author><book-title>Битая книга</book-title><annotation><p>АННОТАЦИЯ</p></annotation></title-info></description>
<body><section><title><p>Глава 1</p></title><p>Текст & ещё текст&nbsp;тут</p><p>Незакрытый абзац<p>Следующий</p><style name="x">стиль <emphasis>курсив</emphasis></style><empty-line/><p>После пустой строки</p></section>
<section><title><p>Глава 2</p></title><p>Конец <b>жирный</p><image l:href="#x"/></section></body>
<binary id="x" content-type="image/png">${BASE64}</binary></FictionBook>`;
		const book = parseFb2String(xml);
		expect(book.title).toBe("Битая книга");
		expect(book.author).toBe("Иванов");
		expect(book.toc.map((e) => e.title)).toEqual(["Глава 1", "Глава 2"]);
		const all = book.paragraphs.join("\n");
		expect(all).toContain("Текст & ещё текст\u00A0тут");
		expect(all).toContain("курсив");
		expect(all).toContain("После пустой строки");
		expect(all).toContain("Конец жирный");
		expect(all).not.toContain("АННОТАЦИЯ");
		assertClean(book.paragraphs);
		for (const e of book.toc) expect(book.paragraphs[e.paragraph]).toBe(e.title);
	});

	it("parseFile: .fb2 и .fb2.zip дают одно и то же", async () => {
		const bytes = encodeSingleByte(fb2Xml(), "windows-1251");
		const progress: number[] = [];
		const plain = await parseFile(fileFrom(bytes, "Книга.fb2"), { onProgress: (f) => progress.push(f) });
		const zipped = await parseFile(fileFrom(await makeZip({ "Книга.fb2": bytes }), "Книга.fb2.zip"));
		expect(plain.paragraphs).toEqual(EXPECTED);
		expect(zipped.paragraphs).toEqual(EXPECTED);
		expect(zipped.toc).toEqual(EXPECTED_TOC);
		expect(progress.at(-1)).toBe(1);
	});

	it("FB2 в UTF-8 без объявления кодировки", () => {
		const xml = fb2Xml().replace(` encoding="windows-1251"`, "");
		expect(parseFb2(utf8(xml)).paragraphs).toEqual(EXPECTED);
	});
});
