/** Пункт оглавления. paragraph — индекс в ParsedBook.paragraphs, с которого начинается раздел. */
export interface TocEntry {
	title: string;
	/** 0 — верхний уровень, 1 — вложенный и т.д. */
	level: number;
	paragraph: number;
}

export type BookFormat = "fb2" | "epub" | "txt" | "pdf" | "text";

/** Результат разбора файла: только читаемый текст, без служебного. */
export interface ParsedBook {
	title: string;
	/** Пустая строка, если автор неизвестен. */
	author: string;
	format: BookFormat;
	/** Абзацы чистого текста. Пробелы схлопнуты, пустых абзацев нет. Заголовки глав — тоже абзацы. */
	paragraphs: string[];
	toc: TocEntry[];
}
