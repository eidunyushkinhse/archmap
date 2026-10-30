// Окно первого вложенного объекта (Р38) как одно действие перед переносом объекта в лист:
// ensure(parentId, child) решает план (firstChild.ts), при надобности спрашивает окном,
// что такое переносимый внутри цели, и записывает элемент цели, а вызывающему отвечает,
// продолжать ли перенос. Отказ записи (422, сеть) — onError тем же путём, что другие
// правки страницы; объект тогда не переносится.
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import type { Node, NodeElement } from "../../types";
import { nodesApi } from "../../api/nodes";
import { ApiError } from "../../api/client";
import FirstChildDialog from "./FirstChildDialog";
import { planFirstChild, type MovedChild } from "./firstChild";

interface Pending {
  parent: Node;
  childName: string;
  preselect: NodeElement;
  resolve: (go: boolean) => void;
}

export interface FirstChild {
  // true — продолжать (элемент записан или выбора не было), false — отмена или отказ.
  ensure: (parentId: string | null, child: MovedChild) => Promise<boolean>;
  // Окно, пока ждём ответа (рисуется вызывающим рядом с остальными окнами).
  dialog: ReactNode;
}

function failText(parent: Node, e: unknown): string {
  const why = e instanceof ApiError ? e.message : "нет связи с сервером";
  return `Не удалось изменить «${parent.name}»: ${why}`;
}

// onError — стабильная функция показа отказа (тост страницы, useMessageToast).
export function useFirstChild(onError: (text: string) => void): FirstChild {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  const write = useCallback(async (parent: Node, element: NodeElement): Promise<boolean> => {
    try {
      await nodesApi.update(parent.id, { element });
      return true;
    } catch (e) {
      onError(failText(parent, e));
      return false;
    }
  }, [onError]);

  const ensure = useCallback(async (parentId: string | null, child: MovedChild): Promise<boolean> => {
    let plan;
    try {
      plan = await planFirstChild(parentId, child);
    } catch (e) {
      onError(e instanceof ApiError ? e.message : "Не удалось загрузить объект");
      return false;
    }
    if (plan.kind === "proceed") return true;
    if (plan.kind === "system") return write(plan.parent, "system");
    const { parent, preselect } = plan;
    return new Promise<boolean>((resolve) => setPending({ parent, childName: child.name, preselect, resolve }));
  }, [write, onError]);

  const answer = (element: NodeElement | null) => {
    const p = pending;
    if (!p) return;
    if (element === null) {
      setPending(null);
      p.resolve(false);
      return;
    }
    setBusy(true);
    void write(p.parent, element).then((ok) => {
      setBusy(false);
      setPending(null);
      p.resolve(ok);
    });
  };

  const dialog = pending ? (
    <FirstChildDialog
      parentName={pending.parent.name}
      childName={pending.childName}
      preselect={pending.preselect}
      busy={busy}
      onConfirm={(element) => answer(element)}
      onCancel={() => answer(null)}
    />
  ) : null;

  return { ensure, dialog };
}
