import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { processesApi } from "../api/processes";
import type { NodeStatus, ProcessListItem } from "../types";
import { getNodeColors } from "./graph/colors";
import { IcoDots, IcoFlow, IcoPlus } from "./processes/icons";
import { BPT, withAlpha } from "./processes/tokens";
import "./processes/processes.css";

// Производный бейдж процесса из статусов его участников: planned+deprecated → миграция,
// только planned → to-be, только deprecated → вывод, всё existing → бейджа нет.
type BadgeTone = "planned" | "deprecated" | "neutral";
function processBadge(statuses: NodeStatus[]): { t: string; tone: BadgeTone } | null {
  const hasP = statuses.includes("planned");
  const hasD = statuses.includes("deprecated");
  if (hasP && hasD) return { t: "миграция", tone: "neutral" };
  if (hasP) return { t: "to-be", tone: "planned" };
  if (hasD) return { t: "вывод", tone: "deprecated" };
  return null;
}
// Тинт пилюли из статусной палитры (planned/deprecated) или нейтрали (миграция).
function pillStyle(tone: BadgeTone): CSSProperties {
  const base: CSSProperties = {
    flex: "none", fontSize: 9.5, fontWeight: 700, letterSpacing: ".02em",
    padding: "1px 6px", borderRadius: 5, lineHeight: 1.4,
  };
  if (tone === "neutral") return { ...base, color: BPT.sec, background: BPT.line2, border: "1px solid " + BPT.line };
  const sc = getNodeColors(false, 0, tone);
  return { ...base, color: sc.border, background: withAlpha(sc.bg, 0.12), border: "1px solid " + withAlpha(sc.border, 0.4) };
}

/**
 * Тело секции «Бизнес-процессы» левой панели (вынесено из NodeTreePanel).
 * Список процессов + «+ Новый процесс». Сами окна (просмотр/редактор) живут в
 * TreePage — секция лишь дёргает onOpen/onEdit. refreshToken инкрементит TreePage,
 * когда окно процесса закрылось с изменениями (чтобы счётчик сообщений обновился).
 */
interface Props {
  isArchitect: boolean;
  onOpen: (id: string) => void; // открыть просмотр
  onEdit: (id: string) => void; // открыть редактор (архитектор)
  refreshToken: number;
}

export default function BusinessProcessSection({ isArchitect, onOpen, onEdit, refreshToken }: Props) {
  const [items, setItems] = useState<ProcessListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [menuId, setMenuId] = useState<string | null>(null);
  // Куда открывать дропдаун действий: вниз по умолчанию, вверх — если снизу мало места.
  const [menuUp, setMenuUp] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const reload = () => {
    processesApi
      .list()
      .then(setItems)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Не удалось загрузить процессы"));
  };

  useEffect(reload, [refreshToken]);
  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      // Область по умолчанию — вся схема (scope_node_id=null); участников выбирают в редакторе.
      const proc = await processesApi.create({ name: trimmed });
      setName("");
      setCreating(false);
      reload();
      onEdit(proc.id); // сразу в редактор (ТЗ §4.1)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось создать процесс");
    } finally {
      setBusy(false);
    }
  }

  async function duplicate(id: string) {
    setMenuId(null);
    setBusy(true);
    try {
      await processesApi.duplicate(id);
      reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось дублировать процесс");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await processesApi.remove(id);
      setConfirmId(null);
      setMenuId(null);
      reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось удалить процесс");
    } finally {
      setBusy(false);
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter") void create();
    if (e.key === "Escape") {
      setCreating(false);
      setName("");
    }
  }

  return (
    <div className="bp" style={{ padding: "0 2px 2px" }}>
      {isArchitect &&
        (creating ? (
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={onKey}
            onBlur={() => !name.trim() && setCreating(false)}
            placeholder="Название процесса, Enter"
            style={nameInput}
          />
        ) : (
          <button className="bp-newproc" onClick={() => setCreating(true)} disabled={busy}>
            <IcoPlus s={15} />
            <span>Новый процесс</span>
          </button>
        ))}

      {error && <div style={errText}>{error}</div>}

      {items === null && !error ? (
        <div style={hint}>Загрузка…</div>
      ) : items && items.length === 0 ? (
        <div style={hint}>Пока нет процессов</div>
      ) : (
        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 1 }}>
          {items?.map((p) => {
            const badge = processBadge(p.statuses);
            return (
            <div
              key={p.id}
              className="bp-procrow"
              onClick={() => onOpen(p.id)}
              role="button"
              tabIndex={0}
            >
              <span className="bp-procglyph">
                <IcoFlow s={15} />
              </span>
              <span className="bp-proctext">
                <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  <span className="bp-procname" style={{ minWidth: 0 }}>{p.name}</span>
                  {badge && <span style={pillStyle(badge.tone)}>{badge.t}</span>}
                </span>
                <span className="bp-procsub">
                  {p.message_count} {plural(p.message_count)} · {p.scope_name ?? "Вся схема"}
                </span>
              </span>
              <button
                className="bp-procdots"
                title="Действия"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmId(null);
                  const opening = menuId !== p.id;
                  if (opening) {
                    // Высота меню: 4 пункта у архитектора, 1 — у зрителя (с запасом).
                    const estH = isArchitect ? 176 : 52;
                    const r = e.currentTarget.getBoundingClientRect();
                    setMenuUp(window.innerHeight - r.bottom < estH + 12);
                  }
                  setMenuId(opening ? p.id : null);
                }}
              >
                <IcoDots s={15} />
              </button>
              {menuId === p.id && (
                <>
                  {/* подложка-перехватчик клика мимо меню */}
                  <div
                    style={backdrop}
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuId(null);
                      setConfirmId(null);
                    }}
                  />
                  <div className={"bp-procmenu" + (menuUp ? " bp-procmenu--up" : "")} onClick={(e) => e.stopPropagation()}>
                    <button className="bp-menuitem" onClick={() => { setMenuId(null); onOpen(p.id); }}>
                      Открыть
                    </button>
                    {isArchitect && (
                      <>
                        <button className="bp-menuitem" onClick={() => { setMenuId(null); onEdit(p.id); }}>
                          Редактировать
                        </button>
                        <button className="bp-menuitem" onClick={() => void duplicate(p.id)} disabled={busy}>
                          Дублировать
                        </button>
                        {confirmId === p.id ? (
                          <button
                            className="bp-menuitem bp-menuitem--danger"
                            onClick={() => void remove(p.id)}
                            disabled={busy}
                          >
                            Точно удалить?
                          </button>
                        ) : (
                          <button
                            className="bp-menuitem bp-menuitem--danger"
                            onClick={() => setConfirmId(p.id)}
                          >
                            Удалить
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function plural(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "сообщение";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "сообщения";
  return "сообщений";
}

const nameInput: CSSProperties = {
  width: "100%",
  height: 36,
  padding: "0 11px",
  border: "1px solid #93c5fd",
  borderRadius: 9,
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
};
const hint: CSSProperties = { fontSize: 12.5, color: "#94a3b8", padding: "10px 6px" };
const errText: CSSProperties = { fontSize: 12, color: "#dc2626", padding: "8px 6px 0" };
const backdrop: CSSProperties = { position: "fixed", inset: 0, zIndex: 7 };
