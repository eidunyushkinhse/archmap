// Приём файлов перетаскиванием — общий для всех мест, где вставляют YAML: окно
// «Обновить из репозитория», обе BYOA-модалки и панель импорта при создании
// проекта. До этого перетаскивания не было НИГДЕ, хотя пунктирная зона своим
// видом его обещала (находка ручной проверки 2026-08-08).
//
// Проверяем только расширение и размер: разбирать YAML здесь незачем — это
// делает превью/dry-run, у которого и текст ошибок человечнее. Хук ничего не
// читает с диска: отдаёт принятые File наружу, где уже есть свои читалки
// (useDocsFiles.pickFiles, ImportPane.pickFiles).
import { useState } from "react";
import type { DragEvent } from "react";

/** Зеркало лимита бэка на длину одного документа (schemas/project.py, docs_import.py). */
export const MAX_FILE_BYTES = 2_000_000;

export interface FileDropOptions {
  /** Допустимые расширения, с точкой и в нижнем регистре; пусто — берём любые файлы. */
  accept?: string[];
  /** Принятые файлы (уже отфильтрованные). */
  onFiles: (files: File[]) => void;
  /** Приём выключен — например, исчерпан лимит файлов пакета. */
  disabled?: boolean;
}

export interface FileDropApi {
  /** Курсор с файлами над зоной — для подсветки. */
  over: boolean;
  /** Что и почему не приняли; гаснет при следующем заходе в зону. */
  error: string | null;
  /** Раскладывается на элемент-зону: <div {...drop.bind}>. */
  bind: {
    onDragOver: (e: DragEvent<HTMLElement>) => void;
    onDragLeave: (e: DragEvent<HTMLElement>) => void;
    onDrop: (e: DragEvent<HTMLElement>) => void;
  };
}

/** Тащат именно файлы, а не выделенный текст внутри страницы. */
function draggingFiles(e: DragEvent<HTMLElement>): boolean {
  return Array.from(e.dataTransfer.types).includes("Files");
}

function ext(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/** Папка приезжает в dataTransfer как файл без типа и размера — прочитать её нельзя. */
function looksLikeFolder(f: File): boolean {
  return f.type === "" && f.size === 0 && !f.name.includes(".");
}

/** Перечисление имён для сообщения: длинные списки схлопываем. */
function names(list: string[]): string {
  return list.length > 3 ? `${list.slice(0, 3).join(", ")} и ещё ${list.length - 3}` : list.join(", ");
}

/** Жалоба начинается сразу с причины: «Не приняли —» ничего не добавляло к смыслу. */
function rejectMessage(
  folders: string[],
  badExt: string[],
  tooBig: string[],
  accept: string[],
): string | null {
  const parts: string[] = [];
  if (folders.length) parts.push(`Папку перетащить нельзя (${names(folders)}) — перетащите файлы из неё.`);
  if (badExt.length) parts.push(`Не тот формат: ${names(badExt)} (подойдёт ${accept.join(", ")}).`);
  if (tooBig.length) parts.push(`Слишком большой файл: ${names(tooBig)} (больше 2 МБ).`);
  return parts.length ? parts.join(" ") : null;
}

export function useFileDrop({ accept = [], onFiles, disabled = false }: FileDropOptions): FileDropApi {
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onDragOver(e: DragEvent<HTMLElement>) {
    if (!draggingFiles(e)) return;
    // Без preventDefault браузер уводит страницу на сам файл вместо того, чтобы отдать его нам.
    e.preventDefault();
    e.dataTransfer.dropEffect = disabled ? "none" : "copy";
    if (disabled) return;
    if (error) setError(null); // новая попытка — прежняя жалоба уже ни при чём
    if (!over) setOver(true);
  }

  function onDragLeave(e: DragEvent<HTMLElement>) {
    // dragleave стреляет и при переходе на ВЛОЖЕННЫЙ элемент зоны; гасим подсветку
    // только когда курсор действительно вышел за её пределы, иначе она мигает.
    const to = e.relatedTarget as Node | null;
    if (to && e.currentTarget.contains(to)) return;
    setOver(false);
  }

  function onDrop(e: DragEvent<HTMLElement>) {
    if (!draggingFiles(e)) return;
    e.preventDefault();
    setOver(false);
    if (disabled) return;

    const good: File[] = [];
    const folders: string[] = [];
    const badExt: string[] = [];
    const tooBig: string[] = [];
    for (const f of Array.from(e.dataTransfer.files)) {
      if (looksLikeFolder(f)) folders.push(f.name);
      else if (accept.length && !accept.includes(ext(f.name))) badExt.push(f.name);
      else if (f.size > MAX_FILE_BYTES) tooBig.push(f.name);
      else good.push(f);
    }

    setError(rejectMessage(folders, badExt, tooBig, accept));
    if (good.length) onFiles(good);
  }

  return { over, error, bind: { onDragOver, onDragLeave, onDrop } };
}
