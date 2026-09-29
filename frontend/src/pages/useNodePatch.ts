// CAS-правка полей узла по blur (паттерн NodeInspector, вынесен для переиспользования
// на странице объекта). Коммитит полный NodeUpdate с base_version; при 409 подтягивает
// свежие данные и показывает конфликт-баннер. БЕЗ undo (правки на страницах в историю
// редактора не попадают — ТЗ, решение Ф8-Б).
import { useCallback, useRef, useState } from "react";
import type { Node, NodeDocMeta, NodeSource, NodeUpdate } from "../types";
import { nodesApi } from "../api/nodes";
import { ApiError, isConflict } from "../api/client";
import type { NodeDocEvent } from "../components/inspector/FlowchartDocs";
import { docToMeta } from "../components/inspector/docMeta";

interface NodePatch {
  // Живые значения полей (для контролируемых инпутов)
  name: string;
  description: string;
  role: string;
  technology: string;
  isExternal: boolean;
  status: Node["status"];
  shape: Node["shape"];
  // Сеттеры
  setName: (v: string) => void;
  setDescription: (v: string) => void;
  setRole: (v: string) => void;
  setTechnology: (v: string) => void;
  setIsExternal: (v: boolean) => void;
  setStatus: (v: Node["status"]) => void;
  // Коммит по blur / сразу
  commitName: () => void;
  commitDesc: () => void;
  commitRole: () => void;
  commitTech: () => void;
  // Спека: возвращает ТЕКСТ ОТКАЗА или null, если сохранилось (или менять нечего) —
  // окно спеки ждёт ответа, чтобы показать в просмотре то, что действительно в БД.
  commitOpenapi: (value: string) => Promise<string | null>;
  toggleExternal: () => void;
  pickStatus: (st: Node["status"]) => void;
  // Смена типа узла (форма C4): структурная правка со своими запретами на сервере
  // (дети / описанная структура БД) — отказ приезжает в error, не молчанием.
  pickShape: (sh: Node["shape"]) => void;
  // Якорь (поле «Якорь», components/anchor). Возвращает текст отказа — или null,
  // если сохранилось: 422 обязан остаться ПОД ФОРМОЙ, где его исправляют, а не
  // только в общей плашке страницы. null в аргументе — очистка якоря.
  commitSource: (source: NodeSource | null) => Promise<string | null>;
  // Конфликт CAS
  conflict: string | null;
  // Отказ сервера, НЕ конфликт версий (400 с причиной: смена типа у контейнера,
  // у базы со структурой). Гаснет при следующей успешной правке.
  error: string | null;
  // Свежий узел (после последнего успешного коммита или 409-рефреша)
  node: Node;
  // Мутация меты доков (секция «Логика»): событие FlowchartDocs несёт полные
  // доки — мета (имя/вид/операция) применяется в стейт узла БЕЗ запроса и БЕЗ
  // undo (истории на страницах нет).
  applyDocEvent: (evt: NodeDocEvent) => void;
  // Внешнее освежение (мета узла изменилась в другой сессии — поллинг страницы):
  // применить свежий узел целиком — стейты полей и CAS-база.
  refresh: (fresh: Node) => void;
}

export function useNodePatch(
  initial: Node,
  onSaved?: (saved: Node) => void,
): NodePatch {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? "");
  const [role, setRole] = useState(initial.role ?? "");
  const [technology, setTechnology] = useState(initial.technology ?? "");
  const [isExternal, setIsExternal] = useState(initial.is_external);
  const [status, setStatus] = useState<Node["status"]>(initial.status);
  const [shape, setShape] = useState<Node["shape"]>(initial.shape);
  const [conflict, setConflict] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [node, setNode] = useState(initial);
  const beforeRef = useRef<Node>(initial);

  // Применить свежий узел целиком (409-ресинк и поллинг чужой меты — один код).
  const refresh = useCallback((fresh: Node) => {
    beforeRef.current = fresh;
    setNode(fresh);
    setName(fresh.name);
    setDescription(fresh.description ?? "");
    setRole(fresh.role ?? "");
    setTechnology(fresh.technology ?? "");
    setIsExternal(fresh.is_external);
    setStatus(fresh.status);
    setShape(fresh.shape);
  }, []);

  // Возвращает ТЕКСТ ОТКАЗА или null при успехе. Плашки conflict/error оно
  // выставляет само (как и раньше); возврат нужен полям, которые показывают
  // отказ у себя (якорь) — остальные зовут через void и его игнорируют.
  const save = useCallback(
    async (over: Partial<NodeUpdate>): Promise<string | null> => {
      const before = beforeRef.current;
      const payload: NodeUpdate = {
        name: name.trim() || before.name,
        description: description || null,
        role: role || null,
        technology: technology || null,
        openapi_spec: before.openapi_spec,
        is_external: isExternal,
        shape,
        status,
        ...over,
        base_version: before.version,
      };
      try {
        const saved = await nodesApi.update(before.id, payload);
        beforeRef.current = saved;
        setNode(saved);
        setConflict(null);
        setError(null);
        onSaved?.(saved);
        return null;
      } catch (e: unknown) {
        if (!isConflict(e)) {
          // Не конфликт версий, а ОТКАЗ с причиной (400: смена типа у узла с детьми
          // либо у базы с описанной структурой). Раньше такие ошибки глотались молча —
          // правка «не срабатывала» без единого слова, худший из исходов. Показываем
          // текст сервера и откатываем поля, которые коммитятся сразу, без blur
          // (форма): иначе интерфейс показывал бы тип, которого в БД нет.
          setShape(beforeRef.current.shape);
          setConflict(null);
          const текст = e instanceof ApiError ? e.message : "Правка не сохранена";
          setError(текст);
          return текст;
        }
        try {
          refresh(await nodesApi.get(before.id));
        } catch {
          // узел могли удалить
        }
        setError(null);
        const текст = "Узел изменён в другой сессии — данные обновлены, повторите правку";
        setConflict(текст);
        return текст;
      }
    },
    [name, description, role, technology, isExternal, status, shape, onSaved, refresh],
  );

  const commitName = useCallback(() => {
    const t = name.trim();
    if (!t) { setName(beforeRef.current.name); return; }
    if (t === beforeRef.current.name) return;
    void save({ name: t });
  }, [name, save]);

  const commitDesc = useCallback(() => {
    if (description === (beforeRef.current.description ?? "")) return;
    void save({ description: description || null });
  }, [description, save]);

  const commitRole = useCallback(() => {
    if (role === (beforeRef.current.role ?? "")) return;
    void save({ role: role || null });
  }, [role, save]);

  const commitTech = useCallback(() => {
    if (technology === (beforeRef.current.technology ?? "")) return;
    void save({ technology: technology || null });
  }, [technology, save]);

  const commitOpenapi = useCallback((value: string): Promise<string | null> => {
    if (value === (beforeRef.current.openapi_spec ?? "")) return Promise.resolve(null);
    return save({ openapi_spec: value || null });
  }, [save]);

  const toggleExternal = useCallback(() => {
    const next = !isExternal;
    setIsExternal(next);
    void save({ is_external: next });
  }, [isExternal, save]);

  const pickStatus = useCallback((st: Node["status"]) => {
    if (st === status) return;
    setStatus(st);
    void save({ status: st });
  }, [status, save]);

  const pickShape = useCallback((sh: Node["shape"]) => {
    if (sh === shape) return;
    setShape(sh);
    void save({ shape: sh });
  }, [shape, save]);

  // Якорь в общий payload НЕ входит осознанно: поле source, не присланное в
  // PATCH, якорь не трогает — иначе каждая правка роли переписывала бы отпечаток
  // прогона агента. Кладём его только здесь, через over.
  const commitSource = useCallback(
    (source: NodeSource | null) => save({ source }),
    [save],
  );

  const applyDocEvent = useCallback((evt: NodeDocEvent) => {
    const patchDocs = (mut: (docs: NodeDocMeta[]) => NodeDocMeta[]) => {
      setNode((n) => ({ ...n, docs: mut(n.docs) }));
      beforeRef.current = { ...beforeRef.current, docs: mut(beforeRef.current.docs) };
    };
    if (evt.type === "edit") patchDocs((ds) => ds.map((m) => (m.id === evt.after.id ? docToMeta(evt.after) : m)));
    else if (evt.type === "create") patchDocs((ds) => [...ds, docToMeta(evt.doc)]);
    else patchDocs((ds) => ds.filter((m) => m.id !== evt.doc.id));
  }, []);

  return {
    name, description, role, technology, isExternal, status, shape,
    setName, setDescription, setRole, setTechnology, setIsExternal, setStatus,
    commitName, commitDesc, commitRole, commitTech, commitOpenapi, toggleExternal,
    pickStatus, pickShape, commitSource,
    conflict, error, node, applyDocEvent, refresh,
  };
}
