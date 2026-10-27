// Режим размещения холста «Развёртывание» (docs/specs/deployment.md D29–D30, ТЗ §2а
// п. 8–9). Вход — иконка строки дерева: холст ждёт щелчка по площадке (рамке, карточке
// площадки или карточке объекта в зоне), баннер «Куда поставить «X»?» с «Снять
// размещение» (если у объекта оно есть) и «Отмена», Esc отменяет. Лист ставится на
// площадку сразу; контейнер размещается ЦЕЛИКОМ — набор получают все объекты внутри,
// и если у кого-то размещение иное, сначала подтверждение со списком «объект:
// площадки»; «Снять размещение» у контейнера снимает его у всех объектов внутри — тоже
// с подтверждением. После записи режим закрывается, граф перечитывается, объект на
// уровне выделяется, вне уровня — тост. Смена уровня режим не сбрасывает: площадки на
// всех уровнях одни.
import { useCallback, useEffect, useRef, useState } from "react";
import type { DeploymentGraph, Node as AppNode, SiteOut } from "../types";
import { deploymentApi } from "../api/deployment";
import { nodesApi } from "../api/nodes";
import { loadErrorText } from "../ui/loadErrorText";
import { cardsOf, pickedSite, projectDeployment, type DeploymentProjection } from "../components/deployment/deploymentProjection";
import { hasPlacement, placementConflicts, type PlacementConflict } from "../components/deployment/placementConflicts";

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
  // площадка, куда ставим; null — снятие размещения контейнера
  siteId: string | null;
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
  const placedText = (node: AppNode, siteId: string | null) =>
    siteId ? `„${node.name}“ размещён на „${siteName(siteId)}“` : `Размещение „${node.name}“ снято`;

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

  // Запись набора (площадка или пустой — снятие). Лист — сразу; контейнер — по свежему
  // составу проекта: объекты внутри с иным размещением — сначала подтверждение.
  const write = (node: AppNode, siteId: string | null) => run(async () => {
    const target = siteId ? [siteId] : [];
    if (fresh(node).has_children) {
      const conflicts = placementConflicts(await nodesApi.getAll(), node.id, target);
      if (conflicts.length > 0) {
        setConfirmError(null);
        setConfirm({ node, siteId, siteName: siteId ? siteName(siteId) : "", conflicts });
        return;
      }
    }
    await deploymentApi.setPlacements([node.id], target);
    await finish(node, placedText(node, siteId));
  });
  const placeOn = (node: AppNode, siteId: string) => write(node, siteId);

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

  // «Снять размещение» — у объекта; у контейнера — у всех объектов внутри (с подтверждением).
  const unplace = () => {
    if (placing) void write(placing.node, null);
  };

  // Подтверждение «Разместить»: контейнер целиком. «Отмена» — без записи, режим жив.
  const confirmPlace = async () => {
    if (!confirm || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setConfirmError(null);
    try {
      await deploymentApi.setPlacements([confirm.node.id], confirm.siteId ? [confirm.siteId] : []);
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
    // размещение у объекта есть (у контейнера — хоть у кого-то внутри) — в баннере
    // «Снять размещение»
    hasOwn: placing ? hasPlacement(allNodes, fresh(placing.node)) : false,
    busy, error, confirm, confirmError,
    start, cancel, unplace, confirmPlace, cancelConfirm,
    // задан только в режиме — холст включает выбор площадки щелчком
    pickFrame: placing ? pickFrame : undefined,
  };
}
