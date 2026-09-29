import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type {
  SchemaAlerts as Alerts,
  UnresolvedChannelRefAlert,
  UnresolvedDataRefAlert,
} from "../types";
import { plural } from "../ui/plural";
import { BulbIcon } from "../ui/icons";
import "./schemaAlerts.css";

/**
 * Рекомендации по схеме для архитектора (подача «А1. Чистый список», 2026-09-29;
 * прежде — янтарный знак «Незавершённость схемы» со счётчиком, пульсом и тостом).
 * В коде и спеках словарь прежний («алерты», спека alerts.md), в интерфейсе —
 * только «Рекомендации».
 *
 *  • Кнопка-иконка «Рекомендации» (лампочка) того же вида, что «три точки»
 *    (SchemaActions), видна ВСЕГДА, в том числе при нуле рекомендаций. Пока
 *    рекомендации есть, в углу кнопки маленькая серая точка; числа нет.
 *  • Клик раскрывает панель: разделы подписями с числом, пункты обычным текстом.
 *    Все рекомендации равнозначны — ни деления по важности, ни выделения цветом.
 *    Пункт кликабелен и ведёт к объекту/связи на схеме (через onLocate — поведение
 *    перехода реализует вызывающая сторона); стрелка «→» появляется у пункта под
 *    курсором. Пустая панель говорит «Рекомендаций нет».
 *
 * Разделы (формулировки на «объект», не «узел»):
 *  1) Объекты без связей — атомарные объекты без единой связи;
 *  2) Связи в контейнер — связь упирается в контейнер, а не в атомарный объект;
 *  3) Изолированные группы — схема распалась на ≥2 несвязанных кластера;
 *  4) Контейнеры со своей документацией — у контейнера остались собственные
 *     (grandfather) логические диаграммы и/или спека; их надо распределить по
 *     дочерним сервисам. ЧТО ИМЕННО осталось, строка не уточняет: конкретное
 *     предупреждение с путём исправления живёт на странице объекта;
 *  5) Пользователи внутри контейнера — узел-человек вложен в другой объект, а по C4
 *     люди живут на контекстном уровне, ЗА границей системы;
 *  6) Незадокументированные сообщения — связь, которой шло сообщение, удалена из
 *     схемы. Клик ведёт В ПРОЦЕСС (чинить на холсте нечего), поэтому строки
 *     кликабельны только там, где переход передан (onOpenProcess);
 *  7) Обращения к неописанным данным — пометка «читает:/пишет:» в схеме логики не
 *     нашла свою таблицу структуры (AL29). Пометка — обещание факта, и строка
 *     называет причину невыполнения: таблицы нет / имя неоднозначно / нет колонки;
 *  8) Обращения к неописанным каналам — то же для событий: «публикует:/потребляет:»
 *     не нашла канал в структуре брокеров (AL30). Класс отдельный от (7): причины и
 *     слова починки свои («укажите „Брокер / канал“»), а искать топик в структуре
 *     базы человека посылать нельзя;
 *  9) Связи с брокером без канала — стрелка в брокер не назвала топик/очередь либо
 *     назвала неизвестный структуре (AL31). Чинится в инспекторе самой связи,
 *     поэтому строка ведёт К СВЯЗИ на схеме;
 * 10) Связи в собственный компонент — связь между узлом и его же потомком (AL32).
 *     Класс ОТДЕЛЬНЫЙ от (2): там конец уточняют до компонента, а здесь конец уже
 *     компонент этого самого контейнера — вложенность выражает иерархия, и связь
 *     удаляют либо перевешивают. Строка ведёт К СВЯЗИ на схеме.
 * 11) Объекты с неописанными схемами логики — у объекта есть заглушки разведки
 *     (схемы без тела, AL35). ОДНА строка на объект с числом заглушек, а не строка
 *     на заглушку: построчный бэклог живёт на странице объекта (блок «Не описано»).
 *     Строка ведёт К ОБЪЕКТУ на схеме, как (4).
 * Алерты глобальные, считаются на бэке — здесь только отображение.
 */

export type LocateTarget =
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string }
  | { kind: "group"; ids: string[] };

interface Props {
  alerts: Alerts;
  // Открыть процесс с повисшим сообщением. Не часть onLocate: цель не на схеме,
  // а в другом режиме — и передаётся только там, где такой переход существует.
  onOpenProcess?: (processId: string) => void;
  // Переход к проблемному объекту/связи на схеме (pan + подсветка) — реализуется
  // вызывающей стороной (MapEditorPage). Если не передан — пункты не кликабельны.
  onLocate?: (target: LocateTarget) => void;
  // Размер кнопки — как у соседних «трёх точек» (SchemaActions): в шапке оболочки
  // 34, на холсте редактора 32.
  size?: number;
  // Где стоит кнопка: на холсте она висит над схемой и получает лёгкую тень.
  placement?: "header" | "canvas";
}

// Почему пометка не срослась. Текст обязан подсказывать действие: неоднозначность
// лечится квалификатором, поэтому строка прямо его называет.
const REF_REASON: Record<UnresolvedDataRefAlert["reason"], string> = {
  unknown_table: "таблица не найдена",
  ambiguous: "имя неоднозначно — укажите „БД / таблица“",
  unknown_column: "колонки нет в таблице",
};

// То же для каналов: слова СВОИ — «Брокер / канал» вместо «БД / таблица», иначе
// подсказка ведёт чинить не туда.
const CHANNEL_REASON: Record<UnresolvedChannelRefAlert["reason"], string> = {
  unknown_channel: "канал не найден у брокеров проекта",
  ambiguous: "имя неоднозначно — укажите „Брокер / канал“",
  unknown_field: "поля нет в канале",
};

export default function SchemaAlerts({ alerts, onLocate, onOpenProcess, size = 32, placement = "header" }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const disconnected = alerts.disconnected_nodes;
  const intermediate = alerts.intermediate_edges;
  // Связи узла с его же потомком: иерархия вложенность уже выразила. Отдельно от
  // «связей в контейнер» — там конец уточняют до компонента, здесь связь лишняя целиком.
  const descendant = alerts.descendant_edges;
  const isolated = alerts.isolated_groups;
  // Правила контейнеров: контейнер с СОБСТВЕННЫМИ доками/спекой (grandfather) —
  // каждая такая запись = 1 проблема (схемы/спеку надо распределить по детям).
  const containerOwn = alerts.container_own_docs;
  // Люди внутри системы: каждый вложенный человек — одна проблема (вынести в корень).
  const personsInside = alerts.persons_inside;
  // Повисшие сообщения процессов: связь под сообщением удалили из схемы.
  const dangling = alerts.dangling_messages;
  // Участники процессов без узла схемы: линия жизни есть, объекта архитектуры за ней
  // нет (импорт не сопоставил имя либо узел удалили). Чинится привязкой на шапке.
  const unbound = alerts.unbound_participants;
  // Шаги, у которых пропало ПЛЕЧО канала: связь на месте, но она стала асинхронной,
  // а у такой «ответа» не бывает. Отдельно от повисших: «Восстановить связи» тут
  // бессильна — чинится возвратом синхронности либо удалением шага.
  const orphanLegs = alerts.orphan_legs;
  // Пометки обращений, не нашедшие свою таблицу: текст обещает факт, а структура его
  // не подтверждает. Единственное место, где видна битая КОЛОНКА — обратный индекс
  // базы показывает такую пометку как обращение к таблице целиком.
  const unresolvedRefs = alerts.unresolved_data_refs;
  // То же для событий: пометка обещала канал, а структура брокеров его не знает.
  // Отдельный класс — чинится другими словами (см. CHANNEL_REASON).
  const unresolvedChannelRefs = alerts.unresolved_channel_refs;
  // И то же для конфигурации: пометка обещала ручку, а её у ОБЪЕКТА нет (искать
  // больше негде — параметры принадлежат самому сервису). Причины у класса нет:
  // она единственная, поэтому и в записи её не передают.
  const unresolvedConfigRefs = alerts.unresolved_config_refs;
  // Связи с брокером, не назвавшие канал (или назвавшие неизвестный): шов «стрелка ↔
  // структура брокера» держат алерты, а не FK, — это единственное место, где он виден.
  const brokerEdges = alerts.broker_edge_channels;
  // Шаги процессов без привязки к схеме логики — алерт ПОЛНОТЫ (Р4 «шумно, зато
  // консистентно»): не «сломалось», а «не документировано», гаснет привязкой шагов.
  const unlinkedMessages = alerts.unlinked_messages;
  // Объекты с заглушками разведки (схемы без тела) — та же полнота, но ОДНА запись
  // на объект: две сотни строк после разведки монолита были бы стеной, а не сигналом.
  const undescribedDocs = alerts.undescribed_docs;
  // Изолированные группы — это «не хватает (групп − 1) связей»: 2 группы → 1 недостающая
  // связь, 3 → 2 и т.д. В общее число рекомендаций идёт groups − 1 (число проблем), а
  // в число самого раздела — фактическое число групп (см. ниже). Общее число на экран
  // не выводится: оно лишь зажигает точку на кнопке и решает, пуста ли панель.
  const isolatedProblems = Math.max(0, isolated.length - 1);
  const total =
    disconnected.length + intermediate.length + descendant.length + isolatedProblems +
    containerOwn.length + personsInside.length + dangling.length + unbound.length +
    orphanLegs.length + unresolvedRefs.length + unresolvedChannelRefs.length +
    unresolvedConfigRefs.length + brokerEdges.length + unlinkedMessages.length +
    undescribedDocs.length;

  // Закрытие панели по клику вне и по Escape
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as globalThis.Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Клик по пункту ведёт к цели (на страницу объекта или в редактор) — переход
  // уводит с текущего экрана, поэтому панель сразу закрываем.
  const locate = (target: LocateTarget) => {
    setOpen(false);
    onLocate?.(target);
  };

  return (
    <div ref={ref} style={wrap}>
      <button
        type="button"
        className={"sa-btn" + (placement === "canvas" ? " sa-btn--canvas" : "")}
        style={{ width: size, height: size }}
        onClick={() => setOpen((o) => !o)}
        title="Рекомендации"
        aria-label="Рекомендации"
        aria-expanded={open}
      >
        <BulbIcon />
        {/* Точка вместо числа: «есть что посмотреть», а не «сколько долга». */}
        {total > 0 && <span className="sa-dot" aria-hidden="true" />}
      </button>

      {open && (
        <div className="sa-panel" role="dialog" aria-label="Рекомендации">
          <div className="sa-head">
            <h3 className="sa-title">Рекомендации</h3>
            {total > 0 && <p className="sa-sub">Что ещё можно дополнить в схеме.</p>}
          </div>

          {/* Пустые разделы не рендерятся, поэтому при нуле ниже ничего нет. */}
          {total === 0 && <div className="sa-empty">Рекомендаций нет. Схема описана полностью.</div>}

          <Section title="Объекты без связей" count={disconnected.length}>
            {disconnected.map((d) => (
              <Item key={d.node_id} onClick={onLocate && (() => locate({ kind: "node", id: d.node_id }))}>
                {d.node_name}
              </Item>
            ))}
          </Section>

          <Section title="Связи в контейнер" count={intermediate.length}>
            {intermediate.map((e) => (
              <Item key={e.edge_id} onClick={onLocate && (() => locate({ kind: "edge", id: e.edge_id }))}>
                <span className="sa-row">
                  <span className={e.source_is_intermediate ? "sa-strong" : undefined}>{e.source_name}</span>
                  <span className="sa-muted">→</span>
                  <span className={e.target_is_intermediate ? "sa-strong" : undefined}>{e.target_name}</span>
                </span>
              </Item>
            ))}
          </Section>

          {/* Связь узла с его же потомком: совет тут ПРОТИВОПОЛОЖЕН соседней секции —
              не «уточните конец», а «удалите или перевесьте». Строка ведёт К СВЯЗИ. */}
          <Section title="Связи в собственный компонент" count={descendant.length}>
            {descendant.map((e) => {
              const part = e.source_is_part ? e.source_name : e.target_name;
              const whole = e.source_is_part ? e.target_name : e.source_name;
              return (
                <Item key={e.edge_id} onClick={onLocate && (() => locate({ kind: "edge", id: e.edge_id }))}>
                  <span className="sa-line">
                    <span className="sa-where">{e.source_name} → {e.target_name}:</span>{" "}
                    <span className="sa-strong">«{part}»</span> — часть «{whole}»
                  </span>
                  <span className="sa-hint">
                    иерархия уже выражает вложенность — удалите связь или перевесьте её
                  </span>
                </Item>
              );
            })}
          </Section>

          <Section title="Изолированные группы" count={isolated.length}>
            {isolated.map((grp, i) => (
              <Item key={i} onClick={onLocate && (() => locate({ kind: "group", ids: grp.node_ids }))}>
                <span className="sa-where">Группа {i + 1}:</span> {grp.node_names.join(", ")}
              </Item>
            ))}
          </Section>

          <Section title="Контейнеры со своей документацией" count={containerOwn.length}>
            {/* Что именно осталось (доки/спека) в строке НЕ уточняем: конкретное
                предупреждение с путём исправления ждёт на странице объекта. */}
            {containerOwn.map((c) => (
              <Item key={c.node_id} onClick={onLocate && (() => locate({ kind: "node", id: c.node_id }))}>
                {c.node_name}
              </Item>
            ))}
          </Section>

          {/* Пометка обещает факт («пишет: orders.status»), а структура его не
              подтверждает. Строка ведёт к узлу-ВЛАДЕЛЬЦУ дока: чинится текст у него,
              а не структура базы. */}
          <Section title="Обращения к неописанным данным" count={unresolvedRefs.length}>
            {unresolvedRefs.map((r) => (
              <Item
                key={`${r.doc_id}:${r.mode}:${r.ref}`}
                onClick={onLocate && (() => locate({ kind: "node", id: r.node_id }))}
              >
                <span className="sa-line">
                  <span className="sa-where">{r.node_name} · {r.doc_name}:</span>{" "}
                  <span className="sa-strong">„{r.ref}“</span> — {REF_REASON[r.reason]}
                </span>
              </Item>
            ))}
          </Section>

          {/* Событийный близнец предыдущей секции: строка так же ведёт к узлу-
              ВЛАДЕЛЬЦУ дока — чинится текст пометки у него, а не структура брокера. */}
          <Section title="Обращения к неописанным каналам" count={unresolvedChannelRefs.length}>
            {unresolvedChannelRefs.map((r) => (
              <Item
                key={`${r.doc_id}:${r.mode}:${r.ref}`}
                onClick={onLocate && (() => locate({ kind: "node", id: r.node_id }))}
              >
                <span className="sa-line">
                  <span className="sa-where">{r.node_name} · {r.doc_name}:</span>{" "}
                  <span className="sa-strong">„{r.ref}“</span> — {CHANNEL_REASON[r.reason]}
                </span>
              </Item>
            ))}
          </Section>

          {/* Третья семья пометок. Отличие от двух соседних — в тексте починки: цель
              искать негде, кроме самого объекта, поэтому и предлагается ровно одно
              место. Класс заведомо ловит и ПРОЗУ («зависит от: нагрузки») — так
              задумано (маркер с двоеточием обещает факт), и подсказка называет оба
              выхода, иначе строка читалась бы как шум. */}
          <Section title="Обращения к неописанным параметрам" count={unresolvedConfigRefs.length}>
            {unresolvedConfigRefs.map((r) => (
              <Item
                key={`${r.doc_id}:${r.ref}`}
                onClick={onLocate && (() => locate({ kind: "node", id: r.node_id }))}
              >
                <span className="sa-line">
                  <span className="sa-where">{r.node_name} · {r.doc_name}:</span>{" "}
                  <span className="sa-strong">„{r.ref}“</span> — параметра нет в конфигурации
                  объекта: опишите его или, если это обычная фраза, уберите двоеточие
                </span>
              </Item>
            ))}
          </Section>

          {/* Стрелка в брокер обязана назвать топик (решение №4): строка ведёт К СВЯЗИ —
              канал правится в её инспекторе, а не в структуре брокера. */}
          <Section title="Связи с брокером без канала" count={brokerEdges.length}>
            {brokerEdges.map((b) => (
              <Item key={b.edge_id} onClick={onLocate && (() => locate({ kind: "edge", id: b.edge_id }))}>
                <span className="sa-line">
                  <span className="sa-where">{b.source_name} → {b.target_name}:</span>{" "}
                  {/* Тексты причин разные по СМЫСЛУ починки: «не указан» — дописать
                      канал в инспекторе; «не найден» — опечатка либо канал не описан
                      в структуре брокера (и тогда чинят её). */}
                  {b.reason === "missing" ? (
                    "канал не указан"
                  ) : (
                    <>канал <span className="sa-strong">«{b.channel}»</span> не найден у брокера «{b.broker_name}»</>
                  )}
                </span>
              </Item>
            ))}
          </Section>

          <Section title="Незадокументированные сообщения" count={dangling.length}>
            {dangling.map((m) => (
              <Item
                key={m.message_id}
                onClick={onOpenProcess && (() => { setOpen(false); onOpenProcess(m.process_id); })}
              >
                <span className="sa-line">
                  <span className="sa-where">{m.process_name}:</span>{" "}
                  {m.caption ? `«${m.caption}»` : "без подписи"}
                </span>
                <span className="sa-hint">
                  {m.from_name} → {m.to_name}
                </span>
              </Item>
            ))}
          </Section>

          <Section title="Ответ на асинхронном канале" count={orphanLegs.length}>
            {orphanLegs.map((m) => (
              <Item
                key={m.message_id}
                onClick={onOpenProcess && (() => { setOpen(false); onOpenProcess(m.process_id); })}
              >
                <span className="sa-line">
                  <span className="sa-where">{m.process_name}:</span>{" "}
                  {m.caption ? `«${m.caption}»` : "без подписи"}
                </span>
                <span className="sa-hint">
                  {m.from_name} → {m.to_name}
                  {m.edge_label ? ` · канал «${m.edge_label}»` : ""}
                </span>
              </Item>
            ))}
          </Section>

          <Section title="Незадокументированные участники" count={unbound.length}>
            {unbound.map((p) => (
              <Item
                key={p.participant_id}
                onClick={onOpenProcess && (() => { setOpen(false); onOpenProcess(p.process_id); })}
              >
                <span className="sa-row">
                  <span className="sa-where">{p.process_name}:</span>
                  <span className="sa-strong">{p.name}</span>
                </span>
              </Item>
            ))}
          </Section>

          <Section title="Шаги без схемы логики" count={unlinkedMessages.length}>
            {unlinkedMessages.map((m) => (
              <Item
                key={m.message_id}
                onClick={onOpenProcess && (() => { setOpen(false); onOpenProcess(m.process_id); })}
              >
                <span className="sa-line">
                  <span className="sa-where">{m.process_name}:</span>{" "}
                  {m.caption ? `«${m.caption}»` : "без подписи"}
                </span>
                <span className="sa-hint">
                  {m.from_name} → {m.to_name}
                </span>
              </Item>
            ))}
          </Section>

          <Section title="Объекты с неописанными схемами логики" count={undescribedDocs.length}>
            {/* Одна строка на объект с числом заглушек: построчный бэклог — на странице
                объекта (блок «Не описано»), сюда его не тащим. */}
            {undescribedDocs.map((u) => (
              <Item key={u.node_id} onClick={onLocate && (() => locate({ kind: "node", id: u.node_id }))}>
                <span className="sa-row">
                  <span>{u.node_name}</span>
                  <span className="sa-muted">{u.count} {plural(u.count, ["схема", "схемы", "схем"])}</span>
                </span>
              </Item>
            ))}
          </Section>

          <Section title="Пользователи внутри контейнера" count={personsInside.length}>
            {personsInside.map((p) => (
              <Item key={p.node_id} onClick={onLocate && (() => locate({ kind: "node", id: p.node_id }))}>
                <span className="sa-row">
                  <span className="sa-strong">{p.node_name}</span>
                  <span className="sa-muted">внутри</span>
                  <span>{p.parent_name}</span>
                </span>
              </Item>
            ))}
          </Section>
        </div>
      )}
    </div>
  );
}

/* раздел: подпись с числом + строки */
function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (count === 0) return null; // пустые разделы не показываем
  return (
    <div className="sa-sec">
      <div className="sa-sec-head">
        <span>{title}</span>
        <span className="sa-sec-count">{count}</span>
      </div>
      {children}
    </div>
  );
}

/* строка-пункт: обычный текст, стрелка перехода — у пункта под курсором. Кликабельна, если есть onClick */
function Item({ children, onClick }: { children: ReactNode; onClick?: (() => void) | false | undefined }) {
  return (
    <div
      className={"sa-item" + (onClick ? " sa-item--clickable" : "")}
      onClick={onClick || undefined}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      title={onClick ? "Показать на схеме" : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
    >
      <span className="sa-text">{children}</span>
      {onClick && <span className="sa-go" aria-hidden="true">→</span>}
    </div>
  );
}

// Якорь выпадающей панели (relative). pointerEvents возвращаем: рейл холста
// (MapEditorPage.toastRail) прозрачен для мыши, а кнопка и панель — интерактивные.
// flex, а не блок: иначе строчный бокс кнопки добавил бы снизу зазор под строку.
const wrap: CSSProperties = { position: "relative", display: "flex", pointerEvents: "auto" };
