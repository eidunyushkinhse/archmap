// Окно «Связь» на странице объекта (редизайн, фаза 9в): каркас окна нового языка
// (ui/ds.css, ds-win) и те же строки, что в панели связи редактора-карты
// (inspector/EdgeInspector): «Откуда», «Куда» (значение-кнопка со значком формы конца, по
// щелчку под строкой открывается сквозной поиск объекта по проекту — работает и
// «углубление» с контейнера на ребёнка), «Описание», «Технология». Значения строк — общие
// с панелью части inspector/EdgeFields, механика правки — общий хук useEdgeEdit
// (CAS-коммит, петля и дубли, 409). «Развернуть направление» — тихая кнопка-значок в
// строке «Откуда».
//
// Коммит — auto, как в панели: по уходу из поля и по смене конца; «Готово» дожимает
// незакоммиченный текст и закрывает только при успехе. Закрывают окно без «Готово»
// крестик и Escape. «Удалить связь» спрашивает подтверждение в подвале этого же окна.
import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import type { Edge, Node } from "../types";
import { treeNesting } from "../types";
import { edgesApi, nodesApi } from "../api/nodes";
import Modal from "../ui/Modal";
import { CloseIcon, SwapIcon } from "../ui/icons";
import { ShapeGlyph } from "./nodeTree.shared";
import { useEdgeEdit } from "./inspector/useEdgeEdit";
import { EdgeLabelField, EdgeTechField, EndValue } from "./inspector/EdgeFields";
import "../ui/ds.css";
import "./inspector/panel.css";
import "./edgeWindows.css";

interface Props {
  edgeId: string;
  onClose: () => void;
  // Коммит связи прошёл успешно — родитель рефетчит таблицу «Связи».
  onChanged: () => void;
}

// Всё, что нужно форме: полная связь (концы + версия для CAS; табличный
// NodeEdgeInfo их не несёт), ВСЕ связи проекта (проверка дублей при смене
// концов — дубль может оказаться не соседним с текущим узлом) и узлы-концы
// (имена для подписей, форма для значка).
interface Loaded {
  edge: Edge;
  edges: Edge[];
  source: Node | null;
  target: Node | null;
}

export default function EdgeEditModal({ edgeId, onClose, onChanged }: Props) {
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const edge = await edgesApi.get(edgeId);
        const [edges, source, target] = await Promise.all([
          edgesApi.list(),
          nodesApi.get(edge.source_id).catch(() => null),
          nodesApi.get(edge.target_id).catch(() => null),
        ]);
        if (!alive) return;
        setData({ edge, edges, source, target });
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => { alive = false; };
  }, [edgeId]);

  if (failed) {
    return (
      <EdgeWindow onClose={onClose}>
        <div className="ds-win-body">
          <p className="ds-danger ew-flat">Не удалось загрузить данные связи</p>
        </div>
        <div className="ds-win-foot">
          <button type="button" className="ds-btn" onClick={onClose}>Закрыть</button>
        </div>
      </EdgeWindow>
    );
  }

  if (!data) {
    return (
      <EdgeWindow onClose={onClose}>
        <div className="ds-win-body">
          <p className="ds-empty ew-flat">Загрузка</p>
        </div>
      </EdgeWindow>
    );
  }

  return <EdgeEditForm key={data.edge.id} data={data} onClose={onClose} onChanged={onChanged} />;
}

// Каркас окна: шапка «Связь» с крестиком (так же называется панель связи в редакторе).
// Окно не обрезает содержимое (overflow на <dialog>): поиск конца связи открывается под
// строкой и, пока открыт, выходит за тело окна (edgeWindows.css, .ew-win).
function EdgeWindow({ onClose, onSubmit, children }: {
  onClose: () => void;
  onSubmit?: () => void;
  children: ReactNode;
}) {
  return (
    <Modal onClose={onClose} onSubmit={onSubmit} boxStyle={{ width: 480, padding: 0, overflow: "visible" }}>
      <div className="ds ds-win ew-win">
        <div className="ds-win-head">
          <h2 className="ds-win-title">Связь</h2>
          <button type="button" className="ds-icon-btn ds-win-close" aria-label="Закрыть" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        {children}
      </div>
    </Modal>
  );
}

// Узлы-концы для значка формы у «Откуда» и «Куда»: сначала загруженные окном, после смены
// конца (выбор в поиске, ответ 409) — новый конец по id. Ключ — id конца, а не поле ответа.
function useEndNodes(sourceId: string, targetId: string, initial: Record<string, Node>) {
  const [ends, setEnds] = useState(initial);
  useEffect(() => {
    const missing = Array.from(new Set([sourceId, targetId])).filter((id) => id !== "" && !(id in ends));
    if (missing.length === 0) return;
    let alive = true;
    void Promise.all(missing.map((id) => nodesApi.get(id).catch(() => null))).then((nodes) => {
      // Неудача состояние не трогает: иначе эффект перезапускался бы без конца.
      if (!alive || nodes.every((n) => n === null)) return;
      setEnds((prev) => {
        const next = { ...prev };
        missing.forEach((id, i) => { const n = nodes[i]; if (n) next[id] = n; });
        return next;
      });
    });
    return () => { alive = false; };
  }, [sourceId, targetId, ends]);
  return ends;
}

// Форма правки (монтируется на загруженных данных; key=edge.id — своя копия на связь, как
// EdgeInspector в панели).
function EdgeEditForm({ data, onClose, onChanged }: {
  data: Loaded;
  onClose: () => void;
  onChanged: () => void;
}) {
  const uid = useId();
  const {
    labelText, setLabelText,
    technology, setTechnology,
    sourceId, targetId, srcLabel, tgtLabel,
    saved, error, commit, invert, pickEnd,
  } = useEdgeEdit(
    {
      id: data.edge.id,
      label: data.edge.label,
      technology: data.edge.technology,
      // Своей строки «Канал» в окне страницы нет (правится в панели редактора-карты), но
      // значение прокидываем: иначе коммит любой другой правки затёр бы канал null'ом.
      channel: data.edge.channel ?? null,
      source_id: data.edge.source_id,
      target_id: data.edge.target_id,
      version: data.edge.version,
      source_name: data.source?.name ?? "",
      target_name: data.target?.name ?? "",
    },
    () => onChanged(),
    data.edges, // проверка дублей: все связи проекта
  );
  const ends = useEndNodes(sourceId, targetId, {
    ...(data.source ? { [data.edge.source_id]: data.source } : {}),
    ...(data.target ? { [data.edge.target_id]: data.target } : {}),
  });

  // Разворот перемонтирует значения концов: открытый поиск конца живёт их локальным
  // состоянием и после обмена концов закрывается, а не остаётся под чужой строкой.
  const [invertSeq, setInvertSeq] = useState(0);
  const handleInvert = () => {
    invert();
    setInvertSeq((s) => s + 1);
  };

  // «Готово»: дожимаем незакоммиченный текст (обычно его уже закоммитил уход из поля) и
  // закрываем при успехе; при отказе остаёмся — отказ показан под строками.
  const handleDone = () => {
    void commit({ label: labelText, technology }).then((ok) => { if (ok) onClose(); });
  };

  // Удаление связи. Подтверждение — ВНУТРИ этого же окна (вложенные <dialog> в проекте
  // запрещены: cancel всплывает) и потому, что на СТРАНИЦЕ отката нет — undo/redo живут в
  // редакторе-карте, а сюда история не доезжает.
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

  const endValue = (end: "source" | "target") => {
    const n = ends[end === "source" ? sourceId : targetId];
    return (
      <EndValue
        key={`${end}-${invertSeq}`}
        label={end === "source" ? srcLabel : tgtLabel}
        glyph={n ? <ShapeGlyph nesting={treeNesting(n)} shape={n.shape} /> : null}
        onPick={(id, lbl) => pickEnd(end, id, lbl)}
        term={end === "source" ? "Откуда" : "Куда"}
      />
    );
  };
  const delErr = delError && <p className="ds-danger ds-win-err">{delError}</p>;

  return (
    // Enter в поле (Ctrl+Enter в описании) — «Готово»; пока окно спрашивает об удалении,
    // клавиша молчит: удаление подтверждают только кнопкой.
    <EdgeWindow onClose={onClose} onSubmit={confirmDel ? undefined : handleDone}>
      <div className="ds-win-body">
        <dl className="ds-props">
          <div className="ds-prop ew-end">
            <dt className="ds-prop-term">Откуда</dt>
            <dd className="ds-prop-value ew-from">
              {endValue("source")}
              {/* Разворот: концы меняются местами, описание и технология остаются на связи;
                  коммит сразу (в хуке). Значок у правого края строки: от длины имени
                  конца его место не зависит. */}
              <button
                type="button"
                className="ds-icon-btn ew-swap"
                title="Поменять местами «Откуда» и «Куда»"
                aria-label="Поменять местами «Откуда» и «Куда»"
                onClick={handleInvert}
              >
                <SwapIcon />
              </button>
            </dd>
          </div>
          <div className="ds-prop ew-end">
            <dt className="ds-prop-term">Куда</dt>
            <dd className="ds-prop-value">{endValue("target")}</dd>
          </div>
          <div className="ds-prop">
            <dt className="ds-prop-term"><label htmlFor={`${uid}-label`}>Описание</label></dt>
            <dd className="ds-prop-value">
              <EdgeLabelField
                id={`${uid}-label`}
                value={labelText}
                saved={saved.label}
                onChange={setLabelText}
                onCommit={() => void commit({ label: labelText })}
                autofill="edge-edit-modal-1"
              />
            </dd>
          </div>
          <div className="ds-prop">
            <dt className="ds-prop-term"><label htmlFor={`${uid}-tech`}>Технология</label></dt>
            <dd className="ds-prop-value">
              <EdgeTechField
                id={`${uid}-tech`}
                value={technology}
                saved={saved.technology}
                onChange={setTechnology}
                onCommit={() => void commit({ technology })}
                autofill="edge-edit-modal-2"
              />
            </dd>
          </div>
        </dl>
        {error && <p className="ds-warn ew-flat">{error}</p>}
      </div>

      <div className="ds-win-foot">
        {confirmDel ? (
          <>
            <p className="ew-ask">
              Удалить связь? Она исчезнет со схемы, а шаги процессов, которые по ней шли,
              окажутся без связи. Со страницы удаление не отменить.
            </p>
            {delErr}
            <button type="button" className="ds-btn ds-btn--danger" onClick={handleDelete} disabled={deleting}>
              {deleting ? "Удаляем" : "Удалить"}
            </button>
            <button type="button" className="ds-btn" onClick={() => setConfirmDel(false)}>Отмена</button>
          </>
        ) : (
          <>
            {delErr}
            <button type="button" className="ds-btn ds-btn--primary" onClick={handleDone}>Готово</button>
            {/* Удаление — у правого края, поодаль от «Готово»: рядом с ним по нему промахиваются. */}
            <button type="button" className="ip-delete" onClick={() => setConfirmDel(true)}>Удалить связь</button>
          </>
        )}
      </div>
    </EdgeWindow>
  );
}
