// Состояние ввоза окна «Обновить из кода» (docsImport/SyncRepoModal): файлы ответов
// агента, галочки «что обновлять», план с бэка и применение. Окно только рисует.
//
// Ничего не записывается, пока пользователь не нажмёт «Применить», и применение
// отправляет курсор схемы из превью: если схема успела измениться, бэк ответит 409, а не
// применит вслепую не то, что человек видел (docs/plan-arch-sync.md, Фаза 3).
import { useEffect, useMemo, useRef, useState } from "react";
import type { DemoExcess, SyncApplyOut, SyncPolicies, SyncPreviewOut } from "../../types";
import { projectsApi } from "../../api/projects";
import { ApiError, isDemoLimit } from "../../api/client";
import { useDocsFiles, MAX_FILES } from "./useDocsFiles";
import type { DocsFilesApi } from "./useDocsFiles";
import { useFileDrop } from "./useFileDrop";
import type { FileDropApi } from "./useFileDrop";
import { applySummary } from "./syncPlanView";
import { firstTooBig, textBytes } from "../demo/demoLimits";
import type { TooBig } from "../demo/demoLimits";

/** Принимаемые расширения: одни и те же у перетаскивания и у выбора с диска. */
export const SYNC_ACCEPT = [".yaml", ".yml", ".txt"];

const NO_POLICIES: SyncPolicies = {
  update_descriptions: false,
  update_names: false,
  sync_components: false,
  mark_missing_deprecated: false,
  restore_returned: false,
};

export interface SyncImport {
  pkg: DocsFilesApi;
  drop: FileDropApi;
  policies: SyncPolicies;
  setPolicy: (key: keyof SyncPolicies, on: boolean) => void;
  /** План текущих файлов; null — файлов нет, план не посчитан или не получен. */
  preview: SyncPreviewOut | null;
  checking: boolean;
  /** Демо-стенд: файл больше предела (не отправляется, план не считается). */
  tooBig: TooBig | null;
  /** Демо-стенд: после обновления проект выйдет за предел (считает сервер). */
  excess: DemoExcess | null;
  applying: boolean;
  applyError: string | null;
  canApply: boolean;
  /** Записать план; done — итог для тоста, после него окно закрывается. */
  apply: (done: (message: string) => void) => void;
}

export function useSyncImport(projectId: string): SyncImport {
  const pkg = useDocsFiles();
  const [policies, setPolicies] = useState<SyncPolicies>(NO_POLICIES);
  const [rawPreview, setRawPreview] = useState<SyncPreviewOut | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const seqRef = useRef(0);
  // Перетаскивание на всё окно: тот же список расширений, что у выбора файлов.
  const drop = useFileDrop({
    accept: SYNC_ACCEPT,
    onFiles: pkg.pickFiles,
    disabled: pkg.files.length >= MAX_FILES,
  });

  // Демо-стенд (docs/tasks/demo-mode.md): файл больше предела не отправляем — сервер
  // ответил бы 413; отказ видно сразу, план не считается.
  const tooBig = useMemo(
    () => firstTooBig(
      pkg.files.filter((f) => f.content.trim() !== "")
        .map((f) => ({ name: f.name, size: textBytes(f.content) })),
    ),
    [pkg.files],
  );

  // Файлы убрали — план прячем ПРОИЗВОДНО, без зеркалящего эффекта.
  const preview = pkg.hasContent && !tooBig ? rawPreview : null;
  const excess = preview?.ok ? (preview.demo_excess ?? null) : null;

  // Дебаунс-превью по файлам и галочкам: план пересчитывается на бэке, здесь только
  // показ. seq отбрасывает устаревшие ответы при быстрой правке.
  useEffect(() => {
    const nonEmpty = pkg.files.filter((f) => f.content.trim() !== "");
    if (nonEmpty.length === 0 || tooBig) return;
    const seq = ++seqRef.current;
    // Все setState — асинхронно, внутри таймера/ответа (react-hooks/set-state-in-effect).
    // Побочно полезно: индикатор не мигает на каждом нажатии клавиши в поле вставки.
    const t = window.setTimeout(() => {
      setChecking(true);
      projectsApi
        .syncPreview(projectId, nonEmpty.map((f) => f.content), policies)
        .then((res) => {
          if (seq === seqRef.current) setRawPreview(res);
        })
        .catch(() => {
          if (seq === seqRef.current) setRawPreview(null);
        })
        .finally(() => {
          if (seq === seqRef.current) setChecking(false);
        });
    }, 400);
    return () => window.clearTimeout(t);
  }, [pkg.files, policies, projectId, tooBig]);

  const apply = (done: (message: string) => void) => {
    if (!preview?.ok || preview.is_noop) return;
    setApplying(true);
    setApplyError(null);
    projectsApi
      .syncApply(projectId, pkg.nonEmpty.map((f) => f.content), policies, preview.graph_rev)
      .then((r: SyncApplyOut) => done(applySummary(r)))
      .catch((e: unknown) => {
        setApplyError(
          // Отказ по пределу демо-стенда — тоже 409, но не устаревший план.
          isDemoLimit(e)
            ? `Не сохранилось. ${e.message}`
            : e instanceof ApiError && e.status === 409
            ? "Схему изменили в другом окне или другим пользователем, и список ниже устарел. Закройте это окно и откройте снова."
            : "Не удалось сохранить изменения. Проверьте соединение и повторите.",
        );
      })
      .finally(() => setApplying(false));
  };

  return {
    pkg,
    drop,
    policies,
    setPolicy: (key, on) => setPolicies((s) => ({ ...s, [key]: on })),
    preview,
    checking,
    tooBig,
    excess,
    applying,
    applyError,
    canApply: !!preview?.ok && !preview.is_noop && !applying && !checking && excess === null,
    apply,
  };
}
