// Алерты незавершённости схемы (индикатор «!» для архитектора, спека alerts.md).
// Данные считает бэк (GET /nodes/alerts, 4 категории, весь проект) — здесь только
// загрузка/хранение и чистое разрешение цели алерта в уровень + LocateRequest.
//
// Две точки размещения (решение 2026-08-01, вариант 3): знак в шапке ProjectShell
// (глобальная видимость) и рейл в холсте редактора-карты MapEditorPage (in-context
// locate + тост «Схема завершена»). Переход из шапки в карту передаёт цель через
// sessionStorage (PENDING_ALERT_LOCATE_KEY) — URL-locate поддерживает только узел,
// а алерты ведут ещё к связям и группам.
import { useCallback, useEffect, useState } from "react";
import type { Node, SchemaAlerts as Alerts } from "../types";
import type { LocateTarget } from "../components/SchemaAlerts";
import type { LocateRequest } from "../components/graph/types";
import { nodesApi } from "../api/nodes";

const EMPTY: Alerts = { disconnected_nodes: [], intermediate_edges: [], isolated_groups: [], container_own_docs: [], persons_inside: [], dangling_messages: [], unbound_participants: [], orphan_legs: [], unresolved_data_refs: [], unresolved_channel_refs: [], unresolved_config_refs: [], broker_edge_channels: [], descendant_edges: [], unlinked_messages: [] };

// Ключ sessionStorage для передачи цели алерта из шапки в редактор-карту.
export const PENDING_ALERT_LOCATE_KEY = "archmap.pendingAlertLocate";
// Обратное направление (2026-08-11): процессные классы (AL26/AL27) чинят НЕ на
// холсте, поэтому строка алерта в редакторе-карте уводит в режим «Процессы»
// оболочки. Процесс передаём тем же способом — роут карты про процессы не знает.
export const PENDING_PROCESS_KEY = "archmap.pendingProcess";

export function useSchemaAlerts(isArchitect: boolean): {
  alerts: Alerts;
  loaded: boolean;
  reload: () => void;
} {
  const [alerts, setAlerts] = useState<Alerts>(EMPTY);
  // Не-архитектору ждать нечего — loaded сразу true (запроса нет).
  const [loaded, setLoaded] = useState(!isArchitect);

  const reload = useCallback(() => {
    if (!isArchitect) return;
    nodesApi.getAlerts()
      .then(setAlerts)
      .catch(() => { /* алерты — некритичный фон, ошибку глотаем */ })
      .finally(() => setLoaded(true));
  }, [isArchitect]);

  useEffect(() => { reload(); }, [reload]);

  return { alerts, loaded, reload };
}

// Разрешает цель алерта в уровень (самый глубокий общий предок) и LocateRequest.
// Чистая функция (портирована из TreePage.handleLocate): для связи берёт сырые
// концы из алерта (фолбэк E6/C19 — связь может быть скрыта проекцией, тогда
// фокусируем представителей концов). Для узла общий предок = его родитель.
export function resolveAlertLocate(
  allNodes: Node[],
  target: LocateTarget,
  alerts: Alerts,
  token: number,
): { level: string | null; request: LocateRequest } {
  const byId = new Map(allNodes.map((n) => [n.id, n]));
  // Цепочка контейнеров снизу вверх: [родитель, дед, ..., null(корень)].
  const parentChain = (id: string): (string | null)[] => {
    const out: (string | null)[] = [];
    let n = byId.get(id);
    while (n && n.parent_id) {
      out.push(n.parent_id);
      n = byId.get(n.parent_id);
    }
    out.push(null);
    return out;
  };
  // Самый глубокий общий предок набора = уровень, на котором рисуется их связь.
  const commonLevel = (ids: string[]): string | null => {
    const chains = ids.map(parentChain);
    for (const cand of chains[0]) {
      if (chains.every((ch) => ch.includes(cand))) return cand;
    }
    return null;
  };

  if (target.kind === "node") {
    return { level: commonLevel([target.id]), request: { kind: "node", ids: [target.id], token } };
  }
  if (target.kind === "edge") {
    // Концы связи ищем во ВСЕХ классах, которые их несут: «связи в контейнер» и
    // «связи в собственный компонент» (AL32) — по ним считается уровень, на
    // котором связь видна. Класс, концов не несущий, уходит в фолбэк ниже.
    const al =
      alerts.intermediate_edges.find((e) => e.edge_id === target.id) ??
      alerts.descendant_edges.find((e) => e.edge_id === target.id);
    if (!al) return { level: null, request: { kind: "edge", ids: [target.id], token } };
    return {
      level: commonLevel([al.source_id, al.target_id]),
      request: { kind: "edge", ids: [target.id], endIds: [al.source_id, al.target_id], token },
    };
  }
  return { level: commonLevel(target.ids), request: { kind: "group", ids: target.ids, token } };
}
