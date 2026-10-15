// Модалка-редактор связи на странице объекта: концы (Откуда/Куда через
// NodeSearchPicker — сквозной поиск по проекту, работает и «углубление»
// с контейнера на ребёнка), описание, технология и инверсия направления.
// Переиспользует механику EdgeInspector из редактора-карты: тот же хук
// useEdgeEdit (CAS-коммит, петля/дубли, 409) и та же insp-* разметка полей.
// Коммит — auto, как в панели: по blur текста и по смене конца; «Готово»
// дожимает незакоммиченный текст и закрывает только при успехе.
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { Edge } from "../types";
import { edgesApi, nodesApi } from "../api/nodes";
import Modal from "../ui/Modal";
import { dangerBtn, primaryBtn, secondaryBtn } from "../ui/styles";
import { useEdgeEdit } from "./inspector/useEdgeEdit";
import EdgeEndRow from "./inspector/EdgeEndRow";
import MetaRow from "./inspector/MetaRow";
import { META_ICON } from "./inspector/metaIcons";
import "./inspector/inspector.css";
import { noAutofill } from "../ui/noAutofill";
import DialogTitle from "../ui/DialogTitle";

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
        <DialogTitle lead="Не удалось загрузить данные связи">Связь</DialogTitle>
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
    sourceId, targetId, srcLabel, tgtLabel,
    error, commit, invert, pickEnd,
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
      <DialogTitle>Редактирование связи</DialogTitle>
      <dl className="insp-meta" style={{ borderTop: "none" }}>
        <EdgeEndRow key={`src-${invertSeq}`} end="source" value={sourceId} label={srcLabel}
          onPick={(id, lbl) => pickEnd("source", id, lbl)} />
        <EdgeEndRow key={`tgt-${invertSeq}`} end="target" value={targetId} label={tgtLabel}
          onPick={(id, lbl) => pickEnd("target", id, lbl)} />
      </dl>

      {/* Инверсия направления: концы меняются местами, описание/технология
          остаются на связи; коммит сразу (в хуке). */}
      <button type="button" onClick={handleInvert} style={invertBtn}
        title="Поменять местами «Откуда» и «Куда»">
        {META_ICON.invert} Развернуть направление
      </button>

      <dl className="insp-meta">
        <MetaRow icon={META_ICON.desc} label="Описание">
          <span className="insp-value">
            <textarea {...noAutofill("edge-edit-modal-1")} className="insp-field insp-fieldarea" value={labelText} maxLength={256}
              onChange={(e) => setLabelText(e.target.value)}
              onBlur={() => void commit({ label: labelText })} placeholder="запрос, событие…" />
          </span>
        </MetaRow>
        <MetaRow icon={META_ICON.tech} label="Технология">
          <span className="insp-value">
            <input {...noAutofill("edge-edit-modal-2")} className="insp-field" value={technology} onChange={(e) => setTechnology(e.target.value)}
              onBlur={() => void commit({ technology })} placeholder="REST, gRPC, Kafka…" />
          </span>
        </MetaRow>
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
