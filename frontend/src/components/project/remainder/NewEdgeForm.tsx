// Форма новой связи — второй шаг вопроса об изолированной группе (§4.4, §5.4 ТЗ).
// Оба конца выбираются по СЛИТОМУ дереву, кандидатов ArchMap не предлагает:
// связь между группой и ядром — факт совместного развёртывания, и знает его
// только человек. После выбора начала пикер сам переходит на конец — иначе жест
// требует лишнего клика ровно там, где мысль уже ушла к следующему полю.
import { useState } from "react";
import type { ComponentOut } from "../../../types";
import type { NewEdgeAnswer } from "./questions";
import type { EdgeDraft } from "./drafts";
import ObjectList from "./ObjectList";
import Option, { PathLabel } from "./Option";

type End = "fromPath" | "toPath";

interface Props {
  /** Всё слитое дерево: remainder.node_paths + node_has_children. */
  nodes: ComponentOut[];
  draft: EdgeDraft;
  onDraft: (next: EdgeDraft) => void;
  onAdd: (answer: NewEdgeAnswer) => void;
  onBack: () => void;
}

export default function NewEdgeForm({ nodes, draft, onDraft, onAdd, onBack }: Props) {
  // Какой конец выбирают прямо сейчас. Форма открывается на «Начале»: это первый
  // шаг жеста, и лишний клик по кнопке был бы пустым.
  const [picking, setPicking] = useState<End | null>("fromPath");

  function pick(path: string) {
    if (picking === null) return;
    onDraft({ ...draft, [picking]: path });
    // Автопереход на конец — только пока конца нет: правка уже выбранного не
    // должна утаскивать пикер дальше.
    setPicking(picking === "fromPath" && draft.toPath === null ? "toPath" : null);
  }

  const endButton = (end: End, label: string) => {
    const path = draft[end];
    return (
      <div>
        <div className="rq-flbl">{label}</div>
        <Option
          main={path === null ? <span className="rq-opt-m">Выберите объект</span> : <PathLabel path={path} />}
          tag={picking === end ? "выбираете" : undefined}
          selected={picking === end}
          onClick={() => setPicking(picking === end ? null : end)}
        />
      </div>
    );
  };

  const ready = draft.fromPath !== null && draft.toPath !== null;

  return (
    <>
      <div className="rq-frow">
        {endButton("fromPath", "Начало")}
        {endButton("toPath", "Конец")}
      </div>
      {picking !== null && (
        <ObjectList key={picking} items={nodes} value={draft[picking]} onPick={pick} />
      )}
      <div className="rq-frow">
        <div>
          <div className="rq-flbl">Подпись</div>
          <input
            className="rq-inp"
            value={draft.label}
            aria-label="Подпись"
            placeholder="что ходит по связи"
            onChange={(e) => onDraft({ ...draft, label: e.target.value })}
          />
        </div>
      </div>
      <div className="rq-frow">
        <div>
          <div className="rq-flbl">Технология</div>
          <input
            className="rq-inp"
            value={draft.tech}
            aria-label="Технология"
            placeholder="SQL, HTTP/JSON, gRPC…"
            onChange={(e) => onDraft({ ...draft, tech: e.target.value })}
          />
        </div>
        <div>
          <div className="rq-flbl">Тип канала</div>
          <div className="rq-seg2">
            <button
              type="button"
              className={draft.channel === "sync" ? "rq-on" : undefined}
              onClick={() => onDraft({ ...draft, channel: "sync" })}
            >
              Синхронный
            </button>
            <button
              type="button"
              className={draft.channel === "async" ? "rq-on" : undefined}
              onClick={() => onDraft({ ...draft, channel: "async" })}
            >
              Асинхронный
            </button>
          </div>
        </div>
      </div>
      <div className="rq-more">
        <button
          type="button"
          className="rq-pri"
          disabled={!ready}
          onClick={() => {
            if (draft.fromPath === null || draft.toPath === null) return;
            onAdd({
              kind: "new_edge", fromPath: draft.fromPath, toPath: draft.toPath,
              label: draft.label, tech: draft.tech, channel: draft.channel,
            });
          }}
        >
          Добавить связь
        </button>
        <button type="button" className="rq-link rq-link--mut" onClick={onBack}>
          Назад к вопросу
        </button>
      </div>
    </>
  );
}
