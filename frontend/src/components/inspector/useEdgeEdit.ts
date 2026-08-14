// Логика редактирования связи: черновики полей, CAS-коммит (валидация концов,
// петли и дублей, обработка 409) и инверсия направления. Вынесено из
// EdgeInspector (правая панель редактора-карты), чтобы тот же механизм
// переиспользовала модалка-редактор связи на странице объекта (EdgeEditModal).
import { useRef, useState } from "react";
import type { Edge, EdgeUpdate } from "../../types";
import { edgesApi, nodesApi } from "../../api/nodes";
import { isConflict } from "../../api/client";

// Исходные данные связи для правки: РЕАЛЬНЫЕ концы (не проекция на уровень)
// с именами для подписей пикеров и версия для CAS.
export interface EdgeEditInitial {
  id: string;
  label: string | null;
  technology: string | null;
  // Канал брокера, названный связью (Ф3 брокеров): правится тем же коммитом и
  // обязан ездить в undo/redo — поле, забытое в списке, история теряет молча.
  channel: string | null;
  source_id: string;
  target_id: string;
  version: number;
  source_name: string;
  target_name: string;
}

// Минимальные данные существующей связи — для проверки дублей при коммите.
export interface EdgeDuplicateRef {
  id: string;
  source_id: string;
  target_id: string;
}

// Поля, переопределяемые в коммите: значение из события (blur/выбор конца),
// которое ещё не попало в state (setState асинхронный).
export type EdgeEditOverride = Partial<{
  label: string;
  technology: string;
  channel: string;
  source_id: string;
  target_id: string;
}>;

/**
 * Хук редактирования связи. Коммит — auto (по blur/смене конца, как в
 * EdgeInspector): вызывающий сам решает, когда звать commit(over).
 *
 * existingEdges — НЕОБЯЗАТЕЛЬНАЯ проверка дублей: связь с такой же парой
 * концов (source_id+target_id) уже существует → отказ до запроса. Редактор-карта
 * список не передаёт (его поведение исторически без этой проверки); модалка
 * страницы передаёт все связи проекта. Обратная пара (B→A при существующей
 * A→B) дублем НЕ считается — встречные взаимодействия легитимны.
 *
 * onSaved зовётся после успешного PATCH с payloads для истории (undo/redo) —
 * в модалке страницы история отсутствует, колбэк там только освежает таблицу.
 */
export function useEdgeEdit(
  initial: EdgeEditInitial,
  onSaved: (updated: Edge, undoPayload: EdgeUpdate, redoPayload: EdgeUpdate) => void,
  existingEdges?: EdgeDuplicateRef[],
) {
  const [labelText, setLabelText] = useState(initial.label ?? "");
  const [technology, setTechnology] = useState(initial.technology ?? "");
  const [channel, setChannel] = useState(initial.channel ?? "");
  const [sourceId, setSourceId] = useState(initial.source_id);
  const [targetId, setTargetId] = useState(initial.target_id);
  const [srcLabel, setSrcLabel] = useState(initial.source_name);
  const [tgtLabel, setTgtLabel] = useState(initial.target_name);
  const [error, setError] = useState<string | null>(null);

  // Состояние ДО последней правки — для обратимой записи в историю (undoPayload).
  // Хэндлов в контракте связи больше нет (R3): геометрия живёт на пучке в view_layout.
  const beforeRef = useRef<EdgeUpdate>({
    label: initial.label ?? null,
    technology: initial.technology ?? null,
    channel: initial.channel ?? null,
    source_id: initial.source_id,
    target_id: initial.target_id,
  });
  // Версия связи для CAS (этап 0 конкурентности): правка от устаревшей → 409.
  const versionRef = useRef(initial.version);
  // Коммит в работе: повторный вызов (blur инпута + клик «Готово» в модалке)
  // дожидается его и идёт поверх свежей версии — иначе второй PATCH с той же
  // base_version получал бы ложный 409.
  const inflightRef = useRef<Promise<boolean> | null>(null);

  async function doCommit(over: EdgeEditOverride): Promise<boolean> {
    const src = over.source_id ?? sourceId;
    const tgt = over.target_id ?? targetId;
    if (!src || !tgt) { setError("Выберите исходный и целевой объекты"); return false; }
    if (src === tgt) { setError("Объект не может ссылаться сам на себя"); return false; }
    // Дубль: другая связь с той же парой концов уже есть (своя пара — не дубль).
    if (existingEdges?.some((e) => e.id !== initial.id && e.source_id === src && e.target_id === tgt)) {
      setError("Связь между этими объектами уже есть");
      return false;
    }
    setError(null);
    const redo: EdgeUpdate = {
      label: (over.label ?? labelText) || null,
      technology: (over.technology ?? technology) || null,
      channel: (over.channel ?? channel) || null,
      source_id: src,
      target_id: tgt,
    };
    const before = beforeRef.current;
    // no-op: ничего не изменилось — не плодим записи истории
    if (redo.label === (before.label ?? null) && redo.technology === (before.technology ?? null)
      && redo.channel === (before.channel ?? null)
      && redo.source_id === before.source_id && redo.target_id === before.target_id) return true;
    const undo: EdgeUpdate = { ...before };
    try {
      // CAS: base_version — версия последнего сохранённого; в историю (undo/redo)
      // уходят payload'ы БЕЗ base_version — компенсации не фенсятся (U24).
      const updated = await edgesApi.update(initial.id, { ...redo, base_version: versionRef.current });
      onSaved(updated, undo, redo);
      versionRef.current = updated.version;
      beforeRef.current = {
        label: updated.label ?? null,
        technology: updated.technology ?? null,
        channel: updated.channel ?? null,
        source_id: updated.source_id,
        target_id: updated.target_id,
      };
      return true;
    } catch (e: unknown) {
      if (isConflict(e)) {
        // Связь изменена в другой сессии: правка не применилась — подтягиваем
        // свежие данные (включая имена концов) и просим повторить поверх них.
        try {
          const fresh = await edgesApi.get(initial.id);
          versionRef.current = fresh.version;
          beforeRef.current = {
            label: fresh.label ?? null,
            technology: fresh.technology ?? null,
            channel: fresh.channel ?? null,
            source_id: fresh.source_id,
            target_id: fresh.target_id,
          };
          setLabelText(fresh.label ?? "");
          setTechnology(fresh.technology ?? "");
          setChannel(fresh.channel ?? "");
          setSourceId(fresh.source_id);
          setTargetId(fresh.target_id);
          const [s, t] = await Promise.all([
            nodesApi.get(fresh.source_id).catch(() => null),
            nodesApi.get(fresh.target_id).catch(() => null),
          ]);
          if (s) setSrcLabel(s.name);
          if (t) setTgtLabel(t.name);
        } catch {
          // связь могли удалить — уровень догонит поллинг/ресинк
        }
        setError("Связь изменена в другой сессии — данные обновлены, повторите правку");
        return false;
      }
      setError(e instanceof Error ? e.message : "Ошибка сохранения");
      return false;
    }
  }

  // Коммит правки. true — сохранилось (включая no-op), false — отказ.
  async function commit(over: EdgeEditOverride): Promise<boolean> {
    if (inflightRef.current) await inflightRef.current;
    const p = doCommit(over);
    inflightRef.current = p;
    try {
      return await p;
    } finally {
      if (inflightRef.current === p) inflightRef.current = null;
    }
  }

  // Инверсия направления: концы меняются местами, описание/технология остаются
  // на связи. Стейт обновляется оптимистично, коммит — сразу с новыми концами
  // (setState асинхронный, поэтому в over уходят перевёрнутые значения явно).
  function invert(): void {
    setSourceId(targetId);
    setTargetId(sourceId);
    setSrcLabel(tgtLabel);
    setTgtLabel(srcLabel);
    void commit({ source_id: targetId, target_id: sourceId });
  }

  return {
    labelText, setLabelText,
    technology, setTechnology,
    channel, setChannel,
    sourceId, setSourceId,
    targetId, setTargetId,
    srcLabel, setSrcLabel,
    tgtLabel, setTgtLabel,
    error, setError,
    commit,
    invert,
  };
}
