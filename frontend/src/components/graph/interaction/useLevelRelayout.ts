// «Переразложить уровень» — КОМАНДА ХОЛСТА (history.md U26, решение владельца 2026-11-24):
// срабатывает сразу, без вопроса, идёт тем же каналом раскладки, что и перемещения
// (useLevelPersistence.commitLayout), и ложится в историю — Ctrl+Z возвращает прежнюю
// расстановку, повтор раскладывает снова. Историю перераскладка больше не чистит.
//
// Сброс считается на клиенте по ДЕЙСТВУЮЩЕЙ раскладке холста (у читателя — с его слоем):
// строки с флагом раскрытия теряют только координаты, остальные строки удаляются — ровно
// как сброс вида на сервере (reset_view_layout, V31) и холста «Развёртывание» (D16, D25),
// одним батчем. Новые авто-позиции конвейер засевает обычным путём (V22). Эндпоинты
// relayout на сервере остаются для MCP и скриптов; холст их не зовёт.
//
// Откат возвращает ПОЗИЦИИ, а не раскрытость (принцип задания П2): x/y строк из снимка до
// сброса, позиции, засеянные после сброса, снимаются; раскрыл или свернул человек рамку
// между делом — так и остаётся. Переезд (C41) и центрирование страниц играются на сбросе,
// отмене и повторе — их запускает onMove, только если запись была.
import { useCallback, useEffect, useEffectEvent, useRef } from "react";
import type { ViewLayout, ViewLayoutPayload } from "../../../types";
import type { LayoutPatch } from "../types";
import type { History, HistoryCommand } from "./useHistory";

// Подпись команды в истории.
const RELAYOUT_LABEL = "Переразложить уровень";

const hasPos = (p: ViewLayoutPayload | undefined): boolean => p?.x != null || p?.y != null;
const hasFlag = (p: ViewLayoutPayload | undefined): boolean => p?.expanded != null;

/** Патч сброса расстановки вида: позиции уходят, флаг раскрытия остаётся. */
export function relayoutPatch(layout: ViewLayout): LayoutPatch {
  const patch: LayoutPatch = {};
  for (const [k, p] of Object.entries(layout)) {
    if (!hasPos(p)) continue;
    patch[k] = hasFlag(p) ? { x: null, y: null } : null;
  }
  return patch;
}

/** Патч возврата позиций до сброса поверх текущей раскладки (раскрытость — текущая). */
export function restorePatch(before: ViewLayout, now: ViewLayout): LayoutPatch {
  const patch: LayoutPatch = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(now)])) {
    const x = before[k]?.x ?? null;
    const y = before[k]?.y ?? null;
    if ((now[k]?.x ?? null) === x && (now[k]?.y ?? null) === y) continue;
    if (x === null && y === null) patch[k] = hasFlag(now[k]) ? { x: null, y: null } : null;
    else patch[k] = { x, y };
  }
  return patch;
}

export function useLevelRelayout({ layout, commitLayout, history, enabled, request, onMove }: {
  // действующая раскладка холста (серверная + слой читателя)
  layout: ViewLayout;
  // стабильная обёртка канала: свежий commitLayout; onFailed — запись окончательно не прошла
  commitLayout: (patch: LayoutPatch, onFailed?: () => void) => boolean;
  // история холста (адаптер штампует уровень команды)
  history: History;
  // расстановка доступна (canArrange): иначе перераскладки нет
  enabled: boolean;
  // запрос хозяина (пункт меню редактора, значок «Развёртывания»): рост токена — команда;
  // значение на маунте не исполняется (переход на уровень его сам не переразложит)
  request?: number;
  // режиссура переезда и центрирование страниц
  onMove: () => void;
}): (() => void) | undefined {
  const layoutRef = useRef(layout);
  useEffect(() => { layoutRef.current = layout; });

  const relayout = useCallback(() => {
    const before = layoutRef.current;
    const cmd: HistoryCommand = {
      label: RELAYOUT_LABEL,
      undo: () => { if (commitLayout(restorePatch(before, layoutRef.current))) onMove(); },
      redo: () => { if (commitLayout(relayoutPatch(layoutRef.current))) onMove(); },
    };
    // Сбой записи (сеть, отказ сервера не 409): канал ресинкает уровень и показывает
    // плашку, а команда снимается — отмена не ведёт в пустоту (A6). 409 переигрывает
    // хозяин без обратного вызова: команда остаётся и при повторном отказе (U26).
    if (!commitLayout(relayoutPatch(before), () => history.remove(cmd))) return;
    onMove();
    history.push(cmd);
  }, [commitLayout, history, onMove]);

  const handledRef = useRef(request);
  const fire = useEffectEvent(() => { if (enabled) relayout(); });
  useEffect(() => {
    if (request === undefined || request === handledRef.current) return;
    handledRef.current = request;
    fire();
  }, [request]);

  return enabled ? relayout : undefined;
}
