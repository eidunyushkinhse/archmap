// Секция «Конфигурация» на странице объекта: переменные окружения и параметры.
//
// Третья семья фактов после структуры БД и каналов брокера, и САМАЯ ПЛОСКАЯ: у
// параметра нет ни второго уровня (колонок/полей), ни групп, ни чужого владельца —
// он принадлежит самому сервису (docs/plan-config-docs.md §2.1). Поэтому здесь нет ни
// раскрывашек, ни группировки, которые есть у двух соседних секций: строка таблицы —
// исчерпывающее представление параметра.
//
// ЗНАЧЕНИЙ НЕТ НИГДЕ: «по умолчанию» — текст дефолта ИЗ КОДА, а не значение среды.
// ArchMap не хранилище секретов, и поля под значение в модели нет вовсе.
//
// «Где используется» — разворот пометок «зависит от:» из схем логики ЭТОГО ЖЕ
// объекта: сослаться на ручку может только его собственная схема, поэтому в строке
// достаточно имени схемы (у таблиц и каналов там ещё и узел — там зовущий чужой).
import { useCallback, useEffect, useState } from "react";
import { configParamsApi } from "../api/nodes";
import AddDocsMenu from "./AddDocsMenu";
import InfoPopover from "../ui/InfoPopover";
import ConfigAgentModal from "./docsImport/ConfigAgentModal";
import type { ConfigParam, ConfigParamUsage } from "../types";
import "./configParams.css";
import { limitMessage } from "./demo/demoLimits";
import type { LimitMessage } from "./demo/demoLimits";
import { LimitNotice } from "./demo/DemoLimitNotice";
import { noAutofill } from "../ui/noAutofill";

interface Props {
  nodeId: string;
  isArchitect: boolean;
  // Положена ли конфигурация этой форме (shapeDocs.config). Не положена, а записи
  // есть — показываем их с предупреждением: спрятать применённое хуже, чем показать
  // (тот же приём, что у легаси-схем логики).
  allowed: boolean;
}

// Свободное имя вида «ПАРАМЕТР», «ПАРАМЕТР_2», … — чтобы «+ Параметр» не упиралась
// в 409 уникальности при повторном нажатии.
function freeName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const TYPE_TITLE =
  "Тип значения: string, int, bool, duration, json — свободная строка, а не перечень: " +
  "конфиги слишком разные";
const DEFAULT_TITLE =
  "Текст значения по умолчанию ИЗ КОДА («30s», «false»). Значения сред здесь не " +
  "хранятся — ArchMap не хранилище секретов";
const REQUIRED_TITLE = "Обязательный: без него сервис не стартует";

export default function ConfigParamsSection({ nodeId, isArchitect, allowed }: Props) {
  const [params, setParams] = useState<ConfigParam[] | null>(null);
  const [usage, setUsage] = useState<ConfigParamUsage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState<LimitMessage | null>(null);
  // Окно дозаливки от агента: открывается пунктом того же меню, что и «Вручную».
  const [agentOpen, setAgentOpen] = useState(false);

  // Перезагрузка — через счётчик, а не вызовом загрузчика из эффекта: setState прямо
  // в теле эффекта даёт каскад рендеров (тот же приём, что в соседних секциях).
  const [seq, setSeq] = useState(0);
  useEffect(() => {
    let alive = true;
    configParamsApi.list(nodeId)
      .then((ps) => { if (alive) { setParams(ps); setError(null); } })
      .catch(() => { if (alive) setError("Не удалось загрузить конфигурацию"); });
    configParamsApi.usage(nodeId)
      .then((u) => { if (alive) setUsage(u); })
      .catch(() => { if (alive) setUsage([]); });
    return () => { alive = false; };
  }, [nodeId, seq]);

  // Любая правка: применяем и перечитываем. Перечитывание — не лень: CAS-версия
  // приходит с сервера, и локальная склейка разъехалась бы на первой же ошибке.
  const apply = useCallback(async (fn: () => Promise<unknown>) => {
    setLimit(null);
    try {
      await fn();
      setError(null);
    } catch (e) {
      // Демо-стенд: правка упёрлась в предел проекта — отдельной плашкой с жирным
      // началом (docs/tasks/demo-mode.md); прочие отказы — как раньше.
      const refusal = limitMessage(e, "save");
      if (refusal) setLimit(refusal);
      else setError(e instanceof Error && e.message ? e.message : "Правка не прошла");
    }
    setSeq((n) => n + 1);
  }, []);

  const addParam = () => {
    const taken = new Set((params ?? []).map((p) => p.name));
    // Поля с серверным дефолтом генерат делает ОБЯЗАТЕЛЬНЫМИ (openapi-typescript,
    // default-non-nullable) — заполняем теми же значениями явно.
    void apply(() => configParamsApi.create(nodeId, {
      name: freeName("ПАРАМЕТР", taken),
      value_type: "", required: false, default_value: "",
    }));
  };

  // Форме конфигурация не положена и записей нет — секции не существует. Пока список
  // не приехал, тоже молчим: пустая карточка «Загрузка…» у КАЖДОЙ базы и брокера была
  // бы шумом ради случая, которого почти не бывает.
  const empty = (params ?? []).length === 0;
  if (!allowed && empty) return null;

  if (params === null && error === null) {
    return (
      <div className="np-card">
        <h3 className="np-card-title">Конфигурация</h3>
        <p className="np-empty">Загрузка…</p>
      </div>
    );
  }

  const usageOf = (paramId: string) => usage.filter((u) => u.param_id === paramId);

  return (
    <div className="np-card">
      <h3 className="np-card-title" style={{ display: "flex", alignItems: "center" }}>
        Конфигурация
        {/* Откуда берётся «зависит от:». Говорим это ОДИН раз на секцию, а не строкой у
            каждого параметра, и прячем за «?» (решение пользователя 2026-09-28):
            пояснение нужно раз, а видимый абзац под списком занимал место всегда. */}
        {!empty && (
          <span style={{ display: "inline-flex", marginLeft: 6, fontWeight: 400 }}>
            <InfoPopover label="Откуда берётся «Зависит от»" width={340} iconSize={17}>
              <p>
                «Зависит от» собирается из пометок «зависит от: ИМЯ» в схемах логики этого
                объекта. Своей формы ввода у зависимости нет.
              </p>
            </InfoPopover>
          </span>
        )}
      </h3>
      {error && <p className="np-warn">{error}</p>}
      {limit && <LimitNotice message={limit} />}
      {!allowed && (
        <p className="np-warn">
          Конфигурация описывает ручки сервиса, а у этого объекта их нет — перенесите
          её на сервис, который с ним работает
        </p>
      )}
      {empty ? (
        <p className="np-empty">Параметры не описаны</p>
      ) : (
        <div className="cfg-list">
          {/* Шапка: без неё колонка типа неотличима от колонки дефолта. Ширины — те же
              классы, что у строк, поэтому заголовки стоят ровно над своими полями. */}
          <div className={"cfg-row cfg-head" + (isArchitect ? "" : " cfg-row--ro")} aria-hidden>
            <span className="cfg-name">Параметр</span>
            <span className="cfg-type">Тип</span>
            <span className="cfg-req">обяз.</span>
            <span className="cfg-default">По умолчанию</span>
            <span className="cfg-desc">Что переключает</span>
            {isArchitect && <span />}
          </div>
          {(params ?? []).map((p) => (
            <ParamRow
              key={p.id}
              param={p}
              nodeId={nodeId}
              isArchitect={isArchitect}
              usage={usageOf(p.id)}
              apply={apply}
            />
          ))}
        </div>
      )}
      {isArchitect && allowed && (
        <div className="cfg-actions">
          {/* Тот же вход, что у «Логики», OpenAPI, структуры базы и каналов: одна
              кнопка с шевроном, а «вручную / через агента» — пункты меню. Два способа
              завести одну сущность не должны выглядеть как две разные кнопки. */}
          <AddDocsMenu
            label="+ Параметр"
            groups={[
              [{ label: "Вручную", onSelect: addParam }],
              [{ label: "Через ИИ-агента", onSelect: () => setAgentOpen(true) }],
            ]}
          />
        </div>
      )}
      {agentOpen && (
        <ConfigAgentModal
          nodeId={nodeId}
          onClose={() => setAgentOpen(false)}
          onApplied={() => setSeq((n) => n + 1)}
        />
      )}
    </div>
  );
}

function ParamRow({
  param, nodeId, isArchitect, usage, apply,
}: {
  param: ConfigParam;
  nodeId: string;
  isArchitect: boolean;
  usage: ConfigParamUsage[];
  apply: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const patch = (data: Parameters<typeof configParamsApi.update>[2]) =>
    void apply(() => configParamsApi.update(nodeId, param.id, {
      ...data, base_version: param.version,
    }));

  // Строка использования — ТОЛЬКО когда ссылки есть: см. подсказку внизу секции.
  const used = usage.length > 0 && (
    <div className="cfg-usage">
      <span className="cfg-usagelabel">зависит:</span>
      <span className="cfg-ro cfg-usagedocs">{usage.map((u) => u.doc_name).join(", ")}</span>
    </div>
  );

  if (!isArchitect) {
    return (
      <div className="cfg-item">
        <div className="cfg-row cfg-row--ro cfg-ro">
          <span className="cfg-name">{param.name}</span>
          <span className="cfg-type">{param.value_type}</span>
          {/* Признак — ОДНОЙ ячейкой: иначе его отсутствие сдвигало бы соседние
              колонки и строки перестали бы стоять друг под другом. */}
          <span className="cfg-req">
            {param.required && <span className="cfg-flag">обяз.</span>}
          </span>
          <span className="cfg-default">{param.default_value}</span>
          <span className="cfg-desc">{param.description}</span>
        </div>
        {used}
      </div>
    );
  }

  return (
    <div className="cfg-item">
      <div className="cfg-row">
        <input
          {...noAutofill("config-params-section-1")}
          className="np-field cfg-name"
          defaultValue={param.name}
          key={`n:${param.id}:${param.version}`}
          onBlur={(e) => { if (e.target.value !== param.name) patch({ name: e.target.value }); }}
        />
        <input
          {...noAutofill("config-params-section-2")}
          className="np-field cfg-type"
          placeholder="string/int/bool"
          title={TYPE_TITLE}
          defaultValue={param.value_type}
          key={`t:${param.id}:${param.version}`}
          onBlur={(e) => {
            if (e.target.value !== param.value_type) patch({ value_type: e.target.value });
          }}
        />
        <input
          type="checkbox"
          className="cfg-check"
          checked={param.required}
          title={REQUIRED_TITLE}
          aria-label="Обязательный параметр"
          onChange={(e) => patch({ required: e.target.checked })}
        />
        <input
          {...noAutofill("config-params-section-3")}
          className="np-field cfg-default"
          placeholder="дефолт из кода"
          title={DEFAULT_TITLE}
          defaultValue={param.default_value}
          key={`d:${param.id}:${param.version}`}
          onBlur={(e) => {
            if (e.target.value !== param.default_value) patch({ default_value: e.target.value });
          }}
        />
        {/* «Что переключает», а не «описание»: имя ручки обычно и так читаемо, а
            ценность несёт именно последствие её переключения. */}
        <input
          {...noAutofill("config-params-section-4")}
          className="np-field cfg-desc"
          placeholder="что переключает"
          defaultValue={param.description ?? ""}
          key={`s:${param.id}:${param.version}`}
          onBlur={(e) => {
            if (e.target.value !== (param.description ?? "")) {
              patch({ description: e.target.value });
            }
          }}
        />
        <button
          type="button"
          className="cfg-del"
          title="Удалить параметр"
          onClick={() => void apply(() => configParamsApi.delete(nodeId, param.id))}
        >×</button>
      </div>
      {used}
    </div>
  );
}
