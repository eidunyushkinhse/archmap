// Модалка «Импорт проекта (zip)» — ДОГРУЗКА полных архивов знания к ЖИВОМУ
// проекту (Ф4, docs/plan-unified-import.md). Кебаб «Действия со схемой» открывает
// её на любой странице проекта.
//
// Отличие от создания проекта: там из архивов собирают проект с нуля, здесь схема
// уже живёт — с раскладкой, схемами логики, спеками и ручными правками. Поэтому
// центр окна не «что в архивах», а ДИФФ: сколько объектов и связей появится, какое
// знание доедет и о чём придётся выбрать. Догрузка аддитивна: живая запись
// перетирается ТОЛЬКО там, где пользователь явно выбрал кандидата из архива
// (дефолт каждого спора — «оставить моё», его ставит бэк).
//
// YAML сюда не кладут принципиально: в существующий проект он заливается синком
// («Импорт схемы» в том же меню) — там своя механика якорей и политик.
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { IntoApplyOut, IntoPreviewOut } from "../../types";
import { projectsApi } from "../../api/projects";
import { isConflict } from "../../api/client";
import { plural } from "../../ui/plural";
import { useFileDrop } from "../docsImport/useFileDrop";
import {
  head, sub, chipsRow, chip, chipBtn, chipX, dropHint, grayLine, footRow,
} from "../docsImport/agentModalShared";
import { statusState } from "./importRemarks";
import {
  BulkBox, RemainderBlock, StatusLine, UnfixableFold, buildQuestions, bulkAnswers,
  hasMineDisputes, pruneAnswers, splitErrorLine, toDecisions,
} from "./remainder";
import type { Answer, Answers } from "./remainder";
import { anchorKind, basisLabel } from "../anchor/anchorText";
import Modal from "../../ui/Modal";
import { CloseIcon } from "../../ui/icons";
import { primaryBtn, secondaryBtn } from "../../ui/styles";

interface Props {
  projectId: string;
  onClose: () => void;
  /** Знание догружено — родитель показывает тост и перечитывает граф. */
  onApplied: (message: string) => void;
}

// Устаревшее превью — не тупик: план пересчитывается сам, выбор пользователя цел.
const STALE =
  "Проект изменился — превью обновлено, проверьте и повторите.";

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
    families: { docs: 0, specs: 0, tables: 0, channels: 0, params: 0, processes: 0 },
    family_conflicts: [],
    // Остаток слияния (Ф-E): разбирать нечего — превью не состоялось.
    remainder: {
      field_conflicts: [], container_edges: [], isolated_groups: [], fuzzy_pairs: [],
      unfixable: [], converted_warnings: [], node_paths: [], node_has_children: [],
    },
    warnings: [],
    base_graph_rev: 0,
    base_meta_rev: 0,
  };
}

/** Что приедет из архивов — только ненулевые семьи, иначе строка из одних нулей. */
function familyLine(f: IntoPreviewOut["families"]): string | null {
  const parts = [
    f.docs && `${f.docs} ${plural(f.docs, ["схема логики", "схемы логики", "схем логики"])}`,
    f.specs && `${f.specs} ${plural(f.specs, ["спека", "спеки", "спек"])}`,
    f.tables && `${f.tables} ${plural(f.tables, ["таблица", "таблицы", "таблиц"])}`,
    f.channels && `${f.channels} ${plural(f.channels, ["канал", "канала", "каналов"])}`,
    f.params && `${f.params} ${plural(f.params, ["параметр", "параметра", "параметров"])}`,
    f.processes && `${f.processes} ${plural(f.processes, ["процесс", "процесса", "процессов"])}`,
  ].filter((s): s is string => typeof s === "string");
  return parts.length ? parts.join(" · ") : null;
}

/** Строка тоста: тронутое, а не «сколько знания в проекте» (форма отчёта догрузки). */
function applySummary(r: IntoApplyOut): string {
  const parts = [
    r.nodes_created && `${r.nodes_created} ${plural(r.nodes_created, ["объект", "объекта", "объектов"])}`,
    r.edges_created && `${r.edges_created} ${plural(r.edges_created, ["связь", "связи", "связей"])}`,
    r.docs_created && `${r.docs_created} ${plural(r.docs_created, ["схема логики", "схемы логики", "схем логики"])}`,
    r.specs_applied && `${r.specs_applied} ${plural(r.specs_applied, ["спека", "спеки", "спек"])}`,
    r.db?.tables_written && `${r.db.tables_written} ${plural(r.db.tables_written, ["таблица", "таблицы", "таблиц"])}`,
    r.channels?.channels_written && `${r.channels.channels_written} ${plural(r.channels.channels_written, ["канал", "канала", "каналов"])}`,
    r.channel_stubs && `${r.channel_stubs} ${plural(r.channel_stubs, ["канал по связи", "канала по связям", "каналов по связям"])}`,
    r.config?.params_written && `${r.config.params_written} ${plural(r.config.params_written, ["параметр", "параметра", "параметров"])}`,
    r.processes.length && `${r.processes.length} ${plural(r.processes.length, ["процесс", "процесса", "процессов"])}`,
  ].filter((s): s is string => typeof s === "string");
  return parts.length ? `Догружено: ${parts.join(", ")}` : "Догрузка завершена: нового не появилось";
}

/** Есть ли ради чего применять: новое, спор или хоть один вопрос разбора. */
function brings(p: IntoPreviewOut, questions: number): boolean {
  return p.nodes_new > 0 || p.edges_new > 0
    || familyLine(p.families) !== null || p.family_conflicts.length > 0 || questions > 0;
}

export default function ImportIntoModal({ projectId, onClose, onApplied }: Props) {
  const [files, setFiles] = useState<File[]>([]);
  // Превью привязано к составу файлов И к номеру перезапроса: устаревший ответ не
  // показываем, а после 409 показ гаснет до прихода свежего плана.
  const [preview, setPreview] = useState<
    { forFiles: File[]; key: number; res: IntoPreviewOut } | null
  >(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  // Ответы на остальные вопросы разбора остатка (Ф-E) — рядом с резолюциями и по
  // тем же правилам: переживают перезапрос превью, протухшие отбрасываются.
  const [answers, setAnswers] = useState<Answers>({});
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  // Отчёт применения показываем В ОКНЕ: замечания догрузки (промахи адресов,
  // тёзки процессов) — видимая деградация, прятать их за закрытием нельзя.
  const [result, setResult] = useState<IntoApplyOut | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);

  const addFiles = (list: ArrayLike<File> | null) => {
    if (!list || list.length === 0) return;
    setFiles((cur) => [...cur, ...Array.from(list)]);
  };

  const drop = useFileDrop({ accept: [".zip"], onFiles: addFiles });

  // Превью БЕЗ дебаунса: состав файлов меняется редко (перетащили архив), а не
  // посимвольно, как текст в редакторе. Устаревшие ответы отбрасывает seq —
  // синхронного setState в эффекте нет (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (files.length === 0) return;
    const seq = ++seqRef.current;
    projectsApi.importIntoPreview(projectId, files).then(
      (res) => { if (seq === seqRef.current) setPreview({ forFiles: files, key: reloadKey, res }); },
      (e: unknown) => {
        if (seq !== seqRef.current) return;
        const msg = e instanceof Error ? e.message : "Не удалось проверить архивы";
        setPreview({ forFiles: files, key: reloadKey, res: failedPreview(msg) });
      },
    );
  }, [projectId, files, reloadKey]);

  const fresh =
    preview && preview.forFiles === files && preview.key === reloadKey ? preview.res : null;
  const checking = files.length > 0 && fresh === null;
  // Мемо, а не выражение: пустой литерал каждый рендер срывал бы ссылочную
  // стабильность зависимых мемо ниже.
  const conflicts = useMemo(() => fresh?.family_conflicts ?? [], [fresh]);
  // Резолюции ПЕРЕЖИВАЮТ перезапрос превью (в том числе после 409): id спора
  // стабилен, пока состав входов и живое знание те же. Протухшие отбрасываем ПРИ
  // РЕНДЕРЕ — паттерн «adjusting state when props change», а не зеркалящим эффектом.
  if (fresh && Object.keys(resolutions).some((id) => !conflicts.some((c) => c.id === id))) {
    setResolutions(Object.fromEntries(
      Object.entries(resolutions).filter(([id]) => conflicts.some((c) => c.id === id)),
    ));
  }
  // Вопросы разбора — производное от свежего превью. Сноска о связи в контейнер
  // здесь говорит «после догрузки»: проект уже создан (mode).
  const questions = useMemo(
    () => (fresh === null ? [] : buildQuestions({
      family_conflicts: fresh.family_conflicts, remainder: fresh.remainder, mode: "into",
    })),
    [fresh],
  );
  if (fresh !== null) {
    const живые = pruneAnswers(answers, questions);
    if (живые !== answers) setAnswers(живые);
  }
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
  // случай: догрузили архив ЭТОГО же проекта) — кнопка гаснет, а дифф это объясняет.
  const canApply = !!fresh?.ok && !applying && brings(fresh, questions.length);

  return (
    <Modal
      onClose={onClose}
      closeButton={false}
      boxStyle={{ width: 720, maxWidth: "calc(100vw - 48px)", maxHeight: "92vh", overflowY: "auto" }}
    >
      <div style={head}>
        <h3 style={{ margin: 0, fontSize: 16.5 }}>Импорт проекта из архива</h3>
        <button className="modal-close" onClick={onClose} aria-label="Закрыть">
          <CloseIcon />
        </button>
      </div>
      <p style={sub}>
        Догрузите к текущему проекту архив другого проекта (или сразу несколько). Схемы
        смерджатся, вместе с ними перенесутся схемы логики, спецификации, структуры баз и
        брокеров, конфигурация и процессы. Информация не затрётся без вашего выбора, ничего
        не удаляется, расположение объектов остаётся на месте. Если вы хотите подгрузить не
        архив, а YAML к этому проекту, то воспользуйтесь другим пунктом меню: «Импорт схемы».
      </p>

      {result ? (
        <ApplyReport result={result} />
      ) : (
        <>
          <div className={drop.over ? "drop-zone--over" : undefined} {...drop.bind}>
          <div style={chipsRow}>
            {files.map((f, i) => (
              <span key={f.name + i} style={chip}>
                {/* Имя — подпись, а не кнопка: переключать в этом окне нечего
                    (тело архива не правят), чипы служат только составом и снятием. */}
                <span style={chipName} title={f.name}>{f.name}</span>
                <button
                  type="button"
                  style={chipX}
                  onClick={() => setFiles((cur) => cur.filter((_, k) => k !== i))}
                  aria-label={`Убрать ${f.name}`}
                >
                  ×
                </button>
              </span>
            ))}
            {files.length > 0 && (
              <button type="button" className="btn-soft" onClick={() => fileRef.current?.click()}>
                Добавить архив…
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              multiple
              accept=".zip"
              style={{ display: "none" }}
              onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
            />
          </div>

          {files.length === 0 && (
            <button type="button" style={dropHint} onClick={() => fileRef.current?.click()}>
              Перетащите сюда архивы .zip — те, что скачиваются пунктом «Экспорт проекта
              (zip)», — или нажмите, чтобы выбрать их на диске.
            </button>
          )}
          </div>
          {drop.error && <p style={{ ...grayLine, color: "#b45309", marginTop: 6 }}>{drop.error}</p>}

          {checking && <p style={{ ...grayLine, marginTop: 8 }}>Считаем, что приедет…</p>}
          {/* Та же строка статуса, что в окне создания (§1.2): отказ разбора
              архива — её красное состояние со ВСЕМИ ошибками (несколько —
              списком, правка Ф2г). Виновника-чипа здесь нет: архивы не
              переключаются, их читают; имя архива — в начале текста ошибки. */}
          {fresh && (
            <StatusLine
              state={statusState(fresh.ok, questions.length + fresh.remainder.unfixable.length)}
              errors={fresh.ok ? undefined : (
                fresh.errors.length > 0 ? fresh.errors : ["Не удалось прочитать архив"]
              ).map((e) => ({ chipLabel: null, chipIndex: null, ...splitErrorLine(e) }))}
            />
          )}
          {fresh?.ok && <Diff preview={fresh} />}

          {fresh?.ok && questions.length > 0 && (
            <RemainderBlock
              questions={questions}
              answers={answers}
              resolutions={resolutions}
              onAnswer={(id: string, answer: Answer) => setAnswers((cur) => ({ ...cur, [id]: answer }))}
              onResolve={(id, choice) => setResolutions((cur) => ({ ...cur, [id]: choice }))}
              mode="into"
            />
          )}
          {/* Массовые действия — под вопросами: сначала видно, о чём спор, потом
              «а можно всё разом». Жестов и споров без живого они не касаются. */}
          {fresh?.ok && withMine && (
            <BulkBox onKeepMine={() => resolveAll(true)} onTakeArchives={() => resolveAll(false)} />
          )}
          {fresh?.ok && <UnfixableFold items={fresh.remainder.unfixable} />}
          {applyError && (
            <p style={{ ...grayLine, color: "#b45309", marginTop: 8 }}>{applyError}</p>
          )}
        </>
      )}

      <div style={footRow}>
        {result ? (
          <button
            type="button"
            style={primaryBtn}
            onClick={() => { onApplied(applySummary(result)); onClose(); }}
          >
            Готово
          </button>
        ) : (
          <>
            <button type="button" style={secondaryBtn} onClick={onClose}>
              Отмена
            </button>
            <button type="button" style={primaryBtn} onClick={apply} disabled={!canApply}>
              {applying ? "Догружаем…" : "Применить"}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

// Дифф превью: числа тут про то, что ПОЯВИТСЯ, а не про содержимое архивов.
function Diff({ preview }: { preview: IntoPreviewOut }) {
  const families = familyLine(preview.families);
  const появятся = preview.new_nodes;
  const найдены = preview.matched_nodes;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "#15803d" }}>
        Нового: {preview.nodes_new} {plural(preview.nodes_new, ["объект", "объекта", "объектов"])}
        {" · "}
        {preview.edges_new} {plural(preview.edges_new, ["связь", "связи", "связей"])}
      </div>
      {families && <div style={{ ...grayLine, marginTop: 3 }}>Приедет: {families}</div>}
      {/* Догрузка сопоставляет узлы ЯКОРЕМ, и до Ф2 (docs/plan-anchor-ux.md) она об
          этом молчала — показывала только новое. Самое спорное её решение («это тот
          же объект») теперь названо вслух, вместе с основанием каждой находки. */}
      {preview.nodes_matched > 0 && (
        <div style={{ ...grayLine, marginTop: 3 }}>
          Найдено в проекте: {preview.nodes_matched}{" "}
          {plural(preview.nodes_matched, ["объект", "объекта", "объектов"])}
          {найдены.map((m) => (
            <div key={m.path} style={subRow}>
              {m.path} — {basisLabel(m.basis, m.path)}
            </div>
          ))}
          {preview.nodes_matched > найдены.length && (
            <div style={subRow}>…ещё {preview.nodes_matched - найдены.length}</div>
          )}
        </div>
      )}
      {появятся.length > 0 && (
        <div style={{ ...grayLine, marginTop: 3 }}>
          Появятся:
          {появятся.map((n) => (
            <div key={n.path} style={subRow}>
              {n.path}
              {/* Без якоря объект будет опознаваться только по имени: следующая
                  догрузка не узнает его, если имя изменится. */}
              {anchorKind(n.source) === null && " (без якоря)"}
            </div>
          ))}
          {preview.nodes_new > появятся.length && (
            <div style={subRow}>…ещё {preview.nodes_new - появятся.length}</div>
          )}
        </div>
      )}
      {/* Сырых строк «Проверьте» здесь больше нет (Ф2г): всё, что не стало вопросом,
          показывает свёртка «Придется подправить вручную» дружелюбными пунктами. */}
    </div>
  );
}

// Отчёт применения: «сколько записей тронуто» (форма догрузки), отчёты семей —
// родные. То, что придётся поправить руками, — свёрткой до закрытия окна.
function ApplyReport({ result }: { result: IntoApplyOut }) {
  const linked = result.processes.reduce((s, p) => s + p.doc_linked, 0);
  const unresolved = result.processes.reduce((s, p) => s + p.doc_unresolved, 0);
  return (
    <div style={{ fontSize: 13, color: "#334155", lineHeight: 1.6 }}>
      <div style={{ fontWeight: 700, fontSize: 15, color: "#0f172a", marginBottom: 8 }}>
        Архивы догружены
      </div>
      <div>
        Создано объектов: {result.nodes_created} · связей: {result.edges_created}
        {result.nodes_filled > 0 && ` · дополнено объектов: ${result.nodes_filled}`}
      </div>
      <div>
        Схем логики: {result.docs_created}
        {result.docs_replaced > 0 && ` · заменено: ${result.docs_replaced}`}
        {" · спек: "}{result.specs_applied}
      </div>
      {result.db && <div>Таблиц БД: {result.db.tables_written}</div>}
      {result.channels && <div>Каналов брокеров: {result.channels.channels_written}</div>}
      {result.channel_stubs > 0 && (
        <div>Каналов брокеров заведено по связям схемы: {result.channel_stubs} (без описания)</div>
      )}
      {result.config && (
        <div>
          Параметров конфигурации: {result.config.params_written}
          {result.params_replaced > 0 && ` · заменено: ${result.params_replaced}`}
        </div>
      )}
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
        <div>Разрешено споров содержимого: {result.resolved_conflicts}</div>
      )}
      {/* Сырого списка «Замечания» нет (Ф2г-2): информация о сделанном видна по
          счётчикам выше, а то, что требует рук, — пунктами той же свёртки, что в
          превью. Сырые строки (result.warnings) остаются в ответе для MCP. */}
      <UnfixableFold items={result.unfixable} after />
    </div>
  );
}

// Строка перечня внутри серой сводки: отступом влево показывает подчинённость.
const subRow: CSSProperties = { marginLeft: 10 };
// Подпись архива в чипе: та же типографика, что у кнопки-чипа соседних окон,
// но без интерактивных свойств.
const chipName: CSSProperties = {
  ...chipBtn, cursor: "default", display: "inline-block", maxWidth: 200,
};
