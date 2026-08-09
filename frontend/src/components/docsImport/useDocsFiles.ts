// Общее состояние файлов пакета archmap-docs для BYOA-модалок (DocsAgentModal
// и SpecAgentModal): список файлов с ИМЕНАМИ (по ним манифест ссылается на
// файлы пакета), активный файл для редактора, загрузка с диска / вставкой
// текста / удаление. Имя — идентичность: повторная загрузка файла с тем же
// именем замещает старый (не плодим дубли).
import { useState } from "react";
import type { DocsFile } from "../../api/docsImport";

// Клиентский предохранитель. Зеркало MAX_PACKAGE_FILES бэка: схема логики стала
// отдельным .mmd, и у монолита их десятки (docs/plan-docs-mmd.md).
export const MAX_FILES = 100;

// Реф скрытого input[type=file] («Загрузить файлы…») намеренно НЕ здесь:
// модалки держат его локально (react-hooks/refs запрещает раздавать рефы
// из возвращаемого хуком объекта — объект становится «ref-tainted»).
export interface DocsFilesApi {
  files: DocsFile[];
  // Индекс активного файла (чип/редактор); прижат к границам списка
  active: number;
  // Есть ли хоть один непустой файл (производная видимость отчёта)
  hasContent: boolean;
  // Непустые файлы — то, что уходит в превью/применение
  nonEmpty: DocsFile[];
  addFiles: (added: DocsFile[]) => void;
  // ArrayLike, а не FileList: тем же путём заходят файлы, перетащенные в зону
  // (useFileDrop отдаёт отфильтрованный массив, собрать из него FileList нельзя).
  pickFiles: (list: ArrayLike<File> | null) => void;
  addPaste: () => void;
  removeFile: (i: number) => void;
  setText: (i: number, content: string) => void;
  // Сделать файл активным (клик по чипу)
  setActive: (i: number) => void;
  // Очистка пакета (например, «Добавить ещё» в режиме «по одной»)
  reset: () => void;
}

export function useDocsFiles(): DocsFilesApi {
  const [files, setFiles] = useState<DocsFile[]>([]);
  const [activeRaw, setActiveRaw] = useState(0);

  const active = Math.min(activeRaw, files.length - 1);
  const nonEmpty = files.filter((f) => f.content.trim() !== "");
  const hasContent = nonEmpty.length > 0;

  function addFiles(added: DocsFile[]) {
    if (!added.length) return;
    setFiles((prev) => {
      const merged = [...prev];
      for (const f of added) {
        const at = merged.findIndex((x) => x.name === f.name);
        if (at >= 0) merged[at] = f;
        else merged.push(f);
      }
      const next = merged.slice(0, MAX_FILES);
      setActiveRaw(next.length - 1);
      return next;
    });
  }

  function pickFiles(list: ArrayLike<File> | null) {
    if (!list || list.length === 0) return;
    void Promise.all(
      // Нечитаемое пропускаем молча: через перетаскивание сюда может приехать
      // то, чего не бывает в диалоге выбора (папка, удалённый уже файл).
      Array.from(list).map(async (f) => {
        try {
          return { name: f.name, content: await f.text() };
        } catch {
          return null;
        }
      }),
    ).then((read) => addFiles(read.filter((f): f is DocsFile => f !== null)));
  }

  function addPaste() {
    let i = 1;
    while (files.some((f) => f.name === `вставка-${i}`)) i++;
    addFiles([{ name: `вставка-${i}`, content: "" }]);
  }

  function removeFile(i: number) {
    setFiles((prev) => prev.filter((_, k) => k !== i));
    setActiveRaw(Math.max(0, active - (i <= active ? 1 : 0)));
  }

  function setText(i: number, content: string) {
    setFiles((prev) => prev.map((f, k) => (k === i ? { ...f, content } : f)));
  }

  function setActive(i: number) {
    setActiveRaw(i);
  }

  function reset() {
    setFiles([]);
    setActiveRaw(0);
  }

  return { files, active, hasContent, nonEmpty, addFiles, pickFiles, addPaste, removeFile, setText, setActive, reset };
}
