// Окно «Перенести документацию» (Р19 эпика «Элемент архитектуры»): собственная
// документация узла с вложенными объектами уходит потомкам по семьям фактов. У системы
// своей документации нет вовсе — схемы логики, спецификация и конфигурация; у контейнера
// с компонентами не на месте только схемы логики (они описывают код компонентов).
//
// Получатели — любой потомок подходящего элемента (transferDocs: takesLogic,
// takesProcessFacts), подписи — путь от узла («orders / api»). Окно само грузит узел,
// потомков и число собственных параметров; применение — POST /nodes/{id}/docs/distribute.
// Отказ сервера (занято имя, уже есть спецификация) — текстом под формой, окно открыто.
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { Node } from "../types";
import { configParamsApi, nodesApi, nodeDocsApi } from "../api/nodes";
import { ApiError } from "../api/client";
import Modal from "../ui/Modal";
import DialogTitle from "../ui/DialogTitle";
import { plural } from "../ui/plural";
import { primaryBtn, secondaryBtn } from "../ui/styles";
import { subtreeRows, takesLogic, takesProcessFacts, type SubtreeRow } from "./element/transferDocs";
import "./inspector/inspector.css"; // классы insp-doc-chip для чипов вида схемы

const TITLE = "Перенести документацию";
const LEAD_SYSTEM = "У системы своей документации нет. Выберите, куда перенести каждую часть.";
const LEAD_CONTAINER = "Схемы логики описывают код, и их место у компонентов.";
const NONE = "Внутри нет подходящего объекта.";

interface Props {
  nodeId: string;
  onClose: () => void;
  // Перенос применён — страница перечитывает узел, потомков и параметры (окно
  // закрывается само).
  onApplied: () => void;
}

interface Loaded {
  node: Node;
  rows: SubtreeRow[];
  params: number;
}

export default function TransferDocsModal({ nodeId, onClose, onApplied }: Props) {
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([nodesApi.get(nodeId), nodesApi.getDescendants(nodeId), configParamsApi.list(nodeId)])
      .then(([node, descendants, params]) => {
        if (alive) setData({ node, rows: subtreeRows(nodeId, descendants), params: params.length });
      })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [nodeId]);

  if (failed) {
    return (
      <Modal onClose={onClose} boxStyle={{ width: 560 }}>
        <DialogTitle lead="Не удалось загрузить данные объекта.">{TITLE}</DialogTitle>
        <div style={footRow}>
          <button type="button" onClick={onClose} style={secondaryBtn}>Закрыть</button>
        </div>
      </Modal>
    );
  }
  if (!data) {
    return (
      <Modal onClose={onClose} boxStyle={{ width: 560 }}>
        <div style={muted}>Загрузка…</div>
      </Modal>
    );
  }
  return <TransferForm key={data.node.id} data={data} onClose={onClose} onApplied={onApplied} />;
}

// Форма монтируется на загруженных данных: начальные назначения — из них.
function TransferForm({ data, onClose, onApplied }: {
  data: Loaded;
  onClose: () => void;
  onApplied: () => void;
}) {
  const { node, rows } = data;
  const system = node.element_effective === "system";
  const logicTo = useMemo(() => rows.filter((r) => takesLogic(r.node)), [rows]);
  const processTo = useMemo(() => rows.filter((r) => takesProcessFacts(r.node)), [rows]);
  // Спецификация и конфигурация не на месте только у системы: у контейнера они свои.
  const spec = system && (node.openapi_spec ?? "").trim() !== "";
  const params = system ? data.params : 0;

  const [docTo, setDocTo] = useState<Record<string, string>>(() =>
    Object.fromEntries(node.docs.map((d) => [d.id, logicTo[0]?.node.id ?? ""])),
  );
  // "" — не переносить. По умолчанию — первый контейнер без своей спецификации.
  const [specTo, setSpecTo] = useState(() =>
    (spec && processTo.find((r) => !(r.node.openapi_spec ?? "").trim())?.node.id) || "",
  );
  const [paramsTo, setParamsTo] = useState(() => (params > 0 ? processTo[0]?.node.id ?? "" : ""));
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  if (rows.length === 0) {
    return (
      <Modal onClose={onClose} boxStyle={{ width: 560 }}>
        <DialogTitle lead={`Внутри «${node.name}» нет объектов, поэтому переносить документацию некуда.`}>
          {TITLE}
        </DialogTitle>
        <div style={footRow}>
          <button type="button" onClick={onClose} style={secondaryBtn}>Закрыть</button>
        </div>
      </Modal>
    );
  }

  const apply = () => {
    setSending(true);
    setError(null);
    nodeDocsApi
      .distribute(node.id, {
        doc_assignments: node.docs
          .map((d) => ({ doc_id: d.id, child_id: docTo[d.id] ?? "" }))
          .filter((a) => a.child_id !== ""),
        ...(specTo !== "" ? { spec_child_id: specTo } : {}),
        ...(paramsTo !== "" ? { params_target_id: paramsTo } : {}),
      })
      .then(() => {
        onApplied();
        onClose();
      })
      .catch((e: unknown) => {
        setError(e instanceof ApiError ? e.message : "Не удалось перенести документацию");
        setSending(false);
      });
  };

  return (
    <Modal onClose={onClose} boxStyle={{ width: 560 }}>
      <DialogTitle lead={system ? LEAD_SYSTEM : LEAD_CONTAINER}>{TITLE}</DialogTitle>

      {node.docs.length > 0 && (
        <>
          <div style={groupLabel}>Схемы логики</div>
          {logicTo.length === 0 ? <p style={muted}>{NONE}</p> : node.docs.map((d) => (
            <div key={d.id} style={row}>
              <span style={rowName} title={d.name}>
                {d.name}
                <span className={`insp-doc-chip insp-doc-chip--${d.kind}`} style={{ marginLeft: 8 }}>
                  {d.kind === "operation" ? "операция" : "воркер"}
                </span>
              </span>
              <select
                style={select}
                value={docTo[d.id] ?? ""}
                onChange={(e) => setDocTo((m) => ({ ...m, [d.id]: e.target.value }))}
                aria-label={`Куда перенести схему «${d.name}»`}
              >
                {logicTo.map((r) => <option key={r.node.id} value={r.node.id}>{r.label}</option>)}
              </select>
            </div>
          ))}
        </>
      )}

      {spec && (
        <>
          <div style={groupLabel}>Спецификация</div>
          {processTo.length === 0 ? <p style={muted}>{NONE}</p> : (
            <div style={row}>
              <span style={rowName}>OpenAPI</span>
              <select
                style={select}
                value={specTo}
                onChange={(e) => setSpecTo(e.target.value)}
                aria-label="Куда перенести спецификацию"
              >
                <option value="">Не переносить</option>
                {processTo.map((r) => {
                  const taken = (r.node.openapi_spec ?? "").trim() !== "";
                  return (
                    <option key={r.node.id} value={r.node.id} disabled={taken}>
                      {r.label}{taken ? " (уже есть спецификация)" : ""}
                    </option>
                  );
                })}
              </select>
            </div>
          )}
        </>
      )}

      {params > 0 && (
        <>
          <div style={groupLabel}>Конфигурация</div>
          {processTo.length === 0 ? <p style={muted}>{NONE}</p> : (
            <div style={row}>
              <span style={rowName}>{params} {plural(params, ["параметр", "параметра", "параметров"])}</span>
              <select
                style={select}
                value={paramsTo}
                onChange={(e) => setParamsTo(e.target.value)}
                aria-label="Куда перенести конфигурацию"
              >
                <option value="">Не переносить</option>
                {processTo.map((r) => <option key={r.node.id} value={r.node.id}>{r.label}</option>)}
              </select>
            </div>
          )}
        </>
      )}

      {error && <p style={errText}>{error}</p>}

      <div style={footRow}>
        <button
          type="button"
          onClick={apply}
          disabled={sending}
          style={{ ...primaryBtn, ...(sending ? { opacity: 0.6, cursor: "default" } : {}) }}
        >
          {sending ? "Перенос…" : "Перенести"}
        </button>
        <button type="button" onClick={onClose} style={secondaryBtn}>Отмена</button>
      </div>
    </Modal>
  );
}

/* --------------------------------- стили --------------------------------- */
const muted: CSSProperties = { color: "#475569", margin: "4px 0 0", fontSize: 13.5 };
const groupLabel: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "#94a3b8",
  margin: "12px 0 6px",
};
// Строка «часть документации → получатель»
const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 0",
  borderBottom: "1px solid #f3f4f6",
};
const rowName: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 13.5,
  fontWeight: 600,
  color: "#1e293b",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  display: "inline-flex",
  alignItems: "center",
};
const select: CSSProperties = {
  width: 240,
  flex: "none",
  padding: "7px 9px",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  fontSize: 13,
  color: "#1e293b",
  background: "#fff",
  outline: "none",
};
const errText: CSSProperties = { color: "#dc2626", margin: "10px 0 0", fontSize: 13 };
const footRow: CSSProperties = { display: "flex", gap: 8, marginTop: 16 };
