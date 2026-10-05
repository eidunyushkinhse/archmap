import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type {
  ArchiveImportResult, Project, PromptVariant, UnifiedFamilyCountsOut, UnifiedPreviewOut,
} from "../../types";
import { projectsApi } from "../../api/projects";
import Modal from "../../ui/Modal";
import { plural } from "../../ui/plural";
import { input, labelStyle, primaryBtn, secondaryBtn } from "../../ui/styles";
import PromptCopyButton from "../docsImport/PromptCopyButton";
import ImportPane from "./ImportPane";
import { DemoExcessNotice, FileTooBigNotice } from "../demo/DemoLimitNotice";
import { firstTooBig, textBytes } from "../demo/demoLimits";
import { UnfixableFold, buildQuestions, pruneAnswers, toDecisions } from "./remainder";
import type { Answer, Answers } from "./remainder";
import "./createProject.css";
import { noAutofill } from "../../ui/noAutofill";

/**
 * Создание проекта — двухпанельное окно: слева способ старта (Пустой / Копия /
 * Импорт / ИИ-агент) со списком вариантов и полями имени/описания, справа превью
 * выбранного варианта (пустой холст, источник копии) либо ЕДИНАЯ панель ввоза
 * (ImportPane: чипы YAML и .zip вперемешку + живая сводка dry-run с отчётом
 * слияния и спорами содержимого). Открывается из лендинга и из дропдауна шапки —
 * компонент один, без редиректов. Успех → onCreated(id).
 *
 * Способа «Шаблон» (шесть каркасов C4 + демо-пакет в витрине) больше нет — убран
 * 2026-09-30; демо-пакет «Ярмарки» ждёт онбординга (tasks.md).
 *
 * Отдельного таба «Из архива» больше нет: архив — такой же вход панели, как YAML
 * (Ф2б, docs/plan-unified-import.md). Ввоз идёт мультипартом /import-unified, а не
 * через POST /projects — отсюда второй шаг «Открыть проект»: отчёт применения
 * (счётчики, замечания) показывается ДО перехода в проект.
 */

interface Props {
  // активные проекты — источник для режима «копия»
  projects: Project[];
  onClose: () => void;
  onCreated: (id: string) => void;
}

// "repo" — «Из репозитория»: генератор промпта для ИИ-агента пользователя + ТА ЖЕ
// единая панель ввоза, что у «Импорта» (таб отдельный — витрина BYOA, решение
// груминга; панель внутри одна).
type StartMode = "blank" | "copy" | "import" | "repo";

export default function CreateProjectDialog({ projects, onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<StartMode>("blank");
  const [sourceId, setSourceId] = useState<string | null>(projects[0]?.id ?? null);
  // Документы импорта (мульти-репо: по YAML на репозиторий) и их имена с диска
  // (строка в строку с docs, null — вставленный текст). Каждое изменение — новый
  // массив, поэтому актуальность сводки проверяется по ссылке (forDocs).
  const [docs, setDocs] = useState<string[]>([""]);
  const [docNames, setDocNames] = useState<(string | null)[]>([]);
  // Архивные входы той же панели (.zip из «Экспорт проекта (zip)»).
  const [archives, setArchives] = useState<File[]>([]);
  // Решения пользователя по спорам содержимого: id спора → «cand:<i>» | «all».
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  // Ответы на остальные вопросы разбора остатка (Ф-E): поля, концы связей,
  // дорисованные связи, склейки. Живут рядом с резолюциями и так же переживают
  // перезапрос превью — id вопроса детерминирован между превью и применением.
  const [answers, setAnswers] = useState<Answers>({});
  // Сводка dry-run привязана к входам, для которых получена: устаревший ответ не
  // показываем и не засчитываем в готовность кнопки.
  const [preview, setPreview] = useState<
    { forDocs: string[]; forArchives: File[]; res: UnifiedPreviewOut } | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Параметры промпта «Из репозитория» (имя системы = название проекта).
  const [promptLang, setPromptLang] = useState<"ru" | "en">("ru");
  const [promptHints, setPromptHints] = useState("");
  const [promptBusy, setPromptBusy] = useState(false);
  // Отчёт применения показываем В ДИАЛОГЕ до перехода в проект: замечания ввоза
  // (неразрешённые адреса, тёзки путей) — видимая деградация, молча провалиться в
  // проект значило бы их спрятать.
  const [unifiedResult, setUnifiedResult] = useState<ArchiveImportResult | null>(null);

  const importish = mode === "import" || mode === "repo";

  // ПОРЯДОК ВХОДОВ — норматив ввоза: сначала непустые YAML в порядке чипов, затем
  // архивы в порядке добавления. Им бэк нумерует входы («вход 3», file_remarks) и
  // от него же зависят tie-break C4-мерджа и дефолты споров, поэтому один и тот же
  // список уезжает и в превью, и в применение. Взаимный порядок yaml/zip на споры
  // не влияет: семьи фактов возят только архивы.
  //
  // Вставленный текстом YAML уезжает с ПУСТЫМ именем: выдуманное «Файл 2.yaml»
  // бэк принял бы за имя файла, а у такого входа подпись источника — номер его
  // чипа («Из файла 2», правка Ф2г). Роутер зовёт безымянный вход «вход N».
  const inputFiles = useMemo(() => {
    const texts = docs
      .map((text, i) => ({ text, name: docNames[i] ?? null }))
      .filter((d) => d.text.trim());
    return [
      ...texts.map((d) => new File([d.text], d.name ?? "", { type: "application/yaml" })),
      ...archives,
    ];
  }, [docs, docNames, archives]);

  // Демо-стенд (docs/tasks/demo-mode.md): вход больше предела файла — превью не
  // запрашиваем (сервер ответил бы 413), показываем отказ и гасим «Создать проект».
  // Вставленный текстом вход подписан номером чипа, как в самой панели.
  const tooBig = useMemo(() => {
    const texts = docs
      .map((text, i) => ({ text, name: docNames[i] ?? null }))
      .filter((d) => d.text.trim());
    return firstTooBig([
      ...texts.map((d, i) => ({ name: d.name ?? `Файл ${i + 1}`, size: textBytes(d.text) })),
      ...archives.map((f) => ({ name: f.name, size: f.size })),
    ]);
  }, [docs, docNames, archives]);

  // Живая сводка ввоза: дебаунс 500мс → dry-run всех входов; устаревшие ответы
  // отбрасываются (alive-флаг в cleanup). Пустая панель сводку не запрашивает — она
  // скрыта по несовпадению ссылок, синхронного сброса стейта в эффекте нет.
  useEffect(() => {
    if (!importish || inputFiles.length === 0 || tooBig) return;
    const forDocs = docs;
    const forArchives = archives;
    let alive = true;
    const t = setTimeout(() => {
      projectsApi.unifiedPreview(inputFiles).then(
        (res) => { if (alive) setPreview({ forDocs, forArchives, res }); },
        (e: unknown) => {
          if (!alive) return;
          const msg = e instanceof Error ? e.message : "Не удалось проверить входы";
          setPreview({ forDocs, forArchives, res: failedPreview(msg, inputFiles.length) });
        },
      );
    }, 500);
    return () => { alive = false; clearTimeout(t); };
  }, [docs, archives, inputFiles, importish, tooBig]);

  const source = projects.find((p) => p.id === sourceId) ?? null;
  const fresh = preview && preview.forDocs === docs && preview.forArchives === archives
    && inputFiles.length > 0 && !tooBig
    ? preview.res
    : null;
  // Демо-стенд: проект из этих входов не поместится в пределы (считает сервер).
  const excess = fresh?.demo_excess ?? null;
  // Мемо, а не выражение: пустой литерал каждый рендер срывал бы ссылочную
  // стабильность бандла архивов ниже (лишние ре-рендеры панели).
  const conflicts = useMemo(() => fresh?.family_conflicts ?? [], [fresh]);
  // Резолюции ПЕРЕЖИВАЮТ перезапрос: id спора стабилен при неизменном составе входов,
  // и правка YAML-текста не должна стирать выбор по архивным спорам. Протухшие
  // (спора больше нет) отбрасываем ПРИ РЕНДЕРЕ — паттерн «adjusting state when props
  // change», а не зеркалящим эффектом.
  if (fresh && Object.keys(resolutions).some((id) => !conflicts.some((c) => c.id === id))) {
    setResolutions(Object.fromEntries(
      Object.entries(resolutions).filter(([id]) => conflicts.some((c) => c.id === id)),
    ));
  }
  // Вопросы разбора остатка — производное от свежего превью, а не состояние.
  const questions = useMemo(
    () => (fresh === null ? [] : buildQuestions({
      family_conflicts: fresh.family_conflicts, remainder: fresh.remainder,
    })),
    [fresh],
  );
  // Ответы протухают тем же правилом, что и резолюции: правка YAML пересчитывает
  // превью, и вопроса с этим id может больше не быть. Чистка ПРИ РЕНДЕРЕ (та же
  // «adjusting state when props change»); без протухших pruneAnswers возвращает
  // ту же ссылку, поэтому цикла setState нет.
  if (fresh !== null) {
    const живые = pruneAnswers(answers, questions);
    if (живые !== answers) setAnswers(живые);
  }
  // П3: единственный вход и он архив — «копия одного архива», имя и описание берутся
  // из манифеста, поля не рендерятся вовсе.
  const fromManifest = fresh?.name_source === "manifest";

  const archiveInputs = useMemo(() => ({
    files: archives,
    onFiles: setArchives,
  }), [archives]);

  // Бандл разбора: собирается одним мемо, чтобы панель не перерисовывалась на
  // каждый чужой рендер диалога (как и archiveInputs).
  const remainderInputs = useMemo(() => ({
    questions,
    answers,
    onAnswer: (id: string, answer: Answer) => setAnswers((cur) => ({ ...cur, [id]: answer })),
    resolutions,
    onResolve: (id: string, choice: string) =>
      setResolutions((cur) => ({ ...cur, [id]: choice })),
    unfixable: fresh?.remainder.unfixable ?? [],
  }), [questions, answers, resolutions, fresh]);

  const canSubmit =
    importish
      // Ввоз: после применения кнопка становится «Открыть проект»; до него нужна
      // зелёная сводка и имя — кроме «копии одного архива», где имя из манифеста.
      ? !busy && (unifiedResult !== null
        || (fresh?.ok === true && excess === null && (fromManifest || name.trim().length > 0)))
      : name.trim().length > 0 &&
        !busy &&
        !(mode === "copy" && !sourceId);

  // Промпт собирает бэкенд (истина формата — рядом с валидатором импорта);
  // копирование после fetch — в пределах жеста, Chrome это допускает. Имя системы
  // вшито в промпт ЛЮБОГО варианта (в том числе аудитного), поэтому вся тройка
  // неактивна, пока проект без имени. «Скопировано» показывает PromptCopyButton по
  // разрешению обещания — ошибку пробрасываем, чтобы её не показал.
  function copyPrompt(variant: PromptVariant): Promise<void> {
    setPromptBusy(true);
    return projectsApi
      .importPrompt({
        systemName: name.trim(),
        // Глубина у агента всегда просится одна — два слоя (решение пользователя
        // 2026-08-16): выбора в интерфейсе нет.
        depth: 2,
        lang: promptLang,
        hints: promptHints.trim() || undefined,
        variant,
      })
      .then((res) => navigator.clipboard.writeText(res.prompt))
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Не удалось скопировать промпт");
        throw e;
      })
      .finally(() => setPromptBusy(false));
  }

  async function submit() {
    if (!canSubmit) return;
    if (importish) {
      // Второй клик — уже «Открыть проект»: отчёт показан, переходим.
      if (unifiedResult) {
        onCreated(unifiedResult.project_id);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        setUnifiedResult(await projectsApi.importUnified(inputFiles, {
          // «Копия одного архива»: поля скрыты, и обещание «имя из архива» должно
          // держаться — набранное раньше в другом составе входов не подсовываем.
          name: fromManifest ? undefined : name.trim(),
          description: fromManifest ? undefined : description.trim() || undefined,
          resolutions,
          // Ответы разбора остатка: «как сейчас» и молчание в форму не едут —
          // результат у них тот же, что сегодня (toDecisions вернёт null).
          decisions: toDecisions(questions, answers),
        }));
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Не удалось выполнить импорт");
      }
      setBusy(false);
      return;
    }
    setBusy(true);
    setError(null);
    const start = mode === "copy" ? `copy:${sourceId}` : "blank";
    try {
      const created = await projectsApi.create({
        name: name.trim(),
        description: description.trim() || null,
        start,
      });
      onCreated(created.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось создать проект");
      setBusy(false);
    }
  }

  const nameFields = (
    <div>
      <label style={labelStyle}>Название</label>
      <input
        {...noAutofill("create-project-dialog-1")}
        data-autofocus
        style={input}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Например, «Платёжная платформа»"
        onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
      />
      <label style={labelStyle}>Описание <span style={{ color: "#94a3b8", fontWeight: 400 }}>(необязательно)</span></label>
      <textarea
        {...noAutofill("create-project-dialog-2")}
        style={{ ...input, minHeight: 52, resize: "none", marginBottom: 0 }}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Коротко о схеме"
      />
    </div>
  );

  // П3: единственный вход-архив — поля не показываем вовсе, называем источник.
  const manifestNote = (
    <div style={manifestBox}>
      <div style={{ fontSize: 13, color: "#334155" }}>
        Имя и описание — из архива: «{fresh?.manifest_name ?? "без имени"}»
      </div>
      {fresh?.manifest_description && (
        <div style={{ fontSize: 12.5, color: "#94a3b8", marginTop: 3 }}>
          {fresh.manifest_description}
        </div>
      )}
    </div>
  );

  return (
    <Modal onClose={onClose} boxStyle={{ width: 904, maxHeight: "90vh", padding: 0, overflow: "hidden" }}>
      <div style={root}>
        <h3 style={title}>Новый проект</h3>

        <div style={body}>
          {/* ── Левая колонка: способ старта + список + имя/описание ── */}
          <div style={leftCol} data-tour="create-project">
            {/* Четыре способа — сеткой 2×2: в строку узкой колонки они не влезают
                («ИИ-агент» упирался в рамку), а перенос 3+1 растягивал последний. */}
            <div className="cp-segs">
              <SegBtn label="Пустой" on={mode === "blank"} onClick={() => setMode("blank")} />
              <SegBtn
                label="Копия"
                on={mode === "copy"}
                disabled={projects.length === 0}
                onClick={() => projects.length && setMode("copy")}
              />
              <SegBtn label="Импорт" on={mode === "import"} onClick={() => setMode("import")} />
              <SegBtn label="ИИ-агент" on={mode === "repo"} onClick={() => setMode("repo")} />
            </div>

            <div style={listArea}>
              {mode === "copy" &&
                projects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`cp-row${p.id === sourceId ? " cp-row--on" : ""}`}
                    onClick={() => setSourceId(p.id)}
                  >
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: "block", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {p.name}
                      </span>
                      <span style={{ fontSize: 12, color: "#64748b" }}>
                        {p.object_count} {plural(p.object_count, ["объект", "объекта", "объектов"])} · {p.edge_count} {plural(p.edge_count, ["связь", "связи", "связей"])}
                      </span>
                    </span>
                  </button>
                ))}

              {/* Серого абзаца «что принимается» в левой колонке ввоза больше нет
                  (ТЗ §1.1): он обещал сводку со склейкой и подозрениями, которой
                  теперь нет, а форматы входов называет плейсхолдер самой панели. */}

              {mode === "repo" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.55, color: "#64748b" }}>
                    <li>Дайте название новому проекту.</li>
                    <li>Скопируйте промпт.</li>
                    <li>
                      Запустите своего ИИ-агента (Claude Code, Cursor, Qwen Code и т.д.) в
                      репозитории вашей системы. Если репозиториев несколько, запустите по
                      агенту в каждом из них.
                    </li>
                    <li>Дождитесь, пока все агенты вернут YAML.</li>
                    <li>Перетащите все YAML в поле справа.</li>
                  </ol>
                  <div>
                    <label style={labelStyle}>Язык описаний</label>
                    <select
                      style={{ ...input, marginBottom: 0 }}
                      value={promptLang}
                      onChange={(e) => setPromptLang(e.target.value === "en" ? "en" : "ru")}
                    >
                      <option value="ru">Русский</option>
                      <option value="en">Английский</option>
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>
                      Подсказки агенту <span style={{ color: "#94a3b8", fontWeight: 400 }}>(необязательно)</span>
                    </label>
                    <textarea
                      {...noAutofill("create-project-dialog-3")}
                      style={{ ...input, minHeight: 44, resize: "none", marginBottom: 0 }}
                      value={promptHints}
                      onChange={(e) => setPromptHints(e.target.value)}
                      placeholder="например: монорепо, сервисы в services/*"
                    />
                  </div>
                  <PromptCopyButton
                    label="Скопировать промпт"
                    copiedLabel="Промпт скопирован ✓"
                    kind="secondary"
                    buttonStyle={{ opacity: name.trim() ? 1 : 0.55 }}
                    disabled={!name.trim() || promptBusy}
                    copy={copyPrompt}
                  />
                </div>
              )}
            </div>

            {/* Имя и описание живут слева ТОЛЬКО там, где слева есть место.
                В режимах со вставкой файлов левая колонка занята параметрами
                промпта, и поля выдавливали кнопку «Скопировать промпт» за край —
                там они переезжают вправо, над зоной вставки. */}
            {!importish && nameFields}
          </div>

          {/* ── Правая колонка: живое превью выбранного варианта ── */}
          <div style={rightCol}>
            {mode === "blank" && (
              <>
                <div style={emptyFrame}>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontWeight: 700, fontSize: 15, color: "#475569" }}>Пустая схема</div>
                    <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 4 }}>начните с чистого листа</div>
                  </div>
                </div>
                <p style={blurbStyle}>Проект откроется с пустым холстом.</p>
              </>
            )}

            {mode === "copy" && source && (
              <>
                <div style={emptyFrame}>
                  <div style={{ textAlign: "center", padding: "0 24px" }}>
                    <div style={{ fontWeight: 700, fontSize: 15, color: "#475569" }}>{source.name}</div>
                    <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 4 }}>
                      {source.object_count} {plural(source.object_count, ["объект", "объекта", "объектов"])} · {source.edge_count} {plural(source.edge_count, ["связь", "связи", "связей"])}
                    </div>
                  </div>
                </div>
                <p style={blurbStyle}>Точная копия схемы «{source.name}» со всеми узлами и связями.</p>
              </>
            )}

            {importish && (unifiedResult === null ? (
              <>
                <div style={{ marginBottom: 12 }}>{fromManifest ? manifestNote : nameFields}</div>
                <ImportPane
                  docs={docs}
                  onDocs={setDocs}
                  names={docNames}
                  onNames={setDocNames}
                  // Не помещается в демо — сводка и вопросы ни к чему: сначала
                  // уменьшить входы. Вместо них — отказ с полоской ниже.
                  summary={excess ? null : (fresh?.c4 ?? null)}
                  archives={archiveInputs}
                  remainder={remainderInputs}
                />
                {tooBig && (
                  <div style={{ marginTop: 12 }}><FileTooBigNotice {...tooBig} /></div>
                )}
                {excess && (
                  <div style={{ marginTop: 12 }}><DemoExcessNotice excess={excess} scope="files" /></div>
                )}
              </>
            ) : (
              /* Отчёт применения ДО перехода в проект: замечания — видимая
                 деградация, прятать их за навигацией нельзя. */
              <ImportReport result={unifiedResult} />
            ))}

          </div>
        </div>

        <div style={footer}>
          {error && <span style={{ flex: 1, color: "#dc2626", fontSize: 13, alignSelf: "center" }}>{error}</span>}
          <button style={secondaryBtn} disabled={busy} onClick={onClose}>Отмена</button>
          <button
            data-tour="create-project-submit"
            style={{ ...primaryBtn, whiteSpace: "nowrap", opacity: canSubmit ? 1 : 0.55 }}
            disabled={!canSubmit}
            onClick={submit}
          >
            {busy ? "Создание…"
              : importish && unifiedResult ? "Открыть проект"
              : "Создать проект"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// Нулевые счётчики семей для отказа превью: считать нечего, но форма ответа
// обязана быть полной — панель читает её без проверок на undefined.
const NO_FAMILIES: UnifiedFamilyCountsOut = {
  docs: 0, specs: 0, tables: 0, channels: 0, params: 0, processes: 0,
};

// Отказ самой проверки — беда всего пакета, а не чьего-то входа: агенту такое не
// адресуем, в панели оно показывается схемной строкой.
function failedPreview(msg: string, files: number): UnifiedPreviewOut {
  return {
    ok: false,
    errors: [msg],
    families: NO_FAMILIES,
    family_conflicts: [],
    // Остаток слияния (Ф-E): разбирать нечего — превью не состоялось.
    remainder: {
      field_conflicts: [], container_edges: [], isolated_groups: [], fuzzy_pairs: [],
      unfixable: [], converted_warnings: [], node_paths: [], node_has_children: [],
    },
    warnings: [],
    name_source: "fields",
    c4: {
      ok: false, errors: [msg], node_count: 0, edge_count: 0, roots: [], node_names: [],
      files, merged_count: 0, merged: [], merged_nodes: [], nodes_without_anchor: 0,
      conflicts: [], warnings: [], dropped_edges: 0,
      file_remarks: [], schema_errors: [msg], schema_warnings: [],
    },
  };
}

// Отчёт применения ввоза: сколько чего приехало и что не разрешилось. Показывается
// вместо панели — из него уходят в проект кнопкой «Открыть проект».
function ImportReport({ result }: { result: ArchiveImportResult }) {
  const linked = result.processes.reduce((s, p) => s + p.doc_linked, 0);
  const unresolved = result.processes.reduce((s, p) => s + p.doc_unresolved, 0);
  return (
    <div style={{ fontSize: 13, color: "#334155", lineHeight: 1.6 }}>
      <div style={{ fontWeight: 700, fontSize: 15, color: "#0f172a", marginBottom: 8 }}>
        «{result.project_name}» создан
      </div>
      <div>Объектов: {result.nodes} · связей: {result.edges}</div>
      <div>Схем логики: {result.docs_created} · спек: {result.specs_applied}</div>
      {result.db && <div>Таблиц БД: {result.db.tables_written}</div>}
      {result.channels && <div>Каналов брокеров: {result.channels.channels_written}</div>}
      {result.channel_stubs > 0 && (
        <div>Каналов брокеров заведено по связям схемы: {result.channel_stubs} (без описания)</div>
      )}
      {result.config && <div>Параметров конфигурации: {result.config.params_written}</div>}
      {result.processes.length > 0 && (
        <div>
          Процессов: {result.processes.length} · привязок шагов: {linked}
          {unresolved > 0 && (
            <span style={{ color: "#b45309" }}> · не разрешилось: {unresolved}</span>
          )}
        </div>
      )}
      {/* Споры рассудил пользователь — говорим об этом вслух: выбор был, и он учтён. */}
      {result.resolved_conflicts > 0 && (
        <div>
          Разрешено споров содержимого: {result.resolved_conflicts}
        </div>
      )}
      {/* Сырого списка «Замечания» нет (Ф2г-2): то, что требует рук, — той же
          свёрткой, что в превью; информация о сделанном видна по счётчикам. Сырые
          строки (result.warnings) остаются в ответе для MCP. */}
      <UnfixableFold items={result.unfixable} after />
    </div>
  );
}

function SegBtn({ label, on, disabled, onClick }: {
  label: string; on: boolean; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button type="button" className={`cp-seg${on ? " cp-seg--on" : ""}`} disabled={disabled} onClick={onClick}>
      {label}
    </button>
  );
}

// Корень несёт колонки и ограничение высоты (maxHeight на <dialog> задаёт бокс,
// но внутренние скроллы работают от этого же лимита на контенте).
const root: CSSProperties = { display: "flex", flexDirection: "column", maxHeight: "90vh" };
const title: CSSProperties = { margin: 0, padding: "20px 22px 0", fontSize: 18, fontWeight: 700, color: "#0f172a" };
const body: CSSProperties = { display: "flex", gap: 22, padding: 22, height: 560, minHeight: 0 };
const leftCol: CSSProperties = { width: 326, flexShrink: 0, display: "flex", flexDirection: "column", gap: 12, minHeight: 0 };
const listArea: CSSProperties = { flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 };
const rightCol: CSSProperties = { flex: 1, minWidth: 0, overflowY: "auto" };
const blurbStyle: CSSProperties = { margin: "8px 0 12px", fontSize: 13.5, lineHeight: 1.55, color: "#475569" };
// Плашка вместо полей имени/описания, когда единственный вход — архив (П3).
const manifestBox: CSSProperties = {
  padding: "10px 12px", borderRadius: 10, border: "1px solid #e2e8f0", background: "#f8fafc",
};
const emptyFrame: CSSProperties = {
  height: 280, display: "flex", alignItems: "center", justifyContent: "center",
  borderRadius: 10, border: "1px solid #eef2f6",
  background: "radial-gradient(circle, #d8e0ea 1px, transparent 1px) 0 0 / 16px 16px, #f8fafc",
};
const footer: CSSProperties = {
  display: "flex", justifyContent: "flex-end", gap: 8,
  padding: "14px 22px 16px", borderTop: "1px solid #eef2f6",
};
