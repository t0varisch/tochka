// Тик на каждое слово. Звук как в Speeedy (MIT, © 2026 Speeedy): короткий синус,
// ниже тоном на запятой и на конце предложения.

type Ctx = AudioContext;
let ctx: Ctx | null = null;

function context(): Ctx | null {
	try {
		if (ctx && ctx.state === "closed") ctx = null;
		if (!ctx) {
			const C = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
			if (!C) return null;
			ctx = new C();
		}
		return ctx;
	} catch {
		return null;
	}
}

/** Вызывать из обработчика нажатия: iOS разрешает звук только после жеста. */
export function unlockAudio(): void {
	const c = context();
	if (c && c.state !== "running") c.resume().catch(() => {});
}

export function tick(kind: "word" | "comma" | "end"): void {
	const c = context();
	if (!c || c.state !== "running") return;
	try {
		const now = c.currentTime;
		const osc = c.createOscillator();
		const gain = c.createGain();
		osc.connect(gain);
		gain.connect(c.destination);
		osc.type = "sine";
		osc.frequency.setValueAtTime(kind === "end" ? 660 : kind === "comma" ? 780 : 880, now);
		const dur = kind === "end" ? 0.015 : kind === "comma" ? 0.01 : 0.008;
		gain.gain.setValueAtTime(kind === "end" ? 0.04 : kind === "comma" ? 0.03 : 0.035, now);
		gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
		osc.start(now);
		osc.stop(now + dur);
	} catch {
		/* звук не критичен */
	}
}
