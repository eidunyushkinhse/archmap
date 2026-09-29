// Просмотр схемы логики в окне DocOverlay: рендер без кода (наблюдателю код — по
// «Показать код») и строка под ним: в каких процессах схема используется и к чему
// обращается. У неописанной схемы (заглушка из списка операций) вместо рендера —
// карточка «ещё не описана» с тем же меню, что «Изменить».
import { Fragment, useEffect, useState } from "react";
import type { DataRefPreviewItem, NodeDoc, NodeDocKind, NodeDocUsage } from "../../types";
import { dataRefsApi } from "../../api/dataRefs";
import FlowchartDoc from "./FlowchartDoc";
import { EditMenu } from "./docChrome";
import { MODE_LABEL, REF_MARKER, reasonOf } from "./docRefs";

export default function FlowchartView({ doc, nodeId, showCode, usage, onOpenProcess }: {
  doc: NodeDoc;
  nodeId: string;
  showCode: boolean;
  usage: NodeDocUsage[]; // строки обратного индекса ЭТОЙ схемы
  onOpenProcess?: (processId: string) => void;
}) {
  const refs = useDocRefs(doc.content, nodeId);
  return (
    <div className="doc-flowwrap">
      <div className="doc-flowbody">
        <FlowchartDoc initial={doc.content} nodeId={nodeId} isArchitect={false} showCode={showCode} />
      </div>
      {(usage.length > 0 || refs.length > 0) && (
        <div className="doc-meta">
          {usage.length > 0 && (
            <span>
              Используется в процессах:{" "}
              {usage.map((u, i) => (
                <Fragment key={u.process_id}>
                  {i > 0 && ", "}
                  {onOpenProcess ? (
                    <button type="button" className="doc-metalink" onClick={() => onOpenProcess(u.process_id)}>
                      {u.process_name}
                    </button>
                  ) : (
                    <b>{u.process_name}</b>
                  )}
                </Fragment>
              ))}
            </span>
          )}
          {refs.length > 0 && (
            <span>
              Обращения:{" "}
              {refs.map((r, i) => (
                <Fragment key={`${r.mode}:${r.ref}:${i}`}>
                  {i > 0 && ", "}
                  {MODE_LABEL[r.mode]}{" "}
                  {r.status === "ok" ? (
                    <><b>{r.target}</b> <span className="doc-refok">✓</span></>
                  ) : (
                    <><b>{r.ref}</b> <span className="doc-refbad">⚠ {reasonOf(r.status, r.mode)}</span></>
                  )}
                </Fragment>
              ))}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// Неописанная схема: строка перечня операций без тела. Архитектору — «Описать» с
// выбором способа; читателю — только сама карточка.
export function StubCard({ kind, canEdit, onManual, onAgent }: {
  kind: NodeDocKind;
  canEdit: boolean;
  onManual: () => void;
  onAgent: () => void;
}) {
  const worker = kind === "worker";
  return (
    <div className="doc-empty">
      <div className="doc-emptycard">
        <h3>{worker ? "Этот воркер ещё не описан" : "Эта операция ещё не описана"}</h3>
        <p>
          {worker
            ? "Он попал в список операций сервиса, но схемы логики у него пока нет."
            : "Она попала в список операций сервиса, но схемы логики у неё пока нет."}
        </p>
        {canEdit && <EditMenu label="Описать" align="center" onManual={onManual} onAgent={onAgent} />}
      </div>
    </div>
  );
}

// Разбор пометок сохранённого текста для строки «Обращения». Резолв на бэке —
// чистая функция и открыт обеим ролям. Без маркера в тексте сеть не трогаем.
// Ответ привязан к тексту, для которого пришёл: чужой разбор не показываем.
function useDocRefs(content: string, nodeId: string): DataRefPreviewItem[] {
  const [got, setGot] = useState<{ forText: string; items: DataRefPreviewItem[] } | null>(null);
  const hasMarker = REF_MARKER.test(content);
  useEffect(() => {
    if (!hasMarker) return;
    let alive = true;
    dataRefsApi
      .preview(content, nodeId)
      .then((items) => { if (alive) setGot({ forText: content, items }); })
      // Строка — подсказка, а не источник истины: отказ сети гасим молча.
      .catch(() => undefined);
    return () => { alive = false; };
  }, [content, nodeId, hasMarker]);
  return hasMarker && got !== null && got.forText === content ? got.items : [];
}
