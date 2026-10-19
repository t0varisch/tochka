import { describe, expect, it } from "vitest";
import { BookParseError, parseFile, sniffFormat } from "./index";
import { fileFrom, makeZip, utf8 } from "./test-fixtures";

describe("parseFile: определение формата", () => {
	it("сигнатуры", () => {
		expect(sniffFormat(new Uint8Array([0x50, 0x4b, 3, 4, 0]))).toBe("zip");
		expect(sniffFormat(utf8("%PDF-1.7\n..."))).toBe("pdf");
		expect(sniffFormat(utf8(`<?xml version="1.0"?>\n<FictionBook xmlns="x">`))).toBe("fb2");
		expect(sniffFormat(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1]))).toBe("ole");
		expect(sniffFormat(utf8("просто текст"))).toBe("unknown");
	});

	it("FB2 в UTF-16 с BOM узнаётся по содержимому, а не по расширению", async () => {
		const xml = `<?xml version="1.0" encoding="UTF-16"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><body><section><p>Текст в UTF-16.</p></section></body></FictionBook>`;
		const bytes = new Uint8Array(2 + xml.length * 2);
		bytes[0] = 0xff;
		bytes[1] = 0xfe;
		for (let i = 0; i < xml.length; i++) {
			bytes[2 + i * 2] = xml.charCodeAt(i) & 0xff;
			bytes[3 + i * 2] = xml.charCodeAt(i) >> 8;
		}
		const book = await parseFile(fileFrom(bytes, "книга.txt"));
		expect(book.format).toBe("fb2");
		expect(book.paragraphs).toEqual(["Текст в UTF-16."]);
	});

	it("понятные ошибки на русском", async () => {
		await expect(parseFile(fileFrom(new Uint8Array(), "пусто.fb2"))).rejects.toThrow("Файл пустой");
		await expect(parseFile(fileFrom(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2]), "старый.doc"))).rejects.toThrow(/Word/);
		await expect(parseFile(fileFrom(new Uint8Array([0, 1, 2, 3, 0, 0, 7, 0]), "что-то.bin"))).rejects.toThrow("Не удалось распознать формат файла");
		await expect(parseFile(fileFrom(await makeZip({ "a.png": new Uint8Array([1, 2, 3]) }), "архив.zip"))).rejects.toThrow(/В архиве нет книги/);
		await expect(parseFile(fileFrom(utf8("не zip"), "книга.epub"))).rejects.toThrow(/повреждён/);
		const err = await parseFile(fileFrom(new Uint8Array([0, 1, 0, 2]), "x.bin")).catch((e) => e);
		expect(err).toBeInstanceOf(BookParseError);
		expect(err).toBeInstanceOf(Error);
	});

	it("TXT внутри zip", async () => {
		const zip = await makeZip({ "readme.txt": utf8("Первая строка.\nВторая строка.") });
		const book = await parseFile(fileFrom(zip, "текст.zip"));
		expect(book.format).toBe("txt");
		expect(book.paragraphs).toEqual(["Первая строка.", "Вторая строка."]);
	});
});
