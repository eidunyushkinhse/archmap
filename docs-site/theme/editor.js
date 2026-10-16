// Редактор автора: дерево страниц и фрагментов, поля фронтматтера, текст с живым
// предпросмотром (рендер тем же движком через /api/preview), вставки, картинки, создание и
// удаление страниц. Всё через /api/* — проверка автора на сервере.
(() => {
  "use strict";
  const $ = (sel, root = document) => root.querySelector(sel);
  const api = async (method, path, body, raw) => {
    const headers = { "X-Requested-With": "docs" };
    if (body !== undefined && !raw) headers["Content-Type"] = "application/json";
    const res = await fetch(path, { method, headers, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search);
      throw new Error("нужен вход");
    }
    if (!res.ok) throw new Error(data.error || ("ошибка " + res.status));
    return data;
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  // Относительный путь от файла к файлу (для включений и ссылок)
  const relPath = (from, to) => {
    const a = from.split("/").slice(0, -1);
    const b = to.split("/");
    while (a.length && b.length > 1 && a[0] === b[0]) { a.shift(); b.shift(); }
    return "../".repeat(a.length) + b.join("/");
  };

  const treeEl = $("[data-tree]");
  const form = $("[data-form]");
  const empty = $("[data-empty]");
  const source = $("[data-source]");
  const preview = $("[data-preview]");
  const status = $("[data-status]");
  const problems = $("[data-problems]");
  const usage = $("[data-usage]");
  const openLink = $("[data-open]");
  const fileLabel = $("[data-file-label]");
  const shortWrap = $("[data-short-wrap]");
  const insertFragment = $("[data-insert-fragment]");
  const insertLink = $("[data-insert-link]");
  const insertBlock = $("[data-insert-block]");
  const panes = $("[data-panes]");

  let tree = null;
  let fragments = [];
  let current = null; // { file, isFragment, extra, … }
  let dirty = false;

  const setDirty = (v) => {
    dirty = v;
    status.textContent = v ? "Есть несохранённые изменения" : status.textContent;
    status.className = "ed-status" + (v ? " dirty" : "");
  };
  window.addEventListener("beforeunload", (ev) => {
    if (dirty) { ev.preventDefault(); ev.returnValue = ""; }
  });

  // ── Дерево ───────────────────────────────────────────────────────────────────
  const GLYPH = {
    container: '<span class="nt-glyph"><svg width="14" height="12" viewBox="0 0 14 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3.5" width="12" height="7.5" rx="2"/><path d="M3.5 3.5 V2 a1 1 0 0 1 1-1 h5 a1 1 0 0 1 1 1 v1.5"/></svg></span>',
    leaf: '<span class="nt-glyph"><svg width="14" height="12" viewBox="0 0 14 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1.5" y="1.5" width="11" height="9" rx="2"/></svg></span>',
    home: '<span class="nt-glyph"><svg width="14" height="12" viewBox="0 0 14 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 6.2 7 1.5l5.5 4.7M3 5v5.5h8V5"/></svg></span>',
    fragment: '<span class="nt-glyph"><svg width="14" height="12" viewBox="0 0 14 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M2 2.5h10M2 6h10M2 9.5h6"/></svg></span>',
  };
  const row = (node, glyph, container) => (
    '<div class="nt-node nt-node--open" data-file="' + esc(node.file) + '">'
    + '<div class="nt-row' + (current && current.file === node.file ? " nt-row--current" : "") + '">'
    + (node.children && node.children.length ? '<span class="nt-chevspacer"></span>' : '<span class="nt-chevspacer"></span>')
    + '<span class="nt-link" data-open-file="' + esc(node.file) + '">' + glyph + '<span class="nt-name' + (container ? " nt-name--container" : "") + '">' + esc(node.title) + "</span></span></div>"
    + (node.children && node.children.length ? '<div class="nt-children">' + node.children.map((c) => row(c, c.children.length || c.kind === "section" || c.kind === "guide" ? GLYPH.container : GLYPH.leaf, c.kind !== "page")).join("") + "</div>" : "")
    + "</div>"
  );
  const renderTree = () => {
    if (!tree) return;
    let html = tree.map((n) => row(n, n.kind === "home" ? GLYPH.home : n.kind === "page" ? GLYPH.leaf : GLYPH.container, n.kind !== "page" && n.kind !== "home")).join("");
    html += '<div class="ed-group">Фрагменты</div>';
    html += fragments.map((f) => row({ file: f.file, title: f.file.replace(/^_shared\//, "").replace(/\.md$/, ""), children: [] }, GLYPH.fragment, false)).join("")
      || '<div class="ed-empty" style="padding:4px 14px;font-size:13px">нет</div>';
    treeEl.innerHTML = html;
  };
  treeEl.addEventListener("click", (ev) => {
    const link = ev.target.closest("[data-open-file]");
    if (!link) return;
    if (dirty && !confirm("Есть несохранённые изменения. Перейти без сохранения?")) return;
    open(link.dataset.openFile);
  });

  const loadTree = async () => {
    const data = await api("GET", "/api/tree");
    tree = data.tree;
    fragments = data.fragments;
    renderTree();
    // Список фрагментов и страниц для вставок
    insertFragment.innerHTML = '<option value="">Вставить фрагмент…</option>' + fragments.map((f) => '<option value="' + esc(f.file) + '">' + esc(f.file) + "</option>").join("");
    const pages = [];
    const walk = (nodes) => { for (const n of nodes) { pages.push(n); walk(n.children || []); } };
    walk(tree);
    insertLink.innerHTML = '<option value="">Ссылка на страницу…</option>' + pages.map((p) => '<option value="' + esc(p.file) + '" data-title="' + esc(p.title) + '">' + esc(p.title) + "</option>").join("");
    const parents = $("[data-new-parent]");
    parents.innerHTML = '<option value="">Корень (новое руководство или отдельная страница)</option>'
      + pages.filter((p) => p.kind === "guide" || p.kind === "section").map((p) => '<option value="' + esc(p.file.replace(/index\.md$/, "")) + '">' + esc(p.title) + "</option>").join("");
    showProblems(data.errors, data.warnings);
  };

  // ── Открытие и предпросмотр ──────────────────────────────────────────────────
  const showProblems = (errors, warnings, own) => {
    const list = [];
    for (const e of errors || []) list.push("<li>" + esc(e) + "</li>");
    for (const w of warnings || []) list.push('<li class="warn">' + esc(w) + "</li>");
    if (!list.length) { problems.hidden = true; return; }
    problems.innerHTML = (own ? "На этой странице:" : "Проблемы в документации:") + "<ul>" + list.join("") + "</ul>";
    problems.hidden = false;
  };

  let previewTimer = null;
  let previewSeq = 0;
  const renderPreview = () => {
    if (!current) return;
    const my = ++previewSeq;
    api("POST", "/api/preview", { file: current.file, title: form.title.value, body: source.value })
      .then((r) => {
        if (my !== previewSeq) return;
        preview.innerHTML = (form.title.value ? "<h1>" + esc(form.title.value) + "</h1>" : "")
          + (form.description.value ? '<p class="lead">' + esc(form.description.value) + "</p>" : "") + r.html;
        showProblems(r.errors, [], true);
      })
      .catch((e) => { preview.innerHTML = '<p class="login-error">' + esc(e.message) + "</p>"; });
  };
  const schedulePreview = () => {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 350);
  };

  const open = async (file) => {
    const data = await api("GET", "/api/page?file=" + encodeURIComponent(file));
    current = data;
    form.title.value = data.title;
    form.description.value = data.description;
    form.order.value = data.order === null ? "" : data.order;
    form.short.value = data.short;
    shortWrap.hidden = !/^[^/]+\/index\.md$/.test(file);
    source.value = data.body;
    fileLabel.textContent = file;
    openLink.hidden = !data.url;
    if (data.url) openLink.href = data.url;
    $("[data-delete]").disabled = file === "index.md";
    form.title.required = !data.isFragment;
    form.title.placeholder = data.isFragment ? "Фрагмент (названия нет — заголовки в тексте)" : "Название страницы";
    if (data.isFragment) {
      usage.hidden = false;
      usage.innerHTML = data.usedBy.length
        ? "Включён в: " + data.usedBy.map((p) => '<a href="#" data-open-file="' + esc(p) + '">' + esc(p) + "</a>").join("")
        : "Фрагмент пока никуда не включён.";
    } else {
      usage.hidden = true;
    }
    empty.hidden = true;
    form.hidden = false;
    setDirty(false);
    status.textContent = "";
    history.replaceState(null, "", "/edit/?file=" + encodeURIComponent(file));
    renderTree();
    renderPreview();
  };
  usage.addEventListener("click", (ev) => {
    const a = ev.target.closest("[data-open-file]");
    if (!a) return;
    ev.preventDefault();
    if (dirty && !confirm("Есть несохранённые изменения. Перейти без сохранения?")) return;
    open(a.dataset.openFile);
  });

  for (const el of [form.title, form.description, form.order, form.short]) {
    el.addEventListener("input", () => { setDirty(true); schedulePreview(); });
  }
  source.addEventListener("input", () => { setDirty(true); schedulePreview(); });
  source.addEventListener("keydown", (ev) => {
    if (ev.key === "Tab") {
      ev.preventDefault();
      insertAtCursor("  ");
    }
  });

  // ── Вставки ──────────────────────────────────────────────────────────────────
  const insertAtCursor = (text, block) => {
    const start = source.selectionStart;
    const end = source.selectionEnd;
    const before = source.value.slice(0, start);
    const after = source.value.slice(end);
    let chunk = text;
    if (block) {
      if (before && !before.endsWith("\n\n")) chunk = (before.endsWith("\n") ? "\n" : "\n\n") + chunk;
      if (after && !after.startsWith("\n")) chunk += "\n";
    }
    source.value = before + chunk + after;
    source.selectionStart = source.selectionEnd = start + chunk.length;
    source.focus();
    setDirty(true);
    schedulePreview();
  };
  insertFragment.addEventListener("change", () => {
    if (!insertFragment.value || !current) return;
    insertAtCursor("<!--@include: " + relPath(current.file, insertFragment.value) + "-->\n", true);
    insertFragment.value = "";
  });
  insertLink.addEventListener("change", () => {
    if (!insertLink.value || !current) return;
    const opt = insertLink.selectedOptions[0];
    insertAtCursor("[" + opt.dataset.title + "](" + relPath(current.file, insertLink.value) + ")");
    insertLink.value = "";
  });
  insertBlock.addEventListener("change", () => {
    const kind = insertBlock.value;
    if (!kind) return;
    insertAtCursor("::: " + kind + (kind === "details" ? " Заголовок" : "") + "\nТекст блока.\n:::\n", true);
    insertBlock.value = "";
  });
  $("[data-upload]").addEventListener("change", async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    try {
      const r = await api("POST", "/api/upload?name=" + encodeURIComponent(file.name), file, true);
      insertAtCursor(r.markdown + "\n", true);
    } catch (e) {
      alert("Не удалось загрузить: " + e.message);
    }
    ev.target.value = "";
  });

  for (const btn of document.querySelectorAll("[data-view]")) {
    btn.addEventListener("click", () => {
      panes.dataset.mode = btn.dataset.view;
      for (const b of document.querySelectorAll("[data-view]")) b.setAttribute("aria-pressed", String(b === btn));
      try { localStorage.setItem("docs.editor.view", btn.dataset.view); } catch { /* не важно */ }
    });
  }
  try {
    const saved = localStorage.getItem("docs.editor.view");
    if (saved) { const b = $('[data-view="' + saved + '"]'); if (b) b.click(); }
  } catch { /* не важно */ }

  // ── Сохранение, создание, удаление ───────────────────────────────────────────
  const save = async () => {
    if (!current) return;
    const btn = $("[data-save]");
    btn.disabled = true;
    status.textContent = "Сохраняю…";
    try {
      const r = await api("PUT", "/api/page", {
        file: current.file,
        title: form.title.value,
        description: form.description.value,
        order: form.order.value === "" ? null : Number(form.order.value),
        short: form.short.value,
        body: source.value,
      });
      setDirty(false);
      status.textContent = "Сохранено " + new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
      status.className = "ed-status saved";
      showProblems(r.errors, r.warnings);
      await loadTree();
    } catch (e) {
      status.textContent = "Не сохранилось: " + e.message;
      status.className = "ed-status dirty";
    } finally {
      btn.disabled = false;
    }
  };
  form.addEventListener("submit", (ev) => { ev.preventDefault(); save(); });
  document.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") { ev.preventDefault(); save(); }
  });

  $("[data-delete]").addEventListener("click", async () => {
    if (!current) return;
    if (!confirm("Удалить «" + (current.title || current.file) + "»? Ссылки на неё с других страниц станут битыми.")) return;
    try {
      const r = await api("DELETE", "/api/page?file=" + encodeURIComponent(current.file));
      current = null;
      dirty = false;
      form.hidden = true;
      empty.hidden = false;
      history.replaceState(null, "", "/edit/");
      await loadTree();
      showProblems(r.errors, r.warnings);
    } catch (e) {
      alert("Не удалилось: " + e.message);
    }
  });

  // Создание: диалог с папкой, названием и адресом
  const dialog = $("[data-new-dialog]");
  const newForm = $("[data-new-form]");
  const newError = $("[data-new-error]");
  let newKind = "page";
  const TRANSLIT = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };
  const slugify = (t) => [...t.toLowerCase()].map((c) => (c in TRANSLIT ? TRANSLIT[c] : c)).join("").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  let slugTouched = false;
  newForm.title.addEventListener("input", () => { if (!slugTouched) newForm.slug.value = slugify(newForm.title.value); });
  newForm.slug.addEventListener("input", () => { slugTouched = true; });
  for (const btn of document.querySelectorAll("[data-new]")) {
    btn.addEventListener("click", () => {
      newKind = btn.dataset.new;
      $("[data-new-title]").textContent = newKind === "fragment" ? "Новый фрагмент" : "Новая страница";
      newForm.parent.parentElement.hidden = newKind === "fragment";
      $("[data-new-kind-wrap]").hidden = newKind === "fragment";
      newForm.title.value = "";
      newForm.slug.value = "";
      newForm.section.checked = false;
      slugTouched = false;
      newError.hidden = true;
      if (current && !current.isFragment && newKind === "page") {
        const dir = current.file.replace(/[^/]+$/, "");
        const opt = [...newForm.parent.options].find((o) => o.value === dir);
        newForm.parent.value = opt ? dir : "";
      }
      dialog.showModal();
    });
  }
  $("[data-new-cancel]").addEventListener("click", () => dialog.close());
  newForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      const r = await api("POST", "/api/page", {
        kind: newKind === "fragment" ? "fragment" : newForm.section.checked ? "section" : "page",
        parent: newForm.parent.value,
        slug: newForm.slug.value,
        title: newForm.title.value,
      });
      dialog.close();
      await loadTree();
      await open(r.file);
      showProblems(r.errors, r.warnings);
    } catch (e) {
      newError.textContent = e.message;
      newError.hidden = false;
    }
  });

  // ── Старт ────────────────────────────────────────────────────────────────────
  (async () => {
    await loadTree();
    const file = new URLSearchParams(location.search).get("file");
    if (file) {
      try { await open(file); } catch (e) { status.textContent = e.message; }
    }
  })().catch((e) => { empty.innerHTML = '<p class="login-error">' + esc(e.message) + "</p>"; });
})();
