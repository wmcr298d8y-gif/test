/*
 * 工数記録アプリのデータ処理（UI 非依存の純粋関数）
 * ブラウザでは window.Core、Node では module.exports として利用する。
 */
(function (global) {
  'use strict';

  // 初期登録する工種と、歩掛り算出に使う数量の単位
  const DEFAULT_WORK_TYPE_UNITS = {
    '仮設工事': 'm²', '土工事': 'm³', '基礎工事': 'm³', '鉄筋工事': 't', '型枠工事': 'm²',
    'コンクリート工事': 'm³', '鉄骨工事': 't', '内装工事': 'm²', '電気設備工事': '式', '機械設備工事': '式', '雑工事': '式',
  };
  const DEFAULT_WORK_TYPES = Object.keys(DEFAULT_WORK_TYPE_UNITS);

  const DEFAULT_SETTINGS = { hoursPerManDay: 8 };

  function emptyState() {
    return {
      version: 1,
      sites: [],
      workTypes: DEFAULT_WORK_TYPES.map((name) => ({ id: newId(), name, unit: DEFAULT_WORK_TYPE_UNITS[name], standardRate: '' })),
      workers: [],
      entries: [],
      settings: { ...DEFAULT_SETTINGS },
    };
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  /** "HH:MM" → 分。不正値は null */
  function parseTime(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 24 || min > 59) return null;
    return h * 60 + min;
  }

  /** 開始・終了・休憩(分) から実働時間(h)を求める。終了が開始より前なら日跨ぎとみなす */
  function hoursFromRange(start, end, breakMinutes) {
    const s = parseTime(start);
    const e = parseTime(end);
    if (s === null || e === null) return null;
    let diff = e - s;
    if (diff < 0) diff += 24 * 60;
    diff -= Number(breakMinutes) || 0;
    return diff > 0 ? round2(diff / 60) : 0;
  }

  /** エントリの延べ工数(h) = 人数 × 1人あたり時間 */
  function entryManHours(entry) {
    return round2((Number(entry.people) || 0) * (Number(entry.hours) || 0));
  }

  function validateEntry(entry) {
    const errors = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date || '')) errors.push('日付を入力してください');
    if (!entry.siteId) errors.push('現場を選択してください');
    if (!entry.workTypeId) errors.push('工種を選択してください');
    const people = Number(entry.people);
    if (!Number.isFinite(people) || people <= 0) errors.push('人数は 0 より大きい数値にしてください');
    const hours = Number(entry.hours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) errors.push('時間は 0〜24 の範囲で入力してください');
    if (!isBlank(entry.quantity)) {
      const q = Number(entry.quantity);
      if (!Number.isFinite(q) || q < 0) errors.push('数量は 0 以上の数値にしてください');
    }
    return errors;
  }

  function isBlank(v) {
    return v === undefined || v === null || String(v).trim() === '';
  }

  /** エントリの数量（未入力は 0） */
  function entryQuantity(entry) {
    return isBlank(entry.quantity) ? 0 : Number(entry.quantity) || 0;
  }

  /**
   * 歩掛りを算出する。
   * 期間内の 延べ人工 ÷ 数量合計 を「歩掛り（人工/単位）」とする。
   * 数量を記録していない日の工数も、その工種の施工に要した手間として分子に含める。
   * bySite: true で 現場×工種 ごと、false（既定）で工種ごとに集計する。
   * 戻り値: [{ key, workTypeId, siteId, quantity, manHours, manDays, rate, output, days, quantityDays, standardRate, ratio }]
   */
  function productivity(entries, workTypes, hoursPerManDay, { bySite = false } = {}) {
    const perDay = Number(hoursPerManDay) || DEFAULT_SETTINGS.hoursPerManDay;
    const wtMap = new Map(workTypes.map((w) => [w.id, w]));
    const groups = new Map();
    for (const e of entries) {
      const key = bySite ? e.siteId + '|' + e.workTypeId : e.workTypeId;
      const g = groups.get(key) || {
        key, workTypeId: e.workTypeId, siteId: bySite ? e.siteId : '',
        quantity: 0, manHours: 0, dates: new Set(), quantityDates: new Set(),
      };
      g.manHours += entryManHours(e);
      g.quantity += entryQuantity(e);
      g.dates.add(e.date);
      if (entryQuantity(e) > 0) g.quantityDates.add(e.date);
      groups.set(key, g);
    }
    return [...groups.values()].map((g) => {
      const manHours = round2(g.manHours);
      const manDays = manHours / perDay;
      const quantity = round2(g.quantity);
      const wt = wtMap.get(g.workTypeId);
      const std = wt && !isBlank(wt.standardRate) ? Number(wt.standardRate) : null;
      const rate = quantity > 0 ? manDays / quantity : null;
      return {
        key: g.key, workTypeId: g.workTypeId, siteId: g.siteId,
        unit: (wt && wt.unit) || '',
        quantity, manHours, manDays: round2(manDays),
        rate: rate === null ? null : Math.round(rate * 1000) / 1000,
        output: manDays > 0 && quantity > 0 ? round2(quantity / manDays) : null,
        days: g.dates.size, quantityDays: g.quantityDates.size,
        standardRate: std,
        ratio: rate !== null && std ? round2((rate / std) * 100) : null,
      };
    }).sort((a, b) => b.manHours - a.manHours);
  }

  function filterEntries(entries, { from, to, siteId, workTypeId } = {}) {
    return entries.filter((e) =>
      (!from || e.date >= from) &&
      (!to || e.date <= to) &&
      (!siteId || e.siteId === siteId) &&
      (!workTypeId || e.workTypeId === workTypeId));
  }

  /**
   * キー関数ごとに延べ工数を集計する。
   * 戻り値: [{ key, manHours, manDays, count }]（工数の降順）
   */
  function aggregate(entries, keyFn, hoursPerManDay) {
    const perDay = Number(hoursPerManDay) || DEFAULT_SETTINGS.hoursPerManDay;
    const map = new Map();
    for (const e of entries) {
      const key = keyFn(e);
      const row = map.get(key) || { key, manHours: 0, count: 0 };
      row.manHours += entryManHours(e);
      row.count += 1;
      map.set(key, row);
    }
    return [...map.values()]
      .map((r) => ({ ...r, manHours: round2(r.manHours), manDays: round2(r.manHours / perDay) }))
      .sort((a, b) => b.manHours - a.manHours);
  }

  /** 工種 × 日付 のクロス集計（延べ工数 h） */
  function pivotByWorkTypeAndDate(entries) {
    const dates = [...new Set(entries.map((e) => e.date))].sort();
    const rows = new Map();
    for (const e of entries) {
      const row = rows.get(e.workTypeId) || {};
      row[e.date] = round2((row[e.date] || 0) + entryManHours(e));
      rows.set(e.workTypeId, row);
    }
    return { dates, rows };
  }

  function csvEscape(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  const CSV_HEADER = ['日付', '現場', '工種', '作業者', '人数', '時間(h/人)', '延べ工数(h)', '人工', '数量', '単位', '開始', '終了', '休憩(分)', '備考'];

  function entriesToCsv(state, entries) {
    const names = nameLookup(state);
    const units = new Map(state.workTypes.map((w) => [w.id, w.unit || '']));
    const perDay = state.settings.hoursPerManDay || DEFAULT_SETTINGS.hoursPerManDay;
    const lines = [CSV_HEADER.map(csvEscape).join(',')];
    const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0));
    for (const e of sorted) {
      const mh = entryManHours(e);
      lines.push([
        e.date, names.site(e.siteId), names.workType(e.workTypeId), e.worker || '',
        e.people, e.hours, mh, round2(mh / perDay),
        isBlank(e.quantity) ? '' : e.quantity, isBlank(e.quantity) ? '' : units.get(e.workTypeId) || '',
        e.start || '', e.end || '', e.breakMinutes ?? '', e.note || '',
      ].map(csvEscape).join(','));
    }
    // Excel で文字化けしないよう BOM 付き
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    const s = text.replace(/^﻿/, '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inQuotes) {
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
        } else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((f) => f.trim() !== ''));
  }

  /**
   * CSV（本アプリの出力形式）を取り込む。未登録の現場・工種は自動追加する。
   * state を直接更新し、取り込み件数とエラーを返す。
   */
  function importCsv(state, text) {
    const rows = parseCsv(text);
    if (!rows.length) return { added: 0, errors: ['データがありません'] };
    const header = rows[0].map((h) => h.trim());
    const col = (name) => header.indexOf(name);
    const idx = {
      date: col('日付'), site: col('現場'), workType: col('工種'), worker: col('作業者'),
      people: col('人数'), hours: col('時間(h/人)'), start: col('開始'), end: col('終了'),
      breakMinutes: col('休憩(分)'), note: col('備考'), quantity: col('数量'), unit: col('単位'),
    };
    if (idx.date < 0 || idx.site < 0 || idx.workType < 0 || idx.hours < 0) {
      return { added: 0, errors: ['見出し行に 日付・現場・工種・時間(h/人) が必要です'] };
    }
    const findOrAdd = (list, name, extra) => {
      let item = list.find((x) => x.name === name);
      if (!item) { item = { id: newId(), name, ...extra }; list.push(item); }
      return item.id;
    };
    const get = (r, i) => (i >= 0 ? (r[i] || '').trim() : '');
    let added = 0;
    const errors = [];
    rows.slice(1).forEach((r, n) => {
      const siteName = get(r, idx.site);
      const wtName = get(r, idx.workType);
      const entry = {
        id: newId(),
        date: get(r, idx.date).replace(/\//g, '-'),
        siteId: siteName ? findOrAdd(state.sites, siteName) : '',
        workTypeId: wtName ? findOrAdd(state.workTypes, wtName, { unit: get(r, idx.unit) || DEFAULT_WORK_TYPE_UNITS[wtName] || '', standardRate: '' }) : '',
        worker: get(r, idx.worker),
        people: Number(get(r, idx.people) || 1),
        hours: Number(get(r, idx.hours)),
        start: get(r, idx.start),
        end: get(r, idx.end),
        breakMinutes: get(r, idx.breakMinutes) === '' ? '' : Number(get(r, idx.breakMinutes)),
        note: get(r, idx.note),
        quantity: get(r, idx.quantity) === '' ? '' : Number(get(r, idx.quantity)),
        createdAt: Date.now() + n,
      };
      const errs = validateEntry(entry);
      if (errs.length) errors.push(`${n + 2}行目: ${errs.join(' / ')}`);
      else { state.entries.push(entry); added++; }
    });
    return { added, errors };
  }

  function nameLookup(state) {
    const byId = (list) => {
      const m = new Map(list.map((x) => [x.id, x.name]));
      return (id) => m.get(id) || '(削除済み)';
    };
    return { site: byId(state.sites), workType: byId(state.workTypes) };
  }

  /** 読み込んだ JSON を現在の形式に整える */
  function normalizeState(raw) {
    const base = emptyState();
    if (!raw || typeof raw !== 'object') return base;
    return {
      version: 1,
      sites: Array.isArray(raw.sites) ? raw.sites : [],
      // 旧データの工種には単位がないため、初期工種名なら既定の単位を補う
      workTypes: Array.isArray(raw.workTypes)
        ? raw.workTypes.map((w) => ({
          unit: DEFAULT_WORK_TYPE_UNITS[w.name] || '', standardRate: '', ...w,
        }))
        : base.workTypes,
      workers: Array.isArray(raw.workers) ? raw.workers : [],
      entries: Array.isArray(raw.entries) ? raw.entries : [],
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
    };
  }

  const Core = {
    DEFAULT_WORK_TYPES, emptyState, newId, round2, parseTime, hoursFromRange,
    DEFAULT_WORK_TYPE_UNITS, isBlank, entryQuantity, productivity,
    entryManHours, validateEntry, filterEntries, aggregate, pivotByWorkTypeAndDate,
    entriesToCsv, parseCsv, importCsv, nameLookup, normalizeState,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  else global.Core = Core;
})(typeof window !== 'undefined' ? window : globalThis);
