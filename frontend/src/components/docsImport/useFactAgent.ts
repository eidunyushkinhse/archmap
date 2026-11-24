// Состояние окон фактов от агента (структура базы, каналы брокера, конфигурация): файлы
// пакета, живое превью с отсрочкой, галочка «Заменять уже описанное», замечания для агента,
// вопрос об устаревших файлах и применение с отказом. Машинерия одна на три семьи (аудит
// F-9): у семьи свой контракт и свои слова (FactAgentKind), окно — FactAgentModal, отчёт —
// FactAgentPlan. Вынесено из окна при переводе на новый язык (редизайн, фаза 6г).
//
// Применение НЕ кладётся в undo — страховка: превью + дефолт «не перезаписывать».
import { useEffect, useMemo, useRef, useState } from "react";
import type { DocsFile, PromptVariant } from "../../types";
import type { DataImportParams } from "../../api/docsImport";
import { useDocsFiles } from "./useDocsFiles";
import type { DocsFilesApi } from "./useDocsFiles";
import { applyRefusal, inputFingerprint, useRepeatedInput } from "./agentModalShared";
import { copyTextOrShow } from "../../lib/copyText";
import { useToast } from "../../pages/useToast";

/** Отчёт превью и применения любой табличной семьи — общая часть. */
export interface FactReport {
  errors: string[];
  warnings: string[];
  applied: boolean;
}

/** Ручки семьи: задание, превью, применение. */
export interface FactApi<R extends FactReport> {
  prompt: (variant?: PromptVariant) => Promise<{ prompt: string }>;
  preview: (p: DataImportParams) => Promise<R>;
  apply: (p: DataImportParams) => Promise<R>;
}

export interface FactAgent<R extends FactReport> {
  pkg: DocsFilesApi;
  overwrite: boolean;
  setOverwrite: (on: boolean) => void;
  /** Отчёт последнего превью или применения; без непустых файлов — null. */
  report: R | null;
  checking: boolean;
  repeatedInput: boolean;
  /** Замечания для агента: ошибки и предупреждения превью. */
  remarks: string[];
  copyRemarks: () => void;
  remarksCopied: boolean;
  /** Замечания ушли агенту: спросить, оставить ли файлы в окне. */
  askStale: boolean;
  keepStale: () => void;
  clearPackage: () => void;
  removeFile: (i: number) => void;
  apply: () => void;
  applying: boolean;
  /** Отказ последнего применения (окно остаётся открытым); null — отказа не было. */
  applyError: string | null;
  /** Применение что-то запишет: кнопка «Применить» включена. */
  willWrite: boolean;
}

export function useFactAgent<R extends FactReport>({ api, nodeId, count, remarksFamily, remarksItems, onApplied }: {
  api: FactApi<R>;
  // Объект, из окна которого открыта дозаливка: к нему уезжают записи без адреса.
  nodeId: string;
  // Записи пакета: по ним «есть что применить».
  count: (r: R) => number;
  // «ArchMap проверил файлы {remarksFamily}…» и «{remarksItems} чини по замечаниям…».
  remarksFamily: string;
  remarksItems: string;
  // Пакет применён: родитель перечитывает факты объекта и закрывает окно.
  onApplied: () => void;
}): FactAgent<R> {
  const pkg = useDocsFiles();
  const [rawReport, setRawReport] = useState<R | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [remarksCopied, flashRemarksCopied] = useToast(2000);
  const seqRef = useRef(0);

  // Пустые файлы прячут отчёт ПРОИЗВОДНО — эффект не зеркалит состояние в состояние.
  const report = pkg.hasContent ? rawReport : null;

  // Гвард «вход не изменился»: тот же байт-в-байт пакет, что в прошлый заход. Это повод
  // посмотреть на файлы агента, а не на замечание (находка полевой приёмки).
  const fingerprint = useMemo(() => inputFingerprint(pkg.files), [pkg.files]);
  const repeatedInput = useRepeatedInput(pkg.files, fingerprint);
  // Пакет, к которому задан вопрос об устаревании (после копирования замечаний).
  // Сравнение по ссылке: тронули файлы — вопрос снят сам, без эффекта.
  const [askedFor, setAskedFor] = useState<DocsFile[] | null>(null);

  useEffect(() => {
    const nonEmpty = pkg.files.filter((f) => f.content.trim() !== "");
    if (nonEmpty.length === 0) return;
    const seq = ++seqRef.current;
    const t = window.setTimeout(() => {
      setChecking(true);
      api.preview({ files: nonEmpty, overwrite, nodeId })
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
  }, [pkg.files, overwrite, nodeId, api]);

  const remarks = report === null ? [] : [...report.errors, ...report.warnings];

  // «Чини, а не удаляй» — тот же урок, что у импорта и доков (полевой QA,
  // docs/qa-sentry-brokers.md находка №2): на голое «исправь» слабая модель отвечает
  // ампутацией — вырезает записи вместо того, чтобы искать верное имя.
  function copyRemarks() {
    const text =
      `ArchMap проверил файлы ${remarksFamily} и нашёл замечания. ` +
      `Исправь файлы и сообщи, какие изменились. ${remarksItems} чини по замечаниям, ` +
      "а не удаляй из пакета:\n" +
      remarks.map((r) => `- ${r}`).join("\n");
    void copyTextOrShow(text).then(() => {
      flashRemarksCopied();
      // Замечания ушли агенту — значит вернётся исправленная версия, и лежащий в
      // окне пакет устареет. Спрашиваем сразу, пока пользователь здесь.
      setAskedFor(pkg.files);
    });
  }

  // Убрать пакет из окна: файлы и отчёт уходят целиком (зеркало снятия последнего файла
  // крестиком) — новый заход сравнивать будет не с чем.
  function clearPackage() {
    setAskedFor(null);
    pkg.reset();
    setRawReport(null);
  }

  // Убрали последний файл — пакета больше нет, и отчёт прошлого пакета не должен вернуться
  // при первой же вставке (он лишь скрыт производно).
  function removeFile(i: number) {
    if (pkg.files.length === 1) setRawReport(null);
    pkg.removeFile(i);
  }

  function apply() {
    setApplying(true);
    setApplyError(null);
    api.apply({ files: pkg.nonEmpty, overwrite, nodeId })
      .then((r) => {
        setRawReport(r);
        if (r.applied) onApplied();
      })
      // Отказ сервера виден строкой над кнопками; окно остаётся открытым с тем же пакетом.
      .catch((e: unknown) => setApplyError(applyRefusal(e)))
      .finally(() => setApplying(false));
  }

  const willWrite = report !== null && report.errors.length === 0 && count(report) > 0;

  return {
    pkg, overwrite, setOverwrite, report, checking, repeatedInput, remarks, copyRemarks,
    remarksCopied, askStale: askedFor === pkg.files, keepStale: () => setAskedFor(null),
    clearPackage, removeFile, apply, applying, applyError, willWrite,
  };
}
