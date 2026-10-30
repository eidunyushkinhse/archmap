// Последствия смены элемента архитектуры или переноса узла (Р18 эпика
// docs/plan-c4-elements.md) словами окна. Что именно переедет, считает сервер
// (GET element-preview / move-preview, ElementChangePreview); здесь только решение
// «нужно ли окно» и тексты прототипа v2 для пяти видов. Своей логики площадок нет.
import type { ElementChangePreview, PlacementRowOut } from "../../types";

function sameRows(a: PlacementRowOut[], b: PlacementRowOut[]): boolean {
  return a.length === b.length && a.every((row, i) =>
    row.node_id === b[i].node_id && row.sites.join("\n") === b[i].sites.join("\n"));
}

// Площадки действительно переезжают (иначе таблицу «было → стало» не показываем).
export function placementsMove(preview: ElementChangePreview): boolean {
  return !sameRows(preview.before, preview.after);
}

// Окно нужно, когда переезжают площадки или документация останется не на месте.
export function hasConsequences(preview: ElementChangePreview): boolean {
  return preview.kind !== "none" && (placementsMove(preview) || preview.docs_names.length > 0);
}

// «api», «api и scheduler», «api, checkout и scheduler».
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} и ${names[names.length - 1]}`;
}

export interface ConsequenceTexts {
  title: string;
  lead: string;
  // Пояснение под таблицей площадок.
  placementNote: string;
  // Секция «Документация»; null — секции нет.
  docs: string | null;
  confirm: string;
}

// Документация будущих компонентов остаётся на месте; кнопка «Собрать с компонентов» —
// на странице контейнера.
function componentDocs(names: string[], container: string): string | null {
  if (names.length === 0) return null;
  return `У ${joinNames(names)} есть своя документация. Она останется на месте: ArchMap `
    + `отметит это подсказкой, а на странице «${container}» будет кнопка, чтобы перенести её `
    + "одним нажатием.";
}

// Тексты окна. name — объект, у которого меняют элемент или который переносят.
export function consequenceTexts(preview: ElementChangePreview, name: string): ConsequenceTexts {
  const container = preview.container_name ?? "";
  switch (preview.kind) {
    case "system_to_container":
      return {
        title: `Сделать «${name}» контейнером?`,
        lead: `Объекты внутри станут частями «${name}» и перестанут считаться отдельными приложениями.`,
        placementNote: `«${name}» займёт все площадки, где сейчас стоят его части.`,
        docs: componentDocs(preview.docs_names, name),
        confirm: "Сделать контейнером",
      };
    case "container_to_system":
      return {
        title: `Сделать «${name}» системой?`,
        lead: "Объекты внутри станут отдельными приложениями, каждое со своими площадками и документацией.",
        placementNote: `Каждый получит площадки «${name}». Лишние можно убрать на холсте «Развёртывание».`,
        docs: preview.docs_names.length > 0
          ? `Документация самого «${name}» останется у него. ArchMap отметит это подсказкой, а на `
            + `странице «${name}» будет кнопка, чтобы раздать её объектам внутри.`
          : null,
        confirm: "Сделать системой",
      };
    case "join_container":
      return {
        title: `Сделать «${name}» частью «${container}»?`,
        lead: `«${name}» станет компонентом контейнера «${container}» и перестанет считаться отдельным приложением.`,
        placementNote: `«${container}» займёт и площадки «${name}».`,
        docs: componentDocs(preview.docs_names, container),
        confirm: "Перенести",
      };
    case "first_child":
      // Перенос в лист с площадками: лист станет системой (D34, правило 5).
      return {
        title: `Перенести «${name}» в «${container}»?`,
        lead: `«${container}» станет системой из вложенных объектов, и его площадки перейдут к ним.`,
        placementNote: `«${name}» получит площадки «${container}». Лишние можно убрать на холсте «Развёртывание».`,
        docs: null,
        confirm: "Перенести",
      };
    default:
      return {
        title: `Сделать «${name}» отдельным приложением?`,
        lead: `«${name}» перестанет быть частью «${container}» и получит свои площадки.`,
        placementNote: `«${name}» получит площадки «${container}». Лишние можно убрать на холсте «Развёртывание».`,
        docs: null,
        confirm: "Перенести",
      };
  }
}
