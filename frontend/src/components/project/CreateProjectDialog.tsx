import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type {
  ArchiveImportResult, Project, PromptVariant, TemplateOut, UnifiedFamilyCountsOut,
  UnifiedPreviewOut,
} from "../../types";
import { projectsApi } from "../../api/projects";
import Modal from "../../ui/Modal";
import { plural } from "../../ui/plural";
import { input, labelStyle, primaryBtn, secondaryBtn } from "../../ui/styles";
import PromptTriple from "../docsImport/PromptTriple";
import C4Preview from "./C4Preview";
import ImportPane from "./ImportPane";
import "./createProject.css";

/**
 * Создание проекта — двухпанельная витрина: слева способ старта (Пустой / Шаблон /
 * Копия / Импорт / ИИ-агент) со списком вариантов и полями имени/описания, справа
 * живое превью выбранного шаблона (C4Preview 1:1 с холстом) либо ЕДИНАЯ панель
 * ввоза (ImportPane: чипы YAML и .zip вперемешку + живая сводка dry-run с отчётом
 * слияния и спорами содержимого). Открывается из лендинга и из дропдауна шапки —
 * компонент один, без редиректов. Успех → onCreated(id).
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
type StartMode = "blank" | "template" | "copy" | "import" | "repo";

// Линейные SVG-глифы шаблонов (currentColor, без эмодзи), по id из каталога.
function TemplateGlyph({ id, size = 18 }: { id: string; size?: number }) {
  const p = { width: size, height: size, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (id) {
    case "monolith": // стопка
      return (<svg {...p}><rect x="6" y="3.5" width="12" height="17" rx="2" /><path d="M6 9h12M6 14.5h12" /></svg>);
    case "webapp": // окно-браузер
      return (<svg {...p}><rect x="3" y="4.5" width="18" height="14" rx="2" /><path d="M3 9h18M8 18.5v2M16 18.5v2M6 21h12" /></svg>);
    case "microservices": // сетка 2×2
      return (<svg {...p}><rect x="3.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.6" /></svg>);
    case "eventdriven": // волны
      return (<svg {...p}><circle cx="12" cy="12" r="2.4" /><path d="M7 7a7 7 0 0 0 0 10M17 7a7 7 0 0 1 0 10M4 4a11 11 0 0 0 0 16M20 4a11 11 0 0 1 0 16" /></svg>);
    case "serverless": // молния
      return (<svg {...p}><path d="M13 2.5 4.5 13.5H11l-1.5 8L20 9.5h-7z" /></svg>);
    case "cqrs": // две встречные стрелки
      return (<svg {...p}><path d="M4 8h11l-3-3M4 8l3 3M20 16H9l3-3M20 16l-3 3" /></svg>);
    default:
      return (<svg {...p}><rect x="4" y="4" width="16" height="16" rx="2" /></svg>);
  }
}

export default function CreateProjectDialog({ projects, onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<StartMode>("template");
  const [templates, setTemplates] = useState<TemplateOut[] | null>(null); // null = грузится
  const [templateId, setTemplateId] = useState<string | null>(null);
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

  // Загрузка каталога шаблонов (легитимный эффект). По умолчанию выбран webapp,
  // иначе первый из ответа.
  useEffect(() => {
    projectsApi.templates().then(
      (list) => {
        setTemplates(list);
        setTemplateId((cur) => cur ?? (list.find((t) => t.id === "webapp") ?? list[0])?.id ?? null);
      },
      (e: unknown) => {
        setTemplates([]);
        setError(e instanceof Error ? e.message : "Не удалось загрузить шаблоны");
      },
    );
  }, []);

  const importish = mode === "import" || mode === "repo";

  // ПОРЯДОК ВХОДОВ — норматив ввоза: сначала непустые YAML в порядке чипов, затем
  // архивы в порядке добавления. Им бэк нумерует входы («вход 3», file_remarks) и
  // от него же зависят tie-break C4-мерджа и дефолты споров, поэтому один и тот же
  // список уезжает и в превью, и в применение. Взаимный порядок yaml/zip на споры
  // не влияет: семьи фактов возят только архивы.
  const inputFiles = useMemo(() => {
    const texts = docs
      .map((text, i) => ({ text, name: docNames[i] ?? null }))
      .filter((d) => d.text.trim());
    return [
      ...texts.map((d, i) =>
        new File([d.text], d.name ?? `Файл ${i + 1}.yaml`, { type: "application/yaml" })),
      ...archives,
    ];
  }, [docs, docNames, archives]);

  // Живая сводка ввоза: дебаунс 500мс → dry-run всех входов; устаревшие ответы
  // отбрасываются (alive-флаг в cleanup). Пустая панель сводку не запрашивает — она
  // скрыта по несовпадению ссылок, синхронного сброса стейта в эффекте нет.
  useEffect(() => {
    if (!importish || inputFiles.length === 0) return;
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
  }, [docs, archives, inputFiles, importish]);

  const tpl = templates?.find((t) => t.id === templateId) ?? null;
  const source = projects.find((p) => p.id === sourceId) ?? null;
  const fresh = preview && preview.forDocs === docs && preview.forArchives === archives
    && inputFiles.length > 0
    ? preview.res
    : null;
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
  // П3: единственный вход и он архив — «копия одного архива», имя и описание берутся
  // из манифеста, поля не рендерятся вовсе.
  const fromManifest = fresh?.name_source === "manifest";

  const archiveInputs = useMemo(() => ({
    files: archives,
    onFiles: setArchives,
    counts: fresh?.families ?? NO_FAMILIES,
    conflicts,
    resolutions,
    onResolve: (id: string, choice: string) =>
      setResolutions((cur) => ({ ...cur, [id]: choice })),
  }), [archives, fresh, conflicts, resolutions]);

  const canSubmit =
    importish
      // Ввоз: после применения кнопка становится «Открыть проект»; до него нужна
      // зелёная сводка и имя — кроме «копии одного архива», где имя из манифеста.
      ? !busy && (unifiedResult !== null
        || (fresh?.ok === true && (fromManifest || name.trim().length > 0)))
      : name.trim().length > 0 &&
        !busy &&
        !(mode === "template" && !templateId) &&
        !(mode === "copy" && !sourceId);

  // Промпт собирает бэкенд (истина формата — рядом с валидатором импорта);
  // копирование после fetch — в пределах жеста, Chrome это допускает. Имя системы
  // вшито в промпт ЛЮБОГО варианта (в том числе аудитного), поэтому вся тройка
  // неактивна, пока проект без имени. «Скопировано» показывает PromptTriple по
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
        }));
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Не удалось выполнить импорт");
      }
      setBusy(false);
      return;
    }
    setBusy(true);
    setError(null);
    const start =
      mode === "template" ? `template:${templateId}` :
      mode === "copy" ? `copy:${sourceId}` : "blank";
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
        data-autofocus
        style={input}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Например, «Платёжная платформа»"
        onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
      />
      <label style={labelStyle}>Описание <span style={{ color: "#94a3b8", fontWeight: 400 }}>(необязательно)</span></label>
      <textarea
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
          <div style={leftCol}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <SegBtn label="Пустой" on={mode === "blank"} onClick={() => setMode("blank")} />
              <SegBtn label="Шаблон" on={mode === "template"} onClick={() => setMode("template")} />
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
              {mode === "template" && (
                templates === null ? (
                  <>
                    <div className="cp-skel" style={{ height: 34, marginBottom: 6 }} />
                    <div className="cp-skel" style={{ height: 34, marginBottom: 6 }} />
                    <div className="cp-skel" style={{ height: 34 }} />
                  </>
                ) : (
                  templates.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={`cp-row${t.id === templateId ? " cp-row--on" : ""}`}
                      onClick={() => setTemplateId(t.id)}
                    >
                      <span style={glyphBox}><TemplateGlyph id={t.id} /></span>
                      <span style={{ fontWeight: 600 }}>{t.name}</span>
                    </button>
                  ))
                )
              )}

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

              {mode === "import" && (
                <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: "#64748b" }}>
                  Принимаются и .yaml-файлы (тот же формат, что выдаёт «Экспорт»), и
                  полные архивы знания .zip из «Экспорт проекта (zip)» — можно
                  вперемешку. Схемы сольются автоматически, сводка справа покажет
                  склейку, конфликты и подозрения; архивы привезут ещё и
                  документацию — схемы логики, спеки, структуры БД и брокеров,
                  конфигурацию, процессы. Раскладка пересчитается заново.
                </p>
              )}

              {mode === "repo" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: "#64748b" }}>
                    Схему построит ваш ИИ-агент (Claude Code, Cursor…): скопируйте
                    промпт и запустите его в корне каждого репозитория системы.
                    Каждый прогон вернёт YAML. Вставьте их все справа, файлы
                    сольются автоматически.
                  </p>
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
                      style={{ ...input, minHeight: 44, resize: "none", marginBottom: 0 }}
                      value={promptHints}
                      onChange={(e) => setPromptHints(e.target.value)}
                      placeholder="например: монорепо, сервисы в services/*"
                    />
                  </div>
                  <PromptTriple
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
            {mode === "template" && (
              templates === null || !tpl ? (
                <div className="cp-skel" style={{ height: 280 }} />
              ) : (
                <>
                  <C4Preview template={tpl} height={280} showLabels />
                  <div style={{ marginTop: 14 }}>
                    <div style={{ fontWeight: 700, fontSize: 15, color: "#0f172a" }}>{tpl.name}</div>
                    <p style={blurbStyle}>{tpl.blurb}</p>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {tpl.techs.map((tech) => (
                        <span key={tech} style={techChip}>{tech}</span>
                      ))}
                    </div>
                  </div>
                </>
              )
            )}

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
                  summary={fresh?.c4 ?? null}
                  archives={archiveInputs}
                />
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

// Счётчики семей, пока сводки нет: панель показывает строку «Из архивов: …»
// только по непустым числам, поэтому нули её просто не рисуют.
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
      {result.warnings.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontWeight: 600, color: "#b45309" }}>Замечания</div>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18, color: "#64748b", fontSize: 12.5 }}>
            {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}
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
const glyphBox: CSSProperties = {
  width: 30, height: 30, flexShrink: 0, display: "inline-flex", alignItems: "center",
  justifyContent: "center", color: "#64748b",
};
const blurbStyle: CSSProperties = { margin: "8px 0 12px", fontSize: 13.5, lineHeight: 1.55, color: "#475569" };
// Плашка вместо полей имени/описания, когда единственный вход — архив (П3).
const manifestBox: CSSProperties = {
  padding: "10px 12px", borderRadius: 10, border: "1px solid #e2e8f0", background: "#f8fafc",
};
const techChip: CSSProperties = {
  padding: "3px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600,
  background: "#f1f5f9", color: "#475569", border: "1px solid #e2e8f0",
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
