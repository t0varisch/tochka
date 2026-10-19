type Attrs = Record<string, string | number | boolean | EventListener | undefined>;
type Child = Node | string | null | undefined | false;

/** Короткий конструктор элементов: h("button.primary", { onclick }, "Текст"). */
export function h<K extends keyof HTMLElementTagNameMap>(
	tag: K | `${K}.${string}`,
	attrs: Attrs = {},
	...children: Child[]
): HTMLElementTagNameMap[K] {
	const [name, ...classes] = tag.split(".");
	const el = document.createElement(name as K);
	if (classes.length) el.className = classes.join(" ");
	for (const [k, v] of Object.entries(attrs)) {
		if (v === undefined || v === false) continue;
		if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
		else if (k === "html") el.innerHTML = String(v);
		else el.setAttribute(k, v === true ? "" : String(v));
	}
	for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
	return el;
}

const PATHS: Record<string, string> = {
	back: '<path d="M15 18l-6-6 6-6"/>',
	toc: '<path d="M4 6h16M4 12h16M4 18h10"/>',
	bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
	gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
	play: '<path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke="none"/>',
	pause: '<path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z" fill="currentColor" stroke="none"/>',
	prev: '<path d="M11 18l-6-6 6-6M19 18l-6-6 6-6"/>',
	next: '<path d="M13 6l6 6-6 6M5 6l6 6-6 6"/>',
	minus: '<path d="M5 12h14"/>',
	plus: '<path d="M12 5v14M5 12h14"/>',
	close: '<path d="M6 6l12 12M18 6L6 18"/>',
	trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
	book: '<path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z"/>',
	text: '<path d="M5 5h14M5 10h14M5 15h9M5 20h6"/>',
};

export function icon(name: keyof typeof PATHS | string, size = 22): SVGSVGElement {
	const wrap = document.createElement("span");
	wrap.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] ?? ""}</svg>`;
	return wrap.firstElementChild as SVGSVGElement;
}

export function iconButton(name: string, label: string, onclick: () => void, cls = ""): HTMLButtonElement {
	return h(`button.icon-btn${cls ? `.${cls}` : ""}` as "button", { type: "button", "aria-label": label, title: label, onclick: () => onclick() }, icon(name));
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function toast(text: string, ms = 2200): void {
	let el = document.getElementById("toast");
	if (!el) {
		el = h("div.toast", { id: "toast", role: "status" });
		document.body.append(el);
	}
	el.textContent = text;
	el.classList.add("show");
	if (toastTimer) clearTimeout(toastTimer);
	toastTimer = setTimeout(() => el?.classList.remove("show"), ms);
}

/** Выезжающая снизу панель. Возвращает функцию закрытия. */
export function openSheet(title: string, body: HTMLElement, onClose?: () => void): () => void {
	const backdrop = h("div.sheet-backdrop");
	const close = () => {
		document.removeEventListener("keydown", onKey, true);
		backdrop.classList.remove("open");
		setTimeout(() => backdrop.remove(), 200);
		onClose?.();
	};
	const onKey = (e: KeyboardEvent) => {
		if (e.key === "Escape") {
			e.stopPropagation();
			close();
		}
	};
	const sheet = h(
		"div.sheet",
		{ role: "dialog", "aria-label": title },
		h("div.sheet-head", {}, h("h2", {}, title), iconButton("close", "Закрыть", close)),
		h("div.sheet-body", {}, body),
	);
	backdrop.append(sheet);
	backdrop.addEventListener("click", (e) => {
		if (e.target === backdrop) close();
	});
	document.addEventListener("keydown", onKey, true);
	document.body.append(backdrop);
	requestAnimationFrame(() => backdrop.classList.add("open"));
	return close;
}

export function formatDuration(ms: number): string {
	const min = Math.max(0, Math.round(ms / 60000));
	if (min < 1) return "меньше минуты";
	const hh = Math.floor(min / 60);
	const mm = min % 60;
	if (hh === 0) return `${mm} мин`;
	return mm ? `${hh} ч ${mm} мин` : `${hh} ч`;
}

export function plural(n: number, one: string, few: string, many: string): string {
	const a = Math.abs(n) % 100;
	const b = a % 10;
	if (a > 10 && a < 20) return many;
	if (b > 1 && b < 5) return few;
	if (b === 1) return one;
	return many;
}
