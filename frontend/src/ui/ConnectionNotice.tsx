import { useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import { isOffline, subscribeConnection } from "../lib/connection";

// Плашка «нет связи» (аудит R-24): поллинг не достучался до сервера несколько раз
// подряд — изменения других участников не подтягиваются. Гаснет на первом удачном тике.
export const CONNECTION_NOTICE = "Нет связи с сервером — изменения не подтягиваются. ArchMap повторит сам.";

export default function ConnectionNotice() {
  const offline = useSyncExternalStore(subscribeConnection, isOffline);
  if (!offline) return null;
  return (
    <div role="status" style={bar}>
      {CONNECTION_NOTICE}
    </div>
  );
}

const bar: CSSProperties = {
  position: "fixed",
  left: "50%",
  top: 12,
  transform: "translateX(-50%)",
  zIndex: 10000,
  maxWidth: "calc(100% - 32px)",
  padding: "8px 14px",
  background: "#fffbeb",
  border: "1px solid #fcd34d",
  color: "#92400e",
  borderRadius: 10,
  boxShadow: "0 8px 24px rgba(15,23,42,.12)",
  fontSize: 13,
};
