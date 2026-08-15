// Модалка «Спека от агента» (BYOA-дозаливка) — ТОЛЬКО OpenAPI-спека узла
// (openapi_spec, одна на узел). Схемы логики — отдельное окно DocsAgentModal:
// сущности не смешиваются (include промпта и фильтр превью/применения
// зафиксированы на «api»). Слева параметры промпта (язык/подсказки →
// «Скопировать промпт»; агент найдёт готовую спеку в репозитории, сгенерирует
// из фреймворка или синтезирует по коду), справа файлы пакета archmap-docs
// (manifest.yaml со ссылкой на файл спеки + сам файл), живой dry-run с политикой
// перезаписи и «Применить». Спека одна — без режимов «пакетом/по одной» и
// «Добавить ещё». Применение НЕ кладётся в undo — страховка: превью + дефолт
// «не перезаписывать». Закрытие после успешного применения — отсюда (onClose);
// родитель через onApplied только освежает мету узла.
import { useEffect, useMemo, useRef, useState } from "react";
import type { DocsImportReport, PromptVariant } from "../../types";
import { docsImportApi, type DocsFile } from "../../api/docsImport";
import { useDocsFiles, MAX_FILES } from "./useDocsFiles";
import { useFileDrop } from "./useFileDrop";
import {
  ACTION_LABEL, countAction, inputFingerprint, useRepeatedInput,
  head, sub, cols, leftCol, rightCol, radioRow, hintsArea,
  chipsRow, chipOn, chip, chipBtn, chipX, fileArea, dropHint, grayLine, footRow,
} from "./agentModalShared";
import { ItemList, NoteList, StaleFilesConfirm, UnchangedInputNote } from "./agentModalReport";
import PromptTriple from "./PromptTriple";
import Modal from "../../ui/Modal";
import { CloseIcon } from "../../ui/icons";
import { labelStyle, primaryBtn, secondaryBtn } from "../../ui/styles";

interface Props {
  // Узел, для которого агент готовит спеку (скоуп промпта и применения).
  nodeId: string;
  nodeName: string;
  onClose: () => void;
  // Дозаливка применена — родитель освежает мету узла (спека + version).
  onApplied: () => void;
}

export default function SpecAgentModal({ nodeId, nodeName, onClose, onApplied }: Props) {
  // ── параметры промпта (include зафиксирован на API-спеке) ──
  const [lang, setLang] = useState<"ru" | "en">("ru");
  const [hints, setHints] = useState("");
  // ── файлы пакета и превью ──
  const pkg = useDocsFiles();
  // Отчёт последнего превью/применения. Пустые файлы прячут его ПРОИЗВОДНО
  // (pkg.hasContent) — эффекты не зеркалят состояние синхронными setState.
  const [rawReport, setRawReport] = useState<DocsImportReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [remarksCopied, setRemarksCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null); // скрытый input «Загрузить файлы…»
  const seqRef = useRef(0);
  // Перетаскивание в ту же зону, что и кнопка загрузки. Расширения не сужаем:
  // в пакете archmap-docs лежит манифест и файл спеки, состав задаёт агент.
  const drop = useFileDrop({ onFiles: pkg.pickFiles, disabled: pkg.files.length >= MAX_FILES });

  const report = pkg.hasContent ? rawReport : null;

  // Гвард «вход не изменился»: тот же байт-в-байт пакет, что в прошлый заход, —
  // повод посмотреть на файлы агента, а не на замечание (находка полевой приёмки).
  const fingerprint = useMemo(() => inputFingerprint(pkg.files), [pkg.files]);
  const repeatedInput = useRepeatedInput(pkg.files, fingerprint);
  // Пакет, к которому задан вопрос об устаревании (после копирования замечаний).
  // Сравнение по ссылке: тронули файлы — вопрос снят сам, без эффекта.
  const [askedFor, setAskedFor] = useState<DocsFile[] | null>(null);

  // Дебаунс-превью по файлам и тумблеру; план фильтруется по спекам (only="api").
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

  // Запрос промпта + запись в буфер В ПРЕДЕЛАХ ЖЕСТА; «скопировано» по каждому из
  // трёх вариантов показывает PromptTriple по разрешению этого обещания.
  function copyPrompt(variant: PromptVariant): Promise<void> {
    return docsImportApi
      .prompt({ nodeId, include: "api", lang, hints, variant })
      .then(({ prompt }) => navigator.clipboard.writeText(prompt));
  }

  // Замечания для агента: ошибки/конфликты/предупреждения по спеке.
  const remarks = report === null ? [] : [...report.errors, ...report.conflicts, ...report.warnings];

  function copyRemarks() {
    const text =
      "Валидатор дозаливки доков ArchMap нашёл замечания к пакету archmap-docs. " +
      "Исправь пакет и сообщи, какие файлы изменились:\n" +
      remarks.map((r) => `- ${r}`).join("\n");
    void navigator.clipboard.writeText(text).then(() => {
      setRemarksCopied(true);
      setTimeout(() => setRemarksCopied(false), 2000);
      // Замечания ушли агенту — значит вернётся исправленная версия, и лежащий в
      // панели пакет устареет. Спрашиваем сразу, пока пользователь здесь.
      setAskedFor(pkg.files);
    });
  }

  // Убрать пакет из панели: файлы и отчёт уходят целиком (зеркало снятия
  // последнего файла крестиком) — новый заход сравнивать будет не с чем.
  function clearPackage() {
    setAskedFor(null);
    pkg.reset();
    setRawReport(null);
  }

  function apply() {
    setApplying(true);
    // Окно спеки: применяются только OpenAPI-спеки (only="api")
    docsImportApi.apply({ files: pkg.nonEmpty, overwrite: true, only: "api", nodeId })
      .then((r) => {
        setRawReport(r);
        if (!r.applied) return;
        onApplied();
        onClose();
      })
      .finally(() => setApplying(false));
  }

  const willWrite =
    report !== null &&
    report.errors.length === 0 &&
    countAction(report.specs, "create") + countAction(report.specs, "overwrite") > 0;

  return (
    <Modal onClose={onClose} closeButton={false} boxStyle={{ width: 1060, maxWidth: "calc(100vw - 48px)", maxHeight: "92vh", overflowY: "auto" }}>
      <div style={head}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Подготовить OpenAPI-спецификацию с помощью ИИ-агента</h2>
        <button onClick={onClose} className="modal-close" aria-label="Закрыть"><CloseIcon /></button>
      </div>
      <p style={sub}>
        ИИ-агент поможет дополнить документацию объекта «{nodeName}» спецификацией OpenAPI.
        Скопируйте промпт, запустите своим агентом в репозитории сервиса и загрузите сюда
        полученные файлы пакета archmap-docs/.
      </p>

      <div style={cols}>
        {/* ── Слева: параметры промпта ── */}
        <div style={leftCol}>
          <label style={labelStyle}>Язык подписей</label>
          <div style={{ display: "flex", gap: 14, marginBottom: 10 }}>
            <label style={radioRow}>
              <input type="radio" checked={lang === "ru"} onChange={() => setLang("ru")} /> Русский
            </label>
            <label style={radioRow}>
              <input type="radio" checked={lang === "en"} onChange={() => setLang("en")} /> English
            </label>
          </div>

          <label style={labelStyle}>Подсказки агенту (опционально)</label>
          <textarea
            style={hintsArea}
            value={hints}
            onChange={(e) => setHints(e.target.value)}
            placeholder={"Например: спеку возьми из swagger.yaml;\nесли её нет — синтезируй по хендлерам."}
          />

          <PromptTriple
            label="Скопировать промпт"
            copiedLabel="Скопировано ✓"
            kind="primary"
            buttonStyle={{ marginTop: 4 }}
            copy={copyPrompt}
          />
        </div>

        {/* ── Справа: файлы пакета + превью + применение ── */}
        <div style={rightCol}>
          <div style={chipsRow}>
            {pkg.files.map((f, i) => (
              <span key={f.name} style={i === pkg.active ? chipOn : chip}>
                <button type="button" style={chipBtn} title={f.name} onClick={() => pkg.setActive(i)}>
                  {f.name}
                </button>
                <button type="button" style={chipX} title="Убрать файл" onClick={() => pkg.removeFile(i)}>×</button>
              </span>
            ))}
            <input
              ref={fileRef}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(e) => { pkg.pickFiles(e.target.files); e.target.value = ""; }}
            />
            <button
              type="button"
              className="btn-soft"
              disabled={pkg.files.length >= MAX_FILES}
              onClick={() => fileRef.current?.click()}
            >
              Загрузить файлы…
            </button>
            <button
              type="button"
              className="btn-soft"
              disabled={pkg.files.length >= MAX_FILES}
              title="Добавить спеку вставкой текста"
              onClick={pkg.addPaste}
            >
              + вставить из буфера
            </button>
          </div>

          <div className={drop.over ? "drop-zone--over" : undefined} {...drop.bind}>
            {pkg.files.length > 0 ? (
              <textarea
                style={fileArea}
                value={pkg.files[pkg.active]?.content ?? ""}
                onChange={(e) => pkg.setText(pkg.active, e.target.value)}
                placeholder="вставьте содержимое файла"
                spellCheck={false}
              />
            ) : (
              <button type="button" style={dropHint} onClick={() => fileRef.current?.click()}>
                Перетащите сюда файл спеки, который подготовил агент, — или нажмите, чтобы
                выбрать его на диске. Спеку можно и вставить текстом.
              </button>
            )}
          </div>
          {drop.error && (
            <p style={{ ...grayLine, color: "#b45309", marginTop: 6 }}>{drop.error}</p>
          )}

          {/* Отчёт превью / применения */}
          <div style={{ marginTop: 10, minHeight: 20 }}>
            {checking && <div style={grayLine}>Проверяю пакет…</div>}
            {/* Вход тот же, что в прошлый заход, — заметка над сводкой: замечание
                повторится, и чинить надо не его, а разговор с агентом. */}
            {repeatedInput && <UnchangedInputNote />}
            {!checking && report !== null && report.applied && (
              <div style={{ fontSize: 13, fontWeight: 600, color: "#15803d" }}>
                Применено: спек записано {report.specs_written}.
              </div>
            )}
            {!checking && report !== null && !report.applied && report.errors.length === 0 && (
              <div style={{ fontSize: 13, fontWeight: 600, color: willWrite ? "#15803d" : "#475569" }}>
                Спек: {report.specs.length} (новых {countAction(report.specs, "create")},
                перезапись {countAction(report.specs, "overwrite")}, пропуск {countAction(report.specs, "skip")},
                без изменений {countAction(report.specs, "unchanged")})
              </div>
            )}
            {!checking && report !== null && report.errors.length > 0 && (
              <div style={{ fontSize: 12.5, color: "#dc2626" }}>
                <div style={{ fontWeight: 600, marginBottom: 3 }}>Пакет не применить:</div>
                {report.errors.slice(0, 6).map((e, i) => <div key={i} style={{ marginTop: 2 }}>{e}</div>)}
                {report.errors.length > 6 && <div>…ещё {report.errors.length - 6}</div>}
              </div>
            )}

            {!checking && report !== null && report.specs.length > 0 && (
              <ItemList
                title="OpenAPI-спеки:"
                rows={report.specs.map((s) => ({
                  key: `${s.node_path}#spec`,
                  text: `«${s.node_path}» · ${s.source}${s.oas_version ? ` · OAS ${s.oas_version}` : ""}`,
                  badge: `${ACTION_LABEL[s.action] ?? s.action}${s.origin ? ` · ${s.origin}` : ""}`,
                  bad: !s.valid_yaml
                    ? "невалидный YAML"
                    : s.origin === "synthesized"
                      ? "синтезирована из кода — проверьте глазами"
                      : !s.looks_openapi ? "не похожа на OpenAPI" : null,
                  ok: s.valid_yaml && s.looks_openapi && s.origin !== "synthesized",
                }))}
              />
            )}
            {!checking && report !== null && report.conflicts.length > 0 && (
              <NoteList title="Конфликты файлов (оставлен первый источник):" items={report.conflicts} />
            )}
            {!checking && report !== null && report.warnings.length > 0 && (
              <NoteList title="Проверьте:" items={report.warnings} />
            )}
            {!checking && remarks.length > 0 && (
              <button
                type="button"
                style={{ ...secondaryBtn, marginTop: 8, padding: "4px 10px", fontSize: 12.5 }}
                onClick={copyRemarks}
              >
                {remarksCopied ? "Скопировано ✓" : "Скопировать замечания для агента"}
              </button>
            )}
            {askedFor === pkg.files && (
              <StaleFilesConfirm onKeep={() => setAskedFor(null)} onClear={clearPackage} />
            )}
          </div>

          <div style={footRow}>
            <button
              type="button"
              style={{ ...primaryBtn, opacity: willWrite && !applying ? 1 : 0.55 }}
              disabled={!willWrite || applying}
              onClick={apply}
            >
              {applying ? "Применяю…" : "Применить"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
