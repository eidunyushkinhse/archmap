// Окно «Список операций от агента» (BYOA) — НУЛЕВОЙ шаг документирования монолита.
//
// Пятое окно того же семейства (схемы логики, спека, структура БД, каналы), но
// принимает оно не документацию, а ОГЛАВЛЕНИЕ: агент обходит репозиторий и
// возвращает перечень операций API и фоновых воркеров одним файлом. Строки перечня
// становятся ЗАГЛУШКАМИ — схемами с пустым телом, — и дальше документирование идёт
// по списку: адресно, порциями, с видимым остатком (docs/plan-recon.md).
//
// Чего здесь НЕТ намеренно: переключателя «перезаписывать» (у потока нет политики
// перезаписи вовсе — применение только создаёт), правок строк превью (перечень
// правит агент, а не человек), выбора языка и режимов «пакетом/по одной».
//
// Превью группируется ПО ДЕЙСТВИЮ: перечень монолита — двести с лишним строк, и
// плоский столбец в нём так же нечитаем, как в витрине.
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { NodeDocKind, PromptVariant, ReconAction, ReconImportReport, ReconItem } from "../../types";
import { reconApi, type DocsFile } from "../../api/docsImport";
import { useDocsFiles, MAX_FILES } from "./useDocsFiles";
import { useFileDrop } from "./useFileDrop";
import { OPEN_LIMIT } from "../docsCollapse";
import {
  inputFingerprint, useRepeatedInput,
  head, sub, cols, leftCol, rightCol, leftNote,
  chipsRow, chipOn, chip, chipBtn, chipX, fileArea, dropHint, grayLine, footRow, badge,
} from "./agentModalShared";
import { NoteList, StaleFilesConfirm, UnchangedInputNote } from "./agentModalReport";
import PromptTriple from "./PromptTriple";
import Modal from "../../ui/Modal";
import { ChevronDownIcon, CloseIcon } from "../../ui/icons";
import { primaryBtn, secondaryBtn } from "../../ui/styles";

// Группы превью — в порядке «что сделаем → что уже есть → расхождение». Подписи
// русские и говорят действием, а не кодом: человек читает их, а не Literal бэка.
const GROUPS: { action: ReconAction; title: string; note?: string }[] = [
  { action: "create", title: "Создадим заглушки" },
  { action: "unchanged", title: "Заглушки уже есть" },
  {
    action: "described",
    title: "Уже описаны — не тронем",
    note: "Повторная разведка не затирает работу: описанная схема остаётся как есть.",
  },
  {
    action: "vanished",
    title: "Есть в документации, но не найдено в коде",
    note: "Ничего не удаляем — это показ расхождения. Схему уберёт человек, если сочтёт нужным.",
  },
];

const KIND_LABEL: Record<NodeDocKind, string> = {
  overview: "обзор",
  operation: "операция",
  worker: "воркер",
};

// Группа длиннее OPEN_LIMIT — стартует свёрнутой: двести строк «создадим» человек не
// читает, он смотрит на число в заголовке и разворачивает, если хочет проверить
// выборочно. Порог общий с витриной «Логики» (components/docsCollapse).

// Строка превью. doc_name приходит, только когда имя УЖЕ существующей схемы отличается
// от строки перечня («POST /messages» описан схемой «Отправка сообщения»), — и человек
// должен видеть, ЧТО именно закрыло операцию.
function ReconRow({ item }: { item: ReconItem }) {
  return (
    <div style={row}>
      <span style={rowName} title={item.name}>{item.name}</span>
      <span style={badge}>{KIND_LABEL[item.kind]}</span>
      {item.doc_name && (
        <span style={rowDoc} title={item.doc_name}>→ {item.doc_name}</span>
      )}
    </div>
  );
}

// Группа строк: заголовок с числом, тело под своим скроллом. Скролл — не украшение:
// он и держит кнопку «Применить» на экране, сколько бы строк ни приехало.
//
// Компонент объявлен НА ВЕРХНЕМ УРОВНЕ модуля: объявленный внутри другого он
// ремаунтился бы каждый рендер (ловушка проекта — так ломался drag палитры).
function ReconGroup({ title, note, items }: { title: string; note?: string; items: ReconItem[] }) {
  const [open, setOpen] = useState(items.length <= OPEN_LIMIT);
  return (
    <div style={{ marginTop: 8 }}>
      <button type="button" style={groupHead} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span style={{ transform: open ? "none" : "rotate(-90deg)", display: "inline-flex" }}>
          <ChevronDownIcon />
        </span>
        {title}
        <span style={groupCount}>{items.length}</span>
      </button>
      {open && (
        <>
          {note && <div style={groupNote}>{note}</div>}
          <div style={groupBody}>
            {items.map((it) => <ReconRow key={`${it.kind}:${it.name}`} item={it} />)}
          </div>
        </>
      )}
    </div>
  );
}

interface Props {
  // Объект, из окна которого открыта разведка: к нему уедет перечень без строки node.
  nodeId: string;
  nodeName: string;
  onClose: () => void;
  // Заглушки созданы — родитель перечитывает объект (секция «Логика»).
  onApplied: () => void;
}

export default function ReconAgentModal({ nodeId, nodeName, onClose, onApplied }: Props) {
  const pkg = useDocsFiles();
  const [rawReport, setRawReport] = useState<ReconImportReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [remarksCopied, setRemarksCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);
  const drop = useFileDrop({ onFiles: pkg.pickFiles, disabled: pkg.files.length >= MAX_FILES });

  // Пустые файлы прячут отчёт ПРОИЗВОДНО — эффект не зеркалит состояние в состояние.
  const report = pkg.hasContent ? rawReport : null;

  // Гвард «вход не изменился»: тот же байт-в-байт файл, что в прошлый заход, — повод
  // посмотреть на выдачу агента, а не на замечание (находка полевой приёмки).
  const fingerprint = useMemo(() => inputFingerprint(pkg.files), [pkg.files]);
  const repeatedInput = useRepeatedInput(pkg.files, fingerprint);
  // Пакет, к которому задан вопрос об устаревании (после копирования замечаний).
  const [askedFor, setAskedFor] = useState<DocsFile[] | null>(null);

  useEffect(() => {
    const nonEmpty = pkg.files.filter((f) => f.content.trim() !== "");
    if (nonEmpty.length === 0) return;
    const seq = ++seqRef.current;
    const t = window.setTimeout(() => {
      setChecking(true);
      reconApi.preview({ files: nonEmpty, nodeId })
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
  }, [pkg.files, nodeId]);

  // Запрос промпта + запись в буфер В ПРЕДЕЛАХ ЖЕСТА (иначе Chrome отбирает
  // разрешение); «скопировано» по каждому из трёх вариантов показывает PromptTriple.
  function copyPrompt(variant: PromptVariant): Promise<void> {
    return reconApi.prompt(nodeId, variant).then(({ prompt }) => navigator.clipboard.writeText(prompt));
  }

  const remarks = report === null ? [] : [...report.errors, ...report.warnings];

  // «Чини, а не удаляй» — тот же урок, что у соседних дозаливок: на голое «исправь»
  // слабая модель отвечает ампутацией, вырезая строки, на которые жалуется валидатор.
  function copyRemarks() {
    const text =
      "Валидатор разведки ArchMap нашёл замечания к перечню точек входа. " +
      "Исправь файл и сообщи, что изменилось. Строки чини по замечаниям, " +
      "а не удаляй из перечня:\n" +
      remarks.map((r) => `- ${r}`).join("\n");
    void navigator.clipboard.writeText(text).then(() => {
      setRemarksCopied(true);
      setTimeout(() => setRemarksCopied(false), 2000);
      // Замечания ушли агенту — вернётся исправленная версия, и лежащий в панели
      // файл устареет. Спрашиваем сразу, пока пользователь здесь.
      setAskedFor(pkg.files);
    });
  }

  // Убрать файлы из панели: вход и отчёт уходят целиком — новый заход сравнивать
  // будет не с чем.
  function clearPackage() {
    setAskedFor(null);
    pkg.reset();
    setRawReport(null);
  }

  function apply() {
    setApplying(true);
    reconApi.apply({ files: pkg.nonEmpty, nodeId })
      .then((r) => {
        setRawReport(r);
        if (!r.applied) return;
        onApplied();
        onClose();
      })
      .finally(() => setApplying(false));
  }

  // Группы и числа — производные отчёта (в рендере, не эффектом): своего состояния у
  // превью нет, и рассинхрониться ему не с чем. Пустые группы не показываем вовсе.
  const groups = useMemo(() => {
    const items = report?.items ?? [];
    return GROUPS
      .map((g) => ({ ...g, items: items.filter((it) => it.action === g.action) }))
      .filter((g) => g.items.length > 0);
  }, [report]);
  const createCount = report?.items.filter((it) => it.action === "create").length ?? 0;
  // Строки ПЕРЕЧНЯ: «исчезнувшие» пришли не из файла, а из документации объекта.
  const listedCount = report?.items.filter((it) => it.action !== "vanished").length ?? 0;

  const willWrite = report !== null && report.errors.length === 0 && createCount > 0;

  return (
    <Modal onClose={onClose} closeButton={false} boxStyle={{ width: 1060, maxWidth: "calc(100vw - 48px)", maxHeight: "92vh", overflowY: "auto" }}>
      <div style={head}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Список операций от агента</h2>
        <button onClick={onClose} className="modal-close" aria-label="Закрыть"><CloseIcon /></button>
      </div>
      <p style={sub}>
        Агент обойдёт репозиторий и вернёт ПЕРЕЧЕНЬ точек входа — операций API и
        фоновых воркеров, — а не их описание. Строки перечня станут заглушками в
        разделе «Логика»: их видно, они посчитаны, и дальше вы описываете их по списку.
        Перечень без строки «node:» приедет к объекту «{nodeName}».
      </p>

      <div style={cols}>
        <div style={leftCol}>
          <PromptTriple
            label="Скопировать промпт"
            copiedLabel="Скопировано ✓"
            kind="primary"
            copy={copyPrompt}
          />
          <p style={leftNote}>
            Перезаписывать нечего: применение только создаёт недостающие заглушки.
            Уже описанные схемы разведка не трогает, удалений здесь нет вовсе — поэтому
            перечень можно приносить повторно после релиза, он даст дифф, а не дубли.
          </p>
        </div>

        <div style={rightCol}>
          <div style={chipsRow}>
            {pkg.files.map((f, i) => (
              <span key={f.name} style={i === pkg.active ? chipOn : chip}>
                <button type="button" style={chipBtn} title={f.name} onClick={() => pkg.setActive(i)}>
                  {f.name}
                </button>
                <button type="button" style={chipX} title="Убрать файл" onClick={() => pkg.removeFile(i)}>×</button>
              </span>
            ))}
            <input
              ref={fileRef}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(e) => { pkg.pickFiles(e.target.files); e.target.value = ""; }}
            />
            <button type="button" className="btn-soft" disabled={pkg.files.length >= MAX_FILES}
              onClick={() => fileRef.current?.click()}>
              Загрузить файлы…
            </button>
            <button type="button" className="btn-soft" disabled={pkg.files.length >= MAX_FILES}
              title="Добавить файл вставкой текста" onClick={pkg.addPaste}>
              + вставить из буфера
            </button>
          </div>

          <div className={drop.over ? "drop-zone--over" : undefined} {...drop.bind}>
            {pkg.files.length > 0 ? (
              <textarea
                style={fileArea}
                value={pkg.files[pkg.active]?.content ?? ""}
                onChange={(e) => pkg.setText(pkg.active, e.target.value)}
                placeholder="вставьте содержимое файла"
                spellCheck={false}
              />
            ) : (
              <button type="button" style={dropHint} onClick={() => fileRef.current?.click()}>
                Перетащите сюда перечень, который подготовил агент, — или нажмите, чтобы
                выбрать его на диске. Содержимое можно и вставить текстом.
              </button>
            )}
          </div>
          {drop.error && <p style={{ ...grayLine, color: "#b45309", marginTop: 6 }}>{drop.error}</p>}

          <div style={{ marginTop: 10, minHeight: 20 }}>
            {checking && <div style={grayLine}>Проверяю перечень…</div>}
            {/* Вход тот же, что в прошлый заход, — заметка над сводкой. */}
            {repeatedInput && <UnchangedInputNote />}
            {!checking && report !== null && report.applied && (
              <div style={{ fontSize: 13, fontWeight: 600, color: "#15803d" }}>
                Применено: заглушек создано {report.created}.
              </div>
            )}
            {!checking && report !== null && !report.applied && report.errors.length === 0 && (
              <div style={{ fontSize: 13, fontWeight: 600, color: willWrite ? "#15803d" : "#475569" }}>
                Точек входа в перечне: {listedCount} (новых {createCount})
                {report.node_path && <span style={{ fontWeight: 400, color: "#64748b" }}> · объект «{report.node_path}»</span>}
              </div>
            )}
            {!checking && report !== null && report.errors.length > 0 && (
              <div style={{ fontSize: 12.5, color: "#dc2626" }}>
                <div style={{ fontWeight: 600, marginBottom: 3 }}>Перечень не применить:</div>
                {report.errors.slice(0, 6).map((e, i) => <div key={i} style={{ marginTop: 2 }}>{e}</div>)}
                {report.errors.length > 6 && <div>…ещё {report.errors.length - 6}</div>}
              </div>
            )}

            {!checking && groups.map((g) => (
              <ReconGroup key={g.action} title={g.title} note={g.note} items={g.items} />
            ))}

            {!checking && report !== null && report.warnings.length > 0 && (
              <NoteList title="Проверьте:" items={report.warnings} />
            )}
            {!checking && remarks.length > 0 && (
              <button type="button"
                style={{ ...secondaryBtn, marginTop: 8, padding: "4px 10px", fontSize: 12.5 }}
                onClick={copyRemarks}>
                {remarksCopied ? "Скопировано ✓" : "Скопировать замечания для агента"}
              </button>
            )}
            {askedFor === pkg.files && (
              <StaleFilesConfirm onKeep={() => setAskedFor(null)} onClear={clearPackage} />
            )}
          </div>

          <div style={footRow}>
            <button type="button"
              style={{ ...primaryBtn, opacity: willWrite && !applying ? 1 : 0.55 }}
              disabled={!willWrite || applying}
              onClick={apply}>
              {applying ? "Применяю…" : "Применить"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── inline-стили групп превью ─────────────────────────────────────────
const groupHead: CSSProperties = {
  display: "flex", alignItems: "center", gap: 6, width: "100%",
  border: "none", background: "none", padding: 0, cursor: "pointer",
  font: "inherit", fontSize: 12.5, fontWeight: 600, color: "#334155", textAlign: "left",
};
const groupCount: CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "#475569", background: "#f1f5f9",
  border: "1px solid #e2e8f0", borderRadius: 5, padding: "1px 6px",
};
const groupNote: CSSProperties = { marginTop: 3, fontSize: 11.5, color: "#94a3b8", lineHeight: 1.5 };
// Скролл ГРУППЫ: перечень монолита — двести строк, и без него кнопка «Применить»
// уехала бы за экран (у окна свой maxHeight, и страница внутри него не бесконечна).
const groupBody: CSSProperties = { marginTop: 3, maxHeight: 200, overflowY: "auto" };
const row: CSSProperties = {
  display: "flex", alignItems: "baseline", gap: 6, marginTop: 3, fontSize: 12.5,
};
const rowName: CSSProperties = {
  color: "#475569", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
};
const rowDoc: CSSProperties = {
  color: "#64748b", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
};
