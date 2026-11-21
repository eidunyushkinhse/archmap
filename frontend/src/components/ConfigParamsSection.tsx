// Раздел «Конфигурация» на странице объекта: переменные окружения и параметры.
//
// Третья семья фактов после структуры БД и каналов брокера, и САМАЯ ПЛОСКАЯ: у
// параметра нет ни второго уровня (колонок/полей), ни групп, ни чужого владельца —
// он принадлежит самому сервису (docs/plan-config-docs.md §2.1). Поэтому здесь нет ни
// раскрывашек, ни группировки, которые есть у двух соседних разделов: строка таблицы —
// исчерпывающее представление параметра.
//
// ЗНАЧЕНИЙ НЕТ НИГДЕ: «по умолчанию» — текст дефолта ИЗ КОДА, а не значение среды.
// ArchMap не хранилище секретов, и поля под значение в модели нет вовсе.
//
// «Зависит» — разворот пометок «зависит от:» из схем логики этого объекта и, если он
// контейнер, его компонентов: пометка ищет ручку у ближайшего контейнера владельца схемы.
// Своя схема называется одним именем, схема компонента — с именем компонента.
//
// Видимость (редизайн, направление А «Документ»): конфигурацию читает то, что
// запускается, — контейнер или объект без вложенных вне контейнера. Там раздел подходит:
// пустой — у редактора одна строка (заголовок и «Добавить»), у читателя раздела нет. У
// системы и компонента раздела нет, пока у них не лежат старые параметры: тогда они
// показаны с предупреждением (у системы — с «Перенести документацию»). Исключение —
// компонент, схемы которого зависят от параметров контейнера: это факт о нём самом, и
// раздел называет эти параметры одной строкой.
//
// Таблица тихая: поля выглядят текстом и растут по тексту (ui/GrowField) — ничего не
// обрезается; крестик удаления виден при наведении на строку и при фокусе в ней.
import { useState } from "react";
import { configParamsApi } from "../api/nodes";
import { useAsyncLoad } from "../lib/useAsyncLoad";
import type { PageElement } from "./element/elementView";
import AddDocsMenu from "./AddDocsMenu";
import ConfigAgentModal from "./docsImport/ConfigAgentModal";
import type { ConfigParam, ConfigParamUsage } from "../types";
import "./configParams.css";
import { LimitNotice } from "./demo/DemoLimitNotice";
import { freeName, useFactRows } from "./useFactRows";
import { noAutofill } from "../ui/noAutofill";
import GrowField from "../ui/GrowField";
import Section from "../ui/Section";
import "../ui/ds.css";

interface Props {
  nodeId: string;
  // Как страница читает объект (components/element/elementView.pageElement).
  element: PageElement;
  isArchitect: boolean;
  // Положена ли конфигурация этой форме (shapeDocs.config). Не положена, а записи
  // есть — показываем их с предупреждением: спрятать применённое хуже, чем показать
  // (тот же приём, что у легаси-схем логики).
  allowed: boolean;
  // «Перенести документацию» (Р19) — у системы: своей конфигурации у неё нет, параметры
  // уходят потомку-контейнеру. undefined — кнопки нет.
  onTransfer?: () => void;
  // «Собрать с компонентов» — у контейнера, у компонентов которого есть параметры.
  onCollect?: () => void;
}

const TYPE_TITLE =
  "Тип значения, например string, int, bool, duration или json. Пишется свободно, " +
  "потому что у разных программ типы разные.";
const DEFAULT_TITLE =
  "Текст значения по умолчанию ИЗ КОДА («30s», «false»). Значения сред здесь не " +
  "хранятся, потому что ArchMap не хранилище секретов";
const REQUIRED_TITLE = "Обязательный: без него сервис не стартует";

export default function ConfigParamsSection({
  nodeId, element, isArchitect, allowed, onTransfer, onCollect,
}: Props) {
  const { rows: params, usage, error, limit, apply, reload } =
    useFactRows(nodeId, configParamsApi, "Не удалось загрузить конфигурацию");
  const kind = element.kind;
  const component = kind === "component" || kind === "composite" ? element.container : null;
  // Компонент: от каких параметров контейнера зависят его схемы — обратный индекс
  // контейнера, отобранный по схемам этого узла. Не компонент — запроса нет.
  const containerId = component?.id ?? null;
  const containerUsage = useAsyncLoad(
    containerId ? `config-usage:${containerId}` : "config-usage:none",
    () => (containerId ? configParamsApi.usage(containerId) : Promise.resolve([])),
  );
  const dependsOn = [...new Set(
    (containerUsage.data ?? []).filter((u) => u.node_id === nodeId).map((u) => u.param_name),
  )];
  // Окно дозаливки от агента: открывается пунктом того же меню, что и «Вручную».
  const [agentOpen, setAgentOpen] = useState(false);

  const addParam = () => {
    // Поля с серверным дефолтом генерат делает ОБЯЗАТЕЛЬНЫМИ (openapi-typescript,
    // default-non-nullable) — заполняем теми же значениями явно.
    void apply(() => configParamsApi.create(nodeId, {
      name: freeName("ПАРАМЕТР", (params ?? []).map((p) => p.name)),
      value_type: "", required: false, default_value: "",
    }));
  };

  // Пока список не приехал, раздела нет: пустая строка «Загрузка» у КАЖДОЙ базы и
  // брокера была бы шумом ради случая, которого почти не бывает.
  if (params === null && error === null) return null;
  const empty = (params ?? []).length === 0;
  // Новые параметры заводят только там, где конфигурацию читают: у контейнера и у
  // объекта без вложенных вне контейнера. У системы и компонента раздела без старых
  // параметров нет.
  const suitable = allowed && (kind === "leaf" || kind === "container");
  if (error === null && empty && dependsOn.length === 0 && (!suitable || !isArchitect)) return null;

  const usageOf = (paramId: string) => usage.filter((u) => u.param_id === paramId);

  const actions = isArchitect && allowed ? (
    <>
      {/* Конфигурацию читает запускаемое целиком (Р19): у системы она не на месте,
          у компонентов — тоже, контейнер собирает её к себе. */}
      {onTransfer && !empty && (
        <button type="button" className="ds-btn" onClick={onTransfer}>Перенести документацию</button>
      )}
      {onCollect && (
        <button type="button" className="ds-btn" onClick={onCollect}>Собрать с компонентов</button>
      )}
      {/* Тот же вход, что у «Логики», OpenAPI, структуры базы и каналов: «вручную /
          через агента» — пункты одного меню. */}
      {suitable && (
        <AddDocsMenu
          align="right"
          groups={[
            [{ label: "Вручную", onSelect: addParam }],
            [{ label: "Через ИИ-агента", onSelect: () => setAgentOpen(true) }],
          ]}
        />
      )}
    </>
  ) : null;

  return (
    <Section title="Конфигурация" actions={actions}>
      {error && <p className="np-warn">{error}</p>}
      {limit && <LimitNotice message={limit} />}
      {!allowed && (
        <p className="np-warn">
          Параметры конфигурации описывают настройки контейнера, а у этого объекта своих
          настроек нет. Перенесите параметры на контейнер, который с ним работает
        </p>
      )}
      {kind === "system" && !empty && (
        <p className="np-warn">
          Конфигурацию читают контейнеры, у системы её нет. Перенесите параметры одному из них
        </p>
      )}
      {component && dependsOn.length > 0 && (
        <p className="cfg-depends">
          Схемы этого компонента зависят от параметров контейнера «{component.name}»: {dependsOn.join(", ")}
        </p>
      )}
      {component && !empty && (
        <p className="np-warn">
          Конфигурацию читает контейнер целиком. Параметры можно перенести в «{component.name}» кнопкой «Собрать с компонентов» на его странице
        </p>
      )}
      {!empty && (
        <div className={"cfg-table" + (isArchitect ? "" : " cfg-table--ro")} role="table" aria-label="Параметры конфигурации">
          {/* Шапка: без неё колонка типа неотличима от колонки дефолта. Ширины — те же
              треки, что у строк, поэтому заголовки стоят ровно над своими значениями. */}
          <div className="cfg-row cfg-head" role="row">
            <span role="columnheader">Параметр</span>
            <span role="columnheader">Тип</span>
            <span role="columnheader">Обязательный</span>
            <span role="columnheader">По умолчанию</span>
            <span role="columnheader">Что переключает</span>
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
      {agentOpen && (
        <ConfigAgentModal
          nodeId={nodeId}
          onClose={() => setAgentOpen(false)}
          onApplied={reload}
        />
      )}
    </Section>
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

  // «Зависит» — ТОЛЬКО когда ссылки есть: тихой строкой под описанием параметра.
  const used = usage.length > 0 && (
    <div className="cfg-usage">
      Зависит:{" "}
      {usage
        .map((u) => (u.node_id === nodeId ? u.doc_name : `${u.doc_name} · ${u.node_name}`))
        .join(", ")}
    </div>
  );

  if (!isArchitect) {
    return (
      <div className="cfg-row" role="row">
        <span className="cfg-name" role="cell">{param.name}</span>
        <span role="cell">{param.value_type}</span>
        <span role="cell">{param.required ? "да" : ""}</span>
        <span className="cfg-default" role="cell">{param.default_value}</span>
        <span role="cell">
          {param.description}
          {used}
        </span>
      </div>
    );
  }

  return (
    <div className="cfg-row" role="row">
      <span role="cell">
        <GrowField
          {...noAutofill("config-params-section-1")}
          className="cfg-name"
          aria-label="Параметр"
          initial={param.name}
          key={`n:${param.id}:${param.version}`}
          onCommit={(v) => { if (v !== param.name) patch({ name: v }); }}
        />
      </span>
      <span role="cell">
        <GrowField
          {...noAutofill("config-params-section-2")}
          aria-label="Тип"
          placeholder="—"
          title={TYPE_TITLE}
          initial={param.value_type}
          key={`t:${param.id}:${param.version}`}
          onCommit={(v) => { if (v !== param.value_type) patch({ value_type: v }); }}
        />
      </span>
      <span role="cell" className="cfg-req">
        <input
          type="checkbox"
          className="cfg-check"
          checked={param.required}
          title={REQUIRED_TITLE}
          aria-label="Обязательный параметр"
          onChange={(e) => patch({ required: e.target.checked })}
        />
      </span>
      <span role="cell">
        <GrowField
          {...noAutofill("config-params-section-3")}
          className="cfg-default"
          aria-label="По умолчанию"
          placeholder="—"
          title={DEFAULT_TITLE}
          initial={param.default_value}
          key={`d:${param.id}:${param.version}`}
          onCommit={(v) => { if (v !== param.default_value) patch({ default_value: v }); }}
        />
      </span>
      {/* «Что переключает», а не «описание»: имя ручки обычно и так читаемо, а
          ценность несёт именно последствие её переключения. Поле растёт по тексту. */}
      <span role="cell">
        <GrowField
          {...noAutofill("config-params-section-4")}
          aria-label="Что переключает"
          placeholder="—"
          multiline
          initial={param.description ?? ""}
          key={`s:${param.id}:${param.version}`}
          onCommit={(v) => { if (v !== (param.description ?? "")) patch({ description: v }); }}
        />
        {used}
      </span>
      <span role="cell">
        <button
          type="button"
          className="ds-del"
          title="Удалить параметр"
          aria-label={`Удалить параметр ${param.name}`}
          onClick={() => void apply(() => configParamsApi.delete(nodeId, param.id))}
        >×</button>
      </span>
    </div>
  );
}
