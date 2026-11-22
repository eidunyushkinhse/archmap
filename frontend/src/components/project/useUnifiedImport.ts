// Ввоз файлов окна «Новый проект» (режимы «Импорт» и «ИИ-агент»): входы, живая сводка
// dry-run по ним, разбор остатка слияния и применение. Окно только рисует.
//
// Ввоз идёт мультипартом /import-unified, а не через POST /projects. Отсюда второй шаг
// «Открыть проект»: отчёт применения (счётчики, замечания) показывается ДО перехода в
// проект. Замечания ввоза — видимая деградация, молча провалиться в проект значило бы их
// спрятать.
import { useEffect, useMemo, useState } from "react";
import type {
  ArchiveImportResult, DemoExcess, UnifiedFamilyCountsOut, UnifiedPreviewOut,
} from "../../types";
import { projectsApi } from "../../api/projects";
import { firstTooBig, textBytes } from "../demo/demoLimits";
import type { TooBig } from "../demo/demoLimits";
import { toDecisions, useRemainderAnswers } from "./remainder";
import type { Answer } from "./remainder";
import type { RemainderInputs } from "./ImportPane";
import { useImportInputs } from "./useImportInputs";
import type { ImportInputsApi } from "./useImportInputs";

export interface UnifiedImport {
  inputs: ImportInputsApi;
  /** Сводка по ТЕКУЩИМ входам; null — входов нет, сводка грузится или устарела. */
  fresh: UnifiedPreviewOut | null;
  /** Демо-стенд: вход больше предела файла (превью не запрашивается). */
  tooBig: TooBig | null;
  /** Демо-стенд: проект из этих входов не поместится в пределы (считает сервер). */
  excess: DemoExcess | null;
  /** Единственный вход и он архив: имя и описание приедут из манифеста (П3). */
  fromManifest: boolean;
  remainder: RemainderInputs;
  /** Зелёная сводка: можно создавать (имя проверяет окно). */
  ready: boolean;
  /** Отчёт применения; после него кнопка окна — «Открыть проект». */
  result: ArchiveImportResult | null;
  apply: (name: string, description: string) => Promise<void>;
}

export function useUnifiedImport(active: boolean): UnifiedImport {
  const inputs = useImportInputs();
  const { docs, archives, files } = inputs;
  // Сводка привязана к входам, для которых получена: устаревший ответ не показываем и не
  // засчитываем в готовность кнопки.
  const [preview, setPreview] = useState<{ forFiles: File[]; res: UnifiedPreviewOut } | null>(null);
  const [result, setResult] = useState<ArchiveImportResult | null>(null);

  // Демо-стенд (docs/tasks/demo-mode.md): вход больше предела файла — превью не
  // запрашиваем (сервер ответил бы 413), показываем отказ и гасим «Создать проект».
  // Вставленный текстом вход подписан номером, как в списке окна.
  const tooBig = useMemo(() => {
    const texts = docs.filter((d) => d.text.trim());
    return firstTooBig([
      ...texts.map((d, i) => ({ name: d.name ?? `Файл ${i + 1}`, size: textBytes(d.text) })),
      ...archives.map((f) => ({ name: f.name, size: f.size })),
    ]);
  }, [docs, archives]);

  // Живая сводка ввоза: дебаунс 500мс → dry-run всех входов; устаревшие ответы
  // отбрасываются (alive-флаг в cleanup). Без входов сводка не запрашивается — она скрыта
  // по несовпадению ссылок, синхронного сброса стейта в эффекте нет.
  useEffect(() => {
    if (!active || files.length === 0 || tooBig) return;
    let alive = true;
    const t = setTimeout(() => {
      projectsApi.unifiedPreview(files).then(
        (res) => { if (alive) setPreview({ forFiles: files, res }); },
        (e: unknown) => {
          if (!alive) return;
          const msg = e instanceof Error ? e.message : "Не удалось проверить файлы";
          setPreview({ forFiles: files, res: failedPreview(msg, files.length) });
        },
      );
    }, 500);
    return () => { alive = false; clearTimeout(t); };
  }, [files, active, tooBig]);

  const fresh = preview && preview.forFiles === files && files.length > 0 && !tooBig ? preview.res : null;
  const excess = fresh?.demo_excess ?? null;
  const fromManifest = fresh?.name_source === "manifest";
  // Разбор остатка (Ф-E): решения по спорам содержимого и ответы на остальные вопросы.
  // Переживают перезапрос превью: правка YAML не стирает выбор по архивным спорам, id
  // вопроса детерминирован между превью и применением.
  const { questions, answers, setAnswers, resolutions, setResolutions } = useRemainderAnswers(fresh);
  // Бандл разбора собирается одним мемо: панель не перерисовывается на каждый чужой рендер.
  const remainder = useMemo((): RemainderInputs => ({
    questions,
    answers,
    onAnswer: (id: string, answer: Answer) => setAnswers((cur) => ({ ...cur, [id]: answer })),
    resolutions,
    onResolve: (id: string, choice: string) => setResolutions((cur) => ({ ...cur, [id]: choice })),
    unfixable: fresh?.remainder.unfixable ?? [],
  }), [questions, answers, setAnswers, resolutions, setResolutions, fresh]);

  async function apply(name: string, description: string) {
    setResult(await projectsApi.importUnified(files, {
      // «Копия одного архива»: полей нет, и обещание «имя из архива» должно держаться —
      // набранное раньше в другом составе входов не подсовываем.
      name: fromManifest ? undefined : name,
      description: fromManifest ? undefined : description || undefined,
      resolutions,
      // Ответы разбора: «как сейчас» и молчание в форму не едут — результат у них тот же,
      // что сегодня (toDecisions вернёт null).
      decisions: toDecisions(questions, answers),
    }));
  }

  return {
    inputs, fresh, tooBig, excess, fromManifest, remainder,
    ready: fresh?.ok === true && excess === null,
    result, apply,
  };
}

// Нулевые счётчики семей для отказа превью: считать нечего, но форма ответа обязана быть
// полной — панель читает её без проверок на undefined.
const NO_FAMILIES: UnifiedFamilyCountsOut = {
  docs: 0, specs: 0, tables: 0, channels: 0, params: 0, processes: 0, sites: 0,
};

// Отказ самой проверки — беда всего пакета, а не чьего-то входа: в панели он показывается
// строкой статуса без файла-виновника.
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
      node_elements: [],
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
