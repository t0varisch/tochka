// Частично основано на Speeedy (MIT, © 2026 Speeedy, github.com/sami-29/speeedy)
// EPUB 2/3: текст по порядку spine, оглавление из nav или NCX, без сносок и служебных страниц.
import JSZip from "jszip";
import type { ParsedBook, TocEntry } from "../types";
import { decodeMarkup } from "./decode";
import { attrLocal, childByLocal, childrenByLocal, elementsByLocal, localOf, parseMarkup, parseXmlLoose } from "./dom";
import { BookParseError, ERR_DRM, ERR_EMPTY, GAP, cleanParagraph, isNoteMarker, titleFromFileName } from "./util";

const OPS_NS = "http://www.idpf.org/2007/ops";

// ---------- архив ----------

function safeDecode(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

/** Нормализует путь внутри архива: «/», без «.» и «..». */
export function normPath(p: string): string {
	const stack: string[] = [];
	for (const part of p.replace(/\\/g, "/").split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") stack.pop();
		else stack.push(part);
	}
	return stack.join("/");
}

function dirOf(p: string): string {
	const i = p.lastIndexOf("/");
	return i >= 0 ? p.slice(0, i + 1) : "";
}

/** Путь из href относительно файла base (href без #фрагмента). */
function resolvePath(base: string, href: string): string {
	const h = safeDecode(href);
	return h.startsWith("/") ? normPath(h) : normPath(dirOf(base) + h);
}

const key = (path: string) => normPath(path).toLowerCase();

/** Имена файлов в zip: UTF-8, иначе cp866 (архивы из русской Windows). */
type FileNameBytes = Parameters<NonNullable<JSZip.JSZipLoadOptions["decodeFileName"]>>[0];
function decodeFileName(bytes: FileNameBytes): string {
	const arr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes as ArrayLike<unknown>, (c) => Number(c));
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(arr);
	} catch {
		return new TextDecoder("ibm866").decode(arr);
	}
}

/** Открывает zip. */
export async function loadZip(data: Uint8Array | ArrayBuffer): Promise<JSZip> {
	return JSZip.loadAsync(data, { decodeFileName });
}

/** Поиск файлов в архиве без учёта регистра и %-кодирования. */
export class ZipIndex {
	private map = new Map<string, JSZip.JSZipObject>();
	constructor(zip: JSZip) {
		zip.forEach((rel, f) => {
			if (!f.dir) this.map.set(key(rel), f);
		});
	}
	get(path: string): JSZip.JSZipObject | null {
		return this.map.get(key(path)) ?? this.map.get(key(safeDecode(path))) ?? null;
	}
	names(): string[] {
		return [...this.map.values()].map((f) => f.name);
	}
}

/** Похож ли архив на EPUB. */
export function isEpubZip(zip: JSZip): boolean {
	const idx = new ZipIndex(zip);
	return !!idx.get("META-INF/container.xml") || idx.names().some((n) => /\.opf$/i.test(n));
}

async function readMarkup(entry: JSZip.JSZipObject): Promise<string> {
	return decodeMarkup(await entry.async("uint8array")).text;
}

// ---------- семантика элементов ----------

/** epub:type и role через пробел, в нижнем регистре. */
function semantic(el: Element): string {
	const t = el.getAttributeNS(OPS_NS, "type") ?? el.getAttribute("epub:type") ?? "";
	return (t + " " + (el.getAttribute("role") ?? "")).toLowerCase();
}

const NOTE_CONTAINER_RE = /(^|\s)(doc-)?(foot|end|rear)notes?(\s|$)/;
const NOTE_ASIDE_RE = /(^|\s)note(\s|$)/;
const NOTEREF_RE = /(^|\s)(doc-)?noteref(\s|$)/;

function hrefOf(el: Element): string {
	return el.getAttribute("href") ?? attrLocal(el, "href") ?? "";
}

/** Ссылка-сноска в тексте: «1», «[1]», «*» и т.п. */
export function isNoteRef(a: Element): boolean {
	if (NOTEREF_RE.test(semantic(a))) return true;
	const href = hrefOf(a);
	const hash = href.indexOf("#");
	if (hash < 0) return false;
	const text = (a.textContent ?? "").replace(/[\s\u00A0]+/g, "");
	if (!text || !isNoteMarker(text)) return false;
	if (!/^\d{1,4}\)?$/.test(text)) return true; // [1], {1}, (1), *, †
	// голая цифра: нужен ещё признак сноски
	const parent = a.parentElement;
	const pn = parent ? localOf(parent) : "";
	if (pn === "sup" || pn === "small") return true;
	if (Array.from(a.children).some((c) => localOf(c) === "sup")) return true;
	const cls = `${a.getAttribute("class") ?? ""} ${a.getAttribute("id") ?? ""} ${parent?.getAttribute("class") ?? ""}`;
	if (/note|fn|foot|sup|ref|comment/i.test(cls)) return true;
	const frag = href.slice(hash + 1);
	return /note|fn|foot|comment|^n_?\d|^c_?\d/i.test(frag) || /note|comment|foot/i.test(href.slice(0, hash));
}

const MARKER_START_RE = /^[\s\u00A0]*[\[\{\(]?(\d{1,4}|\*{1,3}|[†‡])[\]\}\)]?(?=[\s\u00A0.]|$)/;

// ---------- обход документа ----------

const BLOCK = new Set([
	"p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "pre", "td", "th", "dt", "dd",
	"figcaption", "section", "article", "header", "footer", "main", "aside", "figure", "table", "tr",
	"tbody", "thead", "tfoot", "ul", "ol", "dl", "address", "center", "body", "caption", "details",
	"summary", "hgroup", "fieldset", "legend", "form",
]);
const SKIP = new Set([
	"script", "style", "svg", "img", "math", "nav", "head", "title", "noscript", "template", "iframe",
	"object", "embed", "audio", "video", "canvas", "button", "input", "select", "textarea", "map",
	"picture", "source", "link", "meta", "image",
]);
const HEADING_RE = /^h[1-6]$/;

interface Heading {
	level: number;
	paragraph: number;
	title: string;
}

class Walker {
	paragraphs: string[] = [];
	anchors = new Map<string, number>();
	fileStart = new Map<string, number>();
	headings: Heading[] = [];
	/** Ключ текущего файла */
	path = "";
	private buf = "";
	private lastBr = false;
	private discard = false;

	constructor(private noteTargets: Set<string>) {}

	private flush(): void {
		if (!this.discard) {
			const p = cleanParagraph(this.buf);
			if (p) this.paragraphs.push(p);
		}
		this.buf = "";
		this.discard = false;
		this.lastBr = false;
	}

	walkFile(path: string, body: Element): void {
		this.path = path;
		const start = this.paragraphs.length;
		this.fileStart.set(path, start);
		this.walk(body);
		this.flush();
		// от файла сносок остался один заголовок «Примечания» — убрать и его
		if (this.paragraphs.length === start + 1 && NOTES_TITLE_RE.test(this.paragraphs[start])) {
			this.paragraphs.pop();
			this.headings = this.headings.filter((h) => h.paragraph < start);
			this.fileStart.delete(path);
			for (const k of [...this.anchors.keys()]) if (k.startsWith(path + "#")) this.anchors.delete(k);
		}
	}

	private anchor(id: string): void {
		const k = this.path + "#" + id;
		if (!this.anchors.has(k)) this.anchors.set(k, this.paragraphs.length);
	}

	private walk(node: Node): void {
		if (node.nodeType === 3 || node.nodeType === 4) {
			const v = node.nodeValue ?? "";
			this.buf += v;
			if (/\S/.test(v)) this.lastBr = false;
			return;
		}
		if (node.nodeType !== 1) return;
		const el = node as Element;
		const n = localOf(el);
		if (SKIP.has(n) || el.hasAttribute("hidden")) {
			if (n === "img" || n === "svg" || n === "math") this.buf += GAP;
			return;
		}
		const sem = semantic(el);
		if (NOTE_CONTAINER_RE.test(sem) || (n === "aside" && NOTE_ASIDE_RE.test(sem))) return;
		if (n === "a" && isNoteRef(el)) {
			this.buf += GAP;
			return;
		}
		const id = el.getAttribute("id") ?? (n === "a" ? el.getAttribute("name") : null);
		const block = BLOCK.has(n);

		// цель ссылки-сноски: блок с текстом сноски или якорь в начале абзаца сноски
		if (id && this.noteTargets.has(this.path + "#" + id) && !HEADING_RE.test(n)) {
			const text = el.textContent ?? "";
			// span вокруг блоков (так бывает после конвертеров) считаем блоком
			if (block || hasBlockInside(el)) {
				if (text.length < 3000 && (startsWithMarker(el) || ["li", "aside", "dd", "dt"].includes(n) || startsWithNoteRef(el))) {
					this.flush();
					return;
				}
			} else if (!/\S/.test(this.buf)) {
				this.discard = true;
			}
		}

		if (n === "br") {
			if (this.lastBr) this.flush();
			else {
				this.buf += " ";
				this.lastBr = true;
			}
			return;
		}
		if (n === "hr") {
			this.flush();
			return;
		}
		if (block) this.flush();
		if (id) this.anchor(id);
		const start = this.paragraphs.length;
		for (const c of Array.from(el.childNodes)) this.walk(c);
		if (block) {
			this.flush();
			if (HEADING_RE.test(n) && this.paragraphs.length > start) {
				this.headings.push({ level: Number(n[1]), paragraph: start, title: this.paragraphs.slice(start).join(" ") });
			}
		}
	}
}

const NOTES_TITLE_RE = /^(примечания|комментарии|сноски|примечания переводчика|notes|endnotes|footnotes)[.:]?$/i;

/** Первый непустой текст элемента — маркер сноски («1», «[1]», «1. Текст…»). */
function startsWithMarker(el: Element): boolean {
	const first = firstText(el);
	return first !== null && (isNoteMarker(first) || MARKER_START_RE.test(first));
}

function firstText(node: Node): string | null {
	for (const c of Array.from(node.childNodes)) {
		if (c.nodeType === 3 || c.nodeType === 4) {
			const t = (c.nodeValue ?? "").trim();
			if (t) return t;
		} else if (c.nodeType === 1) {
			const t = firstText(c);
			if (t !== null) return t;
		}
	}
	return null;
}

function hasBlockInside(el: Element): boolean {
	for (const d of Array.from(el.getElementsByTagName("*"))) if (BLOCK.has(localOf(d))) return true;
	return false;
}

/** Первый элемент с текстом внутри — ссылка-сноска (обратная ссылка из сноски). */
function startsWithNoteRef(el: Element): boolean {
	for (const a of elementsByLocal(el, "a")) {
		if (!(a.textContent ?? "").trim()) continue;
		return isNoteRef(a) && !(el.textContent ?? "").slice(0, (el.textContent ?? "").indexOf(a.textContent ?? "")).trim();
	}
	return false;
}

/** Страница-оглавление внутри книги: почти весь текст — ссылки на другие файлы. */
function isTocPage(body: Element, path: string): boolean {
	const total = (body.textContent ?? "").replace(/\s+/g, "").length;
	if (!total) return false;
	let count = 0;
	let linked = 0;
	for (const a of elementsByLocal(body, "a")) {
		const href = hrefOf(a);
		if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) continue;
		const target = key(resolvePath(path, href.split("#")[0]));
		if (!target || target === path) continue;
		count++;
		linked += (a.textContent ?? "").replace(/\s+/g, "").length;
	}
	return count >= 3 && linked >= total * 0.6;
}

// ---------- оглавление ----------

interface RawToc {
	title: string;
	href: string | null;
	children: RawToc[];
}

function navEntries(doc: Document): RawToc[] {
	const navs = elementsByLocal(doc, "nav");
	const nav = navs.find((n) => /(^|\s)(doc-)?toc(\s|$)/.test(semantic(n))) ?? navs[0];
	if (!nav) return [];
	const ol = childByLocal(nav, "ol") ?? elementsByLocal(nav, "ol")[0];
	return ol ? navList(ol) : [];
}

function navList(ol: Element): RawToc[] {
	const out: RawToc[] = [];
	for (const li of childrenByLocal(ol, "li")) {
		const label = Array.from(li.children).find((c) => localOf(c) !== "ol");
		const sub = childByLocal(li, "ol");
		const link = label && localOf(label) === "a" ? label : (label ? elementsByLocal(label, "a")[0] : undefined);
		out.push({
			title: cleanParagraph(label?.textContent ?? ""),
			href: link ? hrefOf(link) || null : null,
			children: sub ? navList(sub) : [],
		});
	}
	return out;
}

function ncxEntries(doc: Document): RawToc[] {
	const map = elementsByLocal(doc, "navMap")[0];
	return map ? ncxPoints(map) : [];
}

function ncxPoints(el: Element): RawToc[] {
	return childrenByLocal(el, "navPoint").map((np) => {
		const label = childByLocal(np, "navLabel");
		const text = childByLocal(label, "text") ?? label;
		const content = childByLocal(np, "content");
		return {
			title: cleanParagraph(text?.textContent ?? ""),
			href: content?.getAttribute("src") ?? null,
			children: ncxPoints(np),
		};
	});
}

const SKIP_TOC_TITLE_RE = /^(cover|обложка|cover page)$/i;

function buildToc(raw: RawToc[], base: string, w: Walker): TocEntry[] {
	const total = w.paragraphs.length;
	const resolve = (href: string): number | undefined => {
		const hash = href.indexOf("#");
		const pathPart = hash >= 0 ? href.slice(0, hash) : href;
		const frag = hash >= 0 ? safeDecode(href.slice(hash + 1)) : "";
		const path = pathPart ? key(resolvePath(base, pathPart)) : base;
		const p = (frag ? w.anchors.get(path + "#" + frag) : undefined) ?? w.fileStart.get(path);
		return p !== undefined && p < total ? p : undefined;
	};
	const out: TocEntry[] = [];
	const flatten = (list: RawToc[], level: number): number | undefined => {
		let first: number | undefined;
		for (const e of list) {
			const idx = out.length;
			out.push({ title: e.title, level, paragraph: -1 });
			const childFirst = flatten(e.children, level + 1);
			const p = (e.href ? resolve(e.href) : undefined) ?? childFirst;
			if (p === undefined || !e.title || SKIP_TOC_TITLE_RE.test(e.title)) out.splice(idx, 1);
			else out[idx].paragraph = p;
			if (first === undefined) first = p;
		}
		return first;
	};
	flatten(raw, 0);
	return normalizeToc(out);
}

/** Уровни с нуля, без подряд идущих дублей. */
function normalizeToc(list: TocEntry[]): TocEntry[] {
	if (!list.length) return list;
	const min = Math.min(...list.map((e) => e.level));
	const out: TocEntry[] = [];
	for (const e of list) {
		const prev = out[out.length - 1];
		if (prev && prev.paragraph === e.paragraph && prev.title === e.title) continue;
		out.push({ ...e, level: e.level - min });
	}
	return out;
}

// ---------- OPF ----------

interface ManifestItem {
	id: string;
	path: string;
	mediaType: string;
	properties: string;
}

function isHtmlItem(it: ManifestItem): boolean {
	const mt = it.mediaType.toLowerCase();
	if (mt.includes("html")) return true;
	if (mt.startsWith("image/") || mt.includes("css") || mt.includes("font") || mt.includes("ncx")) return false;
	return /\.(x?html?|xml)$/i.test(it.path);
}

function readCreators(metadata: Element): string[] {
	const roles = new Map<string, string>();
	for (const m of elementsByLocal(metadata, "meta")) {
		const refines = m.getAttribute("refines");
		if (refines && m.getAttribute("property") === "role") roles.set(refines.replace(/^#/, ""), (m.textContent ?? "").trim().toLowerCase());
	}
	const names: string[] = [];
	for (const c of elementsByLocal(metadata, "creator")) {
		const role = (attrLocal(c, "role") ?? roles.get(c.getAttribute("id") ?? "") ?? "").toLowerCase();
		if (role && role !== "aut") continue;
		const name = cleanParagraph(c.textContent ?? "");
		if (name && !names.includes(name)) names.push(name);
	}
	return names;
}

/** Разбор EPUB из открытого архива. */
export async function parseEpubZip(zip: JSZip, fileName = "", onProgress?: (f: number) => void): Promise<ParsedBook> {
	const idx = new ZipIndex(zip);

	// где лежит OPF
	let opfPath = "";
	const container = idx.get("META-INF/container.xml");
	if (container) {
		const doc = parseXmlLoose(await readMarkup(container));
		const roots = elementsByLocal(doc, "rootfile");
		const root = roots.find((r) => (r.getAttribute("media-type") ?? "").includes("oebps-package")) ?? roots[0];
		const full = root?.getAttribute("full-path");
		if (full && idx.get(full)) opfPath = normPath(safeDecode(full));
	}
	if (!opfPath) opfPath = idx.names().find((n) => /\.opf$/i.test(n)) ?? "";
	const opfEntry = opfPath ? idx.get(opfPath) : null;
	if (!opfEntry) throw new BookParseError("Не удалось прочитать EPUB — в архиве нет описания книги");
	opfPath = normPath(opfEntry.name);

	const opf = parseXmlLoose(await readMarkup(opfEntry));
	const metadata = elementsByLocal(opf, "metadata")[0] ?? opf.documentElement;
	const title = cleanParagraph(elementsByLocal(metadata, "title")[0]?.textContent ?? "");
	const authors = readCreators(metadata);

	const manifest = new Map<string, ManifestItem>();
	const manifestEl = elementsByLocal(opf, "manifest")[0];
	for (const it of childrenByLocal(manifestEl, "item")) {
		const id = it.getAttribute("id");
		const href = it.getAttribute("href");
		if (!id || !href) continue;
		manifest.set(id, {
			id,
			path: key(resolvePath(opfPath, href.split("#")[0])),
			mediaType: it.getAttribute("media-type") ?? "",
			properties: it.getAttribute("properties") ?? "",
		});
	}
	const items = [...manifest.values()];
	const spineEl = elementsByLocal(opf, "spine")[0];
	const navItem = items.find((it) => /(^|\s)nav(\s|$)/.test(it.properties));
	const ncxId = spineEl?.getAttribute("toc");
	const ncxItem =
		(ncxId ? manifest.get(ncxId) : undefined) ??
		items.find((it) => it.mediaType.includes("dtbncx")) ??
		items.find((it) => it.path.endsWith(".ncx"));

	// DRM: зашифрованы сами документы с текстом (шрифты не в счёт)
	const enc = idx.get("META-INF/encryption.xml");
	if (enc) {
		const encDoc = parseXmlLoose(await readMarkup(enc));
		const htmlPaths = new Set(items.filter(isHtmlItem).map((it) => it.path));
		for (const ref of elementsByLocal(encDoc, "CipherReference")) {
			const uri = key(resolvePath("", ref.getAttribute("URI") ?? ""));
			if (/\.(x?html?|xml)$/i.test(uri) || htmlPaths.has(uri)) throw new BookParseError(ERR_DRM);
		}
	}

	// документы по порядку spine
	const spine: ManifestItem[] = [];
	for (const ref of childrenByLocal(spineEl, "itemref")) {
		const it = manifest.get(ref.getAttribute("idref") ?? "");
		if (!it || it === navItem || !isHtmlItem(it)) continue;
		if (!spine.includes(it)) spine.push(it);
	}

	const docs: { path: string; body: Element }[] = [];
	for (const it of spine) {
		const entry = idx.get(it.path);
		if (!entry) continue;
		const { doc } = parseMarkup(await readMarkup(entry));
		const body = elementsByLocal(doc, "body")[0] ?? doc.documentElement;
		if (body) docs.push({ path: it.path, body });
	}

	// цели ссылок-сносок по всей книге
	const noteTargets = new Set<string>();
	for (const d of docs) {
		for (const a of elementsByLocal(d.body, "a")) {
			if (!isNoteRef(a)) continue;
			const href = hrefOf(a);
			const hash = href.indexOf("#");
			const pathPart = href.slice(0, hash);
			const target = pathPart ? key(resolvePath(d.path, pathPart)) : d.path;
			noteTargets.add(target + "#" + safeDecode(href.slice(hash + 1)));
		}
	}

	const w = new Walker(noteTargets);
	for (let i = 0; i < docs.length; i++) {
		const d = docs[i];
		if (!isTocPage(d.body, d.path)) w.walkFile(d.path, d.body);
		onProgress?.((i + 1) / docs.length);
	}
	if (!w.paragraphs.length) throw new BookParseError(ERR_EMPTY);

	// оглавление: nav → NCX → заголовки h1–h6
	let toc: TocEntry[] = [];
	if (navItem) {
		const entry = idx.get(navItem.path);
		if (entry) toc = buildToc(navEntries(parseMarkup(await readMarkup(entry)).doc), navItem.path, w);
	}
	if (!toc.length && ncxItem) {
		const entry = idx.get(ncxItem.path);
		if (entry) toc = buildToc(ncxEntries(parseXmlLoose(await readMarkup(entry))), ncxItem.path, w);
	}
	if (!toc.length && w.headings.length) {
		toc = normalizeToc(w.headings.map((h) => ({ title: h.title.slice(0, 150), level: h.level - 1, paragraph: h.paragraph })));
	}

	return {
		title: title || titleFromFileName(fileName),
		author: authors.join(", "),
		format: "epub",
		paragraphs: w.paragraphs,
		toc,
	};
}

/** Разбор EPUB из байтов. */
export async function parseEpub(data: Uint8Array | ArrayBuffer, fileName = "", onProgress?: (f: number) => void): Promise<ParsedBook> {
	return parseEpubZip(await loadZip(data), fileName, onProgress);
}
