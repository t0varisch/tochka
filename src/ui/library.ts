import { buildWords } from "../core/words";
import type { Settings } from "../settings";
import { addBook, askPersist, type BookMeta, deleteBook, listBooks } from "../store";
import type { ParsedBook } from "../types";
import { formatDuration, h, icon, iconButton, openSheet, plural, toast } from "./dom";
import { inAppBrowser, isStandalone, platform } from "./inapp";
import { openSettings } from "./settings-sheet";

export interface LibraryCtx {
	settings: Settings;
	saveSettings(): void;
	onSettingsChange(): void;
	openBook(id: string): void;
}

/** Средний множитель пауз — для оценки «осталось» без разбора книги. */
const AVG_PAUSE = 1.3;

/** Если за это время разбор не сдвинулся ни на шаг — считаем, что завис. */
const STALL_MS = 60000;

/** Плашка «открой в настоящем браузере» для встроенных окон Telegram и других приложений. */
function inAppBanner(app: string): HTMLElement {
	const p = platform();
	const where = app === "приложения" ? "во встроенном окне приложения" : `во встроенном браузере ${app}`;
	const how =
		p === "ios"
			? app === "Telegram"
				? "Нажми на компас внизу справа или «⋯» → «Открыть в Safari»."
				: "Нажми «⋯» или «Поделиться» → «Открыть в Safari»."
			: "Нажми «⋮» вверху справа → «Открыть в браузере» (Chrome).";
	const url = location.href.split("#")[0];
	const copy = h("button.secondary", { type: "button" }, "Скопировать ссылку");
	copy.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(url);
			toast("Ссылка скопирована — вставь её в Safari или Chrome");
		} catch {
			toast(url, 6000);
		}
	});
	const actions = h("div.banner-actions", {}, copy);
	if (p === "android") {
		const host = url.replace(/^https?:\/\//, "");
		actions.prepend(h("a.primary", { href: `intent://${host}#Intent;scheme=https;package=com.android.chrome;end` }, "Открыть в Chrome"));
	}
	return h(
		"div.banner",
		{ role: "alert" },
		h("strong", {}, `Ты открыл «Точку» ${where}.`),
		h("p", {}, "Здесь книги могут пропасть, а приложение не поставить на экран. Открой ссылку в обычном браузере. ", how),
		actions,
	);
}

function installHint(): HTMLElement | null {
	if (isStandalone()) return null;
	const p = platform();
	if (p === "ios") return h("p.hint", {}, "Чтобы читать как приложение: «Поделиться» (в новом Safari — через «⋯») → «На экран „Домой“».");
	if (p === "android") return h("p.hint", {}, "Чтобы читать как приложение: меню «⋮» в Chrome → «Установить приложение».");
	return null;
}

export async function openLibrary(root: HTMLElement, ctx: LibraryCtx): Promise<() => void> {
	// Без accept: iOS не знает .fb2 и делает такие файлы в «Файлах» серыми. Формат определяется по содержимому.
	const fileInput = h("input", { type: "file", multiple: true, hidden: true });
	const list = h("div.books");
	const busy = h("div.busy", { "aria-live": "polite" });
	const app = inAppBrowser();

	const view = h(
		"div.library",
		{},
		h(
			"header.lib-head",
			{},
			h("div", {}, h("h1", {}, "Точка"), h("p.tagline", {}, "Книги по одному слову")),
			iconButton("gear", "Настройки", () => openSettings(ctx.settings, () => (ctx.saveSettings(), ctx.onSettingsChange(), render()))),
		),
		h(
			"div.actions",
			{},
			h("button.primary", { type: "button", onclick: () => fileInput.click() }, icon("book", 20), "Открыть книгу"),
			h("button.secondary", { type: "button", onclick: () => pasteText() }, icon("text", 20), "Вставить текст"),
		),
		h("p.formats", {}, "FB2, EPUB, TXT, PDF. Книга остаётся на этом устройстве."),
		app ? inAppBanner(app) : installHint(),
		busy,
		list,
		fileInput,
	);
	root.replaceChildren(view);

	async function render(): Promise<void> {
		const books = await listBooks();
		list.replaceChildren();
		if (books.length === 0) {
			list.append(h("p.empty", {}, "Здесь пока пусто. Открой книгу — и начнём."));
			return;
		}
		for (const b of books) list.append(card(b));
	}

	function card(b: BookMeta): HTMLElement {
		const pct = b.wordCount > 1 ? Math.min(100, (b.position / (b.wordCount - 1)) * 100) : 0;
		const leftMs = ((b.wordCount - b.position) * AVG_PAUSE * 60000) / ctx.settings.wpm;
		const status = b.position === 0 ? `${b.wordCount.toLocaleString("ru")} ${plural(b.wordCount, "слово", "слова", "слов")} · ≈ ${formatDuration(leftMs)}` : pct >= 99.9 ? "Дочитана" : `${Math.round(pct)}% · осталось ≈ ${formatDuration(leftMs)}`;
		return h(
			"article.book",
			{},
			h(
				"button.book-open",
				{ type: "button", onclick: () => ctx.openBook(b.id) },
				h("span.book-name", {}, b.title),
				b.author ? h("span.book-author", {}, b.author) : null,
				h("span.book-progress", {}, h("i", { style: `width:${pct}%` })),
				h("span.book-status", {}, status),
			),
			iconButton("trash", "Удалить книгу", async () => {
				if (!confirm(`Удалить «${b.title}» с этого устройства?`)) return;
				await deleteBook(b.id);
				render();
			}),
		);
	}

	async function importFiles(files: File[]): Promise<void> {
		if (files.length === 0) return;
		askPersist();
		const parsers = await import("../parsers");
		let lastId = "";
		for (const f of files) {
			let pct = 0;
			let stage = "";
			let moved = Date.now();
			const show = () => {
				moved = Date.now();
				busy.textContent = `Открываю «${f.name}»… ${pct}%${stage ? ` · ${stage}` : ""}`;
			};
			show();
			// Сторож: если разбор долго не двигается, показываем ошибку с названием шага, а не висим молча
			let watch: ReturnType<typeof setInterval> | undefined;
			const stalled = new Promise<never>((_, reject) => {
				watch = setInterval(() => {
					if (Date.now() - moved > STALL_MS) reject(new Error(`файл обрабатывается слишком долго (шаг: ${stage || `${pct}%`})`));
				}, 2000);
			});
			try {
				const book = await Promise.race([
					parsers.parseFile(f, {
						onProgress: (x) => ((pct = Math.round(x * 100)), show()),
						onStage: (s) => ((stage = s), show()),
					}),
					stalled,
				]);
				stage = "сохраняю";
				show();
				lastId = await Promise.race([save(book), stalled]);
			} catch (e) {
				toast(`«${f.name}»: ${e instanceof Error ? e.message : "не получилось открыть"}`, 6000);
			} finally {
				clearInterval(watch);
			}
		}
		busy.textContent = "";
		if (files.length === 1 && lastId) ctx.openBook(lastId);
		else render();
	}

	async function save(book: ParsedBook): Promise<string> {
		const count = buildWords(book.paragraphs).words.length;
		if (count === 0) throw new Error("в файле не нашлось текста");
		return addBook(book, count);
	}

	function pasteText(): void {
		const title = h("input", { type: "text", placeholder: "Название (необязательно)", "aria-label": "Название" });
		const area = h("textarea", { rows: 10, placeholder: "Вставь сюда статью или главу", "aria-label": "Текст" });
		const go = h("button.primary", { type: "button" }, "Читать");
		const body = h("div.paste", {}, title, area, go);
		const close = openSheet("Свой текст", body);
		go.addEventListener("click", async () => {
			const text = area.value.trim();
			if (!text) return area.focus();
			const { parseText } = await import("../parsers");
			const name = title.value.trim() || `Текст от ${new Date().toLocaleDateString("ru")}`;
			try {
				const id = await save(parseText(text, name));
				close();
				ctx.openBook(id);
			} catch (e) {
				toast(e instanceof Error ? e.message : "Не получилось");
			}
		});
		setTimeout(() => area.focus(), 250);
	}

	fileInput.addEventListener("change", () => {
		const files = Array.from(fileInput.files ?? []);
		fileInput.value = "";
		importFiles(files);
	});

	// Перетаскивание файла на окно (компьютер)
	const onDragOver = (e: DragEvent) => {
		if (!e.dataTransfer?.types.includes("Files")) return;
		e.preventDefault();
		view.classList.add("dragging");
	};
	const onDragLeave = (e: DragEvent) => {
		if (e.relatedTarget === null) view.classList.remove("dragging");
	};
	const onDrop = (e: DragEvent) => {
		e.preventDefault();
		view.classList.remove("dragging");
		importFiles(Array.from(e.dataTransfer?.files ?? []));
	};
	window.addEventListener("dragover", onDragOver);
	window.addEventListener("dragleave", onDragLeave);
	window.addEventListener("drop", onDrop);

	await render();

	return () => {
		window.removeEventListener("dragover", onDragOver);
		window.removeEventListener("dragleave", onDragLeave);
		window.removeEventListener("drop", onDrop);
	};
}
