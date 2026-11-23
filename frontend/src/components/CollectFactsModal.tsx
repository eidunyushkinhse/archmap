// Окно «Собрать с компонентов» (Р19 эпика «Элемент архитектуры»): конфигурация и
// спецификация компонентов переезжают их контейнеру — факты процесса читает и отдаёт
// запускаемое целиком. Знание контейнера в приоритете (решения владельца 2026-10-31):
// параметр, который у контейнера уже есть, и своя спецификация контейнера остаются, а
// одноимённое у компонентов отбрасывается — окно говорит это строками-фактами.
// Краевые случаи — вопросы на языке разбора ввоза (project/remainder): одноимённый
// параметр только у компонентов и несколько спецификаций при пустом контейнере.
// Ничего не предвыбрано; вариант «Оставить у компонентов» действует без ответа и помечен
// словом «по умолчанию», «Собрать» доступна без ответов: вопрос без ответа оставляет
// записи у компонентов.
//
// Превью (GET /nodes/{id}/facts/collect-preview) страница уже загрузила — по нему она
// решила показать кнопку, окно его только читает. Применение — POST …/facts/collect;
// отказ сервера — строкой над кнопками, окно открыто. После записи окно показывает итог
// (собрано, отброшено, осталось у компонентов) до «Закрыть».
//
// Вид (редизайн, фаза 9е): каркас окна нового языка (ui/ds.css, ds-win), компоненты двумя
// колонками (имя и что у него есть) без маркеров, факты абзацами. Вопросы того же вида, что
// в окнах ввоза: заголовок со знаком «?» (почему возник вопрос и что будет без ответа),
// варианты с пометкой «по умолчанию». Вид вариантов задан в области .imp-res
// (project/importResult.css): окно ставит её на свой корень, копии правил нет.
import { useState } from "react";
import type { ReactNode } from "react";
import type { CollectFactsOut, CollectFactsPreview } from "../types";
import { nodesApi } from "../api/nodes";
import { ApiError } from "../api/client";
import Modal from "../ui/Modal";
import InfoPopover from "../ui/InfoPopover";
import { CloseIcon } from "../ui/icons";
import { DocViewer, Option, PathLabel, SplitOption } from "./project/remainder";
import {
  asksSpec, candidateSub, collectFacts, collectResult, collectRow, droppedParams, isParamQuestion,
  paramQuestion, specHolders, specQuestion,
} from "./element/collectTexts";
import type { CollectQuestionTexts } from "./element/collectTexts";
import "../ui/ds.css";
import "./project/remainder/remainder.css";
import "./project/importResult.css";
import "./docWindows.css";

interface Props {
  nodeId: string;
  nodeName: string;
  preview: CollectFactsPreview;
  onClose: () => void;
  // Сбор применён — страница перечитывает узел, потомков и параметры.
  onApplied: () => void;
}

// Ответ «Оставить у компонентов»: id объектов — UUID, со словом не совпадут.
const KEEP = "keep";
const TITLE = "Собрать с компонентов";

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
      <Window onClose={onClose} foot={
        <button type="button" className="ds-btn ds-btn--primary" onClick={onClose}>Закрыть</button>
      }>
        {collectResult(result).map((line) => <p key={line} className="dw-text">{line}</p>)}
      </Window>
    );
  }

  return (
    <Window onClose={onClose} foot={
      <>
        {error && <p className="ds-danger ds-win-err" role="alert">{error}</p>}
        <button type="button" className="ds-btn ds-btn--primary" onClick={apply} disabled={sending}>
          {sending ? "Собираем" : "Собрать"}
        </button>
        <button type="button" className="ds-btn" onClick={onClose}>Отмена</button>
      </>
    }>
      <p className="dw-text">
        {"Конфигурацию читает контейнер целиком, а спецификацию отдаёт он же. Параметры и "
          + `спецификации компонентов переедут в «${nodeName}», а где у контейнера есть своё `
          + "описание, останется оно."}
      </p>

      {/* Компоненты: имя слева, что у него есть — тихим цветом справа. */}
      <div className="ds-confirm-rows">
        {preview.components.map((c) => {
          const row = collectRow(c, dropped[c.node_id]);
          return (
            <div key={c.node_id} className="ds-confirm-row">
              <span className="ds-confirm-row-name" title={row.name}>{row.name}</span>
              <span className="ds-confirm-row-value">{row.holds}</span>
            </div>
          );
        })}
      </div>
      {facts.map((f) => <p key={f} className="dw-text">{f}</p>)}

      {(asked.length > 0 || askSpec) && (
        <div className="rq-root dw-questions">
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
                byDefault
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
                byDefault
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
          body={viewer.body}
          diagram={false}
          onPick={() => { setSpec(viewer.id); setViewer(null); }}
          onClose={() => setViewer(null)}
        />
      )}
    </Window>
  );
}

// Каркас окна: шапка с крестиком, тело с прокруткой, подвал. Область .imp-res даёт
// вопросам вид окон ввоза (project/importResult.css).
function Window({ onClose, foot, children }: { onClose: () => void; foot: ReactNode; children: ReactNode }) {
  return (
    <Modal onClose={onClose} boxStyle={{ width: 560, padding: 0 }}>
      <div className="ds ds-win imp-res">
        <div className="ds-win-head">
          <h2 className="ds-win-title">{TITLE}</h2>
          <button type="button" className="ds-icon-btn ds-win-close" aria-label="Закрыть" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="ds-win-body">{children}</div>
        <div className="ds-win-foot">{foot}</div>
      </div>
    </Modal>
  );
}

// Вопрос в виде окон ввоза (RemainderBlock): заголовок со знаком «?» и варианты. Шапки со
// счётчиком и навигации нет: вопросов в окне один–три, они идут списком.
function Question({ texts, children }: { texts: CollectQuestionTexts; children: ReactNode }) {
  return (
    <section>
      <h4 className="rq-q"><TitleWithWhy texts={texts} /></h4>
      <div className="rq-opts">{children}</div>
    </section>
  );
}

/**
 * Заголовок вопроса со знаком «?» сразу после текста: в подсказке «почему возник вопрос» и
 * «Если не отвечать, то …» (так же, как в окнах ввоза, RemainderBlock). Последнее слово и
 * знак в одной обёртке без переноса: знак не уезжает на строку один.
 */
function TitleWithWhy({ texts }: { texts: CollectQuestionTexts }) {
  const cut = texts.title.lastIndexOf(" ") + 1;
  return (
    <>
      {texts.title.slice(0, cut)}
      <span className="rq-q-end">
        {texts.title.slice(cut)}
        <InfoPopover label="Почему возник вопрос" width={380}>
          <p>{texts.why}</p>
          <p>{texts.ifLeft}</p>
        </InfoPopover>
      </span>
    </>
  );
}
