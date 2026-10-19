import { describe, expect, it } from "vitest";
import { splitOrp } from "./orp";
import { buildWords, sentenceStartAt } from "./words";

describe("красная буква", () => {
	// Сверено с кадрами ролика: Начинаем → ч, слов → л, взрослый → р, большинства. → ь, проговаривает → г
	it.each([
		["Начинаем", "На", "ч"],
		["слов", "с", "л"],
		["взрослый", "вз", "р"],
		["большинства.", "бол", "ь"],
		["проговаривает", "про", "г"],
		["ты", "т", "ы"],
		["и", "", "и"],
		["300.", "3", "0"],
		["«Привет,", "«Пр", "и"],
		["— Как", "— К", "а"],
	])("%s", (word, before, pivot) => {
		const p = splitOrp(word);
		expect(p.before).toBe(before);
		expect(p.pivot).toBe(pivot);
		expect(p.before + p.pivot + p.after).toBe(word);
	});
});

describe("слова и паузы", () => {
	it("тире и кавычки прилипают к слову", () => {
		const s = buildWords(["— Привет, — сказал он. « Да » ,"]);
		expect(s.words.map((w) => w.text)).toEqual(["— Привет,", "— сказал", "он.", "«Да»,"]);
	});

	it("паузы: точка ×3, запятая ×1.8, начало абзаца ×1.8", () => {
		const s = buildWords(["Раз, два.", "Три"]);
		const [raz, dva, tri] = s.words;
		expect(raz.pause).toBeCloseTo(1.8);
		expect(dva.pause).toBeCloseTo(3);
		expect(tri.pause).toBeCloseTo(1.8);
	});

	it("многоточие — конец предложения", () => {
		const s = buildWords(["Ну… ладно"]);
		expect(s.words[0].end).toBe(true);
		expect(s.sentenceStarts).toEqual([0, 1]);
	});

	it("начала абзацев и предложений", () => {
		const s = buildWords(["Один. Два три.", "Четыре"]);
		expect(s.paraStarts).toEqual([0, 3]);
		expect(s.sentenceStarts).toEqual([0, 1, 3]);
		expect(sentenceStartAt(s.sentenceStarts, 2)).toBe(1);
	});
});
