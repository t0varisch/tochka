// PDF через pdf.js: строки → абзацы, без колонтитулов и номеров страниц, оглавление из закладок.
// Модуль грузится динамически (import("./pdf")), чтобы pdf.js не попал в основной бандл.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { ParsedBook, TocEntry } from "../types";
import {
	BookParseError,
	ERR_BROKEN,
	ERR_EMPTY,
	ERR_SCAN,
	authorFromFileName,
	cleanParagraph,
	joinLines,
	median,
	percentile,
	stripAuthorFromTitle,
	titleFromFileName,
} from "./util";

export type PdfjsModule = typeof import("pdfjs-dist");
/** Модуль pdf.js или функция, которая его загрузит (в тестах — legacy-сборка для Node). */
export type PdfjsSource = PdfjsModule | (() => Promise<PdfjsModule>);

export interface PdfOptions {
	onProgress?: (fraction: number) => void;
	/** Название текущего шага — показывается в строке загрузки, чтобы по скриншоту было видно, где застряло. */
	onStage?: (stage: string) => void;
	pdfjs?: PdfjsSource;
}

/** pdf.js для браузера: современная сборка + воркер через Vite. */
async function loadBrowserPdfjs(): Promise<PdfjsModule> {
	const pdfjs = await import("pdfjs-dist");
	if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
	return pdfjs;
}

async function resolvePdfjs(src?: PdfjsSource): Promise<PdfjsModule> {
	if (!src) return loadBrowserPdfjs();
	return typeof src === "function" ? src() : src;
}

interface Line {
	text: string;
	x: number;
	/** Базовая линия первого элемента (в PDF ось y вверх) */
	y: number;
	xEnd: number;
	h: number;
	page: number;
}

interface TextItemLike {
	str?: string;
	transform?: number[];
	width?: number;
	height?: number;
	hasEOL?: boolean;
}

/** Строки страницы из элементов getTextContent: по hasEOL и по скачку y. */
function pageLines(items: unknown[], page: number): Line[] {
	const lines: Line[] = [];
	let text = "";
	let x = 0;
	let y = 0;
	let refH = 0;
	let xEnd = -Infinity;
	let lastEnd = -Infinity;
	let hs: number[] = [];
	let started = false;
	const finish = () => {
		const t = text.trim();
		if (started && t) lines.push({ text: t, x, y, xEnd: xEnd === -Infinity ? x : xEnd, h: median(hs) || refH || 10, page });
		text = "";
		started = false;
		xEnd = -Infinity;
		lastEnd = -Infinity;
		hs = [];
	};
	for (const raw of items) {
		if (!raw || typeof raw !== "object" || !("str" in raw)) continue;
		const it = raw as TextItemLike;
		const str = (it.str ?? "").replace(/[ﬀ-ﬆ]/g, (c) => c.normalize("NFKC"));
		const tr = it.transform ?? [];
		const tx = tr[4] ?? 0;
		const ty = tr[5] ?? 0;
		const h = Math.abs(it.height ?? 0) || Math.hypot(tr[2] ?? 0, tr[3] ?? 0) || 10;
		const visible = str.trim().length > 0;
		if (visible && started && Math.abs(ty - y) > Math.max(refH, h) * 0.7) finish();
		if (visible) {
			if (!started) {
				started = true;
				x = tx;
				y = ty;
				refH = h;
			} else if (tx - lastEnd > h * 0.2 && !/\s$/.test(text) && !/^\s/.test(str)) {
				text += " ";
			}
			text += str;
			hs.push(h);
			lastEnd = tx + (it.width ?? 0);
			xEnd = Math.max(xEnd, lastEnd);
		} else if (str && started) {
			text += str;
		}
		if (it.hasEOL) finish();
	}
	finish();
	return lines;
}

/** Мусор распознавания: короткая строка, выпрыгнувшая вверх из потока текста. */
function dropOutliers(lines: Line[]): Line[] {
	return lines.filter((l, i) => {
		if (i === 0 || i === lines.length - 1 || l.text.replace(/\s/g, "").length > 3) return true;
		const prev = lines[i - 1];
		const next = lines[i + 1];
		return !(l.y > prev.y + 2 * l.h && l.y > next.y + 2 * l.h);
	});
}

// ---------- колонтитулы и номера страниц ----------

const PAGE_NUM_RE =
	/^(?:[-–—\s]*\d{1,4}[-–—\s]*|\d{1,4}\s*(?:\/|из|of)\s*\d{1,4}|(?:стр\.?|страница|page|p\.)\s*\d{1,4}|[-–—\s]*[ivxlcdm]{1,7}[-–—\s]*)$/i;
const ROMAN_LOWER_RE = /^[-–—\s]*[ivxlcdm]{1,7}[-–—\s]*$/;

/** Ключ колонтитула: цифры → #, номер страницы (арабский или римский) по краям отброшен. */
function headKey(text: string): string {
	return text
		.toLowerCase()
		.replace(/\d+/g, "#")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^(?:#|[ivxlcdm]{1,6})(?=[\s/|:.·•–—-])/, "")
		.replace(/(?<=[\s/|:.·•–—-])(?:#|[ivxlcdm]{1,6})$/, "")
		.replace(/^[\s/|:.·•–—-]+|[\s/|:.·•–—-]+$/g, "");
}

const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

/** Римское число (строчными или прописными) или null. */
function romanValue(s: string): number | null {
	const t = s.toLowerCase();
	if (!/^[ivxlcdm]{1,8}$/.test(t)) return null;
	let total = 0;
	for (let i = 0; i < t.length; i++) {
		const v = ROMAN[t[i]];
		const next = ROMAN[t[i + 1]] ?? 0;
		total += v < next ? -v : v;
	}
	// отсекаем «xm», «iiv» и прочий мусор распознавания
	return total > 0 && toRoman(total) === t ? total : null;
}

function toRoman(n: number): string {
	const map: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
	let s = "";
	for (const [v, r] of map) while (n >= v) {
		s += r;
		n -= v;
	}
	return s;
}

interface EdgeNum {
	value: number;
	roman: boolean;
}

/** Номер в начале или в конце строки колонтитула: «12 Глава», «Глава / 12», «xii / Preface». */
function edgeNumber(text: string): EdgeNum | null {
	const m = /^(\d{1,4})(?![\d\p{L}])/u.exec(text) ?? /(?<![\d\p{L}])(\d{1,4})$/u.exec(text);
	if (m) return { value: Number(m[1]), roman: false };
	const r = /^([ivxlcdm]{1,8})(?=[\s/|:.·•–—-])/i.exec(text) ?? /(?<=[\s/|:.·•–—-])([ivxlcdm]{1,8})$/i.exec(text);
	if (r) {
		const v = romanValue(r[1]);
		if (v !== null) return { value: v, roman: true };
	}
	return null;
}

/** Самое частое смещение «номер − индекс страницы» и сколько раз оно встретилось. */
function offsetMode(offsets: Map<number, number>): { mode: number | null; count: number } {
	let mode: number | null = null;
	let count = 0;
	for (const [off, cnt] of offsets) {
		if (cnt > count) {
			mode = off;
			count = cnt;
		}
	}
	return { mode, count };
}

/** Убирает колонтитулы и номера страниц (по 2 строки сверху и снизу каждой страницы). */
function removeRunningHeads(pages: Line[][], gap: number, bodyH: number): void {
	const nonEmpty = pages.filter((p) => p.length).length;
	interface Cand {
		line: Line;
		page: number;
		gapToBody: number;
		num: EdgeNum | null;
	}
	const cands: Cand[] = [];
	pages.forEach((lines, page) => {
		if (!lines.length) return;
		const byY = [...lines].sort((a, b) => b.y - a.y);
		const picked = new Set<Line>();
		const add = (l: Line, neighbour: Line | undefined) => {
			// колонтитул не крупнее основного текста: крупная строка — заголовок («PREFACE», «CHAPTER 1»)
			if (picked.has(l) || l.h > bodyH * 1.3) return;
			picked.add(l);
			const gapToBody = neighbour ? Math.abs(l.y - neighbour.y) : Infinity;
			cands.push({ line: l, page, gapToBody, num: edgeNumber(l.text) });
		};
		for (let i = 0; i < Math.min(2, byY.length); i++) add(byY[i], byY[i + 1]);
		for (let j = byY.length - 1; j >= Math.max(0, byY.length - 2); j--) add(byY[j], byY[j - 1]);
	});

	const keyPages = new Map<string, Set<number>>();
	const arabic = new Map<number, number>();
	const roman = new Map<number, number>();
	for (const c of cands) {
		const k = headKey(c.line.text);
		if (k) {
			if (!keyPages.has(k)) keyPages.set(k, new Set());
			keyPages.get(k)!.add(c.page);
		}
		if (c.num && c.line.text.length <= 80) {
			const map = c.num.roman ? roman : arabic;
			const off = c.num.value - c.page;
			map.set(off, (map.get(off) ?? 0) + 1);
		}
	}
	// самое частое смещение «номер на странице − индекс страницы»: так узнаём номера страниц
	const a = offsetMode(arabic);
	const r = offsetMode(roman);
	const arabicMode = a.count >= Math.max(3, nonEmpty * 0.1) ? a.mode : null;
	const romanMode = r.count >= 2 ? r.mode : null;

	const remove = new Set<Line>();
	for (const c of cands) {
		const t = c.line.text;
		const mode = c.num?.roman ? romanMode : arabicMode;
		const onOffset = mode !== null && c.num !== null && Math.abs(c.num.value - c.page - mode) <= 1;
		const isolated = c.gapToBody >= gap * 1.5;
		if (PAGE_NUM_RE.test(t)) {
			// голый номер: страница, если совпадает со смещением (иначе это может быть номер главы)
			if (onOffset || (arabicMode === null && !c.num?.roman) || ROMAN_LOWER_RE.test(t) || /\/|из|of|стр|page/i.test(t)) {
				remove.add(c.line);
			}
			continue;
		}
		const k = headKey(t);
		const cnt = k ? keyPages.get(k)!.size : 0;
		// «CHAPTER 1», «Глава 2»: номер не совпадает с номером страницы — это заголовок, не колонтитул
		const chapterLike = c.num !== null && !onOffset;
		if (cnt >= 3 && (cnt >= nonEmpty * 0.3 || ((isolated || onOffset) && !chapterLike))) remove.add(c.line);
		else if (onOffset && isolated && t.length <= 80) remove.add(c.line);
	}
	for (let i = 0; i < pages.length; i++) pages[i] = pages[i].filter((l) => !remove.has(l));
}


// ---------- абзацы ----------

interface Metrics {
	left: number;
	right: number;
	gap: number;
}

function pageGaps(lines: Line[]): number[] {
	const gaps: number[] = [];
	for (let i = 1; i < lines.length; i++) {
		const d = lines[i - 1].y - lines[i].y;
		if (d > lines[i].h * 0.3 && d < lines[i].h * 3) gaps.push(d);
	}
	return gaps;
}

const SENTENCE_END_RE = /[.!?…]["'»”’)\]]*$/;
const BULLET_RE = /^[•·▪◦●■►‣]/;

interface Para {
	text: string;
	page: number;
	y: number;
}

/** Собирает абзацы из строк всех страниц. */
function buildParagraphs(pages: Line[][], bodyH: number, bookGap: number): Para[] {
	const metrics: Metrics[] = [];
	const fallback: Metrics = { left: 0, right: 0, gap: bookGap };
	{
		const lefts: number[] = [];
		const rights: number[] = [];
		for (const lines of pages) {
			const long = lines.filter((l) => l.text.length >= 25);
			if (long.length >= 3) {
				lefts.push(percentile(long.map((l) => l.x), 0.1));
				rights.push(percentile(long.map((l) => l.xEnd), 0.9));
			}
		}
		fallback.left = median(lefts);
		fallback.right = median(rights);
	}
	let fullCount = 0;
	let lineCount = 0;
	for (const lines of pages) {
		const long = lines.filter((l) => l.text.length >= 25);
		const g = pageGaps(lines);
		const m: Metrics =
			long.length >= 3
				? { left: percentile(long.map((l) => l.x), 0.1), right: percentile(long.map((l) => l.xEnd), 0.9), gap: g.length >= 3 ? median(g) : bookGap }
				: { ...fallback };
		metrics.push(m);
		for (const l of long) {
			lineCount++;
			if (l.xEnd >= m.right - Math.max(bodyH * 1.5, (m.right - m.left) * 0.06)) fullCount++;
		}
	}
	// выравнивание по ширине: большинство строк доходят до правого края
	const justified = lineCount > 0 && fullCount / lineCount >= 0.7;
	const t = Math.max(3, bodyH * 0.6);

	const startsParagraph = (P: Line, L: Line, mP: Metrics, mL: Metrics, samePage: boolean): boolean => {
		if (BULLET_RE.test(L.text)) return true;
		// почти пустые страницы (обложка, титул, посвящение) не сливаем с соседними
		if (!samePage && (pages[P.page].length < 4 || pages[L.page].length < 4)) return true;
		const ratio = Math.max(P.h, L.h) / Math.max(0.1, Math.min(P.h, L.h));
		if (ratio >= 1.45 && P.text.length > 2 && L.text.length > 2) return true;
		if (samePage) {
			const dy = P.y - L.y;
			// обычный интервал с учётом кегля: строки крупного заголовка стоят дальше друг от друга
			const expected = Math.max(mL.gap, P.h * 1.25, L.h * 1.25);
			if (dy > expected * 1.4 || dy < -mL.gap) return true;
		}
		const widthP = Math.max(1, mP.right - mP.left);
		const prevEnds = SENTENCE_END_RE.test(P.text);
		const prevFull = P.xEnd >= mP.right - Math.max(bodyH * 1.5, widthP * 0.06);
		const prevShort = P.xEnd < mP.right - Math.max(bodyH * 2, widthP * 0.1);
		const prevVeryShort = P.xEnd - mP.left < widthP * 0.6;
		// при выравнивании по ширине короткая строка с точкой — последняя в абзаце;
		// без точки — только если она заметно короче (подпись под цитатой, заголовок)
		if (justified && prevShort && prevEnds) return true;
		if (justified && P.xEnd - mP.left < widthP * 0.75 && !/[-‐,]$/.test(P.text)) return true;
		if (prevVeryShort && !/[,;:\-‐-]$/.test(P.text) && (justified || prevEnds)) return true;
		const indent = L.x - mL.left;
		if (indent > t && (!samePage || L.x > P.x + t) && !(prevFull && !prevEnds)) return true;
		if (samePage && L.x < P.x - t && prevEnds) return true;
		if (/^[—–]/.test(L.text) && prevEnds) return true;
		return false;
	};

	const paras: Para[] = [];
	let cur: Para | null = null;
	let prev: Line | null = null;
	let prevM: Metrics | null = null;
	const push = () => {
		if (cur) {
			const text = cleanParagraph(cur.text);
			if (text) paras.push({ ...cur, text });
		}
		cur = null;
	};
	pages.forEach((lines, pi) => {
		const m = metrics[pi];
		for (const L of lines) {
			if (cur && prev && prevM && !startsParagraph(prev, L, prevM, m, prev.page === L.page)) {
				cur.text = joinLines(cur.text, L.text);
			} else {
				push();
				cur = { text: L.text, page: pi, y: L.y };
			}
			prev = L;
			prevM = m;
		}
	});
	push();
	return paras;
}

// ---------- метаданные и оглавление ----------

function meaningfulTitle(t: string): boolean {
	if (t.length < 2) return false;
	if (/^(untitled|без названия|безымянный|document|документ|title|microsoft word|presentation)\b/i.test(t)) return false;
	if (/[\\/]/.test(t) && /\.\w{2,4}$/.test(t)) return false;
	if (/\.(docx?|pdf|indd|qxd|tex|rtf|odt|pages|txt|html?)$/i.test(t)) return false;
	return /\p{L}/u.test(t);
}

interface OutlineNode {
	title?: string;
	dest?: unknown;
	items?: OutlineNode[];
}

type PdfDoc = Awaited<ReturnType<PdfjsModule["getDocument"]>["promise"]>;

async function outlineToc(doc: PdfDoc, outline: OutlineNode[], paras: Para[], numPages: number): Promise<TocEntry[]> {
	const byPage: number[][] = Array.from({ length: numPages }, () => []);
	paras.forEach((p, i) => byPage[p.page]?.push(i));

	const paraAt = (pageIndex: number, top: number | null): number | undefined => {
		const list = byPage[pageIndex] ?? [];
		if (list.length) {
			if (top === null) return list[0];
			const tol = 2;
			return list.find((i) => paras[i].y <= top + tol) ?? list[list.length - 1];
		}
		// на странице не начинается ни один абзац — тот, что её занимает
		for (let p = pageIndex - 1; p >= 0; p--) if (byPage[p].length) return byPage[p][byPage[p].length - 1];
		for (let p = pageIndex + 1; p < numPages; p++) if (byPage[p].length) return byPage[p][0];
		return undefined;
	};

	const destToPara = async (dest: unknown): Promise<number | undefined> => {
		let d = dest;
		if (typeof d === "string") d = await doc.getDestination(d).catch(() => null);
		if (!Array.isArray(d) || !d.length) return undefined;
		const ref = d[0];
		let pageIndex = -1;
		if (typeof ref === "number") pageIndex = ref;
		else if (ref && typeof ref === "object") pageIndex = await doc.getPageIndex(ref).catch(() => -1);
		if (pageIndex < 0 || pageIndex >= numPages) return undefined;
		const mode = (d[1] as { name?: string } | undefined)?.name;
		let top: number | null = null;
		if (mode === "XYZ" && typeof d[3] === "number") top = d[3];
		else if ((mode === "FitH" || mode === "FitBH") && typeof d[2] === "number") top = d[2];
		return paraAt(pageIndex, top);
	};

	const out: TocEntry[] = [];
	const visit = async (nodes: OutlineNode[], level: number): Promise<number | undefined> => {
		let first: number | undefined;
		for (const node of nodes) {
			const idx = out.length;
			const title = cleanParagraph(node.title ?? "");
			out.push({ title, level, paragraph: -1 });
			const own = await destToPara(node.dest);
			const childFirst = node.items?.length ? await visit(node.items, level + 1) : undefined;
			const p = own ?? childFirst;
			if (p === undefined || !title) out.splice(idx, 1);
			else out[idx].paragraph = p;
			if (first === undefined) first = p;
		}
		return first;
	};
	await visit(outline, 0);
	if (!out.length) return out;
	const min = Math.min(...out.map((e) => e.level));
	return out.map((e) => ({ ...e, level: e.level - min }));
}

// ---------- главное ----------

/** Ждёт обещание не дольше ms; по истечении или при ошибке отдаёт запасное значение. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
	return new Promise<T>((resolve) => {
		const t = setTimeout(() => resolve(fallback), ms);
		p.then(
			(v) => (clearTimeout(t), resolve(v)),
			() => (clearTimeout(t), resolve(fallback)),
		);
	});
}

export async function parsePdf(data: Uint8Array, fileName = "", opts: PdfOptions = {}): Promise<ParsedBook> {
	const pdfjs = await resolvePdfjs(opts.pdfjs);
	const task = pdfjs.getDocument({
		data,
		verbosity: 0,
		disableFontFace: true,
		useSystemFonts: false,
		stopAtErrors: false,
	});
	try {
		let doc: PdfDoc;
		try {
			doc = await task.promise;
		} catch (e) {
			const name = (e as { name?: string })?.name ?? "";
			if (name === "PasswordException") throw new BookParseError("PDF защищён паролем — такие не открываются", { cause: e });
			throw new BookParseError(ERR_BROKEN, { cause: e });
		}
		const numPages = doc.numPages;
		const pages: Line[][] = [];
		let chars = 0;
		for (let p = 1; p <= numPages; p++) {
			let lines: Line[] = [];
			try {
				const page = await doc.getPage(p);
				const content = await page.getTextContent();
				lines = dropOutliers(pageLines(content.items as unknown[], p - 1));
				page.cleanup();
			} catch {
				// битая страница — пропускаем
			}
			for (const l of lines) chars += l.text.length;
			pages.push(lines);
			opts.onProgress?.(p / numPages);
		}
		if (!numPages || chars / numPages < 20) throw new BookParseError(ERR_SCAN);
		opts.onStage?.("собираю абзацы");

		const all = pages.flat();
		const bodyH = median(all.filter((l) => l.text.length >= 20).map((l) => l.h)) || median(all.map((l) => l.h)) || 10;
		const bookGap = median(pages.flatMap(pageGaps)) || bodyH * 1.2;
		removeRunningHeads(pages, bookGap, bodyH);
		const paras = buildParagraphs(pages, bodyH, bookGap);
		if (!paras.length) throw new BookParseError(ERR_EMPTY);

		// Метаданные и оглавление необязательны: если воркер pdf.js не отвечает (замечено на iPhone), идём дальше без них
		opts.onStage?.("читаю название");
		const meta = await withTimeout(doc.getMetadata(), 5000, null);
		const info = (meta?.info ?? {}) as Record<string, unknown>;
		const metaTitle = typeof info.Title === "string" ? cleanParagraph(info.Title) : "";
		let author = typeof info.Author === "string" ? cleanParagraph(info.Author) : "";
		if (!author) author = authorFromFileName(fileName);
		const title = meaningfulTitle(metaTitle) ? metaTitle : stripAuthorFromTitle(titleFromFileName(fileName), author);

		let toc: TocEntry[] = [];
		opts.onStage?.("читаю оглавление");
		const outline = (await withTimeout(doc.getOutline(), 5000, null)) as OutlineNode[] | null;
		if (outline?.length) toc = await withTimeout(outlineToc(doc, outline, paras, numPages), 8000, []);

		return { title, author, format: "pdf", paragraphs: paras.map((p) => p.text), toc };
	} finally {
		// Не ждём: закрытие воркера не должно задерживать книгу
		void withTimeout(task.destroy(), 3000, undefined);
	}
}
