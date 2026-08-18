// Импорт процесса из текста mermaid sequenceDiagram: превью → сопоставление имён →
// применение. Тот же паттерн, что у импорта YAML и доков от агента: сперва показать,
// что получится, и только потом писать.
//
// Пользователь НЕ обязан сопоставить каждого участника (его решение): оставленные без
// узла заводятся непривязанными и попадают в алерт «Незадокументированные участники», а их
// шаги — повисшими. Ничего из сценария при этом не теряется.
import { useState } from "react";
import Modal from "../../ui/Modal";
import { processesApi } from "../../api/processes";
import type { ProcessImportPreview, ProcessImportResult } from "../../types";
import { primaryBtn, secondaryBtn } from "../../ui/styles";
import { BPT, BROKEN } from "./tokens";

interface Props {
  onClose: () => void;
  // Импорт создал процесс — открыть его.
  onImported: (processId: string) => void;
}

const label: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, letterSpacing: ".04em",
  textTransform: "uppercase", color: BPT.mut, marginBottom: 6,
};

export default function ProcessImportModal({ onClose, onImported }: Props) {
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<ProcessImportPreview | null>(null);
  // Сопоставление: алиас участника → узел (пусто = оставить непривязанным).
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ProcessImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doPreview() {
    setBusy(true);
    setError(null);
    try {
      const p = await processesApi.importPreview({ text, name: name.trim() || null });
      setPreview(p);
      // Авто-сопоставление подставляем как значение по умолчанию — пользователь его
      // может снять: превью не выбирает из тёзок, а единственное совпадение честное.
      const auto: Record<string, string> = {};
      for (const part of p.participants) if (part.node_id) auto[part.alias] = part.node_id;
      setMapping(auto);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось разобрать диаграмму");
    } finally {
      setBusy(false);
    }
  }

  async function doImport() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const res = await processesApi.importProcess({
        text,
        name: name.trim() || null,
        mapping: Object.fromEntries(
          // Именно ||, а не ??: снятое сопоставление лежит пустой строкой, и с ??
          // она уехала бы на бэк как невалидный uuid.
          preview.participants.map((p) => [p.alias, mapping[p.alias] || null]),
        ),
      });
      setResult(res);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось импортировать процесс");
    } finally {
      setBusy(false);
    }
  }

  const unbound = preview
    ? preview.participants.filter((p) => !mapping[p.alias]).length
    : 0;

  return (
    <Modal onClose={onClose} boxStyle={{ width: 720 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: BPT.head, marginBottom: 12 }}>
        Импорт процесса из Mermaid
      </div>
      {result ? (
        <div style={{ fontSize: 13, lineHeight: 1.7 }}>
          <div style={{ fontWeight: 600, color: BPT.head, marginBottom: 8 }}>Процесс создан</div>
          <div>Участников: {result.participants}
            {result.unbound > 0 && (
              <span style={{ color: BROKEN.ink }}> · без узла схемы: {result.unbound}</span>
            )}
          </div>
          <div>Шагов: {result.messages} · на каналах схемы: {result.attached}
            {/* Внутренние операции участника канала не имеют по контракту — это не
                поломка, поэтому обычным цветом и отдельным числом: иначе строка не
                сходится («шагов 13, на каналах 12, а тринадцатый где?»). */}
            {result.self_messages > 0 && (
              <span style={{ color: BPT.mut }}> · внутренних операций: {result.self_messages}</span>
            )}
            {result.dangling > 0 && (
              <span style={{ color: BROKEN.ink }}> · без связи: {result.dangling}</span>
            )}
          </div>
          <div>Фрагментов: {result.fragments}</div>
          {/* Привязки к схемам логики (Ф7): неразрешённый адрес — не поломка импорта,
              шаг приехал непривязанным и виден алертом полноты, но сказать об этом
              обязаны здесь — молчание читалось бы как «все привязки доехали». */}
          {(result.doc_linked > 0 || result.doc_unresolved > 0) && (
            <div>Привязок к схемам логики: {result.doc_linked}
              {result.doc_unresolved > 0 && (
                <span style={{ color: BROKEN.ink }}> · адрес не разрешился: {result.doc_unresolved}</span>
              )}
            </div>
          )}
          {result.unsupported.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={label}>Строки, которые не удалось разобрать</div>
              <ul style={{ margin: 0, paddingLeft: 18, color: BPT.mut, fontSize: 12 }}>
                {result.unsupported.map((u, i) => <li key={i}>{u}</li>)}
              </ul>
            </div>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
            <button style={primaryBtn} onClick={() => onImported(result.process_id)}>
              Открыть процесс
            </button>
          </div>
        </div>
      ) : (
        <>
          <div style={label}>Текст диаграммы</div>
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setPreview(null); }}
            placeholder={"sequenceDiagram\n    participant P1 as Покупатель\n    P1->>P2: создать заказ"}
            spellCheck={false}
            style={{
              width: "100%", height: 180, fontFamily: "ui-monospace, Menlo, Consolas, monospace",
              fontSize: 12, lineHeight: 1.6, padding: 10, borderRadius: 8,
              border: "1px solid " + BPT.line, resize: "vertical", boxSizing: "border-box",
            }}
          />
          <div style={{ ...label, marginTop: 12 }}>Название процесса</div>
          <input
            className="bp-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Импортированный процесс"
          />

          {preview && (
            <div style={{ marginTop: 14 }}>
              <div style={label}>Участники: с чем сопоставились</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflow: "auto" }}>
                {preview.participants.map((p) => (
                  <div key={p.alias} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 13, color: BPT.head, minWidth: 150 }}>{p.name}</span>
                    <select
                      className="bp-input"
                      style={{ flex: 1, height: 30 }}
                      value={mapping[p.alias] ?? ""}
                      onChange={(e) =>
                        setMapping((m) => ({ ...m, [p.alias]: e.target.value }))
                      }
                    >
                      <option value="">— без узла схемы —</option>
                      {p.candidates.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}{c.parent_name ? ` (в ${c.parent_name})` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 12, color: BPT.mut, marginTop: 8, lineHeight: 1.5 }}>
                Шагов: {preview.message_count} · фрагментов: {preview.fragment_count}
                {unbound > 0 && (
                  <span style={{ color: BROKEN.ink }}>
                    {" "}· без узла останется участников: {unbound} — они попадут в
                    «Незавершённость схемы», привязать можно потом
                  </span>
                )}
              </div>
              {preview.unsupported.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div style={label}>Не удалось разобрать</div>
                  <ul style={{ margin: 0, paddingLeft: 18, color: BPT.mut, fontSize: 12 }}>
                    {preview.unsupported.map((u, i) => <li key={i}>{u}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}

          {error && <div style={{ color: "#dc2626", fontSize: 12, marginTop: 10 }}>{error}</div>}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
            <button style={secondaryBtn} onClick={onClose}>Отмена</button>
            {preview ? (
              <button style={primaryBtn} onClick={() => void doImport()} disabled={busy}>
                Импортировать
              </button>
            ) : (
              <button
                style={primaryBtn}
                onClick={() => void doPreview()}
                disabled={busy || !text.trim()}
              >
                Разобрать
              </button>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
