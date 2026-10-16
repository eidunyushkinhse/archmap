// Поведение сайта документации: дерево страниц (раскрытие веток, память раскрытий), ящик
// дерева на узких экранах, кнопки «Копировать» у кода, поиск (MiniSearch и индекс грузятся
// при первом обращении), авторский режим — кнопки правки у вошедшего автора.
(() => {
  "use strict";

  // ── Дерево страниц ──────────────────────────────────────────────────────────
  const OPEN_KEY = "docs.tree.open";
  const readOpen = () => {
    try {
      return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || "[]"));
    } catch {
      return new Set();
    }
  };
  const writeOpen = (set) => {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...set]));
    } catch {
      /* хранилище недоступно — раскрытия живут до перезагрузки */
    }
  };
  const tree = document.querySelector(".tree");
  if (tree) {
    const open = readOpen();
    const setOpen = (node, isOpen) => {
      node.classList.toggle("nt-node--open", isOpen);
      const kids = node.querySelector(":scope > .nt-children");
      if (kids) kids.hidden = !isOpen;
      const btn = node.querySelector(":scope > .nt-row [data-toggle]");
      if (btn) {
        btn.setAttribute("aria-expanded", String(isOpen));
        btn.setAttribute("aria-label", isOpen ? "Свернуть ветку" : "Развернуть ветку");
      }
    };
    // Ветки, раскрытые в разметке (путь к текущей странице), запоминаются; остальные —
    // как оставил посетитель в прошлый раз
    for (const node of tree.querySelectorAll(".nt-node")) {
      const file = node.dataset.file;
      if (!file || !node.querySelector(":scope > .nt-children")) continue;
      if (node.classList.contains("nt-node--open")) open.add(file);
      else if (open.has(file)) setOpen(node, true);
    }
    writeOpen(open);
    tree.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-toggle]");
      if (!btn) return;
      ev.preventDefault();
      const node = btn.closest(".nt-node");
      const isOpen = !node.classList.contains("nt-node--open");
      setOpen(node, isOpen);
      if (isOpen) open.add(node.dataset.file);
      else open.delete(node.dataset.file);
      writeOpen(open);
    });
    const current = tree.querySelector(".nt-row--current");
    if (current && typeof current.scrollIntoView === "function") current.scrollIntoView({ block: "center" });
  }

  // ── Ящик дерева на узких экранах ────────────────────────────────────────────
  const menuBtn = document.querySelector("[data-menu]");
  const setMenu = (isOpen) => {
    document.body.classList.toggle("menu-open", isOpen);
    if (menuBtn) menuBtn.setAttribute("aria-expanded", String(isOpen));
  };
  if (menuBtn) menuBtn.addEventListener("click", () => setMenu(!document.body.classList.contains("menu-open")));
  const backdrop = document.querySelector("[data-menu-close]");
  if (backdrop) backdrop.addEventListener("click", () => setMenu(false));

  // ── Копирование кода ─────────────────────────────────────────────────────────
  for (const pre of document.querySelectorAll(".article pre")) {
    const code = pre.querySelector("code");
    if (!code || !navigator.clipboard) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-btn";
    btn.textContent = "Копировать";
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(code.textContent.replace(/\n$/, ""));
        btn.textContent = "Скопировано";
        btn.classList.add("done");
        setTimeout(() => {
          btn.textContent = "Копировать";
          btn.classList.remove("done");
        }, 1600);
      } catch {
        btn.textContent = "Не удалось";
      }
    });
    pre.appendChild(btn);
  }

  // ── Авторский режим ──────────────────────────────────────────────────────────
  // Маркер docs_author ставит сервер при входе; сам вход — по адресу /login, ссылок на него нет.
  const isAuthor = /(^|;\s*)docs_author=1(;|$)/.test(document.cookie);
  const slot = document.querySelector("[data-author-slot]");
  if (isAuthor && slot && !document.body.classList.contains("editor-page")) {
    const file = document.body.dataset.file;
    if (file) {
      const edit = document.createElement("a");
      edit.className = "author-btn";
      edit.href = "/edit/?file=" + encodeURIComponent(file);
      edit.textContent = "Редактировать";
      slot.appendChild(edit);
    }
    const menu = document.createElement("div");
    menu.className = "author-menu";
    menu.innerHTML =
      '<button type="button" class="author-menu-btn" aria-haspopup="true" aria-expanded="false">Автор ▾</button>'
      + '<div class="author-menu-pop" hidden>'
      + '<a class="author-menu-item" href="/edit/">Редактор</a>'
      + '<button type="button" class="author-menu-item" data-logout>Выйти</button>'
      + "</div>";
    slot.appendChild(menu);
    const btn = menu.querySelector(".author-menu-btn");
    const pop = menu.querySelector(".author-menu-pop");
    btn.addEventListener("click", () => {
      pop.hidden = !pop.hidden;
      btn.setAttribute("aria-expanded", String(!pop.hidden));
    });
    document.addEventListener("click", (ev) => {
      if (!menu.contains(ev.target)) pop.hidden = true;
    });
    menu.querySelector("[data-logout]").addEventListener("click", async () => {
      await fetch("/logout", { method: "POST", headers: { "X-Requested-With": "docs" } });
      location.reload();
    });
  }

  // ── Поиск ────────────────────────────────────────────────────────────────────
  const box = document.querySelector("[data-search]");
  if (!box) return;
  const input = box.querySelector("input");
  const pop = box.querySelector(".search-pop");
  const searchUrl = document.body.dataset.searchUrl || "/assets/search.json";
  const MAX = 8;
  // Грубый стеммер для русского: длинные слова урезаются до 7 букв и ищутся по префиксу —
  // «навигация», «навигации», «навигацию» сходятся в «навигац»
  const processTerm = (t) => {
    const s = t.toLowerCase().replace(/ё/g, "е");
    return s.length > 7 ? s.slice(0, 7) : s;
  };
  let engine = null;
  let loading = null;

  const loadScript = (src) => new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = ok;
    s.onerror = () => fail(new Error("не загрузился " + src));
    document.head.appendChild(s);
  });

  const ensure = () => {
    if (engine) return Promise.resolve(engine);
    if (!loading) {
      loading = (async () => {
        if (!window.MiniSearch) await loadScript("/assets/minisearch.js");
        const docs = await (await fetch(searchUrl)).json();
        engine = new window.MiniSearch({
          fields: ["title", "heading", "text"],
          storeFields: ["url", "title", "heading", "guide", "text"],
          processTerm,
          searchOptions: { prefix: true, fuzzy: 0.15, boost: { title: 3, heading: 2 }, combineWith: "AND", processTerm },
        });
        engine.addAll(docs);
        return engine;
      })();
    }
    return loading;
  };

  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const mark = (text, words) => {
    if (!words.length) return esc(text);
    const re = new RegExp("(" + words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "giu");
    return esc(text).replace(re, "<mark>$1</mark>");
  };
  const snippet = (text, words) => {
    const low = text.toLowerCase();
    let at = -1;
    for (const w of words) {
      const i = low.indexOf(w);
      if (i >= 0 && (at < 0 || i < at)) at = i;
    }
    const start = Math.max(0, at - 60);
    const piece = text.slice(start, start + 180);
    return (start > 0 ? "…" : "") + mark(piece, words) + (start + 180 < text.length ? "…" : "");
  };

  let selected = -1;
  let items = [];
  const render = (hits, words) => {
    items = hits.slice(0, MAX);
    selected = items.length ? 0 : -1;
    if (!items.length) {
      pop.innerHTML = '<div class="sr-empty">Ничего не нашлось</div>';
    } else {
      pop.innerHTML = items.map((d, i) => (
        '<a class="sr" role="option" href="' + esc(d.url) + '" aria-selected="' + (i === selected) + '">'
        + '<span class="sr-head"><span class="sr-title">' + mark(d.title, words) + "</span>"
        + (d.heading ? '<span class="sr-sec">' + mark(d.heading, words) + "</span>" : "")
        + (d.guide ? '<span class="sr-guide">' + esc(d.guide) + "</span>" : "")
        + '</span><span class="sr-snip">' + snippet(d.text, words) + "</span></a>"
      )).join("");
    }
    pop.hidden = false;
  };
  const close = () => {
    pop.hidden = true;
    selected = -1;
  };
  const select = (i) => {
    selected = (i + items.length) % items.length;
    pop.querySelectorAll(".sr").forEach((a, k) => a.setAttribute("aria-selected", String(k === selected)));
    const el = pop.querySelectorAll(".sr")[selected];
    if (el) el.scrollIntoView({ block: "nearest" });
  };

  let seq = 0;
  const run = async () => {
    const q = input.value.trim();
    if (q.length < 2) {
      close();
      return;
    }
    const my = ++seq;
    const e = await ensure();
    if (my !== seq) return;
    const words = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    render(e.search(q), words);
  };

  input.addEventListener("input", run);
  input.addEventListener("focus", () => {
    ensure().catch(() => {});
    if (input.value.trim().length >= 2 && items.length) pop.hidden = false;
  });
  input.addEventListener("keydown", (ev) => {
    if (pop.hidden && (ev.key === "ArrowDown" || ev.key === "Enter")) {
      run();
      return;
    }
    if (ev.key === "ArrowDown") { ev.preventDefault(); select(selected + 1); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); select(selected - 1); }
    else if (ev.key === "Enter" && selected >= 0 && items[selected]) { ev.preventDefault(); location.href = items[selected].url; }
    else if (ev.key === "Escape") { close(); input.blur(); }
  });
  document.addEventListener("click", (ev) => {
    if (!box.contains(ev.target)) close();
  });
  document.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "k") {
      ev.preventDefault();
      input.focus();
      input.select();
    } else if (ev.key === "Escape" && document.body.classList.contains("menu-open")) {
      setMenu(false);
    }
  });
})();
