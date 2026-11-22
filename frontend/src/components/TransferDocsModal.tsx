// Окно «Перенести документацию» (Р19 эпика «Элемент архитектуры»): собственная
// документация узла с вложенными объектами уходит потомкам по семьям фактов. У системы
// своей документации нет вовсе — схемы логики, спецификация и конфигурация; у контейнера
// с компонентами не на месте только схемы логики (они описывают код компонентов).
//
// Что у узла своего и кто что примет, считает сервер — одно превью
// (nodesApi.transferPreview, app/facts_transfer): у каждого потомка флаги «схемы логики» и
// «спецификация и конфигурация», подпись — путь от узла («orders / api»). Окно правил
// элемента не знает и получателей не отбирает. Узел без вложенных — отказ превью (422)
// его текстом. Применение — POST /nodes/{id}/docs/distribute; отказ сервера (занято имя,
// уже есть спецификация) — строкой над кнопками, окно открыто. После записи окно
// показывает итог (что перенесено) до «Закрыть», как окно «Собрать с компонентов».
//
// Вид (редизайн, фаза 9е): каркас окна нового языка (ui/ds.css, ds-win), части — блоками с
// заголовками обычным регистром, строка части высотой 30px: название слева (у схемы логики
// вид словом тихим цветом), список получателей ds-select справа. Списки во всех строках
// одной ширины и на одной вертикали (docWindows.css).
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { DistributeDocsOut, TransferDocsPreview } from "../types";
import { nodesApi, nodeDocsApi } from "../api/nodes";
import { ApiError } from "../api/client";
import Modal from "../ui/Modal";
import { plural } from "../ui/plural";
import { ChevronDownIcon, CloseIcon } from "../ui/icons";
import "../ui/ds.css";
import "./docWindows.css";

const TITLE = "Перенести документацию";
const LEAD_SYSTEM = "У системы своей документации нет. Выберите, куда перенести каждую часть.";
const LEAD_CONTAINER = "Схемы логики описывают код, и их можно перенести компонентам.";
const NONE = "Внутри нет подходящего объекта.";
const FAILED = "Не удалось загрузить данные объекта.";

interface Props {
  nodeId: string;
  onClose: () => void;
  // Перенос применён — страница перечитывает узел, потомков и параметры (окно
  // остаётся открытым с итогом).
  onApplied: () => void;
}

export default function TransferDocsModal({ nodeId, onClose, onApplied }: Props) {
  const [data, setData] = useState<TransferDocsPreview | null>(null);
  // Отказ превью: 422 — правило («внутри нет объектов») словами сервера, прочее — общий текст.
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    nodesApi.transferPreview(nodeId)
      .then((preview) => { if (alive) setData(preview); })
      .catch((e: unknown) => {
        if (alive) setFailed(e instanceof ApiError && e.status === 422 ? e.message : FAILED);
      });
    return () => { alive = false; };
  }, [nodeId]);

  if (failed !== null) {
    return (
      <Window onClose={onClose} foot={<button type="button" className="ds-btn" onClick={onClose}>Закрыть</button>}>
        <p className="ds-danger" role="alert">{failed}</p>
      </Window>
    );
  }
  if (!data) {
    return (
      <Window onClose={onClose}>
        <p className="dw-text dw-muted">Загружаем данные объекта</p>
      </Window>
    );
  }
  return <TransferForm key={data.node_id} data={data} onClose={onClose} onApplied={onApplied} />;
}

// Форма монтируется на загруженном превью: начальные назначения — из него.
function TransferForm({ data, onClose, onApplied }: {
  data: TransferDocsPreview;
  onClose: () => void;
  onApplied: () => void;
}) {
  const { receivers, docs } = data;
  const system = data.element_effective === "system";
  const logicTo = useMemo(() => receivers.filter((r) => r.takes_docs), [receivers]);
  const processTo = useMemo(() => receivers.filter((r) => r.takes_process_facts), [receivers]);
  // Спецификация и конфигурация не на месте только у системы: у контейнера они свои.
  const spec = system && data.has_spec;
  const params = system ? data.params : 0;

  const [docTo, setDocTo] = useState<Record<string, string>>(() =>
    Object.fromEntries(docs.map((d) => [d.doc_id, logicTo[0]?.node_id ?? ""])),
  );
  // "" — не переносить. По умолчанию — первый контейнер без своей спецификации.
  const [specTo, setSpecTo] = useState(() => (spec && processTo.find((r) => !r.has_spec)?.node_id) || "");
  const [paramsTo, setParamsTo] = useState(() => (params > 0 ? processTo[0]?.node_id ?? "" : ""));
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<DistributeDocsOut | null>(null);

  const apply = () => {
    setSending(true);
    setError(null);
    nodeDocsApi
      .distribute(data.node_id, {
        doc_assignments: docs
          .map((d) => ({ doc_id: d.doc_id, child_id: docTo[d.doc_id] ?? "" }))
          .filter((a) => a.child_id !== ""),
        ...(specTo !== "" ? { spec_child_id: specTo } : {}),
        ...(paramsTo !== "" ? { params_target_id: paramsTo } : {}),
      })
      .then((out) => {
        setResult(out);
        onApplied();
      })
      .catch((e: unknown) => {
        setError(e instanceof ApiError ? e.message : "Не удалось перенести документацию");
        setSending(false);
      });
  };

  if (result !== null) {
    return (
      <Window onClose={onClose} foot={
        <button type="button" className="ds-btn ds-btn--primary" onClick={onClose}>Закрыть</button>
      }>
        <p className="dw-text">{transferResult(result)}</p>
      </Window>
    );
  }

  return (
    <Window onClose={onClose} foot={
      <>
        {error && <p className="ds-danger ds-win-err" role="alert">{error}</p>}
        <button type="button" className="ds-btn ds-btn--primary" onClick={apply} disabled={sending}>
          {sending ? "Переносим" : "Перенести"}
        </button>
        <button type="button" className="ds-btn" onClick={onClose}>Отмена</button>
      </>
    }>
      <p className="dw-text">{system ? LEAD_SYSTEM : LEAD_CONTAINER}</p>

      {docs.length > 0 && (
        <Block title="Схемы логики" empty={logicTo.length === 0}>
          {docs.map((d) => (
            <Row
              key={d.doc_id}
              name={d.name}
              kind={d.kind === "operation" ? "операция" : "воркер"}
              label={`Куда перенести схему «${d.name}»`}
              value={docTo[d.doc_id] ?? ""}
              onChange={(v) => setDocTo((m) => ({ ...m, [d.doc_id]: v }))}
            >
              {logicTo.map((r) => <option key={r.node_id} value={r.node_id}>{r.path}</option>)}
            </Row>
          ))}
        </Block>
      )}

      {spec && (
        <Block title="Спецификация" empty={processTo.length === 0}>
          <Row name="OpenAPI" label="Куда перенести спецификацию" value={specTo} onChange={setSpecTo}>
            <option value="">Не переносить</option>
            {processTo.map((r) => (
              <option key={r.node_id} value={r.node_id} disabled={r.has_spec}>
                {r.path}{r.has_spec ? " (уже есть спецификация)" : ""}
              </option>
            ))}
          </Row>
        </Block>
      )}

      {params > 0 && (
        <Block title="Конфигурация" empty={processTo.length === 0}>
          <Row
            name={`${params} ${plural(params, ["параметр", "параметра", "параметров"])}`}
            label="Куда перенести конфигурацию"
            value={paramsTo}
            onChange={setParamsTo}
          >
            <option value="">Не переносить</option>
            {processTo.map((r) => <option key={r.node_id} value={r.node_id}>{r.path}</option>)}
          </Row>
        </Block>
      )}
    </Window>
  );
}

// Каркас окна: шапка с крестиком, тело с прокруткой, подвал (у загрузки его нет).
function Window({ onClose, foot, children }: { onClose: () => void; foot?: ReactNode; children: ReactNode }) {
  return (
    <Modal onClose={onClose} closeButton={false} boxStyle={{ width: 560, padding: 0 }}>
      <div className="ds ds-win dw-win">
        <div className="ds-win-head">
          <h2 className="ds-win-title">{TITLE}</h2>
          <button type="button" className="ds-icon-btn ds-win-close" aria-label="Закрыть" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="ds-win-body">{children}</div>
        {foot !== undefined && <div className="ds-win-foot">{foot}</div>}
      </div>
    </Modal>
  );
}

// Блок части документации: заголовок обычным регистром и строки; некому принять —
// «Внутри нет подходящего объекта.» тихим текстом.
function Block({ title, empty, children }: { title: string; empty: boolean; children: ReactNode }) {
  return (
    <section className="ds-win-block">
      <h3 className="ds-win-block-title">{title}</h3>
      {empty ? <p className="dw-text dw-muted">{NONE}</p> : <div className="dw-rows">{children}</div>}
    </section>
  );
}

// Строка «часть документации → получатель»: название (длинное — многоточием, целиком в
// подсказке), у схемы логики её вид словом; справа список получателей.
function Row({ name, kind, label, value, onChange, children }: {
  name: string;
  kind?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="dw-row">
      <span className="dw-row-name" title={name}>
        <span className="dw-row-text">{name}</span>
        {kind !== undefined && <span className="dw-row-kind">{kind}</span>}
      </span>
      <span className="ds-select">
        <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
          {children}
        </select>
        <ChevronDownIcon />
      </span>
    </div>
  );
}

// Итог переноса: перенесённые части по порядку окна, пустые не называются —
// «Перенесено: 2 схемы логики, спецификация, 3 параметра.»
function transferResult(out: DistributeDocsOut): string {
  const parts: string[] = [];
  if (out.moved_docs > 0) {
    parts.push(`${out.moved_docs} ${plural(out.moved_docs, ["схема логики", "схемы логики", "схем логики"])}`);
  }
  if (out.spec_moved) parts.push("спецификация");
  if (out.moved_params > 0) {
    parts.push(`${out.moved_params} ${plural(out.moved_params, ["параметр", "параметра", "параметров"])}`);
  }
  return parts.length > 0 ? `Перенесено: ${parts.join(", ")}.` : "Ничего не перенесено.";
}
