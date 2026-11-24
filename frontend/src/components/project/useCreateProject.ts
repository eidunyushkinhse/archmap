// Состояние окна «Новый проект»: название и описание (общие для всех режимов), режим,
// образец копии, параметры задания агенту, создание. Ввоз файлов — useUnifiedImport.
// Окно (CreateProjectDialog) и режимы только рисуют.
import { useState } from "react";
import type { Project, PromptVariant } from "../../types";
import { projectsApi } from "../../api/projects";
import { CopyFailed, copyText } from "../../lib/copyText";
import { useUnifiedImport } from "./useUnifiedImport";
import type { UnifiedImport } from "./useUnifiedImport";

// "repo" — «ИИ-агент»: задание для ИИ-агента пользователя + ТОТ ЖЕ ввоз, что у «Импорта»
// (режим отдельный — витрина BYOA, решение груминга; ввоз внутри один).
export type StartMode = "blank" | "copy" | "import" | "repo";
export type Lang = "ru" | "en";

/** Задание без названия не копируется: имя системы вшито в его текст. */
class NameMissing extends Error {}

export interface CreateProject {
  name: string;
  setName: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  mode: StartMode;
  setMode: (m: StartMode) => void;
  importish: boolean;
  sourceId: string | null;
  setSourceId: (id: string) => void;
  lang: Lang;
  setLang: (l: Lang) => void;
  hints: string;
  setHints: (v: string) => void;
  promptBusy: boolean;
  /** Нажали «Скопировать задание» без названия: под названием строка-просьба. */
  nameMissing: boolean;
  copyPrompt: (variant: PromptVariant) => Promise<void>;
  imp: UnifiedImport;
  busy: boolean;
  error: string | null;
  canSubmit: boolean;
  submit: () => Promise<void>;
}

export function useCreateProject(
  projects: Project[], onCreated: (id: string) => void, focusName: () => void,
): CreateProject {
  const [name, setNameRaw] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<StartMode>("blank");
  const [sourceId, setSourceId] = useState<string | null>(projects[0]?.id ?? null);
  const [lang, setLang] = useState<Lang>("ru");
  const [hints, setHints] = useState("");
  const [promptBusy, setPromptBusy] = useState(false);
  const [nameMissing, setNameMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const importish = mode === "import" || mode === "repo";
  const imp = useUnifiedImport(importish);

  const setName = (v: string) => {
    setNameRaw(v);
    if (v.trim()) setNameMissing(false);
  };

  const canSubmit = importish
    // Ввоз: после применения кнопка становится «Открыть проект»; до него нужна зелёная
    // сводка и имя — кроме «копии одного архива», где имя из манифеста.
    ? !busy && (imp.result !== null || (imp.ready && (imp.fromManifest || name.trim().length > 0)))
    : name.trim().length > 0 && !busy && !(mode === "copy" && !sourceId);

  // Задание собирает бэкенд (истина формата — рядом с валидатором импорта); копирование
  // после fetch — в пределах жеста, Chrome это допускает. Имя системы вшито в задание,
  // поэтому без названия кнопка ничего не копирует: ставит фокус в поле названия и
  // просит его строкой под ним. «Скопировано» показывает PromptCopyButton по разрешению
  // обещания — отказ пробрасываем, чтобы его не показал.
  function copyPrompt(variant: PromptVariant): Promise<void> {
    if (!name.trim()) {
      setNameMissing(true);
      focusName();
      return Promise.reject(new NameMissing());
    }
    setPromptBusy(true);
    return copyText(projectsApi
      .importPrompt({
        systemName: name.trim(),
        // Глубина у агента всегда просится одна — два слоя (решение пользователя
        // 2026-08-16): выбора в интерфейсе нет.
        depth: 2,
        lang,
        hints: hints.trim() || undefined,
        variant,
        // Адрес ArchMap для агента: по нему он скачает сборщик фактов первым шагом.
        origin: window.location.origin,
      })
      .then((res) => res.prompt))
      .catch((e: unknown) => {
        // CopyFailed (буфер недоступен) — кнопка сама покажет текст для ручного
        // копирования; ошибкой окна показываем только отказ запроса задания.
        if (!(e instanceof CopyFailed)) setError(e instanceof Error ? e.message : "Не удалось скопировать задание");
        throw e;
      })
      .finally(() => setPromptBusy(false));
  }

  async function submit() {
    if (!canSubmit) return;
    if (importish) {
      // Второй клик — уже «Открыть проект»: отчёт показан, переходим.
      if (imp.result) {
        onCreated(imp.result.project_id);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await imp.apply(name.trim(), description.trim());
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Не удалось выполнить импорт");
      }
      setBusy(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await projectsApi.create({
        name: name.trim(),
        description: description.trim() || null,
        start: mode === "copy" ? `copy:${sourceId}` : "blank",
      });
      onCreated(created.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось создать проект");
      setBusy(false);
    }
  }

  return {
    name, setName, description, setDescription, mode, setMode, importish, sourceId, setSourceId,
    lang, setLang, hints, setHints, promptBusy, nameMissing, copyPrompt, imp, busy, error,
    canSubmit, submit,
  };
}
