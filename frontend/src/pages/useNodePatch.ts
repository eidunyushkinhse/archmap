// CAS-правка полей узла по blur (паттерн NodeInspector, вынесен для переиспользования
// на странице объекта). Коммитит полный NodeUpdate с base_version; при 409 подтягивает
// свежие данные и показывает конфликт-баннер. БЕЗ undo (правки на страницах в историю
// редактора не попадают — ТЗ, решение Ф8-Б).
import { useCallback, useRef, useState } from "react";
import type { Node, NodeUpdate } from "../types";
import { nodesApi } from "../api/nodes";
import { isConflict } from "../api/client";

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
  toggleExternal: () => void;
  pickStatus: (st: Node["status"]) => void;
  // Конфликт CAS
  conflict: string | null;
  // Свежий узел (после последнего успешного коммита или 409-рефреша)
  node: Node;
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
          const fresh = await nodesApi.get(before.id);
          beforeRef.current = fresh;
          setNode(fresh);
          setName(fresh.name);
          setDescription(fresh.description ?? "");
          setRole(fresh.role ?? "");
          setTechnology(fresh.technology ?? "");
          setIsExternal(fresh.is_external);
          setStatus(fresh.status);
        } catch {
          // узел могли удалить
        }
        setConflict("Узел изменён в другой сессии — данные обновлены, повторите правку");
      }
    },
    [name, description, role, technology, isExternal, status, onSaved],
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

  return {
    name, description, role, technology, isExternal, status,
    setName, setDescription, setRole, setTechnology, setIsExternal, setStatus,
    commitName, commitDesc, commitRole, commitTech, toggleExternal, pickStatus,
    conflict, node,
  };
}
