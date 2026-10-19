import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import type { BookFormat, ParsedBook, TocEntry } from "./types";

export interface Bookmark {
	id: string;
	/** Индекс слова. */
	word: number;
	createdAt: number;
	snippet: string;
}

export interface BookMeta {
	id: string;
	title: string;
	author: string;
	format: BookFormat;
	addedAt: number;
	openedAt: number;
	wordCount: number;
	/** Индекс слова, где остановились. */
	position: number;
	toc: TocEntry[];
	bookmarks: Bookmark[];
}

interface Schema extends DBSchema {
	books: { key: string; value: BookMeta };
	texts: { key: string; value: { id: string; paragraphs: string[] } };
}

let dbp: Promise<IDBPDatabase<Schema>> | null = null;

function db(): Promise<IDBPDatabase<Schema>> {
	if (!dbp) {
		dbp = openDB<Schema>("tochka", 1, {
			upgrade(d) {
				d.createObjectStore("books", { keyPath: "id" });
				d.createObjectStore("texts", { keyPath: "id" });
			},
		});
	}
	return dbp;
}

export function newId(): string {
	try {
		return crypto.randomUUID();
	} catch {
		return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	}
}

/** Просим браузер не чистить книги при нехватке места (важно для iPhone). */
export function askPersist(): void {
	try {
		navigator.storage?.persist?.().catch(() => {});
	} catch {
		/* не поддерживается */
	}
}

export async function listBooks(): Promise<BookMeta[]> {
	const all = await (await db()).getAll("books");
	return all.sort((a, b) => b.openedAt - a.openedAt);
}

export async function getBook(id: string): Promise<{ meta: BookMeta; paragraphs: string[] } | null> {
	const d = await db();
	const [meta, text] = await Promise.all([d.get("books", id), d.get("texts", id)]);
	if (!meta || !text) return null;
	return { meta, paragraphs: text.paragraphs };
}

/** Сохраняет разобранную книгу. Если такая уже есть (название + автор + число слов) — возвращает её id. */
export async function addBook(book: ParsedBook, wordCount: number): Promise<string> {
	const d = await db();
	const existing = (await d.getAll("books")).find(
		(b) => b.title === book.title && b.author === book.author && b.wordCount === wordCount,
	);
	if (existing) return existing.id;
	const id = newId();
	const now = Date.now();
	const meta: BookMeta = {
		id,
		title: book.title,
		author: book.author,
		format: book.format,
		addedAt: now,
		openedAt: now,
		wordCount,
		position: 0,
		toc: book.toc,
		bookmarks: [],
	};
	const tx = d.transaction(["books", "texts"], "readwrite");
	await Promise.all([tx.objectStore("books").put(meta), tx.objectStore("texts").put({ id, paragraphs: book.paragraphs }), tx.done]);
	return id;
}

export async function updateBook(id: string, patch: Partial<BookMeta>): Promise<void> {
	const d = await db();
	const meta = await d.get("books", id);
	if (!meta) return;
	await d.put("books", { ...meta, ...patch });
}

export async function deleteBook(id: string): Promise<void> {
	const d = await db();
	const tx = d.transaction(["books", "texts"], "readwrite");
	await Promise.all([tx.objectStore("books").delete(id), tx.objectStore("texts").delete(id), tx.done]);
}
