// Правая колонка дозаливки схем логики от агента (BYOA): файлы пакета, живое
// превью (dry-run), отчёт и применение. Вынесена из DocsAgentModal, чтобы жить в
// двух окнах:
//   • модалка «Доки от агента» (DocsAgentModal) — «Пакетом» и «По одной схеме»:
//     галка «Обновлять готовые диаграммы», имя и вид правятся в строках превью;
//   • окно одной схемы (DocOverlay → «Изменить → Через ИИ-агента», режим «doc»):
//     пакет ОБНОВЛЯЕТ открытую схему — имя принудительно её (поле overrides),
//     перезапись разрешена: человек сам выбрал «изменить эту схему».
// Промпт и его параметры — забота окна (левая колонка), панели они не нужны.
//
// Mermaid-тексты схем валидируются здесь фронтом (бэкового валидатора нет) —
// советующе, ✗ не блокирует применение. Применение НЕ кладётся в undo (см.
// примечание к версионированию в tasks.md) — страховка: превью + дефолт
// «не перезаписывать» в модалке.
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { DocsImportReport, NodeDocKind } from "../../types";
import { docsImportApi, type DocsFile, type DocsOverride } from "../../api/docsImport";
import { validateMermaid } from "../mermaidLoader";
import MermaidRenderer from "../MermaidRenderer";
import { useDocsFiles } from "./useDocsFiles";
import {
  ACTION_LABEL, countAction, checkMermaid, type MermaidCheck,
  inputFingerprint, useRepeatedInput, rightCol, radioRow, grayLine, footRow,
} from "./agentModalShared";
import { ItemList, NoteList, StaleFilesConfirm, UnchangedInputNote } from "./agentModalReport";
import AgentPackageInput from "./AgentPackageInput";
import { primaryBtn, secondaryBtn } from "../../ui/styles";

// Режим панели. «doc» несёт имя схемы, которую обновляет пакет.
export type DocsAgentPanelMode =
  | { kind: "batch" }
  | { kind: "single" }
  | { kind: "doc"; docName: string };

interface Props {
  // Узел, для которого агент готовит документы (скоуп превью и применения).
  nodeId: string;
  mode: DocsAgentPanelMode;
  // Пакет применён. more=true — «Добавить ещё» (модалка «по одной»): окно остаётся
  // открытым, адрес следующей точки входа очищает окно, пакет панель очищает сама.
  onApplied: (more: boolean) => void;
}

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

const KIND_LABEL: Record<NodeDocKind, string> = {
  operation: "Операция",
  worker: "Воркер",
};
const KIND_ORDER: NodeDocKind[] = ["operation", "worker"];

// Сводка окна одной схемы: что станет с ЭТОЙ схемой, словами, а не счётчиками пакета.
function docSummary(action: string, name: string): string {
  if (action === "overwrite") return `Схема «${name}» будет обновлена`;
  if (action === "fill") return `Схема «${name}» будет описана`;
  if (action === "unchanged") return "Файл совпадает со схемой, менять нечего";
  if (action === "create") return `Будет создана новая схема «${name}»`;
  return `Схема «${name}» не изменится`;
}

export default function DocsAgentPanel({ nodeId, mode, onApplied }: Props) {
  const docName = mode.kind === "doc" ? mode.docName : null;
  const pkg = useDocsFiles();
  // Галка «Обновлять готовые диаграммы» — только у модалки; окно схемы перезаписывает
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
  const [remarksCopied, setRemarksCopied] = useState(false);
  // Правки строк превью (модалка): ключ — ФАЙЛ-источник (одна схема = один файл
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

  // ── правка строки превью (имя и вид схемы, только модалка) ──
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
      "Валидатор дозаливки доков ArchMap нашёл замечания к пакету archmap-docs. " +
      "Исправь пакет и сообщи, какие файлы изменились. Битую пометку чини " +
      "ДОСЛОВНЫМ именем: бери его из подсказки «похоже на …» в замечании, а нет " +
      "подсказки — найди настоящее имя в структуре проекта или DDL. Квалификатор " +
      "«Узел / имя» добавляй ТОЛЬКО когда одинаковое имя есть у разных узлов. " +
      "НЕ удаляй пометки: удаление прячет факт, а не исправляет его:\n" +
      remarks.map((r) => `- ${r}`).join("\n");
    void navigator.clipboard.writeText(text).then(() => {
      setRemarksCopied(true);
      setTimeout(() => setRemarksCopied(false), 2000);
      // Замечания ушли агенту — значит вернётся исправленная версия, и лежащий в
      // панели пакет устареет. Спрашиваем сразу, пока пользователь здесь.
      setAskedFor(pkg.files);
    });
  }

  // Убрать пакет из панели: файлы, отчёт, правки строк и история попыток —
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
    // Применяются только схемы логики (only="logic")
    docsImportApi.apply({ files: pkg.nonEmpty, overwrite, only: "logic", nodeId, overrides })
      .then((r) => {
        setRawReport(r);
        if (!r.applied) return;
        if (more) clearPackage(); // следующий воркер — новый пакет, сравнивать не с чем
        onApplied(more);
      })
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
  const applyStyle = { ...primaryBtn, opacity: willWrite && !applying ? 1 : 0.55 };
  // Схема, которую получит окно схемы: рисуем её до применения — это и есть
  // «что изменится». Первая строка плана: пакет окна схемы — один файл.
  const incoming = docName !== null && report !== null && !report.applied ? report.logic[0] ?? null : null;

  return (
    <div style={rightCol}>
      <AgentPackageInput
        pkg={pkg}
        onRemove={removeFile}
        dropText={
          docName !== null
            ? "Перетащите сюда файл схемы, который подготовил агент, или нажмите, чтобы выбрать его на диске. Содержимое можно и вставить текстом."
            : "Перетащите сюда файлы схем, которые создал агент, или нажмите, чтобы выбрать их на диске. Схему можно и вставить текстом."
        }
        pasteTitle="Добавить схему вставкой текста"
      />

      {/* Отчёт превью / применения */}
      <div style={{ marginTop: 10, minHeight: 20 }}>
        {checking && <div style={grayLine}>Проверяю пакет…</div>}
        {/* Вход тот же, что в прошлый заход, — заметка над сводкой: замечание
            повторится, и чинить надо не его, а разговор с агентом. */}
        {repeatedInput && <UnchangedInputNote />}
        {/* Ампутация пометок не должна быть молчаливой: пропавшие между
            попытками — НАД сводкой, до зелёного «Схем: N». */}
        {!checking && shrank.map((line) => (
          <div key={line} style={shrankLine}>
            {line} Проверьте: агент мог удалить их вместо починки
          </div>
        ))}
        {/* Непарсящиеся схемы — строкой НАД сводкой, а не только значком ✗ в
            строке файла: в пакете на три десятка схем значок в списке теряется,
            и пакет применяют целиком (полевая находка Zulip v2). Применение не
            блокируем: схема с битым mermaid — всё ещё текст, который правят. */}
        {!checking && mmdPending && <div style={grayLine}>Проверяю схемы mermaid…</div>}
        {!checking && report !== null && mmdBroken > 0 && (
          <div style={shrankLine}>
            Не парсятся mermaid: {mmdBroken} из {report.logic.length} схем — применение
            их не оживит, почините пакет и загрузите снова
          </div>
        )}
        {!checking && report !== null && report.applied && (
          <div style={{ fontSize: 13, fontWeight: 600, color: "#15803d" }}>
            Применено: схем создано {report.created_docs}, заполнено заглушек{" "}
            {report.filled_docs}, перезаписано {report.updated_docs}.
          </div>
        )}
        {!checking && report !== null && !report.applied && report.errors.length === 0 && (
          docName !== null && report.logic.length === 1 ? (
            <div style={{ fontSize: 13, fontWeight: 600, color: willWrite ? "#15803d" : "#475569" }}>
              {docSummary(report.logic[0].action, docName)}
            </div>
          ) : (
            <div style={{ fontSize: 13, fontWeight: 600, color: willWrite ? "#15803d" : "#475569" }}>
              Схем: {report.logic.length} (новых {countAction(report.logic, "create")},
              заглушек {countAction(report.logic, "fill")},
              перезапись {countAction(report.logic, "overwrite")}, пропуск {countAction(report.logic, "skip")},
              без изменений {countAction(report.logic, "unchanged")})
            </div>
          )
        )}
        {!checking && report !== null && report.errors.length > 0 && (
          <div style={{ fontSize: 12.5, color: "#dc2626" }}>
            <div style={{ fontWeight: 600, marginBottom: 3 }}>Пакет не применить:</div>
            {report.errors.slice(0, 6).map((e, i) => <div key={i} style={{ marginTop: 2 }}>{e}</div>)}
            {report.errors.length > 6 && <div>…ещё {report.errors.length - 6}</div>}
          </div>
        )}

        {!checking && report !== null && report.logic.length > 0 && (
          <ItemList
            title="Схемы логики:"
            rows={report.logic.map((l, i) => {
              // Фиксируем в const: TS не сужает индексацию через ?. в тернарнике
              const err = mmdErrs?.[i] ?? null;
              const key = `${l.node_path}#${l.name}`;
              return {
                key,
                text: `«${l.node_path}»${l.operation ? ` · ${l.operation}` : ""}`,
                badge: ACTION_LABEL[l.action] ?? l.action,
                bad: err !== null ? `mermaid: ${err.split("\n")[0]}` : null,
                ok: mmdErrs?.[i] === null,
                // Имя и вид приехали из шапки файла (или подставлены по
                // умолчанию) — и то и другое правится до применения. В окне
                // схемы имя уже её, править нечего.
                extra: docName !== null ? undefined : (
                  <>
                    <input
                      style={nameInput}
                      value={nameOf(l.source, l.name)}
                      onChange={(e) => edit(l.source, { name: e.target.value || undefined })}
                      title="Имя схемы — под ним она будет видна в ArchMap"
                      aria-label={`Имя схемы из файла ${l.source}`}
                    />
                    <select
                      style={kindSelect}
                      value={kindOf(l.source, l.kind)}
                      onChange={(e) => edit(l.source, { kind: e.target.value as NodeDocKind })}
                      title="Вид схемы — можно поменять до применения"
                      aria-label={`Вид схемы из файла ${l.source}`}
                    >
                      {KIND_ORDER.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                    </select>
                  </>
                ),
              };
            })}
          />
        )}
        {!checking && report !== null && report.conflicts.length > 0 && (
          <NoteList title="Конфликты файлов (оставлен первый источник):" items={report.conflicts} />
        )}
        {!checking && report !== null && report.warnings.length > 0 && (
          <NoteList title="Проверьте:" items={report.warnings} />
        )}
        {!checking && remarks.length > 0 && (
          <button
            type="button"
            style={{ ...secondaryBtn, marginTop: 8, padding: "4px 10px", fontSize: 12.5 }}
            onClick={copyRemarks}
          >
            {remarksCopied ? "Скопировано ✓" : "Скопировать замечания для агента"}
          </button>
        )}
        {askedFor === pkg.files && (
          <StaleFilesConfirm onKeep={() => setAskedFor(null)} onClear={clearPackage} />
        )}
        {!checking && incoming !== null && incoming.mermaid.trim() !== "" && (
          <div style={incomingBox}>
            <MermaidRenderer chart={incoming.mermaid} />
          </div>
        )}
      </div>

      <div style={footRow}>
        {docName === null && (
          <label
            style={{ ...radioRow, marginRight: "auto" }}
            title="Если имя схемы от агента совпадёт с именем схемы, задокументированной в ArchMap, сервис по умолчанию пропустит её. Поставьте галочку, чтобы новые схемы автоматически перезаписывали старые"
          >
            <input type="checkbox" checked={overwriteFlag} onChange={(e) => setOverwriteFlag(e.target.checked)} />
            Обновлять готовые диаграммы
          </label>
        )}
        {mode.kind === "single" ? (
          <>
            <button
              type="button"
              style={{ ...secondaryBtn, opacity: willWrite && !applying ? 1 : 0.55 }}
              disabled={!willWrite || applying}
              title="Применить и подготовить поля к следующему воркеру/эндпоинту"
              onClick={() => apply(true)}
            >
              Добавить ещё
            </button>
            <button type="button" style={applyStyle} disabled={!willWrite || applying} onClick={() => apply(false)}>
              {applying ? "Применяю…" : "Добавить"}
            </button>
          </>
        ) : (
          <button
            type="button"
            style={{ ...applyStyle, marginLeft: docName !== null ? "auto" : undefined }}
            disabled={!willWrite || applying}
            onClick={() => apply(false)}
          >
            {applying ? "Применяю…" : "Применить"}
          </button>
        )}
      </div>
    </div>
  );
}

// ── inline-стили отчёта и правки строк (остальные — agentModalShared) ──

// Тот же amber, что у «Исчезли:» в панели импорта и у заголовков отчёта.
const shrankLine: CSSProperties = {
  fontSize: 12.5, fontWeight: 600, color: "#b45309", marginBottom: 6,
};
const nameInput: CSSProperties = {
  flex: "none", width: 190, font: "inherit", fontSize: 11.5, color: "#0f172a",
  border: "1px solid #e2e8f0", borderRadius: 6, background: "#fff", padding: "1px 5px",
};
const kindSelect: CSSProperties = {
  flex: "none", font: "inherit", fontSize: 11.5, color: "#334155", cursor: "pointer",
  border: "1px solid #e2e8f0", borderRadius: 6, background: "#fff", padding: "1px 4px",
};
// Превью входящей схемы: рамка и точечный фон — как у превью окна схемы.
const incomingBox: CSSProperties = {
  marginTop: 10, maxHeight: 260, overflow: "auto", padding: 12,
  border: "1px solid #e2e8f0", borderRadius: 10,
  backgroundColor: "#fbfcfd",
  backgroundImage: "radial-gradient(#e3e8ee 1px, transparent 1px)",
  backgroundSize: "16px 16px",
};
