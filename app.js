const els = {
  form: document.querySelector("#searchForm"),
  query: document.querySelector("#query"),
  type: document.querySelector("#typeFilter"),
  genre: document.querySelector("#genreFilter"),
  site: document.querySelector("#siteFilter"),
  license: document.querySelector("#licenseFilter"),
  commercial: document.querySelector("#commercialFilter"),
  youtube: document.querySelector("#youtubeFilter"),
  creditFree: document.querySelector("#creditFreeFilter"),
  sort: document.querySelector("#sortFilter"),
  pageSize: document.querySelector("#pageSize"),
  reset: document.querySelector("#resetFilters"),
  summary: document.querySelector("#summary"),
  activeFilters: document.querySelector("#activeFilters"),
  loading: document.querySelector("#loading"),
  items: document.querySelector("#items"),
  pager: document.querySelector("#pager"),
  shell: document.querySelector(".shell"),
  detail: document.querySelector("#detail"),
  detailBody: document.querySelector("#detailBody"),
  closeDetail: document.querySelector("#closeDetail"),
};

const state = {
  page: 1,
  total: 0,
  controller: null,
  source: "api",
  staticMaterials: null,
  materialById: null,
};

const ASSET_VERSION = "1000";

const typeLabels = {
  bgm: "BGM",
  se: "効果音",
};

const yn = (value) => Number(value) === 1;
const text = (value, fallback = "-") => (value === null || value === undefined || value === "" ? fallback : value);

function buildParams() {
  const params = new URLSearchParams();
  params.set("page", String(state.page));
  params.set("page_size", els.pageSize.value);
  params.set("sort", els.sort.value);

  const q = els.query.value.trim();
  if (q) params.set("q", q);
  if (els.type.value) params.set("type", els.type.value);
  if (els.genre.value) params.set("genre", els.genre.value);
  if (els.site.value) params.set("site", els.site.value);
  if (els.license.value) params.set("license", els.license.value);
  if (els.commercial.checked) params.set("commercial", "1");
  if (els.youtube.checked) params.set("youtube", "1");
  if (els.creditFree.checked) params.set("credit_free", "1");
  return params;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDuration(seconds) {
  if (!seconds) return "";
  const min = Math.floor(seconds / 60);
  const sec = String(seconds % 60).padStart(2, "0");
  return `${min}:${sec}`;
}

function optionLabel(value) {
  return typeLabels[value] || value;
}

function fillSelect(select, rows, labeler = optionLabel) {
  const current = select.value;
  select.length = 1;
  rows.forEach((row) => {
    const option = document.createElement("option");
    option.value = row.value;
    option.textContent = `${labeler(row.value)} (${row.count})`;
    select.append(option);
  });
  select.value = [...select.options].some((option) => option.value === current) ? current : "";
}

async function loadFacets() {
  let data;
  try {
    data = await fetchJson("facets.json");
    state.source = "static";
  } catch (_error) {
    data = await fetchJson("api/facets");
    state.source = "api";
  }
  fillSelect(els.type, data.types);
  fillSelect(els.genre, data.genres, (value) => value);
  fillSelect(els.site, data.sites, (value) => value);
  fillSelect(els.license, data.licenses, (value) => value);
}

async function fetchJson(url, options) {
  const separator = url.includes("?") ? "&" : "?";
  const versionedUrl = `${url}${separator}v=${ASSET_VERSION}`;
  const res = await fetch(versionedUrl, { cache: "no-store", ...options });
  if (!res.ok) throw new Error(url);
  return res.json();
}

async function ensureStaticMaterials() {
  if (state.staticMaterials) return;
  const data = await fetchJson("materials.json");
  const items = data.items || data;
  state.staticMaterials = items.map((item) => ({
    ...item,
    _searchText: [
      item.title,
      item.short_description,
      item.description,
      item.creator_name,
      item.site_name,
      item.genre,
      item.sub_genre,
      item.mood,
      item.use_case,
      item.scene,
      item.tags,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase(),
  }));
  state.materialById = new Map(state.staticMaterials.map((item) => [item.id, item]));
}

function staticMatches(item) {
  const q = els.query.value.trim().toLowerCase();
  if (q) {
    const terms = q.split(/\s+/).filter(Boolean);
    if (!terms.every((term) => item._searchText.includes(term))) return false;
  }
  if (els.type.value && item.material_type !== els.type.value) return false;
  if (els.genre.value && item.genre !== els.genre.value) return false;
  if (els.site.value && item.site_name !== els.site.value) return false;
  if (els.license.value && item.license_type !== els.license.value) return false;
  if (els.commercial.checked && !yn(item.commercial_use)) return false;
  if (els.youtube.checked && !yn(item.youtube_use)) return false;
  if (els.creditFree.checked && yn(item.credit_required)) return false;
  return true;
}

function compareStaticItems(a, b) {
  if (els.sort.value === "updated") {
    return String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || ""), "ja") ||
      String(a.title || "").localeCompare(String(b.title || ""), "ja");
  }
  if (els.sort.value === "duration") {
    const ad = Number.isFinite(a.duration_sec) ? a.duration_sec : Number.MAX_SAFE_INTEGER;
    const bd = Number.isFinite(b.duration_sec) ? b.duration_sec : Number.MAX_SAFE_INTEGER;
    return ad - bd || String(a.title || "").localeCompare(String(b.title || ""), "ja");
  }
  return String(a.title || "").localeCompare(String(b.title || ""), "ja");
}

async function getStaticMaterials() {
  await ensureStaticMaterials();
  const pageSize = Number(els.pageSize.value);
  const filtered = state.staticMaterials.filter(staticMatches).sort(compareStaticItems);
  const start = (state.page - 1) * pageSize;
  return {
    total: filtered.length,
    page: state.page,
    page_size: pageSize,
    items: filtered.slice(start, start + pageSize),
  };
}

function filterSummary() {
  const parts = [];
  if (els.query.value.trim()) parts.push(`検索: ${els.query.value.trim()}`);
  if (els.type.value) parts.push(optionLabel(els.type.value));
  if (els.genre.value) parts.push(els.genre.value);
  if (els.site.value) parts.push(els.site.value);
  if (els.license.value) parts.push(els.license.value);
  if (els.commercial.checked) parts.push("商用可");
  if (els.youtube.checked) parts.push("YouTube可");
  if (els.creditFree.checked) parts.push("クレジット不要");
  return parts.join(" / ");
}

async function loadMaterials() {
  els.loading.hidden = false;

  try {
    let data;
    if (state.source === "static") {
      data = await getStaticMaterials();
    } else {
      if (state.controller) state.controller.abort();
      state.controller = new AbortController();
      try {
        data = await fetchJson(`api/materials?${buildParams()}`, { signal: state.controller.signal });
      } catch (error) {
        if (error.name === "AbortError") throw error;
        state.source = "static";
        data = await getStaticMaterials();
      }
    }
    state.total = data.total;
    renderMaterials(data.items);
    renderPager(data.page, data.page_size, data.total);
    const start = data.total === 0 ? 0 : (data.page - 1) * data.page_size + 1;
    const end = Math.min(data.page * data.page_size, data.total);
    els.summary.textContent = `${data.total.toLocaleString()}件中 ${start.toLocaleString()}-${end.toLocaleString()}件`;
    els.activeFilters.textContent = filterSummary();
  } catch (error) {
    if (error.name !== "AbortError") {
      els.items.innerHTML = '<div class="empty">読み込みに失敗しました</div>';
      els.summary.textContent = "エラー";
    }
  } finally {
    els.loading.hidden = true;
  }
}

function renderMaterials(items) {
  els.items.textContent = "";
  if (items.length === 0) {
    els.items.innerHTML = '<div class="empty">該当する素材がありません</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  items.forEach((item) => {
    const article = document.createElement("article");
    article.className = "item";
    article.innerHTML = `
      <div class="badges">
        <span class="badge type">${escapeHtml(optionLabel(item.material_type))}</span>
        ${item.genre ? `<span class="badge">${escapeHtml(item.genre)}</span>` : ""}
        ${item.duration_sec ? `<span class="badge">${formatDuration(item.duration_sec)}</span>` : ""}
        ${item.credit_required ? '<span class="badge warn">要クレジット</span>' : '<span class="badge">クレジット不要</span>'}
      </div>
      <h2 class="item-title">${escapeHtml(item.title)}</h2>
      <p class="item-meta">${escapeHtml(text(item.site_name))} / ${escapeHtml(text(item.creator_name))}</p>
      <p class="item-desc">${escapeHtml(text(item.short_description || item.tags, ""))}</p>
      <div class="badges">
        ${yn(item.commercial_use) ? '<span class="badge">商用可</span>' : '<span class="badge danger">商用要確認</span>'}
        ${yn(item.youtube_use) ? '<span class="badge">YouTube可</span>' : '<span class="badge danger">YouTube要確認</span>'}
        <span class="badge">${escapeHtml(text(item.license_type))}</span>
      </div>
      <div class="item-actions">
        <button class="primary" type="button" data-id="${escapeHtml(item.id)}">詳細</button>
        <a href="${escapeHtml(item.official_url || item.download_url || "#")}" target="_blank" rel="noopener">公式</a>
      </div>
    `;
    article.querySelector("button").addEventListener("click", () => showDetail(item.id));
    fragment.append(article);
  });
  els.items.append(fragment);
}

function renderPager(page, pageSize, total) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  els.pager.textContent = "";

  const prev = document.createElement("button");
  prev.type = "button";
  prev.textContent = "前へ";
  prev.disabled = page <= 1;
  prev.addEventListener("click", () => {
    state.page -= 1;
    loadMaterials();
  });

  const current = document.createElement("span");
  current.className = "page-current";
  current.textContent = `${page} / ${pages}`;

  const next = document.createElement("button");
  next.type = "button";
  next.textContent = "次へ";
  next.disabled = page >= pages;
  next.addEventListener("click", () => {
    state.page += 1;
    loadMaterials();
  });

  els.pager.append(prev, current, next);
}

async function showDetail(id) {
  els.detail.hidden = false;
  els.shell.classList.add("detail-open");
  els.detailBody.innerHTML = '<p class="detail-meta">読み込み中</p>';

  let item = null;
  if (state.source === "static") {
    await ensureStaticMaterials();
    item = state.materialById.get(id);
  } else {
    try {
      item = await fetchJson(`api/materials/${encodeURIComponent(id)}`);
    } catch (_error) {
      state.source = "static";
      await ensureStaticMaterials();
      item = state.materialById.get(id);
    }
  }

  if (!item) {
    els.detailBody.innerHTML = '<p class="detail-meta">詳細を取得できませんでした</p>';
    return;
  }
  const official = item.official_url || item.download_url;
  const preview = item.preview_url || item.download_url;
  els.detailBody.innerHTML = `
    <h2>${escapeHtml(item.title)}</h2>
    <p class="detail-meta">${escapeHtml(optionLabel(item.material_type))} / ${escapeHtml(text(item.site_name))}</p>
    <div class="badges">
      ${item.genre ? `<span class="badge">${escapeHtml(item.genre)}</span>` : ""}
      ${item.mood ? `<span class="badge">${escapeHtml(item.mood)}</span>` : ""}
      ${item.use_case ? `<span class="badge">${escapeHtml(item.use_case)}</span>` : ""}
      ${item.duration_sec ? `<span class="badge">${formatDuration(item.duration_sec)}</span>` : ""}
    </div>
    <div class="detail-section">
      <p class="detail-desc">${escapeHtml(text(item.description || item.short_description || item.tags, ""))}</p>
      ${preview ? `<audio controls preload="none" src="${escapeHtml(preview)}"></audio>` : ""}
    </div>
    <dl class="detail-grid detail-section">
      <dt>作者</dt><dd>${escapeHtml(text(item.creator_name))}</dd>
      <dt>ライセンス</dt><dd>${escapeHtml(text(item.license_type))}</dd>
      <dt>商用利用</dt><dd>${yn(item.commercial_use) ? "可" : "要確認"}</dd>
      <dt>YouTube</dt><dd>${yn(item.youtube_use) ? "可" : "要確認"}</dd>
      <dt>クレジット</dt><dd>${yn(item.credit_required) ? escapeHtml(text(item.credit_text, "必要")) : "不要"}</dd>
      <dt>形式</dt><dd>${escapeHtml(text(item.file_format))}</dd>
      <dt>タグ</dt><dd>${escapeHtml(text(item.tags))}</dd>
    </dl>
    <div class="detail-links detail-section">
      ${official ? `<a class="primary" href="${escapeHtml(official)}" target="_blank" rel="noopener">公式ページ</a>` : ""}
      ${item.license_url ? `<a href="${escapeHtml(item.license_url)}" target="_blank" rel="noopener">利用規約</a>` : ""}
    </div>
  `;
}

function resetFilters() {
  els.query.value = "";
  els.type.value = "";
  els.genre.value = "";
  els.site.value = "";
  els.license.value = "";
  els.commercial.checked = false;
  els.youtube.checked = false;
  els.creditFree.checked = false;
  els.sort.value = "title";
  state.page = 1;
  loadMaterials();
}

function debounce(fn, wait) {
  let timer = 0;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
}

function bindEvents() {
  const refresh = () => {
    state.page = 1;
    loadMaterials();
  };
  const debouncedRefresh = debounce(refresh, 250);

  els.form.addEventListener("submit", (event) => {
    event.preventDefault();
    refresh();
  });
  els.query.addEventListener("input", debouncedRefresh);
  [els.type, els.genre, els.site, els.license, els.sort, els.pageSize].forEach((el) => {
    el.addEventListener("change", refresh);
  });
  [els.commercial, els.youtube, els.creditFree].forEach((el) => {
    el.addEventListener("change", refresh);
  });
  els.reset.addEventListener("click", resetFilters);
  els.closeDetail.addEventListener("click", () => {
    els.detail.hidden = true;
    els.shell.classList.remove("detail-open");
    els.detailBody.textContent = "";
  });
}

async function init() {
  try {
    bindEvents();
    await loadFacets();
    await loadMaterials();
  } catch (error) {
    els.loading.hidden = true;
    els.summary.textContent = "読み込みに失敗しました";
    els.activeFilters.textContent =
      location.protocol === "file:"
        ? "GitHub PagesまたはローカルHTTPサーバーで開いてください"
        : "materials.json と facets.json の配置を確認してください";
    els.items.innerHTML = '<div class="empty">データファイルを読み込めませんでした</div>';
    console.error(error);
  }
}

init();
