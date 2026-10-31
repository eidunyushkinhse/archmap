// Перенос документации по элементу архитектуры со страницы объекта (Р19): окна
// «Перенести документацию» и «Собрать с компонентов» и превью сбора, по которому
// страница решает, показывать ли кнопку сбора. Превью запрашивается один раз у
// контейнера с компонентами (и заново после записи — по эпохе страницы); у системы и
// листа сбора нет, запроса тоже. Окно сбора получает превью, снятое в момент открытия:
// после записи оно показывает итог, а превью страницы тем временем перечитывается и
// может опустеть — окно с итогом от этого не закрывается.
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { CollectFactsPreview, Node } from "../../types";
import { nodesApi } from "../../api/nodes";
import TransferDocsModal from "../TransferDocsModal";
import CollectFactsModal from "../CollectFactsModal";

export interface FactsTransfer {
  openTransfer: () => void;
  // «Собрать с компонентов» из секции конфигурации и из «OpenAPI»: undefined — по этой
  // семье собирать нечего (или узел не контейнер с компонентами, или не редактор).
  collectParams: (() => void) | undefined;
  collectSpec: (() => void) | undefined;
  dialogs: ReactNode;
}

export function useFactsTransfer(
  node: Node, isArchitect: boolean, epoch: number, onApplied: () => void,
): FactsTransfer {
  const [transferOpen, setTransferOpen] = useState(false);
  // Превью, с которым открыто окно сбора; null — окно закрыто.
  const [collecting, setCollecting] = useState<CollectFactsPreview | null>(null);
  const [preview, setPreview] = useState<CollectFactsPreview | null>(null);
  const collectable = isArchitect && node.element_effective === "container" && node.has_children;

  useEffect(() => {
    if (!collectable) return;
    let alive = true;
    nodesApi.collectPreview(node.id)
      .then((p) => { if (alive) setPreview(p); })
      // Превью — повод показать кнопку, а не опора страницы: сбой — кнопки нет.
      .catch(() => { if (alive) setPreview(null); });
    return () => { alive = false; };
  }, [node.id, collectable, epoch]);

  const live = collectable && preview !== null && preview.components.length > 0 ? preview : null;
  const openTransfer = useCallback(() => setTransferOpen(true), []);
  const openCollect = useCallback(() => setCollecting(live), [live]);

  return {
    openTransfer,
    collectParams: live?.components.some((c) => c.params > 0) ? openCollect : undefined,
    collectSpec: live?.components.some((c) => c.has_spec) ? openCollect : undefined,
    dialogs: (
      <>
        {transferOpen && (
          <TransferDocsModal nodeId={node.id} onClose={() => setTransferOpen(false)} onApplied={onApplied} />
        )}
        {collecting && (
          <CollectFactsModal
            nodeId={node.id}
            nodeName={node.name}
            preview={collecting}
            onClose={() => setCollecting(null)}
            onApplied={onApplied}
          />
        )}
      </>
    ),
  };
}
