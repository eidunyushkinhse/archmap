// Шаги обучающего тура демо-стенда (docs/tasks/demo-tour.md) — ДАННЫЕ, без логики.
// Тексты перенесены дословно из принятого прототипа docs/tasks/demo-tour-prototype.html
// (массив S). Отступления от прототипа ровно двух видов:
//   - имена созданных пользователем объектов подставляются вместо «Моя система»,
//     «Покупатель», «Веб-витрина» (плейсхолдеры {system}, {peer}, {child});
//   - где имя стояло в косвенном падеже или с ним согласовывался глагол («на
//     „Покупателе“», «с „Моей системой“», «„Моя система“ стала»), фраза перестроена
//     так, чтобы имя стояло в кавычках в именительном падеже.
// Короткий финал повторного запуска (свой проект уже есть) — текст архитектора.

/** Имена демо-пакета: по ним тур находит объекты «Ярмарки» (гость мог их удалить —
 *  тогда шаг пропускается). Проект и его система называются одинаково. */
export const YAR_PROJECT = "Маркетплейс «Ярмарка»";
export const YAR_SYSTEM = "Маркетплейс «Ярмарка»";
export const YAR_SELLER = "Продавец";
export const YAR_ORDERS = "Сервис заказов";
export const YAR_ORDERS_DB = "БД заказов";
export const YAR_BROKER = "Kafka";
export const YAR_ORDER_API = "Order API";

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
  | "tree"
  | "service-docs"
  | "db-docs"
  | "broker-docs"
  | "processes"
  | "leave-yar"
  | "new-project"
  | "create-blank"
  | "create-system"
  | "add-peer"
  | "connect"
  | "enter-system"
  | "add-child"
  | "rehang"
  | "go-up"
  | "context-edge"
  | "expand-own"
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

/** Что подсвечивается. Разбор в DOM — tourTargets.ts. */
export type Target =
  /** элемент с data-tour=key; scroll — прокрутить к нему при входе в шаг */
  | { kind: "tour"; key: string; scroll?: boolean }
  /** карточка проекта «Ярмарка» в списке */
  | { kind: "yar-card" }
  /** узел или рамка «Ярмарки» на холсте по имени объекта */
  | { kind: "yar-node"; name: string }
  /** кнопка на узле «система» своего проекта: «Войти» или лупа */
  | { kind: "system-part"; part: "node-enter" | "node-expand" }
  /** пара хэндлов, которую рендерер выберет для связи «второй объект → система» */
  | { kind: "handles" }
  /** рамка системы и конец стрелки на ней */
  | { kind: "frame-end" }
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
    id: "tree", kind: "info", n: 8, screen: { kind: "yar-node", name: YAR_ORDERS }, needs: [YAR_ORDERS],
    mode: "schema", target: { kind: "tour", key: "tree" },
    title: "Дерево системы",
    body: "Слева вся система списком. Нажмите на любой объект, чтобы открыть его страницу. Сейчас открыт «Сервис заказов».",
  },
  "service-docs": {
    id: "service-docs", kind: "info", n: 9, screen: { kind: "yar-node", name: YAR_ORDER_API },
    needs: [YAR_ORDER_API], mode: "schema", target: { kind: "tour", key: "node-logic", scroll: true },
    title: "Документация сервиса",
    body: "Схемы логики операций и воркеров, параметры конфигурации и спецификация OpenAPI.",
    action: "Нажмите «открыть», чтобы посмотреть схему логики.",
  },
  "db-docs": {
    id: "db-docs", kind: "info", n: 10, screen: { kind: "yar-node", name: YAR_ORDERS_DB },
    needs: [YAR_ORDERS_DB], mode: "schema", target: { kind: "tour", key: "node-structure", scroll: true },
    title: "Документация базы данных",
    body: "Таблицы и колонки с пояснениями. «Показать диаграмму» нарисует связи таблиц.",
  },
  "broker-docs": {
    id: "broker-docs", kind: "info", n: 11, screen: { kind: "yar-node", name: YAR_BROKER },
    needs: [YAR_BROKER], mode: "schema", target: { kind: "tour", key: "node-channels", scroll: true },
    title: "Документация брокера",
    body: "Каналы брокера: топики и очереди. В связях выше видно, кто в них пишет и кто читает.",
  },
  processes: {
    id: "processes", kind: "info", n: 12, screen: { kind: "yar-shell" }, mode: "proc",
    target: { kind: "tour", key: "mode-proc" },
    title: "Бизнес-процессы",
    body: "Сценарий шаг за шагом: какие сервисы участвуют и что передают друг другу. Каждый шаг ведёт к схеме логики нужной операции.",
  },
  "leave-yar": {
    id: "leave-yar", kind: "act", n: 13, screen: { kind: "yar-any" }, mode: "schema",
    target: { kind: "tour", key: "logo" },
    title: "Вы посмотрели «Ярмарку»",
    body: "Логотип ArchMap всегда ведёт ко всем проектам.",
    action: "Нажмите на логотип.",
  },
  "new-project": {
    id: "new-project", kind: "act", n: 14, screen: { kind: "projects" },
    target: { kind: "tour", key: "new-project" },
    title: "Начните свой проект",
    body: "Теперь ваша очередь. В песочнице можно создать один свой проект.",
    action: "Нажмите «Новый проект».",
  },
  "create-blank": {
    id: "create-blank", kind: "act", n: 15, screen: ANY, target: { kind: "create-project" },
    title: "Проще всего начать с пустого",
    body: "Импорт и ИИ-агент пригодятся, когда захотите собрать схему из кода.",
    action: "Выберите «Пустой», введите название и нажмите «Создать проект».",
  },
  "create-system": {
    id: "create-system", kind: "act", n: 16, screen: OWN_MAP, target: { kind: "tour", key: "palette:service" },
    title: "Создайте свою систему",
    body: "Начнём с верхнего слоя архитектуры: ваша система целиком и те, кто с ней работает.",
    action: "Перетащите «Сервис» на схему и назовите его именем вашей системы.",
  },
  "add-peer": {
    id: "add-peer", kind: "act", n: 17, screen: OWN_MAP, target: { kind: "tour", key: "palette" },
    title: "Добавьте ещё один объект",
    body: "Например, внешний сервис, который обменивается данными с вашей системой, или пользователя.",
    action: "Перетащите форму на схему.",
  },
  connect: {
    id: "connect", kind: "act", n: 18, screen: OWN_MAP, target: { kind: "handles" },
    title: "Проведите связь",
    body: "Стрелка идёт от того, кто вызывает, к тому, кого вызывают.",
    // Прототип: «от точки на «Покупателе» к точке на «Моей системе»».
    action: "Протяните стрелку от точки на объекте «{peer}» к точке на объекте «{system}».",
  },
  "enter-system": {
    id: "enter-system", kind: "act", n: 19, screen: OWN_MAP, target: { kind: "system-part", part: "node-enter" },
    title: "У вас получилась диаграмма контекста",
    body: "Она ещё не полная, но вы уже знаете, как её доделать. Перейдём на следующий слой архитектуры.",
    action: "Нажмите «Войти» на системе «{system}».",
  },
  "add-child": {
    id: "add-child", kind: "act", n: 20, screen: OWN_MAP, target: { kind: "tour", key: "palette:service" },
    title: "Соберите систему из сервисов",
    body: "Поместите в рамку сервис, который входит в состав вашей системы. Начните с того, с которым работает внешний объект: если наверху вы создали пользователя, добавьте приложение, которое отдаёт ему фронтенд. А если внешнюю систему, то сервис, который с ней интегрирован.",
    action: "Перетащите «Сервис» в рамку «{system}».",
  },
  rehang: {
    id: "rehang", kind: "act", n: 21, screen: OWN_MAP, target: { kind: "frame-end" },
    title: "Перевесьте связь на сервис",
    // Прототип: «„Моя система“ стала контейнером» — глагол согласован с именем.
    body: "Система «{system}» стала контейнером. Контейнер является абстракцией и не может быть связан с внешним объектом.",
    // Прототип: «отпустите на „Веб-витрине“».
    action: "Потяните конец стрелки с рамки и отпустите на объекте «{child}».",
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

/** Шаги «Ярмарки» (по прототипу 1–13): общие у полного и короткого прохода. */
const YAR_PART: readonly StepId[] = [
  "open-yar", "yar-home", "open-editor", "drag", "expand-system", "expand-service",
  "service-expanded", "tree", "service-docs", "db-docs", "broker-docs", "processes", "leave-yar",
];

/** Полный проход: «Ярмарка», затем свой проект. */
export const FULL_SEQUENCE: readonly StepId[] = [
  "welcome", ...YAR_PART,
  "new-project", "create-blank", "create-system", "add-peer", "connect", "enter-system",
  "add-child", "rehang", "go-up", "context-edge", "expand-own", "final",
];

/** Повторный запуск при уже созданном своём проекте: «Новый проект» погашена, шаги
 *  14–15 не выполнить — после «Ярмарки» короткий финал. */
export const SHORT_SEQUENCE: readonly StepId[] = ["welcome", ...YAR_PART, "final-short"];
