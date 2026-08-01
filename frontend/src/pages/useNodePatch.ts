// CAS-правка полей узла по blur (паттерн NodeInspector, вынесен для переиспользования
// на странице объекта). Коммитит полный NodeUpdate с base_version; при 409 подтягивает
// свежие данные и показывает конфликт-баннер. БЕЗ undo (правки на страницах в историю
// редактора не попадают — ТЗ, решение Ф8-Б).
import { useCallback, useRef, useState } from "react";
import type { Node, NodeDoc, NodeDocMeta, NodeUpdate } from "../types";
import { nodesApi } from "../api/nodes";
import { isConflict } from "../api/client";
import type { NodeDocEvent } from "../components/inspector/FlowchartDocs";

interface NodePatch {
  // Живые значения полей (для контролируемых инпутов)
  name: string;
  description: string;
  role: string;
  technology: string;
  isExternal: boolean;
  status: Node["status"];
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
  commitOpenapi: (value: string) => void;
  toggleExternal: () => void;
  pickStatus: (st: Node["status"]) => void;
  // Конфликт CAS
  conflict: string | null;
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
  const [conflict, setConflict] = useState<string | null>(null);
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
  }, []);

  const save = useCallback(
    async (over: Partial<NodeUpdate>) => {
      const before = beforeRef.current;
      const payload: NodeUpdate = {
        name: name.trim() || before.name,
        description: description || null,
        role: role || null,
        technology: technology || null,
        openapi_spec: before.openapi_spec,
        is_external: isExternal,
        shape: before.shape,
        status,
        ...over,
        base_version: before.version,
      };
      try {
        const saved = await nodesApi.update(before.id, payload);
        beforeRef.current = saved;
        setNode(saved);
        setConflict(null);
        onSaved?.(saved);
      } catch (e: unknown) {
        if (!isConflict(e)) return;
        try {
          refresh(await nodesApi.get(before.id));
        } catch {
          // узел могли удалить
        }
        setConflict("Узел изменён в другой сессии — данные обновлены, повторите правку");
      }
    },
    [name, description, role, technology, isExternal, status, onSaved, refresh],
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

  const commitOpenapi = useCallback((value: string) => {
    if (value === (beforeRef.current.openapi_spec ?? "")) return;
    void save({ openapi_spec: value || null });
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

  const applyDocEvent = useCallback((evt: NodeDocEvent) => {
    // version — в сигнатуру меты поллинга (V53): правка КОНТЕНТА доков видна
    // странице как изменение данных даже без смены имени/вида.
    const meta = (d: NodeDoc): NodeDocMeta => ({ id: d.id, name: d.name, kind: d.kind, operation: d.operation, version: d.version });
    const patchDocs = (mut: (docs: NodeDocMeta[]) => NodeDocMeta[]) => {
      setNode((n) => ({ ...n, docs: mut(n.docs) }));
      beforeRef.current = { ...beforeRef.current, docs: mut(beforeRef.current.docs) };
    };
    if (evt.type === "edit") patchDocs((ds) => ds.map((m) => (m.id === evt.after.id ? meta(evt.after) : m)));
    else if (evt.type === "create") patchDocs((ds) => [...ds, meta(evt.doc)]);
    else patchDocs((ds) => ds.filter((m) => m.id !== evt.doc.id));
  }, []);

  return {
    name, description, role, technology, isExternal, status,
    setName, setDescription, setRole, setTechnology, setIsExternal, setStatus,
    commitName, commitDesc, commitRole, commitTech, commitOpenapi, toggleExternal, pickStatus,
    conflict, node, applyDocEvent, refresh,
  };
}
