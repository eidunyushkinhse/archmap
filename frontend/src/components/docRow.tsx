import type { CSSProperties, ReactNode } from "react";
import type { NodeDocKind } from "../types";
import { KIND_LABEL } from "./docsList";

// Строка-документ (схема логики, спека, процесс) страницы объекта: имя, вид, пометка
// заглушки, операция или примечание и «открыть →» у правого края. Одна разметка вместо
// семи копий (аудит F-5) — у собственных схем, спек, схем и спек потомков, процессов.
export function DocRowLabel({ name, kind, stub, operation, note }: {
  name: string;
  kind?: NodeDocKind;
  stub?: boolean;
  operation?: string | null;
  note?: ReactNode;
}) {
  return (
    <>
      <span style={rowName}>{name}</span>
      {kind && <span className={`np-doc-chip np-doc-chip--${kind}`}>{KIND_LABEL[kind]}</span>}
      {stub && <StubMark />}
      {operation && <span style={rowOperation}>{operation}</span>}
      {note !== undefined && <span style={rowNote}>{note}</span>}
      <span style={rowOpen}>открыть →</span>
    </>
  );
}

// Split-строка документа потомка в объединении контейнера: левая (широкая) часть
// открывает документ владельца напрямую (в его контексте), правая (узкая) ведёт на
// страницу владельца — документы принадлежат ему.
export function OwnerSplitRow({ openTitle, onOpen, owner, onNavigateNode, children }: {
  openTitle: string;
  onOpen: () => void;
  owner: { id: string; name: string };
  onNavigateNode: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="np-doc-split">
      <button type="button" className="np-doc-split-main" onClick={onOpen} title={openTitle}>
        {children}
      </button>
      <button
        type="button"
        className="np-doc-split-child"
        onClick={() => onNavigateNode(owner.id)}
        title={`Перейти к объекту «${owner.name}»`}
      >
        от {owner.name} →
      </button>
    </div>
  );
}

// Метка заглушки: схема в списке есть, а тела у неё нет — список операций от агента
// создал её строкой перечня (docs/plan-recon.md). Спокойный пунктирный контур, а НЕ
// красная тревога: неописанная точка входа — нормальное состояние работы по списку,
// а не ошибка. В списках «Логики» больше не стоит (заглушки живут отдельным блоком);
// остаётся у собственных (grandfather) схем контейнера — там список предупреждения,
// и что именно переезжает к детям, видеть полезно.
function StubMark() {
  return <span style={stubMark}>не описана</span>;
}

const rowName: CSSProperties = { fontWeight: 600, fontSize: 13 };
const rowOperation: CSSProperties = { fontSize: 12, color: "#64748b", fontFamily: "ui-monospace, monospace" };
const rowNote: CSSProperties = { fontSize: 12, color: "#94a3b8" };
const rowOpen: CSSProperties = { marginLeft: "auto", fontSize: 12, color: "#94a3b8" };
const stubMark: CSSProperties = {
  flex: "none", fontSize: 11, fontWeight: 600, color: "#64748b",
  background: "#f8fafc", border: "1px dashed #cbd5e1", borderRadius: 5, padding: "1px 6px",
  whiteSpace: "nowrap",
};
