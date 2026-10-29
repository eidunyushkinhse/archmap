// Окно «Собрать с компонентов» (Р19 эпика «Элемент архитектуры»): конфигурация и
// спецификация компонентов переезжают их контейнеру — факты процесса читает и отдаёт
// запускаемое целиком. Одноимённые параметры — один и тот же параметр контейнера:
// остаётся одно описание, какое — выбирает человек. Спецификаций несколько — контейнеру
// отдаётся одна выбранная, прочие остаются на месте.
//
// Превью (GET /nodes/{id}/facts/collect-preview) страница уже загрузила — по нему она
// решила показать кнопку, окно его только читает. Применение — POST …/facts/collect;
// отказ сервера — текстом под формой, окно открыто.
import { useState } from "react";
import type { CSSProperties } from "react";
import type { CollectFactsPreview } from "../types";
import { nodesApi } from "../api/nodes";
import { ApiError } from "../api/client";
import Modal from "../ui/Modal";
import DialogTitle from "../ui/DialogTitle";
import { primaryBtn, secondaryBtn } from "../ui/styles";
import { joinNames } from "./element/elementChange";
import { collectLine } from "./element/transferDocs";

interface Props {
  nodeId: string;
  nodeName: string;
  preview: CollectFactsPreview;
  onClose: () => void;
  // Сбор применён — страница перечитывает узел, потомков и параметры.
  onApplied: () => void;
}

export default function CollectFactsModal({ nodeId, nodeName, preview, onClose, onApplied }: Props) {
  // Одноимённые: имя → чьё описание остаётся (по умолчанию — первого держателя).
  const [choice, setChoice] = useState<Record<string, string>>(() =>
    Object.fromEntries(preview.param_clashes.map((c) => [c.name, c.candidates[0]?.node_id ?? ""])),
  );
  // Чья спецификация уходит контейнеру: "" — не переносить. Держатель один и это
  // компонент — переносится он, без вопроса; своя спецификация контейнера — по
  // умолчанию остаётся она.
  const own = preview.specs.some((s) => s.node_id === nodeId);
  const fromComponents = preview.specs.filter((s) => s.node_id !== nodeId);
  const ask = preview.specs.length > 1;
  const [specFrom, setSpecFrom] = useState<string>(() =>
    own ? "" : fromComponents[0]?.node_id ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const apply = () => {
    setSending(true);
    setError(null);
    nodesApi
      .collectFacts(nodeId, {
        param_choices: Object.entries(choice).map(([name, node_id]) => ({ name, node_id })),
        ...(specFrom !== "" ? { spec_from: specFrom } : {}),
      })
      .then(() => {
        onApplied();
        onClose();
      })
      .catch((e: unknown) => {
        setError(e instanceof ApiError ? e.message : "Не удалось собрать документацию");
        setSending(false);
      });
  };

  return (
    <Modal onClose={onClose} boxStyle={{ width: 560 }}>
      <DialogTitle lead={
        "Конфигурацию читает контейнер целиком, а спецификацию отдаёт он же. Параметры и "
        + `спецификации компонентов переедут в «${nodeName}».`
      }>
        Собрать с компонентов
      </DialogTitle>

      <ul style={list}>
        {preview.components.map((c) => <li key={c.node_id}>{collectLine(c)}</li>)}
      </ul>

      {preview.param_clashes.map((clash) => (
        <fieldset key={clash.name} style={question}>
          <legend style={questionText}>
            Одинаковые имена: {clash.name} у {joinNames(clash.candidates.map((c) => c.node_name))}.
            {" "}Какое описание оставить?
          </legend>
          {clash.candidates.map((c) => (
            <label key={c.node_id} style={radio}>
              <input
                type="radio"
                name={`clash-${clash.name}`}
                checked={choice[clash.name] === c.node_id}
                onChange={() => setChoice((m) => ({ ...m, [clash.name]: c.node_id }))}
              />
              {c.description ? `${c.node_name}: «${c.description}»` : `${c.node_name}: без описания`}
            </label>
          ))}
        </fieldset>
      ))}

      {ask && (
        <fieldset style={question}>
          <legend style={questionText}>Спецификаций несколько. Какую отдать «{nodeName}»?</legend>
          {preview.specs.map((s) => {
            // Своя спецификация контейнера — «оставить как есть», запросу это null; пункт
            // «Не переносить» тогда не нужен — он значит то же самое.
            const value = s.node_id === nodeId ? "" : s.node_id;
            return (
              <label key={s.node_id} style={radio}>
                <input
                  type="radio"
                  name="spec-from"
                  checked={specFrom === value}
                  onChange={() => setSpecFrom(value)}
                />
                {s.name}
              </label>
            );
          })}
          {!own && (
            <label style={radio}>
              <input type="radio" name="spec-from" checked={specFrom === ""} onChange={() => setSpecFrom("")} />
              Не переносить
            </label>
          )}
        </fieldset>
      )}

      {error && <p style={errText}>{error}</p>}

      <div style={footRow}>
        <button
          type="button"
          onClick={apply}
          disabled={sending}
          style={{ ...primaryBtn, ...(sending ? { opacity: 0.6, cursor: "default" } : {}) }}
        >
          {sending ? "Сбор…" : "Собрать"}
        </button>
        <button type="button" onClick={onClose} style={secondaryBtn}>Отмена</button>
      </div>
    </Modal>
  );
}

/* --------------------------------- стили --------------------------------- */
const list: CSSProperties = { margin: "4px 0 0", paddingLeft: 18, fontSize: 13.5, color: "#1e293b", lineHeight: 1.7 };
const question: CSSProperties = { border: "none", margin: "14px 0 0", padding: 0 };
const questionText: CSSProperties = { fontSize: 13.5, fontWeight: 600, color: "#1e293b", padding: 0, marginBottom: 6 };
const radio: CSSProperties = { display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, color: "#334155", padding: "3px 0" };
const errText: CSSProperties = { color: "#dc2626", margin: "10px 0 0", fontSize: 13 };
const footRow: CSSProperties = { display: "flex", gap: 8, marginTop: 16 };
