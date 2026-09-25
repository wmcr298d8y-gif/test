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

  // compareMasterIds: 集計画面で実績と並べて表示する歩掛りマスタ（SITE_MASTER は各現場に設定したマスタ）
  const DEFAULT_SETTINGS = { hoursPerManDay: 8, compareMasterIds: [] };
  const SITE_MASTER = '@site';

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
      rateMasters: [],
      employees: [],
      entries: [],
      settings: { ...DEFAULT_SETTINGS, compareMasterIds: [] },
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
          state.workTypes.push({ id: newId(), categoryId: catId, name, unit });
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
      w = { id: newId(), categoryId, name, unit: unit || defaultUnit(name) };
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

  // ---------- 日報（1 日・1 現場分の作業をまとめて入力） ----------

  /** 何も入力していない行（保存時に読み飛ばす） */
  function isEmptyRow(row) {
    return !row.workTypeId && isBlank(row.quantity) && isBlank(row.note);
  }

  function isSiteDone(state, siteId) {
    const site = state.sites.find((x) => x.id === siteId);
    return !!site && site.status === 'done';
  }

  /** 指定日・現場の記録を日報の並び順で返す */
  function dayEntries(state, date, siteId) {
    const orderOf = (e) => (Number.isFinite(e.order) ? e.order : Infinity);
    return state.entries
      .filter((e) => e.date === date && e.siteId === siteId)
      .sort((a, b) => orderOf(a) - orderOf(b) || (a.createdAt || 0) - (b.createdAt || 0));
  }

  /**
   * 日報をまとめて保存する。rows は画面の作業行（id があれば既存の記録）。
   * 日報から消した行の記録は削除する。1 行でもエラーがあれば何も変更しない。
   * inputBy: 入力者（社員ID）。requireInputBy が true なら必須。完工済みの現場には保存できない。
   * 戻り値: { errors, saved, added, removed }
   */
  function saveDaySheet(state, date, siteId, rows, now = Date.now(), { inputBy = '', requireInputBy = false } = {}) {
    const existing = new Map(dayEntries(state, date, siteId).map((e) => [e.id, e]));
    const errors = [];
    const entries = [];
    rows.forEach((r, i) => {
      if (isEmptyRow(r)) return;
      const prev = existing.get(r.id);
      const entry = {
        ...(prev || { createdAt: now + i }),
        id: prev ? prev.id : newId(),
        date, siteId,
        workTypeId: r.workTypeId,
        people: Number(r.people),
        hours: Number(r.hours),
        quantity: isBlank(r.quantity) ? '' : Number(r.quantity),
        note: String(r.note || '').trim(),
        inputBy: inputBy || (prev && prev.inputBy) || '',
        order: entries.length,
      };
      // 開始・終了時刻は時間を変えると合わなくなるので消す
      if (!prev || Number(prev.hours) !== entry.hours) Object.assign(entry, { start: '', end: '', breakMinutes: '' });
      if (prev) entry.updatedAt = now;
      const errs = validateEntry(entry);
      if (errs.length) errors.push(`作業${i + 1}: ${errs.join(' / ')}`);
      entries.push(entry);
    });
    if (!date || !siteId) errors.unshift(!date ? '日付を入力してください' : '現場を選択してください');
    if (requireInputBy && !inputBy) errors.unshift('入力者を選択してください');
    if (isSiteDone(state, siteId)) errors.unshift('完工済みの現場のため保存できません（管理者が完工を解除すると入力できます）');
    if (errors.length) return { errors: [...new Set(errors)], saved: 0, added: 0, removed: 0 };

    const keptIds = new Set(entries.map((e) => e.id));
    const removed = [...existing.keys()].filter((id) => !keptIds.has(id));
    const drop = new Set([...existing.keys()]);
    state.entries = state.entries.filter((e) => !drop.has(e.id)).concat(entries);
    return {
      errors: [], saved: entries.length,
      added: entries.filter((e) => !existing.has(e.id)).length,
      removed: removed.length,
    };
  }

  /**
   * 同じ現場で指定日より前の、直近の日報の作業を呼び出す（数量・備考は空にする）。
   * 戻り値: { date, rows }（該当なしは date: null）
   */
  function previousDayRows(state, siteId, beforeDate) {
    const dates = state.entries.filter((e) => e.siteId === siteId && e.date < beforeDate).map((e) => e.date).sort();
    const date = dates.pop() || null;
    if (!date) return { date: null, rows: [] };
    return {
      date,
      rows: dayEntries(state, date, siteId).map((e) => ({
        workTypeId: e.workTypeId, people: e.people, hours: e.hours, quantity: '', note: '',
      })),
    };
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
   * 月 × キー（小分類・大分類など）の延べ工数(h)。
   * 戻り値: { months: ['YYYY-MM', ...], rows: Map(key → { [month]: h }), totals: Map(key → h), monthTotals: { [month]: h }, total }
   */
  function monthlyMatrix(entries, keyFn) {
    const months = [...new Set(entries.map((e) => e.date.slice(0, 7)))].sort();
    const rows = new Map();
    const totals = new Map();
    const monthTotals = {};
    let total = 0;
    for (const e of entries) {
      const key = keyFn(e);
      const m = e.date.slice(0, 7);
      const mh = entryManHours(e);
      const row = rows.get(key) || {};
      row[m] = round2((row[m] || 0) + mh);
      rows.set(key, row);
      totals.set(key, round2((totals.get(key) || 0) + mh));
      monthTotals[m] = round2((monthTotals[m] || 0) + mh);
      total += mh;
    }
    return { months, rows, totals, monthTotals, total: round2(total) };
  }

  /** 現場の記録がある期間（最初と最後の日付） */
  function siteDateRange(state, siteId) {
    const dates = state.entries.filter((e) => e.siteId === siteId).map((e) => e.date).sort();
    return { first: dates[0] || '', last: dates[dates.length - 1] || '' };
  }

  /**
   * 歩掛りを算出する（小分類ごと）。
   * 期間内の 延べ人工 ÷ 数量合計 を「歩掛り（人工/単位）」とする。
   * 数量を記録していない日の工数も、その工種の施工に要した手間として分子に含める。
   * bySite: true で 現場×小分類 ごとに集計する。
   * categories を渡すと大分類・小分類の登録順に並べる（省略時は工数の降順）。
   * 歩掛りマスタとの比較は compareStandards で付け加える。
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
      const rate = quantity > 0 ? manDays / quantity : null;
      return {
        key: g.key, workTypeId: g.workTypeId, siteId: g.siteId,
        categoryId: wt ? wt.categoryId : '',
        unit: (wt && wt.unit) || '',
        quantity, manHours, manDays: round2(manDays),
        rate: rate === null ? null : Math.round(rate * 1000) / 1000,
        output: manDays > 0 && quantity > 0 ? round2(quantity / manDays) : null,
        days: g.dates.size, quantityDays: g.quantityDates.size,
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

  // ---------- 歩掛りマスタ ----------

  /** マスタに登録された小分類の歩掛り（人工/単位）。未登録は null */
  function rateOf(master, workTypeId) {
    if (!master || !master.rates) return null;
    const v = master.rates[workTypeId];
    return isBlank(v) || !Number.isFinite(Number(v)) ? null : Number(v);
  }

  /**
   * productivity の各行に、指定した歩掛りマスタの値と対比（実績 ÷ マスタ × 100%）を付ける。
   * masterIds に SITE_MASTER を含めると、行の現場に設定されたマスタと比較する（現場ごと集計時のみ有効）。
   * 戻り値: 各行に standards: { [masterId]: { masterId, rate, ratio } } を追加したもの
   */
  function compareStandards(rows, state, masterIds) {
    const masters = new Map(state.rateMasters.map((m) => [m.id, m]));
    const siteMaster = new Map(state.sites.map((x) => [x.id, x.rateMasterId || '']));
    return rows.map((r) => {
      const standards = {};
      for (const id of masterIds) {
        const mId = id === SITE_MASTER ? (r.siteId ? siteMaster.get(r.siteId) || '' : '') : id;
        const std = rateOf(masters.get(mId), r.workTypeId);
        standards[id] = {
          masterId: mId,
          rate: std,
          ratio: r.rate !== null && std ? round2((r.rate / std) * 100) : null,
        };
      }
      return { ...r, standards };
    });
  }

  function addRateMaster(state, name, { note = '', copyFromId = '' } = {}) {
    const src = state.rateMasters.find((m) => m.id === copyFromId);
    const master = { id: newId(), name, note, rates: src ? { ...src.rates } : {} };
    state.rateMasters.push(master);
    return master;
  }

  /** マスタの歩掛りを設定する。空欄・不正値は削除扱い */
  function setRate(master, workTypeId, value) {
    if (isBlank(value)) { delete master.rates[workTypeId]; return true; }
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return false;
    master.rates[workTypeId] = n;
    return true;
  }

  const RATE_CSV_HEADER = ['大分類', '小分類', '単位', '歩掛り(人工/単位)'];

  /** 歩掛りマスタを CSV 化する。未登録の小分類も空欄で出力し、Excel での入力用テンプレートとして使える */
  function rateMasterToCsv(state, master) {
    const lines = [RATE_CSV_HEADER.join(',')];
    for (const c of state.categories) {
      for (const w of workTypesOfCategory(state, c.id)) {
        const r = rateOf(master, w.id);
        lines.push([c.name, w.name, w.unit || '', r === null ? '' : r].map(csvEscape).join(','));
      }
    }
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  /**
   * CSV を歩掛りマスタに取り込む。未登録の大分類・小分類は追加する。
   * 歩掛りが空欄の行は読み飛ばす（既存の値は消さない）。
   */
  function importRateMasterCsv(state, master, text) {
    const rows = parseCsv(text);
    if (!rows.length) return { updated: 0, createdWorkTypes: 0, errors: ['データがありません'] };
    const header = rows[0].map((h) => h.trim());
    const col = (...names) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
    const idx = {
      category: col('大分類'), workType: col('小分類', '工種'), unit: col('単位'),
      rate: col('歩掛り(人工/単位)', '歩掛り', '歩掛'),
    };
    if (idx.workType < 0 || idx.rate < 0) {
      return { updated: 0, createdWorkTypes: 0, errors: ['見出し行に 小分類・歩掛り(人工/単位) が必要です'] };
    }
    const get = (r, i) => (i >= 0 ? (r[i] || '').trim() : '');
    let updated = 0;
    const before = state.workTypes.length;
    const errors = [];
    rows.slice(1).forEach((r, n) => {
      const name = get(r, idx.workType);
      const rate = get(r, idx.rate);
      if (!name || rate === '') return;
      const v = Number(rate);
      if (!Number.isFinite(v) || v < 0) { errors.push(`${n + 2}行目: 歩掛り「${rate}」が数値ではありません`); return; }
      const catId = findOrAddCategory(state, get(r, idx.category) || UNCATEGORIZED);
      const wtId = findOrAddWorkType(state, catId, name, get(r, idx.unit));
      master.rates[wtId] = v;
      updated++;
    });
    return { updated, createdWorkTypes: state.workTypes.length - before, errors };
  }

  function csvEscape(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  const CSV_HEADER = ['日付', '作番', '現場', '大分類', '小分類', '人数', '時間(h/人)', '延べ工数(h)', '人工', '数量', '単位', '入力者', '備考'];

  function entriesToCsv(state, entries) {
    const names = nameLookup(state);
    const units = new Map(state.workTypes.map((w) => [w.id, w.unit || '']));
    const perDay = state.settings.hoursPerManDay || DEFAULT_SETTINGS.hoursPerManDay;
    const lines = [CSV_HEADER.map(csvEscape).join(',')];
    const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0));
    for (const e of sorted) {
      const mh = entryManHours(e);
      lines.push([
        e.date, names.siteCode(e.siteId), names.siteName(e.siteId),
        names.categoryOfWorkType(e.workTypeId), names.workType(e.workTypeId),
        e.people, e.hours, mh, round2(mh / perDay),
        isBlank(e.quantity) ? '' : e.quantity, isBlank(e.quantity) ? '' : units.get(e.workTypeId) || '',
        e.inputBy ? names.employee(e.inputBy) : '', e.note || '',
      ].map(csvEscape).join(','));
    }
    // Excel で文字化けしないよう BOM 付き
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    const s = text.replace(/^\uFEFF/, '');
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
   * CSV（本アプリの出力形式）を取り込む。現場は作番（なければ現場名）で照合し、未登録の現場・大分類・小分類は自動追加する。
   * 旧形式（「工種」列のみ）の CSV は大分類「未分類」として取り込む。
   * state を直接更新し、取り込み件数とエラーを返す。
   */
  function importCsv(state, text) {
    const rows = parseCsv(text);
    if (!rows.length) return { added: 0, errors: ['データがありません'] };
    const header = rows[0].map((h) => h.trim());
    const col = (...names) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
    const idx = {
      date: col('日付'), siteCode: col('作番'), site: col('現場'), category: col('大分類'), workType: col('小分類', '工種'),
      people: col('人数'), hours: col('時間(h/人)'), start: col('開始'), end: col('終了'),
      breakMinutes: col('休憩(分)'), note: col('備考'), quantity: col('数量'), unit: col('単位'), inputBy: col('入力者'),
    };
    if (idx.date < 0 || (idx.site < 0 && idx.siteCode < 0) || idx.workType < 0 || idx.hours < 0) {
      return { added: 0, errors: ['見出し行に 日付・作番（または現場）・小分類・時間(h/人) が必要です'] };
    }
    const get = (r, i) => (i >= 0 ? (r[i] || '').trim() : '');
    let added = 0;
    const errors = [];
    rows.slice(1).forEach((r, n) => {
      const siteName = get(r, idx.site);
      const siteCode = get(r, idx.siteCode);
      const wtName = get(r, idx.workType);
      let workTypeId = '';
      if (wtName) {
        const catId = findOrAddCategory(state, get(r, idx.category) || UNCATEGORIZED);
        workTypeId = findOrAddWorkType(state, catId, wtName, get(r, idx.unit));
      }
      let siteId = '';
      if (siteName || siteCode) {
        let site = (siteCode && state.sites.find((x) => x.code === siteCode)) ||
          (!siteCode && state.sites.find((x) => x.name === siteName));
        if (!site) { site = normalizeSite({ id: newId(), code: siteCode, name: siteName || siteCode }); state.sites.push(site); }
        siteId = site.id;
      }
      const inputByName = get(r, idx.inputBy);
      const emp = inputByName && state.employees.find((x) => x.name === inputByName);
      const entry = {
        id: newId(),
        date: get(r, idx.date).replace(/\//g, '-'),
        siteId,
        workTypeId,
        people: Number(get(r, idx.people) || 1),
        hours: Number(get(r, idx.hours)),
        start: get(r, idx.start),
        end: get(r, idx.end),
        breakMinutes: get(r, idx.breakMinutes) === '' ? '' : Number(get(r, idx.breakMinutes)),
        note: get(r, idx.note),
        quantity: get(r, idx.quantity) === '' ? '' : Number(get(r, idx.quantity)),
        inputBy: emp ? emp.id : '',
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
    const siteMap = new Map(state.sites.map((x) => [x.id, x]));
    const site = (id) => (siteMap.has(id) ? siteLabel(siteMap.get(id)) : '(削除済み)');
    const siteName = (id) => (siteMap.has(id) ? siteMap.get(id).name : '(削除済み)');
    const siteCode = (id) => (siteMap.has(id) ? siteMap.get(id).code || '' : '');
    const employee = byId(state.employees || []);
    const workType = byId(state.workTypes);
    const category = byId(state.categories);
    const catOf = categoryMap(state.workTypes);
    const categoryOfWorkType = (wtId) => (catOf.has(wtId) ? category(catOf.get(wtId)) : '(削除済み)');
    return {
      site, siteName, siteCode, employee, workType, category, categoryOfWorkType,
      workTypeFull: (wtId) => `${categoryOfWorkType(wtId)} › ${workType(wtId)}`,
    };
  }

  /** 表示用の現場名（作番 現場名） */
  function siteLabel(site) {
    return site.code ? `${site.code} ${site.name}` : site.name;
  }

  /**
   * 現場。作番・現場名は kintone の現場アプリの値を使う。
   * status（active: 稼働中 / done: 完工）・completedOn・rateMasterId はこのアプリで管理者が設定する。
   */
  function normalizeSite(x) {
    return { code: '', status: 'active', completedOn: '', rateMasterId: '', ...x };
  }

  /** 読み込んだ JSON を現在の形式に整える（旧形式の工種は大分類「未分類」に入れる） */
  function normalizeState(raw) {
    if (!raw || typeof raw !== 'object') return emptyState();
    const state = {
      version: 2,
      sites: Array.isArray(raw.sites) ? raw.sites.map(normalizeSite) : [],
      categories: Array.isArray(raw.categories) ? raw.categories : [],
      workTypes: [],
      rateMasters: Array.isArray(raw.rateMasters)
        ? raw.rateMasters.map((m) => ({ note: '', ...m, rates: { ...(m.rates || {}) } }))
        : [],
      employees: Array.isArray(raw.employees) ? raw.employees : [],
      entries: Array.isArray(raw.entries) ? raw.entries : [],
      settings: {
        ...DEFAULT_SETTINGS, ...(raw.settings || {}),
        compareMasterIds: [...((raw.settings && raw.settings.compareMasterIds) || [])],
      },
    };
    if (!Array.isArray(raw.workTypes)) {
      mergeDefaultTaxonomy(state);
      return state;
    }
    const catIds = new Set(state.categories.map((c) => c.id));
    // 旧バージョンでは標準歩掛りを小分類に直接持っていたため、マスタへ移す
    const legacyRates = {};
    state.workTypes = raw.workTypes.map((w) => {
      const { standardRate, ...wt } = { unit: defaultUnit(w.name), ...w };
      if (!catIds.has(wt.categoryId)) wt.categoryId = findOrAddCategory(state, UNCATEGORIZED);
      if (!isBlank(standardRate) && Number.isFinite(Number(standardRate))) legacyRates[wt.id] = Number(standardRate);
      return wt;
    });
    if (Object.keys(legacyRates).length) {
      const m = addRateMaster(state, '標準歩掛り（旧設定から移行）');
      m.rates = legacyRates;
      if (!state.settings.compareMasterIds.length) state.settings.compareMasterIds = [m.id];
    }
    // 削除済みマスタへの参照を外す
    const masterIds = new Set(state.rateMasters.map((m) => m.id));
    state.settings.compareMasterIds = (state.settings.compareMasterIds || [])
      .filter((id) => id === SITE_MASTER || masterIds.has(id));
    return state;
  }

  // ---------- サンプルデータ（お試し用） ----------

  /** 再現性のある疑似乱数（同じ日付なら同じサンプルになる） */
  function seededRandom(seed) {
    let t = seed >>> 0;
    return () => {
      t += 0x6D2B79F5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  function isoLocal(d) {
    // toISOString は UTC になり日本時間では前日にずれるため、端末の日付で組み立てる
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** endIso から遡って平日 count 日分の日付（古い順） */
  function weekdaysBack(endIso, count) {
    const days = [];
    const d = new Date(endIso + 'T00:00:00');
    while (days.length < count) {
      if (d.getDay() !== 0 && d.getDay() !== 6) days.unshift(isoLocal(d));
      d.setDate(d.getDate() - 1);
    }
    return days;
  }

  /**
   * お試し用のサンプルを追加する。
   * 稼働中の現場 2 件（直近 10 営業日）、完工済みの現場 1 件（約 1 か月前に完工）、社員 3 名、歩掛りマスタ 2 件。
   * 歩掛りの値はデモ用の仮の値で、国交省などの実際の値ではない。
   */
  function addSampleData(state, todayIso) {
    mergeDefaultTaxonomy(state);
    const wt = (name) => state.workTypes.find((w) => w.name === name);
    // [小分類, サンプル標準, サンプル元請]
    const sampleRates = [
      ['電線管敷設（露出）', 0.025, 0.03], ['ボックス取付', 0.04, 0.045], ['ケーブル配線（VVF等）', 0.012, 0.015],
      ['幹線ケーブル敷設', 0.05, 0.06], ['照明器具取付', 0.12, 0.15], ['コンセント取付', 0.05, 0.06],
      ['スイッチ取付', 0.05, 0.06], ['分電盤据付', 1.5, 1.8], ['LAN配線', 0.01, 0.012], ['自火報 感知器取付', 0.06, 0.07],
    ].filter(([n]) => wt(n));
    const std = addRateMaster(state, '標準歩掛り（サンプル値）', { note: 'お試し用の仮の値です。国交省の実際の歩掛りではありません。' });
    const gen = addRateMaster(state, '元請 ○○建設（サンプル値）', { note: 'お試し用の仮の値です。' });
    for (const [n, a, b] of sampleRates) { std.rates[wt(n).id] = a; gen.rates[wt(n).id] = b; }

    const employees = [['E001', '山田 太郎'], ['E002', '鈴木 一郎'], ['E003', '高橋 健']].map(([code, name]) => {
      let emp = state.employees.find((x) => x.code === code);
      if (!emp) { emp = { id: newId(), code, name }; state.employees.push(emp); }
      return emp;
    });

    const today = todayIso;
    const monthAgo = new Date(today + 'T00:00:00');
    monthAgo.setDate(monthAgo.getDate() - 30);
    const doneDays = weekdaysBack(isoLocal(monthAgo), 20);
    const sites = [
      normalizeSite({ id: newId(), code: '26-015', name: '【サンプル】A病院 改修電気工事' }),
      normalizeSite({ id: newId(), code: '26-021', name: '【サンプル】B庁舎 新築電気工事', rateMasterId: gen.id }),
      normalizeSite({ id: newId(), code: '25-088', name: '【サンプル】C工場 照明更新工事', status: 'done', completedOn: doneDays[doneDays.length - 1] }),
    ];
    state.sites.push(...sites);

    // 工程の順に作業が進むように、日ごとの作業候補を切り替える
    const phases = [
      ['電線管敷設（露出）', 'ボックス取付', 'LAN配線'],
      ['ケーブル配線（VVF等）', '幹線ケーブル敷設', 'LAN配線'],
      ['照明器具取付', 'コンセント取付', 'スイッチ取付', '分電盤据付', '自火報 感知器取付'],
    ].map((names) => names.filter((n) => wt(n)));
    const rand = seededRandom(Number(todayIso.replace(/-/g, '')));
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const rateBy = new Map(sampleRates.map(([n, a]) => [n, a]));
    let n = 0;
    const plan = [
      [sites[0], weekdaysBack(today, 10), employees[0], 0],
      [sites[1], weekdaysBack(today, 10), employees[1], 0.1], // B 現場はやや手間がかかる想定
      [sites[2], doneDays, employees[2], -0.05],
    ];
    for (const [site, days, emp, bias] of plan) {
      days.forEach((date, i) => {
        const phase = phases[Math.min(phases.length - 1, Math.floor((i / days.length) * phases.length))];
        [...new Set([pick(phase), pick(phase)])].forEach((name, order) => {
          const people = 1 + Math.floor(rand() * 3);
          const hours = pick([8, 8, 8, 6, 4, 3.5]);
          const manDays = (people * hours) / (state.settings.hoursPerManDay || 8);
          // 実績は標準の 0.8〜1.25 倍程度でばらつかせる
          const factor = 0.8 + rand() * 0.45 + bias;
          const raw = manDays / (rateBy.get(name) * factor);
          const quantity = raw >= 20 ? Math.round(raw / 5) * 5 : Math.max(1, Math.round(raw));
          state.entries.push({
            id: newId(), date, siteId: site.id, workTypeId: wt(name).id, people, hours,
            // 一部の日は数量を翌日にまとめて入力した想定で空欄にする
            quantity: rand() < 0.15 ? '' : quantity,
            note: '', inputBy: emp.id, order, createdAt: Date.now() + n++,
          });
        });
      });
    }
    state.settings.compareMasterIds = [std.id, SITE_MASTER];
    return { sites, masters: [std, gen], employees };
  }

  const Core = {
    addSampleData, isEmptyRow, isSiteDone, dayEntries, saveDaySheet, previousDayRows,
    monthlyMatrix, siteDateRange, siteLabel, normalizeSite,
    DEFAULT_TAXONOMY, UNCATEGORIZED, SITE_MASTER, emptyState,
    rateOf, compareStandards, addRateMaster, setRate, rateMasterToCsv, importRateMasterCsv, mergeDefaultTaxonomy, defaultUnit,
    findOrAddCategory, findOrAddWorkType, workTypesOfCategory,
    newId, round2, parseTime, hoursFromRange, isBlank, entryQuantity, entryManHours, validateEntry,
    filterEntries, aggregate, pivotByDate, productivity,
    entriesToCsv, parseCsv, importCsv, nameLookup, normalizeState,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  else global.Core = Core;
})(typeof window !== 'undefined' ? window : globalThis);
