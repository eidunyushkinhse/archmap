import { useEffect, useMemo, useState } from "react";
import { processesApi } from "../api/processes";
import type { ProcessDetail } from "../types";
import Modal from "../ui/Modal";
import { IcoClose, IcoEdit } from "./processes/icons";
import LegLegend from "./processes/LegLegend";
import ProcessWindow from "./processes/ProcessWindow";
import SequenceDiagram from "./processes/SequenceDiagram";
import { deriveActivations } from "./processes/sequence/layout";
import { detailToSeq } from "./processes/sequence/fromDetail";
import { BPT } from "./processes/tokens";
import "./processes/processes.css";

/**
 * Просмотр процесса (обе роли): sequence-диаграмма read-only. Архитектор может
 * перейти в редактор. Окно — на ui/Modal (нативный dialog) + ProcessWindow-хром.
 */
interface Props {
  id: string;
  isArchitect: boolean;
  onClose: () => void;
  onEdit: (id: string) => void;
}

export default function ProcessViewerModal({ id, isArchitect, onClose, onEdit }: Props) {
  const [detail, setDetail] = useState<ProcessDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    processesApi
      .get(id)
      .then((d) => alive && setDetail(d))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : "Не удалось загрузить процесс"));
    return () => { alive = false; };
  }, [id]);

  const seq = useMemo(() => (detail ? detailToSeq(detail) : null), [detail]);
  const activations = useMemo(() => (seq ? deriveActivations(seq.messages) : []), [seq]);
  const invalid = seq ? seq.messages.filter((m) => !m.valid).length : 0;

  return (
    <Modal onClose={onClose} closeButton={false} boxStyle={{ padding: 0, width: 1040, display: "flex", flexDirection: "column" }}>
      <ProcessWindow
        title={detail?.name ?? "Процесс"}
        scope={detail?.scope_name}
        width={1040}
        height="min(800px, 88vh)"
        actions={
          <>
            {isArchitect && (
              <button className="bp-btn-ghost" onClick={() => onEdit(id)}>
                <IcoEdit s={15} />
                <span style={{ marginLeft: 6 }}>Редактировать</span>
              </button>
            )}
            <button className="bp-iconbtn" title="Закрыть" onClick={onClose}>
              <IcoClose />
            </button>
          </>
        }
        foot={
          <>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: BPT.mut }}>
              Плечи каналов
            </span>
            <LegLegend />
            <span style={{ marginLeft: "auto", fontSize: 12, color: invalid ? "#dc2626" : BPT.mut }}>
              {detail
                ? invalid
                  ? `${detail.messages.length} сообщений · ${detail.participants.length} участников · ${invalid} повисших`
                  : `${detail.messages.length} сообщений · ${detail.participants.length} участников`
                : ""}
            </span>
          </>
        }
      >
        <div className="bp-canvas" style={{ flex: 1, overflow: "auto" }}>
          {error ? (
            <div style={{ padding: 24, color: "#dc2626", fontSize: 14 }}>{error}</div>
          ) : !detail || !seq ? (
            <div style={{ padding: 24, color: BPT.mut, fontSize: 14 }}>Загрузка…</div>
          ) : seq.participants.length === 0 ? (
            <div style={{ padding: 24, color: BPT.mut, fontSize: 14 }}>
              В процессе пока нет участников и сообщений.
            </div>
          ) : (
            <div style={{ padding: "8px 12px 18px", width: "max-content" }}>
              <SequenceDiagram
                participants={seq.participants}
                messages={seq.messages}
                activations={activations}
                fragment={seq.fragment}
              />
            </div>
          )}
        </div>
      </ProcessWindow>
    </Modal>
  );
}
