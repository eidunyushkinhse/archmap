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

// scrollTo / scrollIntoView — jsdom не реализует.
if (!window.scrollTo) window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn();

// HTMLDialogElement.showModal/close — Modal использует нативный <dialog>.
if (typeof HTMLDialogElement !== "undefined") {
  if (!HTMLDialogElement.prototype.showModal) HTMLDialogElement.prototype.showModal = vi.fn();
  if (!HTMLDialogElement.prototype.close) HTMLDialogElement.prototype.close = vi.fn();
}
