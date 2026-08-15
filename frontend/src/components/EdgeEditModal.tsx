// Модалка-редактор связи на странице объекта: концы (Откуда/Куда через
// NodeSearchPicker — сквозной поиск по проекту, работает и «углубление»
// с контейнера на ребёнка), описание, технология и инверсия направления.
// Переиспользует механику EdgeInspector из редактора-карты: тот же хук
// useEdgeEdit (CAS-коммит, петля/дубли, 409) и та же insp-* разметка полей.
// Коммит — auto, как в панели: по blur текста и по смене конца; «Готово»
// дожимает незакоммиченный текст и закрывает только при успехе.
import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { Edge } from "../types";
import { edgesApi, nodesApi } from "../api/nodes";
import Modal from "../ui/Modal";
import { dangerBtn, primaryBtn, secondaryBtn } from "../ui/styles";
import NodeSearchPicker from "./NodeSearchPicker";
import { useEdgeEdit } from "./inspector/useEdgeEdit";
import "./inspector/inspector.css";

interface Props {
  edgeId: string;
  onClose: () => void;
  // Коммит связи прошёл успешно — родитель рефетчит таблицу «Связи».
  onChanged: () => void;
}

// Всё, что нужно форме: полная связь (концы + версия для CAS; табличный
// NodeEdgeInfo их не несёт), ВСЕ связи проекта (проверка дублей при смене
// концов — дубль может оказаться не соседним с текущим узлом) и имена концов.
interface Loaded {
  edge: Edge;
  edges: Edge[];
  sourceName: string;
  targetName: string;
}

export default function EdgeEditModal({ edgeId, onClose, onChanged }: Props) {
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const edge = await edgesApi.get(edgeId);
        const [edges, src, tgt] = await Promise.all([
          edgesApi.list(),
          nodesApi.get(edge.source_id).catch(() => null),
          nodesApi.get(edge.target_id).catch(() => null),
        ]);
        if (!alive) return;
        setData({ edge, edges, sourceName: src?.name ?? "", targetName: tgt?.name ?? "" });
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => { alive = false; };
  }, [edgeId]);

  if (failed) {
    return (
      <Modal onClose={onClose} boxStyle={{ width: 480 }}>
        <h3 style={titleStyle}>Связь</h3>
        <p style={failText}>Не удалось загрузить данные связи</p>
        <div style={footRow}>
          <button type="button" onClick={onClose} style={secondaryBtn}>Закрыть</button>
        </div>
      </Modal>
    );
  }

  if (!data) {
    return (
      <Modal onClose={onClose} boxStyle={{ width: 480 }}>
        <div style={failText}>Загрузка…</div>
      </Modal>
    );
  }

  return <EdgeEditForm key={data.edge.id} data={data} onClose={onClose} onChanged={onChanged} />;
}

// Форма редактирования (монтируется на загруженных данных; key=edge.id —
// своя копия на связь, как EdgeInspector в панели).
function EdgeEditForm({ data, onClose, onChanged }: {
  data: Loaded;
  onClose: () => void;
  onChanged: () => void;
}) {
  const {
    labelText, setLabelText,
    technology, setTechnology,
    sourceId, setSourceId,
    targetId, setTargetId,
    srcLabel, setSrcLabel,
    tgtLabel, setTgtLabel,
    error, commit, invert,
  } = useEdgeEdit(
    {
      id: data.edge.id,
      label: data.edge.label,
      technology: data.edge.technology,
      // Своего поля «Канал» в модалке страницы нет (правится в инспекторе
      // редактора-карты), но значение прокидываем: иначе коммит любой другой
      // правки затёр бы канал null'ом.
      channel: data.edge.channel ?? null,
      source_id: data.edge.source_id,
      target_id: data.edge.target_id,
      version: data.edge.version,
      source_name: data.sourceName,
      target_name: data.targetName,
    },
    () => onChanged(),
    data.edges, // проверка дублей: все связи проекта
  );

  // Инверсия перемонтировывает пикеры концов: внутри NodeSearchPicker выбор
  // живёт локальным стейтом (синхронного эффекта value→selected там нет по
  // дизайну очистки) — без remount пикеры не увидели бы обмен концов.
  const [invertSeq, setInvertSeq] = useState(0);
  const handleInvert = () => {
    invert();
    setInvertSeq((s) => s + 1);
  };

  // «Готово»: дожимаем незакоммиченный текст (обычно его уже закоммитил blur)
  // и закрываем при успехе; при ошибке остаёмся — ошибка показана в модалке.
  const handleDone = () => {
    void commit({ label: labelText, technology }).then((ok) => { if (ok) onClose(); });
  };

  // Удаление связи. Подтверждение — ВНУТРИ этой же модалки (вложенные <dialog>
  // в проекте запрещены: cancel всплывает) и потому, что на СТРАНИЦЕ отката нет —
  // undo/redo живут в редакторе-карте, а сюда история не доезжает.
  const [confirmDel, setConfirmDel] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [delError, setDelError] = useState<string | null>(null);
  const handleDelete = () => {
    setDeleting(true);
    setDelError(null);
    void edgesApi
      .delete(data.edge.id)
      .then(() => { onChanged(); onClose(); })
      .catch((e: unknown) => {
        setDelError(e instanceof Error ? e.message : "Не удалось удалить связь");
        setDeleting(false);
      });
  };

  return (
    <Modal onClose={onClose} boxStyle={{ width: 480 }}>
      <h3 style={titleStyle}>Редактирование связи</h3>
      <dl className="insp-meta" style={{ borderTop: "none" }}>
        {/* Откуда */}
        <div className="insp-row insp-row--top">
          <dt className="insp-term"><span className="insp-term-ico">{ICON.source}</span>Откуда</dt>
          <dd style={{ margin: 0, flex: 1, minWidth: 0 }}>
            <NodeSearchPicker
              key={`src-${invertSeq}`}
              value={sourceId}
              initialLabel={srcLabel}
              onChange={(id, lbl) => { setSourceId(id); if (lbl != null) setSrcLabel(lbl); if (id) void commit({ source_id: id }); }}
            />
          </dd>
        </div>
        {/* Куда */}
        <div className="insp-row insp-row--top">
          <dt className="insp-term"><span className="insp-term-ico">{ICON.target}</span>Куда</dt>
          <dd style={{ margin: 0, flex: 1, minWidth: 0 }}>
            <NodeSearchPicker
              key={`tgt-${invertSeq}`}
              value={targetId}
              initialLabel={tgtLabel}
              onChange={(id, lbl) => { setTargetId(id); if (lbl != null) setTgtLabel(lbl); if (id) void commit({ target_id: id }); }}
            />
          </dd>
        </div>
      </dl>

      {/* Инверсия направления: концы меняются местами, описание/технология
          остаются на связи; коммит сразу (в хуке). */}
      <button type="button" onClick={handleInvert} style={invertBtn}
        title="Поменять местами «Откуда» и «Куда»">
        {ICON.invert} Развернуть направление
      </button>

      <dl className="insp-meta">
        {/* Описание */}
        <div className="insp-row">
          <dt className="insp-term"><span className="insp-term-ico">{ICON.desc}</span>Описание</dt>
          <dd style={{ margin: 0, flex: 1, minWidth: 0, display: "flex" }}>
            <span className="insp-value">
              <textarea className="insp-field insp-fieldarea" value={labelText} maxLength={256}
                onChange={(e) => setLabelText(e.target.value)}
                onBlur={() => void commit({ label: labelText })} placeholder="запрос, событие…" />
            </span>
          </dd>
        </div>
        {/* Технология */}
        <div className="insp-row">
          <dt className="insp-term"><span className="insp-term-ico">{ICON.tech}</span>Технология</dt>
          <dd style={{ margin: 0, flex: 1, minWidth: 0, display: "flex" }}>
            <span className="insp-value">
              <input className="insp-field" value={technology} onChange={(e) => setTechnology(e.target.value)}
                onBlur={() => void commit({ technology })} placeholder="REST, gRPC, Kafka…" />
            </span>
          </dd>
        </div>
      </dl>

      {error && <p style={errText}>{error}</p>}
      {delError && <p style={errText}>{delError}</p>}

      {confirmDel ? (
        <>
          <p style={confirmText}>
            Удалить связь? Она исчезнет со схемы, а шаги процессов, которые по ней шли,
            станут повисшими. Отменить со страницы будет нечем.
          </p>
          <div style={footRow}>
            <button type="button" onClick={handleDelete} disabled={deleting} style={dangerBtn}>
              {deleting ? "Удаление…" : "Удалить"}
            </button>
            <button type="button" onClick={() => setConfirmDel(false)} style={secondaryBtn}>Отмена</button>
          </div>
        </>
      ) : (
        <div style={footRow}>
          {/* Удаление — слева и поодаль от «Готово»: рядом с ним по нему промахиваются */}
          <button
            type="button"
            onClick={() => setConfirmDel(true)}
            style={{ ...secondaryBtn, marginRight: "auto", color: "#dc2626" }}
          >
            Удалить
          </button>
          <button type="button" onClick={handleDone} style={primaryBtn}>Готово</button>
          <button type="button" onClick={onClose} style={secondaryBtn}>Закрыть</button>
        </div>
      )}
    </Modal>
  );
}

const titleStyle: CSSProperties = {
  margin: "0 0 12px",
  fontSize: 17,
  fontWeight: 700,
  color: "#1e293b",
  lineHeight: 1.3,
};
const failText: CSSProperties = {
  color: "#475569",
  margin: "4px 0 0",
  fontSize: 14,
};
const footRow: CSSProperties = {
  display: "flex",
  gap: 8,
  marginTop: 16,
};
const errText: CSSProperties = {
  color: "#dc2626",
  margin: "10px 0 0",
  fontSize: 13,
};
const confirmText: CSSProperties = {
  color: "#475569",
  margin: "14px 0 0",
  fontSize: 13,
  lineHeight: 1.5,
};
// Кнопка инверсии: пунктирная плашка между концами и текстовыми полями.
const invertBtn: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 7,
  width: "100%",
  boxSizing: "border-box",
  margin: "10px 0",
  padding: "8px 12px",
  border: "1px dashed #cbd5e1",
  borderRadius: 8,
  background: "#f8fafc",
  color: "#334155",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const ms = {
  width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
  stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round",
} as const;
const ICON: Record<"source" | "target" | "desc" | "tech" | "invert", ReactNode> = {
  source: <svg {...ms}><circle cx="3.5" cy="8" r="2.25" /><path d="M6 8h7" /><path d="M10.5 5.4 13.2 8l-2.7 2.6" /></svg>,
  target: <svg {...ms}><path d="M2.8 8h7" /><path d="M7.3 5.4 10 8l-2.7 2.6" /><circle cx="12.5" cy="8" r="2.25" /></svg>,
  desc: <svg {...ms}><path d="M8.4 2.6 13 7.2a1.3 1.3 0 0 1 0 1.8l-3.9 3.9a1.3 1.3 0 0 1-1.8 0L2.7 8.3V4a1.3 1.3 0 0 1 1.3-1.3Z" /><circle cx="5.6" cy="5.5" r=".9" fill="currentColor" stroke="none" /></svg>,
  tech: <svg {...ms}><path d="M6 5.4 3 8l3 2.6" /><path d="M10 5.4 13 8l-3 2.6" /></svg>,
  invert: <svg {...ms} width={15} height={15}><path d="M2.5 5.5h9.5" /><path d="M9.8 3.2 12 5.5l-2.2 2.3" /><path d="M13.5 10.5H4" /><path d="M6.2 8.2 4 10.5l2.2 2.3" /></svg>,
};
