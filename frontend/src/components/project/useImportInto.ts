// Состояние окна «Догрузить архив»: архивы, превью диффа с перезапросом после 409, разбор
// остатка слияния (вопросы и массовые ответы), применение с отчётом в окне. Вынесено из
// окна при переводе на новый язык (редизайн, фаза 6г): окно — ImportIntoModal, дифф и
// отчёт — IntoReport.
//
// Догрузка аддитивна: живая запись перетирается ТОЛЬКО там, где пользователь явно выбрал
// кандидата из архива (дефолт каждого спора — «оставить моё», его ставит бэк).
//
// YAML сюда не кладут принципиально: в существующий проект он заливается синком
// («Обновить из кода» в том же меню), там своя механика источников и политик. Не-архив
// окно не берёт и говорит об этом строкой над футером.
import { useEffect, useMemo, useRef, useState } from "react";
import type { IntoApplyOut, IntoPreviewOut } from "../../types";
import { projectsApi } from "../../api/projects";
import { isConflict } from "../../api/client";
import { plural } from "../../ui/plural";
import { MAX_ARCHIVE_BYTES, useFileDrop } from "../docsImport/useFileDrop";
import type { FileDropApi } from "../docsImport/useFileDrop";
import { bulkAnswers, hasMineDisputes, toDecisions, useRemainderAnswers } from "./remainder";
import type { Answer, Answers, Question, Resolutions } from "./remainder";
import { firstTooBig } from "../demo/demoLimits";
import type { TooBig } from "../demo/demoLimits";

// Устаревшее превью — не тупик: план пересчитывается сам, выбор пользователя цел.
const STALE =
  "Проект изменился, проверка обновлена. Посмотрите изменения и примените снова.";

// Принесли не архив. Бывшее последнее предложение вступления окна: оно нужно только тому,
// кто принёс YAML.
export const NOT_ZIP =
  "Сюда загружаются архивы .zip. Файлы YAML загружаются пунктом «Обновить из кода».";

const isZip = (f: File) => f.name.toLowerCase().endsWith(".zip");

/** Отказ самого превью показываем в той же форме, что и отказ разбора архива. */
function failedPreview(msg: string): IntoPreviewOut {
  return {
    ok: false,
    errors: [msg],
    nodes_new: 0,
    nodes_new_paths: [],
    new_nodes: [],
    nodes_matched: 0,
    matched_nodes: [],
    edges_new: 0,
    families: { docs: 0, specs: 0, tables: 0, channels: 0, params: 0, processes: 0, sites: 0 },
    family_conflicts: [],
    // Остаток слияния (Ф-E): разбирать нечего, превью не состоялось.
    remainder: {
      field_conflicts: [], container_edges: [], isolated_groups: [], fuzzy_pairs: [],
      unfixable: [], converted_warnings: [], node_paths: [], node_has_children: [],
      node_elements: [],
    },
    warnings: [],
    base_graph_rev: 0,
    base_meta_rev: 0,
  };
}

/** Что приедет из архивов: только ненулевые семьи через запятую, иначе null. */
export function familyLine(f: IntoPreviewOut["families"]): string | null {
  const parts = [
    f.docs && `${f.docs} ${plural(f.docs, ["схема логики", "схемы логики", "схем логики"])}`,
    f.specs && `${f.specs} ${plural(f.specs, ["спецификация", "спецификации", "спецификаций"])}`,
    f.tables && `${f.tables} ${plural(f.tables, ["таблица", "таблицы", "таблиц"])}`,
    f.channels && `${f.channels} ${plural(f.channels, ["канал", "канала", "каналов"])}`,
    f.params && `${f.params} ${plural(f.params, ["параметр", "параметра", "параметров"])}`,
    f.processes && `${f.processes} ${plural(f.processes, ["процесс", "процесса", "процессов"])}`,
    f.sites && `${f.sites} ${plural(f.sites, ["площадка", "площадки", "площадок"])}`,
  ].filter((s): s is string => typeof s === "string");
  return parts.length ? parts.join(", ") : null;
}

/** Строка тоста: тронутое, а не «сколько знания в проекте» (форма отчёта догрузки). */
function applySummary(r: IntoApplyOut): string {
  const parts = [
    r.nodes_created && `${r.nodes_created} ${plural(r.nodes_created, ["объект", "объекта", "объектов"])}`,
    r.edges_created && `${r.edges_created} ${plural(r.edges_created, ["связь", "связи", "связей"])}`,
    r.docs_created && `${r.docs_created} ${plural(r.docs_created, ["схема логики", "схемы логики", "схем логики"])}`,
    r.specs_applied && `${r.specs_applied} ${plural(r.specs_applied, ["спецификация", "спецификации", "спецификаций"])}`,
    r.db?.tables_written && `${r.db.tables_written} ${plural(r.db.tables_written, ["таблица", "таблицы", "таблиц"])}`,
    r.channels?.channels_written && `${r.channels.channels_written} ${plural(r.channels.channels_written, ["канал", "канала", "каналов"])}`,
    r.channel_stubs && `${r.channel_stubs} ${plural(r.channel_stubs, ["канал по связи", "канала по связям", "каналов по связям"])}`,
    r.config?.params_written && `${r.config.params_written} ${plural(r.config.params_written, ["параметр", "параметра", "параметров"])}`,
    r.processes.length && `${r.processes.length} ${plural(r.processes.length, ["процесс", "процесса", "процессов"])}`,
  ].filter((s): s is string => typeof s === "string");
  return parts.length ? `Догружено: ${parts.join(", ")}` : "Догрузка завершена, нового не появилось";
}

/** Есть ли ради чего применять: новое, спор или хоть один вопрос разбора. */
function brings(p: IntoPreviewOut, questions: number): boolean {
  return p.nodes_new > 0 || p.edges_new > 0
    || familyLine(p.families) !== null || p.family_conflicts.length > 0 || questions > 0;
}

export interface ImportInto {
  files: File[];
  /** Выбор с диска и перетаскивание: архивы в окно, остальное — отказом над футером. */
  pickFiles: (list: ArrayLike<File> | null) => void;
  removeFile: (i: number) => void;
  drop: FileDropApi;
  /** Не архив: строка над футером; null — отказа нет. */
  notZip: string | null;
  /** Демо-стенд: архив больше предела файла не отправляется. */
  tooBig: TooBig | null;
  /** Превью по ТЕКУЩЕМУ составу архивов; null — нет или устарело. */
  fresh: IntoPreviewOut | null;
  checking: boolean;
  /** Демо-стенд: после догрузки проект выйдет за предел. */
  excess: IntoPreviewOut["demo_excess"] | null;
  questions: Question[];
  answers: Answers;
  onAnswer: (id: string, answer: Answer) => void;
  resolutions: Resolutions;
  /** Выбор по спору содержимого: id → «cand:<i>» либо «all». */
  onResolve: (id: string, choice: string) => void;
  /** Есть споры С ЖИВЫМ знанием: массовые ответы имеют смысл. */
  withMine: boolean;
  resolveAll: (mine: boolean) => void;
  apply: () => void;
  applying: boolean;
  applyError: string | null;
  canApply: boolean;
  /** Архивы успешно проверены, но ничего не добавляют и ни о чём не спорят (условие, по
   *  которому гаснет «Применить»): окно говорит об этом одной тихой строкой. */
  nothingNew: boolean;
  /** Отчёт применения: показывается В ОКНЕ до «Готово». */
  result: IntoApplyOut | null;
  /** «Готово»: тост родителю строкой тронутого. */
  finish: () => void;
}

export function useImportInto(
  projectId: string,
  onApplied: (message: string) => void,
  onClose: () => void,
): ImportInto {
  const [files, setFiles] = useState<File[]>([]);
  const [notZip, setNotZip] = useState<string | null>(null);
  // Превью привязано к составу файлов И к номеру перезапроса: устаревший ответ не
  // показываем, а после 409 показ гаснет до прихода свежего плана.
  const [preview, setPreview] = useState<
    { forFiles: File[]; key: number; res: IntoPreviewOut } | null
  >(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  // Отчёт применения показываем В ОКНЕ: замечания догрузки (промахи адресов, тёзки
  // процессов) — видимая деградация, прятать их за закрытием нельзя.
  const [result, setResult] = useState<IntoApplyOut | null>(null);
  const seqRef = useRef(0);

  // Каждый новый заход файлов заново решает про отказ: принесли архивы — строки нет.
  function pickFiles(list: ArrayLike<File> | null) {
    if (!list || list.length === 0) return;
    const all = Array.from(list);
    const zips = all.filter(isZip);
    setNotZip(zips.length < all.length ? NOT_ZIP : null);
    if (zips.length > 0) setFiles((cur) => [...cur, ...zips]);
  }

  function removeFile(i: number) {
    setNotZip(null);
    setFiles((cur) => cur.filter((_, k) => k !== i));
  }

  // Формат проверяет pickFiles (отказ над футером, а не под зоной); хук перетаскивания
  // держит папки и размер. Предел размера — архивный: архив знания крупнее документа.
  const drop = useFileDrop({ onFiles: pickFiles, maxBytes: MAX_ARCHIVE_BYTES });
  // Демо-стенд (docs/tasks/demo-mode.md): архив больше предела файла не отправляем
  // вовсе — сервер ответил бы 413; отказ показываем сразу.
  const tooBig = useMemo(() => firstTooBig(files), [files]);

  // Превью БЕЗ дебаунса: состав файлов меняется редко (перетащили архив), а не
  // посимвольно, как текст в редакторе. Устаревшие ответы отбрасывает seq —
  // синхронного setState в эффекте нет (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (files.length === 0 || tooBig) return;
    const seq = ++seqRef.current;
    projectsApi.importIntoPreview(projectId, files).then(
      (res) => { if (seq === seqRef.current) setPreview({ forFiles: files, key: reloadKey, res }); },
      (e: unknown) => {
        if (seq !== seqRef.current) return;
        const msg = e instanceof Error ? e.message : "Не удалось проверить архивы";
        setPreview({ forFiles: files, key: reloadKey, res: failedPreview(msg) });
      },
    );
  }, [projectId, files, reloadKey, tooBig]);

  const fresh =
    preview && preview.forFiles === files && preview.key === reloadKey && !tooBig
      ? preview.res : null;
  const checking = files.length > 0 && fresh === null && !tooBig;
  const excess = fresh?.demo_excess ?? null;
  // Разбор остатка (Ф-E): резолюции споров и ответы на остальные вопросы переживают
  // перезапрос превью, в том числе после 409. Сноска о связи в контейнер здесь
  // говорит «после догрузки»: проект уже создан (mode).
  const { questions, answers, setAnswers, resolutions, setResolutions } =
    useRemainderAnswers(fresh, "into");
  // Массовые действия имеют смысл только там, где спорят С ЖИВЫМ: спор двух архивов
  // между собой «моим» не разрешить.
  const withMine = hasMineDisputes(questions);

  /**
   * «Оставить, как было в проекте» / «Взять из новых архивов» (§7): закрывают
   * ТОЛЬКО споры — содержимого и полей. Обе карты переписываются целиком:
   * «оставить моё» у спора содержимого — это СНЯТИЕ записи (дефолт бэка и так
   * «моё», а явный выбор после перезапроса мог бы уехать вместе с планом).
   */
  function resolveAll(mine: boolean) {
    const next = bulkAnswers(questions, mine, { answers, resolutions });
    setAnswers(next.answers);
    setResolutions(next.resolutions);
  }

  function apply() {
    if (!fresh?.ok || applying) return;
    setApplying(true);
    setApplyError(null);
    projectsApi
      .importIntoApply(projectId, files, {
        resolutions,
        // «Как сейчас» и молчание в форму не едут: их результат — сегодняшний.
        decisions: toDecisions(questions, answers),
        baseGraphRev: fresh.base_graph_rev,
        baseMetaRev: fresh.base_meta_rev,
      })
      .then((r) => setResult(r))
      .catch((e: unknown) => {
        // 409 — не тупик: проект уехал между превью и применением. Пересчитываем
        // план и оставляем выбор пользователя (перезапрос СОБЫТИЙНЫЙ, из catch).
        if (isConflict(e)) {
          setApplyError(STALE);
          setReloadKey((k) => k + 1);
          return;
        }
        setApplyError(e instanceof Error ? e.message : "Не удалось выполнить догрузку");
      })
      .finally(() => setApplying(false));
  }

  // Применять нечего, когда архив ничего не добавляет и ни о чём не спорит (типовой
  // случай: догрузили архив ЭТОГО же проекта): кнопка гаснет, а окно говорит «нет ничего
  // нового» вместо статуса «Готово к импорту» и строки «Нового: 0 объектов, 0 связей».
  const checked = fresh?.ok === true && excess === null;
  const brought = checked && brings(fresh, questions.length);
  const canApply = brought && !applying;
  const nothingNew = checked && !brought;

  function finish() {
    if (result) onApplied(applySummary(result));
    onClose();
  }

  return {
    files, pickFiles, removeFile, drop, notZip, tooBig, fresh, checking, excess,
    questions,
    answers,
    onAnswer: (id, answer) => setAnswers((cur) => ({ ...cur, [id]: answer })),
    resolutions,
    onResolve: (id, choice) => setResolutions((cur) => ({ ...cur, [id]: choice })),
    withMine,
    resolveAll,
    apply, applying, applyError, canApply, nothingNew, result, finish,
  };
}
