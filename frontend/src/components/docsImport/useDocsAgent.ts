// Состояние дозаливки схем логики от агента (BYOA): файлы пакета, живое превью
// (dry-run), проверка Mermaid, память попыток агента, правки строк превью, замечания для
// агента и применение. Вынесено из прежней панели (редизайн, фаза 6в), чтобы одно
// состояние служило двум окнам:
//   • окно «Описать схемы логики с помощью ИИ-агента» (DocsAgentModal) — «Пакетом» и
//     «По одной схеме»: галочка «Заменять уже описанное», имя и вид правятся в строках
//     превью;
//   • окно одной схемы (DocOverlay → «Изменить → Через ИИ-агента», режим «doc»,
//     inspector/DocAgentStage): пакет ОБНОВЛЯЕТ открытую схему — имя
//     принудительно её (поле overrides), перезапись разрешена: человек сам выбрал
//     «изменить эту схему».
// Промпт и его параметры — забота окна, состоянию пакета они не нужны.
//
// Mermaid-тексты схем валидируются здесь фронтом (бэкового валидатора нет) —
// советующе, битая схема не блокирует применение. Применение НЕ кладётся в undo (см.
// примечание к версионированию в tasks.md) — страховка: превью + дефолт
// «не перезаписывать» в окне пакета.
import { useEffect, useMemo, useRef, useState } from "react";
import type { DocsFile, DocsImportReport, DocsOverride, NodeDocKind } from "../../types";
import { docsImportApi } from "../../api/docsImport";
import { validateMermaid } from "../mermaidLoader";
import { useDocsFiles } from "./useDocsFiles";
import type { DocsFilesApi } from "./useDocsFiles";
import {
  applyRefusal, countAction, checkMermaid, type MermaidCheck, inputFingerprint, useRepeatedInput,
} from "./agentModalShared";
import { copyTextOrShow } from "../../lib/copyText";
import { useToast } from "../../pages/useToast";

// Режим. «doc» несёт имя схемы, которую обновляет пакет.
export type DocsAgentPanelMode =
  | { kind: "batch" }
  | { kind: "single" }
  | { kind: "doc"; docName: string };

/** Строка плана превью: одна схема пакета. */
export type DocsPlanRow = DocsImportReport["logic"][number];

// Память попыток агента: сколько пометок каждой семьи несло ПРЕДЫДУЩЕЕ зелёное
// превью. Текстовый запрет «не удаляй пометки» в замечаниях нужен, но тексты
// дисперсны — число не врёт: упало между попытками, значит агент, скорее всего,
// вырезал пометки вместо починки (находка №2 docs/qa-sentry-brokers.md).
// from — отчёт, которому соответствует cur (сравнение по ссылке: каждый ответ
// превью — новый объект). prev = null — попытка первая, сравнивать не с чем.
interface RefCounts {
  data: number;
  channel: number;
}
interface Attempts {
  from: DocsImportReport | null;
  prev: RefCounts | null;
  cur: RefCounts;
}
const NO_REFS: RefCounts = { data: 0, channel: 0 };
const NO_ATTEMPTS: Attempts = { from: null, prev: null, cur: NO_REFS };

export interface DocsAgent {
  pkg: DocsFilesApi;
  /** Окно одной схемы: имя схемы, которую обновляет пакет; иначе null. */
  docName: string | null;
  /** Галочка «Заменять уже описанное» (только окно пакета). */
  overwriteFlag: boolean;
  setOverwriteFlag: (on: boolean) => void;
  /** Отчёт последнего превью или применения; без непустых файлов — null. */
  report: DocsImportReport | null;
  /** Превью в пути. */
  checking: boolean;
  /** Ошибка Mermaid на каждую строку плана (null — читается); null — проверки ещё нет. */
  mmdErrs: (string | null)[] | null;
  mmdBroken: number;
  mmdPending: boolean;
  /** Что уменьшилось между попытками агента: строки «Пометок … было N → стало M». */
  shrank: string[];
  /** Вход тот же, что в прошлый заход. */
  repeatedInput: boolean;
  /** Замечания ушли агенту: спросить, оставить ли файлы в окне. */
  askStale: boolean;
  keepStale: () => void;
  clearPackage: () => void;
  removeFile: (i: number) => void;
  /** Замечания для агента: бэк и проверка Mermaid. */
  remarks: string[];
  copyRemarks: () => void;
  remarksCopied: boolean;
  /** Имя и вид строки превью с учётом правки. */
  nameOf: (file: string, reportName: string) => string;
  kindOf: (file: string, reportKind: NodeDocKind) => NodeDocKind;
  edit: (file: string, patch: Partial<DocsOverride>) => void;
  /** more=true — «Добавить ещё»: применить и очистить пакет под следующую схему. */
  apply: (more: boolean) => void;
  applying: boolean;
  /** Отказ последнего применения (окно остаётся открытым); null — отказа не было. */
  applyError: string | null;
  /** Применение что-то запишет: кнопки применения включены. */
  willWrite: boolean;
  /** Окно одной схемы: схема, которую получит окно (её рисуют до применения). */
  incoming: DocsPlanRow | null;
}

export function useDocsAgent(
  // Узел, для которого агент готовит документы (скоуп превью и применения).
  nodeId: string,
  mode: DocsAgentPanelMode,
  // Пакет применён. more=true — «Добавить ещё»: окно остаётся открытым, адрес
  // следующей точки входа очищает окно, пакет очищается здесь.
  onApplied: (more: boolean) => void,
): DocsAgent {
  const docName = mode.kind === "doc" ? mode.docName : null;
  const pkg = useDocsFiles();
  // Галка «Заменять уже описанное» — только у окна пакета; окно схемы перезаписывает
  // всегда (см. шапку модуля).
  const [overwriteFlag, setOverwriteFlag] = useState(false);
  const overwrite = docName !== null || overwriteFlag;
  // Отчёт последнего превью/применения. Пустые файлы прячут его ПРОИЗВОДНО
  // (pkg.hasContent ниже) — эффекты не зеркалят состояние синхронными setState.
  const [rawReport, setRawReport] = useState<DocsImportReport | null>(null);
  const [checking, setChecking] = useState(false);
  // Результаты mermaid-валидации привязаны к породившему их отчёту (сравнение
  // по ссылке — паттерн importSummary.forDocs): чужому отчёту не показываются.
  const [mmdRes, setMmdRes] = useState<{ forReport: DocsImportReport; check: MermaidCheck } | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [remarksCopied, flashRemarksCopied] = useToast(2000);
  // Правки строк превью (окно пакета): ключ — ФАЙЛ-источник (одна схема = один файл
  // .mmd). Уезжают на бэк отдельным полем overrides: манифеста, текст которого
  // раньше переписывался ради правки вида, больше нет (docs/plan-docs-mmd.md).
  const [edits, setEdits] = useState<DocsOverride[]>([]);
  // Окно схемы: каждый файл пакета ложится в ЭТУ схему — имя её, а не из шапки
  // файла. Иначе агент, назвавший схему по-своему, создал бы вторую рядом.
  // useMemo обязателен: overrides — зависимость эффекта превью.
  const overrides = useMemo<DocsOverride[]>(
    () => (docName !== null ? pkg.files.map((f) => ({ file: f.name, name: docName })) : edits),
    [docName, pkg.files, edits],
  );
  const seqRef = useRef(0);

  const report = pkg.hasContent ? rawReport : null;
  // Проверка схем — производное от отчёта: пока её нет (парс ещё идёт), окно не
  // делает вид, что схемы здоровы, а прямо говорит «проверяю».
  const mmdCheck = report !== null && mmdRes?.forReport === report ? mmdRes.check : null;
  const mmdErrs = mmdCheck?.errs ?? null;
  const mmdBroken = mmdErrs === null ? 0 : mmdErrs.filter((e) => e !== null).length;
  const mmdPending = report !== null && report.logic.length > 0 && mmdCheck === null;

  // Дифф числа пометок между попытками. Переставляем ПРИ РЕНДЕРЕ по смене ссылки
  // отчёта (React-паттерн «adjusting state when props change», как в ImportPane), а
  // не зеркалящим эффектом: setState в useEffect запрещён линтом и дал бы лишний
  // кадр со старыми числами. Считаем только ЗЕЛЁНЫЕ превью: у отчёта с ошибками
  // плана нет вовсе, и его нули не попытка агента, а отсутствие разбора.
  const [seen, setSeen] = useState<Attempts>(NO_ATTEMPTS);
  const counted = report !== null && !report.applied && report.errors.length === 0;
  if (counted && seen.from !== report) {
    setSeen({
      from: report,
      prev: seen.cur,
      cur: { data: report.data_refs_total, channel: report.channel_refs_total },
    });
  }
  // Гвард «вход не изменился»: тот же байт-в-байт пакет, что в прошлый заход, —
  // повод посмотреть на файлы агента, а не на замечание (находка полевой приёмки).
  const fingerprint = useMemo(() => inputFingerprint(pkg.files), [pkg.files]);
  const repeatedInput = useRepeatedInput(pkg.files, fingerprint);
  // Пакет, к которому задан вопрос об устаревании (после копирования замечаний).
  // Сравнение по ссылке: тронули файлы — вопрос снят сам, без эффекта.
  const [askedFor, setAskedFor] = useState<DocsFile[] | null>(null);
  // Что уменьшилось между попытками. Рост и равенство — норма, о них молчим.
  const shrank = useMemo(() => {
    const was = seen.prev;
    if (was === null) return [];
    const out: string[] = [];
    if (was.data > seen.cur.data) {
      out.push(`Пометок данных было ${was.data} → стало ${seen.cur.data}.`);
    }
    if (was.channel > seen.cur.channel) {
      out.push(`Пометок каналов было ${was.channel} → стало ${seen.cur.channel}.`);
    }
    return out;
  }, [seen]);

  // Дебаунс-превью по файлам и тумблеру; план фильтруется по схемам логики
  // (only="logic"). Все setState — в таймере/ответе (асинхронно); seq отбрасывает
  // устаревшие ответы при быстрой правке.
  useEffect(() => {
    const nonEmpty = pkg.files.filter((f) => f.content.trim() !== "");
    if (nonEmpty.length === 0) return; // отчёт скрыт производно (hasContent)
    const seq = ++seqRef.current;
    const t = window.setTimeout(() => {
      setChecking(true);
      docsImportApi.preview({ files: nonEmpty, overwrite, only: "logic", nodeId, overrides })
        .then((r) => {
          if (seqRef.current !== seq) return;
          setRawReport(r);
          setChecking(false);
        })
        .catch(() => {
          if (seqRef.current !== seq) return;
          setRawReport(null);
          setChecking(false);
        });
    }, 600);
    return () => window.clearTimeout(t);
    // overrides в зависимостях намеренно: правка имени/вида в превью меняет
    // ПЛАН (создание вместо перезаписи), и пользователь должен видеть это сразу.
  }, [pkg.files, overwrite, nodeId, overrides]);

  // Mermaid-валидация текстов схем из превью НАСТОЯЩИМ парсером (ленивый чанк
  // mermaid грузится только когда пакет уже разобран). Асинхронна по природе,
  // поэтому эффект — с отменой по смене отчёта: результат чужого пакета показывать
  // нельзя. Полевая находка (Zulip v2): 9 из 30 схем приехали с рассогласованными
  // скобками вершины — парсер такой класс ловит, но замечание должно назвать ФАЙЛ и
  // быть видно ДО применения, иначе схемы применяются мёртвыми для рендера.
  useEffect(() => {
    if (report === null || report.logic.length === 0) return;
    let alive = true;
    void checkMermaid(report.logic, validateMermaid).then((check) => {
      if (alive) setMmdRes({ forReport: report, check });
    });
    return () => { alive = false; };
  }, [report]);

  // ── правка строки превью (имя и вид схемы, только окно пакета) ──
  function kindOf(file: string, reportKind: NodeDocKind): NodeDocKind {
    return edits.find((o) => o.file === file)?.kind ?? reportKind;
  }
  function nameOf(file: string, reportName: string): string {
    return edits.find((o) => o.file === file)?.name ?? reportName;
  }
  function edit(file: string, patch: Partial<DocsOverride>) {
    setEdits((prev) => {
      const cur = prev.find((o) => o.file === file) ?? { file };
      const next = { ...cur, ...patch };
      const rest = prev.filter((o) => o.file !== file);
      // Пустая правка (вернули как было) — не храним
      return next.name === undefined && next.kind === undefined ? rest : [...rest, next];
    });
  }

  // Замечания для агента: ошибки/конфликты/предупреждения бэка + mermaid-замечания
  // фронта (собраны и закапированы в checkMermaid — там же формат «файл: …»).
  const remarks =
    report === null
      ? []
      : [...report.errors, ...report.conflicts, ...report.warnings, ...(mmdCheck?.remarks ?? [])];

  // Вступление к замечаниям несёт ЗАПРЕТ УДАЛЯТЬ пометки, и это не косметика:
  // полевой QA (docs/qa-sentry-brokers.md, находка №2) показал ампутацию Х3 в новой
  // одежде — по списку из семи битых пометок слабая модель «починила» их удалением
  // ВСЕХ восьмидесяти трёх, и обратный индекс базы опустел при «идеальном» превью.
  // Второй урок (docs/qa-zulip-brokers.md, находка №1): чинить «именем ИЛИ
  // квалификатором» — это ВЫБОР ИЗ ДВУХ МЕХАНИК, и слабая модель оба круга берёт
  // дешёвую — добавляет квалификатор, потом снимает его обратно, а имя так и не
  // сверяет. Поэтому цель одна: ДОСЛОВНОЕ имя, и сказано, где его взять
  // (подсказка «похоже на …» из замечания); квалификатор — только про омонимы.
  function copyRemarks() {
    const text =
      "ArchMap проверил файлы archmap-docs и нашёл замечания. " +
      "Исправь пакет и сообщи, какие файлы изменились. Битую пометку чини " +
      "ДОСЛОВНЫМ именем: бери его из подсказки «похоже на …» в замечании, а если " +
      "подсказки нет, найди настоящее имя в структуре проекта или DDL. Уточнение " +
      "«Объект / имя» добавляй ТОЛЬКО когда одинаковое имя есть у разных объектов. " +
      "НЕ удаляй пометки: удаление прячет факт, а не исправляет его:\n" +
      remarks.map((r) => `- ${r}`).join("\n");
    void copyTextOrShow(text).then(() => {
      flashRemarksCopied();
      // Замечания ушли агенту — значит вернётся исправленная версия, и лежащий в
      // окне пакет устареет. Спрашиваем сразу, пока пользователь здесь.
      setAskedFor(pkg.files);
    });
  }

  // Убрать пакет из окна: файлы, отчёт, правки строк и история попыток —
  // сравнивать после очистки не с чем (зеркало снятия последнего файла крестиком).
  function clearPackage() {
    setAskedFor(null);
    pkg.reset();
    setRawReport(null);
    setMmdRes(null);
    setEdits([]);
    setSeen(NO_ATTEMPTS);
  }

  // Убрали последний файл — пакета больше нет: история попыток начинается заново
  // (зеркало ImportPane), и вместе с ней уходит отчёт. Без этого отчёт прошлого
  // пакета вернулся бы при первой же вставке (он лишь СКРЫТ производно) и стал бы
  // «первой попыткой» нового — с ложной ампутацией на следующем превью.
  function removeFile(i: number) {
    if (pkg.files.length === 1) {
      setSeen(NO_ATTEMPTS);
      setRawReport(null);
      setMmdRes(null);
    }
    pkg.removeFile(i);
  }

  // more=true — «Добавить ещё»: применить и очистить пакет под следующий воркер или
  // эндпоинт (окно остаётся открытым в режиме «по одной»).
  function apply(more: boolean) {
    setApplying(true);
    setApplyError(null);
    // Применяются только схемы логики (only="logic")
    docsImportApi.apply({ files: pkg.nonEmpty, overwrite, only: "logic", nodeId, overrides })
      .then((r) => {
        setRawReport(r);
        if (!r.applied) return;
        if (more) clearPackage(); // следующий воркер — новый пакет, сравнивать не с чем
        onApplied(more);
      })
      // Отказ сервера виден строкой над кнопками; окно остаётся открытым с тем же пакетом.
      .catch((e: unknown) => setApplyError(applyRefusal(e)))
      .finally(() => setApplying(false));
  }

  // Правка в превью делает схему «перезаписью» даже при unchanged в отчёте
  // (бэк сверяет имя и вид) — учитываем её в доступности кнопок применения.
  const kindEdited = edits.length > 0 && report !== null && report.logic.length > 0;
  // «fill» — заполнение заглушки разведки: тоже запись, и без него кнопка «Применить»
  // осталась бы серой на пакете, который весь состоит из заполнения заглушек (то есть
  // на главном сценарии разведки).
  const willWrite =
    report !== null &&
    report.errors.length === 0 &&
    (kindEdited ||
      countAction(report.logic, "create") +
        countAction(report.logic, "fill") +
        countAction(report.logic, "overwrite") >
        0);
  // Схема, которую получит окно схемы: рисуем её до применения — это и есть
  // «что изменится». Первая строка плана: пакет окна схемы — один файл.
  const incoming = docName !== null && report !== null && !report.applied ? report.logic[0] ?? null : null;

  return {
    pkg, docName, overwriteFlag, setOverwriteFlag, report, checking, mmdErrs, mmdBroken, mmdPending,
    shrank, repeatedInput, askStale: askedFor === pkg.files, keepStale: () => setAskedFor(null),
    clearPackage, removeFile, remarks, copyRemarks, remarksCopied, nameOf, kindOf, edit, apply,
    applying, applyError, willWrite, incoming,
  };
}
