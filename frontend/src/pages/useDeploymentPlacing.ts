// Режим размещения холста «Развёртывание» (docs/specs/deployment.md D29–D30, ТЗ §2а
// п. 8–9). Вход — иконка строки дерева: холст ждёт щелчка по площадке (рамке, карточке
// площадки или карточке объекта в зоне), баннер «Куда поставить «X»?» с «Снять
// размещение» (если у объекта есть своё) и «Отмена», Esc отменяет. Лист ставится на
// площадку сразу; контейнер размещается ЦЕЛИКОМ — своё размещение объектов внутри
// снимается, и если у кого-то оно на других площадках, сначала подтверждение со списком
// «объект: площадки». После записи режим закрывается, граф перечитывается, объект на
// уровне выделяется, вне уровня — тост. Смена уровня режим не сбрасывает: площадки на
// всех уровнях одни.
import { useCallback, useEffect, useRef, useState } from "react";
import type { DeploymentGraph, Node as AppNode, SiteOut } from "../types";
import { deploymentApi } from "../api/deployment";
import { nodesApi } from "../api/nodes";
import { loadErrorText } from "../ui/loadErrorText";
import { cardsOf, pickedSite, projectDeployment, type DeploymentProjection } from "../components/deployment/deploymentProjection";
import { ownSites, placementConflicts, type PlacementConflict } from "../components/deployment/placementConflicts";

interface Args {
  proj: DeploymentProjection | null;
  // площадки графа — имена для тоста и подтверждения
  sites: readonly SiteOut[];
  // все объекты проекта (перечитываются после записи): своё размещение и has_children
  allNodes: readonly AppNode[];
  // запись прошла: хозяин перечитывает граф (стрелки — анимированно) и список объектов;
  // отдаёт применённый граф уровня (null — не перечитался, догонит поллинг)
  onWritten: () => Promise<DeploymentGraph | null>;
  // объект на уровне — выделить его карточки на холсте
  onShow: (cardIds: string[]) => void;
  // объекта на уровне нет — сообщить тостом
  onToast: (text: string) => void;
}

export interface PlacingConfirm {
  node: AppNode;
  siteId: string;
  siteName: string;
  conflicts: PlacementConflict[];
}

export function useDeploymentPlacing({ proj, sites, allNodes, onWritten, onShow, onToast }: Args) {
  const [placing, setPlacing] = useState<{ node: AppNode } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<PlacingConfirm | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  // Запись в полёте: второй щелчок того же двойного клика не пишет второй раз.
  const busyRef = useRef(false);

  const fresh = (node: AppNode): AppNode => allNodes.find((n) => n.id === node.id) ?? node;
  const siteName = (siteId: string): string => sites.find((s) => s.id === siteId)?.name ?? "площадку";

  const start = useCallback((node: AppNode) => {
    setPlacing({ node });
    setError(null);
  }, []);
  const cancel = useCallback(() => {
    setPlacing(null);
    setError(null);
  }, []);

  // Esc отменяет режим. Пока открыто окно (подтверждение, «Площадки»), Esc принадлежит
  // ему: нативный <dialog> сам владеет своим Escape (ui/Modal) — не перехватываем.
  useEffect(() => {
    if (!placing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (confirm || document.querySelector("dialog[open]")) return;
      cancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [placing, confirm, cancel]);

  // Записано: режим закрыть, граф перечитать; объект на уровне — выделить, нет — тост.
  const finish = async (node: AppNode, toast: string) => {
    setPlacing(null);
    setConfirm(null);
    setError(null);
    const graph = await onWritten();
    if (!graph) return;
    const cards = cardsOf(projectDeployment(graph), node.id);
    if (cards.length > 0) onShow(cards);
    else onToast(toast);
  };
  const placedText = (node: AppNode, siteId: string) => `„${node.name}“ размещён на „${siteName(siteId)}“`;

  const run = async (write: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await write();
    } catch (e) {
      setError(`Не удалось разместить. ${loadErrorText(e)}`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  // Щелчок по площадке. Лист — сразу; контейнер — по свежему составу проекта: свои
  // размещения внутри на других площадках — сначала подтверждение.
  const placeOn = (node: AppNode, siteId: string) => run(async () => {
    const container = fresh(node).has_children;
    if (container) {
      const conflicts = placementConflicts(await nodesApi.getAll(), node.id, [siteId]);
      if (conflicts.length > 0) {
        setConfirmError(null);
        setConfirm({ node, siteId, siteName: siteName(siteId), conflicts });
        return;
      }
    }
    if (container) await deploymentApi.setPlacements([node.id], [siteId], { clearDescendants: true });
    else await deploymentApi.setPlacements([node.id], [siteId]);
    await finish(node, placedText(node, siteId));
  });

  // Колбэк холста (projection.pickFrame): id рамки или карточки → площадка; группа «не
  // указано» — не площадка, режим остаётся. Наружу — стабильная обёртка над свежим
  // обработчиком (latest-ref): бандл проекции не пересобирается на каждый рендер.
  const pickNow = (canvasId: string) => {
    if (!placing || confirm || !proj) return;
    const siteId = pickedSite(proj, canvasId);
    if (siteId) void placeOn(placing.node, siteId);
  };
  const pickRef = useRef(pickNow);
  useEffect(() => { pickRef.current = pickNow; });
  const pickFrame = useCallback((canvasId: string) => pickRef.current(canvasId), []);

  // «Снять размещение» — своё размещение объекта; у контейнера объекты внутри не трогаем.
  const unplace = () => {
    if (!placing) return;
    const node = placing.node;
    void run(async () => {
      await deploymentApi.setPlacements([node.id], []);
      await finish(node, `Своё размещение „${node.name}“ снято`);
    });
  };

  // Подтверждение «Разместить»: контейнер целиком. «Отмена» — без записи, режим жив.
  const confirmPlace = async () => {
    if (!confirm || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setConfirmError(null);
    try {
      await deploymentApi.setPlacements([confirm.node.id], [confirm.siteId], { clearDescendants: true });
      await finish(confirm.node, placedText(confirm.node, confirm.siteId));
    } catch (e) {
      setConfirmError(`Не удалось разместить. ${loadErrorText(e)}`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const cancelConfirm = () => { setConfirm(null); setConfirmError(null); };

  return {
    placing: placing?.node ?? null,
    // своё размещение у объекта есть — в баннере «Снять размещение»
    hasOwn: placing ? ownSites(fresh(placing.node)).length > 0 : false,
    busy, error, confirm, confirmError,
    start, cancel, unplace, confirmPlace, cancelConfirm,
    // задан только в режиме — холст включает выбор площадки щелчком
    pickFrame: placing ? pickFrame : undefined,
  };
}
