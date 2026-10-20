// Встроенные браузеры мессенджеров: там нельзя поставить приложение на экран,
// а книги могут стереться вместе с окном. Просим открыть ссылку в настоящем браузере.

export type Platform = "ios" | "android" | "other";

export function platform(): Platform {
	const ua = navigator.userAgent;
	if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "ios";
	if (/Android/i.test(ua)) return "android";
	return "other";
}

export function isStandalone(): boolean {
	return (navigator as unknown as { standalone?: boolean }).standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

/** Название приложения, во встроенном браузере которого открыта страница, или null. */
export function inAppBrowser(): string | null {
	const ua = navigator.userAgent;
	const w = window as unknown as Record<string, unknown>;
	if (w.TelegramWebviewProxy || w.TelegramWebviewProxyProto || w.TelegramWebview || /Telegram/i.test(ua)) return "Telegram";
	if (/Instagram/i.test(ua)) return "Instagram";
	if (/FBAN|FBAV|FB_IAB/i.test(ua)) return "Facebook";
	if (/WhatsApp/i.test(ua)) return "WhatsApp";
	if (/VKAndroidApp|VKClient|com\.vkontakte/i.test(ua)) return "ВКонтакте";
	// Android WebView помечает себя «; wv)»
	if (platform() === "android" && /; wv\)/.test(ua)) return "приложения";
	// Любой браузер на iPhone (Safari, Chrome, Яндекс) пишет «Safari/» в конце; встроенные окна приложений — нет
	if (platform() === "ios" && !isStandalone() && !/Safari\//.test(ua)) return "приложения";
	return null;
}
