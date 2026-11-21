import type { ReactNode } from "react";
import type { NodeDocKind } from "../types";
import { KIND_LABEL } from "./docsList";
import "../ui/ds.css";

// Строка-документ (схема логики, спецификация, процесс) страницы объекта: имя, операция
// моноширинным, тихие пометки у правого края. Одна разметка вместо семи копий (аудит
// F-5). С редизайна (направление А) пилюль вида и «открыть →» нет: строка нажимается
// целиком, а вид, где группировки по виду нет, пишется тихим текстом справа.
export function DocRowLabel({ name, kind, stub, operation, note }: {
  name: string;
  kind?: NodeDocKind;
  stub?: boolean;
  operation?: string | null;
  note?: ReactNode;
}) {
  const quiet = [kind ? KIND_LABEL[kind] : "", stub ? "не описана" : ""].filter(Boolean).join(", ");
  return (
    <>
      <span className="ds-row-name">{name}</span>
      {operation && <span className="ds-mono">{operation}</span>}
      {note !== undefined && <span className="ds-row-quiet">{note}</span>}
      {quiet && <span className="ds-row-quiet">{quiet}</span>}
    </>
  );
}

// Строка документа, которая открывается целиком (своя схема, спецификация, процесс).
export function DocRow({ title, onOpen, children }: {
  title?: string;
  onOpen: () => void;
  children: ReactNode;
}) {
  return (
    <div className="ds-row">
      <button type="button" className="ds-row-main" onClick={onOpen} title={title}>
        {children}
      </button>
    </div>
  );
}

// Строка документа потомка в объединении контейнера: строка открывает документ
// владельца напрямую (в его контексте). owner — владелец глубже подгруппы (имя
// компонента в подписи подгруппы уже названо): тихой ссылкой справа он ведёт на свою
// страницу — документы принадлежат ему.
export function OwnerSplitRow({ openTitle, onOpen, owner, onNavigateNode, children }: {
  openTitle: string;
  onOpen: () => void;
  owner: { id: string; name: string } | null;
  onNavigateNode: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="ds-row">
      <button type="button" className="ds-row-main" onClick={onOpen} title={openTitle}>
        {children}
      </button>
      {owner && (
        <button
          type="button"
          className="ds-row-side"
          onClick={() => onNavigateNode(owner.id)}
          title={`Перейти к объекту «${owner.name}»`}
        >
          {owner.name}
        </button>
      )}
    </div>
  );
}
