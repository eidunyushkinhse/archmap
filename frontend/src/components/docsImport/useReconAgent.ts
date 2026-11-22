// Состояние окна «Составить список операций с помощью ИИ-агента»: файлы перечня, живое
// превью с отсрочкой, разделы отчёта по действию, замечания для агента, вопрос об
// устаревших файлах и применение с отказом. Вынесено из окна при переводе на новый язык
// (редизайн, фаза 6г): окно — ReconAgentModal, отчёт — ReconAgentPlan.
//
// Политики перезаписи у потока нет вовсе: применение только создаёт заглушки.
import { useEffect, useMemo, useRef, useState } from "react";
import type { DocsFile, ReconAction, ReconImportReport, ReconItem } from "../../types";
import { reconApi } from "../../api/docsImport";
import { useDocsFiles } from "./useDocsFiles";
import type { DocsFilesApi } from "./useDocsFiles";
import { applyRefusal, inputFingerprint, useRepeatedInput } from "./agentModalShared";
import { copyTextOrShow } from "../../lib/copyText";
import { useToast } from "../../pages/useToast";

// Разделы превью — в порядке «что сделаем → что уже есть → расхождение». Подписи
// русские и говорят действием, а не кодом: человек читает их, а не Literal бэка.
const GROUPS: { action: ReconAction; title: string; note?: string }[] = [
  { action: "create", title: "Создадим неописанные схемы" },
  { action: "unchanged", title: "Неописанные схемы уже есть" },
  {
    action: "described",
    title: "Уже описаны, их не тронем",
    note: "Повторный сбор списка не затирает работу: описанная схема остаётся как есть.",
  },
  {
    action: "vanished",
    title: "Есть в документации, но не найдено в коде",
    note: "ArchMap ничего не удаляет. Если схема больше не нужна, удалите её сами.",
  },
];

/** Раздел отчёта: действие, подпись, примечание и строки. */
export interface ReconGroupRows {
  action: ReconAction;
  title: string;
  note?: string;
  items: ReconItem[];
}

export interface ReconAgent {
  pkg: DocsFilesApi;
  report: ReconImportReport | null;
  checking: boolean;
  repeatedInput: boolean;
  /** Непустые разделы отчёта в порядке GROUPS. */
  groups: ReconGroupRows[];
  /** Строк перечня («исчезнувшие» пришли не из файла, а из документации объекта). */
  listedCount: number;
  createCount: number;
  remarks: string[];
  copyRemarks: () => void;
  remarksCopied: boolean;
  askStale: boolean;
  keepStale: () => void;
  clearPackage: () => void;
  removeFile: (i: number) => void;
  apply: () => void;
  applying: boolean;
  applyError: string | null;
  willWrite: boolean;
}

export function useReconAgent(
  // Объект, из окна которого открыт список: к нему уедет перечень без строки node.
  nodeId: string,
  // Заглушки созданы: родитель перечитывает объект и закрывает окно.
  onApplied: () => void,
): ReconAgent {
  const pkg = useDocsFiles();
  const [rawReport, setRawReport] = useState<ReconImportReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [remarksCopied, flashRemarksCopied] = useToast(2000);
  const seqRef = useRef(0);

  // Пустые файлы прячут отчёт ПРОИЗВОДНО — эффект не зеркалит состояние в состояние.
  const report = pkg.hasContent ? rawReport : null;

  // Гвард «вход не изменился»: тот же байт-в-байт файл, что в прошлый заход. Это повод
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

  const remarks = report === null ? [] : [...report.errors, ...report.warnings];

  // «Чини, а не удаляй» — тот же урок, что у соседних дозаливок: на голое «исправь»
  // слабая модель отвечает ампутацией, вырезая строки, на которые жалуется валидатор.
  function copyRemarks() {
    const text =
      "ArchMap проверил список операций и нашёл замечания. " +
      "Исправь файл и сообщи, что изменилось. Строки чини по замечаниям, " +
      "а не удаляй из списка:\n" +
      remarks.map((r) => `- ${r}`).join("\n");
    void copyTextOrShow(text).then(() => {
      flashRemarksCopied();
      // Замечания ушли агенту — вернётся исправленная версия, и лежащий в окне файл
      // устареет. Спрашиваем сразу, пока пользователь здесь.
      setAskedFor(pkg.files);
    });
  }

  // Убрать файлы из окна: вход и отчёт уходят целиком — новый заход сравнивать не с чем.
  function clearPackage() {
    setAskedFor(null);
    pkg.reset();
    setRawReport(null);
  }

  // Убрали последний файл — отчёт прошлого списка не должен вернуться при первой вставке.
  function removeFile(i: number) {
    if (pkg.files.length === 1) setRawReport(null);
    pkg.removeFile(i);
  }

  function apply() {
    setApplying(true);
    setApplyError(null);
    reconApi.apply({ files: pkg.nonEmpty, nodeId })
      .then((r) => {
        setRawReport(r);
        if (r.applied) onApplied();
      })
      // Отказ сервера виден строкой над кнопками; окно остаётся открытым с тем же списком.
      .catch((e: unknown) => setApplyError(applyRefusal(e)))
      .finally(() => setApplying(false));
  }

  // Разделы и числа — производные отчёта (в рендере, не эффектом). Пустые разделы не
  // показываем вовсе.
  const groups = useMemo(() => {
    const items = report?.items ?? [];
    return GROUPS
      .map((g) => ({ ...g, items: items.filter((it) => it.action === g.action) }))
      .filter((g) => g.items.length > 0);
  }, [report]);
  const createCount = report?.items.filter((it) => it.action === "create").length ?? 0;
  const listedCount = report?.items.filter((it) => it.action !== "vanished").length ?? 0;
  const willWrite = report !== null && report.errors.length === 0 && createCount > 0;

  return {
    pkg, report, checking, repeatedInput, groups, listedCount, createCount, remarks,
    copyRemarks, remarksCopied, askStale: askedFor === pkg.files, keepStale: () => setAskedFor(null),
    clearPackage, removeFile, apply, applying, applyError, willWrite,
  };
}
