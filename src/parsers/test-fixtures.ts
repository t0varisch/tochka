// Только для тестов: кодировщики cp1251/koi8-r, сборка zip/EPUB и минимального PDF.
import JSZip from "jszip";

const tables = new Map<string, Map<string, number>>();

/** Кодирует строку в однобайтовую кодировку (таблицу строим через TextDecoder). */
export function encodeSingleByte(text: string, encoding: "windows-1251" | "koi8-r" | "ibm866"): Uint8Array {
	let map = tables.get(encoding);
	if (!map) {
		map = new Map();
		const dec = new TextDecoder(encoding);
		for (let b = 0; b < 256; b++) {
			const ch = dec.decode(new Uint8Array([b]));
			if (!map.has(ch)) map.set(ch, b);
		}
		tables.set(encoding, map);
	}
	const out = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) {
		const b = map.get(text[i]);
		if (b === undefined) throw new Error(`Символ «${text[i]}» не кодируется в ${encoding}`);
		out[i] = b;
	}
	return out;
}

/** Простой кодировщик cp1251 только для кириллицы и ASCII (А–я = C0–FF, Ё = A8, ё = B8). */
export function encodeCp1251Basic(text: string): Uint8Array {
	const out = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c < 0x80) out[i] = c;
		else if (c >= 0x410 && c <= 0x44f) out[i] = c - 0x410 + 0xc0;
		else if (c === 0x401) out[i] = 0xa8;
		else if (c === 0x451) out[i] = 0xb8;
		else throw new Error(`Символ «${text[i]}» вне простого cp1251`);
	}
	return out;
}

export function utf8(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

/** Zip из словаря «путь → содержимое». */
export async function makeZip(files: Record<string, string | Uint8Array>, mimetypeFirst = false): Promise<Uint8Array> {
	const zip = new JSZip();
	if (mimetypeFirst && files.mimetype !== undefined) zip.file("mimetype", files.mimetype, { compression: "STORE" });
	for (const [path, data] of Object.entries(files)) {
		if (mimetypeFirst && path === "mimetype") continue;
		zip.file(path, data);
	}
	return zip.generateAsync({ type: "uint8array" });
}

export function fileFrom(bytes: Uint8Array, name: string): File {
	return new File([bytes as BlobPart], name);
}

// ---------- минимальный PDF ----------

export interface PdfLine {
	text: string;
	x: number;
	y: number;
	size?: number;
}

export interface PdfSpec {
	pages: PdfLine[][];
	title?: string;
	author?: string;
	/** Закладки: название и страница (с нуля), y — верх цели */
	outline?: { title: string; page: number; y: number }[];
}

function pdfString(s: string): string {
	return "(" + s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)") + ")";
}

/** Собирает PDF с текстом Helvetica (только ASCII), закладками и метаданными. */
export function buildPdf(spec: PdfSpec): Uint8Array {
	const objects: string[] = [];
	const add = (body: string) => {
		objects.push(body);
		return objects.length;
	};
	const catalogId = add("");
	const pagesId = add("");
	const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
	const pageIds: number[] = [];
	for (const lines of spec.pages) {
		const stream = lines
			.map((l) => `BT /F1 ${l.size ?? 10} Tf ${l.x} ${l.y} Td ${pdfString(l.text)} Tj ET`)
			.join("\n");
		const contentId = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
		pageIds.push(
			add(
				`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
			),
		);
	}
	objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

	let outlinesRef = "";
	if (spec.outline?.length) {
		const outlinesId = add("");
		const itemIds = spec.outline.map(() => add(""));
		spec.outline.forEach((o, i) => {
			const prev = i > 0 ? ` /Prev ${itemIds[i - 1]} 0 R` : "";
			const next = i < itemIds.length - 1 ? ` /Next ${itemIds[i + 1]} 0 R` : "";
			objects[itemIds[i] - 1] =
				`<< /Title ${pdfString(o.title)} /Parent ${outlinesId} 0 R${prev}${next} /Dest [${pageIds[o.page]} 0 R /XYZ 0 ${o.y} 0] >>`;
		});
		objects[outlinesId - 1] = `<< /Type /Outlines /First ${itemIds[0]} 0 R /Last ${itemIds[itemIds.length - 1]} 0 R /Count ${itemIds.length} >>`;
		outlinesRef = ` /Outlines ${outlinesId} 0 R`;
	}
	objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R${outlinesRef} >>`;
	const infoParts = [spec.title ? `/Title ${pdfString(spec.title)}` : "", spec.author ? `/Author ${pdfString(spec.author)}` : ""].filter(Boolean);
	const infoId = add(`<< ${infoParts.join(" ")} >>`);

	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((body, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(out);
}
