(function () {
  'use strict';

  const STORAGE_KEY = 'site-work-hours:v1';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // ---------- 状態と保存 ----------
  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? Core.normalizeState(JSON.parse(raw)) : Core.emptyState();
    } catch (e) {
      console.error(e);
      return Core.emptyState();
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.error(e);
      toast('保存に失敗しました。ブラウザの設定を確認してください。');
    }
  }

  // ---------- ユーティリティ ----------
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmt(n, digits = 2) {
    return Number(n).toLocaleString('ja-JP', { maximumFractionDigits: digits });
  }

  function toISODate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function formatDate(iso) {
    const d = new Date(iso + 'T00:00:00');
    const w = '日月火水木金土'[d.getDay()];
    return `${d.getMonth() + 1}/${d.getDate()}(${w})`;
  }

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
  }

  function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsText(file, 'utf-8');
    });
  }

  function perDay() {
    return Number(state.settings.hoursPerManDay) || 8;
  }

  function fillSelect(select, list, { placeholder, keep = true } = {}) {
    const current = select.value;
    select.innerHTML = (placeholder ? `<option value="">${escapeHtml(placeholder)}</option>` : '') +
      list.map((x) => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`).join('');
    if (keep && list.some((x) => x.id === current)) select.value = current;
  }

  /** 大分類に属する小分類だけを select に入れる（大分類未選択なら全件を大分類別にまとめて表示） */
  function fillWorkTypeSelect(select, categoryId, placeholder) {
    const current = select.value;
    const opt = (w) => `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)}</option>`;
    let html = `<option value="">${escapeHtml(placeholder)}</option>`;
    if (categoryId) {
      html += Core.workTypesOfCategory(state, categoryId).map(opt).join('');
    } else {
      html += state.categories.map((c) => {
        const items = Core.workTypesOfCategory(state, c.id);
        return items.length ? `<optgroup label="${escapeHtml(c.name)}">${items.map(opt).join('')}</optgroup>` : '';
      }).join('');
    }
    select.innerHTML = html;
    if ([...select.options].some((o) => o.value === current)) select.value = current;
  }

  function categoryOf(workTypeId) {
    const wt = state.workTypes.find((w) => w.id === workTypeId);
    return wt ? wt.categoryId : '';
  }

  // ---------- タブ ----------
  function showTab(name) {
    $$('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    $$('.panel').forEach((p) => { p.hidden = p.id !== 'tab-' + name; });
    render();
  }

  $$('.tabs [role=tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  function currentTab() {
    return $('.tabs [aria-selected=true]').dataset.tab;
  }

  // ---------- 入力フォーム ----------
  const form = $('#entry-form');

  function formMode() {
    return form.elements.mode.value;
  }

  function updateModeUI() {
    const range = formMode() === 'range';
    $('#range-fields').hidden = !range;
    form.elements.hours.readOnly = range;
    $('#quick-hours').hidden = range;
    if (range) syncHoursFromRange();
    updatePreview();
  }

  function syncHoursFromRange() {
    const h = Core.hoursFromRange(form.elements.start.value, form.elements.end.value, form.elements.breakMinutes.value);
    if (h !== null) form.elements.hours.value = h;
  }

  function unitOf(workTypeId) {
    const wt = state.workTypes.find((w) => w.id === workTypeId);
    return (wt && wt.unit) || '';
  }

  function updateUnit() {
    $('#f-unit').textContent = unitOf(form.elements.workTypeId.value);
  }

  function updatePreview() {
    const people = Number(form.elements.people.value) || 0;
    const hours = Number(form.elements.hours.value) || 0;
    const mh = Core.round2(people * hours);
    $('#calc-preview').innerHTML = `延べ工数 <strong>${fmt(mh)} h</strong>（${fmt(Core.round2(mh / perDay()))} 人工）`;
  }

  $$('input[name=mode]', form).forEach((r) => r.addEventListener('change', updateModeUI));
  ['start', 'end', 'breakMinutes'].forEach((n) => form.elements[n].addEventListener('input', () => { syncHoursFromRange(); updatePreview(); }));
  ['hours', 'people'].forEach((n) => form.elements[n].addEventListener('input', updatePreview));
  form.elements.date.addEventListener('change', renderDayList);
  form.elements.workTypeId.addEventListener('change', updateUnit);
  form.elements.categoryId.addEventListener('change', () => {
    fillWorkTypeSelect(form.elements.workTypeId, form.elements.categoryId.value, '選択してください');
    // 小分類が 1 つだけなら自動で選ぶ
    const opts = [...form.elements.workTypeId.options].filter((o) => o.value);
    if (opts.length === 1) form.elements.workTypeId.value = opts[0].value;
    updateUnit();
  });

  function setFormWorkType(workTypeId) {
    form.elements.categoryId.value = categoryOf(workTypeId);
    fillWorkTypeSelect(form.elements.workTypeId, form.elements.categoryId.value, '選択してください');
    form.elements.workTypeId.value = workTypeId;
    updateUnit();
  }

  $$('#quick-hours button').forEach((b) => b.addEventListener('click', () => {
    form.elements.hours.value = b.dataset.h;
    updatePreview();
  }));
  $$('button[data-step]', form).forEach((b) => b.addEventListener('click', () => {
    const v = Math.max(1, (Number(form.elements.people.value) || 1) + Number(b.dataset.step));
    form.elements.people.value = v;
    updatePreview();
  }));

  function resetForm(keepContext) {
    const keep = keepContext ? {
      date: form.elements.date.value,
      siteId: form.elements.siteId.value,
      categoryId: form.elements.categoryId.value,
    } : null;
    form.reset();
    form.elements.id.value = '';
    form.elements.date.value = keep ? keep.date : toISODate(new Date());
    if (keep) form.elements.siteId.value = keep.siteId;
    else if (state.settings.lastSiteId) form.elements.siteId.value = state.settings.lastSiteId;
    if (!form.elements.siteId.value && state.sites.length === 1) form.elements.siteId.value = state.sites[0].id;
    // 続けて入力しやすいよう大分類は残し、小分類は選び直してもらう
    form.elements.categoryId.value = keep ? keep.categoryId : '';
    fillWorkTypeSelect(form.elements.workTypeId, form.elements.categoryId.value, '選択してください');
    form.elements.workTypeId.value = '';
    $('#submit-btn').textContent = '記録する';
    $('#cancel-edit').hidden = true;
    $('#form-errors').innerHTML = '';
    updateUnit();
    updateModeUI();
  }

  function editEntry(id) {
    const e = state.entries.find((x) => x.id === id);
    if (!e) return;
    showTab('entry');
    form.elements.id.value = e.id;
    form.elements.date.value = e.date;
    form.elements.siteId.value = e.siteId;
    setFormWorkType(e.workTypeId);
    form.elements.worker.value = e.worker || '';
    form.elements.people.value = e.people;
    form.elements.note.value = e.note || '';
    form.elements.quantity.value = Core.isBlank(e.quantity) ? '' : e.quantity;
    updateUnit();
    const range = !!(e.start && e.end);
    form.elements.mode.value = range ? 'range' : 'hours';
    if (range) {
      form.elements.start.value = e.start;
      form.elements.end.value = e.end;
      form.elements.breakMinutes.value = e.breakMinutes ?? 0;
    }
    form.elements.hours.value = e.hours;
    updateModeUI();
    if (!range) form.elements.hours.value = e.hours;
    updatePreview();
    $('#submit-btn').textContent = '更新する';
    $('#cancel-edit').hidden = false;
    renderDayList();
    form.scrollIntoView({ behavior: 'smooth' });
  }

  function deleteEntry(id) {
    if (!confirm('この記録を削除しますか？')) return;
    state.entries = state.entries.filter((x) => x.id !== id);
    save();
    if (form.elements.id.value === id) resetForm(true);
    render();
    toast('削除しました');
  }

  function copyEntry(id) {
    const e = state.entries.find((x) => x.id === id);
    if (!e) return;
    editEntry(id);
    // 編集ではなく新規として扱う（日付は今日）
    form.elements.id.value = '';
    form.elements.date.value = toISODate(new Date());
    $('#submit-btn').textContent = '記録する';
    $('#cancel-edit').hidden = false;
    renderDayList();
    toast('内容をコピーしました。確認して記録してください。');
  }

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (formMode() === 'range') syncHoursFromRange();
    const f = form.elements;
    const range = formMode() === 'range';
    const entry = {
      id: f.id.value || Core.newId(),
      date: f.date.value,
      siteId: f.siteId.value,
      workTypeId: f.workTypeId.value,
      worker: f.worker.value.trim(),
      people: Number(f.people.value),
      hours: Number(f.hours.value),
      start: range ? f.start.value : '',
      end: range ? f.end.value : '',
      breakMinutes: range ? Number(f.breakMinutes.value) || 0 : '',
      quantity: f.quantity.value === '' ? '' : Number(f.quantity.value),
      note: f.note.value.trim(),
    };
    const errors = Core.validateEntry(entry);
    $('#form-errors').innerHTML = errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('');
    if (errors.length) return;

    const idx = state.entries.findIndex((x) => x.id === entry.id);
    if (idx >= 0) {
      state.entries[idx] = { ...state.entries[idx], ...entry, updatedAt: Date.now() };
    } else {
      state.entries.push({ ...entry, createdAt: Date.now() });
    }
    if (entry.worker && !state.workers.some((w) => w.name === entry.worker)) {
      state.workers.push({ id: Core.newId(), name: entry.worker });
    }
    state.settings.lastSiteId = entry.siteId;
    save();
    toast(idx >= 0 ? '更新しました' : '記録しました');
    resetForm(true);
    render();
  });

  $('#cancel-edit').addEventListener('click', () => resetForm(true));

  // ---------- 記録の表示 ----------
  function entryCards(entries) {
    if (!entries.length) return '<p class="muted">記録はありません</p>';
    const names = Core.nameLookup(state);
    return '<ul class="cards">' + entries.map((e) => {
      const mh = Core.entryManHours(e);
      const time = e.start && e.end ? `${e.start}〜${e.end}（休憩${e.breakMinutes || 0}分）` : '';
      return `<li class="card">
        <div class="card-main">
          <div class="card-title"><span class="tag-cat">${escapeHtml(names.categoryOfWorkType(e.workTypeId))} ›</span><span class="tag">${escapeHtml(names.workType(e.workTypeId))}</span> ${escapeHtml(names.site(e.siteId))}</div>
          <div class="card-sub">${formatDate(e.date)} ${escapeHtml(e.worker || '')} ${e.people}人 × ${fmt(e.hours)}h ${escapeHtml(time)}</div>
          ${Core.isBlank(e.quantity) ? '' : `<div class="card-sub">数量 <strong>${fmt(e.quantity)} ${escapeHtml(unitOf(e.workTypeId))}</strong></div>`}
          ${e.note ? `<div class="card-note">${escapeHtml(e.note)}</div>` : ''}
        </div>
        <div class="card-side">
          <div class="card-hours">${fmt(mh)}<small>h</small></div>
          <div class="card-actions">
            <button type="button" data-act="edit" data-id="${e.id}">編集</button>
            <button type="button" data-act="copy" data-id="${e.id}">複製</button>
            <button type="button" data-act="del" data-id="${e.id}" class="danger">削除</button>
          </div>
        </div>
      </li>`;
    }).join('') + '</ul>';
  }

  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-act]');
    if (!b) return;
    const { act, id } = b.dataset;
    if (act === 'edit') editEntry(id);
    else if (act === 'copy') copyEntry(id);
    else if (act === 'del') deleteEntry(id);
  });

  function sortedDesc(entries) {
    return [...entries].sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
  }

  function renderDayList() {
    const date = form.elements.date.value;
    const list = sortedDesc(state.entries.filter((e) => e.date === date));
    const total = Core.round2(list.reduce((s, e) => s + Core.entryManHours(e), 0));
    $('#today-list').innerHTML =
      (list.length ? `<p class="muted">${formatDate(date)} 合計 ${fmt(total)} h（${fmt(Core.round2(total / perDay()))} 人工）</p>` : '') +
      entryCards(list);
  }

  function readFilters(root) {
    const get = (n) => { const el = $(`[name=${n}]`, root); return el ? el.value : ''; };
    return { from: get('from'), to: get('to'), siteId: get('siteId'), categoryId: get('categoryId'), workTypeId: get('workTypeId') };
  }

  function listFiltered() {
    return sortedDesc(Core.filterEntries(state.entries, readFilters($('#list-filters')), state.workTypes));
  }

  function renderList() {
    const list = listFiltered();
    const total = Core.round2(list.reduce((s, e) => s + Core.entryManHours(e), 0));
    $('#list-count').textContent = `${list.length} 件 / 延べ ${fmt(total)} h（${fmt(Core.round2(total / perDay()))} 人工）`;
    $('#entry-list').innerHTML = entryCards(list);
  }
  $$('#list-filters input, #list-filters select').forEach((el) => el.addEventListener('change', () => {
    if (el.name === 'categoryId') {
      const wt = $('#list-filters [name=workTypeId]');
      fillWorkTypeSelect(wt, el.value, 'すべて');
    }
    renderList();
  }));

  // ---------- 集計 ----------
  function barTable(rows, label) {
    if (!rows.length) return '<p class="muted">データがありません</p>';
    const max = Math.max(...rows.map((r) => r.manHours)) || 1;
    const total = rows.reduce((s, r) => s + r.manHours, 0) || 1;
    return `<table class="summary-table">
      <thead><tr><th>${label}</th><th class="num">延べ工数(h)</th><th class="num">人工</th><th class="num">比率</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td><div class="bar-label">${escapeHtml(r.name)}</div><div class="bar" style="width:${(r.manHours / max) * 100}%"></div></td>
        <td class="num">${fmt(r.manHours)}</td>
        <td class="num">${fmt(r.manDays)}</td>
        <td class="num">${fmt(Core.round2((r.manHours / total) * 100))}%</td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  function renderSummary() {
    const filters = readFilters($('#summary-filters'));
    const entries = Core.filterEntries(state.entries, filters, state.workTypes);
    const names = Core.nameLookup(state);
    const total = Core.round2(entries.reduce((s, e) => s + Core.entryManHours(e), 0));
    const days = new Set(entries.map((e) => e.date)).size;

    $('#summary-totals').innerHTML = `
      <div class="stat"><span>延べ工数</span><strong>${fmt(total)}<small> h</small></strong></div>
      <div class="stat"><span>人工</span><strong>${fmt(Core.round2(total / perDay()))}</strong></div>
      <div class="stat"><span>稼働日数</span><strong>${days}<small> 日</small></strong></div>
      <div class="stat"><span>記録件数</span><strong>${entries.length}<small> 件</small></strong></div>`;

    renderRates(entries);

    const catKey = (e) => categoryOf(e.workTypeId);
    const byCat = Core.aggregate(entries, catKey, perDay()).map((r) => ({ ...r, name: names.category(r.key) }));
    $('#summary-by-category').innerHTML = barTable(byCat, '大分類');

    const byWt = Core.aggregate(entries, (e) => e.workTypeId, perDay()).map((r) => ({ ...r, name: names.workTypeFull(r.key) }));
    $('#summary-by-worktype').innerHTML = barTable(byWt, '大分類 › 小分類');

    const bySite = Core.aggregate(entries, (e) => e.siteId, perDay()).map((r) => ({ ...r, name: names.site(r.key) }));
    $('#summary-by-site').innerHTML = barTable(bySite, '現場');

    const { dates, rows } = Core.pivotByDate(entries, catKey);
    if (!dates.length) {
      $('#summary-pivot').innerHTML = '<p class="muted">データがありません</p>';
      return;
    }
    const keys = byCat.map((r) => r.key);
    const colTotals = dates.map((d) => Core.round2(keys.reduce((s, id) => s + (rows.get(id)[d] || 0), 0)));
    $('#summary-pivot').innerHTML = `<table class="pivot">
      <thead><tr><th>大分類</th>${dates.map((d) => `<th class="num">${formatDate(d)}</th>`).join('')}<th class="num">合計</th></tr></thead>
      <tbody>${byCat.map((r) => `<tr><th>${escapeHtml(r.name)}</th>${dates.map((d) => `<td class="num">${rows.get(r.key)[d] ? fmt(rows.get(r.key)[d]) : ''}</td>`).join('')}<td class="num strong">${fmt(r.manHours)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><th>合計</th>${colTotals.map((t) => `<td class="num">${fmt(t)}</td>`).join('')}<td class="num strong">${fmt(total)}</td></tr></tfoot>
    </table>`;
  }

  function renderRates(entries) {
    const bySite = $('#rate-by-site').checked;
    const rows = Core.productivity(entries, state.workTypes, perDay(), { bySite, categories: state.categories });
    if (!rows.length) {
      $('#summary-rates').innerHTML = '<p class="muted">データがありません</p>';
      return;
    }
    const names = Core.nameLookup(state);
    const cell = (v, suffix = '') => (v === null ? '<span class="muted">—</span>' : fmt(v) + suffix);
    const ratioCell = (r) => {
      if (r.ratio === null) return '<span class="muted">—</span>';
      // 標準より手間がかかっている（100% 超）なら赤、少ないなら緑
      const cls = r.ratio > 100 ? 'over' : 'under';
      return `<span class="${cls}">${fmt(r.ratio)}%</span>`;
    };
    $('#summary-rates').innerHTML = `<table class="rates">
      <thead><tr>
        ${bySite ? '<th>現場</th>' : ''}<th>工種</th><th>大分類</th>
        <th class="num">数量</th><th class="num">人工</th>
        <th class="num">歩掛り<br><small>人工/単位</small></th>
        <th class="num">1人工あたり<br><small>施工量</small></th>
        <th class="num">標準歩掛り</th><th class="num">対標準</th>
        <th class="num">稼働日<br><small>(数量記録日)</small></th>
      </tr></thead>
      <tbody>${rows.map((r) => {
        const unit = escapeHtml(r.unit);
        return `<tr>
          ${bySite ? `<td>${escapeHtml(names.site(r.siteId))}</td>` : ''}
          <td>${escapeHtml(names.workType(r.workTypeId))}</td>
          <td class="cat-cell">${escapeHtml(names.category(r.categoryId))}</td>
          <td class="num">${r.quantity > 0 ? `${fmt(r.quantity)} ${unit}` : '<span class="muted">未入力</span>'}</td>
          <td class="num">${fmt(r.manDays)}</td>
          <td class="num rate-val">${r.rate === null ? '<span class="muted">—</span>' : `${fmt(r.rate, 3)}<small> 人工/${unit || '単位'}</small>`}</td>
          <td class="num">${cell(r.output, ` ${unit}`)}</td>
          <td class="num">${r.standardRate === null ? '<span class="muted">—</span>' : fmt(r.standardRate, 3)}</td>
          <td class="num">${ratioCell(r)}</td>
          <td class="num">${r.days}日 (${r.quantityDays}日)</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  }

  $$('#summary-filters input, #summary-filters select').forEach((el) => el.addEventListener('change', renderSummary));
  $('#rate-by-site').addEventListener('change', renderSummary);

  function setPeriod(kind) {
    const now = new Date();
    let from = '', to = '';
    if (kind === 'week') {
      const d = new Date(now);
      const diff = (d.getDay() + 6) % 7; // 月曜始まり
      d.setDate(d.getDate() - diff);
      from = toISODate(d);
      d.setDate(d.getDate() + 6);
      to = toISODate(d);
    } else if (kind === 'month') {
      from = toISODate(new Date(now.getFullYear(), now.getMonth(), 1));
      to = toISODate(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    } else if (kind === 'lastmonth') {
      from = toISODate(new Date(now.getFullYear(), now.getMonth() - 1, 1));
      to = toISODate(new Date(now.getFullYear(), now.getMonth(), 0));
    }
    const root = $('#summary-filters');
    $('[name=from]', root).value = from;
    $('[name=to]', root).value = to;
    renderSummary();
  }
  $$('#period-quick button').forEach((b) => b.addEventListener('click', () => setPeriod(b.dataset.period)));

  // ---------- マスタ ----------
  function usageCount(key, id) {
    if (key === 'sites') return state.entries.filter((e) => e.siteId === id).length;
    if (key === 'workTypes') return state.entries.filter((e) => e.workTypeId === id).length;
    if (key === 'categories') {
      const ids = new Set(Core.workTypesOfCategory(state, id).map((w) => w.id));
      return state.entries.filter((e) => ids.has(e.workTypeId)).length;
    }
    return 0;
  }

  function masterActions(key, id, canUp) {
    return `<span class="master-actions">
      <button type="button" data-master-act="up" data-key="${key}" data-id="${id}" ${canUp ? '' : 'disabled'} aria-label="上へ">↑</button>
      <button type="button" data-master-act="rename" data-key="${key}" data-id="${id}">名前変更</button>
      <button type="button" data-master-act="del" data-key="${key}" data-id="${id}" class="danger">削除</button>
    </span>`;
  }

  function simpleList(key, extraLabel) {
    const list = state[key];
    return list.length ? list.map((x, i) => {
      const used = usageCount(key, x.id);
      return `<li>
        <span class="master-name">${escapeHtml(x.name)}${extraLabel ? extraLabel(x) : ''}${used ? ` <small class="muted">${used}件</small>` : ''}</span>
        ${masterActions(key, x.id, i > 0)}
      </li>`;
    }).join('') : '<li class="muted">未登録</li>';
  }

  function workTypeRow(x, i) {
    const used = usageCount('workTypes', x.id);
    const catOptions = state.categories.map((c) =>
      `<option value="${escapeHtml(c.id)}" ${c.id === x.categoryId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
    return `<li class="wt-row">
      <span class="master-name">${escapeHtml(x.name)}${used ? ` <small class="muted">${used}件</small>` : ''}
        <span class="wt-extra">
          <label>単位<input type="text" class="wt-unit" data-wt-field="unit" data-id="${x.id}" value="${escapeHtml(x.unit || '')}" placeholder="m など"></label>
          <label>標準歩掛り（人工/${escapeHtml(x.unit || '単位')}）<input type="number" class="wt-std" data-wt-field="standardRate" data-id="${x.id}" value="${escapeHtml(x.standardRate ?? '')}" min="0" step="any" inputmode="decimal" placeholder="未設定"></label>
          <label>大分類<select data-wt-field="categoryId" data-id="${x.id}">${catOptions}</select></label>
        </span>
      </span>
      ${masterActions('workTypes', x.id, i > 0)}
    </li>`;
  }

  // 再描画しても開いている大分類の折りたたみ状態を保つ
  const openGroups = new Set();
  $('#master-workTypes').addEventListener('toggle', (ev) => {
    const d = ev.target;
    if (!d.dataset || !d.dataset.cat) return;
    if (d.open) openGroups.add(d.dataset.cat); else openGroups.delete(d.dataset.cat);
  }, true);

  function renderMaster() {
    $('#master-sites').innerHTML = simpleList('sites');
    $('#master-workers').innerHTML = simpleList('workers');
    $('#master-categories').innerHTML = simpleList('categories',
      (c) => ` <small class="muted">小分類 ${Core.workTypesOfCategory(state, c.id).length}</small>`);
    $('#master-workTypes').innerHTML = state.categories.map((c) => {
      const items = Core.workTypesOfCategory(state, c.id);
      const open = openGroups.has(c.id) ? 'open' : '';
      const stdCount = items.filter((w) => !Core.isBlank(w.standardRate)).length;
      return `<details class="wt-group" data-cat="${escapeHtml(c.id)}" ${open}>
        <summary>${escapeHtml(c.name)} <small class="muted">小分類 ${items.length}・標準歩掛り設定 ${stdCount}</small></summary>
        <ul class="master-list">${items.length ? items.map(workTypeRow).join('') : '<li class="muted">小分類なし</li>'}</ul>
      </details>`;
    }).join('') || '<p class="muted">先に大分類を登録してください</p>';
    $('#s-perday').value = perDay();
  }

  $$('.add-form').forEach((f) => f.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const key = f.dataset.master;
    const name = f.elements.name.value.trim();
    if (!name) return;
    if (key === 'workTypes') {
      const categoryId = f.elements.categoryId.value;
      if (!categoryId) { toast('大分類を選択してください'); return; }
      if (state.workTypes.some((w) => w.categoryId === categoryId && w.name === name)) {
        toast('同じ大分類に同じ名前の小分類があります');
        return;
      }
      state.workTypes.push({
        id: Core.newId(), categoryId, name,
        unit: f.elements.unit.value.trim() || Core.defaultUnit(name), standardRate: '',
      });
      f.elements.name.value = '';
      f.elements.unit.value = '';
    } else {
      if (state[key].some((x) => x.name === name)) { toast('同じ名前がすでに登録されています'); return; }
      state[key].push({ id: Core.newId(), name });
      f.reset();
    }
    save();
    render();
  }));

  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-master-act]');
    if (!b) return;
    const { masterAct, key, id } = b.dataset;
    const list = state[key];
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return;
    if (masterAct === 'up') {
      // 小分類は同じ大分類の中で 1 つ上と入れ替える
      let j = i - 1;
      if (key === 'workTypes') while (j >= 0 && list[j].categoryId !== list[i].categoryId) j--;
      if (j < 0) return;
      [list[j], list[i]] = [list[i], list[j]];
    } else if (masterAct === 'rename') {
      const name = prompt('新しい名前', list[i].name);
      if (!name || !name.trim()) return;
      list[i].name = name.trim();
    } else if (masterAct === 'del') {
      if (key === 'categories' && Core.workTypesOfCategory(state, id).length) {
        alert(`「${list[i].name}」には小分類があります。先に小分類を削除するか、別の大分類へ移動してください。`);
        return;
      }
      const used = usageCount(key, id);
      const msg = used
        ? `「${list[i].name}」は ${used} 件の記録で使われています。削除すると記録の表示が「(削除済み)」になります。削除しますか？`
        : `「${list[i].name}」を削除しますか？`;
      if (!confirm(msg)) return;
      list.splice(i, 1);
    }
    save();
    render();
  });

  document.addEventListener('change', (ev) => {
    const input = ev.target.closest('[data-wt-field]');
    if (!input) return;
    const wt = state.workTypes.find((w) => w.id === input.dataset.id);
    if (!wt) return;
    const field = input.dataset.wtField;
    if (field === 'standardRate') {
      const v = input.value.trim();
      if (v !== '' && !(Number(v) >= 0)) { input.value = wt.standardRate ?? ''; return; }
      wt.standardRate = v === '' ? '' : Number(v);
    } else if (field === 'categoryId') {
      wt.categoryId = input.value;
      // 移動先の大分類の末尾に並べる
      state.workTypes = state.workTypes.filter((w) => w !== wt).concat(wt);
    } else {
      wt.unit = input.value.trim();
    }
    save();
    render();
    updateUnit();
    toast('保存しました');
  });

  $('#merge-defaults').addEventListener('click', () => {
    const added = Core.mergeDefaultTaxonomy(state);
    save();
    render();
    toast(added ? `${added} 件の小分類を追加しました` : '追加する工種はありません（すべて登録済み）');
  });

  $('#s-perday').addEventListener('change', (ev) => {
    const v = Number(ev.target.value);
    if (v > 0 && v <= 24) {
      state.settings.hoursPerManDay = v;
      save();
      render();
    } else {
      ev.target.value = perDay();
    }
  });

  // ---------- 入出力 ----------
  const stamp = () => toISODate(new Date()).replace(/-/g, '');

  $('#backup-json').addEventListener('click', () => {
    download(`工数記録_バックアップ_${stamp()}.json`, JSON.stringify(state, null, 2), 'application/json');
  });

  $('#restore-json').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await readFile(file));
      if (!confirm('現在のデータをバックアップの内容で置き換えます。よろしいですか？')) return;
      state = Core.normalizeState(data);
      save();
      resetForm(false);
      render();
      toast(`復元しました（${state.entries.length} 件）`);
    } catch (e) {
      alert('バックアップファイルを読み込めませんでした: ' + e.message);
    }
  });

  $('#export-all-csv').addEventListener('click', () => {
    download(`工数記録_${stamp()}.csv`, Core.entriesToCsv(state, state.entries), 'text/csv');
  });

  $('#export-list-csv').addEventListener('click', () => {
    download(`工数記録_${stamp()}.csv`, Core.entriesToCsv(state, listFiltered()), 'text/csv');
  });

  $('#import-csv').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    try {
      const { added, errors } = Core.importCsv(state, await readFile(file));
      save();
      render();
      alert(`${added} 件取り込みました。` + (errors.length ? `\n\n取り込めなかった行:\n${errors.slice(0, 20).join('\n')}` : ''));
    } catch (e) {
      alert('CSV を読み込めませんでした: ' + e.message);
    }
  });

  $('#clear-all').addEventListener('click', () => {
    if (!confirm('すべての記録とマスタを削除します。元に戻せません。よろしいですか？')) return;
    if (!confirm('本当に削除しますか？（先にバックアップを保存することをおすすめします）')) return;
    state = Core.emptyState();
    save();
    resetForm(false);
    render();
    toast('全データを削除しました');
  });

  // ---------- 描画 ----------
  function renderSelects() {
    fillSelect(form.elements.siteId, state.sites, { placeholder: state.sites.length ? '選択してください' : '先に「設定」で現場を登録' });
    if (!form.elements.siteId.value && state.sites.length === 1) form.elements.siteId.value = state.sites[0].id;
    fillSelect(form.elements.categoryId, state.categories, { placeholder: '選択してください' });
    fillWorkTypeSelect(form.elements.workTypeId, form.elements.categoryId.value, '選択してください');
    for (const root of [$('#list-filters'), $('#summary-filters')]) {
      fillSelect($('[name=siteId]', root), state.sites, { placeholder: 'すべて' });
      const cat = $('[name=categoryId]', root);
      fillSelect(cat, state.categories, { placeholder: 'すべて' });
      const wt = $('[name=workTypeId]', root);
      if (wt) fillWorkTypeSelect(wt, cat.value, 'すべて');
    }
    fillSelect($('.wt-add [name=categoryId]'), state.categories, { placeholder: '大分類を選択' });
    $('#worker-list').innerHTML = state.workers.map((w) => `<option value="${escapeHtml(w.name)}">`).join('');
  }

  function render() {
    renderSelects();
    const tab = currentTab();
    if (tab === 'entry') { renderDayList(); updatePreview(); }
    else if (tab === 'list') renderList();
    else if (tab === 'summary') renderSummary();
    else if (tab === 'master') renderMaster();
  }

  // ---------- 起動 ----------
  renderSelects();
  resetForm(false);
  setPeriod('month');
  render();
  if (!state.sites.length) toast('まず「設定」タブで現場を登録してください');

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker 登録失敗', e));
  }
})();
