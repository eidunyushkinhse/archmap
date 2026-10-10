// Шаги обучающего тура демо-стенда (docs/tasks/demo-tour.md) — ДАННЫЕ, без логики.
// Тексты перенесены дословно из принятого прототипа docs/tasks/demo-tour-prototype.html
// (массив S). Отступления от прототипа ровно двух видов:
//   - имена созданных пользователем объектов подставляются вместо «Моя система»,
//     «Покупатель», «Веб-витрина» (плейсхолдеры {system}, {peer}, {child});
//   - где имя стояло в косвенном падеже или с ним согласовывался глагол («на
//     „Покупателе“», «с „Моей системой“», «„Моя система“ стала»), фраза перестроена
//     так, чтобы имя стояло в кавычках в именительном падеже.
// Короткий финал повторного запуска (свой проект уже есть) — текст архитектора.
// Доработка по приёмке (docs/tasks/demo-tour-2.md): шаги дерева (8а/8б), «диаграмма
// контекста» перед входом в систему (19а/19б), шаг «Вот куда ведёт связь на самом
// деле» после лупы, новые тексты шагов 22 и финала — тексты пользователя дословно.
// По испытаниям на людях (2026-10-10): три шага документации (сервис, БД, брокер)
// слиты в один ознакомительный «Не только схема» — текст пользователя, длинные тире
// заменены точкой и опущены.

/** Имена демо-пакета: по ним тур находит объекты «Ярмарки» (гость мог их удалить —
 *  тогда шаг пропускается). Проект и его система называются одинаково. */
export const YAR_PROJECT = "Маркетплейс «Ярмарка»";
export const YAR_SYSTEM = "Маркетплейс «Ярмарка»";
export const YAR_SELLER = "Продавец";
export const YAR_ORDERS = "Сервис заказов";
export const YAR_ORDER_API = "Order API";
export const YAR_ORCH = "Оркестратор заказа";

/** Имена из прототипа: запас на случай, если созданный объект тур не застал. */
export const FALLBACK_NAMES = { system: "Моя система", peer: "Покупатель", child: "Веб-витрина" } as const;

export type StepId =
  | "welcome"
  | "open-yar"
  | "yar-home"
  | "open-editor"
  | "drag"
  | "expand-system"
  | "expand-service"
  | "service-expanded"
  /** дерево: раскрыть «Сервис заказов» шевроном (8а) */
  | "tree"
  /** дерево: открыть страницу «Оркестратора заказа» (8б) */
  | "tree-open"
  /** вся документация под схемой на странице объекта — одним взглядом, без разбора */
  | "docs"
  | "processes"
  | "leave-yar"
  | "new-project"
  | "create-blank"
  | "create-system"
  | "add-peer"
  | "connect"
  /** вся диаграмма контекста: система, второй объект и связь (19а) */
  | "context-diagram"
  | "enter-system"
  | "add-child"
  | "rehang"
  | "go-up"
  | "context-edge"
  | "expand-own"
  /** после лупы: связь и сервис внутри раскрытой системы */
  | "inside"
  | "final"
  | "final-short";

/** Экран, на котором живёт шаг: там ищется цель, туда тур ведёт при входе в шаг. */
export type Screen =
  | { kind: "any" }
  | { kind: "projects" }
  /** главная «Ярмарки» */
  | { kind: "yar-home" }
  /** оболочка «Ярмарки»: главная или страница объекта */
  | { kind: "yar-shell" }
  /** любой экран «Ярмарки», включая редактор (логотип есть везде) */
  | { kind: "yar-any" }
  | { kind: "yar-map" }
  /** страница объекта «Ярмарки» с этим именем */
  | { kind: "yar-node"; name: string }
  /** редактор своего проекта */
  | { kind: "own-map" };

/** Часть составной цели: элемент с data-tour, холст редактора или узел «система». */
export type TargetPart =
  | { kind: "tour"; key: string }
  | { kind: "canvas" }
  | { kind: "system" };

/** Что подсвечивается. Разбор в DOM — tourTargets.ts. */
export type Target =
  /** элемент с data-tour=key; scroll — прокрутить к нему при входе в шаг */
  | { kind: "tour"; key: string; scroll?: boolean }
  /** два выреза: main — то, с чем работать (карточка ставится к нему, пульс), zone —
   *  куда бросать или на что смотреть (без пульса; карточка по возможности не на ней) */
  | { kind: "pair"; main: TargetPart; zone: TargetPart }
  /** строка «Ярмарки» в дереве слева по имени объекта: шеврон или вся строка */
  | { kind: "yar-tree"; name: string; part: "chevron" | "row" }
  /** карточка проекта «Ярмарка» в списке */
  | { kind: "yar-card" }
  /** узел или рамка «Ярмарки» на холсте по имени объекта */
  | { kind: "yar-node"; name: string }
  /** кнопка на узле «система» своего проекта: «Войти» или лупа */
  | { kind: "system-part"; part: "node-enter" | "node-expand" }
  /** пара хэндлов, которую рендерер выберет для связи «второй объект → система» */
  | { kind: "handles" }
  /** конец стрелки на рамке системы и одна точка на дочернем объекте — та, куда
   *  роутер провёл бы связь после перевеса */
  | { kind: "frame-end" }
  /** вся диаграмма контекста: система, второй объект и связь между ними */
  | { kind: "context-diagram" }
  /** связь и сервис внутри раскрытой системы */
  | { kind: "inside" }
  /** связь между системой и вторым объектом на слое контекста */
  | { kind: "context-edge" }
  /** окно «Новый проект»: левая колонка и кнопка «Создать проект» */
  | { kind: "create-project" };

export interface TourStep {
  id: StepId;
  /** start — приветствие, end — финал, info — с кнопкой «Далее», act — ждёт действия */
  kind: "start" | "info" | "act" | "end";
  /** номер в «Шаг N из M»; у приветствия и финалов его нет */
  n?: number;
  title: string;
  /** пустой — только заголовок и строка действия */
  body: string;
  /** синяя строка действия */
  action?: string;
  screen: Screen;
  target?: Target;
  /** объекты «Ярмарки» по именам: нет хоть одного — шаг пропускается */
  needs?: readonly string[];
  /** режим оболочки проекта («Объекты»/«Процессы»), выставляемый на входе в шаг */
  mode?: "schema" | "proc";
}

const ANY: Screen = { kind: "any" };
const OWN_MAP: Screen = { kind: "own-map" };
const YAR_MAP: Screen = { kind: "yar-map" };

export const STEPS: Readonly<Record<StepId, TourStep>> = {
  welcome: {
    id: "welcome", kind: "start", screen: ANY,
    title: "Добро пожаловать в ArchMap",
    body: "Перед вами песочница с демо-проектом «Ярмарка». Это выдуманный маркетплейс, полностью описанный в ArchMap. На его примере за пару минут покажем, как устроена документация.",
  },
  "open-yar": {
    id: "open-yar", kind: "act", n: 1, screen: { kind: "projects" }, target: { kind: "yar-card" },
    title: "Откройте «Ярмарку»",
    body: "Здесь все ваши проекты. Пока он один.",
    action: "Нажмите на карточку проекта.",
  },
  "yar-home": {
    id: "yar-home", kind: "info", n: 2, screen: { kind: "yar-home" }, mode: "schema",
    target: { kind: "tour", key: "schema-block" },
    title: "Главная страница проекта",
    body: "Описание, счётчики и схема системы: «Ярмарка» в центре, вокруг покупатели, продавцы и внешние сервисы.",
  },
  "open-editor": {
    id: "open-editor", kind: "act", n: 3, screen: { kind: "yar-home" }, mode: "schema",
    target: { kind: "tour", key: "schema-edit" },
    title: "Откройте редактор",
    body: "В редакторе схему можно двигать и раскрывать.",
    action: "Нажмите «Редактировать».",
  },
  drag: {
    id: "drag", kind: "act", n: 4, screen: YAR_MAP, needs: [YAR_SELLER],
    target: { kind: "yar-node", name: YAR_SELLER },
    title: "Объекты можно двигать",
    body: "Расставьте схему так, как вам удобно: связи перестроятся сами.",
    action: "Перетащите «Продавца» мышью.",
  },
  "expand-system": {
    id: "expand-system", kind: "act", n: 5, screen: YAR_MAP, needs: [YAR_SYSTEM],
    target: { kind: "yar-node", name: YAR_SYSTEM },
    title: "Объекты раскрываются",
    body: "Значок со счётчиком внизу значит, что внутри есть содержимое. У «Ярмарки» это 11 объектов.",
    action: "Нажмите лупу в правом верхнем углу «Ярмарки».",
  },
  "expand-service": {
    id: "expand-service", kind: "act", n: 6, screen: YAR_MAP, needs: [YAR_ORDERS],
    target: { kind: "yar-node", name: YAR_ORDERS },
    title: "Внутри системы её сервисы",
    body: "Раскрывать можно на любой глубине.",
    action: "Раскройте «Сервис заказов» той же лупой.",
  },
  "service-expanded": {
    id: "service-expanded", kind: "info", n: 7, screen: YAR_MAP, needs: [YAR_ORDERS],
    target: { kind: "yar-node", name: YAR_ORDERS },
    title: "Сервис раскрыт прямо на схеме",
    body: "Видны его компоненты и их связи, а со схемы уходить не нужно. Свернуть можно крестиком у названия рамки.",
  },
  tree: {
    id: "tree", kind: "act", n: 8, screen: { kind: "yar-node", name: YAR_ORDERS }, needs: [YAR_ORDERS],
    mode: "schema", target: { kind: "yar-tree", name: YAR_ORDERS, part: "chevron" },
    title: "Дерево системы",
    body: "Слева вся система списком. Шеврон раскрывает объект, а название открывает его страницу.",
    action: "Раскройте «Сервис заказов» шевроном.",
  },
  "tree-open": {
    id: "tree-open", kind: "act", n: 9, screen: { kind: "yar-node", name: YAR_ORDERS },
    needs: [YAR_ORDERS, YAR_ORCH], mode: "schema", target: { kind: "yar-tree", name: YAR_ORCH, part: "row" },
    title: "Откройте страницу объекта",
    body: "Здесь вся документация объекта.",
    action: "Нажмите «Оркестратор заказа».",
  },
  docs: {
    id: "docs", kind: "info", n: 10, screen: { kind: "yar-node", name: YAR_ORCH },
    needs: [YAR_ORCH], mode: "schema", target: { kind: "tour", key: "node-docs", scroll: true },
    title: "Не только схема",
    body: "Под схемой архитектуры лежит остальная документация: бизнес-логика, параметры конфигурации, спецификация API. Словом, самое необходимое. У баз данных похожим образом описана их структура, а у брокеров их каналы. Пока не будем на ней останавливаться, с ней вы сможете разобраться позже.",
  },
  processes: {
    id: "processes", kind: "info", n: 11, screen: { kind: "yar-shell" }, mode: "proc",
    target: { kind: "pair", main: { kind: "tour", key: "mode-proc" }, zone: { kind: "tour", key: "process-diagram" } },
    title: "Бизнес-процессы",
    body: "Сценарий шаг за шагом: какие сервисы участвуют и что передают друг другу. Каждый шаг ведёт к схеме логики нужной операции.",
  },
  "leave-yar": {
    id: "leave-yar", kind: "act", n: 12, screen: { kind: "yar-any" }, mode: "schema",
    target: { kind: "tour", key: "logo" },
    title: "Вы посмотрели «Ярмарку»",
    body: "Логотип ArchMap всегда ведёт ко всем проектам.",
    action: "Нажмите на логотип.",
  },
  "new-project": {
    id: "new-project", kind: "act", n: 13, screen: { kind: "projects" },
    target: { kind: "tour", key: "new-project" },
    title: "Начните свой проект",
    body: "Теперь ваша очередь. В песочнице можно создать один свой проект.",
    action: "Нажмите «Новый проект».",
  },
  "create-blank": {
    id: "create-blank", kind: "act", n: 14, screen: ANY, target: { kind: "create-project" },
    title: "Проще всего начать с пустого",
    body: "Импорт и ИИ-агент пригодятся, когда захотите собрать схему из кода.",
    action: "Выберите «Пустой», введите название и нажмите «Создать проект».",
  },
  "create-system": {
    id: "create-system", kind: "act", n: 15, screen: OWN_MAP,
    target: { kind: "pair", main: { kind: "tour", key: "palette:service" }, zone: { kind: "canvas" } },
    title: "Создайте свою систему",
    body: "Начнём с верхнего слоя архитектуры: ваша система целиком и те, кто с ней работает.",
    action: "Перетащите «Сервис» на схему и назовите его именем вашей системы.",
  },
  "add-peer": {
    id: "add-peer", kind: "act", n: 16, screen: OWN_MAP, target: { kind: "tour", key: "palette" },
    title: "Добавьте ещё один объект",
    body: "Например, внешний сервис, который обменивается данными с вашей системой, или пользователя.",
    action: "Перетащите форму на схему.",
  },
  connect: {
    id: "connect", kind: "act", n: 17, screen: OWN_MAP, target: { kind: "handles" },
    title: "Проведите связь",
    body: "Стрелка идёт от того, кто вызывает, к тому, кого вызывают.",
    // Прототип: «от точки на «Покупателе» к точке на «Моей системе»».
    action: "Протяните стрелку от точки на объекте «{peer}» к точке на объекте «{system}».",
  },
  "context-diagram": {
    id: "context-diagram", kind: "info", n: 18, screen: OWN_MAP, target: { kind: "context-diagram" },
    title: "У вас получилась диаграмма контекста",
    body: "Она ещё не полная, но вы уже знаете, как её доделать.",
  },
  "enter-system": {
    id: "enter-system", kind: "act", n: 19, screen: OWN_MAP, target: { kind: "system-part", part: "node-enter" },
    title: "Перейдём на следующий слой архитектуры",
    body: "",
    action: "Нажмите «Войти» на системе «{system}».",
  },
  "add-child": {
    id: "add-child", kind: "act", n: 20, screen: OWN_MAP,
    target: { kind: "pair", main: { kind: "tour", key: "palette:service" }, zone: { kind: "system" } },
    title: "Соберите систему из сервисов",
    body: "Поместите в рамку сервис, который входит в состав вашей системы. Начните с того, с которым работает внешний объект: если наверху вы создали пользователя, добавьте приложение, которое отдаёт ему фронтенд. А если внешнюю систему, то сервис, который с ней интегрирован.",
    action: "Перетащите «Сервис» в рамку «{system}».",
  },
  rehang: {
    id: "rehang", kind: "act", n: 21, screen: OWN_MAP, target: { kind: "frame-end" },
    title: "Перевесьте связь на сервис",
    // Прототип: «„Моя система“ стала контейнером» — глагол согласован с именем.
    body: "Система «{system}» стала контейнером. Контейнер является абстракцией и не может быть связан с внешним объектом.",
    action: "Потяните конец стрелки с рамки к точке на объекте «{child}».",
  },
  "go-up": {
    id: "go-up", kind: "act", n: 22, screen: OWN_MAP, target: { kind: "tour", key: "crumb-root" },
    title: "Вернитесь на верхний слой",
    body: "Связь теперь ведёт прямо к сервису «{child}». Посмотрим, как это выглядит на диаграмме контекста.",
    action: "Нажмите «Проект» в шапке.",
  },
  "context-edge": {
    id: "context-edge", kind: "info", n: 23, screen: OWN_MAP, target: { kind: "context-edge" },
    title: "Наверху связь по-прежнему ведёт в систему",
    // Прототип: «„Покупатель“ работает с „Моей системой“ целиком».
    body: "Для слоя контекста это правда: «{peer}» работает с системой «{system}» целиком.",
  },
  "expand-own": {
    id: "expand-own", kind: "act", n: 24, screen: OWN_MAP, target: { kind: "system-part", part: "node-expand" },
    title: "Загляните внутрь",
    body: "Лупа раскрывает систему прямо на схеме, и видно, куда связь ведёт на самом деле.",
    action: "Нажмите лупу.",
  },
  inside: {
    id: "inside", kind: "info", n: 25, screen: OWN_MAP, target: { kind: "inside" },
    title: "Вот куда ведёт связь на самом деле",
    body: "Внутри системы «{system}» связь приходит в сервис «{child}». Диаграмма контекста показывает систему целиком, а лупа показывает, что внутри.",
  },
  final: {
    id: "final", kind: "end", screen: ANY,
    title: "Теперь вы знаете, с чего начать",
    body: "Мы показали самое важное, но это только верхушка айсберга. Остальные возможности ArchMap откроются на практике. Пройти обучение заново можно кнопкой «Обучение» в шапке.",
  },
  "final-short": {
    id: "final-short", kind: "end", screen: ANY,
    title: "Готово",
    body: "Свой проект у вас уже есть. Продолжайте в нём.",
  },
};

/** Шаги «Ярмарки» (1–12): общие у полного и короткого прохода. */
const YAR_PART: readonly StepId[] = [
  "open-yar", "yar-home", "open-editor", "drag", "expand-system", "expand-service",
  "service-expanded", "tree", "tree-open", "docs", "processes", "leave-yar",
];

/** Полный проход: «Ярмарка», затем свой проект. */
export const FULL_SEQUENCE: readonly StepId[] = [
  "welcome", ...YAR_PART,
  "new-project", "create-blank", "create-system", "add-peer", "connect", "context-diagram", "enter-system",
  "add-child", "rehang", "go-up", "context-edge", "expand-own", "inside", "final",
];

/** Повторный запуск при уже созданном своём проекте: «Новый проект» погашена, шаги
 *  13–14 не выполнить — после «Ярмарки» короткий финал. */
export const SHORT_SEQUENCE: readonly StepId[] = ["welcome", ...YAR_PART, "final-short"];
