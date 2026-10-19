import { type FontKind, type Settings, type Theme, WPM_MAX, WPM_MIN, WPM_STEP } from "../settings";
import type { PauseLevel } from "../core/words";
import { h, openSheet } from "./dom";

function range(label: string, value: number, min: number, max: number, step: number, fmt: (v: number) => string, set: (v: number) => void): HTMLElement {
	const out = h("output", {}, fmt(value));
	const input = h("input", { type: "range", min, max, step, value, "aria-label": label });
	input.addEventListener("input", () => {
		const v = Number(input.value);
		out.textContent = fmt(v);
		set(v);
	});
	return h("label.row.range-row", {}, h("span.row-label", {}, label, out), input);
}

function segmented<T extends string | number>(label: string, value: T, options: [T, string][], set: (v: T) => void): HTMLElement {
	const group = h("div.segmented", { role: "radiogroup", "aria-label": label });
	for (const [v, text] of options) {
		const b = h("button", { type: "button", role: "radio", "aria-checked": String(v === value) }, text);
		b.addEventListener("click", () => {
			for (const x of group.children) x.setAttribute("aria-checked", "false");
			b.setAttribute("aria-checked", "true");
			set(v);
		});
		group.append(b);
	}
	return h("div.row", {}, h("span.row-label", {}, label), group);
}

function toggle(label: string, hint: string, value: boolean, set: (v: boolean) => void): HTMLElement {
	const input = h("input", { type: "checkbox", role: "switch" });
	input.checked = value;
	input.addEventListener("change", () => set(input.checked));
	return h("label.row.toggle-row", {}, h("span.toggle-text", {}, h("span", {}, label), hint ? h("small", {}, hint) : null), input);
}

export function openSettings(s: Settings, onChange: (s: Settings) => void): void {
	const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
		s[k] = v;
		onChange(s);
	};
	const body = h(
		"div.settings",
		{},
		range("Скорость", s.wpm, WPM_MIN, WPM_MAX, WPM_STEP, (v) => `${v} сл/мин`, (v) => set("wpm", v)),
		range("Размер слова", s.fontSize, 24, 160, 2, (v) => `${v} px`, (v) => set("fontSize", v)),
		segmented<Theme>("Тема", s.theme, [["auto", "Авто"], ["light", "Светлая"], ["paper", "Бумага"], ["dark", "Тёмная"], ["black", "Чёрная"]], (v) => set("theme", v)),
		segmented<FontKind>("Шрифт", s.font, [["mono", "Моно"], ["serif", "С засечками"], ["sans", "Без засечек"]], (v) => set("font", v)),
		segmented<PauseLevel>("Паузы на знаках", s.pauses, [[0, "Нет"], [1, "Мягкие"], [2, "Обычные"], [3, "Длинные"]], (v) => set("pauses", v)),
		toggle("Тиканье", "Тихий щелчок на каждое слово держит ритм", s.sound, (v) => set("sound", v)),
		toggle("Соседние слова", "Бледно показывать предыдущее и следующее", s.context, (v) => set("context", v)),
		toggle("Направляющие", "Линии с засечкой над и под словом", s.guides, (v) => set("guides", v)),
		toggle("Плавный старт", "Первые слова после паузы идут медленнее", s.ramp, (v) => set("ramp", v)),
		toggle("Умная скорость", "Короткие слова быстрее, длинные медленнее", s.smart, (v) => set("smart", v)),
		h(
			"p.fineprint",
			{},
			"Книги хранятся только на этом устройстве. Красная буква, паузы и звук взяты из ",
			h("a", { href: "https://github.com/sami-29/speeedy", target: "_blank", rel: "noopener" }, "Speeedy"),
			" (лицензия MIT).",
		),
	);
	openSheet("Настройки", body);
}
