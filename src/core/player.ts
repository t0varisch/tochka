import { sentenceStartAt, smartFactor, type Word, type WordStream } from "./words";

export interface PlayerOptions {
	wpm: number;
	smart: boolean;
	/** Плавный старт: первые слова после запуска идут медленнее. */
	ramp: boolean;
}

const RAMP_WORDS = 8;
const RAMP_FROM = 0.55;

/** Проигрыватель: держит позицию, показывает слова по таймеру с поправкой на дрейф. */
export class Player {
	index = 0;
	playing = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private nextAt = 0;
	private rampStep = RAMP_WORDS;

	constructor(
		public stream: WordStream,
		public opts: PlayerOptions,
		private onWord: (index: number, word: Word) => void,
		private onState: () => void,
	) {}

	get words(): Word[] {
		return this.stream.words;
	}

	play(): void {
		if (this.playing || this.words.length === 0) return;
		if (this.index >= this.words.length - 1 && this.words.length > 1) this.index = 0;
		this.playing = true;
		this.rampStep = this.opts.ramp ? 0 : RAMP_WORDS;
		this.nextAt = performance.now();
		this.onState();
		this.tick();
	}

	pause(): void {
		if (!this.playing) return;
		this.playing = false;
		this.clear();
		this.onState();
	}

	toggle(): void {
		if (this.playing) this.pause();
		else this.play();
	}

	seek(index: number): void {
		this.index = Math.max(0, Math.min(this.words.length - 1, index));
		this.show();
		if (this.playing) {
			this.clear();
			this.rampStep = this.opts.ramp ? 0 : RAMP_WORDS;
			this.nextAt = performance.now() + this.duration(this.index);
			this.schedule();
		}
		this.onState();
	}

	/** Назад: к началу текущего предложения, а если уже в начале — к предыдущему. */
	backSentence(): void {
		const s = this.stream.sentenceStarts;
		if (s.length === 0) return this.seek(0);
		let k = sentenceStartAt(s, this.index);
		if (this.index - s[k] < 2 && k > 0) k--;
		this.seek(s[k]);
	}

	forwardSentence(): void {
		const s = this.stream.sentenceStarts;
		const k = sentenceStartAt(s, this.index);
		if (k + 1 < s.length) this.seek(s[k + 1]);
	}

	setWpm(wpm: number): void {
		this.opts.wpm = wpm;
		this.onState();
	}

	show(): void {
		const w = this.words[this.index];
		if (w) this.onWord(this.index, w);
	}

	/** Длительность показа слова в мс. */
	duration(i: number): number {
		const w = this.words[i];
		if (!w) return 0;
		let ms = (60000 / this.opts.wpm) * w.pause;
		if (this.opts.smart) ms *= smartFactor(w);
		if (this.rampStep < RAMP_WORDS) {
			const speed = RAMP_FROM + ((1 - RAMP_FROM) * this.rampStep) / RAMP_WORDS;
			ms /= speed;
		}
		return ms;
	}

	/** Оценка оставшегося времени при текущей скорости, мс. */
	remainingMs(): number {
		const key = `${this.opts.smart}`;
		if (!this.cum || this.cumFor !== this.stream || this.cumKey !== key) {
			const words = this.words;
			const cum = new Float64Array(words.length + 1);
			for (let i = 0; i < words.length; i++) {
				cum[i + 1] = cum[i] + words[i].pause * (this.opts.smart ? smartFactor(words[i]) : 1);
			}
			this.cum = cum;
			this.cumFor = this.stream;
			this.cumKey = key;
		}
		const n = this.words.length;
		return (this.cum[n] - this.cum[Math.min(this.index, n)]) * (60000 / this.opts.wpm);
	}

	private cum: Float64Array | null = null;
	private cumFor: WordStream | null = null;
	private cumKey = "";

	destroy(): void {
		this.clear();
	}

	private tick = (): void => {
		if (!this.playing) return;
		this.show();
		const ms = this.duration(this.index);
		if (this.rampStep < RAMP_WORDS) this.rampStep++;
		this.nextAt += ms;
		// Отстали больше чем на слово (вкладка спала) — не догоняем пачкой
		const now = performance.now();
		if (this.nextAt < now - ms) this.nextAt = now + ms;
		this.schedule();
	};

	private schedule(): void {
		this.timer = setTimeout(() => {
			if (!this.playing) return;
			if (this.index >= this.words.length - 1) {
				this.playing = false;
				this.timer = null;
				this.onState();
				return;
			}
			this.index++;
			this.tick();
		}, Math.max(0, this.nextAt - performance.now()));
	}

	private clear(): void {
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
	}
}
