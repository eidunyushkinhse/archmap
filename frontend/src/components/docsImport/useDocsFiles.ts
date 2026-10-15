// Общее состояние файлов пакета archmap-docs для BYOA-модалок (DocsAgentModal
// и SpecAgentPanel): список файлов с ИМЕНАМИ (по ним манифест ссылается на
// файлы пакета), активный файл для редактора, загрузка с диска / вставкой
// текста / удаление. Имя — идентичность: повторная загрузка файла с тем же
// именем замещает старый (не плодим дубли).
import { useReducer, useState } from "react";
import type { DocsFile } from "../../types";
import { fileTooBigMessage } from "../demo/demoLimits";
import { bytesLimitText, MAX_FILE_BYTES } from "./useFileDrop";

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
  // Демо-стенд: последний файл с диска, не взятый из-за предела размера, — текст
  // отказа (docs/tasks/demo-mode.md). null — отказов не было.
  sizeError: string | null;
}

// Файлы и активный файл — одно состояние (аудит F-50): добавление делает активным
// последний файл в ТОМ ЖЕ переходе, а не вызовом setState изнутри апдейтера списка
// (в StrictMode апдейтер выполняется дважды и обязан быть чистым).
interface FilesState {
  files: DocsFile[];
  // Индекс активного файла как его выставили; к границам прижимается при чтении.
  active: number;
}
type FilesAction =
  | { type: "add"; added: DocsFile[] }
  | { type: "remove"; i: number }
  | { type: "text"; i: number; content: string }
  | { type: "active"; i: number }
  | { type: "reset" };

const clampActive = (st: FilesState) => Math.min(st.active, st.files.length - 1);

function filesReducer(st: FilesState, a: FilesAction): FilesState {
  switch (a.type) {
    case "add": {
      const merged = [...st.files];
      for (const f of a.added) {
        const at = merged.findIndex((x) => x.name === f.name);
        if (at >= 0) merged[at] = f;
        else merged.push(f);
      }
      const files = merged.slice(0, MAX_FILES);
      return { files, active: files.length - 1 };
    }
    case "remove": {
      const active = clampActive(st);
      return {
        files: st.files.filter((_, k) => k !== a.i),
        active: Math.max(0, active - (a.i <= active ? 1 : 0)),
      };
    }
    case "text":
      return { ...st, files: st.files.map((f, k) => (k === a.i ? { ...f, content: a.content } : f)) };
    case "active":
      return { ...st, active: a.i };
    case "reset":
      return { files: [], active: 0 };
  }
}

export function useDocsFiles(): DocsFilesApi {
  const [state, dispatch] = useReducer(filesReducer, { files: [], active: 0 });
  const [sizeError, setSizeError] = useState<string | null>(null);

  const { files } = state;
  const active = clampActive(state);
  const nonEmpty = files.filter((f) => f.content.trim() !== "");
  const hasContent = nonEmpty.length > 0;

  function addFiles(added: DocsFile[]) {
    if (!added.length) return;
    dispatch({ type: "add", added });
  }

  function pickFiles(list: ArrayLike<File> | null) {
    if (!list || list.length === 0) return;
    // Демо-стенд: файл больше предела не читаем и не отправляем — сервер ответил бы
    // 413. Отказ показывает окно (sizeError); остальные файлы берутся как обычно.
    // Вне демо — тот же предел документа, что у перетаскивания (аудит F-31: кнопкой
    // файл больше 2 МБ принимался и падал уже на сервере).
    const all = Array.from(list);
    const tooBig = (f: File): string | null =>
      fileTooBigMessage(f) ??
      (f.size > MAX_FILE_BYTES ? `Слишком большой файл: ${f.name} (${bytesLimitText(MAX_FILE_BYTES)}).` : null);
    const refusals = all.map(tooBig).filter((m): m is string => m !== null);
    setSizeError(refusals[0] ?? null);
    const fit = all.filter((f) => tooBig(f) === null);
    void Promise.all(
      // Нечитаемое пропускаем молча: через перетаскивание сюда может приехать
      // то, чего не бывает в диалоге выбора (папка, удалённый уже файл).
      fit.map(async (f) => {
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
    dispatch({ type: "remove", i });
  }

  function setText(i: number, content: string) {
    dispatch({ type: "text", i, content });
  }

  function setActive(i: number) {
    dispatch({ type: "active", i });
  }

  function reset() {
    dispatch({ type: "reset" });
    setSizeError(null);
  }

  return {
    files, active, hasContent, nonEmpty, addFiles, pickFiles, addPaste, removeFile, setText,
    setActive, reset, sizeError,
  };
}
