// Разбор разметки через DOMParser: XML, починка частых ошибок, откат на HTML.

// Именованные сущности HTML, которых нет в XML (частая причина ошибок разбора)
const ENTITIES: Record<string, string> = {
	nbsp: "\u00A0", shy: "\u00AD", mdash: "—", ndash: "–", minus: "−", hellip: "…",
	laquo: "«", raquo: "»", bdquo: "„", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", sbquo: "‚",
	lsaquo: "‹", rsaquo: "›", prime: "′", Prime: "″", copy: "©", reg: "®", trade: "™", deg: "°",
	middot: "·", bull: "•", sect: "§", para: "¶", plusmn: "±", times: "×", divide: "÷", frac12: "½",
	frac14: "¼", frac34: "¾", sup1: "¹", sup2: "²", sup3: "³", euro: "€", pound: "£", cent: "¢",
	yen: "¥", curren: "¤", iexcl: "¡", iquest: "¿", ordf: "ª", ordm: "º", not: "¬", macr: "¯",
	acute: "´", micro: "µ", cedil: "¸", uml: "¨", dagger: "†", Dagger: "‡", permil: "‰", larr: "←",
	rarr: "→", uarr: "↑", darr: "↓", harr: "↔", le: "≤", ge: "≥", ne: "≠", asymp: "≈", infin: "∞",
	ensp: " ", emsp: " ", thinsp: "\u2009", zwnj: "\u200C", zwj: "\u200D", lrm: "\u200E", rlm: "\u200F",
	agrave: "à", aacute: "á", acirc: "â", auml: "ä", atilde: "ã", aring: "å", aelig: "æ", ccedil: "ç",
	egrave: "è", eacute: "é", ecirc: "ê", euml: "ë", igrave: "ì", iacute: "í", icirc: "î", iuml: "ï",
	ntilde: "ñ", ograve: "ò", oacute: "ó", ocirc: "ô", ouml: "ö", otilde: "õ", oslash: "ø", ugrave: "ù",
	uacute: "ú", ucirc: "û", uuml: "ü", yacute: "ý", yuml: "ÿ", szlig: "ß", Auml: "Ä", Ouml: "Ö", Uuml: "Ü",
	Eacute: "É", oelig: "œ", OElig: "Œ",
};
const XML_ENTITIES = new Set(["amp", "lt", "gt", "quot", "apos"]);

/** Чинит то, на чём чаще всего ломается XML: HTML-сущности, голые «&», управляющие символы. */
export function repairXml(text: string): string {
	return text
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
		.replace(/&(#\d{1,7};|#x[0-9a-fA-F]{1,6};|[A-Za-z][A-Za-z0-9]{0,31};)?/g, (m, ent: string | undefined) => {
			if (!ent) return "&amp;";
			if (ent[0] === "#") return m;
			const name = ent.slice(0, -1);
			if (XML_ENTITIES.has(name)) return m;
			const ch = ENTITIES[name];
			return ch !== undefined ? ch : "&amp;" + ent;
		});
}

/** Есть ли в документе ошибка разбора (Chrome, Firefox, jsdom ставят элемент parsererror). */
export function hasParserError(doc: Document): boolean {
	return doc.getElementsByTagName("parsererror").length > 0 || doc.getElementsByTagNameNS("*", "parsererror").length > 0;
}

/** XML-разбор. null — если документ не разобрался. */
export function tryParseXml(text: string, type: DOMParserSupportedType = "application/xml"): Document | null {
	try {
		const doc = new DOMParser().parseFromString(text, type);
		if (!doc.documentElement || hasParserError(doc)) return null;
		return doc;
	} catch {
		return null;
	}
}

const VOID_HTML = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

/** Перед HTML-разбором раскрывает самозакрытые теги (`<a id="x"/>`, `<script/>`), иначе HTML проглотит текст. */
export function expandSelfClosing(text: string): string {
	return text.replace(/<([A-Za-z][\w:.-]*)(\s[^<>]*?)?\s*\/>/g, (m, name: string, attrs: string | undefined) =>
		VOID_HTML.has(name.toLowerCase()) ? m : `<${name}${attrs ?? ""}></${name}>`,
	);
}

/** XHTML → (починка) → HTML. Всегда возвращает документ. */
export function parseMarkup(text: string): { doc: Document; html: boolean } {
	const xml = tryParseXml(text, "application/xhtml+xml") ?? tryParseXml(repairXml(text), "application/xhtml+xml");
	if (xml) return { doc: xml, html: false };
	return { doc: new DOMParser().parseFromString(expandSelfClosing(text), "text/html"), html: true };
}

/** Локальное имя элемента в нижнем регистре, без префикса пространства имён. */
export function localOf(el: Element): string {
	const n = (el.localName || el.nodeName).toLowerCase();
	const i = n.indexOf(":");
	return i >= 0 ? n.slice(i + 1) : n;
}

/** Значение атрибута по локальному имени (`href`, `l:href`, `xlink:href`, `epub:type`…). */
export function attrLocal(el: Element, local: string): string | null {
	const direct = el.getAttribute(local);
	if (direct !== null) return direct;
	for (const a of Array.from(el.attributes)) {
		const name = a.name.toLowerCase();
		if (name === local || name.endsWith(":" + local) || a.localName === local) return a.value;
	}
	return null;
}

/** Все элементы с данным локальным именем (с учётом префиксов и пространств имён). */
export function elementsByLocal(root: Document | Element, local: string): Element[] {
	const ns = Array.from(root.getElementsByTagNameNS("*", local));
	if (ns.length) return ns;
	const lower = local.toLowerCase();
	return Array.from(root.getElementsByTagName("*")).filter((e) => localOf(e) === lower);
}

/** Разбор служебного XML (OPF, NCX, container): XML → починка → HTML. */
export function parseXmlLoose(text: string): Document {
	return (
		tryParseXml(text) ??
		tryParseXml(repairXml(text)) ??
		new DOMParser().parseFromString(expandSelfClosing(text), "text/html")
	);
}

/** Первый дочерний элемент с данным локальным именем. */
export function childByLocal(el: Element | null | undefined, local: string): Element | null {
	if (!el) return null;
	const lower = local.toLowerCase();
	for (const c of Array.from(el.children)) if (localOf(c) === lower) return c;
	return null;
}

/** Все дочерние элементы с данным локальным именем. */
export function childrenByLocal(el: Element | null | undefined, local: string): Element[] {
	if (!el) return [];
	const lower = local.toLowerCase();
	return Array.from(el.children).filter((c) => localOf(c) === lower);
}
