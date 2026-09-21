// Форма проведения связей — второй шаг вопроса об изолированной группе (§4.4,
// §5.4 ТЗ; переделана по приёмке 2026-09-21, П4).
//
// Прежняя форма спрашивала ОДНУ связь двумя пикерами — и, открыв её,
// пользователь переставал видеть, у каких объектов связей нет. Теперь строка на
// КАЖДЫЙ объект группы: слева он сам, справа сосед из слитого дерева, между ними
// переключатель направления. Пустая строка законна: объект, у которого связи
// действительно нет, так и останется без неё.
//
// Типа канала здесь нет вовсе: синхронность связи — предмет «Процессов», а не
// разбора остатка, и спрашивать её значило бы требовать ответа на незаданный
// вопрос (бэк без поля channel ставит дефолт движка).
import { useState } from "react";
import type { ComponentOut } from "../../../types";
import type { NewEdgesAnswer } from "./questions";
import type { EdgesDraft } from "./drafts";
import { answerFromDraft } from "./drafts";
import ObjectList from "./ObjectList";
import Option, { PathLabel } from "./Option";

interface Props {
  /** Всё слитое дерево: сосед выбирается по нему. */
  nodes: ComponentOut[];
  draft: EdgesDraft;
  onDraft: (next: EdgesDraft) => void;
  onAdd: (answer: NewEdgesAnswer) => void;
  onBack: () => void;
}

export default function NewEdgeForm({ nodes, draft, onDraft, onAdd, onBack }: Props) {
  // У какой строки раскрыт дропдаун соседа; null — все свёрнуты.
  const [picking, setPicking] = useState<number | null>(null);

  const правка = (i: number, patch: Partial<EdgesDraft[number]>) =>
    onDraft(draft.map((r, k) => (k === i ? { ...r, ...patch } : r)));

  const готово = draft.filter((r) => r.toPath !== null).length;

  return (
    <>
      {draft.map((row, i) => (
        <div key={row.nodePath} className="rq-erow">
          <div className="rq-epair">
            <div className="rq-eend rq-eend--fixed" title={row.nodePath}>
              <PathLabel path={row.nodePath} />
            </div>
            <button
              type="button"
              className="rq-eswap"
              title="Поменять направление"
              aria-label="Поменять направление"
              onClick={() => правка(i, { reversed: !row.reversed })}
            >
              {row.reversed ? "←" : "→"}
            </button>
            <div className="rq-eend">
              <Option
                main={row.toPath === null
                  ? <span className="rq-opt-m">Выберите объект</span>
                  : <PathLabel path={row.toPath} />}
                tag={picking === i ? "выбираете" : undefined}
                selected={picking === i}
                onClick={() => setPicking(picking === i ? null : i)}
              />
            </div>
          </div>
          {picking === i && (
            <ObjectList
              key={`pick-${i}`}
              items={nodes.filter((n) => n.path !== row.nodePath)}
              value={row.toPath}
              search
              onPick={(path) => { правка(i, { toPath: path }); setPicking(null); }}
            />
          )}
          <div className="rq-frow">
            <div>
              <div className="rq-flbl">Описание</div>
              <input
                className="rq-inp"
                value={row.label}
                aria-label={`Описание связи — ${row.nodePath}`}
                placeholder="что ходит по связи"
                onChange={(e) => правка(i, { label: e.target.value })}
              />
            </div>
            <div>
              <div className="rq-flbl">Технология</div>
              <input
                className="rq-inp"
                value={row.tech}
                aria-label={`Технология связи — ${row.nodePath}`}
                placeholder="SQL, HTTP/JSON, gRPC…"
                onChange={(e) => правка(i, { tech: e.target.value })}
              />
            </div>
          </div>
        </div>
      ))}
      <div className="rq-more">
        <button
          type="button"
          className="rq-pri"
          disabled={готово === 0}
          onClick={() => onAdd(answerFromDraft(draft))}
        >
          {готово > 1 ? "Провести связи" : "Провести связь"}
        </button>
        <button type="button" className="rq-link rq-link--mut" onClick={onBack}>
          Назад к вопросу
        </button>
      </div>
    </>
  );
}
