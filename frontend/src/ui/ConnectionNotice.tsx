import { useSyncExternalStore } from "react";
import { isOffline, subscribeConnection } from "../lib/connection";
import "./ds.css";

// Плашка «нет связи» (аудит R-24): поллинг не достучался до сервера несколько раз
// подряд — изменения других участников не подтягиваются. Гаснет на первом удачном тике.
// Вид — тост нового языка вверху окна поверх всего (ui/ds.css).
export const CONNECTION_NOTICE = "Нет связи с сервером, поэтому свежие изменения не видны. ArchMap переподключится сам.";

export default function ConnectionNotice() {
  const offline = useSyncExternalStore(subscribeConnection, isOffline);
  if (!offline) return null;
  return (
    <div role="status" className="ds-toast ds-toast--service-top">
      {CONNECTION_NOTICE}
    </div>
  );
}
