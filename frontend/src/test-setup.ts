// Setup vitest: jest-dom-матчеры (toBeInTheDocument и пр.) + полифилы browser
// API, которых нет в jsdom (matchMedia, ResizeObserver, scrollTo, HTMLDialogElement).
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Автоочистка DOM после каждого теста (RTL под vitest не делает её сама).
afterEach(() => cleanup());

// window.matchMedia — используется некоторыми UI-примитивами.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }) as unknown as MediaQueryList;
}

// ResizeObserver — EmbeddedSchemaBlock замеряет ширину контейнера.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// IntersectionObserver — SequenceDiagram следит им за «липкостью» шапок участников.
if (!globalThis.IntersectionObserver) {
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
    root = null;
    rootMargin = "";
    thresholds = [];
  } as unknown as typeof IntersectionObserver;
}

// Pointer capture — жесты канваса и sequence-диаграммы держат указатель за собой.
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
}

// scrollTo / scrollIntoView — jsdom не реализует.
if (!window.scrollTo) window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn();

// HTMLDialogElement.showModal/close — Modal использует нативный <dialog>. jsdom их не
// реализует, а его UA-стили прячут закрытый диалог (dialog:not([open]) — display: none),
// и role-запросы RTL не видят содержимого: открытие эмулируем атрибутом open — тогда
// окно тестируется настоящим Modal (клавиши, крестик), без прозрачной подмены.
if (typeof HTMLDialogElement !== "undefined") {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); };
  }
}
