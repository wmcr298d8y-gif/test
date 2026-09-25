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

  // ---------- 画面内ダイアログ ----------
  // ブラウザ標準の alert / confirm / prompt は埋め込み表示などで使えない場合があるため、画面内に表示する
  const modal = {
    root: $('#modal'),
    open({ title = '', message = '', input = null, text = null, buttons }) {
      return new Promise((resolve) => {
        const inputEl = $('#modal-input');
        const textEl = $('#modal-text');
        $('#modal-title').textContent = title;
        $('#modal-title').hidden = !title;
        $('#modal-msg').textContent = message;
        $('#modal-msg').hidden = !message;
        inputEl.hidden = input === null;
        inputEl.value = input ?? '';
        textEl.hidden = text === null;
        textEl.value = text ?? '';
        const actions = $('#modal-actions');
        actions.innerHTML = '';
        const prevFocus = document.activeElement;
        const close = (value) => {
          this.root.hidden = true;
          document.removeEventListener('keydown', onKey);
          if (prevFocus && prevFocus.focus) prevFocus.focus();
          resolve(value);
        };
        const onKey = (ev) => {
          if (ev.key === 'Escape') close(null);
          if (ev.key === 'Enter' && ev.target === inputEl) close(inputEl.value);
        };
        for (const bt of buttons) {
          const el = document.createElement('button');
          el.type = 'button';
          el.textContent = bt.label;
          if (bt.className) el.className = bt.className;
          el.addEventListener('click', async () => {
            if (bt.onClick) { await bt.onClick(el); return; }
            close(typeof bt.value === 'function' ? bt.value() : bt.value);
          });
          actions.appendChild(el);
        }
        this.root.hidden = false;
        document.addEventListener('keydown', onKey);
        (input !== null ? inputEl : actions.lastElementChild).focus();
        if (input !== null) inputEl.select();
      });
    },
  };

  function showAlert(message, title = '') {
    return modal.open({ title, message, buttons: [{ label: 'OK', className: 'primary', value: true }] });
  }

  async function askConfirm(message, { ok = 'OK', danger = false, title = '' } = {}) {
    const v = await modal.open({
      title, message,
      buttons: [{ label: 'キャンセル', value: false }, { label: ok, className: danger ? 'danger-fill' : 'primary', value: true }],
    });
    return v === true;
  }

  async function askText(message, defaultValue = '') {
    const v = await modal.open({
      message, input: defaultValue,
      buttons: [{ label: 'キャンセル', value: null }, { label: 'OK', className: 'primary', value: () => $('#modal-input').value }],
    });
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  }

  /**
   * 出力画面。ファイル保存に加え、保存できない環境向けにコピー（Excel に貼り付け可能なタブ区切り）も用意する。
   */
  function showExport({ title, filename, content, type, copyText }) {
    return modal.open({
      title,
      message: '「ファイルに保存」で保存できない場合は「コピー」して、Excel やメモ帳に貼り付けてください。',
      text: copyText,
      buttons: [
        { label: '閉じる', value: null },
        {
          label: 'コピー', onClick: async (btn) => {
            try {
              await navigator.clipboard.writeText(copyText);
              btn.textContent = 'コピーしました';
            } catch (e) {
              const t = $('#modal-text');
              t.focus();
              t.select();
              btn.textContent = '選択しました（長押し/Ctrl+C でコピー）';
            }
          },
        },
        { label: 'ファイルに保存', className: 'primary', onClick: () => download(filename, content, type) },
      ],
    });
  }

  /** CSV をタブ区切りに変換（Excel に貼り付けると列に分かれる） */
  function csvToTsv(csv) {
    return Core.parseCsv(csv).map((r) => r.map((f) => f.replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');
  }

  function exportCsv(title, filename, csv) {
    return showExport({ title, filename, content: csv, type: 'text/csv', copyText: csvToTsv(csv) });
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

  // ---------- 現場用 / 管理者用 ----------
  // 本番では kintone にログインしたアカウントで決まる。モックでは画面右上で切り替える
  function role() {
    return state.settings.role === 'admin' ? 'admin' : 'site';
  }

  function applyRole() {
    const r = role();
    document.body.dataset.role = r;
    $$('.role-switch [data-role]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.role === r)));
    $$('.tabs [role=tab]').forEach((b) => { b.hidden = !b.dataset.roles.split(' ').includes(r); });
  }

  $$('.role-switch [data-role]').forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.role === role()) return;
    if (!await confirmDiscard()) return;
    state.settings.role = b.dataset.role;
    save();
    applyRole();
    // 未保存の内容は破棄済み。選べる現場が変わるので読み直す
    sheet.dirty = false;
    report.dirty = false;
    loadContext(sheet.date, sheet.siteId || defaultSiteId());
    showTab($('.tabs [aria-selected=true]').hidden ? 'entry' : currentTab());
  }));

  // ---------- タブ ----------
  function showTab(name) {
    if (name !== 'site') editingNote = false;
    $$('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    $$('.panel').forEach((p) => { p.hidden = p.id !== 'tab-' + name; });
    render();
  }

  $$('.tabs [role=tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  function currentTab() {
    return $('.tabs [aria-selected=true]').dataset.tab;
  }

  // ---------- 入力（日報） ----------
  // 1 日・1 現場分の作業（工種）を行として並べ、まとめて保存する
  const form = $('#entry-form');
  let sheet = { date: '', siteId: '', rows: [], dirty: false };
  let rowSeq = 0;

  function unitOf(workTypeId) {
    const wt = state.workTypes.find((w) => w.id === workTypeId);
    return (wt && wt.unit) || '';
  }

  function unitLabel(workTypeId) {
    const u = unitOf(workTypeId);
    return u ? `(${u})` : '';
  }

  function makeRow(src = {}) {
    return {
      key: 'r' + (++rowSeq),
      id: src.id || '',
      categoryId: src.categoryId ?? categoryOf(src.workTypeId || ''),
      workTypeId: src.workTypeId || '',
      people: src.people ?? 1,
      hours: src.hours ?? 8,
      quantity: Core.isBlank(src.quantity) ? '' : src.quantity,
      hard: !!src.hard,
      note: src.note || '',
    };
  }

  /** 新しい行は直前の行の大分類・人数・時間を引き継ぐ（同じ班で工種だけ変わることが多いため） */
  function newRowLike(last) {
    return makeRow(last ? { categoryId: last.categoryId, people: last.people, hours: last.hours } : {});
  }

  // 増減ボタンの刻みと範囲（時間は 0.25h = 15 分刻み）
  const STEPPERS = {
    people: { step: 1, min: 1, max: 99, label: '人数' },
    hours: { step: 0.25, min: 0.25, max: 24, label: '時間' },
  };

  /** 刻みに合わせて丸め、範囲内に収める */
  function snapValue(f, value) {
    const c = STEPPERS[f];
    const n = Number(value);
    if (!Number.isFinite(n)) return c.min;
    const snapped = Math.round(n / c.step) * c.step;
    return Math.min(c.max, Math.max(c.min, Core.round2(snapped)));
  }

  function rowCalcText(r) {
    const mh = rowManHours(r);
    return `延べ <strong>${fmt(mh)} h</strong><br>${fmt(Core.round2(mh / perDay()))} 人工`;
  }

  function stepperHtml(r, f, i) {
    const c = STEPPERS[f];
    const inputId = `${r.key}-${f}`;
    return `<div class="num-field">
      <label for="${inputId}">${f === 'hours' ? '時間(h/人)' : '人数'}</label>
      <div class="stepper">
        <button type="button" data-step="-1" data-f-target="${f}" aria-label="作業 ${i + 1} の${c.label}を減らす">▼</button>
        <input id="${inputId}" data-f="${f}" type="number" min="${c.min}" max="${c.max}" step="${c.step}"
          inputmode="${f === 'hours' ? 'decimal' : 'numeric'}" value="${escapeHtml(r[f])}">
        <button type="button" data-step="1" data-f-target="${f}" aria-label="作業 ${i + 1} の${c.label}を増やす">▲</button>
      </div>
    </div>`;
  }

  function rowManHours(r) {
    return Core.round2((Number(r.people) || 0) * (Number(r.hours) || 0));
  }

  /** 日付・現場の日報を保存済みの記録から読み込む */
  function loadSheet(date, siteId) {
    if (!entrySites().some((x) => x.id === siteId)) siteId = '';
    const rows = siteId ? Core.dayEntries(state, date, siteId).map(makeRow) : [];
    sheet = { date, siteId, rows: rows.length ? rows : [newRowLike(null)], dirty: false };
    form.elements.date.value = date;
    form.elements.siteId.value = siteId;
    $('#form-errors').innerHTML = '';
    renderSheet();
  }

  function markDirty() {
    sheet.dirty = true;
    updateSheetTotal();
  }

  /** 保存していない変更がある場合は破棄してよいか確認する */
  async function confirmDiscard() {
    if (!sheet.dirty && !report.dirty) return true;
    const which = [report.dirty ? '日報' : '', sheet.dirty ? '工数' : ''].filter(Boolean).join('と');
    return askConfirm(`${which}に保存していない変更があります。破棄して移動しますか？`, { ok: '破棄する', danger: true });
  }

  /** 日付・現場を切り替えて、日報と工数の両方を読み直す */
  function loadContext(date, siteId) {
    loadSheet(date, siteId);
    loadReport(sheet.date, sheet.siteId);
    // 現場タブを開いているときは、選んだ日付・現場の内容に描き直す
    if (currentTab() === 'site') renderSiteView();
  }

  /** 入力画面で選べる現場（現場用は稼働中のみ、管理者は完工済みも表示・閲覧できる） */
  function entrySites() {
    return state.sites.filter((x) => role() === 'admin' || x.status !== 'done');
  }

  /** 既定の現場: 入力者が最後に入力した現場 → この端末で最後に使った現場 → 1 件だけならそれ */
  function defaultSiteId() {
    const allowed = new Set(entrySites().map((x) => x.id));
    const emp = state.settings.lastEmployeeId;
    if (emp) {
      const last = state.entries.filter((e) => e.inputBy === emp && allowed.has(e.siteId))
        .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0))[0];
      if (last) return last.siteId;
    }
    if (allowed.has(state.settings.lastSiteId)) return state.settings.lastSiteId;
    return allowed.size === 1 ? [...allowed][0] : '';
  }

  function openToday() {
    loadContext(toISODate(new Date()), defaultSiteId());
  }

  function workTypeOptions(categoryId, selected) {
    const items = categoryId ? Core.workTypesOfCategory(state, categoryId) : [];
    return `<option value="">${categoryId ? '小分類を選択' : '先に大分類を選択'}</option>` +
      items.map((w) => `<option value="${escapeHtml(w.id)}" ${w.id === selected ? 'selected' : ''}>${escapeHtml(w.name)}</option>`).join('');
  }

  function rowHtml(r, i) {
    const catOptions = '<option value="">大分類を選択</option>' + state.categories.map((c) =>
      `<option value="${escapeHtml(c.id)}" ${c.id === r.categoryId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
    const id = (f) => `${r.key}-${f}`;
    const hasDetail = !!r.note;
    return `<div class="work-row" data-key="${r.key}">
      <div class="work-row-head">
        <span class="work-no">作業 ${i + 1}</span>
        <label class="hard-toggle" for="${id('hard')}" title="高所・狭所など、通常より手間のかかる作業">
          <input id="${id('hard')}" type="checkbox" data-f="hard" ${r.hard ? 'checked' : ''}> 難
        </label>
        <span class="work-row-actions">
          <button type="button" data-row-act="up" ${i === 0 ? 'disabled' : ''} aria-label="作業 ${i + 1} を上へ">↑</button>
          <button type="button" data-row-act="dup">複製</button>
          <button type="button" data-row-act="del" class="danger">削除</button>
        </span>
      </div>
      <div class="work-type">
        <select id="${id('cat')}" data-f="categoryId" aria-label="作業 ${i + 1} の大分類">${catOptions}</select>
        <select id="${id('wt')}" data-f="workTypeId" aria-label="作業 ${i + 1} の小分類">${workTypeOptions(r.categoryId, r.workTypeId)}</select>
      </div>
      <div class="work-nums">
        ${stepperHtml(r, 'people', i)}
        ${stepperHtml(r, 'hours', i)}
        <div class="num-field">
          <label for="${id('qty')}">数量<span class="unit" data-unit>${escapeHtml(unitLabel(r.workTypeId))}</span></label>
          <input id="${id('qty')}" data-f="quantity" type="number" min="0" step="any" inputmode="decimal" value="${escapeHtml(r.quantity)}" placeholder="任意">
        </div>
        <div class="row-calc" data-mh>${rowCalcText(r)}</div>
      </div>
      <details class="work-more" ${hasDetail ? 'open' : ''}>
        <summary>備考${hasDetail ? '' : ' <span class="muted">（任意。「難」の理由など）</span>'}</summary>
        <div class="work-more-body">
          <input id="${id('note')}" data-f="note" type="text" value="${escapeHtml(r.note)}" placeholder="場所・内容など" aria-label="作業 ${i + 1} の備考">
        </div>
      </details>
    </div>`;
  }

  function renderSheet() {
    $('#sheet-rows').innerHTML = sheet.rows.map(rowHtml).join('');
    const site = state.sites.find((x) => x.id === sheet.siteId);
    const done = !!site && site.status === 'done';
    $('#sheet-fields').disabled = done;
    $('#sheet-lock').hidden = !done;
    if (done) $('#sheet-lock').textContent = `この現場は完工済みです（完工日 ${site.completedOn ? formatDate(site.completedOn) : '未設定'}）。表示のみで、入力・修正はできません。`;
    renderDaySites();
    updateSheetTotal();
  }

  /** 日報の出面に対して、工数をどれだけ割り振ったか（出面 1 人 = 1 人工として比べる） */
  function renderCrewBanner(totalHours) {
    const rep = Core.findReport(state, sheet.date, sheet.siteId);
    const el = $('#entry-crew');
    if (!sheet.siteId) { el.innerHTML = ''; return; }
    const md = Core.round2(totalHours / perDay());
    if (!rep) {
      el.innerHTML = `<span class="muted">この日の日報はまだありません。先に「日報」タブで出面を入力すると、割り振りの残りが分かります。</span>`;
      return;
    }
    const crew = Core.crewTotal(rep);
    const rest = Core.round2(crew - md);
    const withType = rep.tasks.filter((t) => t.workTypeId && !sheet.rows.some((r) => r.workTypeId === t.workTypeId));
    el.innerHTML = `<div>日報の出面 <strong>${fmt(crew)} 人工</strong> のうち、工数に割り振り済み <strong>${fmt(md)} 人工</strong>
      ${rest > 0 ? `<span class="pill active">残り ${fmt(rest)} 人工</span>` : rest < 0 ? `<span class="pill hard">出面より ${fmt(-rest)} 人工多い</span>` : '<span class="pill active">割り振り完了</span>'}</div>` +
      (withType.length ? `<button type="button" id="rows-from-report">日報の作業から工種を取り込む（${withType.length} 件）</button>` : '');
  }

  function updateSheetTotal() {
    const filled = sheet.rows.filter((r) => !Core.isEmptyRow(r));
    const total = Core.round2(filled.reduce((s, r) => s + rowManHours(r), 0));
    renderCrewBanner(total);
    $('#sheet-total').innerHTML = `<strong>${fmt(total)} h</strong>（${fmt(Core.round2(total / perDay()))} 人工）・${filled.length} 作業` +
      (sheet.dirty ? ' <span class="unsaved">未保存</span>' : '');
    $('#save-sheet').disabled = !sheet.dirty || Core.isSiteDone(state, sheet.siteId);
  }

  /** 同じ日に記録のある現場（切り替え用） */
  function renderDaySites() {
    // 同じ日に日報のある現場（出面の人数を表示）
    const reports = state.reports.filter((r) => r.date === sheet.date);
    const allowed = new Set(entrySites().map((x) => x.id));
    const sites = reports.filter((r) => r.siteId !== sheet.siteId && allowed.has(r.siteId))
      .map((r) => ({ site: state.sites.find((x) => x.id === r.siteId), crew: Core.crewTotal(r) })).filter((x) => x.site);
    $('#day-sites').innerHTML = sites.length
      ? `<span class="muted small">${formatDate(sheet.date)} の他の現場:</span> ` + sites.map(({ site, crew }) =>
        `<button type="button" class="chip" data-goto-site="${escapeHtml(site.id)}">${escapeHtml(site.name)} ${fmt(crew)}人工</button>`).join('')
      : '';
  }

  function rowOf(el) {
    const box = el.closest('.work-row');
    return box ? sheet.rows.find((r) => r.key === box.dataset.key) : null;
  }

  $('#sheet-rows').addEventListener('input', (ev) => {
    const f = ev.target.dataset.f;
    const r = rowOf(ev.target);
    if (!f || !r || ev.target.tagName === 'SELECT') return;
    r[f] = ev.target.type === 'checkbox' ? ev.target.checked : ev.target.value;
    if (f === 'people' || f === 'hours') ev.target.closest('.work-row').querySelector('[data-mh]').innerHTML = rowCalcText(r);
    markDirty();
  });

  // 直接入力した人数・時間は、入力を終えた時点で刻みに合わせる（例: 7.3h → 7.25h）
  $('#sheet-rows').addEventListener('focusout', (ev) => {
    const f = ev.target.dataset.f;
    if (!STEPPERS[f]) return;
    const r = rowOf(ev.target);
    const v = snapValue(f, ev.target.value);
    if (String(v) === String(ev.target.value)) return;
    ev.target.value = v;
    r[f] = v;
    ev.target.closest('.work-row').querySelector('[data-mh]').innerHTML = rowCalcText(r);
    markDirty();
  });

  // ▲▼ボタン。押し続けると連続で増減する
  function stepBy(btn) {
    const f = btn.dataset.fTarget;
    const r = rowOf(btn);
    const input = btn.parentElement.querySelector('input');
    const v = snapValue(f, (Number(input.value) || 0) + Number(btn.dataset.step) * STEPPERS[f].step);
    input.value = v;
    r[f] = v;
    btn.closest('.work-row').querySelector('[data-mh]').innerHTML = rowCalcText(r);
    markDirty();
  }

  let repeatTimer = null;
  // 指・マウスで押した場合は pointerdown で増減済みなので、続く click では増減しない
  let pointerStepped = false;
  function stopRepeat() {
    clearTimeout(repeatTimer);
    clearInterval(repeatTimer);
    repeatTimer = null;
  }
  $('#sheet-rows').addEventListener('pointerdown', (ev) => {
    const btn = ev.target.closest('button[data-step]');
    if (!btn || ev.button !== 0) return;
    ev.preventDefault(); // 長押しで文字選択やメニューが出ないように
    pointerStepped = true;
    stepBy(btn);
    stopRepeat();
    repeatTimer = setTimeout(() => { repeatTimer = setInterval(() => stepBy(btn), 90); }, 450);
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
    $('#sheet-rows').addEventListener(type, stopRepeat, true);
  }
  $('#sheet-rows').addEventListener('contextmenu', (ev) => {
    if (ev.target.closest('button[data-step]')) ev.preventDefault();
  });
  // キーボード操作（Enter / Space）ではクリックとして 1 回だけ増減する
  $('#sheet-rows').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-step]');
    if (!btn) return;
    if (pointerStepped) { pointerStepped = false; return; }
    stepBy(btn);
  });
  $('#sheet-rows').addEventListener('keydown', () => { pointerStepped = false; });

  $('#sheet-rows').addEventListener('change', (ev) => {
    const f = ev.target.dataset.f;
    const r = rowOf(ev.target);
    if (!r || (f !== 'categoryId' && f !== 'workTypeId')) return;
    const box = ev.target.closest('.work-row');
    r[f] = ev.target.value;
    if (f === 'categoryId') {
      const wtSel = box.querySelector('[data-f=workTypeId]');
      const items = Core.workTypesOfCategory(state, r.categoryId);
      // 小分類が 1 つだけなら自動で選ぶ
      r.workTypeId = items.length === 1 ? items[0].id : '';
      wtSel.innerHTML = workTypeOptions(r.categoryId, r.workTypeId);
      if (!r.workTypeId) wtSel.focus();
    }
    box.querySelector('[data-unit]').textContent = unitLabel(r.workTypeId);
    markDirty();
  });

  $('#sheet-rows').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button[data-row-act]');
    if (!b) return;
    const r = rowOf(b);
    const i = sheet.rows.indexOf(r);
    const act = b.dataset.rowAct;
    if (act === 'del') {
      const filled = !Core.isEmptyRow(r);
      if (filled && !await askConfirm(`作業 ${i + 1} を削除しますか？（「保存」で確定します）`, { ok: '削除する', danger: true })) return;
      sheet.rows.splice(i, 1);
      if (!sheet.rows.length) sheet.rows.push(newRowLike(null));
    } else if (act === 'dup') {
      sheet.rows.splice(i + 1, 0, makeRow({ ...r, id: '', quantity: '' }));
    } else if (act === 'up' && i > 0) {
      [sheet.rows[i - 1], sheet.rows[i]] = [sheet.rows[i], sheet.rows[i - 1]];
    }
    markDirty();
    renderSheet();
    if (act === 'dup') $(`.work-row[data-key="${sheet.rows[i + 1].key}"] [data-f=workTypeId]`).focus();
  });

  // 日報で工種を付けた作業を、工数の行として取り込む
  $('#entry-crew').addEventListener('click', (ev) => {
    if (!ev.target.closest('#rows-from-report')) return;
    const rep = Core.findReport(state, sheet.date, sheet.siteId);
    if (!rep) return;
    sheet.rows = sheet.rows.filter((r) => !Core.isEmptyRow(r));
    for (const t of rep.tasks) {
      if (!t.workTypeId || sheet.rows.some((r) => r.workTypeId === t.workTypeId)) continue;
      sheet.rows.push(makeRow({ workTypeId: t.workTypeId, people: 1, hours: 8, note: t.place }));
    }
    if (!sheet.rows.length) sheet.rows.push(newRowLike(null));
    markDirty();
    renderSheet();
    toast('日報の作業を取り込みました。人数と時間を確認して保存してください');
  });

  $('#add-row').addEventListener('click', () => {
    const r = newRowLike(sheet.rows[sheet.rows.length - 1]);
    sheet.rows.push(r);
    markDirty();
    renderSheet();
    const box = $(`.work-row[data-key="${r.key}"]`);
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    box.querySelector(r.categoryId ? '[data-f=workTypeId]' : '[data-f=categoryId]').focus();
  });

  $('#load-prev').addEventListener('click', async () => {
    if (!sheet.siteId) { toast('先に現場を選択してください'); return; }
    const prev = Core.previousDayRows(state, sheet.siteId, sheet.date);
    if (!prev.date) { toast('この現場の以前の記録はありません'); return; }
    const hasInput = sheet.rows.some((r) => !Core.isEmptyRow(r));
    if (hasInput && !await askConfirm(`${formatDate(prev.date)} の作業 ${prev.rows.length} 件を下に追加しますか？`, { ok: '追加する' })) return;
    sheet.rows = sheet.rows.filter((r) => !Core.isEmptyRow(r)).concat(prev.rows.map(makeRow));
    markDirty();
    renderSheet();
    toast(`${formatDate(prev.date)} の作業を呼び出しました。数量を入れて保存してください`);
  });

  form.elements.inputBy.addEventListener('change', (ev) => {
    // 入力者はこの端末で覚えておく（次回から選び直さなくてよい）
    state.settings.lastEmployeeId = ev.target.value;
    save();
    if (!sheet.dirty && !report.dirty && !sheet.siteId) loadContext(sheet.date, defaultSiteId());
    $('#form-errors').innerHTML = '';
  });

  form.elements.date.addEventListener('change', async (ev) => {
    if (!await confirmDiscard()) { ev.target.value = sheet.date; return; }
    loadContext(ev.target.value, sheet.siteId);
  });

  form.elements.siteId.addEventListener('change', async (ev) => {
    if (!await confirmDiscard()) { ev.target.value = sheet.siteId; return; }
    loadContext(sheet.date, ev.target.value);
  });

  $('#day-sites').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-goto-site]');
    if (!b || !await confirmDiscard()) return;
    loadContext(sheet.date, b.dataset.gotoSite);
  });

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const res = Core.saveDaySheet(state, sheet.date, sheet.siteId, sheet.rows, Date.now(), {
      inputBy: form.elements.inputBy.value,
      requireInputBy: state.employees.length > 0,
    });
    $('#form-errors').innerHTML = res.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('');
    if (res.errors.length) {
      $('#form-errors').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    state.settings.lastSiteId = sheet.siteId;
    save();
    loadSheet(sheet.date, sheet.siteId);
    renderSelects();
    toast(`保存しました（${res.saved} 作業${res.removed ? `・${res.removed} 件削除` : ''}）`);
  });

  window.addEventListener('beforeunload', (ev) => {
    if (!sheet.dirty) return;
    ev.preventDefault();
    ev.returnValue = '';
  });

  /** 一覧などから、その記録の日報を開く */
  async function openEntryInSheet(id) {
    const e = state.entries.find((x) => x.id === id);
    if (!e) return;
    if (!(sheet.date === e.date && sheet.siteId === e.siteId) && !await confirmDiscard()) return;
    showTab('entry');
    if (!(sheet.date === e.date && sheet.siteId === e.siteId && sheet.dirty)) loadContext(e.date, e.siteId);
    const r = sheet.rows.find((x) => x.id === id);
    const box = r && $(`.work-row[data-key="${r.key}"]`);
    if (box) {
      box.scrollIntoView({ behavior: 'smooth', block: 'center' });
      box.classList.add('flash');
      setTimeout(() => box.classList.remove('flash'), 1500);
    }
  }

  /** 記録を今日の日報に複製する */
  async function copyEntryToToday(id) {
    const e = state.entries.find((x) => x.id === id);
    if (!e) return;
    const today = toISODate(new Date());
    if (!(sheet.date === today && sheet.siteId === e.siteId) && !await confirmDiscard()) return;
    showTab('entry');
    if (!(sheet.date === today && sheet.siteId === e.siteId)) loadContext(today, e.siteId);
    sheet.rows = sheet.rows.filter((r) => !Core.isEmptyRow(r));
    sheet.rows.push(makeRow({ ...e, id: '', quantity: '', note: '' }));
    markDirty();
    renderSheet();
    $('#sheet-rows .work-row:last-child').scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast('今日の日報に追加しました。数量を入れて保存してください');
  }

  async function deleteEntry(id) {
    if (!await askConfirm('この記録を削除しますか？', { ok: '削除する', danger: true })) return;
    const e = state.entries.find((x) => x.id === id);
    state.entries = state.entries.filter((x) => x.id !== id);
    save();
    // 開いている日報に含まれていれば読み込み直す（未保存の変更がある場合は行だけ外す）
    if (e && sheet.date === e.date && sheet.siteId === e.siteId) {
      if (sheet.dirty) sheet.rows = sheet.rows.filter((r) => r.id !== id);
      else loadSheet(sheet.date, sheet.siteId);
    }
    render();
    toast('削除しました');
  }

  // ---------- 日報（必須） ----------
  const reportForm = $('#report-form');
  let report = { data: Core.normalizeReport({}), saved: false, fromDate: null, dirty: false };
  const TASK_STATUS_ORDER = ['done', 'partial'];

  function loadReport(date, siteId) {
    const d = siteId ? Core.draftReport(state, date, siteId) : { report: Core.normalizeReport({ date, siteId }), saved: false, fromDate: null };
    report = { data: d.report, saved: d.saved, fromDate: d.fromDate, dirty: false };
    if (!report.data.tasks.length) report.data.tasks.push(newTask());
    if (!report.data.tomorrow.length) report.data.tomorrow.push(newPlan());
    $('#rp-errors').innerHTML = '';
    renderReport();
  }

  function newTask() {
    return { id: Core.newId(), place: '', work: '', workTypeId: '', status: 'done', memo: '' };
  }

  function newPlan() {
    return { id: Core.newId(), place: '', work: '', workTypeId: '', fromTaskId: '' };
  }

  function markReportDirty() {
    report.dirty = true;
    updateReportStatus();
  }

  /** 工種（任意）の選択肢。大分類ごとにまとめる */
  function workTypeOptionsAll(selected) {
    return '<option value="">工種（任意）</option>' + state.categories.map((c) => {
      const items = Core.workTypesOfCategory(state, c.id);
      return items.length ? `<optgroup label="${escapeHtml(c.name)}">${items.map((w) =>
        `<option value="${escapeHtml(w.id)}" ${w.id === selected ? 'selected' : ''}>${escapeHtml(w.name)}</option>`).join('')}</optgroup>` : '';
    }).join('');
  }

  /** 作業の備考欄の案内文（途中のときは進み具合・できなかった理由を書いてもらう） */
  function memoPlaceholder(status) {
    return status === 'partial'
      ? 'どこまで進んだか・できなかった理由（例: 盤 2 面のうち 1 面済み／資材未着のため未着手）'
      : '備考（任意。確認済み・注意点など）';
  }

  function taskHtml(t, i) {
    const id = (f) => `task-${t.id}-${f}`;
    return `<div class="task status-${t.status || 'none'}" data-task="${escapeHtml(t.id)}">
      <div class="task-head">
        <div class="task-status" role="group" aria-label="作業 ${i + 1} の状態">
          ${TASK_STATUS_ORDER.map((st) => `<button type="button" data-status="${st}" aria-pressed="${t.status === st}">${Core.TASK_STATUS[st]}</button>`).join('')}
        </div>
        <button type="button" class="task-del danger" data-del-task aria-label="作業 ${i + 1} を削除">削除</button>
      </div>
      ${t.status ? '' : '<p class="task-hint">完了か途中を選んでください（手を付けられなかった作業も「途中」）</p>'}
      ${t.prevMemo ? `<p class="task-prev">前回: ${escapeHtml(t.prevMemo)}</p>` : ''}
      <div class="task-fields">
        <input id="${id('place')}" data-tf="place" type="text" value="${escapeHtml(t.place)}" placeholder="場所（例: 2F 西側）" aria-label="作業 ${i + 1} の場所">
        <input id="${id('work')}" data-tf="work" type="text" value="${escapeHtml(t.work)}" placeholder="作業（例: 天井内配管）" aria-label="作業 ${i + 1} の内容">
      </div>
      <input id="${id('memo')}" class="task-memo" data-tf="memo" type="text" value="${escapeHtml(t.memo)}"
        placeholder="${memoPlaceholder(t.status)}" aria-label="作業 ${i + 1} の備考">
      <select id="${id('wt')}" class="task-wt" data-tf="workTypeId" aria-label="作業 ${i + 1} の工種（任意）">${workTypeOptionsAll(t.workTypeId)}</select>
    </div>`;
  }

  function planHtml(p, i) {
    const id = (f) => `plan-${p.id}-${f}`;
    return `<div class="task plan" data-plan="${escapeHtml(p.id)}">
      <div class="task-head">
        ${p.fromTaskId || p.carried ? '<span class="pill st-partial">繰越</span>' : `<span class="muted small">予定 ${i + 1}</span>`}
        <button type="button" class="task-del danger" data-del-plan aria-label="予定 ${i + 1} を削除">削除</button>
      </div>
      <div class="task-fields">
        <input id="${id('place')}" data-pf="place" type="text" value="${escapeHtml(p.place)}" placeholder="場所" aria-label="予定 ${i + 1} の場所">
        <input id="${id('work')}" data-pf="work" type="text" value="${escapeHtml(p.work)}" placeholder="作業" aria-label="予定 ${i + 1} の内容">
      </div>
      <select id="${id('wt')}" class="task-wt" data-pf="workTypeId" aria-label="予定 ${i + 1} の工種（任意）">${workTypeOptionsAll(p.workTypeId)}</select>
    </div>`;
  }

  function crewHtml() {
    const c = report.data.crew;
    const stepper = (key, value, label) => `<div class="stepper" data-crew-stepper="${key}">
        <button type="button" data-crew-step="-1" aria-label="${label}を減らす">▼</button>
        <input type="number" min="0" max="999" step="0.5" inputmode="decimal" data-crew-people="${key}" value="${escapeHtml(value)}" aria-label="${label}">
        <button type="button" data-crew-step="1" aria-label="${label}を増やす">▲</button>
      </div>`;
    return `<div class="crew-row"><span class="crew-name">自社</span>${stepper('own', c.own, '自社の人工')}<span class="crew-unit">人工</span><span></span></div>` +
      c.subs.map((x, i) => `<div class="crew-row" data-sub="${i}">
        <input type="text" class="crew-name-input" data-sub-name="${i}" value="${escapeHtml(x.name)}" list="sub-names" placeholder="協力会社名" aria-label="協力会社 ${i + 1} の名前">
        ${stepper('sub-' + i, x.people, `協力会社 ${i + 1} の人工`)}<span class="crew-unit">人工</span>
        <button type="button" class="task-del danger" data-del-sub="${i}" aria-label="協力会社 ${i + 1} を削除">×</button>
      </div>`).join('') +
      `<p class="crew-total">合計 <strong>${fmt(Core.crewTotal(report.data))} 人工</strong><span class="muted small">（半日は 0.5）</span></p>`;
  }

  function renderReport() {
    const d = report.data;
    const site = state.sites.find((x) => x.id === d.siteId);
    const done = !!site && site.status === 'done';
    $('#rp-fields').disabled = done || !d.siteId;
    $('#rp-lock').hidden = !done;
    if (done) $('#rp-lock').textContent = `この現場は完工済みです（完工日 ${site.completedOn ? formatDate(site.completedOn) : '未設定'}）。表示のみで、入力・修正はできません。`;
    const rp = Core.findReport(state, d.date, d.siteId);
    $('#rp-origin').innerHTML = !d.siteId ? '<span class="muted">現場を選ぶと、その現場の日報を入力できます。</span>'
      : report.saved ? `<span class="pill active">保存済み</span> ${rp && rp.inputBy ? `入力 ${escapeHtml(Core.nameLookup(state).employee(rp.inputBy))}` : ''}${rp && rp.updatedAt ? `・最終更新 ${new Date(rp.updatedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}`
        : report.fromDate ? `<span class="pill kind">下書き</span> ${formatDate(report.fromDate)} の日報の「明日の予定」と途中の作業から作りました。それぞれ完了か途中を選んでください。`
          : '<span class="pill kind">新規</span> この現場の最初の日報です。';
    $('#rp-weather').innerHTML = Core.WEATHERS.map((w) =>
      `<button type="button" data-weather="${w}" aria-pressed="${d.weather === w}">${w}</button>`).join('');
    $('#rp-crew').innerHTML = crewHtml();
    $('#rp-tasks').innerHTML = d.tasks.map(taskHtml).join('');
    $('#rp-plans').innerHTML = d.tomorrow.map(planHtml).join('');
    $('#rp-notes').value = d.notes;
    renderPhotos();
    $('#sub-names').innerHTML = Core.subcontractorNames(state).map((n) => `<option value="${escapeHtml(n)}">`).join('');
    updateReportStatus();
  }

  function updateReportStatus() {
    const d = report.data;
    const tasks = d.tasks.filter((t) => t.place.trim() || t.work.trim());
    const count = (st) => tasks.filter((t) => t.status === st).length;
    $('#rp-status').innerHTML = `出面 <strong>${fmt(Core.crewTotal(d))} 人工</strong>・作業 ${tasks.length}` +
      (tasks.length ? `<span class="muted small">（完了 ${count('done')}・途中 ${count('partial')}${count('') ? `・<span class="over">未選択 ${count('')}</span>` : ''}）</span>` : '') +
      (report.dirty ? ' <span class="unsaved">未保存</span>' : '');
    $('#rp-save').disabled = !report.dirty || Core.isSiteDone(state, d.siteId) || !d.siteId;
    const crewTotal = $('#rp-crew .crew-total strong');
    if (crewTotal) crewTotal.textContent = `${fmt(Core.crewTotal(d))} 人工`;
  }

  /** 途中の作業を明日の予定へ反映し、予定の欄を描き直す（入力中の欄のフォーカスは保つ） */
  function refreshPlans() {
    const before = report.data.tomorrow.map((p) => `${p.id}:${p.place}|${p.work}|${p.workTypeId}`).join();
    Core.syncCarryOver(report.data);
    // 入力欄として置いていた空の予定は、ほかの予定が入ったら外す
    const isBlankPlan = (p) => !p.place.trim() && !p.work.trim() && !p.fromTaskId;
    if (report.data.tomorrow.some((p) => !isBlankPlan(p))) report.data.tomorrow = report.data.tomorrow.filter((p) => !isBlankPlan(p));
    if (!report.data.tomorrow.length) report.data.tomorrow.push(newPlan());
    const after = report.data.tomorrow.map((p) => `${p.id}:${p.place}|${p.work}|${p.workTypeId}`).join();
    if (before !== after) $('#rp-plans').innerHTML = report.data.tomorrow.map(planHtml).join('');
  }

  const taskOf = (el) => { const box = el.closest('[data-task]'); return box && report.data.tasks.find((t) => t.id === box.dataset.task); };
  const planOf = (el) => { const box = el.closest('[data-plan]'); return box && report.data.tomorrow.find((p) => p.id === box.dataset.plan); };

  $('#rp-weather').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-weather]');
    if (!b) return;
    report.data.weather = report.data.weather === b.dataset.weather ? '' : b.dataset.weather;
    $$('#rp-weather [data-weather]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.weather === report.data.weather)));
    markReportDirty();
  });

  // 出面
  /** 出面は人工で入力する（半日の人がいるので 0.5 刻み） */
  const CREW_STEP = 0.5;
  function setCrewPeople(key, value) {
    const v = Math.max(0, Math.min(999, Math.round((Number(value) || 0) / CREW_STEP) * CREW_STEP));
    if (key === 'own') report.data.crew.own = v;
    else report.data.crew.subs[Number(key.slice(4))].people = v;
    return v;
  }
  $('#rp-crew').addEventListener('click', (ev) => {
    const step = ev.target.closest('[data-crew-step]');
    if (step) {
      const box = step.closest('[data-crew-stepper]');
      const input = box.querySelector('input');
      input.value = setCrewPeople(box.dataset.crewStepper, (Number(input.value) || 0) + Number(step.dataset.crewStep) * CREW_STEP);
      markReportDirty();
      return;
    }
    const del = ev.target.closest('[data-del-sub]');
    if (del) {
      report.data.crew.subs.splice(Number(del.dataset.delSub), 1);
      $('#rp-crew').innerHTML = crewHtml();
      markReportDirty();
    }
  });
  $('#rp-crew').addEventListener('input', (ev) => {
    const people = ev.target.dataset.crewPeople;
    if (people) setCrewPeople(people, ev.target.value);
    const name = ev.target.dataset.subName;
    if (name !== undefined) report.data.crew.subs[Number(name)].name = ev.target.value;
    markReportDirty();
  });
  // 直接入力した人工は、入力を終えた時点で 0.5 刻みに丸めた値を表示する（例: 3.3 → 3.5）
  $('#rp-crew').addEventListener('change', (ev) => {
    const key = ev.target.dataset.crewPeople;
    if (key) ev.target.value = setCrewPeople(key, ev.target.value);
  });

  $('#rp-add-sub').addEventListener('click', () => {
    report.data.crew.subs.push({ name: '', people: 1 });
    $('#rp-crew').innerHTML = crewHtml();
    $$('#rp-crew [data-sub-name]').pop().focus();
    markReportDirty();
  });

  // 今日の作業
  $('#rp-tasks').addEventListener('click', (ev) => {
    const t = taskOf(ev.target);
    if (!t) return;
    const st = ev.target.closest('[data-status]');
    if (st) {
      t.status = st.dataset.status;
      const box = ev.target.closest('[data-task]');
      box.className = `task status-${t.status}`;
      box.querySelectorAll('[data-status]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.status === t.status)));
      const hint = box.querySelector('.task-hint');
      if (hint) hint.remove();
      const memo = box.querySelector('[data-tf=memo]');
      memo.placeholder = memoPlaceholder(t.status);
      if (t.status === 'partial' && !t.memo) memo.focus();
      refreshPlans();
      markReportDirty();
      return;
    }
    if (ev.target.closest('[data-del-task]')) {
      report.data.tasks = report.data.tasks.filter((x) => x !== t);
      if (!report.data.tasks.length) report.data.tasks.push(newTask());
      $('#rp-tasks').innerHTML = report.data.tasks.map(taskHtml).join('');
      refreshPlans();
      markReportDirty();
    }
  });
  $('#rp-tasks').addEventListener('input', (ev) => {
    const t = taskOf(ev.target);
    const f = ev.target.dataset.tf;
    if (!t || !f) return;
    t[f] = ev.target.value;
    markReportDirty();
  });
  // 場所・作業の入力を終えたら持ち越しの予定に反映（入力のたびに予定欄を描き直さない）
  $('#rp-tasks').addEventListener('change', (ev) => {
    if (!taskOf(ev.target)) return;
    const t = taskOf(ev.target);
    t[ev.target.dataset.tf] = ev.target.value;
    refreshPlans();
    markReportDirty();
  });
  $('#rp-add-task').addEventListener('click', () => {
    const t = newTask();
    report.data.tasks.push(t);
    $('#rp-tasks').insertAdjacentHTML('beforeend', taskHtml(t, report.data.tasks.length - 1));
    $(`[data-task="${t.id}"] [data-tf=place]`).focus();
    markReportDirty();
  });

  // 明日の予定
  $('#rp-plans').addEventListener('click', (ev) => {
    if (!ev.target.closest('[data-del-plan]')) return;
    const p = planOf(ev.target);
    report.data.tomorrow = report.data.tomorrow.filter((x) => x !== p);
    // 持ち越しの予定を消した場合は、その作業を「完了」扱いにはせず、予定だけ外す
    if (p && p.fromTaskId) {
      const t = report.data.tasks.find((x) => x.id === p.fromTaskId);
      if (t) t.skipCarry = true;
    }
    if (!report.data.tomorrow.length) report.data.tomorrow.push(newPlan());
    $('#rp-plans').innerHTML = report.data.tomorrow.map(planHtml).join('');
    markReportDirty();
  });
  $('#rp-plans').addEventListener('input', (ev) => {
    const p = planOf(ev.target);
    const f = ev.target.dataset.pf;
    if (!p || !f) return;
    p[f] = ev.target.value;
    // 手で直した予定は、今日の作業との連動をやめる
    p.fromTaskId = '';
    markReportDirty();
  });
  $('#rp-plans').addEventListener('change', (ev) => {
    const p = planOf(ev.target);
    if (p && ev.target.dataset.pf === 'workTypeId') { p.workTypeId = ev.target.value; markReportDirty(); }
  });
  $('#rp-add-plan').addEventListener('click', () => {
    const p = newPlan();
    report.data.tomorrow.push(p);
    $('#rp-plans').insertAdjacentHTML('beforeend', planHtml(p, report.data.tomorrow.length - 1));
    $(`[data-plan="${p.id}"] [data-pf=place]`).focus();
    markReportDirty();
  });

  $('#rp-notes').addEventListener('input', (ev) => { report.data.notes = ev.target.value; markReportDirty(); });

  // 写真（任意）。端末の容量を圧迫しないよう、長辺 1280px の JPEG に縮小して保存する
  const MAX_PHOTOS = 4;
  function resizeImage(file, maxSide = 1280, quality = 0.7) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした')); };
      img.src = url;
    });
  }

  function renderPhotos() {
    $('#rp-photos').innerHTML = report.data.photos.map((ph, i) => `<figure class="photo">
        <img src="${escapeHtml(ph.dataUrl)}" alt="${escapeHtml(ph.caption || `写真 ${i + 1}`)}">
        <input type="text" data-photo-caption="${i}" value="${escapeHtml(ph.caption || '')}" placeholder="説明（例: 2F 西側 配管の終わり位置）" aria-label="写真 ${i + 1} の説明">
        <button type="button" class="task-del danger" data-del-photo="${i}" aria-label="写真 ${i + 1} を削除">×</button>
      </figure>`).join('');
  }

  $('#rp-photo-input').addEventListener('change', async (ev) => {
    const files = [...ev.target.files];
    ev.target.value = '';
    for (const f of files) {
      if (report.data.photos.length >= MAX_PHOTOS) { toast(`写真は 1 日 ${MAX_PHOTOS} 枚までです`); break; }
      try {
        report.data.photos.push({ id: Core.newId(), dataUrl: await resizeImage(f), caption: '' });
      } catch (e) {
        toast(e.message);
      }
    }
    renderPhotos();
    markReportDirty();
  });
  $('#rp-photos').addEventListener('input', (ev) => {
    const i = ev.target.dataset.photoCaption;
    if (i === undefined) return;
    report.data.photos[Number(i)].caption = ev.target.value;
    markReportDirty();
  });
  $('#rp-photos').addEventListener('click', (ev) => {
    const del = ev.target.closest('[data-del-photo]');
    if (del) {
      report.data.photos.splice(Number(del.dataset.delPhoto), 1);
      renderPhotos();
      markReportDirty();
      return;
    }
    const img = ev.target.closest('img');
    if (img) img.closest('figure').classList.toggle('expanded');
  });

  reportForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const d = report.data;
    d.inputBy = form.elements.inputBy.value || d.inputBy;
    const res = Core.saveReport(state, d, Date.now(), { requireInputBy: state.employees.length > 0 });
    $('#rp-errors').innerHTML = res.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('');
    if (res.errors.length) {
      $('#rp-errors').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    state.settings.lastSiteId = d.siteId;
    save();
    loadReport(d.date, d.siteId);
    renderDaySites();
    renderCrewBanner(sheet.rows.filter((r) => !Core.isEmptyRow(r)).reduce((sum, r) => sum + rowManHours(r), 0));
    toast('日報を保存しました');
  });

  // ---------- 現場（引き継ぎ） ----------
  let historyLimit = 5;
  let editingNote = false;

  function contextSite() {
    return state.sites.find((x) => x.id === sheet.siteId) || null;
  }

  function reportHtml(r, names) {
    const tasks = r.tasks.map((t) => `<li class="status-${t.status}">
        <span class="pill st-${t.status}">${Core.TASK_STATUS[t.status]}</span>
        ${escapeHtml([t.place, t.work].filter(Boolean).join(' '))}${t.memo ? `<span class="muted"> … ${escapeHtml(t.memo)}</span>` : ''}</li>`).join('');
    const plans = r.tomorrow.map((p) => `<li>${escapeHtml([p.place, p.work].filter(Boolean).join(' '))}</li>`).join('');
    const subs = r.crew.subs.map((x) => `${escapeHtml(x.name)} ${fmt(x.people)}人工`).join('、');
    return `<details class="report-card">
      <summary>
        <strong>${formatDate(r.date)}</strong>
        ${r.weather ? `<span class="pill kind">${escapeHtml(r.weather)}</span>` : ''}
        <span class="muted">出面 ${fmt(Core.crewTotal(r))}人工・作業 ${r.tasks.length}${r.photos.length ? `・写真 ${r.photos.length}` : ''}</span>
        ${r.inputBy ? `<span class="muted small">入力 ${escapeHtml(names.employee(r.inputBy))}</span>` : ''}
      </summary>
      <div class="report-body">
        <p class="small">出面: 自社 ${fmt(r.crew.own)}人工${subs ? `、${subs}` : ''}</p>
        <h3>作業</h3><ul class="todo">${tasks || '<li class="muted">なし</li>'}</ul>
        <h3>翌日の予定</h3><ul class="todo">${plans || '<li class="muted">なし</li>'}</ul>
        ${r.notes ? `<h3>特記事項</h3><p class="pre">${escapeHtml(r.notes)}</p>` : ''}
        ${r.photos.length ? `<div class="photos">${r.photos.map((ph) => `<figure class="photo"><img src="${escapeHtml(ph.dataUrl)}" alt="${escapeHtml(ph.caption || '現場写真')}">${ph.caption ? `<figcaption>${escapeHtml(ph.caption)}</figcaption>` : ''}</figure>`).join('')}</div>` : ''}
      </div>
    </details>`;
  }

  function renderSiteView() {
    const site = contextSite();
    const blocks = $$('#tab-site .sv-block');
    if (!site) {
      $('#sv-head').innerHTML = '<p class="muted">上の「現場」を選んでください。</p>';
      blocks.forEach((b) => { b.hidden = true; });
      return;
    }
    blocks.forEach((b) => { b.hidden = false; });
    const names = Core.nameLookup(state);
    const kind = state.siteKinds.find((k) => k.id === site.kindId);
    $('#sv-head').innerHTML = `<h2 class="sv-title">${escapeHtml(Core.siteLabel(site))}</h2>
      <p>${site.status === 'done' ? '<span class="pill done">完工</span>' : '<span class="pill active">稼働中</span>'}
      ${kind ? `<span class="pill kind">${escapeHtml(kind.name)}</span>` : ''}</p>`;

    // 現場ノート
    const nb = site.notebook || {};
    const filled = Core.NOTEBOOK_FIELDS.filter(([k]) => nb[k]);
    $('#sv-note').innerHTML = filled.length
      ? filled.map(([k, label]) => `<dt>${escapeHtml(label)}</dt><dd class="pre">${escapeHtml(nb[k])}</dd>`).join('') +
        (nb.updatedAt ? `<dt class="muted small">最終更新</dt><dd class="muted small">${formatDateLong(nb.updatedAt.slice(0, 10))}${nb.updatedBy ? `（${escapeHtml(names.employee(nb.updatedBy))}）` : ''}</dd>` : '')
      : '<p class="muted">まだ書かれていません。「編集」から、代わりの人が最初に知りたいこと（連絡先・ルール・鍵や資材の場所など）を書いてください。</p>';
    $('#sv-note').hidden = editingNote;
    $('#sv-note-form').hidden = !editingNote;
    $('#sv-edit-note').hidden = editingNote || site.status === 'done';

    // 今日やること（保存済みの日報、なければ下書き＝前日の予定と持ち越し）
    const d = Core.draftReport(state, sheet.date, site.id);
    const isToday = sheet.date === toISODate(new Date());
    $('#sv-today-title').textContent = `${isToday ? '今日' : formatDate(sheet.date)}やること`;
    const todo = d.report.tasks.filter((t) => t.place || t.work);
    $('#sv-today-src').textContent = d.saved ? 'この日の日報（保存済み）の作業です。'
      : d.fromDate ? `${formatDate(d.fromDate)} の日報の「明日の予定」と、終わっていない作業です。` : 'まだ日報がありません。';
    $('#sv-today').innerHTML = todo.length ? todo.map((t) => `<li class="status-${t.status}">
        ${d.saved ? `<span class="pill st-${t.status}">${Core.TASK_STATUS[t.status]}</span>` : '<span class="todo-box" aria-hidden="true"></span>'}
        <span>${escapeHtml([t.place, t.work].filter(Boolean).join(' '))}${t.memo ? `<span class="muted"> … ${escapeHtml(t.memo)}</span>` : ''}${!d.saved && t.prevMemo ? `<span class="muted"> … 前回: ${escapeHtml(t.prevMemo)}</span>` : ''}</span>
      </li>`).join('') : '<li class="muted">なし</li>';

    // 近日の予定
    const events = Core.upcomingEvents(state, site.id, sheet.date);
    $('#sv-events').innerHTML = events.length ? events.map((e) => `<li>
        <span class="event-date">${formatDate(e.date)}</span><span>${escapeHtml(e.title)}</span>
        <button type="button" class="task-del danger" data-del-event="${escapeHtml(e.id)}" aria-label="予定「${escapeHtml(e.title)}」を削除">×</button>
      </li>`).join('') : '<li class="muted">登録された予定はありません</li>';
    $('#sv-event-form').hidden = site.status === 'done';

    // これまでの日報
    const reports = Core.reportsOfSite(state, site.id).filter((r) => r.date <= sheet.date);
    $('#sv-reports').innerHTML = reports.length ? reports.slice(0, historyLimit).map((r) => reportHtml(r, names)).join('') : '<p class="muted">日報はまだありません</p>';
    const first = $('#sv-reports details');
    if (first) first.open = true;
    $('#sv-more').hidden = reports.length <= historyLimit;
  }

  function openNoteEditor() {
    const site = contextSite();
    if (!site) return;
    const nb = site.notebook || {};
    $('#sv-note-form').innerHTML = Core.NOTEBOOK_FIELDS.map(([k, label]) => `<div class="field">
        <label for="nb-${k}">${escapeHtml(label)}</label>
        <textarea id="nb-${k}" name="${k}" rows="2">${escapeHtml(nb[k] || '')}</textarea>
      </div>`).join('') +
      `<div class="actions"><button type="submit" class="primary">現場ノートを保存</button><button type="button" id="sv-note-cancel">やめる</button></div>`;
    editingNote = true;
    renderSiteView();
    $('#sv-note-form textarea').focus();
  }

  $('#sv-edit-note').addEventListener('click', openNoteEditor);
  $('#sv-note-form').addEventListener('click', (ev) => {
    if (!ev.target.closest('#sv-note-cancel')) return;
    editingNote = false;
    renderSiteView();
  });
  $('#sv-note-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const site = contextSite();
    if (!site) return;
    const nb = {};
    for (const [k] of Core.NOTEBOOK_FIELDS) nb[k] = ev.target.elements[k].value.trim();
    nb.updatedAt = new Date().toISOString();
    nb.updatedBy = form.elements.inputBy.value || '';
    site.notebook = nb;
    save();
    editingNote = false;
    renderSiteView();
    toast('現場ノートを保存しました');
  });
  $('#sv-event-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const site = contextSite();
    const f = ev.target.elements;
    if (!site || !f.date.value || !f.title.value.trim()) return;
    state.events.push({ id: Core.newId(), siteId: site.id, date: f.date.value, title: f.title.value.trim() });
    save();
    ev.target.reset();
    renderSiteView();
    toast('予定を追加しました');
  });
  $('#sv-events').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-del-event]');
    if (!b) return;
    const e = state.events.find((x) => x.id === b.dataset.delEvent);
    if (!e || !await askConfirm(`予定「${e.title}」を削除しますか？`, { ok: '削除する', danger: true })) return;
    state.events = state.events.filter((x) => x !== e);
    save();
    renderSiteView();
  });
  $('#sv-more').addEventListener('click', () => { historyLimit += 10; renderSiteView(); });

  // ---------- 集計: 日報の提出状況 ----------
  function renderSubmission() {
    const today = new Date();
    const dates = [];
    for (let i = 6; i >= 0; i--) { const d = new Date(today); d.setDate(d.getDate() - i); dates.push(toISODate(d)); }
    const sites = state.sites.filter((x) => x.status !== 'done');
    if (!sites.length) { $('#summary-submission').innerHTML = '<p class="muted">稼働中の現場がありません</p>'; return; }
    const sub = Core.reportSubmission(state, dates);
    const holiday = (iso) => [0, 6].includes(new Date(iso + 'T00:00:00').getDay());
    $('#summary-submission').innerHTML = `<table class="pivot submission">
      <thead><tr><th>現場</th>${dates.map((d) => `<th class="num ${holiday(d) ? 'holiday' : ''}">${formatDate(d)}</th>`).join('')}</tr></thead>
      <tbody>${sites.map((x) => `<tr><th>${escapeHtml(Core.siteLabel(x))}</th>${dates.map((d) => {
        const ok = sub.get(x.id) && sub.get(x.id).has(d);
        return `<td class="num ${holiday(d) ? 'holiday' : ''}"><button type="button" class="sub-cell ${ok ? 'ok' : 'ng'}" data-open-report="${escapeHtml(x.id)}|${d}"
          aria-label="${escapeHtml(x.name)} ${formatDate(d)} ${ok ? '提出済み' : '未提出'}">${ok ? '✓' : holiday(d) ? '' : '未'}</button></td>`;
      }).join('')}</tr>`).join('')}</tbody>
    </table>`;
  }

  $('#summary-submission').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-open-report]');
    if (!b || !await confirmDiscard()) return;
    const [siteId, date] = b.dataset.openReport.split('|');
    loadContext(date, siteId);
    showTab('report');
  });

  // ---------- 記録の表示 ----------
  function entryCards(entries) {
    if (!entries.length) return '<p class="muted">記録はありません</p>';
    const names = Core.nameLookup(state);
    return '<ul class="cards">' + entries.map((e) => {
      const mh = Core.entryManHours(e);
      const time = e.start && e.end ? `${e.start}〜${e.end}（休憩${e.breakMinutes || 0}分）` : '';
      return `<li class="card">
        <div class="card-main">
          <div class="card-title"><span class="tag-cat">${escapeHtml(names.categoryOfWorkType(e.workTypeId))} ›</span><span class="tag">${escapeHtml(names.workType(e.workTypeId))}</span>${e.hard ? '<span class="pill hard">難</span> ' : ' '}${escapeHtml(names.site(e.siteId))}</div>
          <div class="card-sub">${formatDate(e.date)} ${e.people}人 × ${fmt(e.hours)}h ${escapeHtml(time)}${e.inputBy ? `・入力 ${escapeHtml(names.employee(e.inputBy))}` : ''}</div>
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
    if (act === 'edit') openEntryInSheet(id);
    else if (act === 'copy') copyEntryToToday(id);
    else if (act === 'del') deleteEntry(id);
  });

  function sortedDesc(entries) {
    return [...entries].sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
  }

  function readFilters(root) {
    const get = (n) => { const el = $(`[name=${n}]`, root); return el ? el.value : ''; };
    return { from: get('from'), to: get('to'), siteId: get('siteId'), categoryId: get('categoryId'), workTypeId: get('workTypeId') };
  }

  /** 集計の条件で絞り込んだ工数（新しい順）。明細と CSV 出力に使う */
  function listFiltered() {
    return sortedDesc(Core.filterEntries(state.entries, readFilters($('#summary-filters')), state.workTypes));
  }

  /** 工数の明細（多いと重くなるので最新 50 件まで表示。CSV は全件） */
  function renderDetails() {
    const list = listFiltered();
    const total = Core.round2(list.reduce((sum, e) => sum + Core.entryManHours(e), 0));
    $('#list-count').textContent = `${list.length} 件 / 延べ ${fmt(total)} h（${fmt(Core.round2(total / perDay()))} 人工）` +
      (list.length > 50 ? '・最新 50 件を表示' : '');
    $('#entry-list').innerHTML = entryCards(list.slice(0, 50));
  }

  // ---------- 累計（現場ごと・任意の時点／完工時） ----------
  function formatDateLong(iso) {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-').map(Number);
    return `${y}/${m}/${d}`;
  }

  function lastDayOfPrevMonth() {
    const now = new Date();
    return toISODate(new Date(now.getFullYear(), now.getMonth(), 0));
  }

  /** 完工済みなら完工日、稼働中なら今日 */
  function defaultAsOf(site) {
    return site && site.status === 'done' && site.completedOn ? site.completedOn : toISODate(new Date());
  }

  let cumulSiteId = '';

  function renderCumul() {
    const sel = $('#c-site');
    if (!sel.value) sel.value = sheet.siteId || defaultSiteId() || (state.sites[0] || {}).id || '';
    const site = state.sites.find((x) => x.id === sel.value);
    const clear = (msg) => {
      $('#c-status').textContent = msg;
      $('#c-totals').innerHTML = '';
      $('#c-table').innerHTML = '';
    };
    if (!site) { clear('現場がありません'); return; }
    // 現場を切り替えたら時点を既定値（完工日または今日）に戻す
    if (cumulSiteId !== site.id || !$('#c-asof').value) {
      $('#c-asof').value = defaultAsOf(site);
      cumulSiteId = site.id;
    }
    const asOf = $('#c-asof').value;
    const done = site.status === 'done';
    $('#c-quick [data-asof=done]').disabled = !done;
    const range = Core.siteDateRange(state, site.id);
    const entries = state.entries.filter((e) => e.siteId === site.id && e.date <= asOf);

    const final = done && asOf === site.completedOn;
    $('#c-status').innerHTML = `${done ? `<span class="pill done">完工 ${escapeHtml(formatDateLong(site.completedOn))}</span>` : '<span class="pill active">稼働中</span>'}
      ${final ? '<strong>完工時の累計（確定）</strong>' : `<strong>${escapeHtml(formatDateLong(asOf))} 時点の累計</strong>`}
      <span class="muted">（初回記録 ${escapeHtml(formatDateLong(range.first))}〜）</span>`;
    if (!entries.length) {
      $('#c-totals').innerHTML = '';
      $('#c-table').innerHTML = '<p class="muted">この時点までの記録はありません</p>';
      return;
    }

    const total = Core.round2(entries.reduce((s2, e) => s2 + Core.entryManHours(e), 0));
    $('#c-totals').innerHTML = `
      <div class="stat"><span>延べ工数</span><strong>${fmt(total)}<small> h</small></strong></div>
      <div class="stat"><span>人工</span><strong>${fmt(Core.round2(total / perDay()))}</strong></div>
      <div class="stat"><span>稼働日数</span><strong>${new Set(entries.map((e) => e.date)).size}<small> 日</small></strong></div>
      <div class="stat"><span>工種数</span><strong>${new Set(entries.map((e) => e.workTypeId)).size}</strong></div>`;

    const rows = Core.productivity(entries, state.workTypes, perDay(), { bySite: true, categories: state.categories });
    const names = Core.nameLookup(state);
    const dash = '<span class="muted">—</span>';
    // 大分類ごとに小計行を入れる
    let html = '';
    let currentCat = null;
    const catTotals = new Map();
    for (const r of rows) catTotals.set(r.categoryId, Core.round2((catTotals.get(r.categoryId) || 0) + r.manDays));
    for (const r of rows) {
      if (r.categoryId !== currentCat) {
        currentCat = r.categoryId;
        html += `<tr class="cat-row"><th>${escapeHtml(names.category(r.categoryId))}</th>
          <td></td><td class="num">${fmt(catTotals.get(r.categoryId))}</td><td colspan="3"></td></tr>`;
      }
      const unit = escapeHtml(r.unit);
      html += `<tr>
        <td class="wt-cell">${escapeHtml(names.workType(r.workTypeId))}</td>
        <td class="num">${r.quantity > 0 ? `${fmt(r.quantity)} ${unit}` : '<span class="muted">未入力</span>'}</td>
        <td class="num">${fmt(r.manDays)}</td>
        <td class="num rate-val">${r.rate === null ? dash : `${fmt(r.rate, 3)}<br><small>人工/${unit || '単位'}</small>`}</td>
        <td class="num">${r.output === null ? dash : `${fmt(r.output)} ${unit}`}</td>
        <td class="num">${r.days}日</td>
      </tr>`;
    }
    $('#c-table').innerHTML = `<table class="rates cumul">
      <thead><tr>
        <th>工種</th><th class="num">数量</th><th class="num">人工</th>
        <th class="num">実績歩掛り<br><small>人工/単位</small></th>
        <th class="num">1人工あたり<br><small>施工量</small></th>
        <th class="num">稼働日</th>
      </tr></thead>
      <tbody>${html}</tbody>
      <tfoot><tr><th>合計</th><td></td><td class="num">${fmt(Core.round2(total / perDay()))}</td><td colspan="3"></td></tr></tfoot>
    </table>`;
  }

  $('#c-site').addEventListener('change', renderCumul);
  $('#c-asof').addEventListener('change', renderCumul);
  $('#c-quick').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-asof]');
    if (!b) return;
    const site = state.sites.find((x) => x.id === $('#c-site').value);
    const kind = b.dataset.asof;
    $('#c-asof').value = kind === 'lastmonth' ? lastDayOfPrevMonth()
      : kind === 'done' && site && site.completedOn ? site.completedOn
        : toISODate(new Date());
    renderCumul();
  });

  // ---------- 集計 ----------
  let monthUnit = 'md'; // md: 人工 / h: 時間

  /** 月 × 工種（大分類ごとに小計）。期間・現場・大分類の絞り込みに従う */
  function renderMonthly(entries) {
    const m = Core.monthlyMatrix(entries, (e) => e.workTypeId);
    if (!m.months.length) {
      $('#summary-monthly').innerHTML = '<p class="muted">データがありません</p>';
      return;
    }
    const names = Core.nameLookup(state);
    const conv = (h) => (monthUnit === 'md' ? Core.round2(h / perDay()) : h);
    const cell = (h, cls = '') => `<td class="num ${cls}">${h ? fmt(conv(h)) : ''}</td>`;
    const monthLabel = (ym) => { const [y, mo] = ym.split('-'); return `${y}/${Number(mo)}`; };
    // 大分類・小分類の登録順（未登録の工種は最後）
    const wtOrder = state.workTypes.filter((w) => m.rows.has(w.id));
    const unknown = [...m.rows.keys()].filter((id) => !state.workTypes.some((w) => w.id === id));
    const groups = state.categories.map((c) => ({ name: c.name, ids: wtOrder.filter((w) => w.categoryId === c.id).map((w) => w.id) }))
      .filter((g) => g.ids.length);
    if (unknown.length) groups.push({ name: '(削除済み)', ids: unknown });
    let body = '';
    for (const g of groups) {
      const sub = {};
      let subTotal = 0;
      for (const id of g.ids) {
        for (const mo of m.months) sub[mo] = (sub[mo] || 0) + (m.rows.get(id)[mo] || 0);
        subTotal += m.totals.get(id);
      }
      body += `<tr class="cat-row"><th>${escapeHtml(g.name)}</th>${m.months.map((mo) => cell(sub[mo])).join('')}${cell(subTotal, 'strong')}</tr>`;
      body += g.ids.map((id) => `<tr><th class="wt-cell">${escapeHtml(names.workType(id))}</th>
        ${m.months.map((mo) => cell(m.rows.get(id)[mo])).join('')}${cell(m.totals.get(id), 'strong')}</tr>`).join('');
    }
    $('#summary-monthly').innerHTML = `<table class="pivot monthly">
      <thead><tr><th>工種（${monthUnit === 'md' ? '人工' : '時間 h'}）</th>${m.months.map((mo) => `<th class="num">${monthLabel(mo)}</th>`).join('')}<th class="num">合計</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><th>合計</th>${m.months.map((mo) => cell(m.monthTotals[mo])).join('')}${cell(m.total, 'strong')}</tr></tfoot>
    </table>`;
  }

  $$('[data-month-unit]').forEach((b) => b.addEventListener('click', () => {
    monthUnit = b.dataset.monthUnit;
    $$('[data-month-unit]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderSummary();
  }));

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

    renderSubmission();
    renderMonthly(entries);
    renderRates(entries);
    renderDetails();

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
    const dash = '<span class="muted">—</span>';
    // スマホで横スクロールしなくても要点が見えるよう、工種名の次に実績歩掛りと比較を置く
    $('#summary-rates').innerHTML = `<table class="rates">
      <thead><tr>
        <th>${bySite ? '現場 / ' : ''}工種</th>
        <th class="num">実績歩掛り<br><small>人工/単位</small></th>
        <th class="num">数量</th><th class="num">人工</th>
        <th class="num">1人工あたり<br><small>施工量</small></th>
        <th class="num">稼働日<br><small>(数量記録日)</small></th>
      </tr></thead>
      <tbody>${rows.map((r) => {
        const unit = escapeHtml(r.unit);
        return `<tr>
          <td class="wt-cell">
            ${bySite ? `<div class="site-name">${escapeHtml(names.site(r.siteId))}</div>` : ''}
            <div class="cat-cell">${escapeHtml(names.category(r.categoryId))}</div>
            <div>${escapeHtml(names.workType(r.workTypeId))}</div>
          </td>
          <td class="num rate-val">${r.rate === null ? dash : `${fmt(r.rate, 3)}<br><small>人工/${unit || '単位'}</small>`}</td>
          <td class="num">${r.quantity > 0 ? `${fmt(r.quantity)} ${unit}` : '<span class="muted">未入力</span>'}</td>
          <td class="num">${fmt(r.manDays)}</td>
          <td class="num">${r.output === null ? dash : `${fmt(r.output)} ${unit}`}</td>
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
    if (key === 'employees') return state.entries.filter((e) => e.inputBy === id).length;
    if (key === 'siteKinds') return state.sites.filter((x) => x.kindId === id).length;
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

  /** 現場の行。作番・現場名は kintone 側の値なので表示のみ、状態・完工日・元請マスタを設定する */
  function siteRow(x) {
    const used = usageCount('sites', x.id);
    const range = Core.siteDateRange(state, x.id);
    const done = x.status === 'done';
    const rid = (f) => `site-${x.id}-${f}`;
    return `<li class="site-row ${done ? 'is-done' : ''}">
      <div class="site-main">
        <span class="master-name"><strong>${escapeHtml(x.code || '（作番なし）')}</strong> ${escapeHtml(x.name)}
          ${done ? '<span class="pill done">完工</span>' : '<span class="pill active">稼働中</span>'}
          ${kindName(x) ? `<span class="pill kind">${escapeHtml(kindName(x))}</span>` : ''}</span>
        <span class="rm-meta">${used ? `記録 ${used} 件・${formatDate(range.first)}〜${formatDate(range.last)}` : '記録なし'}</span>
      </div>
      <div class="site-fields">
        <label for="${rid('status')}">状態
          <select id="${rid('status')}" data-site-field="status" data-id="${x.id}">
            <option value="active" ${done ? '' : 'selected'}>稼働中</option>
            <option value="done" ${done ? 'selected' : ''}>完工</option>
          </select>
        </label>
        <label for="${rid('done')}">完工日
          <input id="${rid('done')}" type="date" data-site-field="completedOn" data-id="${x.id}" value="${escapeHtml(x.completedOn || '')}" ${done ? '' : 'disabled'}>
        </label>
        <label for="${rid('kind')}">工事区分
          <select id="${rid('kind')}" data-site-field="kindId" data-id="${x.id}">
            <option value="">未設定</option>
            ${state.siteKinds.map((k) => `<option value="${escapeHtml(k.id)}" ${k.id === x.kindId ? 'selected' : ''}>${escapeHtml(k.name)}</option>`).join('')}
          </select>
        </label>
        <button type="button" data-master-act="del" data-key="sites" data-id="${x.id}" class="danger mock-only" title="モック用。本番では kintone の現場アプリで管理">削除</button>
      </div>
    </li>`;
  }

  function kindName(site) {
    const k = state.siteKinds.find((x) => x.id === site.kindId);
    return k ? k.name : '';
  }

  function employeeRow(x) {
    const used = usageCount('employees', x.id);
    return `<li>
      <span class="master-name"><strong>${escapeHtml(x.code || '')}</strong> ${escapeHtml(x.name)}${used ? ` <small class="muted">入力 ${used}件</small>` : ''}</span>
      <span class="master-actions">
        <button type="button" data-master-act="del" data-key="employees" data-id="${x.id}" class="danger mock-only" title="モック用。本番では kintone の社員アプリで管理">削除</button>
      </span>
    </li>`;
  }

  function renderMaster() {
    // 稼働中を上に、それぞれ作番順
    const sites = [...state.sites].sort((a, b) =>
      (a.status === 'done') - (b.status === 'done') || String(a.code).localeCompare(String(b.code)));
    $('#master-sites').innerHTML = sites.length ? sites.map(siteRow).join('') : '<li class="muted">未登録</li>';
    $('#master-siteKinds').innerHTML = simpleList('siteKinds');
    $('#master-employees').innerHTML = state.employees.length
      ? state.employees.map(employeeRow).join('') : '<li class="muted">未登録</li>';
    $('#master-categories').innerHTML = simpleList('categories',
      (c) => ` <small class="muted">小分類 ${Core.workTypesOfCategory(state, c.id).length}</small>`);
    $('#master-workTypes').innerHTML = state.categories.map((c) => {
      const items = Core.workTypesOfCategory(state, c.id);
      const open = openGroups.has(c.id) ? 'open' : '';
      return `<details class="wt-group" data-cat="${escapeHtml(c.id)}" ${open}>
        <summary>${escapeHtml(c.name)} <small class="muted">小分類 ${items.length}</small></summary>
        <ul class="master-list">${items.length ? items.map(workTypeRow).join('') : '<li class="muted">小分類なし</li>'}</ul>
      </details>`;
    }).join('') || '<p class="muted">先に大分類を登録してください</p>';
    $('#s-perday').value = perDay();
  }

  $$('.add-form[data-master]').forEach((f) => f.addEventListener('submit', (ev) => {
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
        unit: f.elements.unit.value.trim() || Core.defaultUnit(name),
      });
      f.elements.name.value = '';
      f.elements.unit.value = '';
    } else if (key === 'sites' || key === 'employees') {
      // モック用の追加（本番では kintone の現場アプリ・社員アプリから取得する）
      const code = f.elements.code.value.trim();
      if (state[key].some((x) => x.code === code)) {
        toast(`同じ${key === 'sites' ? '作番' : '管理番号'}がすでに登録されています`);
        return;
      }
      const item = { id: Core.newId(), code, name };
      state[key].push(key === 'sites' ? Core.normalizeSite(item) : item);
      f.reset();
    } else {
      if (state[key].some((x) => x.name === name)) { toast('同じ名前がすでに登録されています'); return; }
      state[key].push({ id: Core.newId(), name });
      f.reset();
    }
    save();
    render();
  }));

  document.addEventListener('click', async (ev) => {
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
      const name = await askText('新しい名前', list[i].name);
      if (!name) return;
      list[i].name = name;
    } else if (masterAct === 'del') {
      if (key === 'categories' && Core.workTypesOfCategory(state, id).length) {
        await showAlert(`「${list[i].name}」には小分類があります。先に小分類を削除するか、別の大分類へ移動してください。`);
        return;
      }
      const used = usageCount(key, id);
      const msg = !used ? `「${list[i].name}」を削除しますか？`
        : key === 'siteKinds' ? `「${list[i].name}」は ${used} 件の現場で使われています。削除するとそれらの現場の工事区分は未設定になります。削除しますか？`
          : `「${list[i].name}」は ${used} 件の記録で使われています。削除すると記録の表示が「(削除済み)」になります。削除しますか？`;
      if (!await askConfirm(msg, { ok: '削除する', danger: true })) return;
      list.splice(i, 1);
      if (key === 'siteKinds') state.sites.forEach((x) => { if (x.kindId === id) x.kindId = ''; });
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
    if (field === 'categoryId') {
      wt.categoryId = input.value;
      // 移動先の大分類の末尾に並べる
      state.workTypes = state.workTypes.filter((w) => w !== wt).concat(wt);
    } else {
      wt.unit = input.value.trim();
    }
    save();
    render();
    toast('保存しました');
  });

  document.addEventListener('change', (ev) => {
    const el = ev.target.closest('[data-site-field]');
    if (!el) return;
    const site = state.sites.find((x) => x.id === el.dataset.id);
    if (!site) return;
    const field = el.dataset.siteField;
    if (field === 'status') {
      site.status = el.value;
      // 完工日の初期値は最後の記録日（なければ今日）
      if (site.status === 'done' && !site.completedOn) {
        site.completedOn = Core.siteDateRange(state, site.id).last || toISODate(new Date());
      }
      if (site.status === 'active') site.completedOn = '';
    } else {
      site[field] = el.value;
    }
    save();
    render();
    toast(field === 'status'
      ? (site.status === 'done' ? `完工にしました（完工日 ${formatDate(site.completedOn)}）` : '稼働中に戻しました')
      : '保存しました');
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

  // ---------- 自社の実績歩掛り ----------
  function companyRateOptions() {
    return {
      doneOnly: $('#cr-target').value !== 'all',
      kindId: $('#cr-kind').value,
      difficulty: $('#cr-diff').value,
      from: $('#cr-from').value,
      to: $('#cr-to').value,
    };
  }

  /** 画面と CSV に出す条件の説明 */
  function companyRateCondition(o) {
    const kind = state.siteKinds.find((k) => k.id === o.kindId);
    return [
      o.doneOnly ? '完工した現場のみ' : '稼働中の現場を含む',
      `工事区分: ${kind ? kind.name : 'すべて'}`,
      `難度: ${{ all: 'すべて', normal: '標準のみ', hard: '難のみ' }[o.difficulty]}`,
      (o.from || o.to) ? `記録日: ${o.from ? formatDateLong(o.from) : '最初'}〜${o.to ? formatDateLong(o.to) : '最新'}` : '',
    ].filter(Boolean).join(' / ');
  }

  function renderCompanyRates() {
    const o = companyRateOptions();
    const rows = Core.companyRates(state, o, perDay());
    const names = Core.nameLookup(state);
    const siteMap = new Map(state.sites.map((x) => [x.id, x]));
    const targetSites = new Set(state.entries.filter((e) => {
      const site = siteMap.get(e.siteId);
      return site && (!o.doneOnly || site.status === 'done') && (!o.kindId || site.kindId === o.kindId);
    }).map((e) => e.siteId));
    $('#cr-summary').innerHTML = `<strong>${escapeHtml(companyRateCondition(o))}</strong>
      <span class="muted">対象 ${targetSites.size} 現場・${rows.filter((r) => r.rate !== null).length} 工種</span>`;
    if (!rows.length) {
      $('#cr-table').innerHTML = `<p class="muted">${o.doneOnly ? '完工した現場の記録がありません。「対象の現場」を「稼働中の現場も含める」にすると途中の値を確認できます。' : '記録がありません'}</p>`;
      return;
    }
    const dash = '<span class="muted">—</span>';
    let body = '';
    let currentCat = null;
    for (const r of rows) {
      if (r.categoryId !== currentCat) {
        currentCat = r.categoryId;
        body += `<tr class="cat-row"><th colspan="8">${escapeHtml(names.category(r.categoryId))}</th></tr>`;
      }
      const unit = escapeHtml(r.unit);
      const few = r.rate !== null && r.sites <= 2;
      body += `<tr>
        <td class="wt-cell">${escapeHtml(names.workType(r.workTypeId))}${few ? ' <span class="pill few">参考</span>' : ''}</td>
        <td class="num rate-val">${r.rate === null ? dash : `${fmt(r.rate, 3)}<br><small>人工/${unit || '単位'}</small>`}</td>
        <td class="num">${r.sites}${r.sitesNoQuantity ? `<br><small class="muted">数量なし ${r.sitesNoQuantity}</small>` : ''}</td>
        <td class="num">${r.siteMin === null ? dash : r.siteMin === r.siteMax ? fmt(r.siteMin, 3) : `${fmt(r.siteMin, 3)}〜<br>${fmt(r.siteMax, 3)}`}</td>
        <td class="num">${r.output === null ? dash : `${fmt(r.output)} ${unit}`}</td>
        <td class="num">${r.quantity > 0 ? `${fmt(r.quantity)} ${unit}` : dash}</td>
        <td class="num">${fmt(r.manDays)}</td>
        <td class="num">${r.hardShare ? `${fmt(r.hardShare, 0)}%` : ''}</td>
      </tr>`;
    }
    $('#cr-table').innerHTML = `<table class="rates company">
      <thead><tr>
        <th>工種</th>
        <th class="num">実績歩掛り</th>
        <th class="num">現場数</th>
        <th class="num">現場ごとの<br>最小〜最大</th>
        <th class="num">1人工あたり<br>施工量</th>
        <th class="num">数量合計</th>
        <th class="num">人工合計</th>
        <th class="num">難の<br>割合</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>`;
  }

  $$('#cr-filters select, #cr-filters input').forEach((el) => el.addEventListener('change', renderCompanyRates));
  $('#cr-export').addEventListener('click', () => {
    const o = companyRateOptions();
    const rows = Core.companyRates(state, o, perDay()).filter((r) => r.rate !== null);
    exportCsv('自社の実績歩掛りの CSV', `自社実績歩掛り_${stamp()}.csv`, Core.companyRatesToCsv(state, rows, companyRateCondition(o)));
  });

  // ---------- 入出力 ----------
  const stamp = () => toISODate(new Date()).replace(/-/g, '');

  $('#backup-json').addEventListener('click', () => {
    const json = JSON.stringify(state, null, 2);
    showExport({ title: 'バックアップ', filename: `現場日報_バックアップ_${stamp()}.json`, content: json, type: 'application/json', copyText: json });
  });

  $('#restore-json').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await readFile(file));
      if (!await askConfirm('現在のデータをバックアップの内容で置き換えます。よろしいですか？', { ok: '置き換える', danger: true })) return;
      state = Core.normalizeState(data);
      save();
      openToday();
      render();
      toast(`復元しました（${state.entries.length} 件）`);
    } catch (e) {
      showAlert('バックアップファイルを読み込めませんでした: ' + e.message);
    }
  });

  $('#export-all-csv').addEventListener('click', () => {
    exportCsv('全記録の CSV', `工数記録_${stamp()}.csv`, Core.entriesToCsv(state, state.entries));
  });

  $('#export-list-csv').addEventListener('click', () => {
    exportCsv('表示中の工数の CSV', `工数記録_${stamp()}.csv`, Core.entriesToCsv(state, listFiltered()));
  });

  $('#import-csv').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    try {
      const { added, errors } = Core.importCsv(state, await readFile(file));
      save();
      render();
      showAlert(`${added} 件取り込みました。` + (errors.length ? `\n\n取り込めなかった行:\n${errors.slice(0, 20).join('\n')}` : ''));
    } catch (e) {
      showAlert('CSV を読み込めませんでした: ' + e.message);
    }
  });

  $('#clear-all').addEventListener('click', async () => {
    if (!await askConfirm('すべての記録とマスタを削除します。元に戻せません。先にバックアップを保存することをおすすめします。',
      { ok: 'すべて削除する', danger: true, title: '全データの削除' })) return;
    state = Core.emptyState();
    save();
    openToday();
    render();
    toast('全データを削除しました');
  });

  // ---------- サンプルデータ ----------
  function loadSample() {
    const { sites, employees } = Core.addSampleData(state, toISODate(new Date()));
    state.settings.lastSiteId = sites[0].id;
    state.settings.lastEmployeeId = employees[0].id;
    save();
    openToday();
    setPeriod('all');
    $('#rate-by-site').checked = true;
    // 現場用は現場の引き継ぎ画面、管理者用は全体の集計を表示する
    showTab(role() === 'admin' ? 'summary' : 'site');
    toast('サンプルデータを追加しました');
  }

  $('#load-sample').addEventListener('click', loadSample);
  $('#add-sample').addEventListener('click', loadSample);
  $('#start-own').addEventListener('click', () => {
    state.settings.welcomeDismissed = true;
    save();
    showTab('master');
    $('#master-sites').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  // ---------- 描画 ----------
  function siteOptionLabel(x) {
    return Core.siteLabel(x) + (x.status === 'done' ? '（完工）' : '');
  }

  /** 現場の選択肢（作番 現場名）。稼働中を上に並べる */
  function fillSiteSelect(select, sites, placeholder) {
    const current = select.value;
    const sorted = [...sites].sort((a, b) => (a.status === 'done') - (b.status === 'done') || String(a.code).localeCompare(String(b.code)));
    select.innerHTML = (placeholder === null ? '' : `<option value="">${escapeHtml(placeholder)}</option>`) +
      sorted.map((x) => `<option value="${escapeHtml(x.id)}">${escapeHtml(siteOptionLabel(x))}</option>`).join('');
    if (sites.some((x) => x.id === current)) select.value = current;
  }

  function renderSelects() {
    const sites = entrySites();
    fillSiteSelect(form.elements.siteId, sites, sites.length ? '現場を選択' : '現場がありません（管理者用 → 設定）');
    form.elements.siteId.value = sheet.siteId;
    const emps = state.employees;
    form.elements.inputBy.innerHTML = `<option value="">${emps.length ? '入力者を選択' : '社員が未登録です'}</option>` +
      emps.map((x) => `<option value="${escapeHtml(x.id)}">${escapeHtml(`${x.code} ${x.name}`.trim())}</option>`).join('');
    form.elements.inputBy.value = emps.some((x) => x.id === state.settings.lastEmployeeId) ? state.settings.lastEmployeeId : '';
    fillSiteSelect($('#c-site'), state.sites, null);
    for (const root of [$('#summary-filters')]) {
      fillSiteSelect($('[name=siteId]', root), state.sites, 'すべて');
      const cat = $('[name=categoryId]', root);
      fillSelect(cat, state.categories, { placeholder: 'すべて' });
      const wt = $('[name=workTypeId]', root);
      if (wt) fillWorkTypeSelect(wt, cat.value, 'すべて');
    }
    fillSelect($('.wt-add [name=categoryId]'), state.categories, { placeholder: '大分類を選択' });
    fillSelect($('#cr-kind'), state.siteKinds, { placeholder: 'すべて' });
  }

  function render() {
    renderSelects();
    const tab = currentTab();
    $('#context').hidden = !['report', 'entry', 'site'].includes(tab);
    $('#welcome').hidden = tab !== 'report' || !!(state.settings.welcomeDismissed || state.sites.length || state.entries.length);
    // 未保存の入力は残し、保存済みなら最新の記録から読み直す（マスタ変更も反映）
    const date = sheet.date || toISODate(new Date());
    const siteId = sheet.siteId || defaultSiteId();
    if (tab === 'report') {
      if (report.dirty) renderReport();
      else loadReport(date, siteId);
      renderDaySites();
    } else if (tab === 'entry') {
      if (sheet.dirty) renderSheet();
      else loadSheet(date, siteId);
    } else if (tab === 'site') {
      renderDaySites();
      renderSiteView();
    }
    else if (tab === 'cumul') renderCumul();
    else if (tab === 'summary') renderSummary();
    else if (tab === 'rates') renderCompanyRates();
    else if (tab === 'master') renderMaster();
  }

  // ---------- 起動 ----------
  applyRole();
  renderSelects();
  openToday();
  setPeriod('month');
  render();

  // 他のページに埋め込まれている場合（プレビュー公開など）はオフライン機能を使わない
  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && window.self === window.top) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker 登録失敗', e));
  }
})();
