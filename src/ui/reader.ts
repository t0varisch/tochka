import { tick, unlockAudio } from "../audio";
import { splitOrp } from "../core/orp";
import { Player } from "../core/player";
import { buildWords, type Word, type WordStream } from "../core/words";
import { type Settings, WPM_MAX, WPM_MIN, WPM_STEP } from "../settings";
import { type BookMeta, getBook, newId, updateBook } from "../store";
import { formatDuration, h, icon, iconButton, openSheet, toast } from "./dom";
import { openSettings } from "./settings-sheet";

export interface AppCtx {
	settings: Settings;
	saveSettings(): void;
	goLibrary(): void;
}

interface ChapterMark {
	title: string;
	level: number;
	word: number;
}

const SAVE_EVERY_MS = 5000;

/** Ставит слово так, чтобы красная буква была ровно на засечке; длинные слова ужимает по ширине. */
function placeWord(el: HTMLElement, text: string, fontPx: number, anchor: number, width: number): void {
	const parts = splitOrp(text);
	const [b, p, a] = el.children as unknown as HTMLElement[];
	b.textContent = parts.before;
	p.textContent = parts.pivot;
	a.textContent = parts.after;
	el.style.fontSize = `${fontPx}px`;
	const pc = p.offsetLeft + p.offsetWidth / 2;
	const total = el.offsetWidth;
	const margin = 10;
	let scale = 1;
	if (pc > 0 && total > 0) {
		scale = Math.min(1, (anchor - margin) / pc, (width - anchor - margin) / Math.max(1, total - pc));
	}
	if (scale < 1) el.style.fontSize = `${fontPx * scale}px`;
	el.style.transform = `translateX(${anchor - pc * scale}px)`;
}

function wordEl(cls: string): HTMLElement {
	return h(`div.${cls}` as "div", {}, h("span.b"), h("span.p"), h("span.a"));
}

export async function openReader(root: HTMLElement, id: string, app: AppCtx): Promise<() => void> {
	const book = await getBook(id);
	if (!book) {
		toast("Книга не найдена");
		app.goLibrary();
		return () => {};
	}
	const meta: BookMeta = book.meta;
	const s = app.settings;
	let stream: WordStream = buildWords(book.paragraphs, s.pauses);
	if (stream.words.length === 0) {
		toast("В книге не нашлось текста");
		app.goLibrary();
		return () => {};
	}

	const chapters: ChapterMark[] = meta.toc
		.filter((t) => t.paragraph >= 0 && t.paragraph < stream.paraStarts.length)
		.map((t) => ({ title: t.title, level: t.level, word: stream.paraStarts[t.paragraph] }));
	const sortedChapters = [...chapters].sort((x, y) => x.word - y.word);

	// ---- разметка
	const bar = h("div.progress-fill");
	const chapterLine = h("div.chapter");
	const titleLine = h("div.book-title", {}, meta.title);
	const playBtn = h("button.play", { type: "button", "aria-label": "Читать" }, icon("play", 30));
	const wpmOut = h("button.wpm", { type: "button", "aria-label": "Скорость" });
	const metaLine = h("div.meta");
	const word = wordEl("word");
	const prevWord = wordEl("ctx-word.prev");
	const nextWord = wordEl("ctx-word.next");
	const focus = h("div.focus", {}, h("div.guide.top", {}, h("i")), word, h("div.guide.bottom", {}, h("i")));
	const stage = h("main.stage", { "aria-live": "off" }, prevWord, focus, nextWord);
	const pauseView = h("section.pause-view", { "aria-label": "Текст вокруг" });
	const bookmarkBtn = iconButton("bookmark", "Закладка здесь", () => addBookmark());

	const view = h(
		"div.reader",
		{},
		h("div.progress", { "aria-hidden": "true" }, bar),
		h(
			"header.topbar",
			{},
			iconButton("back", "К библиотеке", () => app.goLibrary()),
			h("div.where", {}, chapterLine, titleLine),
			iconButton("toc", "Оглавление и закладки", () => openNav()),
			bookmarkBtn,
			iconButton("gear", "Настройки", () => openReaderSettings()),
		),
		stage,
		pauseView,
		h(
			"footer.controls",
			{},
			h(
				"div.control-row",
				{},
				iconButton("prev", "Назад на предложение", () => player.backSentence()),
				playBtn,
				iconButton("next", "Вперёд на предложение", () => player.forwardSentence()),
				h("div.speed", {}, iconButton("minus", "Медленнее", () => changeWpm(-WPM_STEP)), wpmOut, iconButton("plus", "Быстрее", () => changeWpm(WPM_STEP))),
			),
			metaLine,
		),
	);
	root.replaceChildren(view);

	// ---- проигрыватель
	let lastSaved = 0;
	let wakeLock: { release(): Promise<void> } | null = null;

	const player = new Player(stream, { wpm: s.wpm, smart: s.smart, ramp: s.ramp }, onWord, onState);
	player.index = Math.min(meta.position, stream.words.length - 1);

	let appliedAnchor = -1;

	/** Ширина сцены и положение засечки; засечка в CSS всегда совпадает с той, по которой ставится слово. */
	function geometry(): { width: number; anchor: number } {
		const width = stage.clientWidth || window.innerWidth;
		const anchor = Math.round(width * (width < 768 ? 0.4 : 0.45));
		if (anchor !== appliedAnchor) {
			appliedAnchor = anchor;
			view.style.setProperty("--anchor", `${anchor}px`);
		}
		return { width, anchor };
	}

	function onWord(i: number, w: Word): void {
		const { width, anchor } = geometry();
		placeWord(word, w.text, s.fontSize, anchor, width);
		if (s.context) {
			const small = Math.max(14, Math.round(s.fontSize * 0.42));
			const pw = player.words[i - 1];
			const nw = player.words[i + 1];
			prevWord.style.visibility = pw ? "visible" : "hidden";
			nextWord.style.visibility = nw ? "visible" : "hidden";
			if (pw) placeWord(prevWord, pw.text, small, anchor, width);
			if (nw) placeWord(nextWord, nw.text, small, anchor, width);
		}
		if (player.playing) {
			if (s.sound) tick(w.end ? "end" : w.pause > 1.3 ? "comma" : "word");
			if (Date.now() - lastSaved > SAVE_EVERY_MS) savePosition();
			if ((i & 7) === 0) updateMeta();
		}
	}

	let wasPlaying = false;

	function onState(): void {
		const finished = wasPlaying && !player.playing && player.index >= player.words.length - 1;
		wasPlaying = player.playing;
		view.dataset.playing = String(player.playing);
		playBtn.replaceChildren(icon(player.playing ? "pause" : "play", 30));
		playBtn.setAttribute("aria-label", player.playing ? "Пауза" : "Читать");
		wpmOut.textContent = `${player.opts.wpm} сл/мин`;
		updateMeta();
		if (player.playing) {
			pauseView.replaceChildren();
			lockScreen();
		} else {
			renderPauseView();
			savePosition();
			unlockScreen();
			if (finished) toast("Книга дочитана");
		}
	}

	function updateMeta(): void {
		const n = player.words.length;
		const pct = n > 1 ? (player.index / (n - 1)) * 100 : 0;
		bar.style.width = `${pct}%`;
		metaLine.textContent = `${pct.toFixed(pct < 10 ? 1 : 0)}% · осталось ${formatDuration(player.remainingMs())}`;
		const ch = currentChapter();
		chapterLine.textContent = ch ? ch.title : "";
		view.classList.toggle("no-chapter", !ch);
	}

	function currentChapter(): ChapterMark | null {
		let found: ChapterMark | null = null;
		for (const c of sortedChapters) {
			if (c.word <= player.index) found = c;
			else break;
		}
		return found;
	}

	function savePosition(): void {
		lastSaved = Date.now();
		meta.position = player.index;
		updateBook(meta.id, { position: player.index, openedAt: Date.now() }).catch(() => {});
	}

	function changeWpm(delta: number): void {
		const v = Math.min(WPM_MAX, Math.max(WPM_MIN, player.opts.wpm + delta));
		s.wpm = v;
		app.saveSettings();
		player.setWpm(v);
	}

	// ---- текст вокруг на паузе: видно, что пропустил, и можно ткнуть в слово
	function renderPauseView(): void {
		const starts = stream.paraStarts;
		let lo = 0;
		let hi = starts.length - 1;
		let p = 0;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (starts[mid] <= player.index) {
				p = mid;
				lo = mid + 1;
			} else hi = mid - 1;
		}
		let from = starts[p];
		let to = p + 1 < starts.length ? starts[p + 1] : player.words.length;
		if (to - from > 90) {
			from = Math.max(from, player.index - 45);
			to = Math.min(to, from + 90);
		}
		const frag = document.createDocumentFragment();
		if (from > starts[p]) frag.append("… ");
		for (let i = from; i < to; i++) {
			const sp = h("span", { "data-i": i }, player.words[i].text);
			if (i === player.index) sp.className = "here";
			frag.append(sp, " ");
		}
		if (p + 1 < starts.length && to < starts[p + 1]) frag.append("…");
		pauseView.replaceChildren(h("p", {}, frag));
	}

	pauseView.addEventListener("click", (e) => {
		const t = (e.target as HTMLElement).closest("span[data-i]");
		if (!t) return;
		player.seek(Number(t.getAttribute("data-i")));
		renderPauseView();
	});

	// ---- закладки и оглавление
	function snippetAt(i: number): string {
		return player.words
			.slice(i, i + 9)
			.map((w) => w.text)
			.join(" ");
	}

	function addBookmark(): void {
		const b = { id: newId(), word: player.index, createdAt: Date.now(), snippet: snippetAt(player.index) };
		meta.bookmarks = [...meta.bookmarks, b].sort((x, y) => x.word - y.word);
		updateBook(meta.id, { bookmarks: meta.bookmarks }).catch(() => {});
		bookmarkBtn.classList.add("flash");
		setTimeout(() => bookmarkBtn.classList.remove("flash"), 600);
		toast("Закладка добавлена");
	}

	function openNav(): void {
		player.pause();
		const n = player.words.length;
		const pctOf = (w: number) => (n > 1 ? (w / (n - 1)) * 100 : 0);

		const posOut = h("output", {}, `${pctOf(player.index).toFixed(1)}%`);
		const pos = h("input", { type: "range", min: 0, max: 1000, step: 1, value: Math.round(pctOf(player.index) * 10), "aria-label": "Позиция в книге" });
		pos.addEventListener("input", () => {
			const w = Math.round((Number(pos.value) / 1000) * (n - 1));
			posOut.textContent = `${(Number(pos.value) / 10).toFixed(1)}% · ${snippetAt(w).slice(0, 40)}…`;
		});
		pos.addEventListener("change", () => player.seek(Math.round((Number(pos.value) / 1000) * (n - 1))));

		const tocList = h("div.toc-list");
		const current = currentChapter();
		if (chapters.length === 0) tocList.append(h("p.empty", {}, "В этой книге нет оглавления. Двигайся ползунком выше."));
		for (const c of chapters) {
			const btn = h(
				"button.toc-item",
				{ type: "button", style: `padding-left:${12 + c.level * 16}px` },
				h("span", {}, c.title),
				h("small", {}, `${Math.round(pctOf(c.word))}%`),
			);
			if (c === current) btn.classList.add("current");
			btn.addEventListener("click", () => {
				player.seek(c.word);
				close();
			});
			tocList.append(btn);
		}

		const marks = h("div.marks-list");
		const renderMarks = () => {
			marks.replaceChildren();
			if (meta.bookmarks.length === 0) {
				marks.append(h("p.empty", {}, "Закладок пока нет. Значок закладки сверху отмечает текущее место."));
				return;
			}
			for (const b of meta.bookmarks) {
				const ch = sortedChapters.filter((c) => c.word <= b.word).pop();
				const row = h(
					"div.mark",
					{},
					h(
						"button.mark-go",
						{ type: "button", onclick: () => (player.seek(b.word), close()) },
						h("span", {}, `${b.snippet}…`),
						h("small", {}, `${Math.round(pctOf(b.word))}%${ch ? ` · ${ch.title}` : ""}`),
					),
					iconButton("trash", "Удалить закладку", () => {
						meta.bookmarks = meta.bookmarks.filter((x) => x.id !== b.id);
						updateBook(meta.id, { bookmarks: meta.bookmarks }).catch(() => {});
						renderMarks();
					}),
				);
				marks.append(row);
			}
		};
		renderMarks();

		const tabToc = h("button", { type: "button", role: "tab", "aria-selected": "true" }, "Оглавление");
		const tabMarks = h("button", { type: "button", role: "tab", "aria-selected": "false" }, `Закладки${meta.bookmarks.length ? ` · ${meta.bookmarks.length}` : ""}`);
		const panes = h("div.panes", {}, tocList, marks);
		marks.hidden = true;
		const select = (toc: boolean) => {
			tabToc.setAttribute("aria-selected", String(toc));
			tabMarks.setAttribute("aria-selected", String(!toc));
			tocList.hidden = !toc;
			marks.hidden = toc;
		};
		tabToc.addEventListener("click", () => select(true));
		tabMarks.addEventListener("click", () => select(false));

		const body = h("div.nav", {}, h("label.row.range-row", {}, h("span.row-label", {}, "Позиция", posOut), pos), h("div.tabs", { role: "tablist" }, tabToc, tabMarks), panes);
		const close = openSheet("Навигация", body);
		requestAnimationFrame(() => tocList.querySelector(".current")?.scrollIntoView({ block: "center" }));
	}

	function openReaderSettings(): void {
		player.pause();
		const before = { ...s };
		openSettings(s, (next) => {
			app.saveSettings();
			if (next.pauses !== before.pauses) {
				stream = buildWords(book!.paragraphs, next.pauses);
				player.stream = stream;
				before.pauses = next.pauses;
			}
			player.opts.smart = next.smart;
			player.opts.ramp = next.ramp;
			player.setWpm(next.wpm);
			applyLook();
			player.show();
		});
	}

	function applyLook(): void {
		view.classList.toggle("with-context", s.context);
		view.classList.toggle("with-guides", s.guides);
		view.style.setProperty("--word-size", `${s.fontSize}px`);
		geometry();
	}

	// ---- экран не гаснет во время чтения
	async function lockScreen(): Promise<void> {
		try {
			const wl = (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock;
			if (wl && !wakeLock) wakeLock = await wl.request("screen");
		} catch {
			wakeLock = null;
		}
	}

	function unlockScreen(): void {
		wakeLock?.release().catch(() => {});
		wakeLock = null;
	}

	// ---- управление
	const togglePlay = () => {
		if (s.sound) unlockAudio();
		player.toggle();
	};
	playBtn.addEventListener("click", togglePlay);
	stage.addEventListener("click", togglePlay);
	wpmOut.addEventListener("click", () => openReaderSettings());

	const onKey = (e: KeyboardEvent) => {
		if (document.querySelector(".sheet-backdrop")) return;
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
		if (e.key === " " || e.key === "k") {
			e.preventDefault();
			togglePlay();
		} else if (e.key === "ArrowLeft") {
			e.preventDefault();
			player.backSentence();
		} else if (e.key === "ArrowRight") {
			e.preventDefault();
			player.forwardSentence();
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			changeWpm(WPM_STEP);
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			changeWpm(-WPM_STEP);
		} else if (e.key === "Escape") {
			app.goLibrary();
		} else if (e.key === "b" || e.key === "и") {
			addBookmark();
		}
	};
	const onHide = () => {
		if (document.visibilityState === "hidden") {
			player.pause();
			savePosition();
		} else if (player.playing) lockScreen();
	};
	const onResize = () => {
		applyLook();
		player.show();
	};
	document.addEventListener("keydown", onKey);
	document.addEventListener("visibilitychange", onHide);
	window.addEventListener("pagehide", savePosition);
	window.addEventListener("resize", onResize);

	applyLook();
	await document.fonts?.ready;
	player.show();
	onState();
	updateBook(meta.id, { openedAt: Date.now() }).catch(() => {});

	return () => {
		player.pause();
		player.destroy();
		savePosition();
		unlockScreen();
		document.removeEventListener("keydown", onKey);
		document.removeEventListener("visibilitychange", onHide);
		window.removeEventListener("pagehide", savePosition);
		window.removeEventListener("resize", onResize);
	};
}
