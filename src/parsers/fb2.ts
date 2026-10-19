// FictionBook 2: только текст книги — без описания, картинок (base64), стилей и сносок.
import type { ParsedBook, TocEntry } from "../types";
import { decodeMarkup } from "./decode";
import { attrLocal, localOf, repairXml, tryParseXml } from "./dom";
import { joinTitleLines } from "./headings";
import { BookParseError, ERR_EMPTY, GAP, cleanParagraph, isNoteMarker, titleFromFileName } from "./util";

type Ln = (el: Element) => string;

interface Ctx {
	ln: Ln;
	paragraphs: string[];
	toc: TocEntry[];
	/** id секций, на которые ведут ссылки-сноски type="note" */
	noteIds: Set<string>;
}

// Строчные элементы: текст идёт в текущий абзац
const INLINE = new Set(["strong", "emphasis", "style", "strikethrough", "sub", "sup", "code", "a", "span", "b", "i", "u", "em", "small"]);
// Никогда не читаем
const SKIP = new Set(["image", "binary", "description", "stylesheet", "empty-line", "img", "script"]);
// Блоки с одним абзацем текста
const TEXT_BLOCKS = new Set(["p", "v", "subtitle", "text-author", "date", "td", "th"]);

const XML_DECL_RE = /^\uFEFF?\s*<\?xml[^>]*\?>/;
const BINARY_RE = /<(?:[\w.-]+:)?binary\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?binary\s*>/g;

/** Убирает до разбора то, что не нужно и мешает: объявление XML и base64-картинки. */
function prepare(xml: string): string {
	return xml.replace(XML_DECL_RE, "").replace(BINARY_RE, "");
}

/**
 * Откат для битых файлов: все теги получают префикс «fb-», самозакрытые раскрываются.
 * Так HTML-парсер не применяет свои правила к title/style/body/image и не теряет текст.
 */
function toSafeHtml(xml: string): string {
	return xml.replace(
		/<(\/?)(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)((?:\s[^<>]*?)?)\s*(\/?)>/g,
		(_m, close: string, name: string, attrs: string, self: string) => {
			const tag = "fb-" + name.toLowerCase();
			if (close) return `</${tag}>`;
			return self ? `<${tag}${attrs}></${tag}>` : `<${tag}${attrs}>`;
		},
	);
}

function parseDom(xml: string): { doc: Document; ln: Ln; root: Element } {
	const prepared = prepare(xml);
	const doc = tryParseXml(prepared) ?? tryParseXml(repairXml(prepared));
	if (doc) {
		const ln: Ln = (el) => localOf(el);
		return { doc, ln, root: doc.documentElement };
	}
	const html = new DOMParser().parseFromString(toSafeHtml(prepared), "text/html");
	const ln: Ln = (el) => {
		const n = el.localName.toLowerCase();
		return n.startsWith("fb-") ? n.slice(3) : "#" + n;
	};
	const root = html.getElementsByTagName("fb-fictionbook")[0] ?? html.body ?? html.documentElement;
	return { doc: html, ln, root };
}

function firstDesc(el: Element | null, name: string, ln: Ln): Element | null {
	if (!el) return null;
	for (const c of Array.from(el.getElementsByTagName("*"))) if (ln(c) === name) return c;
	return null;
}

function child(el: Element | null, name: string, ln: Ln): Element | null {
	if (!el) return null;
	for (const c of Array.from(el.children)) if (ln(c) === name) return c;
	return null;
}

function children(el: Element | null, name: string, ln: Ln): Element[] {
	if (!el) return [];
	return Array.from(el.children).filter((c) => ln(c) === name);
}

function allByName(root: Element, name: string, ln: Ln): Element[] {
	return Array.from(root.getElementsByTagName("*")).filter((e) => ln(e) === name);
}

function hrefTarget(a: Element): string | null {
	const href = attrLocal(a, "href");
	if (!href || !href.startsWith("#")) return null;
	try {
		return decodeURIComponent(href.slice(1));
	} catch {
		return href.slice(1);
	}
}

function isNoteLink(a: Element): boolean {
	if ((a.getAttribute("type") ?? "").toLowerCase() === "note") return true;
	return hrefTarget(a) !== null && isNoteMarker(a.textContent ?? "");
}

function inlineText(el: Element, ctx: Ctx): string {
	let s = "";
	for (const node of Array.from(el.childNodes)) {
		if (node.nodeType === 3 || node.nodeType === 4) {
			s += node.nodeValue ?? "";
			continue;
		}
		if (node.nodeType !== 1) continue;
		const c = node as Element;
		const n = ctx.ln(c);
		if (SKIP.has(n) || (n === "a" && isNoteLink(c))) {
			if (n === "a" || n === "image") s += GAP;
			continue;
		}
		s += INLINE.has(n) ? inlineText(c, ctx) : " " + inlineText(c, ctx) + " ";
	}
	return s;
}

function emit(ctx: Ctx, text: string): void {
	const p = cleanParagraph(text);
	if (p) ctx.paragraphs.push(p);
}

/** Секция — сноска (цель ссылки type="note") или обёртка из одних сносок. */
function isNoteSection(sec: Element, ctx: Ctx): boolean {
	if (!ctx.noteIds.size) return false;
	const subs = children(sec, "section", ctx.ln);
	const id = sec.getAttribute("id");
	if (!subs.length) return !!id && ctx.noteIds.has(id) && (sec.textContent ?? "").length < 3000;
	if (!subs.every((s) => isNoteSection(s, ctx))) return false;
	const other = Array.from(sec.children).filter((c) => !["section", "title", "epigraph", "empty-line", "image"].includes(ctx.ln(c)));
	return other.length === 0;
}

function walkSection(sec: Element, ctx: Ctx, depth: number): void {
	if (isNoteSection(sec, ctx)) return;
	const title = child(sec, "title", ctx.ln);
	let inner = depth;
	if (title) {
		const start = ctx.paragraphs.length;
		walkMixed(title, ctx, depth, null);
		const lines = ctx.paragraphs.slice(start);
		if (lines.length) {
			ctx.toc.push({ title: joinTitleLines(lines), level: depth, paragraph: start });
			inner = depth + 1;
		}
	}
	walkMixed(sec, ctx, inner, title);
}

/** Обход блока: текст и строчные элементы копятся в абзац, блоки обрабатываются отдельно. */
function walkMixed(el: Element, ctx: Ctx, depth: number, skip: Element | null): void {
	let buf = "";
	for (const node of Array.from(el.childNodes)) {
		if (node.nodeType === 3 || node.nodeType === 4) {
			buf += node.nodeValue ?? "";
			continue;
		}
		if (node.nodeType !== 1 || node === skip) continue;
		const c = node as Element;
		const n = ctx.ln(c);
		if (SKIP.has(n)) {
			if (n === "image") buf += GAP;
			continue;
		}
		if (INLINE.has(n)) {
			buf += n === "a" && isNoteLink(c) ? GAP : inlineText(c, ctx);
			continue;
		}
		emit(ctx, buf);
		buf = "";
		if (n === "section") walkSection(c, ctx, depth);
		else if (TEXT_BLOCKS.has(n)) emit(ctx, inlineText(c, ctx));
		// title вне секции, epigraph, cite, poem, stanza, annotation, table, tr, неизвестные
		else walkMixed(c, ctx, depth, null);
	}
	emit(ctx, buf);
}

function authorName(a: Element, ln: Ln): string {
	const part = (name: string) => cleanParagraph(child(a, name, ln)?.textContent ?? "");
	const full = [part("first-name"), part("middle-name"), part("last-name")].filter(Boolean).join(" ");
	return full || part("nickname");
}

const NOTES_BODY_RE = /note|comment|примеч|коммент|сноск/i;

/** Тело без имени, но почти все его секции — цели ссылок-сносок. */
function looksLikeNotesBody(body: Element, targets: Set<string>, ln: Ln): boolean {
	const withId = allByName(body, "section", ln).filter((s) => s.getAttribute("id"));
	if (!withId.length) return false;
	const hits = withId.filter((s) => targets.has(s.getAttribute("id")!)).length;
	return hits / withId.length >= 0.5;
}

/** Разбор FB2 из строки (кодировка уже снята). */
export function parseFb2String(xml: string, fileName = ""): ParsedBook {
	const { ln, root } = parseDom(xml);

	const desc = child(root, "description", ln) ?? firstDesc(root, "description", ln);
	const info = child(desc, "title-info", ln) ?? firstDesc(desc, "title-info", ln);
	const title = cleanParagraph(child(info, "book-title", ln)?.textContent ?? "");
	const authors = [...new Set(children(info, "author", ln).map((a) => authorName(a, ln)).filter(Boolean))];

	let bodies = children(root, "body", ln);
	if (!bodies.length) bodies = allByName(root, "body", ln).filter((b) => !b.parentElement || ln(b.parentElement) !== "body");

	// Цели ссылок-сносок: явные (type="note") и все похожие на маркеры
	const noteIds = new Set<string>();
	const targets = new Set<string>();
	for (const a of allByName(root, "a", ln)) {
		const id = hrefTarget(a);
		if (!id) continue;
		if ((a.getAttribute("type") ?? "").toLowerCase() === "note") noteIds.add(id);
		if (isNoteLink(a)) targets.add(id);
	}

	const main = bodies.filter((b, i) => {
		if (NOTES_BODY_RE.test(b.getAttribute("name") ?? "")) return false;
		return i === 0 || !looksLikeNotesBody(b, targets, ln);
	});
	if (!main.length && bodies.length) main.push(bodies[0]);

	const ctx: Ctx = { ln, paragraphs: [], toc: [], noteIds };
	for (const body of main) walkMixed(body, ctx, 0, null);
	if (!ctx.paragraphs.length) throw new BookParseError(ERR_EMPTY);

	return {
		title: title || titleFromFileName(fileName),
		author: authors.join(", "),
		format: "fb2",
		paragraphs: ctx.paragraphs,
		toc: ctx.toc,
	};
}

/** Разбор FB2 из байтов: кодировка из объявления XML (часто windows-1251). */
export function parseFb2(bytes: Uint8Array, fileName = ""): ParsedBook {
	return parseFb2String(decodeMarkup(bytes).text, fileName);
}
