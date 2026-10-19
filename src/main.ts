import "./styles.css";
import { registerSW } from "virtual:pwa-register";
import { applyTheme, loadSettings, saveSettings, watchSystemTheme } from "./settings";
import { toast } from "./ui/dom";
import { openLibrary } from "./ui/library";
import { openReader } from "./ui/reader";

const root = document.getElementById("app") as HTMLElement;
const settings = loadSettings();
let cleanup: (() => void) | null = null;
let routeSeq = 0;

applyTheme(settings);
watchSystemTheme(() => settings);

function persist(): void {
	saveSettings(settings);
	applyTheme(settings);
}

async function route(): Promise<void> {
	const seq = ++routeSeq;
	cleanup?.();
	cleanup = null;
	const m = location.hash.match(/^#\/read\/(.+)$/);
	try {
		const done = m
			? await openReader(root, decodeURIComponent(m[1]), { settings, saveSettings: persist, goLibrary: () => (location.hash = "#/") })
			: await openLibrary(root, {
					settings,
					saveSettings: persist,
					onSettingsChange: () => applyTheme(settings),
					openBook: (id) => (location.hash = `#/read/${encodeURIComponent(id)}`),
				});
		if (seq === routeSeq) cleanup = done;
		else done();
	} catch (e) {
		console.error(e);
		toast("Что-то сломалось. Обнови страницу.", 5000);
	}
}

window.addEventListener("hashchange", route);
route();

try {
	registerSW({ immediate: true });
} catch {
	/* без офлайна тоже работает */
}
