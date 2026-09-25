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

  function fmt(n) {
    return Number(n).toLocaleString('ja-JP', { maximumFractionDigits: 2 });
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
    } : null;
    form.reset();
    form.elements.id.value = '';
    form.elements.date.value = keep ? keep.date : toISODate(new Date());
    if (keep) form.elements.siteId.value = keep.siteId;
    else if (state.settings.lastSiteId) form.elements.siteId.value = state.settings.lastSiteId;
    $('#submit-btn').textContent = '記録する';
    $('#cancel-edit').hidden = true;
    $('#form-errors').innerHTML = '';
    updateModeUI();
  }

  function editEntry(id) {
    const e = state.entries.find((x) => x.id === id);
    if (!e) return;
    showTab('entry');
    form.elements.id.value = e.id;
    form.elements.date.value = e.date;
    form.elements.siteId.value = e.siteId;
    form.elements.workTypeId.value = e.workTypeId;
    form.elements.worker.value = e.worker || '';
    form.elements.people.value = e.people;
    form.elements.note.value = e.note || '';
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
          <div class="card-title"><span class="tag">${escapeHtml(names.workType(e.workTypeId))}</span> ${escapeHtml(names.site(e.siteId))}</div>
          <div class="card-sub">${formatDate(e.date)} ${escapeHtml(e.worker || '')} ${e.people}人 × ${fmt(e.hours)}h ${escapeHtml(time)}</div>
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
    return { from: get('from'), to: get('to'), siteId: get('siteId'), workTypeId: get('workTypeId') };
  }

  function listFiltered() {
    return sortedDesc(Core.filterEntries(state.entries, readFilters($('#list-filters'))));
  }

  function renderList() {
    const list = listFiltered();
    const total = Core.round2(list.reduce((s, e) => s + Core.entryManHours(e), 0));
    $('#list-count').textContent = `${list.length} 件 / 延べ ${fmt(total)} h（${fmt(Core.round2(total / perDay()))} 人工）`;
    $('#entry-list').innerHTML = entryCards(list);
  }
  $$('#list-filters input, #list-filters select').forEach((el) => el.addEventListener('change', renderList));

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
    const entries = Core.filterEntries(state.entries, filters);
    const names = Core.nameLookup(state);
    const total = Core.round2(entries.reduce((s, e) => s + Core.entryManHours(e), 0));
    const days = new Set(entries.map((e) => e.date)).size;

    $('#summary-totals').innerHTML = `
      <div class="stat"><span>延べ工数</span><strong>${fmt(total)}<small> h</small></strong></div>
      <div class="stat"><span>人工</span><strong>${fmt(Core.round2(total / perDay()))}</strong></div>
      <div class="stat"><span>稼働日数</span><strong>${days}<small> 日</small></strong></div>
      <div class="stat"><span>記録件数</span><strong>${entries.length}<small> 件</small></strong></div>`;

    const byWt = Core.aggregate(entries, (e) => e.workTypeId, perDay()).map((r) => ({ ...r, name: names.workType(r.key) }));
    $('#summary-by-worktype').innerHTML = barTable(byWt, '工種');

    const bySite = Core.aggregate(entries, (e) => e.siteId, perDay()).map((r) => ({ ...r, name: names.site(r.key) }));
    $('#summary-by-site').innerHTML = barTable(bySite, '現場');

    const { dates, rows } = Core.pivotByWorkTypeAndDate(entries);
    if (!dates.length) {
      $('#summary-pivot').innerHTML = '<p class="muted">データがありません</p>';
      return;
    }
    const wtIds = byWt.map((r) => r.key);
    const colTotals = dates.map((d) => Core.round2(wtIds.reduce((s, id) => s + (rows.get(id)[d] || 0), 0)));
    $('#summary-pivot').innerHTML = `<table class="pivot">
      <thead><tr><th>工種</th>${dates.map((d) => `<th class="num">${formatDate(d)}</th>`).join('')}<th class="num">合計</th></tr></thead>
      <tbody>${byWt.map((r) => `<tr><th>${escapeHtml(r.name)}</th>${dates.map((d) => `<td class="num">${rows.get(r.key)[d] ? fmt(rows.get(r.key)[d]) : ''}</td>`).join('')}<td class="num strong">${fmt(r.manHours)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><th>合計</th>${colTotals.map((t) => `<td class="num">${fmt(t)}</td>`).join('')}<td class="num strong">${fmt(total)}</td></tr></tfoot>
    </table>`;
  }

  $$('#summary-filters input, #summary-filters select').forEach((el) => el.addEventListener('change', renderSummary));

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
    const field = key === 'sites' ? 'siteId' : key === 'workTypes' ? 'workTypeId' : null;
    if (!field) return 0;
    return state.entries.filter((e) => e[field] === id).length;
  }

  function renderMaster() {
    for (const key of ['sites', 'workTypes', 'workers']) {
      const ul = $('#master-' + key);
      const list = state[key];
      ul.innerHTML = list.length ? list.map((x, i) => {
        const used = usageCount(key, x.id);
        return `<li>
          <span class="master-name">${escapeHtml(x.name)}${used ? ` <small class="muted">${used}件</small>` : ''}</span>
          <span class="master-actions">
            <button type="button" data-master-act="up" data-key="${key}" data-id="${x.id}" ${i === 0 ? 'disabled' : ''} aria-label="上へ">↑</button>
            <button type="button" data-master-act="rename" data-key="${key}" data-id="${x.id}">名前変更</button>
            <button type="button" data-master-act="del" data-key="${key}" data-id="${x.id}" class="danger">削除</button>
          </span>
        </li>`;
      }).join('') : '<li class="muted">未登録</li>';
    }
    $('#s-perday').value = perDay();
  }

  $$('.add-form').forEach((f) => f.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const key = f.dataset.master;
    const name = f.elements.name.value.trim();
    if (!name) return;
    if (state[key].some((x) => x.name === name)) { toast('同じ名前がすでに登録されています'); return; }
    state[key].push({ id: Core.newId(), name });
    save();
    f.reset();
    render();
  }));

  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-master-act]');
    if (!b) return;
    const { masterAct, key, id } = b.dataset;
    const list = state[key];
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return;
    if (masterAct === 'up' && i > 0) {
      [list[i - 1], list[i]] = [list[i], list[i - 1]];
    } else if (masterAct === 'rename') {
      const name = prompt('新しい名前', list[i].name);
      if (!name || !name.trim()) return;
      list[i].name = name.trim();
    } else if (masterAct === 'del') {
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
    fillSelect(form.elements.workTypeId, state.workTypes, { placeholder: '選択してください' });
    for (const root of [$('#list-filters'), $('#summary-filters')]) {
      fillSelect($('[name=siteId]', root), state.sites, { placeholder: 'すべて' });
      const wt = $('[name=workTypeId]', root);
      if (wt) fillSelect(wt, state.workTypes, { placeholder: 'すべて' });
    }
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
