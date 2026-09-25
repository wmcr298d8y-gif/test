/*
 * 工数記録アプリのデータ処理（UI 非依存の純粋関数）
 * ブラウザでは window.Core、Node では module.exports として利用する。
 */
(function (global) {
  'use strict';

  /**
   * 電気設備工事の標準工種（大分類 → [小分類, 数量の単位]）
   * 初回起動時に登録し、「設定」からいつでも不足分を追加できる。
   */
  const DEFAULT_TAXONOMY = [
    ['準備・仮設', [['墨出し', '式'], ['資材搬入・小運搬', '式'], ['仮設電気', '式'], ['片付け・清掃', '式']]],
    ['配管工事', [
      ['電線管敷設（露出）', 'm'], ['電線管敷設（隠ぺい）', 'm'], ['電線管敷設（打込み・埋設）', 'm'],
      ['ボックス取付', '個'], ['ケーブルラック敷設', 'm'], ['金属ダクト・レースウェイ', 'm'],
    ]],
    ['配線工事', [
      ['幹線ケーブル敷設', 'm'], ['電線入線', 'm'], ['ケーブル配線（VVF等）', 'm'], ['端末処理・結線', '箇所'],
    ]],
    ['盤・受変電設備', [['分電盤据付', '面'], ['動力盤・制御盤据付', '面'], ['キュービクル据付', '基'], ['盤内結線', '面']]],
    ['照明・配線器具', [['照明器具取付', '台'], ['非常照明・誘導灯取付', '台'], ['スイッチ取付', '個'], ['コンセント取付', '個']]],
    ['弱電・通信設備', [
      ['LAN配線', 'm'], ['情報コンセント取付', '個'], ['電話・TV配線', 'm'],
      ['放送・インターホン機器取付', '台'], ['防犯カメラ設置', '台'],
    ]],
    ['防災設備', [['自火報 感知器取付', '個'], ['受信機・発信機取付', '台'], ['防災配線', 'm']]],
    ['接地・避雷', [['接地工事', '箇所'], ['避雷設備', '式']]],
    ['外線・引込', [['引込工事', '式'], ['ハンドホール設置', '箇所'], ['地中管路敷設', 'm']]],
    ['試験・調整', [['絶縁抵抗・接地抵抗測定', '回路'], ['動作試験・調整', '式'], ['検査立会い', '式']]],
    ['改修・撤去', [['既存設備撤去', '式'], ['既存配線撤去', 'm']]],
    ['その他', [['はつり・貫通・補修', '箇所'], ['その他作業', '式']]],
  ];

  const UNCATEGORIZED = '未分類';

  const DEFAULT_SETTINGS = { hoursPerManDay: 8 };

  /** 小分類名 → 既定の単位 */
  function defaultUnit(name) {
    for (const [, items] of DEFAULT_TAXONOMY) {
      const hit = items.find(([n]) => n === name);
      if (hit) return hit[1];
    }
    return '';
  }

  function emptyState() {
    const state = {
      version: 2,
      sites: [],
      categories: [],
      workTypes: [],
      workers: [],
      entries: [],
      settings: { ...DEFAULT_SETTINGS },
    };
    mergeDefaultTaxonomy(state);
    return state;
  }

  /** 標準工種のうち未登録のもの（大分類名＋小分類名で判定）を追加する。追加件数を返す */
  function mergeDefaultTaxonomy(state) {
    let added = 0;
    for (const [catName, items] of DEFAULT_TAXONOMY) {
      const catId = findOrAddCategory(state, catName);
      for (const [name, unit] of items) {
        if (!state.workTypes.some((w) => w.categoryId === catId && w.name === name)) {
          state.workTypes.push({ id: newId(), categoryId: catId, name, unit, standardRate: '' });
          added++;
        }
      }
    }
    return added;
  }

  function findOrAddCategory(state, name) {
    let c = state.categories.find((x) => x.name === name);
    if (!c) { c = { id: newId(), name }; state.categories.push(c); }
    return c.id;
  }

  function findOrAddWorkType(state, categoryId, name, unit) {
    let w = state.workTypes.find((x) => x.categoryId === categoryId && x.name === name);
    if (!w) {
      w = { id: newId(), categoryId, name, unit: unit || defaultUnit(name), standardRate: '' };
      state.workTypes.push(w);
    }
    return w.id;
  }

  /** 大分類の並び順に小分類を並べたもの（入力・設定画面の表示順） */
  function workTypesOfCategory(state, categoryId) {
    return state.workTypes.filter((w) => w.categoryId === categoryId);
  }

  let idSeq = 0;
  function newId() {
    idSeq = (idSeq + 1) % 1296;
    return Date.now().toString(36) + idSeq.toString(36).padStart(2, '0') + Math.random().toString(36).slice(2, 6);
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

  function isBlank(v) {
    return v === undefined || v === null || String(v).trim() === '';
  }

  /** エントリの数量（未入力は 0） */
  function entryQuantity(entry) {
    return isBlank(entry.quantity) ? 0 : Number(entry.quantity) || 0;
  }

  function validateEntry(entry) {
    const errors = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date || '')) errors.push('日付を入力してください');
    if (!entry.siteId) errors.push('現場を選択してください');
    if (!entry.workTypeId) errors.push('工種（小分類）を選択してください');
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

  /** 小分類ID → 大分類ID の対応表 */
  function categoryMap(workTypes) {
    return new Map(workTypes.map((w) => [w.id, w.categoryId]));
  }

  /** 期間・現場・大分類・小分類で絞り込む（大分類で絞る場合は workTypes が必要） */
  function filterEntries(entries, { from, to, siteId, categoryId, workTypeId } = {}, workTypes = []) {
    const catOf = categoryMap(workTypes);
    return entries.filter((e) =>
      (!from || e.date >= from) &&
      (!to || e.date <= to) &&
      (!siteId || e.siteId === siteId) &&
      (!categoryId || catOf.get(e.workTypeId) === categoryId) &&
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

  /** キー × 日付 のクロス集計（延べ工数 h） */
  function pivotByDate(entries, keyFn) {
    const dates = [...new Set(entries.map((e) => e.date))].sort();
    const rows = new Map();
    for (const e of entries) {
      const key = keyFn(e);
      const row = rows.get(key) || {};
      row[e.date] = round2((row[e.date] || 0) + entryManHours(e));
      rows.set(key, row);
    }
    return { dates, rows };
  }

  /**
   * 歩掛りを算出する（小分類ごと）。
   * 期間内の 延べ人工 ÷ 数量合計 を「歩掛り（人工/単位）」とする。
   * 数量を記録していない日の工数も、その工種の施工に要した手間として分子に含める。
   * bySite: true で 現場×小分類 ごとに集計する。
   * categories を渡すと大分類・小分類の登録順に並べる（省略時は工数の降順）。
   */
  function productivity(entries, workTypes, hoursPerManDay, { bySite = false, categories = null } = {}) {
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
    const rows = [...groups.values()].map((g) => {
      const manHours = round2(g.manHours);
      const manDays = manHours / perDay;
      const quantity = round2(g.quantity);
      const wt = wtMap.get(g.workTypeId);
      const std = wt && !isBlank(wt.standardRate) ? Number(wt.standardRate) : null;
      const rate = quantity > 0 ? manDays / quantity : null;
      return {
        key: g.key, workTypeId: g.workTypeId, siteId: g.siteId,
        categoryId: wt ? wt.categoryId : '',
        unit: (wt && wt.unit) || '',
        quantity, manHours, manDays: round2(manDays),
        rate: rate === null ? null : Math.round(rate * 1000) / 1000,
        output: manDays > 0 && quantity > 0 ? round2(quantity / manDays) : null,
        days: g.dates.size, quantityDays: g.quantityDates.size,
        standardRate: std,
        ratio: rate !== null && std ? round2((rate / std) * 100) : null,
      };
    });
    if (categories) {
      const catIdx = new Map(categories.map((c, i) => [c.id, i]));
      const wtIdx = new Map(workTypes.map((w, i) => [w.id, i]));
      const idx = (m, k) => (m.has(k) ? m.get(k) : Infinity);
      return rows.sort((a, b) =>
        idx(catIdx, a.categoryId) - idx(catIdx, b.categoryId) ||
        idx(wtIdx, a.workTypeId) - idx(wtIdx, b.workTypeId) ||
        b.manHours - a.manHours);
    }
    return rows.sort((a, b) => b.manHours - a.manHours);
  }

  function csvEscape(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  const CSV_HEADER = ['日付', '現場', '大分類', '小分類', '作業者', '人数', '時間(h/人)', '延べ工数(h)', '人工', '数量', '単位', '開始', '終了', '休憩(分)', '備考'];

  function entriesToCsv(state, entries) {
    const names = nameLookup(state);
    const units = new Map(state.workTypes.map((w) => [w.id, w.unit || '']));
    const perDay = state.settings.hoursPerManDay || DEFAULT_SETTINGS.hoursPerManDay;
    const lines = [CSV_HEADER.map(csvEscape).join(',')];
    const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0));
    for (const e of sorted) {
      const mh = entryManHours(e);
      lines.push([
        e.date, names.site(e.siteId), names.categoryOfWorkType(e.workTypeId), names.workType(e.workTypeId), e.worker || '',
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
   * CSV（本アプリの出力形式）を取り込む。未登録の現場・大分類・小分類は自動追加する。
   * 旧形式（「工種」列のみ）の CSV は大分類「未分類」として取り込む。
   * state を直接更新し、取り込み件数とエラーを返す。
   */
  function importCsv(state, text) {
    const rows = parseCsv(text);
    if (!rows.length) return { added: 0, errors: ['データがありません'] };
    const header = rows[0].map((h) => h.trim());
    const col = (...names) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
    const idx = {
      date: col('日付'), site: col('現場'), category: col('大分類'), workType: col('小分類', '工種'),
      worker: col('作業者'), people: col('人数'), hours: col('時間(h/人)'), start: col('開始'), end: col('終了'),
      breakMinutes: col('休憩(分)'), note: col('備考'), quantity: col('数量'), unit: col('単位'),
    };
    if (idx.date < 0 || idx.site < 0 || idx.workType < 0 || idx.hours < 0) {
      return { added: 0, errors: ['見出し行に 日付・現場・小分類・時間(h/人) が必要です'] };
    }
    const get = (r, i) => (i >= 0 ? (r[i] || '').trim() : '');
    let added = 0;
    const errors = [];
    rows.slice(1).forEach((r, n) => {
      const siteName = get(r, idx.site);
      const wtName = get(r, idx.workType);
      let workTypeId = '';
      if (wtName) {
        const catId = findOrAddCategory(state, get(r, idx.category) || UNCATEGORIZED);
        workTypeId = findOrAddWorkType(state, catId, wtName, get(r, idx.unit));
      }
      let siteId = '';
      if (siteName) {
        let site = state.sites.find((x) => x.name === siteName);
        if (!site) { site = { id: newId(), name: siteName }; state.sites.push(site); }
        siteId = site.id;
      }
      const entry = {
        id: newId(),
        date: get(r, idx.date).replace(/\//g, '-'),
        siteId,
        workTypeId,
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
    const site = byId(state.sites);
    const workType = byId(state.workTypes);
    const category = byId(state.categories);
    const catOf = categoryMap(state.workTypes);
    const categoryOfWorkType = (wtId) => (catOf.has(wtId) ? category(catOf.get(wtId)) : '(削除済み)');
    return {
      site, workType, category, categoryOfWorkType,
      workTypeFull: (wtId) => `${categoryOfWorkType(wtId)} › ${workType(wtId)}`,
    };
  }

  /** 読み込んだ JSON を現在の形式に整える（旧形式の工種は大分類「未分類」に入れる） */
  function normalizeState(raw) {
    if (!raw || typeof raw !== 'object') return emptyState();
    const state = {
      version: 2,
      sites: Array.isArray(raw.sites) ? raw.sites : [],
      categories: Array.isArray(raw.categories) ? raw.categories : [],
      workTypes: [],
      workers: Array.isArray(raw.workers) ? raw.workers : [],
      entries: Array.isArray(raw.entries) ? raw.entries : [],
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
    };
    if (!Array.isArray(raw.workTypes)) {
      mergeDefaultTaxonomy(state);
      return state;
    }
    const catIds = new Set(state.categories.map((c) => c.id));
    state.workTypes = raw.workTypes.map((w) => {
      const wt = { unit: defaultUnit(w.name), standardRate: '', ...w };
      if (!catIds.has(wt.categoryId)) wt.categoryId = findOrAddCategory(state, UNCATEGORIZED);
      return wt;
    });
    return state;
  }

  const Core = {
    DEFAULT_TAXONOMY, UNCATEGORIZED, emptyState, mergeDefaultTaxonomy, defaultUnit,
    findOrAddCategory, findOrAddWorkType, workTypesOfCategory,
    newId, round2, parseTime, hoursFromRange, isBlank, entryQuantity, entryManHours, validateEntry,
    filterEntries, aggregate, pivotByDate, productivity,
    entriesToCsv, parseCsv, importCsv, nameLookup, normalizeState,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  else global.Core = Core;
})(typeof window !== 'undefined' ? window : globalThis);
