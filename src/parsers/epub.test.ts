import { describe, expect, it } from "vitest";
import { parseEpub } from "./epub";
import { parseFile } from "./index";
import { encodeSingleByte, fileFrom, makeZip } from "./test-fixtures";

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const XHTML_HEAD = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">`;

function epub3Files(): Record<string, string | Uint8Array> {
	return {
		mimetype: "application/epub+zip",
		"META-INF/container.xml": CONTAINER,
		"OEBPS/content.opf": `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="id">urn:uuid:1</dc:identifier>
<dc:title>Книга EPUB3</dc:title>
<dc:creator id="c1">Анна Автор</dc:creator>
<dc:creator id="c2">Пётр Переводчик</dc:creator>
<meta refines="#c2" property="role" scheme="marc:relators">trl</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
<item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
<item id="notes" href="text/notes.xhtml" media-type="application/xhtml+xml"/>
<item id="css" href="style.css" media-type="text/css"/>
<item id="pic" href="img/pic.png" media-type="image/png"/>
</manifest>
<spine><itemref idref="nav"/><itemref idref="ch1"/><itemref idref="ch2"/><itemref idref="notes" linear="no"/></spine>
</package>`,
		"OEBPS/nav.xhtml": `${XHTML_HEAD}<head><title>Оглавление</title></head><body>
<nav epub:type="toc"><h1>СОДЕРЖАНИЕ НАВИГАЦИИ</h1><ol>
<li><a href="text/ch1.xhtml">Глава 1</a></li>
<li><a href="text/ch2.xhtml#s1">Глава 2</a><ol><li><a href="text/ch2.xhtml#s2">Раздел 2.1</a></li></ol></li>
<li><span>Без ссылки</span><ol><li><a href="text/ch2.xhtml#s3">Раздел 2.2</a></li></ol></li>
<li><a href="text/notes.xhtml">Примечания</a></li>
<li><a href="text/missing.xhtml">Нет такого файла</a></li>
</ol></nav>
<nav epub:type="landmarks"><ol><li><a href="text/ch1.xhtml">ОРИЕНТИР</a></li></ol></nav>
</body></html>`,
		"OEBPS/text/ch1.xhtml": `${XHTML_HEAD}<head><title>СЛУЖЕБНЫЙ ЗАГОЛОВОК</title><style>p { color: red }</style><script>var x = "СКРИПТ";</script></head>
<body><section>
<h1>Глава 1</h1>
<p>Первый абзац<a epub:type="noteref" href="notes.xhtml#n1">1</a> с жирным <b>словом</b>.</p>
<div>Текст в div <p>и вложенный абзац</p> хвост div</div>
<p>Строка стиха<br/>вторая строка</p>
<p>Абзац со сноской<sup><a href="#fn2">2</a></sup>.</p>
<aside epub:type="footnote" id="fn2"><p>ВНУТРЕННЯЯ СНОСКА</p></aside>
<p><img src="../img/pic.png" alt="КАРТИНКА"/>Подпись&nbsp;после картинки</p>
<svg xmlns="http://www.w3.org/2000/svg"><text>SVG ТЕКСТ</text></svg>
<ul><li>Пункт один</li><li>Пункт два</li></ul>
</section></body></html>`,
		"OEBPS/text/ch2.xhtml": `${XHTML_HEAD}<head><title>x</title></head><body>
<h2 id="s1">Глава 2</h2><p>Текст главы два.</p>
<h3 id="s2">Раздел 2.1</h3><p>Текст раздела. <a href="ch1.xhtml">Обычная ссылка</a> остаётся.</p>
<h3 id="s3">Раздел 2.2</h3><p>Последний<a href="notes.xhtml#n3">[3]</a> абзац.</p>
</body></html>`,
		"OEBPS/text/notes.xhtml": `${XHTML_HEAD}<head><title>Примечания</title></head><body>
<h2>Примечания</h2>
<section epub:type="endnotes"><ol><li id="n1"><p>ТЕКСТ СНОСКИ 1</p></li><li id="n3"><p>ТЕКСТ СНОСКИ 3</p></li></ol></section>
</body></html>`,
		"OEBPS/style.css": "p { margin: 0 }",
		"OEBPS/img/pic.png": new Uint8Array([137, 80, 78, 71]),
	};
}

const EPUB3_TEXT = [
	"Глава 1",
	"Первый абзац с жирным словом.",
	"Текст в div",
	"и вложенный абзац",
	"хвост div",
	"Строка стиха вторая строка",
	"Абзац со сноской.",
	"Подпись\u00A0после картинки",
	"Пункт один",
	"Пункт два",
	"Глава 2",
	"Текст главы два.",
	"Раздел 2.1",
	"Текст раздела. Обычная ссылка остаётся.",
	"Раздел 2.2",
	"Последний абзац.",
];

const NOTES_EPUB2 = `${XHTML_HEAD}<head><title>n</title></head><body>
<div class="title"><p class="p">Примечания</p></div>
<span id="id7"><div class="title5"><p class="p">1</p></div><p class="p1">ТЕКСТ СНОСКИ КАЛИБРА</p></span>
</body></html>`;

function epub2Files(): Record<string, string | Uint8Array> {
	return {
		mimetype: "application/epub+zip",
		"META-INF/container.xml": CONTAINER,
		"OEBPS/content.opf": `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:opf="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>Книга EPUB2</dc:title>
<dc:creator opf:role="aut">Иван Иванов</dc:creator>
<dc:creator opf:role="ill">Художник Рисующий</dc:creator>
</metadata>
<manifest>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="cover" href="Text/cover.xhtml" media-type="application/xhtml+xml"/>
<item id="tocpage" href="Text/toc.xhtml" media-type="application/xhtml+xml"/>
<item id="ch1" href="Text/%D0%93%D0%BB%D0%B0%D0%B2%D0%B0%201.xhtml" media-type="application/xhtml+xml"/>
<item id="ch2" href="Text/ch2.html" media-type="application/xhtml+xml"/>
<item id="notes" href="Text/notes.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine toc="ncx"><itemref idref="cover"/><itemref idref="tocpage"/><itemref idref="ch1"/><itemref idref="ch2"/><itemref idref="notes"/></spine>
</package>`,
		"OEBPS/toc.ncx": `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
<navPoint id="n0" playOrder="0"><navLabel><text>Обложка</text></navLabel><content src="Text/cover.xhtml"/></navPoint>
<navPoint id="n1" playOrder="1"><navLabel><text>Глава 1</text></navLabel><content src="Text/%D0%93%D0%BB%D0%B0%D0%B2%D0%B0%201.xhtml"/>
  <navPoint id="n2" playOrder="2"><navLabel><text>Сцена</text></navLabel><content src="Text/%D0%93%D0%BB%D0%B0%D0%B2%D0%B0%201.xhtml#scene"/></navPoint>
</navPoint>
<navPoint id="n3" playOrder="3"><navLabel><text>Глава 2</text></navLabel><content src="Text/ch2.html#top"/></navPoint>
</navMap></ncx>`,
		"OEBPS/Text/cover.xhtml": `${XHTML_HEAD}<head><title>c</title></head><body><div><img src="../cover.jpg"/></div></body></html>`,
		"OEBPS/Text/toc.xhtml": `${XHTML_HEAD}<head><title>t</title></head><body><h1>Содержание</h1>
<p><a href="Глава%201.xhtml">Глава 1</a></p><p><a href="ch2.html">Глава 2</a></p><p><a href="ch2.html#x">Глава 2, часть 2</a></p></body></html>`,
		// глава в windows-1251 с объявлением кодировки
		"OEBPS/Text/Глава 1.xhtml": encodeSingleByte(
			`<?xml version="1.0" encoding="windows-1251"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>
<h1>Глава 1</h1><p>Текст с <a href="notes.xhtml#id7" class="a">[1]</a> сноской.</p><p id="scene">Сцена вторая.</p>
</body></html>`,
			"windows-1251",
		),
		// небрежный HTML: незакрытые теги, &nbsp;
		"OEBPS/Text/ch2.html": `<html><body><a id="top"></a><h2>Глава 2<br>Подзаголовок</h2><p>Текст&nbsp;главы<p>Незакрытый абзац</body></html>`,
		"OEBPS/Text/notes.xhtml": NOTES_EPUB2,
	};
}

function assertClean(paragraphs: string[]): void {
	const all = paragraphs.join("\n");
	for (const bad of ["СЛУЖЕБН", "СКРИПТ", "color", "SVG", "КАРТИНКА", "СНОСК", "СОДЕРЖАНИЕ НАВИГАЦИИ", "ОРИЕНТИР", "Примечания", "Содержание"]) {
		expect(all).not.toContain(bad);
	}
	expect(all).not.toMatch(/<\/?[a-zA-Z][^>]{0,40}>/);
	for (const p of paragraphs) expect(p).not.toMatch(/[\t\n\r]| {2}|^\s|\s$/);
}

describe("EPUB", () => {
	it("EPUB3: nav-оглавление, без скриптов, сносок, картинок и самого nav", async () => {
		const book = await parseEpub(await makeZip(epub3Files(), true), "x.epub");
		expect(book.title).toBe("Книга EPUB3");
		expect(book.author).toBe("Анна Автор");
		expect(book.format).toBe("epub");
		expect(book.paragraphs).toEqual(EPUB3_TEXT);
		assertClean(book.paragraphs);
		expect(book.toc).toEqual([
			{ title: "Глава 1", level: 0, paragraph: 0 },
			{ title: "Глава 2", level: 0, paragraph: 10 },
			{ title: "Раздел 2.1", level: 1, paragraph: 12 },
			{ title: "Без ссылки", level: 0, paragraph: 14 },
			{ title: "Раздел 2.2", level: 1, paragraph: 14 },
		]);
	});

	it("EPUB2: NCX, %-кодированные пути, cp1251, страница-оглавление и сноски калибра", async () => {
		const progress: number[] = [];
		const book = await parseEpub(await makeZip(epub2Files(), true), "y.epub", (f) => progress.push(f));
		expect(book.title).toBe("Книга EPUB2");
		expect(book.author).toBe("Иван Иванов");
		expect(book.paragraphs).toEqual(["Глава 1", "Текст с сноской.", "Сцена вторая.", "Глава 2 Подзаголовок", "Текст\u00A0главы", "Незакрытый абзац"]);
		assertClean(book.paragraphs);
		expect(book.toc).toEqual([
			{ title: "Глава 1", level: 0, paragraph: 0 },
			{ title: "Сцена", level: 1, paragraph: 2 },
			{ title: "Глава 2", level: 0, paragraph: 3 },
		]);
		expect(progress.at(-1)).toBe(1);
	});

	it("DRM: зашифрованный текст — понятная ошибка; зашифрованные шрифты — не DRM", async () => {
		const enc = (uri: string) => `<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
<enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>
<enc:CipherData><enc:CipherReference URI="${uri}"/></enc:CipherData></enc:EncryptedData></encryption>`;
		const drm = await makeZip({ ...epub3Files(), "META-INF/encryption.xml": enc("OEBPS/text/ch1.xhtml") }, true);
		await expect(parseFile(fileFrom(drm, "drm.epub"))).rejects.toThrow("Книга защищена DRM — такие не открываются");
		const fonts = await makeZip({ ...epub3Files(), "META-INF/encryption.xml": enc("OEBPS/fonts/a.otf") }, true);
		expect((await parseFile(fileFrom(fonts, "fonts.epub"))).paragraphs).toEqual(EPUB3_TEXT);
	});

	it("«.fb2.epub» и «.zip» определяются по содержимому как EPUB", async () => {
		const bytes = await makeZip(epub3Files(), true);
		expect((await parseFile(fileFrom(bytes, "Книга.fb2.epub"))).format).toBe("epub");
		expect((await parseFile(fileFrom(bytes, "Книга.zip"))).format).toBe("epub");
	});
});
