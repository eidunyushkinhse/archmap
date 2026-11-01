import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { Node, NodeCreate, NodeElement, NodeStatus } from "../types";
import { getNodeColors, STATUS_META } from "./graph/colors";
import { nodesApi, viewsApi } from "../api/nodes";
import Modal from "../ui/Modal";
import { labelStyle, input, primaryBtn, secondaryBtn } from "../ui/styles";
import { useScrollEdges } from "../ui/useScrollEdges";
import { CloseIcon } from "../ui/icons";
import "../ui/modalShell.css";
import { limitMessage } from "./demo/demoLimits";
import type { LimitMessage } from "./demo/demoLimits";
import { LimitText } from "./demo/DemoLimitToast";
import { emitTourEvent } from "./tour/tourBus";
import { noAutofill } from "../ui/noAutofill";
import { loadErrorText } from "../ui/loadErrorText";
import { useAsyncLoad } from "../lib/useAsyncLoad";
import { STATUS_ORDER, shapeOfType, type NodeType } from "./nodeTerms";
import { preselectType, typeOptions } from "./element/typeOptions";
import { awaitsFirstChild } from "./element/elementView";
import TypeSelect from "./element/TypeSelect";

// Модалка СОЗДАНИЯ объекта. Просмотр и правка существующего узла переехали в правую
// панель схемы (inspector/NodeInspector) — здесь осталась только форма нового объекта:
// «+» в дереве и бросок шаблона из палитры на схему.
//
// Первое поле — «Тип» (Р36 раздела 13 docs/plan-c4-elements.md), обязательное: какие из
// шести типов возможны под этим родителем, решает typeOptions, серые — с объяснением.
// Родителя и соседей окно загружает само по parentId: по ним — варианты и предвыбор
// (тип шаблона, «Компонент» внутри контейнера, тип последнего созданного соседа). У
// листа-сервиса без элемента выбор задаёт и родителя (Р38): строка под полем говорит,
// кем он станет, а запрос несёт parent_element — родитель и ребёнок пишутся вместе.
interface Props {
  parentId: string | null;
  // Тип шаблона из палитры: предвыбран, если возможен в этом месте.
  type?: NodeType;
  // Координаты, куда бросили шаблон на схему.
  initialPos?: { x: number; y: number } | null;
  // Вид, в который писать позицию дропа. Задан ТОЛЬКО при дропе в раскрытую рамку:
  // тогда parentId — контейнер рамки, а позиция принадлежит виду ТЕКУЩЕГО уровня
  // (posView), а не виду parentId (иначе узел появился бы в рамке не там, где брошен).
  // undefined — обычный дроп: позицию кладёт сам POST /nodes (в вид parentId).
  posView?: string | null;
  onClose: () => void;
  // isCreate всегда true — но сигнатуру держим общей с inline-правкой в панели.
  onSaved: (node: Node, isCreate: boolean) => void;
}

// Родитель (null — верхний уровень) и его вложенные объекты — то, по чему считаются
// варианты поля «Тип» и предвыбор.
interface Place {
  parent: Node | null;
  siblings: Node[];
}

export default function NodeModal({ parentId, type: templateType, initialPos, posView, onClose, onSaved }: Props) {
  // Дроп в раскрытую рамку: позицию пишем отдельным батчем в вид текущего уровня.
  const intoFrame = posView !== undefined;
  const [picked, setPicked] = useState<NodeType | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [role, setRole] = useState("");
  const [technology, setTechnology] = useState("");
  const [isExternal, setIsExternal] = useState(false);
  const [status, setStatus] = useState<NodeStatus>("existing");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Демо-стенд: проект упёрся в предел — тот же текст, что в тосте холста.
  const [limit, setLimit] = useState<LimitMessage | null>(null);

  // Соседи — те же ручки, что у дерева объектов (nodeTree.useLazyTree): корень и дети узла.
  const place = useAsyncLoad<Place>(`node-modal:${parentId ?? ""}`, async () => {
    const [parent, siblings] = await Promise.all([
      parentId ? nodesApi.get(parentId) : Promise.resolve(null),
      parentId ? nodesApi.getChildren(parentId) : nodesApi.list(null),
    ]);
    return { parent, siblings };
  });
  const parent = place.data?.parent ?? null;
  const options = useMemo(
    () => (place.data ? typeOptions({ mode: "create", parent: place.data.parent }) : []),
    [place.data],
  );
  // Предвыбор — производное от загруженного места; выбор человека его перекрывает.
  const preselect = useMemo(
    () => (place.data ? preselectType(options, place.data.parent, place.data.siblings, templateType ?? null) : null),
    [options, place.data, templateType],
  );
  const type = picked ?? preselect;
  const note = options.find((o) => o.type === type)?.note;
  // Поля по форме типа: у «Пользователя» нет технологии и внешности.
  const isPerson = type === "person";

  const { atTop, atBottom, topRef, bottomRef } = useScrollEdges(false);
  const headerClass = `modal-header${atTop ? " modal-header--at-top" : ""}`;
  const footerClass = `modal-footer${atBottom ? " modal-footer--at-bottom" : ""}`;

  async function handleSave() {
    if (saving) return; // Enter во время сохранения — как неактивная кнопка
    if (!type) {
      setError("Выберите тип объекта");
      return;
    }
    if (!name.trim()) {
      setError("Название обязательно");
      return;
    }
    setSaving(true);
    setError(null);
    setLimit(null);
    try {
      // Тип в модели — форма и элемент: система и контейнер пишутся элементом,
      // компонентом объект делает место (внутри контейнера), а не поле.
      const element: NodeElement | null = type === "system" || type === "container" ? type : null;
      // Первый вложенный объект листа задаёт его элемент (Р38): компонент — контейнер,
      // любой другой тип — система.
      const parentElement: NodeElement | null = parent && awaitsFirstChild(parent)
        ? (type === "component" ? "container" : "system")
        : null;
      const data: NodeCreate = {
        name: name.trim(),
        description: description || null,
        role: role || null,
        technology: isPerson ? null : technology || null,
        parent_id: parentId,
        // Доки и спека в создание не входят: они добавляются на странице объекта.
        is_external: isPerson ? false : isExternal,
        shape: shapeOfType(type),
        status,
        ...(element ? { element } : {}),
        ...(parentElement ? { parent_element: parentElement } : {}),
        // При дропе в рамку позицию НЕ отдаём POST-у (он положил бы её в вид parentId) —
        // пишем ниже в вид текущего уровня. Обычный дроп — как раньше, позицию кладёт POST.
        pos_x: intoFrame ? null : (initialPos?.x ?? null),
        pos_y: intoFrame ? null : (initialPos?.y ?? null),
      };
      const saved = await nodesApi.create(data);
      // Дроп в рамку: позиция принадлежит виду ТЕКУЩЕГО уровня (posView), не виду parentId.
      if (intoFrame && initialPos) {
        await viewsApi.saveLayout(posView ?? null, { [saved.id]: { x: initialPos.x, y: initialPos.y } });
      }
      // Обучающий тур демо-стенда ждёт созданные объекты (docs/tasks/demo-tour.md).
      emitTourEvent({ type: "node-created", id: saved.id, name: saved.name, shape: saved.shape, parentId: saved.parent_id ?? null });
      onSaved(saved, true);
    } catch (e: unknown) {
      const refusal = limitMessage(e, "node");
      if (refusal) setLimit(refusal);
      else setError(e instanceof Error ? e.message : "Ошибка сохранения");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} onSubmit={handleSave} closeButton={false} boxStyle={{ width: 560, maxHeight: "90vh", overflowY: "auto" }}>
      <div ref={topRef} style={{ height: 1 }} aria-hidden />
      <div className={headerClass}>
        <h2>Новый объект</h2>
        <button onClick={onClose} className="modal-close" aria-label="Закрыть">
          <CloseIcon />
        </button>
      </div>

      <label style={labelStyle}>Тип *</label>
      {place.error ? (
        // Без родителя варианты не посчитать: причина и «Повторить» прямо в окне.
        <div role="alert" style={loadFail}>
          <span style={{ flex: 1 }}>
            Не удалось узнать, какие типы возможны здесь.
            <span style={loadFailDetail}>{loadErrorText(place.error)}</span>
          </span>
          <button type="button" style={retryBtn} onClick={place.reload}>Повторить</button>
        </div>
      ) : place.loading ? (
        <div style={{ ...input, color: "#94a3b8" }}>Загрузка…</div>
      ) : (
        <div style={typeField}>
          <TypeSelect
            value={type}
            options={options}
            onPick={(t) => { setPicked(t); setError(null); }}
            triggerClass="ts-field"
            chevron={<span className="ts-chev"><ChevronDown /></span>}
            label="Тип"
          />
        </div>
      )}
      {note && <p style={noteStyle}>{note}</p>}

      <label style={labelStyle}>Название *</label>
      <input {...noAutofill("node-modal-1")} value={name} onChange={(e) => setName(e.target.value)} style={input} data-autofocus />

      <label style={labelStyle}>Описание</label>
      <textarea {...noAutofill("node-modal-2")} value={description} onChange={(e) => setDescription(e.target.value)} style={textarea} rows={2} />

      <label style={labelStyle}>Роль</label>
      <input {...noAutofill("node-modal-3")} value={role} onChange={(e) => setRole(e.target.value)} placeholder="API, воркер, шлюз…" style={input} />

      {!isPerson && (
        <>
          <label style={labelStyle}>Технология</label>
          <input {...noAutofill("node-modal-4")} value={technology} onChange={(e) => setTechnology(e.target.value)} placeholder="Python, Kafka, Redis..." style={input} />

          <label style={toggleRow}>
            <input type="checkbox" checked={isExternal} onChange={(e) => setIsExternal(e.target.checked)} style={{ marginRight: 8, cursor: "pointer" }} />
            Внешний
          </label>
        </>
      )}

      <label style={labelStyle}>Статус</label>
      <div style={statusSeg} role="radiogroup" aria-label="Статус">
        {STATUS_ORDER.map((st) => {
          const active = status === st;
          const dot = getNodeColors(isExternal, 0, st).bg;
          return (
            <button
              key={st}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setStatus(st)}
              style={active ? statusSegBtnActive : statusSegBtn}
            >
              <span style={{ ...metaDot, background: dot }} />
              {STATUS_META[st].label}
            </button>
          );
        })}
      </div>

      <div ref={bottomRef} style={{ height: 1 }} aria-hidden />
      <div className={footerClass}>
        {error && <p style={errStyle}>{error}</p>}
        {limit && <p style={errStyle} role="alert"><LimitText message={limit} /></p>}
        <div style={{ display: "flex", gap: 8 }}>
          {/* Без типа объект не создаётся (Р36): кнопка ждёт выбора. */}
          <button onClick={handleSave} disabled={saving || !type} style={primaryBtn}>
            {saving ? "Сохранение..." : "Создать"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ChevronDown() {
  return <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M6 9 L12 15 L18 9" /></svg>;
}

const typeField: CSSProperties = { marginBottom: 10 };
const noteStyle: CSSProperties = { margin: "-4px 0 10px", fontSize: 12.5, color: "#475569" };
const loadFail: CSSProperties = {
  display: "flex", alignItems: "center", gap: 10, marginBottom: 10, padding: "8px 11px",
  border: "1px solid #fecaca", borderRadius: 8, background: "#fef2f2", color: "#991b1b", fontSize: 13,
};
const loadFailDetail: CSSProperties = { display: "block", marginTop: 2, color: "#b91c1c", fontSize: 12.5 };
const retryBtn: CSSProperties = { ...secondaryBtn, padding: "5px 10px", fontSize: 12.5, flexShrink: 0 };
const textarea: CSSProperties = {
  display: "block", width: "100%", marginBottom: 10, padding: "9px 11px",
  border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 14, boxSizing: "border-box",
  color: "#0f172a", resize: "vertical",
};
const errStyle: CSSProperties = { color: "#dc2626", margin: "0 0 8px" };
const toggleRow: CSSProperties = {
  display: "flex", alignItems: "center", fontSize: 14, fontWeight: 500,
  color: "#374151", marginBottom: 12, cursor: "pointer", userSelect: "none",
};
const statusSeg: CSSProperties = { display: "flex", gap: 6, marginBottom: 12 };
const statusSegBtn: CSSProperties = {
  flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
  padding: "8px 6px", border: "1px solid #e2e8f0", borderRadius: 8,
  background: "#f8fafc", color: "#475569", cursor: "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap",
};
const statusSegBtnActive: CSSProperties = {
  ...statusSegBtn, border: "1px solid #2563eb", background: "#eff6ff", color: "#1e3a8a",
};
const metaDot: CSSProperties = { width: 7, height: 7, borderRadius: 4, flexShrink: 0 };
