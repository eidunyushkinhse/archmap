// Модалка «Описать конфигурацию с помощью ИИ-агента» (BYOA-дозаливка параметров).
//
// Пятое окно того же семейства (схемы логики — DocsAgentModal, спека — SpecAgentModal,
// структура БД — DataAgentModal, каналы — ChannelsAgentModal): машинерия общая,
// контракт свой. Два отличия, и оба про честность подзаголовка:
//   • владелец однозначен, в отличие от каналов, — параметр читает КОД СЕРВИСА, и
//     промпт гоняют в репозитории этого сервиса, а не «в каждом, кто ходит»;
//   • ЗНАЧЕНИЯ НЕ ЕДУТ. Об этом пользователь должен узнать ДО запуска агента: он
//     собирается натравить модель на репозиторий с `.env`, и вправе знать, что
//     ArchMap хранит только перечень ручек.
//
// Зависимости («какая развилка от ручки зависит») здесь НЕ приезжают: они живут
// пометками «зависит от:» внутри схем логики, то есть окном дозаливки доков.
// Применение НЕ кладётся в undo — страховка та же: превью + дефолт «не перезаписывать».
import { useEffect, useMemo, useRef, useState } from "react";
import type { ConfigImportReport, PromptVariant } from "../../types";
import { configImportApi, type DocsFile } from "../../api/docsImport";
import { useDocsFiles, MAX_FILES } from "./useDocsFiles";
import { useFileDrop } from "./useFileDrop";
import {
  ACTION_LABEL, countAction, inputFingerprint, useRepeatedInput,
  head, sub, cols, leftCol, rightCol, leftNote,
  chipsRow, chipOn, chip, chipBtn, chipX, fileArea, dropHint, grayLine, footRow, radioRow,
} from "./agentModalShared";
import { ItemList, NoteList, StaleFilesConfirm, UnchangedInputNote } from "./agentModalReport";
import PromptTriple from "./PromptTriple";
import Modal from "../../ui/Modal";
import { CloseIcon } from "../../ui/icons";
import { primaryBtn, secondaryBtn } from "../../ui/styles";

interface Props {
  // Объект, из окна которого открыта дозаливка: к нему уедут параметры без адреса.
  nodeId: string;
  nodeName: string;
  onClose: () => void;
  // Дозаливка применена — родитель перечитывает конфигурацию.
  onApplied: () => void;
}

export default function ConfigAgentModal({ nodeId, nodeName, onClose, onApplied }: Props) {
  const pkg = useDocsFiles();
  const [rawReport, setRawReport] = useState<ConfigImportReport | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [remarksCopied, setRemarksCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);
  const drop = useFileDrop({ onFiles: pkg.pickFiles, disabled: pkg.files.length >= MAX_FILES });

  // Пустые файлы прячут отчёт ПРОИЗВОДНО — эффект не зеркалит состояние в состояние.
  const report = pkg.hasContent ? rawReport : null;

  // Гвард «вход не изменился»: тот же байт-в-байт пакет, что в прошлый заход, —
  // повод посмотреть на файлы агента, а не на замечание (находка полевой приёмки).
  const fingerprint = useMemo(() => inputFingerprint(pkg.files), [pkg.files]);
  const repeatedInput = useRepeatedInput(pkg.files, fingerprint);
  const [askedFor, setAskedFor] = useState<DocsFile[] | null>(null);

  useEffect(() => {
    const nonEmpty = pkg.files.filter((f) => f.content.trim() !== "");
    if (nonEmpty.length === 0) return;
    const seq = ++seqRef.current;
    const t = window.setTimeout(() => {
      setChecking(true);
      configImportApi.preview({ files: nonEmpty, overwrite, nodeId })
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
  }, [pkg.files, overwrite, nodeId]);

  // Запрос промпта + запись в буфер В ПРЕДЕЛАХ ЖЕСТА; «скопировано» по каждому из
  // трёх вариантов показывает PromptTriple по разрешению этого обещания.
  function copyPrompt(variant: PromptVariant): Promise<void> {
    return configImportApi.prompt(variant).then(({ prompt }) => navigator.clipboard.writeText(prompt));
  }

  const remarks = report === null ? [] : [...report.errors, ...report.warnings];

  // «Чини, а не удаляй» — тот же урок, что у импорта, доков и каналов: на голое
  // «исправь» слабая модель отвечает ампутацией, вырезая записи вместо починки.
  function copyRemarks() {
    const text =
      "Валидатор дозаливки конфигурации ArchMap нашёл замечания к пакету. " +
      "Исправь файлы и сообщи, какие изменились. Параметры чини по замечаниям, " +
      "а не удаляй из пакета:\n" +
      remarks.map((r) => `- ${r}`).join("\n");
    void navigator.clipboard.writeText(text).then(() => {
      setRemarksCopied(true);
      setTimeout(() => setRemarksCopied(false), 2000);
      setAskedFor(pkg.files);
    });
  }

  function clearPackage() {
    setAskedFor(null);
    pkg.reset();
    setRawReport(null);
  }

  function apply() {
    setApplying(true);
    configImportApi.apply({ files: pkg.nonEmpty, overwrite, nodeId })
      .then((r) => {
        setRawReport(r);
        if (!r.applied) return;
        onApplied();
        onClose();
      })
      .finally(() => setApplying(false));
  }

  const willWrite =
    report !== null && report.errors.length === 0 && report.params.length > 0;

  return (
    <Modal onClose={onClose} closeButton={false} boxStyle={{ width: 1060, maxWidth: "calc(100vw - 48px)", maxHeight: "92vh", overflowY: "auto" }}>
      <div style={head}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Описать конфигурацию с помощью ИИ-агента</h2>
        <button onClick={onClose} className="modal-close" aria-label="Закрыть"><CloseIcon /></button>
      </div>
      <p style={sub}>
        Запускайте агента с этим промптом в репозитории сервиса: параметр описывается
        там, где его читает код. В ArchMap приедет ПЕРЕЧЕНЬ РУЧЕК — имена, типы,
        назначение и дефолты из кода; значения сред и секреты не хранятся. Параметры
        из файла без адреса «# archmap-node:» приедут к объекту «{nodeName}».
      </p>

      <div style={cols}>
        <div style={leftCol}>
          <PromptTriple
            label="Скопировать промпт"
            copiedLabel="Скопировано ✓"
            kind="primary"
            copy={copyPrompt}
          />
          <label style={{ ...radioRow, marginTop: 14 }}>
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
            Перезаписывать заполненное
          </label>
          <p style={leftNote}>
            По умолчанию описанное раньше — вручную или прошлым прогоном — не
            трогается: пакет только добавляет недостающее, а расхождение попадает в
            замечания. Удалений нет ни при какой настройке: чего агент не увидел, то
            останется как есть.
          </p>
        </div>

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
            <button type="button" className="btn-soft" disabled={pkg.files.length >= MAX_FILES}
              onClick={() => fileRef.current?.click()}>
              Загрузить файлы…
            </button>
            <button type="button" className="btn-soft" disabled={pkg.files.length >= MAX_FILES}
              title="Добавить файл вставкой текста" onClick={pkg.addPaste}>
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
                Перетащите сюда файлы, которые подготовил агент, — или нажмите, чтобы
                выбрать их на диске. Содержимое можно и вставить текстом.
              </button>
            )}
          </div>
          {drop.error && <p style={{ ...grayLine, color: "#b45309", marginTop: 6 }}>{drop.error}</p>}

          <div style={{ marginTop: 10, minHeight: 20 }}>
            {checking && <div style={grayLine}>Проверяю пакет…</div>}
            {repeatedInput && <UnchangedInputNote />}
            {!checking && report !== null && report.applied && (
              <div style={{ fontSize: 13, fontWeight: 600, color: "#15803d" }}>
                Применено: параметров {report.params_written}.
              </div>
            )}
            {!checking && report !== null && !report.applied && report.errors.length === 0 && (
              <div style={{ fontSize: 13, fontWeight: 600, color: willWrite ? "#15803d" : "#475569" }}>
                Параметров: {report.params.length} (новых {countAction(report.params, "create")})
              </div>
            )}
            {!checking && report !== null && report.errors.length > 0 && (
              <div style={{ fontSize: 12.5, color: "#dc2626" }}>
                <div style={{ fontWeight: 600, marginBottom: 3 }}>Пакет не применить:</div>
                {report.errors.slice(0, 6).map((e, i) => <div key={i} style={{ marginTop: 2 }}>{e}</div>)}
                {report.errors.length > 6 && <div>…ещё {report.errors.length - 6}</div>}
              </div>
            )}

            {!checking && report !== null && report.params.length > 0 && (
              <ItemList
                title="Параметры:"
                rows={report.params.map((p) => ({
                  key: `${p.node_path}#${p.name}`,
                  text: `«${p.node_path}» · ${p.name}${p.value_type ? ` · ${p.value_type}` : ""}${p.required ? " · обяз." : ""}`,
                  badge: ACTION_LABEL[p.action] ?? p.action,
                  bad: null,
                  ok: true,
                }))}
              />
            )}
            {!checking && report !== null && report.warnings.length > 0 && (
              <NoteList title="Проверьте:" items={report.warnings} />
            )}
            {!checking && remarks.length > 0 && (
              <button type="button"
                style={{ ...secondaryBtn, marginTop: 8, padding: "4px 10px", fontSize: 12.5 }}
                onClick={copyRemarks}>
                {remarksCopied ? "Скопировано ✓" : "Скопировать замечания для агента"}
              </button>
            )}
            {askedFor === pkg.files && (
              <StaleFilesConfirm onKeep={() => setAskedFor(null)} onClear={clearPackage} />
            )}
          </div>

          <div style={footRow}>
            <button type="button"
              style={{ ...primaryBtn, opacity: willWrite && !applying ? 1 : 0.55 }}
              disabled={!willWrite || applying}
              onClick={apply}>
              {applying ? "Применяю…" : "Применить"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
