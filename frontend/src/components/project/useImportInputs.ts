// Входы ввоза окна «Новый проект» (режимы «Импорт» и «ИИ-агент»): YAML с диска и
// вставленные текстом, архивы знания .zip, открытый в поле YAML и приём файлов
// перетаскиванием на всё окно. Окно и панель ввоза только рисуют.
//
// ПОРЯДОК ВХОДОВ — норматив ввоза: сначала непустые YAML в порядке списка, затем архивы в
// порядке добавления. Им бэк нумерует входы («вход 3», file_remarks), от него же зависят
// tie-break C4-мерджа и дефолты споров, поэтому один и тот же список уезжает и в превью,
// и в применение, и в том же порядке файлы стоят в списке окна.
//
// Вставленный текстом YAML уезжает с ПУСТЫМ именем: выдуманное «Файл 2.yaml» бэк принял
// бы за имя файла, а у такого входа подпись источника — его номер («Из файла 2», правка
// Ф2г). В списке окна он зовётся так же: «Файл 2».
import { useMemo, useState } from "react";
import { MAX_ARCHIVE_BYTES, MAX_FILE_BYTES, useFileDrop } from "../docsImport/useFileDrop";
import type { FileDropApi } from "../docsImport/useFileDrop";

// Зеркало MAX_IMPORT_FILES бэка (schemas/project.py) — клиентский предохранитель.
// 256 — с запасом под крупные мульти-репо системы (80+ сервисов, файл на репозиторий).
export const MAX_IMPORT_FILES = 256;
/** Расширения выбора с диска и перетаскивания: YAML и архив знания. */
export const IMPORT_ACCEPT = [".yaml", ".yml", ".zip"];

/** YAML-вход: текст и имя файла с диска (null — вставлен текстом). */
export interface YamlInput {
  text: string;
  name: string | null;
}

export interface ImportInputsApi {
  docs: YamlInput[];
  archives: File[];
  /** Входы в порядке превью и применения: непустые YAML, затем архивы. */
  files: File[];
  /** YAML, текст которого показан в поле; null — поля нет. */
  shown: number | null;
  /** Подпись YAML в списке окна. */
  docLabel: (i: number) => string;
  /** Подпись архива в списке окна. */
  zipLabel: (j: number) => string;
  /** Подпись входа по его номеру в сводке (для строк ошибок); null — такого входа нет. */
  inputLabel: (no: number) => string | null;
  /** YAML по номеру входа в сводке; -1 — это архив или входа нет. */
  docOfInput: (no: number) => number;
  full: boolean;
  drop: FileDropApi;
  pickFiles: (list: ArrayLike<File> | null) => void;
  addPaste: () => void;
  openDoc: (i: number) => void;
  setText: (i: number, text: string) => void;
  removeDoc: (i: number) => void;
  removeArchive: (j: number) => void;
}

const isZip = (f: File): boolean => f.name.toLowerCase().endsWith(".zip");

export function useImportInputs(initial: YamlInput[] = []): ImportInputsApi {
  const [docs, setDocs] = useState<YamlInput[]>(initial);
  const [archives, setArchives] = useState<File[]>([]);
  // Открытый в поле YAML как его выставили; к границам и к вставкам прижимается при чтении.
  const [openRaw, setOpenRaw] = useState<number | null>(null);

  const files = useMemo(() => [
    ...docs.filter((d) => d.text.trim()).map((d) => new File([d.text], d.name ?? "", { type: "application/yaml" })),
    ...archives,
  ], [docs, archives]);

  // Номер входа в сводке для каждого YAML: в превью уезжают только НЕПУСТЫЕ (нумерация
  // сводки — по ним). Пустой показывает номер, который займёт, когда его наполнят.
  const docNo = useMemo(() => {
    let n = 0;
    return docs.map((d) => (d.text.trim() ? ++n : n + 1));
  }, [docs]);
  const yamlCount = docs.filter((d) => d.text.trim()).length;

  // Одинаковые имена (по YAML из каждого репозитория с одним именем) различаются номером
  // входа — иначе строка ошибки «Проблема в файле schema.yaml» не скажет, в каком.
  const twice = useMemo(() => {
    const seen = new Map<string, number>();
    for (const n of [...docs.map((d) => d.name), ...archives.map((f) => f.name)]) {
      if (n !== null) seen.set(n, (seen.get(n) ?? 0) + 1);
    }
    return seen;
  }, [docs, archives]);
  const named = (name: string, no: number) => ((twice.get(name) ?? 0) > 1 ? `${name} (${no})` : name);
  const docLabel = (i: number) => {
    const name = docs[i]?.name ?? null;
    return name === null ? `Файл ${docNo[i]}` : named(name, docNo[i]);
  };
  const zipLabel = (j: number) => named(archives[j].name, yamlCount + j + 1);
  const docOfInput = (no: number) => docs.findIndex((d, k) => d.text.trim() !== "" && docNo[k] === no);
  // В строках ошибок вставка подписана номером («Проблема в файле 2»): «Открыть файл
  // Файл 2» читалось бы заиканием, а запись «Файл 2» в списке узнаётся и так.
  const inputLabel = (no: number): string | null => {
    const i = docOfInput(no);
    if (i >= 0) return docs[i].name === null ? `${no}` : docLabel(i);
    const j = no - yamlCount - 1;
    return j >= 0 && j < archives.length ? zipLabel(j) : null;
  };

  // В поле — открытый YAML; не открыт ни один — последняя вставка (как в «Обновить из кода»).
  const lastPaste = docs.map((d) => d.name).lastIndexOf(null);
  const shown = openRaw !== null && openRaw < docs.length ? openRaw : lastPaste >= 0 ? lastPaste : null;

  function addDocs(added: YamlInput[]) {
    if (!added.length) return;
    // Единственная пустая вставка замещается принесёнными файлами.
    setDocs((cur) => {
      const drop = cur.length === 1 && cur[0].name === null && !cur[0].text.trim();
      return [...(drop ? [] : cur), ...added].slice(0, MAX_IMPORT_FILES);
    });
  }

  // ArrayLike, а не FileList: тем же путём заходят перетащенные файлы (useFileDrop отдаёт
  // отфильтрованный массив). Архивы отделяются по расширению: читать их текстом нельзя,
  // они уезжают как файлы. Нечитаемый YAML пропускается: перетащить можно и то, чего не
  // бывает в диалоге выбора.
  function pickFiles(list: ArrayLike<File> | null) {
    if (!list || list.length === 0) return;
    const all = Array.from(list);
    const zip = all.filter(isZip);
    if (zip.length) setArchives((cur) => [...cur, ...zip]);
    const yaml = all.filter((f) => !isZip(f));
    if (!yaml.length) return;
    void Promise.all(
      yaml.map((f) => f.text().then((text): YamlInput => ({ text, name: f.name })).catch(() => null)),
    ).then((read) => addDocs(read.filter((r): r is YamlInput => r !== null)));
  }

  const full = docs.length >= MAX_IMPORT_FILES;
  const drop = useFileDrop({
    accept: IMPORT_ACCEPT,
    onFiles: pickFiles,
    disabled: full,
    // Архив знания — до предела запроса, YAML — как документ (аудит F-31).
    maxBytes: (f) => (isZip(f) ? MAX_ARCHIVE_BYTES : MAX_FILE_BYTES),
  });

  return {
    docs, archives, files, shown, docLabel, zipLabel, inputLabel, docOfInput, full, drop, pickFiles,
    addPaste: () => {
      if (full) return;
      setOpenRaw(docs.length);
      setDocs([...docs, { text: "", name: null }]);
    },
    openDoc: setOpenRaw,
    setText: (i, text) => setDocs(docs.map((d, k) => (k === i ? { ...d, text } : d))),
    removeDoc: (i) => {
      setDocs(docs.filter((_, k) => k !== i));
      setOpenRaw((cur) => (cur === null || cur === i ? null : cur > i ? cur - 1 : cur));
    },
    removeArchive: (j) => setArchives(archives.filter((_, k) => k !== j)),
  };
}
