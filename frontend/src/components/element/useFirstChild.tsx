// Окно первого вложенного объекта (Р4) как одно действие для всех путей появления
// ребёнка: ensure(parentId, childShape) решает план (firstChild.ts), при надобности
// спрашивает окном и записывает элемент родителю, а вызывающему отвечает, продолжать ли
// создание или перенос. Отказ записи (422, сеть) — onError тем же путём, что другие
// правки страницы; ребёнок тогда не создаётся.
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import type { Node, NodeElement, NodeShape } from "../../types";
import { nodesApi } from "../../api/nodes";
import { ApiError } from "../../api/client";
import FirstChildDialog from "./FirstChildDialog";
import { planFirstChild } from "./firstChild";

interface Pending {
  parent: Node;
  preselect: NodeElement;
  resolve: (go: boolean) => void;
}

export interface FirstChild {
  // true — продолжать (элемент записан или выбора не было), false — отмена или отказ.
  ensure: (parentId: string | null, childShape: NodeShape) => Promise<boolean>;
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

  const ensure = useCallback(async (parentId: string | null, childShape: NodeShape): Promise<boolean> => {
    let plan;
    try {
      plan = await planFirstChild(parentId, childShape);
    } catch (e) {
      onError(e instanceof ApiError ? e.message : "Не удалось загрузить объект");
      return false;
    }
    if (plan.kind === "proceed") return true;
    if (plan.kind === "system") return write(plan.parent, "system");
    const { parent, preselect } = plan;
    return new Promise<boolean>((resolve) => setPending({ parent, preselect, resolve }));
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
      preselect={pending.preselect}
      busy={busy}
      onConfirm={(element) => answer(element)}
      onCancel={() => answer(null)}
    />
  ) : null;

  return { ensure, dialog };
}
