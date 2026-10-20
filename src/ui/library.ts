import { buildWords } from "../core/words";
import type { Settings } from "../settings";
import { addBook, askPersist, type BookMeta, deleteBook, listBooks } from "../store";
import type { ParsedBook } from "../types";
import { formatDuration, h, icon, iconButton, openSheet, plural, toast } from "./dom";
import { openSettings } from "./settings-sheet";

export interface LibraryCtx {
	settings: Settings;
	saveSettings(): void;
	onSettingsChange(): void;
	openBook(id: string): void;
}

/** Средний множитель пауз — для оценки «осталось» без разбора книги. */
const AVG_PAUSE = 1.3;

function isIosSafari(): boolean {
	const ua = navigator.userAgent;
	const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
	const standalone = (navigator as unknown as { standalone?: boolean }).standalone === true || window.matchMedia("(display-mode: standalone)").matches;
	return ios && !standalone;
}

export async function openLibrary(root: HTMLElement, ctx: LibraryCtx): Promise<() => void> {
	// Без accept: iOS не знает .fb2 и делает такие файлы в «Файлах» серыми. Формат определяется по содержимому.
	const fileInput = h("input", { type: "file", multiple: true, hidden: true });
	const list = h("div.books");
	const busy = h("div.busy", { "aria-live": "polite" });

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
		isIosSafari() ? h("p.hint", {}, "Чтобы читать как приложение: кнопка «Поделиться» внизу Safari → «На экран „Домой“».") : null,
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
			busy.textContent = `Открываю «${f.name}»…`;
			try {
				const book = await parsers.parseFile(f, {
					onProgress: (x) => (busy.textContent = `Открываю «${f.name}»… ${Math.round(x * 100)}%`),
				});
				lastId = await save(book);
			} catch (e) {
				toast(`«${f.name}»: ${e instanceof Error ? e.message : "не получилось открыть"}`, 5000);
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
