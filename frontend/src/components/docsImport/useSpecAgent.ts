// Состояние стадии «Через ИИ-агента» окна спецификации OpenAPI (DocOverlay → OpenApiPane →
// inspector/DocAgentStage): файлы пакета, живое превью с отсрочкой, замечания для агента,
// вопрос об устаревших файлах и применение. Перенесено из прежней панели SpecAgentPanel без
// изменения поведения (редизайн, фаза 7в), по образцу useFactAgent; новое одно: отказ
// сервера на применении виден строкой над кнопками (раньше отказ не обрабатывался вовсе).
//
// Спецификация у объекта одна — без режимов «пакетом/по одной» и «Добавить ещё». Политика
// перезаписи всегда «перезаписывать»: окно открывают, чтобы получить новую спецификацию.
// Применение НЕ кладётся в undo — страховка: превью до записи.
import { useEffect, useMemo, useRef, useState } from "react";
import type { DocsFile, DocsImportReport } from "../../types";
import { docsImportApi } from "../../api/docsImport";
import { useDocsFiles } from "./useDocsFiles";
import type { DocsFilesApi } from "./useDocsFiles";
import { applyRefusal, countAction, inputFingerprint, useRepeatedInput } from "./agentModalShared";
import { copyTextOrShow } from "../../lib/copyText";
import { useToast } from "../../pages/useToast";

export interface SpecAgent {
  pkg: DocsFilesApi;
  /** Отчёт последнего превью или применения; без непустых файлов — null. */
  report: DocsImportReport | null;
  /** Превью в пути. */
  checking: boolean;
  /** Вход тот же, что в прошлый заход. */
  repeatedInput: boolean;
  /** Замечания для агента: ошибки, конфликты и предупреждения превью. */
  remarks: string[];
  copyRemarks: () => void;
  remarksCopied: boolean;
  /** Замечания ушли агенту: спросить, оставить ли файлы в окне. */
  askStale: boolean;
  keepStale: () => void;
  clearPackage: () => void;
  apply: () => void;
  applying: boolean;
  /** Отказ последнего применения (окно остаётся открытым); null — отказа не было. */
  applyError: string | null;
  /** Применение что-то запишет: кнопка «Применить» включена. */
  willWrite: boolean;
}

export function useSpecAgent(
  // Узел, для которого агент готовит спецификацию (скоуп превью и применения).
  nodeId: string,
  // Спецификация записана: окно перечитывает её и возвращается к чтению.
  onApplied: () => void,
): SpecAgent {
  const pkg = useDocsFiles();
  // Отчёт последнего превью/применения. Пустые файлы прячут его ПРОИЗВОДНО
  // (pkg.hasContent) — эффекты не зеркалят состояние синхронными setState.
  const [rawReport, setRawReport] = useState<DocsImportReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [remarksCopied, flashRemarksCopied] = useToast(2000);
  const seqRef = useRef(0);

  const report = pkg.hasContent ? rawReport : null;

  // Гвард «вход не изменился»: тот же байт-в-байт пакет, что в прошлый заход. Это повод
  // посмотреть на файлы агента, а не на замечание (находка полевой приёмки).
  const fingerprint = useMemo(() => inputFingerprint(pkg.files), [pkg.files]);
  const repeatedInput = useRepeatedInput(pkg.files, fingerprint);
  // Пакет, к которому задан вопрос об устаревании (после копирования замечаний).
  // Сравнение по ссылке: тронули файлы — вопрос снят сам, без эффекта.
  const [askedFor, setAskedFor] = useState<DocsFile[] | null>(null);

  // Дебаунс-превью по файлам; план фильтруется по спецификациям (only="api").
  // Все setState — в таймере/ответе (асинхронно); seq отбрасывает устаревшие
  // ответы при быстрой правке.
  useEffect(() => {
    const nonEmpty = pkg.files.filter((f) => f.content.trim() !== "");
    if (nonEmpty.length === 0) return; // отчёт скрыт производно (hasContent)
    const seq = ++seqRef.current;
    const t = window.setTimeout(() => {
      setChecking(true);
      docsImportApi.preview({ files: nonEmpty, overwrite: true, only: "api", nodeId })
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

  // Замечания для агента: ошибки/конфликты/предупреждения по спецификации.
  const remarks = report === null ? [] : [...report.errors, ...report.conflicts, ...report.warnings];

  function copyRemarks() {
    const text =
      "ArchMap проверил файлы archmap-docs и нашёл замечания. " +
      "Исправь пакет и сообщи, какие файлы изменились:\n" +
      remarks.map((r) => `- ${r}`).join("\n");
    void copyTextOrShow(text).then(() => {
      flashRemarksCopied();
      // Замечания ушли агенту — значит вернётся исправленная версия, и лежащий в
      // окне пакет устареет. Спрашиваем сразу, пока пользователь здесь.
      setAskedFor(pkg.files);
    });
  }

  // Убрать пакет из окна: файлы и отчёт уходят целиком (зеркало снятия
  // последнего файла крестиком) — новый заход сравнивать будет не с чем.
  function clearPackage() {
    setAskedFor(null);
    pkg.reset();
    setRawReport(null);
  }

  function apply() {
    setApplying(true);
    setApplyError(null);
    // Применяются только OpenAPI-спецификации (only="api")
    docsImportApi.apply({ files: pkg.nonEmpty, overwrite: true, only: "api", nodeId })
      .then((r) => {
        setRawReport(r);
        if (r.applied) onApplied();
      })
      // Отказ сервера виден строкой над кнопками; окно остаётся открытым с тем же пакетом.
      .catch((e: unknown) => setApplyError(applyRefusal(e)))
      .finally(() => setApplying(false));
  }

  const willWrite =
    report !== null &&
    report.errors.length === 0 &&
    countAction(report.specs, "create") + countAction(report.specs, "overwrite") > 0;

  return {
    pkg, report, checking, repeatedInput, remarks, copyRemarks, remarksCopied,
    askStale: askedFor === pkg.files, keepStale: () => setAskedFor(null), clearPackage,
    apply, applying, applyError, willWrite,
  };
}
