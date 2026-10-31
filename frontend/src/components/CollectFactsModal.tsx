// Окно «Собрать с компонентов» (Р19 эпика «Элемент архитектуры»): конфигурация и
// спецификация компонентов переезжают их контейнеру — факты процесса читает и отдаёт
// запускаемое целиком. Знание контейнера в приоритете (решения владельца 2026-10-31):
// параметр, который у контейнера уже есть, и своя спецификация контейнера остаются, а
// одноимённое у компонентов отбрасывается — окно говорит это строками-фактами.
// Краевые случаи — вопросы на языке разбора ввоза (project/remainder): одноимённый
// параметр только у компонентов и несколько спецификаций при пустом контейнере.
// Ничего не предвыбрано; дефолт «как сейчас» — пунктирный вариант, и «Собрать»
// доступна без ответов: вопрос без ответа оставляет записи у компонентов.
//
// Превью (GET /nodes/{id}/facts/collect-preview) страница уже загрузила — по нему она
// решила показать кнопку, окно его только читает. Применение — POST …/facts/collect;
// отказ сервера — текстом под формой, окно открыто. После записи окно показывает итог
// (собрано, отброшено, осталось у компонентов) до «Закрыть».
import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { CollectFactsOut, CollectFactsPreview } from "../types";
import { nodesApi } from "../api/nodes";
import { ApiError } from "../api/client";
import Modal from "../ui/Modal";
import DialogTitle from "../ui/DialogTitle";
import { primaryBtn, secondaryBtn } from "../ui/styles";
import { DocViewer, Option, PathLabel, SplitOption } from "./project/remainder";
import "./project/remainder/remainder.css";
import {
  asksSpec, candidateSub, collectFacts, collectLine, collectResult, droppedParams, isParamQuestion,
  paramQuestion, specHolders, specQuestion,
} from "./element/collectTexts";
import type { CollectQuestionTexts } from "./element/collectTexts";

interface Props {
  nodeId: string;
  nodeName: string;
  preview: CollectFactsPreview;
  onClose: () => void;
  // Сбор применён — страница перечитывает узел, потомков и параметры.
  onApplied: () => void;
}

// Ответ «как сейчас»: id объектов — UUID, со словом не совпадут.
const KEEP = "keep";

export default function CollectFactsModal({ nodeId, nodeName, preview, onClose, onApplied }: Props) {
  // Ответы: имя параметра → node_id выбранного или KEEP; спецификация — так же. Нет
  // ключа — вопрос без ответа (то же, что KEEP, но вариант не подсвечен).
  const [params, setParams] = useState<Record<string, string>>({});
  const [spec, setSpec] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ id: string; name: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<CollectFactsOut | null>(null);

  const facts = collectFacts(preview, nodeId);
  const dropped = droppedParams(preview, nodeId);
  const asked = preview.param_clashes.filter(isParamQuestion);
  const holders = specHolders(preview, nodeId);
  const askSpec = asksSpec(preview, nodeId);

  const apply = () => {
    setSending(true);
    setError(null);
    nodesApi
      .collectFacts(nodeId, {
        param_choices: asked.flatMap((c) => {
          const v = params[c.name];
          return v !== undefined && v !== KEEP ? [{ name: c.name, node_id: v }] : [];
        }),
        ...(askSpec && spec !== null && spec !== KEEP ? { spec_from: spec } : {}),
      })
      .then((out) => {
        setResult(out);
        onApplied();
      })
      .catch((e: unknown) => {
        setError(e instanceof ApiError ? e.message : "Не удалось собрать документацию");
        setSending(false);
      });
  };

  const openSpec = (s: { node_id: string; name: string }) => {
    nodesApi.get(s.node_id)
      .then((n) => setViewer({ id: s.node_id, name: s.name, body: n.openapi_spec ?? "" }))
      .catch(() => setError("Не удалось открыть спецификацию"));
  };

  if (result !== null) {
    return (
      <Modal onClose={onClose} boxStyle={{ width: 560 }}>
        <DialogTitle>Собрать с компонентов</DialogTitle>
        {collectResult(result).map((line) => <p key={line} style={resultLine}>{line}</p>)}
        <div style={footRow}>
          <button type="button" onClick={onClose} style={primaryBtn}>Закрыть</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose} boxStyle={{ width: 560 }}>
      <DialogTitle lead={
        "Конфигурацию читает контейнер целиком, а спецификацию отдаёт он же. Параметры и "
        + `спецификации компонентов переедут в «${nodeName}», а где у контейнера есть своё `
        + "описание, останется оно."
      }>
        Собрать с компонентов
      </DialogTitle>

      <ul style={list}>
        {preview.components.map((c) => <li key={c.node_id}>{collectLine(c, dropped[c.node_id])}</li>)}
      </ul>
      {facts.length > 0 && (
        <ul style={factList}>
          {facts.map((f) => <li key={f}>{f}</li>)}
        </ul>
      )}

      {(asked.length > 0 || askSpec) && (
        <div className="rq-root">
          {asked.map((c) => (
            <Question key={c.name} texts={paramQuestion(c, nodeName)}>
              {c.candidates.map((k) => (
                <Option
                  key={k.node_id}
                  main={<PathLabel path={k.node_name} />}
                  sub={candidateSub(k.description)}
                  selected={params[c.name] === k.node_id}
                  onClick={() => setParams((m) => ({ ...m, [c.name]: k.node_id }))}
                />
              ))}
              <Option
                main="Оставить у компонентов"
                tag="как сейчас"
                keep
                selected={params[c.name] === KEEP}
                onClick={() => setParams((m) => ({ ...m, [c.name]: KEEP }))}
              />
            </Question>
          ))}
          {askSpec && (
            <Question texts={specQuestion(holders.map((h) => h.name), nodeName)}>
              {holders.map((h) => (
                <SplitOption
                  key={h.node_id}
                  main={<PathLabel path={h.name} />}
                  selected={spec === h.node_id}
                  onSelect={() => setSpec(h.node_id)}
                  open={viewer?.id === h.node_id}
                  onOpen={() => openSpec(h)}
                />
              ))}
              <Option
                main="Оставить у компонентов"
                tag="как сейчас"
                keep
                selected={spec === KEEP}
                onClick={() => setSpec(KEEP)}
              />
            </Question>
          )}
        </div>
      )}

      {viewer !== null && (
        <DocViewer
          title={viewer.name}
          source="спецификация"
          tag="openapi"
          body={viewer.body}
          diagram={false}
          onPick={() => { setSpec(viewer.id); setViewer(null); }}
          onClose={() => setViewer(null)}
        />
      )}

      {error && <p style={errText}>{error}</p>}

      <div style={footRow}>
        <button
          type="button"
          onClick={apply}
          disabled={sending}
          style={{ ...primaryBtn, ...(sending ? { opacity: 0.6, cursor: "default" } : {}) }}
        >
          {sending ? "Собираем" : "Собрать"}
        </button>
        <button type="button" onClick={onClose} style={secondaryBtn}>Отмена</button>
      </div>
    </Modal>
  );
}

// Вопрос в виде разбора ввоза (RemainderBlock): заголовок, «почему» свёрнутым, варианты
// и сноска «Если не отвечать». Шапки с прогрессом и навигации нет: вопросов в окне
// один–три, они идут списком.
function Question({ texts, children }: { texts: CollectQuestionTexts; children: ReactNode }) {
  return (
    <div className="rq-block">
      <div className="rq-bd">
        <h4 className="rq-q">{texts.title}</h4>
        <details className="rq-why">
          <summary>почему возник вопрос</summary>
          <p>{texts.why}</p>
        </details>
        <div className="rq-opts">{children}</div>
        <div className="rq-ifnot">{texts.ifLeft}</div>
      </div>
    </div>
  );
}

/* --------------------------------- стили --------------------------------- */
const list: CSSProperties = { margin: "4px 0 0", paddingLeft: 18, fontSize: 13.5, color: "#1e293b", lineHeight: 1.7 };
const factList: CSSProperties = { margin: "10px 0 0", paddingLeft: 18, fontSize: 13, color: "#475569", lineHeight: 1.55 };
const resultLine: CSSProperties = { margin: "0 0 6px", fontSize: 14, color: "#1e293b", lineHeight: 1.5 };
const errText: CSSProperties = { color: "#dc2626", margin: "10px 0 0", fontSize: 13 };
const footRow: CSSProperties = { display: "flex", gap: 8, marginTop: 16 };
