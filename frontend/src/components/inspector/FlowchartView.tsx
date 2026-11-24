// Чтение схемы логики в окне DocOverlay: рендер без кода (читателю код — по «Показать
// код») и подвал под ним: в каких процессах схема используется и какие обращения не
// разрешились. Разрешённые обращения не показываются: они написаны в узлах схемы. Нет ни
// процессов, ни неразрешённых обращений — подвала нет. У неописанной схемы (заглушка из
// списка операций) вместо рендера — карточка «ещё не описана» с тем же меню, что
// «Изменить». Новый язык (редизайн, фаза 7а).
import { Fragment, useEffect, useState } from "react";
import type { DataRefPreviewItem, NodeDoc, NodeDocKind, NodeDocUsage } from "../../types";
import { dataRefsApi } from "../../api/dataRefs";
import FlowchartDoc from "./FlowchartDoc";
import { EditMenu } from "./docChrome";
import { REF_MARKER, unresolvedLine } from "./docRefs";
import "../../ui/ds.css";

export default function FlowchartView({ doc, nodeId, showCode, usage, onOpenProcess }: {
  doc: NodeDoc;
  nodeId: string;
  showCode: boolean;
  usage: NodeDocUsage[]; // строки обратного индекса ЭТОЙ схемы
  onOpenProcess?: (processId: string) => void;
}) {
  const unresolved = unresolvedLine(useDocRefs(doc.content, nodeId));
  return (
    <div className="doc-flowwrap">
      <div className="doc-flowbody">
        <FlowchartDoc initial={doc.content} nodeId={nodeId} isArchitect={false} showCode={showCode} />
      </div>
      {(usage.length > 0 || unresolved) && (
        <div className="doc-readfoot">
          {usage.length > 0 && (
            <p className="doc-readline">
              {"В процессах: "}
              {usage.map((u, i) => (
                <Fragment key={u.process_id}>
                  {i > 0 && ", "}
                  {onOpenProcess ? (
                    <button type="button" className="doc-proclink" onClick={() => onOpenProcess(u.process_id)}>
                      {u.process_name}
                    </button>
                  ) : (
                    <span className="doc-procname">{u.process_name}</span>
                  )}
                </Fragment>
              ))}
            </p>
          )}
          {unresolved && <p className="ds-warn" role="status">{unresolved}</p>}
        </div>
      )}
    </div>
  );
}

// Неописанная схема: строка перечня операций без тела. Архитектору — «Описать» с
// выбором способа; читателю — только заголовок.
export function StubCard({ kind, canEdit, onManual, onAgent }: {
  kind: NodeDocKind;
  canEdit: boolean;
  onManual: () => void;
  onAgent: () => void;
}) {
  return (
    <div className="doc-stub">
      <h3 className="doc-stub-title">{kind === "worker" ? "Этот воркер ещё не описан" : "Эта операция ещё не описана"}</h3>
      {canEdit && <EditMenu label="Описать" variant="primary" align="center" onManual={onManual} onAgent={onAgent} />}
    </div>
  );
}

// Разбор пометок сохранённого текста для подвала. Резолв на бэке — чистая функция и
// открыт обеим ролям. Без маркера в тексте сеть не трогаем. Ответ привязан к тексту, для
// которого пришёл: чужой разбор не показываем.
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
