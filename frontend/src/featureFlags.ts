// Фиче-флаги клиента (localStorage). Пивот «Страницы объектов» gated флагом
// pages_pivot: старое поведение (TreePage-холст) остаётся доступным, пока флаг
// не выключен. Снятие флага = удаление старого кода.
const PAGES_PIVOT_KEY = "archmap_pages_pivot";

export function isPagesPivot(): boolean {
  // Дефолт: включён (пивот активен). Для отката: localStorage.setItem("archmap_pages_pivot", "0")
  const v = localStorage.getItem(PAGES_PIVOT_KEY);
  return v === null ? true : v === "1";
}

export function setPagesPivot(on: boolean): void {
  localStorage.setItem(PAGES_PIVOT_KEY, on ? "1" : "0");
}
