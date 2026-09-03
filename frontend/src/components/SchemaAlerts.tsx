import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type {
  SchemaAlerts as Alerts,
  UnresolvedChannelRefAlert,
  UnresolvedDataRefAlert,
} from "../types";
import { plural } from "../ui/plural";
import "./schemaAlerts.css";

/**
 * Индикатор незавершённости схемы для архитектора (редизайн «Вариант 1 · Минимал-знак»).
 *
 *  • Есть активные алерты → в правом верхнем углу схемы — компактный круглый
 *    янтарный знак «!» с бабл-счётчиком. При появлении и при росте числа замечаний
 *    знак коротко пульсирует (3 цикла), привлекая внимание без постоянного шума.
 *  • Клик раскрывает компактную панель с тремя категориями. Каждый пункт
 *    кликабелен и ведёт к объекту/связи на схеме (через onLocate — поведение
 *    перехода реализует вызывающая сторона).
 *  • Когда устранено последнее замечание (total: >0 → 0) — на ~2.5 с всплывает
 *    зелёный тост «Схема завершена» и уезжает вправо за край. Постоянно на схеме
 *    он НЕ живёт.
 *
 * Категории (формулировки на «объект», не «узел»):
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
 *     кликабельны только там, где переход возможен — в оболочке страниц;
 *     редактор-карта живёт отдельным роутом и обработчик не передаёт;
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
}

const TOAST_HOLD = 2500; // сколько тост висит, мс
const TOAST_EXIT = 260; // длительность уезда вправо, мс (синхронно с CSS)

/* Восклицательный знак в треугольнике */
function WarningIcon({ size = 20, sw = 2.2 }: { size?: number; sw?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0z" />
      <line x1="12" y1="9.2" x2="12" y2="13.2" /><line x1="12" y1="16.6" x2="12.01" y2="16.6" />
    </svg>
  );
}
const CheckIcon = ({ size = 15, sw = 2.2 }: { size?: number; sw?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 6.5" /></svg>
);

/* Иконки категорий (16px, line) */
const sIco = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const IcoUnlink = (s = 13) => <svg width={s} height={s} viewBox="0 0 16 16" {...sIco}><circle cx="8" cy="8" r="4.2" /><path d="M3.2 12.8 12.8 3.2" /></svg>;
const IcoArrowBox = (s = 13) => <svg width={s} height={s} viewBox="0 0 16 16" {...sIco}><rect x="9" y="3.4" width="3.8" height="9.2" rx="1" /><path d="M2 8h5.2" /><path d="M5.2 5.6 7.6 8l-2.4 2.4" /></svg>;
// Связь в собственный компонент: стрелка из рамки контейнера в коробочку внутри неё.
const IcoSelfNest = (s = 13) => <svg width={s} height={s} viewBox="0 0 16 16" {...sIco}><rect x="1.6" y="2.4" width="12.8" height="11.2" rx="1.6" /><rect x="8.6" y="7.2" width="4" height="4.2" rx="1" /><path d="M4.4 5.2v4.1h4.2" /><path d="M7.2 7.9 8.8 9.3 7.2 10.7" /></svg>;
const IcoScatter = (s = 13) => <svg width={s} height={s} viewBox="0 0 16 16" {...sIco}><circle cx="4.2" cy="5" r="1.9" /><circle cx="11.6" cy="4.4" r="1.9" /><circle cx="8" cy="11.4" r="1.9" /></svg>;
// Контейнер со своими схемами: бокс-контейнер с точкой («своя» схема внутри)
const IcoBoxDocs = (s = 13) => <svg width={s} height={s} viewBox="0 0 16 16" {...sIco}><rect x="2.4" y="3" width="11.2" height="10" rx="1.6" /><path d="M2.4 6.2h11.2" /><circle cx="8" cy="9.8" r="1.2" fill="currentColor" stroke="none" /></svg>;
// Пользователь внутри системы: фигурка человека внутри рамки-границы.
const IcoPersonBox = (s = 13) => <svg width={s} height={s} viewBox="0 0 16 16" {...sIco}><rect x="2.2" y="2.6" width="11.6" height="10.8" rx="1.8" /><circle cx="8" cy="6.6" r="1.5" /><path d="M5.6 11.2c0-1.4 1.1-2.3 2.4-2.3s2.4.9 2.4 2.3" /></svg>;
// Повисшее сообщение: стрелка с разрывом посередине.
const IcoBrokenLifeline = (s = 13) => <svg width={s} height={s} viewBox="0 0 16 16" {...sIco}><rect x="4.5" y="1.8" width="7" height="3.4" rx="1" /><path d="M8 5.6v2.2" /><path d="M8 10.4v3.8" /></svg>;
const IcoBrokenArrow = (s = 13) => <svg width={s} height={s} viewBox="0 0 16 16" {...sIco}><path d="M1.8 8h3.4" /><path d="M10.8 8h3.4" /><path d="M11.4 5.6 13.8 8l-2.4 2.4" /><path d="M7.4 5.4 8.6 10.6" /></svg>;
// Ответное плечо, которого больше нет: дуга возврата, перечёркнутая косой.
const IcoNoReturn = (s = 13) => <svg width={s} height={s} viewBox="0 0 16 16" {...sIco}><path d="M13.2 3.8H6.2a3 3 0 0 0 0 6h3.4" /><path d="M7.6 7.6 5.6 9.8l2 2.2" /><path d="M2.6 2.6l10.8 10.8" /></svg>;
// Шаг без схемы логики: лист документа, перечёркнутый косой — документации нет.
// Заглушка: документ пунктиром — тела нет, но и не поломка (спокойный контур, как у метки на странице объекта)
const IcoStubDoc = (s = 13) => <svg width={s} height={s} viewBox="0 0 16 16" {...sIco}><path d="M4 1.8h5.2L12 4.6v9.6H4Z" strokeDasharray="2 1.6" /><path d="M9.2 1.8v2.8H12" /></svg>;
const IcoNoDoc = (s = 13) => <svg width={s} height={s} viewBox="0 0 16 16" {...sIco}><path d="M4 1.8h5.2L12 4.6v9.6H4Z" /><path d="M9.2 1.8v2.8H12" /><path d="M2.6 2.6l10.8 10.8" /></svg>;
// Обращение к неописанным данным: цилиндр базы со знаком вопроса — цель пометки
// не нашлась.
const IcoUnknownData = (s = 13) => <svg width={s} height={s} viewBox="0 0 16 16" {...sIco}><ellipse cx="6.6" cy="3.6" rx="4.2" ry="1.7" /><path d="M2.4 3.6v6c0 .9 1.9 1.7 4.2 1.7" /><path d="M10.8 3.6v2.4" /><path d="M10.2 9.6a1.6 1.6 0 1 1 2.2 1.5v.9" /><path d="M12.4 13.7h.01" /></svg>;
// Обращение к неописанному каналу: конверт события со знаком вопроса — цель
// пометки не нашлась в структуре брокеров.
const IcoUnknownChannel = (s = 13) => <svg width={s} height={s} viewBox="0 0 16 16" {...sIco}><rect x="1.8" y="3.4" width="9.4" height="7.2" rx="1.2" /><path d="M1.8 4.4 6.5 7.6l4.7-3.2" /><path d="M11.6 11.4a1.5 1.5 0 1 1 2 1.4v.7" /><path d="M13.6 15.1h.01" /></svg>;
// Обращение к неописанной ручке: ползунок-настройка со знаком вопроса — пометка
// «зависит от:» не нашла параметра у самого объекта.
const IcoUnknownParam = (s = 13) => <svg width={s} height={s} viewBox="0 0 16 16" {...sIco}><path d="M1.8 4.6h7.4M1.8 9.4h4" /><circle cx="6.4" cy="4.6" r="1.5" /><circle cx="3.4" cy="9.4" r="1.5" /><path d="M10.4 10.2a1.6 1.6 0 1 1 2.2 1.5v.8" /><path d="M12.6 14.4h.01" /></svg>;
// Связь с брокером без канала: стрелка с безымянным конвертом-меткой на конце.
const IcoEdgeChannel = (s = 13) => <svg width={s} height={s} viewBox="0 0 16 16" {...sIco}><path d="M1.6 8h5.2" /><path d="M4.6 5.8 6.8 8l-2.2 2.2" /><rect x="8.4" y="4.6" width="6.4" height="5" rx="1" /><path d="M8.4 5.2 11.6 7.4l3.2-2.2" /><path d="M11.6 12.4h.01" /></svg>;
const IcoLocate = (s = 14) => <svg width={s} height={s} viewBox="0 0 16 16" {...sIco}><circle cx="8" cy="8" r="3" /><path d="M8 1v2.2M8 12.8V15M1 8h2.2M12.8 8H15" /></svg>;

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

export default function SchemaAlerts({ alerts, onLocate, onOpenProcess }: Props) {
  const [open, setOpen] = useState(false);
  const [pulseKey, setPulseKey] = useState(0);
  const [toast, setToast] = useState(false);
  const [leaving, setLeaving] = useState(false);
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
  // связь, 3 → 2 и т.д. В ОБЩИЙ счётчик «Незавершённость схемы» идёт groups − 1 (число
  // проблем), а в счётчик самой секции — фактическое число групп (см. ниже): 2 группы
  // показываются как «2», но в сумму незавершённости дают «1».
  const isolatedProblems = Math.max(0, isolated.length - 1);
  const total =
    disconnected.length + intermediate.length + descendant.length + isolatedProblems +
    containerOwn.length + personsInside.length + dangling.length + unbound.length +
    orphanLegs.length + unresolvedRefs.length + unresolvedChannelRefs.length +
    unresolvedConfigRefs.length + brokerEdges.length + unlinkedMessages.length +
    undescribedDocs.length;

  // Отслеживаем переходы total: рост → пульс; обнуление (>0 → 0) → тост
  const prevTotal = useRef(total);
  useEffect(() => {
    const prev = prevTotal.current;
    prevTotal.current = total;
    if (prev > 0 && total === 0) {
      setOpen(false);
      setLeaving(false);
      setToast(true);
      const t1 = setTimeout(() => setLeaving(true), TOAST_HOLD);
      const t2 = setTimeout(() => setToast(false), TOAST_HOLD + TOAST_EXIT);
      return () => { clearTimeout(t1); clearTimeout(t2); };
    }
    if (total > prev) setPulseKey((k) => k + 1); // новое замечание — пульс
  }, [total]);

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

  // Ничего активного и тост отыграл — не рендерим
  if (total === 0 && !toast) return null;

  // Состояние «схема завершена» — транзиентный тост
  if (total === 0) {
    return (
      <div style={wrap}>
        <div className={"sa-toast" + (leaving ? " sa-toast--leave" : "")} style={toastBox} role="status">
          <span style={toastCheck}><CheckIcon /></span>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: "#047857" }}>Схема завершена</span>
        </div>
      </div>
    );
  }

  return (
    <div ref={ref} style={wrap}>
      <button
        style={badge}
        onClick={() => setOpen((o) => !o)}
        title="Незавершённость схемы — открыть детали"
        aria-label={`Незавершённость схемы: ${total}`}
        aria-expanded={open}
      >
        <span key={pulseKey} className="sa-ring" aria-hidden="true" />
        <WarningIcon />
        <span style={count}>{total}</span>
      </button>

      {open && (
        <div className="sa-panel" style={menu}>
          <div style={menuHead}>
            <span style={{ color: "#d97706", display: "flex" }}><WarningIcon size={16} /></span>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>Незавершённость схемы</span>
            <span style={totalChip}>{total}</span>
          </div>

          <Section icon={IcoUnlink(13)} title="Объекты без связей" count={disconnected.length}>
            {disconnected.map((d) => (
              <Item key={d.node_id} onClick={onLocate && (() => locate({ kind: "node", id: d.node_id }))}>
                {d.node_name}
              </Item>
            ))}
          </Section>

          <Section icon={IcoArrowBox(13)} title="Связи в контейнер" count={intermediate.length}>
            {intermediate.map((e) => (
              <Item key={e.edge_id} onClick={onLocate && (() => locate({ kind: "edge", id: e.edge_id }))}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                  <span style={e.source_is_intermediate ? badEnd : undefined}>{e.source_name}</span>
                  <span style={{ color: "#9ca3af" }}>→</span>
                  <span style={e.target_is_intermediate ? badEnd : undefined}>{e.target_name}</span>
                </span>
              </Item>
            ))}
          </Section>

          {/* Связь узла с его же потомком: совет тут ПРОТИВОПОЛОЖЕН соседней секции —
              не «уточните конец», а «удалите или перевесьте». Строка ведёт К СВЯЗИ. */}
          <Section icon={IcoSelfNest(13)} title="Связи в собственный компонент" count={descendant.length}>
            {descendant.map((e) => {
              const part = e.source_is_part ? e.source_name : e.target_name;
              const whole = e.source_is_part ? e.target_name : e.source_name;
              return (
                <Item key={e.edge_id} onClick={onLocate && (() => locate({ kind: "edge", id: e.edge_id }))}>
                  <span style={{ display: "block", lineHeight: 1.35 }}>
                    <span style={{ color: "#6b7280", fontWeight: 600 }}>{e.source_name} → {e.target_name}:</span>{" "}
                    <span style={badEnd}>«{part}»</span> — часть «{whole}»
                  </span>
                  <span style={{ display: "block", fontSize: 11.5, color: "#9ca3af", lineHeight: 1.35 }}>
                    иерархия уже выражает вложенность — удалите связь или перевесьте её
                  </span>
                </Item>
              );
            })}
          </Section>

          <Section icon={IcoScatter(13)} title="Изолированные группы" count={isolated.length}>
            {isolated.map((grp, i) => (
              <Item key={i} onClick={onLocate && (() => locate({ kind: "group", ids: grp.node_ids }))}>
                <span style={{ color: "#6b7280", fontWeight: 600 }}>Группа {i + 1}:</span> {grp.node_names.join(", ")}
              </Item>
            ))}
          </Section>

          <Section icon={IcoBoxDocs(13)} title="Контейнеры со своей документацией" count={containerOwn.length}>
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
          <Section icon={IcoUnknownData(13)} title="Обращения к неописанным данным" count={unresolvedRefs.length}>
            {unresolvedRefs.map((r) => (
              <Item
                key={`${r.doc_id}:${r.mode}:${r.ref}`}
                onClick={onLocate && (() => locate({ kind: "node", id: r.node_id }))}
              >
                <span style={{ display: "block", lineHeight: 1.35 }}>
                  <span style={{ color: "#6b7280", fontWeight: 600 }}>{r.node_name} · {r.doc_name}:</span>{" "}
                  <span style={badEnd}>„{r.ref}“</span> — {REF_REASON[r.reason]}
                </span>
              </Item>
            ))}
          </Section>

          {/* Событийный близнец предыдущей секции: строка так же ведёт к узлу-
              ВЛАДЕЛЬЦУ дока — чинится текст пометки у него, а не структура брокера. */}
          <Section icon={IcoUnknownChannel(13)} title="Обращения к неописанным каналам" count={unresolvedChannelRefs.length}>
            {unresolvedChannelRefs.map((r) => (
              <Item
                key={`${r.doc_id}:${r.mode}:${r.ref}`}
                onClick={onLocate && (() => locate({ kind: "node", id: r.node_id }))}
              >
                <span style={{ display: "block", lineHeight: 1.35 }}>
                  <span style={{ color: "#6b7280", fontWeight: 600 }}>{r.node_name} · {r.doc_name}:</span>{" "}
                  <span style={badEnd}>„{r.ref}“</span> — {CHANNEL_REASON[r.reason]}
                </span>
              </Item>
            ))}
          </Section>

          {/* Третья семья пометок. Отличие от двух соседних — в тексте починки: цель
              искать негде, кроме самого объекта, поэтому и предлагается ровно одно
              место. Класс заведомо ловит и ПРОЗУ («зависит от: нагрузки») — так
              задумано (маркер с двоеточием обещает факт), и подсказка называет оба
              выхода, иначе строка читалась бы как шум. */}
          <Section icon={IcoUnknownParam(13)} title="Обращения к неописанным параметрам" count={unresolvedConfigRefs.length}>
            {unresolvedConfigRefs.map((r) => (
              <Item
                key={`${r.doc_id}:${r.ref}`}
                onClick={onLocate && (() => locate({ kind: "node", id: r.node_id }))}
              >
                <span style={{ display: "block", lineHeight: 1.35 }}>
                  <span style={{ color: "#6b7280", fontWeight: 600 }}>{r.node_name} · {r.doc_name}:</span>{" "}
                  <span style={badEnd}>„{r.ref}“</span> — параметра нет в конфигурации
                  объекта: опишите его или, если это обычная фраза, уберите двоеточие
                </span>
              </Item>
            ))}
          </Section>

          {/* Стрелка в брокер обязана назвать топик (решение №4): строка ведёт К СВЯЗИ —
              канал правится в её инспекторе, а не в структуре брокера. */}
          <Section icon={IcoEdgeChannel(13)} title="Связи с брокером без канала" count={brokerEdges.length}>
            {brokerEdges.map((b) => (
              <Item key={b.edge_id} onClick={onLocate && (() => locate({ kind: "edge", id: b.edge_id }))}>
                <span style={{ display: "block", lineHeight: 1.35 }}>
                  <span style={{ color: "#6b7280", fontWeight: 600 }}>{b.source_name} → {b.target_name}:</span>{" "}
                  {/* Тексты причин разные по СМЫСЛУ починки: «не указан» — дописать
                      канал в инспекторе; «не найден» — опечатка либо канал не описан
                      в структуре брокера (и тогда чинят её). */}
                  {b.reason === "missing" ? (
                    "канал не указан"
                  ) : (
                    <>канал <span style={badEnd}>«{b.channel}»</span> не найден у брокера «{b.broker_name}»</>
                  )}
                </span>
              </Item>
            ))}
          </Section>

          <Section icon={IcoBrokenArrow(13)} title="Незадокументированные сообщения" count={dangling.length}>
            {dangling.map((m) => (
              <Item
                key={m.message_id}
                onClick={onOpenProcess && (() => { setOpen(false); onOpenProcess(m.process_id); })}
              >
                <span style={{ display: "block", lineHeight: 1.35 }}>
                  <span style={{ color: "#6b7280", fontWeight: 600 }}>{m.process_name}:</span>{" "}
                  {m.caption ? `«${m.caption}»` : "без подписи"}
                </span>
                <span style={{ display: "block", fontSize: 11.5, color: "#9ca3af", lineHeight: 1.35 }}>
                  {m.from_name} → {m.to_name}
                </span>
              </Item>
            ))}
          </Section>

          <Section icon={IcoNoReturn(13)} title="Ответ на асинхронном канале" count={orphanLegs.length}>
            {orphanLegs.map((m) => (
              <Item
                key={m.message_id}
                onClick={onOpenProcess && (() => { setOpen(false); onOpenProcess(m.process_id); })}
              >
                <span style={{ display: "block", lineHeight: 1.35 }}>
                  <span style={{ color: "#6b7280", fontWeight: 600 }}>{m.process_name}:</span>{" "}
                  {m.caption ? `«${m.caption}»` : "без подписи"}
                </span>
                <span style={{ display: "block", fontSize: 11.5, color: "#9ca3af", lineHeight: 1.35 }}>
                  {m.from_name} → {m.to_name}
                  {m.edge_label ? ` · канал «${m.edge_label}»` : ""}
                </span>
              </Item>
            ))}
          </Section>

          <Section icon={IcoBrokenLifeline(13)} title="Незадокументированные участники" count={unbound.length}>
            {unbound.map((p) => (
              <Item
                key={p.participant_id}
                onClick={onOpenProcess && (() => { setOpen(false); onOpenProcess(p.process_id); })}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                  <span style={{ color: "#6b7280", fontWeight: 600 }}>{p.process_name}:</span>
                  <span style={badEnd}>{p.name}</span>
                </span>
              </Item>
            ))}
          </Section>

          <Section icon={IcoNoDoc(13)} title="Шаги без схемы логики" count={unlinkedMessages.length}>
            {unlinkedMessages.map((m) => (
              <Item
                key={m.message_id}
                onClick={onOpenProcess && (() => { setOpen(false); onOpenProcess(m.process_id); })}
              >
                <span style={{ display: "block", lineHeight: 1.35 }}>
                  <span style={{ color: "#6b7280", fontWeight: 600 }}>{m.process_name}:</span>{" "}
                  {m.caption ? `«${m.caption}»` : "без подписи"}
                </span>
                <span style={{ display: "block", fontSize: 11.5, color: "#9ca3af", lineHeight: 1.35 }}>
                  {m.from_name} → {m.to_name}
                </span>
              </Item>
            ))}
          </Section>

          <Section icon={IcoStubDoc(13)} title="Объекты с неописанными схемами логики" count={undescribedDocs.length}>
            {/* Одна строка на объект с числом заглушек: построчный бэклог — на странице
                объекта (блок «Не описано»), сюда его не тащим. */}
            {undescribedDocs.map((u) => (
              <Item key={u.node_id} onClick={onLocate && (() => locate({ kind: "node", id: u.node_id }))}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                  <span>{u.node_name}</span>
                  <span style={{ color: "#9ca3af" }}>{u.count} {plural(u.count, ["схема", "схемы", "схем"])}</span>
                </span>
              </Item>
            ))}
          </Section>

          <Section icon={IcoPersonBox(13)} title="Пользователи внутри контейнера" count={personsInside.length}>
            {personsInside.map((p) => (
              <Item key={p.node_id} onClick={onLocate && (() => locate({ kind: "node", id: p.node_id }))}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                  <span style={badEnd}>{p.node_name}</span>
                  <span style={{ color: "#9ca3af" }}>внутри</span>
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

/* секция категории: шапка (иконка-чип + заголовок + счётчик) + строки */
function Section({ icon, title, count, children }: { icon: ReactNode; title: string; count: number; children: ReactNode }) {
  if (count === 0) return null; // пустые категории не показываем
  return (
    <div style={section}>
      <div style={sectionHead}>
        <span style={iconChip}>{icon}</span>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "#374151" }}>{title}</span>
        <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, color: "#9ca3af" }}>{count}</span>
      </div>
      {children}
    </div>
  );
}

/* строка-пункт: hover-подсветка + «прицел» перехода. Кликабельна, если есть onClick */
function Item({ children, onClick }: { children: ReactNode; onClick?: (() => void) | false | undefined }) {
  return (
    <div
      className={"sa-item" + (onClick ? " sa-item--clickable" : "")}
      onClick={onClick || undefined}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
    >
      <span style={{ flex: 1, minWidth: 0, lineHeight: 1.35 }}>{children}</span>
      {onClick && <span className="sa-loc" title="Показать на схеме">{IcoLocate(14)}</span>}
    </div>
  );
}

/* --------------------------------- стили --------------------------------- */
// Позиционирует рейл тостов холста (MapEditorPage.toastRail); relative — якорь для
// выпадающей панели. pointerEvents возвращаем: рейл прозрачен для мыши, а знак
// и панель — интерактивные.
const wrap: CSSProperties = { position: "relative", pointerEvents: "auto" };
const badge: CSSProperties = {
  position: "relative", width: 42, height: 42, borderRadius: 21, background: "#f59e0b",
  border: "none", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
  cursor: "pointer", boxShadow: "0 2px 8px rgba(0,0,0,.18)",
};
const count: CSSProperties = {
  position: "absolute", top: -5, right: -5, minWidth: 19, height: 19, padding: "0 5px",
  borderRadius: 10, background: "#fff", color: "#b45309", border: "1.5px solid #f59e0b",
  fontSize: 11, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box",
};
// Панель поверх содержимого страницы: у соседей z-index задан явно (меню ⋯ и
// выпадающие списки страницы объекта — 20/15/14), а холст React Flow расставляет
// свои значения элементам схемы. Без z-index панель уходила под них (находка
// ручной проверки 2026-08-08). 50 — выше содержимого, но ниже тостов (60);
// модалки живут в top-layer <dialog> и вне этой шкалы.
const menu: CSSProperties = {
  position: "absolute", zIndex: 50,
  top: "calc(100% + 8px)", right: 0, width: 296, maxHeight: 460, overflowY: "auto",
  background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, boxShadow: "0 12px 32px rgba(17,24,39,.16)", padding: "0 0 6px",
};
const menuHead: CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, padding: "12px 14px 11px", borderBottom: "1px solid #f3f4f6",
};
const totalChip: CSSProperties = {
  marginLeft: "auto", fontSize: 12, fontWeight: 800, color: "#b45309", background: "#fef3c7", borderRadius: 999, padding: "2px 8px",
};
const section: CSSProperties = { padding: "8px 6px 6px", borderTop: "1px solid #f3f4f6" };
const sectionHead: CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "0 8px 4px" };
const iconChip: CSSProperties = {
  width: 22, height: 22, borderRadius: 7, background: "#fef3c7", color: "#d97706",
  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
};
// подсветка конца-нарушителя (промежуточного объекта) в строке связи
const badEnd: CSSProperties = { color: "#b45309", fontWeight: 600 };
const toastBox: CSSProperties = {
  display: "flex", alignItems: "center", gap: 9, background: "#fff", border: "1px solid #a7f3d0",
  borderRadius: 12, padding: "9px 14px 9px 11px", boxShadow: "0 8px 24px rgba(5,150,105,.16)",
};
const toastCheck: CSSProperties = {
  width: 24, height: 24, borderRadius: 12, background: "#10b981", color: "#fff",
  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
};
