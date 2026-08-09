// Модалка «Распределить по детям» (правила контейнеров): перенос СОБСТВЕННЫХ
// (grandfather) схем логики и OpenAPI-спеки контейнера на его непосредственных
// детей. Контейнеру по правилам не положено своей логики/спеки — модалка
// открывается со страницы контейнера, когда у того остались свои доки/спека.
//
// Паттерн EdgeEditModal: сама фетчит данные (узел + дети), loading/failed-состояния,
// форма монтируется на загруженных данных. Для каждой своей схемы — выбор
// ребёнка-получателя (дефолт — первый ребёнок); спека переносится ЦЕЛИКОМ одному
// ребёнку (опция «не переносить» — spec_child_id опционален в контракте).
// Применение — POST /nodes/{id}/docs/distribute; при ошибке (409 — имя схемы
// занято у ребёнка, у ребёнка уже есть спека, цель не ребёнок) показываем текст
// ошибки и НЕ закрываемся.
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { Node } from "../types";
import { nodesApi, nodeDocsApi } from "../api/nodes";
import { ApiError } from "../api/client";
import Modal from "../ui/Modal";
import { primaryBtn, secondaryBtn } from "../ui/styles";
import "./inspector/inspector.css"; // классы insp-doc-chip для чипов вида схемы

interface Props {
  nodeId: string;
  onClose: () => void;
  // Перенос применён — родитель освежает узел и детей (модалка закрывается сама).
  onApplied: () => void;
}

interface Loaded {
  node: Node;
  children: Node[];
}

export default function DistributeDocsModal({ nodeId, onClose, onApplied }: Props) {
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [node, children] = await Promise.all([
          nodesApi.get(nodeId),
          nodesApi.getChildren(nodeId),
        ]);
        if (!alive) return;
        setData({ node, children });
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => { alive = false; };
  }, [nodeId]);

  if (failed) {
    return (
      <Modal onClose={onClose} boxStyle={{ width: 540 }}>
        <h3 style={titleStyle}>Распределить по детям</h3>
        <p style={failText}>Не удалось загрузить данные узла</p>
        <div style={footRow}>
          <button type="button" onClick={onClose} style={secondaryBtn}>Закрыть</button>
        </div>
      </Modal>
    );
  }

  if (!data) {
    return (
      <Modal onClose={onClose} boxStyle={{ width: 540 }}>
        <div style={failText}>Загрузка…</div>
      </Modal>
    );
  }

  return <DistributeForm key={data.node.id} data={data} onClose={onClose} onApplied={onApplied} />;
}

// Форма распределения (монтируется на загруженных данных; key=node.id).
function DistributeForm({ data, onClose, onApplied }: {
  data: Loaded;
  onClose: () => void;
  onApplied: () => void;
}) {
  const ownDocs = data.node.docs;
  const hasSpec = (data.node.openapi_spec ?? "") !== "";
  const children = data.children;
  const firstChildId = children[0]?.id ?? "";

  // Назначения: каждая своя схема → выбранный ребёнок. Дефолт — первый ребёнок.
  const [docChild, setDocChild] = useState<Record<string, string>>(() =>
    Object.fromEntries(ownDocs.map((d) => [d.id, firstChildId])),
  );
  // Ребёнок для спеки; "" — не переносить (спека остаётся на контейнере).
  const [specChildId, setSpecChildId] = useState<string>(firstChildId);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const apply = () => {
    setSending(true);
    setError(null);
    const assigned = ownDocs
      .map((d) => ({ doc_id: d.id, child_id: docChild[d.id] ?? firstChildId }))
      .filter((a) => a.child_id !== ""); // без получателя — не переносится
    void nodeDocsApi
      .distribute(data.node.id, {
        doc_assignments: assigned,
        ...(hasSpec && specChildId !== "" ? { spec_child_id: specChildId } : {}),
      })
      .then(() => {
        onApplied();
        onClose();
      })
      .catch((e: unknown) => {
        // 409 (имя схемы занято у ребёнка / у ребёнка уже спека / цель не ребёнок)
        // и прочее — текст ошибки бэка под формой, модалка не закрывается.
        setError(e instanceof ApiError ? e.message : "Не удалось распределить документы");
        setSending(false);
      });
  };

  // Детей нет — распределять некуда (родитель не должен был открыть модалку,
  // но защищаемся: кнопка переноса недоступна).
  if (children.length === 0) {
    return (
      <Modal onClose={onClose} boxStyle={{ width: 540 }}>
        <h3 style={titleStyle}>Распределить по детям</h3>
        <p style={failText}>У контейнера нет детей — схемы и спеку некуда перенести.</p>
        <div style={footRow}>
          <button type="button" onClick={onClose} style={secondaryBtn}>Закрыть</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose} boxStyle={{ width: 540 }}>
      <h3 style={titleStyle}>Распределить по детям</h3>
      <p style={hintText}>
        Собственные схемы логики и OpenAPI-спека контейнера будут перенесены выбранным
        детям. У контейнера не останется своей логики и спеки.
      </p>

      {/* Схемы логики: строка на док — имя + выбор ребёнка-получателя */}
      {ownDocs.length > 0 && (
        <>
          <div style={groupLabel}>Схемы логики</div>
          <div>
            {ownDocs.map((d) => (
              <div key={d.id} style={docRow}>
                <span style={docName} title={d.name}>
                  {d.name}
                  <span className={`insp-doc-chip insp-doc-chip--${d.kind}`} style={{ marginLeft: 8 }}>
                    {d.kind === "overview" ? "обзор" : d.kind === "operation" ? "операция" : "воркер"}
                  </span>
                </span>
                <select
                  style={childSel}
                  value={docChild[d.id] ?? firstChildId}
                  onChange={(e) => setDocChild((m) => ({ ...m, [d.id]: e.target.value }))}
                  aria-label={`Получатель схемы «${d.name}»`}
                >
                  {children.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </>
      )}

      {/* OpenAPI-спека: переносится целиком одному ребёнку */}
      {hasSpec && (
        <>
          <div style={groupLabel}>OpenAPI-спека</div>
          <div style={docRow}>
            <span style={docName}>Спецификация</span>
            <select
              style={childSel}
              value={specChildId}
              onChange={(e) => setSpecChildId(e.target.value)}
              aria-label="Получатель OpenAPI-спеки"
            >
              <option value="">Не переносить</option>
              {children.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.openapi_spec ? " (уже есть спека)" : ""}
                </option>
              ))}
            </select>
          </div>
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
          {sending ? "Перенос…" : "Распределить"}
        </button>
        <button type="button" onClick={onClose} style={secondaryBtn}>Отмена</button>
      </div>
    </Modal>
  );
}

/* --------------------------------- стили --------------------------------- */
const titleStyle: CSSProperties = {
  margin: "0 0 10px",
  fontSize: 17,
  fontWeight: 700,
  color: "#1e293b",
  lineHeight: 1.3,
};
const hintText: CSSProperties = {
  margin: "0 0 12px",
  fontSize: 13,
  lineHeight: 1.45,
  color: "#64748b",
};
const failText: CSSProperties = {
  color: "#475569",
  margin: "4px 0 0",
  fontSize: 14,
};
const groupLabel: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "#94a3b8",
  margin: "12px 0 6px",
};
// Строка «схема/спека → получатель»
const docRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 0",
  borderBottom: "1px solid #f3f4f6",
};
const docName: CSSProperties = {
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
// Селект ребёнка-получателя
const childSel: CSSProperties = {
  width: 220,
  flex: "none",
  padding: "7px 9px",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  fontSize: 13,
  color: "#1e293b",
  background: "#fff",
  outline: "none",
};
const errText: CSSProperties = {
  color: "#dc2626",
  margin: "10px 0 0",
  fontSize: 13,
};
const footRow: CSSProperties = {
  display: "flex",
  gap: 8,
  marginTop: 16,
};
