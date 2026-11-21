// Окно «Импорт процессов» и «Заменить процесс» (редизайн, фаза 3б). Источник один на оба
// способа: поле текста (вставленный текст — один черновик) и файлы (кнопкой или
// перетаскиванием; в .md каждый блок mermaid с sequenceDiagram — свой черновик).
// Название черновика подставляется само: шапка диаграммы, заголовок Markdown, имя
// файла (importDrafts). Превью считается само (useImportPreviews), под черновиком
// только то, что требует решения или говорит о потере (ImportDraftIssues).
//
// Пользователь НЕ обязан сопоставить каждого участника (его решение): оставленные без
// объекта заводятся непривязанными, их шаги — без связи; об этом сказано до импорта.
//
// Замена (replace): один черновик, название подставлено текущее, содержимое процесса
// заменяется, id и область остаются, перед заменой бэкенд сохраняет версию проекта.
// Привязка шага к схеме логики переживает замену только строкой `%% archmap-doc`
// перед шагом: окно сравнивает, сколько привязок у процесса сейчас и сколько
// разрешится в новом тексте.
import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import Modal from "../../ui/Modal";
import { processesApi } from "../../api/processes";
import type { ProcessImportPreview, ProcessReplaceResult } from "../../types";
import { limitMessage } from "../demo/demoLimits";
import { noAutofill } from "../../ui/noAutofill";
import { ChevronDownIcon } from "../../ui/icons";
import { plural } from "../../ui/plural";
import { autoName, splitDiagram, splitFile } from "./importDrafts";
import type { DraftSource } from "./importDrafts";
import { requestKey, useImportPreviews } from "./useImportPreviews";
import type { PreviewResult } from "./useImportPreviews";
import ImportDraftIssues from "./ImportDraftIssues";
import { chosenNode, hasIssues, issuesOf } from "./importIssues";
import type { DocKeep, DraftFailure } from "./importIssues";
import "../../ui/ds.css";
import "./processes.css";

interface Props {
  onClose: () => void;
  // Импорт создал процессы (в порядке черновиков). all — прошли все: окно закрывается,
  // открывается первый; иначе окно остаётся с упавшими. Замене не нужен.
  onImported?: (processIds: string[], all: boolean) => void;
  // Режим замены: какой процесс заменить. Без него — импорт новых процессов.
  replace?: { id: string; name: string };
  onReplaced?: (result: ProcessReplaceResult, name: string) => void;
}

// Файл больше этого не читаем: диаграмма процесса столько не весит.
const MAX_FILE_BYTES = 1024 * 1024;
const FILE_TYPES = /\.(mmd|md|markdown|txt)$/i;

interface Draft extends DraftSource {
  key: string;
  // Название, правленное человеком; null — подставляется само (autoName).
  name: string | null;
  // Выбор человека: алиас участника → id узла, пустая строка — без объекта схемы.
  choice: Record<string, string>;
  // Файл не прочитан (велик, не тот тип, нет диаграммы): черновик не импортируется.
  fileError: string | null;
  // Отказ последней попытки импорта или замены; правка текста его снимает.
  failure: DraftFailure | null;
}

const PLACEHOLDER = [
  "sequenceDiagram",
  "    Покупатель->>Веб-витрина: подтверждает корзину",
  "    Веб-витрина->>Order API: создать заказ",
].join("\n");

// Ключ черновика: уникален на всё время жизни страницы, порядок не важен.
let draftSeq = 0;
function newDraft(src: DraftSource, extra: Partial<Draft> = {}): Draft {
  return { key: `d${++draftSeq}`, ...src, name: null, choice: {}, fileError: null, failure: null, ...extra };
}

export default function ProcessImportModal({ onClose, onImported, replace, onReplaced }: Props) {
  const [drafts, setDrafts] = useState<Draft[]>(() => [
    newDraft({ raw: "", fallbackName: "" }, replace ? { name: replace.name } : {}),
  ]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [dropping, setDropping] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Замена: сколько шагов процесса привязаны к схемам логики сейчас (K).
  const [keptNow, setKeptNow] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const replaceId = replace?.id;
  useEffect(() => {
    if (!replaceId) return;
    let alive = true;
    processesApi.get(replaceId).then(
      (p) => { if (alive) setKeptNow(p.messages.filter((m) => !!m.doc_id).length); },
      (e: unknown) => { if (alive) setLoadError(e instanceof Error ? e.message : "Не удалось загрузить процесс"); },
    );
    return () => { alive = false; };
  }, [replaceId]);

  // Входы превью: текст без шапки и выбор человека. Мемо — ссылочная стабильность для
  // эффекта превью (меняется только вместе с черновиками).
  const inputs = useMemo(
    () => drafts.map((d) => ({ key: d.key, body: d.fileError ? "" : splitDiagram(d.raw).body, choice: d.choice })),
    [drafts],
  );
  const results = useImportPreviews(inputs);

  // Состояние черновика для показа и импорта.
  const view = drafts.map((d, idx) => {
    const input = inputs[idx];
    const res: PreviewResult | undefined = results[d.key];
    const hasText = input.body.trim() !== "";
    const fresh = hasText && res !== undefined && res.reqKey === requestKey(input);
    const preview: ProcessImportPreview | null = hasText ? res?.preview ?? null : null;
    const previewError = fresh ? res.error : null;
    const name = d.name ?? autoName(d);
    const keep: DocKeep | null = replace && keptNow !== null && preview
      ? { m: issuesOf(preview).docKept, k: keptNow }
      : null;
    const errors: DraftFailure[] = [d.fileError, previewError, d.failure]
      .filter((e): e is DraftFailure => e !== null);
    // К импорту: есть текст и свежее превью без отказа (без превью неизвестно
    // сопоставление — участники уехали бы непривязанными).
    const importable = !d.fileError && hasText && fresh && !previewError;
    return { d, body: input.body, preview, name, keep, errors, importable, pending: hasText && !fresh };
  });

  // Черновики с отказом (файл не прочитан, превью не посчиталось) не импортируются и
  // кнопку не держат: ошибка видна у них самих. Держат кнопку превью в пути и пустое
  // название.
  const toImport = view.filter((v) => v.importable);
  const canSubmit = !busy && toImport.length > 0
    && !view.some((v) => v.pending)
    && toImport.every((v) => v.name.trim() !== "");

  function patch(key: string, change: Partial<Draft>) {
    setDrafts((cur) => cur.map((d) => (d.key === key ? { ...d, ...change } : d)));
  }

  async function addFiles(list: FileList | File[]) {
    const files = Array.from(list);
    if (!files.length) return;
    const fresh: Draft[] = [];
    for (const f of files) {
      if (!FILE_TYPES.test(f.name)) {
        fresh.push(newDraft({ raw: "", fallbackName: f.name }, { fileError: "Подходят файлы .mmd, .md и .txt" }));
      } else if (f.size > MAX_FILE_BYTES) {
        fresh.push(newDraft({ raw: "", fallbackName: f.name }, { fileError: "Файл больше 1 МБ и не прочитан" }));
      } else {
        let text: string;
        try {
          text = await f.text();
        } catch {
          fresh.push(newDraft({ raw: "", fallbackName: f.name }, { fileError: "Файл не прочитан" }));
          continue;
        }
        const parts = splitFile(f.name, text);
        if (!parts.length) {
          fresh.push(newDraft({ raw: "", fallbackName: f.name }, { fileError: "В файле нет блока mermaid с sequenceDiagram" }));
        }
        for (const p of parts) fresh.push(newDraft(p));
      }
      if (replace && fresh.some((d) => !d.fileError)) break; // замене нужен один файл
    }
    setDrafts((cur) => {
      if (replace) {
        // Один черновик: текст из файла, название — прежнее (текущее имя процесса).
        const src = fresh.find((d) => !d.fileError) ?? fresh[0];
        return [{ ...src, name: cur[0]?.name ?? replace.name }];
      }
      // Пустое поле вставки уступает место файлам.
      const kept = cur.filter((d) => d.raw.trim() !== "" || d.fileError);
      return [...kept, ...fresh];
    });
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    setDropping(true);
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    setDropping(false);
    void addFiles(e.dataTransfer.files);
  }

  function mappingOf(v: (typeof view)[number]): Record<string, string | null> {
    // Именно ||, а не ??: снятый выбор лежит пустой строкой, и с ?? она уехала бы на
    // бэкенд невалидным uuid.
    return Object.fromEntries(
      (v.preview?.participants ?? []).map((p) => [p.alias, chosenNode(p, v.d.choice) || null]),
    );
  }

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      if (replace) {
        const v = toImport[0];
        const name = v.name.trim();
        try {
          const res = await processesApi.replaceProcess(replace.id, { text: v.body, name, mapping: mappingOf(v) });
          onReplaced?.(res, name);
        } catch (e: unknown) {
          patch(v.d.key, { failure: limitMessage(e, "save") ?? (e instanceof Error ? e.message : "Не удалось заменить процесс") });
        }
        return;
      }
      // Импорт по очереди: успешные уходят из списка, упавшие остаются со своей ошибкой.
      const created: string[] = [];
      const failed = new Map<string, DraftFailure>();
      for (const v of toImport) {
        try {
          const res = await processesApi.importProcess({ text: v.body, name: v.name.trim(), mapping: mappingOf(v) });
          created.push(res.process_id);
        } catch (e: unknown) {
          // Демо-стенд: проект упёрся в предел (docs/tasks/demo-mode.md).
          failed.set(v.d.key, limitMessage(e, "process") ?? (e instanceof Error ? e.message : "Не удалось импортировать процесс"));
        }
      }
      const done = new Set(toImport.map((v) => v.d.key).filter((k) => !failed.has(k)));
      const all = failed.size === 0 && view.every((v) => v.importable);
      if (!all) {
        setDrafts((cur) => cur
          .filter((d) => !done.has(d.key))
          .map((d) => (failed.has(d.key) ? { ...d, failure: failed.get(d.key) ?? null } : d)));
      }
      if (created.length) onImported?.(created, all);
    } finally {
      setBusy(false);
    }
  }

  const single = drafts.length === 1;
  const title = replace ? "Заменить процесс" : "Импорт процессов";
  const button = replace
    ? "Заменить"
    : toImport.length > 1
      ? `Импортировать ${toImport.length} ${plural(toImport.length, ["процесс", "процесса", "процессов"])}`
      : "Импортировать";

  return (
    <Modal onClose={onClose} onSubmit={() => void submit()} boxStyle={{ width: 720, maxHeight: "calc(100vh - 48px)", overflowY: "auto", padding: 24 }}>
      <div
        className={"ds pim" + (dropping ? " is-drop" : "")}
        onDragOver={onDragOver}
        // Уход указателя за пределы окна, а не переход между его частями.
        onDragLeave={(e) => {
          if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setDropping(false);
        }}
        onDrop={onDrop}
      >
        <h2 className="pim-title">{title}</h2>
        {loadError && <p className="ds-danger pim-line">{loadError}</p>}

        {single ? (
          <SingleDraft
            v={view[0]}
            replace={!!replace}
            onName={(name) => patch(view[0].d.key, { name })}
            onText={(raw) => patch(view[0].d.key, { raw, failure: null, fileError: null })}
            onChoose={(alias, id) => patch(view[0].d.key, { choice: { ...view[0].d.choice, [alias]: id } })}
          />
        ) : (
          <div className="pim-rows">
            {view.map((v) => {
              const isOpen = open[v.d.key] ?? hasIssues(v.preview, v.errors.length > 0, v.keep);
              return (
                <div key={v.d.key} className="pim-row">
                  <div className="pim-row-head">
                    <button
                      type="button"
                      className="pim-row-chev"
                      aria-expanded={isOpen}
                      aria-label={isOpen ? "Свернуть" : "Раскрыть"}
                      onClick={() => setOpen((o) => ({ ...o, [v.d.key]: !isOpen }))}
                    >
                      <span className={"ds-chev" + (isOpen ? "" : " is-closed")}><ChevronDownIcon /></span>
                    </button>
                    <input
                      {...noAutofill(`process-import-name-${v.d.key}`)}
                      className="ds-field pim-row-name"
                      value={v.name}
                      maxLength={256}
                      placeholder="Название процесса"
                      aria-label="Название процесса"
                      onChange={(e) => patch(v.d.key, { name: e.target.value })}
                    />
                    {v.preview && (
                      <span className="pim-row-steps">
                        {v.preview.message_count} {plural(v.preview.message_count, ["шаг", "шага", "шагов"])}
                      </span>
                    )}
                    <button
                      type="button"
                      className="ds-del"
                      title="Убрать из импорта"
                      aria-label="Убрать из импорта"
                      onClick={() => setDrafts((cur) => cur.filter((d) => d.key !== v.d.key))}
                    >
                      ×
                    </button>
                  </div>
                  {isOpen && (
                    <div className="pim-row-body">
                      <ImportDraftIssues
                        preview={v.preview}
                        choice={v.d.choice}
                        onChoose={(alias, id) => patch(v.d.key, { choice: { ...v.d.choice, [alias]: id } })}
                        errors={v.errors}
                        keep={v.keep}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="pim-foot">
          <button type="button" className="ds-add" onClick={() => fileInput.current?.click()}>
            {replace ? "Выбрать файл" : "Выбрать файлы"}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".mmd,.md,.txt"
            multiple={!replace}
            hidden
            onChange={(e) => {
              const files = e.target.files;
              if (files) void addFiles(files);
              e.target.value = ""; // тот же файл можно выбрать ещё раз
            }}
          />
          <div className="pim-btns">
            <button type="button" className="ds-btn ds-btn--primary" disabled={!canSubmit} onClick={() => void submit()}>
              {button}
            </button>
            <button type="button" className="ds-btn" onClick={onClose}>Отмена</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// Один черновик: поле названия, текст диаграммы и его проблемы. Без списка.
function SingleDraft({ v, replace, onName, onText, onChoose }: {
  v: {
    d: Draft;
    preview: ProcessImportPreview | null;
    name: string;
    keep: DocKeep | null;
    errors: DraftFailure[];
  };
  replace: boolean;
  onName: (name: string) => void;
  onText: (raw: string) => void;
  onChoose: (alias: string, nodeId: string) => void;
}) {
  return (
    <>
      <input
        {...noAutofill("process-import-name")}
        className="ds-input pim-name"
        value={v.name}
        maxLength={256}
        placeholder="Название процесса"
        aria-label="Название процесса"
        onChange={(e) => onName(e.target.value)}
      />
      <textarea
        {...noAutofill("process-import-text")}
        className="pim-text"
        value={v.d.raw}
        placeholder={PLACEHOLDER}
        aria-label={replace ? "Новый текст процесса" : "Текст диаграммы"}
        spellCheck={false}
        data-autofocus
        onChange={(e) => onText(e.target.value)}
      />
      <ImportDraftIssues
        preview={v.preview}
        choice={v.d.choice}
        onChoose={onChoose}
        errors={v.errors}
        keep={v.keep}
      />
    </>
  );
}
