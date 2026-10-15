import { useCallback, useState } from "react";
import type { FragmentKind, ProcessParticipant } from "../../types";

// Оверлеи холста процесса (аудит F-3): одна запись на открытое окно, в порядке открытия.
// Верхнее — последнее: его закрывает Escape, и рисуется оно последним, то есть поверх
// остальных. Раньше каждое окно было своим useState, порядок наложения — зашит в разметку,
// а приоритет Escape — отдельным списком; подтверждение удаления участника, открытое из
// панели «Участники», оказывалось ПОД панелью. Набранный текст и занятость окна живут
// в его записи: открытие начинает с чистого, закрытие уносит их с собой.
export type Overlay =
  | { kind: "parts" }
  | { kind: "composer"; from: string; to: string }
  | { kind: "self"; pid: string; caption: string }
  | { kind: "msg"; mid: string; caption: string }
  | { kind: "doc"; docId: string; nodeId: string; nodeName: string }
  | { kind: "delPart"; part: ProcessParticipant; busy: boolean; error: string | null }
  | { kind: "branch"; fid: string; index: number | null; guard: string }
  | { kind: "frag"; frag: FragmentKind; fromRow: number; toRow: number; guard: string }
  | { kind: "delFrag"; fid: string }
  | { kind: "bindPart"; pid: string }
  | { kind: "bindConfirm"; participantId: string; nodeId: string; nodeName: string; partName: string };

export type OverlayKind = Overlay["kind"];
export type OverlayOf<K extends OverlayKind> = Extract<Overlay, { kind: K }>;

function isKind<K extends OverlayKind>(o: Overlay, kind: K): o is OverlayOf<K> {
  return o.kind === kind;
}

export interface OverlayStack {
  stack: Overlay[];
  // Окно этого вида, если открыто.
  get: <K extends OverlayKind>(kind: K) => OverlayOf<K> | null;
  // Открыть поверх остальных; окно того же вида, если было, уступает место новому.
  open: (o: Overlay) => void;
  close: (kind: OverlayKind) => void;
  // Поправить открытое окно (набранный текст, занятость); закрытое не воскресает.
  update: <K extends OverlayKind>(kind: K, fn: (o: OverlayOf<K>) => OverlayOf<K>) => void;
}

export function useOverlayStack(): OverlayStack {
  const [stack, setStack] = useState<Overlay[]>([]);
  const open = useCallback((o: Overlay) => {
    setStack((s) => [...s.filter((x) => x.kind !== o.kind), o]);
  }, []);
  const close = useCallback((kind: OverlayKind) => {
    setStack((s) => (s.some((x) => x.kind === kind) ? s.filter((x) => x.kind !== kind) : s));
  }, []);
  const update = useCallback(<K extends OverlayKind>(kind: K, fn: (o: OverlayOf<K>) => OverlayOf<K>) => {
    setStack((s) => s.map((x) => (isKind(x, kind) ? fn(x) : x)));
  }, []);
  const get = <K extends OverlayKind>(kind: K): OverlayOf<K> | null =>
    stack.find((x): x is OverlayOf<K> => isKind(x, kind)) ?? null;
  return { stack, get, open, close, update };
}
