// Фиче-флаги клиента (localStorage). Пивот «Страницы объектов» gated флагом
// pages_pivot: старое поведение (TreePage-холст) остаётся доступным, пока флаг
// не включён. Снятие флага = удаление старого кода (Фаза 6).
const PAGES_PIVOT_KEY = "archmap_pages_pivot";

export function isPagesPivot(): boolean {
  return localStorage.getItem(PAGES_PIVOT_KEY) === "1";
}

export function setPagesPivot(on: boolean): void {
  localStorage.setItem(PAGES_PIVOT_KEY, on ? "1" : "0");
}
