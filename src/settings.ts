import type { PauseLevel } from "./core/words";

export type Theme = "auto" | "light" | "paper" | "dark" | "black";
export type FontKind = "mono" | "serif" | "sans";

export interface Settings {
	wpm: number;
	fontSize: number;
	font: FontKind;
	theme: Theme;
	sound: boolean;
	/** Предыдущее и следующее слово бледно сверху и снизу. */
	context: boolean;
	/** Линии с засечкой над и под словом. */
	guides: boolean;
	ramp: boolean;
	smart: boolean;
	pauses: PauseLevel;
}

const KEY = "tochka:settings";
const narrow = typeof window !== "undefined" && window.innerWidth < 768;

// Значения по умолчанию повторяют Speeedy, на котором Роман проверял чтение (19.10.2026)
export const DEFAULTS: Settings = {
	wpm: 300,
	fontSize: narrow ? 48 : 80,
	font: "mono",
	theme: "auto",
	sound: true,
	context: true,
	guides: true,
	ramp: true,
	smart: false,
	pauses: 2,
};

export const WPM_MIN = 100;
export const WPM_MAX = 1200;
export const WPM_STEP = 25;

export function loadSettings(): Settings {
	try {
		const raw = localStorage.getItem(KEY);
		if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
	} catch {
		/* приватный режим или запрет хранилища */
	}
	return { ...DEFAULTS };
}

export function saveSettings(s: Settings): void {
	try {
		localStorage.setItem(KEY, JSON.stringify(s));
	} catch {
		/* не сохранилось — не страшно */
	}
}

const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

export function applyTheme(s: Settings): void {
	const t = s.theme === "auto" ? (media?.matches ? "dark" : "light") : s.theme;
	document.documentElement.dataset.theme = t;
	document.documentElement.dataset.font = s.font;
	const color = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
	document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color || "#1b1e24");
}

export function watchSystemTheme(get: () => Settings): void {
	media?.addEventListener?.("change", () => applyTheme(get()));
}
