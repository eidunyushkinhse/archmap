// Поведение сайта документации: навигация-ящик на узких экранах, подсветка оглавления,
// кнопки «Копировать» у кода, поиск (MiniSearch и индекс грузятся при первом обращении).
(() => {
  "use strict";

  // ── Ящик навигации ───────────────────────────────────────────────────────────
  const menuBtn = document.querySelector("[data-menu]");
  const setMenu = (open) => {
    document.body.classList.toggle("menu-open", open);
    if (menuBtn) menuBtn.setAttribute("aria-expanded", String(open));
  };
  if (menuBtn) menuBtn.addEventListener("click", () => setMenu(!document.body.classList.contains("menu-open")));
  const backdrop = document.querySelector("[data-menu-close]");
  if (backdrop) backdrop.addEventListener("click", () => setMenu(false));

  // Текущий пункт навигации — в видимой области
  const activeItem = document.querySelector(".side-item.active, .side-group-title.active");
  if (activeItem && typeof activeItem.scrollIntoView === "function") {
    activeItem.scrollIntoView({ block: "center" });
  }

  // ── Оглавление: подсветка раздела, который на экране ─────────────────────────
  const outlineLinks = Array.from(document.querySelectorAll("[data-outline]"));
  if (outlineLinks.length) {
    const targets = outlineLinks
      .map((a) => ({ a, el: document.getElementById(a.dataset.outline) }))
      .filter((x) => x.el);
    let ticking = false;
    const update = () => {
      ticking = false;
      const line = 96;
      let current = targets[0];
      for (const t of targets) {
        if (t.el.getBoundingClientRect().top <= line) current = t;
        else break;
      }
      // Страница докручена до конца — активен последний раздел, даже если он короткий
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
        current = targets[targets.length - 1];
      }
      for (const t of targets) t.a.classList.toggle("active", t === current);
    };
    window.addEventListener("scroll", () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(update);
      }
    }, { passive: true });
    update();
  }

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
  // Кусок текста вокруг первого совпадения
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
