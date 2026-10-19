import { describe, expect, it } from "vitest";
import { decodeMarkup, decodeText, detectBom, normalizeEncodingLabel, sniffDeclaredEncoding } from "./decode";
import { encodeCp1251Basic, encodeSingleByte, utf8 } from "./test-fixtures";

const RU = "Съешь же ещё этих мягких французских булок, да выпей чаю. Ёлка и ёжик.";

describe("decode", () => {
	it("BOM", () => {
		expect(detectBom(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toEqual({ encoding: "utf-8", length: 3 });
		expect(detectBom(new Uint8Array([0xff, 0xfe, 0x41, 0]))).toEqual({ encoding: "utf-16le", length: 2 });
		expect(detectBom(new Uint8Array([0xfe, 0xff, 0, 0x41]))).toEqual({ encoding: "utf-16be", length: 2 });
		expect(detectBom(new Uint8Array([0x41, 0x42]))).toBeNull();
	});

	it("UTF-8 с BOM и без", () => {
		expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(RU)])).text).toBe(RU);
		expect(decodeText(utf8(RU))).toEqual({ text: RU, encoding: "utf-8" });
	});

	it("UTF-16LE с BOM и без", () => {
		const le = new Uint8Array(RU.length * 2);
		for (let i = 0; i < RU.length; i++) {
			le[i * 2] = RU.charCodeAt(i) & 0xff;
			le[i * 2 + 1] = RU.charCodeAt(i) >> 8;
		}
		expect(decodeText(new Uint8Array([0xff, 0xfe, ...le])).text).toBe(RU);
		expect(decodeText(le)).toEqual({ text: RU, encoding: "utf-16le" });
	});

	it("windows-1251, koi8-r и cp866 различаются по частоте букв", () => {
		expect(decodeText(encodeCp1251Basic(RU))).toEqual({ text: RU, encoding: "windows-1251" });
		expect(decodeText(encodeSingleByte(RU, "koi8-r"))).toEqual({ text: RU, encoding: "koi8-r" });
		expect(decodeText(encodeSingleByte(RU, "ibm866"))).toEqual({ text: RU, encoding: "ibm866" });
	});

	it("UTF-8 с одним битым байтом в конце всё равно UTF-8", () => {
		const bytes = new Uint8Array([...utf8(RU.repeat(5)), 0xd0]);
		expect(decodeText(bytes).encoding).toBe("utf-8");
	});

	it("ярлыки кодировок", () => {
		expect(normalizeEncodingLabel("cp1251")).toBe("windows-1251");
		expect(normalizeEncodingLabel("WIN-1251")).toBe("windows-1251");
		expect(normalizeEncodingLabel("koi8r")).toBe("koi8-r");
		expect(normalizeEncodingLabel("нет-такой")).toBeNull();
	});

	it("XML: объявленная кодировка, ложное объявление и угадывание", () => {
		const decl = `<?xml version="1.0" encoding="windows-1251"?>`;
		expect(sniffDeclaredEncoding(utf8(decl))).toBe("windows-1251");
		const cp = new Uint8Array([...utf8(decl), ...encodeCp1251Basic(`<a>${RU}</a>`)]);
		expect(decodeMarkup(cp).text).toContain(RU);
		// объявлено windows-1251, а на деле UTF-8
		expect(decodeMarkup(utf8(`${decl}<a>${RU}</a>`)).text).toContain(RU);
		// объявлено UTF-8, а на деле cp1251
		const lie = new Uint8Array([...utf8(`<?xml version="1.0" encoding="utf-8"?>`), ...encodeCp1251Basic(`<a>${RU}</a>`)]);
		expect(decodeMarkup(lie).text).toContain(RU);
		// koi8-r в объявлении
		const koi = new Uint8Array([...utf8(`<?xml version="1.0" encoding="koi8-r"?>`), ...encodeSingleByte(`<a>${RU}</a>`, "koi8-r")]);
		expect(decodeMarkup(koi)).toMatchObject({ encoding: "koi8-r" });
		expect(decodeMarkup(koi).text).toContain(RU);
	});
});
