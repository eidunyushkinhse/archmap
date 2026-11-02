// Подтверждение последствий как одно действие: ask(preview, имя, цель) отвечает сразу
// «да», если последствий нет, иначе показывает окно (ElementChangeDialog) и ждёт ответа.
// Им пользуются контрол «Элемент архитектуры» и перенос в дереве (только он знает цель).
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import type { ElementChangePreview } from "../../types";
import ElementChangeDialog from "./ElementChangeDialog";
import { hasConsequences } from "./elementChange";

interface Pending {
  preview: ElementChangePreview;
  nodeName: string;
  targetName?: string;
  resolve: (go: boolean) => void;
}

export interface Consequences {
  ask: (preview: ElementChangePreview, nodeName: string, targetName?: string) => Promise<boolean>;
  dialog: ReactNode;
}

export function useConsequences(): Consequences {
  const [pending, setPending] = useState<Pending | null>(null);
  const ask = useCallback((
    preview: ElementChangePreview, nodeName: string, targetName?: string,
  ): Promise<boolean> => {
    if (!hasConsequences(preview)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => setPending({ preview, nodeName, targetName, resolve }));
  }, []);
  const close = (go: boolean) => {
    pending?.resolve(go);
    setPending(null);
  };
  const dialog = pending ? (
    <ElementChangeDialog
      preview={pending.preview}
      nodeName={pending.nodeName}
      targetName={pending.targetName}
      onConfirm={() => close(true)}
      onCancel={() => close(false)}
    />
  ) : null;
  return { ask, dialog };
}
