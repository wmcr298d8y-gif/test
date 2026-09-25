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

  /** 工事区分の初期値（管理者が追加・変更できる） */
  const DEFAULT_SITE_KINDS = ['新築', '改修', '設備更新', 'その他'];

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
      siteKinds: DEFAULT_SITE_KINDS.map((name) => ({ id: newId(), name })),
      employees: [],
      entries: [],
      reports: [],
      events: [],
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
          state.workTypes.push({ id: newId(), categoryId: catId, name, unit, countRule: '' });
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
      w = { id: newId(), categoryId, name, unit: unit || defaultUnit(name), countRule: '' };
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
        // 難度が高い作業（高所・狭所など）。自社の実績歩掛で標準と分けて集計する
        hard: !!r.hard,
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
        workTypeId: e.workTypeId, people: e.people, hours: e.hours, quantity: '', note: '', hard: !!e.hard,
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
   * 歩掛を算出する（小分類ごと）。
   * 期間内の 延べ人工 ÷ 数量合計 を「歩掛（人工/単位）」とする。
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

  // ---------- 日報 ----------
  // 1 日・1 現場で 1 件。代わりの人が読んでも「今日は何をどこまでやるか」が分かることを目的にする。
  // 今日の作業は前日の「明日の予定」から下書きし、途中の作業は翌日の予定へ自動で入れる（繰越）。

  const WEATHERS = ['晴', '曇', '雨', '雪'];
  // 今日の作業の状態。前日の予定から入った作業は未選択（''）で始まり、完了か途中を選ぶ。
  // 途中 = 今日で終わらなかった作業（手を付けられなかった作業も含む。理由は備考に書く）。
  // 今日の記録に残したまま、明日の予定へ「繰越」として入れる
  const TASK_STATUS = { done: '完了', partial: '途中' };
  const CARRY_STATUSES = new Set(['partial']);

  /** 現場ノートの項目（現場ごとに 1 枚。代わりの人が最初に読む情報） */
  const NOTEBOOK_FIELDS = [
    ['contacts', '元請の担当者・連絡先'],
    ['hours', '朝礼・作業時間'],
    ['rules', '入退場・作業のルール'],
    ['places', '鍵・資材置き場・図面の場所'],
    ['cautions', '注意点'],
    ['other', 'その他'],
  ];

  // workTypeId: 日報では選ばない（旧バージョンのデータやサンプルにある場合は、工数への取り込みで使う）
  function normalizeTask(t) {
    // 旧バージョンの「未着手」「繰越」は「途中」として扱う
    const status = t.status === 'notyet' || t.status === 'carried' ? 'partial' : (t.status in TASK_STATUS ? t.status : '');
    // skipCarry: 途中でも明日の予定には入れない（利用者が予定から外した）
    // photos: この作業の写真（「どこまで進んだか」を写真で残す）
    // prevMemo / prevPhotos: 下書きで表示する前回の進み具合と写真（参考表示のみで保存しない）
    return {
      id: t.id || newId(), place: t.place || '', work: t.work || '', workTypeId: t.workTypeId || '', status,
      memo: t.memo || '', photos: t.photos || [], skipCarry: !!t.skipCarry,
      prevMemo: t.prevMemo || '', prevPhotos: t.prevPhotos || [],
    };
  }

  /** 明日の予定。fromTaskId: 今日の途中の作業から自動で入れた予定（繰越）。carried は旧バージョンの項目 */
  function normalizePlan(p) {
    return { id: p.id || newId(), place: p.place || '', work: p.work || '', workTypeId: p.workTypeId || '', fromTaskId: p.fromTaskId || '', carried: !!p.carried };
  }

  function normalizeReport(r) {
    return {
      id: r.id || newId(),
      date: r.date || '',
      siteId: r.siteId || '',
      inputBy: r.inputBy || '',
      weather: r.weather || '',
      crew: {
        own: Number((r.crew && r.crew.own) || 0),
        subs: ((r.crew && r.crew.subs) || []).map((x) => ({ name: x.name || '', people: Number(x.people) || 0 })),
      },
      tasks: (r.tasks || []).map(normalizeTask),
      tomorrow: (r.tomorrow || []).map(normalizePlan),
      notes: r.notes || '',
      // その他の写真（作業に結び付かないもの: 元請の指示図面・危険箇所・資材など）
      photos: r.photos || [],
      // ふりかえり（良かった点・うまくいかなかった点）。現場タブの履歴には出さず、本人と管理者だけが見る
      reflection: r.reflection || '',
      createdAt: r.createdAt || 0,
      updatedAt: r.updatedAt || 0,
    };
  }

  function findReport(state, date, siteId) {
    return state.reports.find((r) => r.date === date && r.siteId === siteId) || null;
  }

  /** 現場の日報（新しい順） */
  function reportsOfSite(state, siteId) {
    return state.reports.filter((r) => r.siteId === siteId).sort((a, b) => b.date.localeCompare(a.date));
  }

  function previousReport(state, siteId, beforeDate) {
    return reportsOfSite(state, siteId).find((r) => r.date < beforeDate) || null;
  }

  /** 同じ作業かどうかの判定に使うキー（場所＋作業） */
  function itemKey(x) {
    return `${String(x.place || '').trim()}|${String(x.work || '').trim()}`;
  }

  /** 出面の合計（人工。半日の人は 0.5 として入力する） */
  function crewTotal(report) {
    if (!report) return 0;
    return round2((Number(report.crew.own) || 0) + report.crew.subs.reduce((sum, x) => sum + (Number(x.people) || 0), 0));
  }

  /** 空欄の作業・予定・協力会社の行を除いた日報 */
  function cleanReport(report) {
    const filled = (x) => String(x.place || '').trim() || String(x.work || '').trim();
    return {
      ...report,
      tasks: report.tasks.filter(filled).map(({ prevMemo, prevPhotos, ...t }) => ({ ...t, place: t.place.trim(), work: t.work.trim(), memo: t.memo.trim() })),
      tomorrow: report.tomorrow.filter(filled).map((p) => ({ ...p, place: p.place.trim(), work: p.work.trim() })),
      crew: { own: Number(report.crew.own) || 0, subs: report.crew.subs.filter((x) => String(x.name).trim() || Number(x.people)).map((x) => ({ name: String(x.name).trim(), people: Number(x.people) || 0 })) },
      notes: String(report.notes || '').trim(),
      reflection: String(report.reflection || '').trim(),
    };
  }

  /**
   * 日報の下書き。保存済みならその内容、なければ同じ現場の直近の日報から作る。
   *   今日の作業 = 前回の「明日の予定」＋ 前回「途中」で予定に入っていなかった作業（どちらも状態は未選択）
   *   出面 = 前回と同じ人数（変わっていれば直してもらう）
   * 戻り値: { report, saved: 保存済みか, fromDate: 下書きの元にした日報の日付 }
   */
  function draftReport(state, date, siteId) {
    const saved = findReport(state, date, siteId);
    if (saved) return { report: normalizeReport(JSON.parse(JSON.stringify(saved))), saved: true, fromDate: null };
    const prev = previousReport(state, siteId, date);
    const report = normalizeReport({ date, siteId });
    if (!prev) return { report, saved: false, fromDate: null };
    const seen = new Set();
    const tasks = [];
    // 前回「途中」だった作業の進み具合・できなかった理由と写真は、参考として下書きに表示する（入力欄には入れない）
    const unfinished = prev.tasks.filter((t) => t.status !== 'done');
    const prevMemo = new Map(unfinished.filter((t) => t.memo).map((t) => [itemKey(t), t.memo]));
    const prevPhotos = new Map(unfinished.filter((t) => t.photos.length).map((t) => [itemKey(t), t.photos]));
    for (const p of prev.tomorrow) {
      const key = itemKey(p);
      if (seen.has(key)) continue;
      seen.add(key);
      tasks.push(normalizeTask({ place: p.place, work: p.work, workTypeId: p.workTypeId, status: '', prevMemo: prevMemo.get(key), prevPhotos: prevPhotos.get(key) }));
    }
    for (const t of prev.tasks) {
      if (t.status === 'done' || seen.has(itemKey(t))) continue;
      seen.add(itemKey(t));
      tasks.push(normalizeTask({ place: t.place, work: t.work, workTypeId: t.workTypeId, status: '', prevMemo: t.memo, prevPhotos: t.photos }));
    }
    report.tasks = tasks;
    report.crew = { own: prev.crew.own, subs: prev.crew.subs.map((x) => ({ ...x })) };
    return { report, saved: false, fromDate: prev.date };
  }

  /**
   * 途中の作業を「明日の予定」に自動で入れる（すでに同じ作業があれば入れない）。
   * 完了にした・消した作業から自動で入れた予定は外す。手で書いた予定には触れない。
   */
  function syncCarryOver(report) {
    const byTask = new Map(report.tasks.map((t) => [t.id, t]));
    report.tomorrow = report.tomorrow.filter((p) => {
      if (!p.fromTaskId) return true;
      const t = byTask.get(p.fromTaskId);
      return t && CARRY_STATUSES.has(t.status) && !t.skipCarry;
    });
    const keys = new Set(report.tomorrow.map(itemKey));
    for (const t of report.tasks) {
      if (!CARRY_STATUSES.has(t.status) || t.skipCarry || !(t.place.trim() || t.work.trim())) continue;
      const linked = report.tomorrow.find((p) => p.fromTaskId === t.id);
      if (linked) {
        // 作業の内容や状態を直したら、自動で入れた予定も合わせる
        Object.assign(linked, { place: t.place, work: t.work, workTypeId: t.workTypeId });
        continue;
      }
      if (keys.has(itemKey(t))) continue;
      report.tomorrow.push(normalizePlan({ place: t.place, work: t.work, workTypeId: t.workTypeId, fromTaskId: t.id }));
      keys.add(itemKey(t));
    }
    return report;
  }

  function validateReport(state, report, { requireInputBy = false } = {}) {
    const errors = [];
    if (requireInputBy && !report.inputBy) errors.push('入力者を選択してください');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(report.date || '')) errors.push('日付を入力してください');
    if (!report.siteId) errors.push('現場を選択してください');
    if (isSiteDone(state, report.siteId)) errors.push('完工済みの現場のため保存できません（管理者が完工を解除すると入力できます）');
    const r = cleanReport(report);
    if (!r.tasks.length && !r.notes) errors.push('今日の作業を 1 つ以上入力してください（作業がない日は特記事項に理由を書いてください）');
    const unset = r.tasks.filter((t) => !t.status);
    if (unset.length) errors.push(`状態を選んでいない作業が ${unset.length} 件あります。完了か途中を選んでください（手を付けられなかった作業は「途中」にして理由を備考へ）`);
    if (r.crew.own < 0 || r.crew.subs.some((x) => x.people < 0)) errors.push('出面は 0 以上にしてください');
    if (r.crew.subs.some((x) => !x.name)) errors.push('協力会社の名前を入力してください');
    return errors;
  }

  /** 日報を保存する（同じ日・現場の日報は置き換え）。戻り値: { errors, report } */
  function saveReport(state, report, now = Date.now(), opts = {}) {
    const errors = validateReport(state, report, opts);
    if (errors.length) return { errors, report: null };
    const clean = normalizeReport(cleanReport(report));
    const prev = findReport(state, clean.date, clean.siteId);
    clean.id = prev ? prev.id : clean.id;
    clean.createdAt = prev ? prev.createdAt : now;
    clean.updatedAt = now;
    state.reports = state.reports.filter((r) => r !== prev).concat(clean);
    return { errors: [], report: clean };
  }

  /** 検索用に表記をそろえる（全角・半角、大文字・小文字の違いを無視） */
  function normalizeForSearch(s) {
    return String(s || '').normalize('NFKC').toLowerCase();
  }

  /**
   * 現場の日報をキーワードで探す（新しい順）。空白区切りの語をすべて含む日報を返す。
   * 対象: 今日の作業（場所・作業・備考）、明日の予定、特記事項。ふりかえりは対象にしない（本人と管理者のみの情報のため）。
   */
  function searchReports(state, siteId, query) {
    const terms = normalizeForSearch(query).split(/\s+/).filter(Boolean);
    const reps = reportsOfSite(state, siteId);
    if (!terms.length) return reps;
    return reps.filter((r) => {
      const text = normalizeForSearch([
        ...r.tasks.flatMap((t) => [t.place, t.work, t.memo]),
        ...r.tomorrow.flatMap((p) => [p.place, p.work]),
        r.notes,
      ].join(' '));
      return terms.every((t) => text.includes(t));
    });
  }

  /** 指定日以降の予定（検査・打合せ・搬入など）。古い順 */
  function upcomingEvents(state, siteId, fromDate) {
    return state.events.filter((e) => e.siteId === siteId && e.date >= fromDate)
      .sort((a, b) => a.date.localeCompare(b.date) || String(a.title).localeCompare(String(b.title)));
  }

  /** 日付ごとの日報の提出状況: Map(siteId → Set(date)) */
  function reportSubmission(state, dates) {
    const want = new Set(dates);
    const map = new Map();
    for (const r of state.reports) {
      if (!want.has(r.date)) continue;
      const set = map.get(r.siteId) || new Set();
      set.add(r.date);
      map.set(r.siteId, set);
    }
    return map;
  }

  /** 協力会社名の入力候補（これまでの日報に出てきた名前） */
  function subcontractorNames(state) {
    const names = new Set();
    for (const r of state.reports) for (const x of r.crew.subs) if (x.name) names.add(x.name);
    return [...names].sort((a, b) => a.localeCompare(b, 'ja'));
  }

  // ---------- 自社の実績歩掛（積算用） ----------

  /**
   * 複数現場の記録から、小分類ごとの自社実績歩掛を求める。
   * 歩掛 = 人工合計 ÷ 数量合計（規模の大きい現場ほど重みが大きい加重平均）。
   * その工種の数量を一度も記録していない現場は、手間だけが計上されて値が過大になるため計算から除き、
   * 件数（sitesNoQuantity）として返す。同じ現場の中で数量を入れていない日の工数は含める。
   * 現場ごとの歩掛から最小・最大も出し、ばらつきと現場数で信頼度を判断できるようにする。
   * options:
   *   doneOnly  完工済みの現場だけを対象にする（既定 true）
   *   kindId    工事区分で絞る
   *   difficulty 'all' | 'normal'（難なしのみ）| 'hard'（難ありのみ）
   *   from / to 記録日の範囲
   *   minCoverage 工数の入力率（0〜1）がこれ未満の現場を除く
   * 戻り値（大分類・小分類の登録順）:
   *   [{ workTypeId, categoryId, unit, rate, output, quantity, manDays, sites, sitesNoQuantity, siteMin, siteMax, hardShare }]
   */
  /**
   * 現場の工数の入力率 = 工数の人工 ÷ 日報の出面の人工（日報がある日だけで比べる。最大 1）。
   * 工数は任意入力なので、一部の日しか入れていない現場は歩掛が偏る。その判断に使う。
   * 日報がない（出面が分からない）場合は null。
   */
  function siteCoverage(state, siteId, { from = '', to = '' } = {}, hoursPerManDay) {
    const perDay = Number(hoursPerManDay || state.settings.hoursPerManDay) || DEFAULT_SETTINGS.hoursPerManDay;
    const reps = state.reports.filter((r) => r.siteId === siteId && (!from || r.date >= from) && (!to || r.date <= to));
    const crew = reps.reduce((sum, r) => sum + crewTotal(r), 0);
    if (!crew) return null;
    const dates = new Set(reps.map((r) => r.date));
    const md = state.entries.filter((e) => e.siteId === siteId && dates.has(e.date))
      .reduce((sum, e) => sum + entryManHours(e), 0) / perDay;
    return Math.min(1, round2(md / crew));
  }

  /**
   * 実績歩掛の対象にする現場。工数の入力率が minCoverage 未満の現場は除く（入力率が分からない現場は含める）。
   * 戻り値: { included: [{ siteId, coverage }], excluded: [{ siteId, coverage }] }（記録のある現場のみ）
   */
  function rateTargetSites(state, { doneOnly = true, kindId = '', from = '', to = '', minCoverage = 0 } = {}, hoursPerManDay) {
    const withEntries = new Set(state.entries.filter((e) => (!from || e.date >= from) && (!to || e.date <= to)).map((e) => e.siteId));
    const included = [];
    const excluded = [];
    for (const site of state.sites) {
      if (!withEntries.has(site.id)) continue;
      if (doneOnly && site.status !== 'done') continue;
      if (kindId && site.kindId !== kindId) continue;
      const coverage = siteCoverage(state, site.id, { from, to }, hoursPerManDay);
      (coverage !== null && coverage < minCoverage ? excluded : included).push({ siteId: site.id, coverage });
    }
    return { included, excluded };
  }

  function companyRates(state, { doneOnly = true, kindId = '', difficulty = 'all', from = '', to = '', minCoverage = 0 } = {}, hoursPerManDay) {
    const perDay = Number(hoursPerManDay || state.settings.hoursPerManDay) || DEFAULT_SETTINGS.hoursPerManDay;
    const targets = new Set(rateTargetSites(state, { doneOnly, kindId, from, to, minCoverage }, perDay).included.map((x) => x.siteId));
    const entries = state.entries.filter((e) => {
      if (!targets.has(e.siteId)) return false;
      if (difficulty === 'normal' && e.hard) return false;
      if (difficulty === 'hard' && !e.hard) return false;
      return (!from || e.date >= from) && (!to || e.date <= to);
    });
    // 小分類 → 現場 → { 人工(h), 難の人工(h), 数量 }
    const groups = new Map();
    for (const e of entries) {
      const bySite = groups.get(e.workTypeId) || new Map();
      const bs = bySite.get(e.siteId) || { manHours: 0, hardHours: 0, quantity: 0 };
      const mh = entryManHours(e);
      bs.manHours += mh;
      if (e.hard) bs.hardHours += mh;
      bs.quantity += entryQuantity(e);
      bySite.set(e.siteId, bs);
      groups.set(e.workTypeId, bySite);
    }
    const wtIndex = new Map(state.workTypes.map((w, i) => [w.id, i]));
    const catIndex = new Map(state.categories.map((c, i) => [c.id, i]));
    const wtMap = new Map(state.workTypes.map((w) => [w.id, w]));
    const idx = (m, k) => (m.has(k) ? m.get(k) : Infinity);
    const r3 = (v) => Math.round(v * 1000) / 1000;
    return [...groups.entries()].map(([workTypeId, bySite]) => {
      const wt = wtMap.get(workTypeId);
      const withQty = [...bySite.values()].filter((x) => x.quantity > 0);
      const manHours = withQty.reduce((sum, x) => sum + x.manHours, 0);
      const hardHours = withQty.reduce((sum, x) => sum + x.hardHours, 0);
      const manDays = manHours / perDay;
      const quantity = round2(withQty.reduce((sum, x) => sum + x.quantity, 0));
      const siteRates = withQty.map((x) => x.manHours / perDay / x.quantity);
      return {
        workTypeId, categoryId: wt ? wt.categoryId : '', unit: (wt && wt.unit) || '', countRule: (wt && wt.countRule) || '',
        rate: quantity > 0 ? r3(manDays / quantity) : null,
        output: quantity > 0 && manDays > 0 ? round2(quantity / manDays) : null,
        quantity, manDays: round2(manDays),
        sites: withQty.length,
        sitesNoQuantity: bySite.size - withQty.length,
        siteMin: siteRates.length ? r3(Math.min(...siteRates)) : null,
        siteMax: siteRates.length ? r3(Math.max(...siteRates)) : null,
        hardShare: manHours > 0 ? round2((hardHours / manHours) * 100) : 0,
      };
    }).sort((a, b) =>
      idx(catIndex, a.categoryId) - idx(catIndex, b.categoryId) || idx(wtIndex, a.workTypeId) - idx(wtIndex, b.workTypeId));
  }

  const COMPANY_RATE_CSV_HEADER = ['大分類', '小分類', '単位', '実績歩掛(人工/単位)', '1人工あたり施工量', '現場数', '最小', '最大', '数量合計', '人工合計', '難の割合(%)', '数量の数え方'];

  /** 自社の実績歩掛を CSV にする（積算の歩掛マスタへの転記用）。condition は条件の説明（1 行目に出力） */
  function companyRatesToCsv(state, rows, condition = '') {
    const names = nameLookup(state);
    const v = (x) => (x === null || x === undefined ? '' : x);
    const lines = [];
    if (condition) lines.push(csvEscape(`条件: ${condition}`));
    lines.push(COMPANY_RATE_CSV_HEADER.join(','));
    for (const r of rows) {
      lines.push([
        names.category(r.categoryId), names.workType(r.workTypeId), r.unit,
        v(r.rate), v(r.output), r.sites, v(r.siteMin), v(r.siteMax), r.quantity, r.manDays, r.hardShare, r.countRule || '',
      ].map(csvEscape).join(','));
    }
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  // ---------- 工種マスタの CSV（Excel での編集用。本番の kintone 工種アプリと同じ項目） ----------

  const WORKTYPE_CSV_HEADER = ['大分類', '小分類', '単位', '数量の数え方', '表示順'];

  /** 工種を大分類・小分類の並び順で CSV にする */
  function workTypesToCsv(state) {
    const lines = [WORKTYPE_CSV_HEADER.join(',')];
    let order = 0;
    for (const c of state.categories) {
      for (const w of workTypesOfCategory(state, c.id)) {
        lines.push([c.name, w.name, w.unit || '', w.countRule || '', ++order].map(csvEscape).join(','));
      }
    }
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  /** Excel からコピーしたセル（タブ区切り）か CSV かを見分けて表に分ける */
  function parseTable(text) {
    const s = String(text || '').replace(/^\uFEFF/, '');
    const firstLine = s.split(/\r?\n/, 1)[0];
    if (firstLine.includes('\t')) {
      return s.split(/\r?\n/).map((line) => line.split('\t')).filter((r) => r.some((f) => f.trim() !== ''));
    }
    return parseCsv(s);
  }

  /**
   * 工種マスタを CSV（またはタブ区切り）から取り込む。
   * 大分類＋小分類の名前で照合し、あれば単位・数量の数え方を更新、なければ追加する。
   * CSV にない工種は削除しない（過去の記録で使っているため）。
   * すべての工種が入った CSV（書き出して編集したもの）のときだけ、表示順（なければ行の順）に並べ替える。
   * 一部だけの CSV では並び順を変えず、新しい工種は後ろに追加する。
   * 戻り値: { added, updated, errors }
   */
  function importWorkTypesCsv(state, text) {
    const rows = parseTable(text);
    if (!rows.length) return { added: 0, updated: 0, errors: ['データがありません'] };
    const header = rows[0].map((h) => h.trim());
    const col = (name) => header.indexOf(name);
    const idx = { category: col('大分類'), name: col('小分類'), unit: col('単位'), rule: col('数量の数え方'), order: col('表示順') };
    if (idx.category < 0 || idx.name < 0) return { added: 0, updated: 0, errors: ['見出し行に 大分類・小分類 が必要です'] };
    const get = (r, i) => (i >= 0 ? String(r[i] ?? '').trim() : '');
    const errors = [];
    const seen = [];
    let added = 0;
    let updated = 0;
    rows.slice(1).forEach((r, n) => {
      const catName = get(r, idx.category);
      const name = get(r, idx.name);
      if (!catName || !name) { errors.push(`${n + 2}行目: 大分類と小分類を入力してください`); return; }
      const catId = findOrAddCategory(state, catName);
      let wt = state.workTypes.find((w) => w.categoryId === catId && w.name === name);
      const unit = get(r, idx.unit);
      if (!wt) {
        wt = { id: newId(), categoryId: catId, name, unit: unit || defaultUnit(name), countRule: '' };
        state.workTypes.push(wt);
        added++;
      } else {
        updated++;
      }
      if (unit) wt.unit = unit;
      // 数え方は空欄も反映する（Excel で消した場合）
      if (idx.rule >= 0) wt.countRule = get(r, idx.rule);
      const order = Number(get(r, idx.order));
      seen.push({ wt, catId, order: Number.isFinite(order) && get(r, idx.order) !== '' ? order : Infinity, row: n });
    });
    const inCsv = new Set(seen.map((x) => x.wt));
    if (state.workTypes.every((w) => inCsv.has(w))) {
      seen.sort((a, b) => a.order - b.order || a.row - b.row);
      state.workTypes = seen.map((x) => x.wt);
      const catOrder = [...new Set(seen.map((x) => x.catId))];
      state.categories = catOrder.map((id) => state.categories.find((c) => c.id === id))
        .concat(state.categories.filter((c) => !catOrder.includes(c.id)));
    }
    return { added, updated, errors, reordered: state.workTypes.every((w) => inCsv.has(w)) };
  }

  /**
   * ファイルの中身を文字列にする。UTF-8 で読めなければ Shift_JIS として読む
   * （日本語版 Excel で「CSV（コンマ区切り）」として保存すると Shift_JIS になるため）。
   */
  function decodeText(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      return new TextDecoder('shift_jis').decode(bytes);
    }
  }

  function csvEscape(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  const CSV_HEADER = ['日付', '作番', '現場', '大分類', '小分類', '人数', '時間(h/人)', '延べ工数(h)', '人工', '数量', '単位', '難度', '入力者', '備考'];

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
        e.hard ? '難' : '', e.inputBy ? names.employee(e.inputBy) : '', e.note || '',
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
      hard: col('難度'),
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
        hard: get(r, idx.hard) === '難',
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
   * status（active: 稼働中 / done: 完工）・completedOn・kindId（工事区分）はこのアプリで管理者が設定する。
   */
  function normalizeSite(x) {
    const { rateMasterId, ...site } = x; // 旧バージョンの元請マスタ紐づけは廃止
    return { code: '', status: 'active', completedOn: '', kindId: '', ...site };
  }

  /** 読み込んだ JSON を現在の形式に整える（旧形式の工種は大分類「未分類」に入れる） */
  function normalizeState(raw) {
    if (!raw || typeof raw !== 'object') return emptyState();
    const state = {
      version: 2,
      sites: Array.isArray(raw.sites) ? raw.sites.map(normalizeSite) : [],
      categories: Array.isArray(raw.categories) ? raw.categories : [],
      workTypes: [],
      siteKinds: Array.isArray(raw.siteKinds) ? raw.siteKinds : DEFAULT_SITE_KINDS.map((name) => ({ id: newId(), name })),
      employees: Array.isArray(raw.employees) ? raw.employees : [],
      reports: Array.isArray(raw.reports) ? raw.reports.map(normalizeReport) : [],
      events: Array.isArray(raw.events) ? raw.events : [],
      entries: Array.isArray(raw.entries) ? raw.entries : [],
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
    };
    if (!Array.isArray(raw.workTypes)) {
      mergeDefaultTaxonomy(state);
      return state;
    }
    const catIds = new Set(state.categories.map((c) => c.id));
    state.workTypes = raw.workTypes.map((w) => {
      // 旧バージョンの小分類ごとの標準歩掛（standardRate）は廃止
      // countRule: 数量の数え方（例: 図面上の管の長さ。支持金具の取付を含む）。人によって数え方が違うと歩掛が比べられないため、会社として決めて書いておく
      const { standardRate, ...wt } = { unit: defaultUnit(w.name), countRule: '', ...w };
      if (!catIds.has(wt.categoryId)) wt.categoryId = findOrAddCategory(state, UNCATEGORIZED);
      return wt;
    });
    // 廃止した設定（歩掛マスタとの比較）を消す
    delete state.settings.compareMasterIds;
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
   * 稼働中の現場 2 件（直近 10 営業日）、完工済みの現場 2 件（約 1・2 か月前に完工）、社員 3 名。
   * 一部の作業は難度「難」にする。
   */
  function addSampleData(state, todayIso) {
    mergeDefaultTaxonomy(state);
    const wt = (name) => state.workTypes.find((w) => w.name === name);
    // 実績のばらつきの基準にする仮の歩掛（人工/単位）
    const baseRates = new Map([
      ['電線管敷設（露出）', 0.03], ['ボックス取付', 0.045], ['ケーブル配線（VVF等）', 0.014],
      ['幹線ケーブル敷設', 0.055], ['照明器具取付', 0.13], ['コンセント取付', 0.055],
      ['スイッチ取付', 0.055], ['分電盤据付', 1.6], ['LAN配線', 0.011], ['自火報 感知器取付', 0.065],
    ].filter(([n]) => wt(n)));

    // 数量の数え方の例（実際の数え方は会社で決めて「設定」で書き換える）
    const sampleRules = [
      ['電線管敷設（露出）', '【サンプル】図面上の管の長さ（m）。支持金具の取付を含む。'],
      ['照明器具取付', '【サンプル】器具 1 台＝1 台（種類は問わない）。結線まで含む。'],
      ['ケーブル配線（VVF等）', '【サンプル】ケーブル 1 本ごとの長さ（m）。3 本並べたら 3 本分。'],
      ['分電盤据付', '【サンプル】盤 1 面＝1 面。盤内結線は「盤内結線」で別に数える。'],
    ];
    for (const [n, rule] of sampleRules) { const w = wt(n); if (w && !w.countRule) w.countRule = rule; }

    const employees = [['E001', '山田 太郎'], ['E002', '鈴木 一郎'], ['E003', '高橋 健']].map(([code, name]) => {
      let emp = state.employees.find((x) => x.code === code);
      if (!emp) { emp = { id: newId(), code, name }; state.employees.push(emp); }
      return emp;
    });
    const kind = (name) => {
      let k = state.siteKinds.find((x) => x.name === name);
      if (!k) { k = { id: newId(), name }; state.siteKinds.push(k); }
      return k.id;
    };

    const back = (days) => { const d = new Date(todayIso + 'T00:00:00'); d.setDate(d.getDate() - days); return isoLocal(d); };
    const doneC = weekdaysBack(back(30), 20);
    const doneD = weekdaysBack(back(62), 15);
    const sites = [
      normalizeSite({ id: newId(), code: '26-015', name: '【サンプル】A病院 改修電気工事', kindId: kind('改修') }),
      normalizeSite({ id: newId(), code: '26-021', name: '【サンプル】B庁舎 新築電気工事', kindId: kind('新築') }),
      normalizeSite({ id: newId(), code: '25-088', name: '【サンプル】C工場 照明更新工事', kindId: kind('設備更新'), status: 'done', completedOn: doneC[doneC.length - 1] }),
      normalizeSite({ id: newId(), code: '25-071', name: '【サンプル】D学校 新築電気工事', kindId: kind('新築'), status: 'done', completedOn: doneD[doneD.length - 1] }),
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
    let n = 0;
    const plan = [
      [sites[0], weekdaysBack(todayIso, 10), employees[0], 0.1], // 改修はやや手間がかかる想定
      [sites[1], weekdaysBack(todayIso, 10), employees[1], 0],
      [sites[2], doneC, employees[2], 0.05],
      // D 現場は工数を一日おきにしか入れていない想定（工数の入力率が低い例）
      [sites[3], doneD, employees[1], -0.05, true],
    ];
    const places = ['1F 東側', '1F 西側', '2F 東側', '2F 西側', '3F', '屋上', 'EPS'];
    for (const [site, days, emp, bias, partialInput] of plan) {
      const dayItems = [];
      days.forEach((date, i) => {
        const phase = phases[Math.min(phases.length - 1, Math.floor((i / days.length) * phases.length))];
        const items = [];
        dayItems.push({ date, items });
        [...new Set([pick(phase), pick(phase)])].forEach((name, order) => {
          const people = 1 + Math.floor(rand() * 3);
          const hours = pick([8, 8, 8, 6, 4, 3.5]);
          const manDays = (people * hours) / (state.settings.hoursPerManDay || 8);
          const hard = rand() < 0.15;
          // 実績は基準の 0.85〜1.3 倍程度でばらつかせ、難の作業は 1.4 倍程度手間がかかる想定
          const factor = (0.85 + rand() * 0.45 + bias) * (hard ? 1.4 : 1);
          const raw = manDays / (baseRates.get(name) * factor);
          const quantity = raw >= 20 ? Math.round(raw / 5) * 5 : Math.max(1, Math.round(raw));
          const entry = {
            id: newId(), date, siteId: site.id, workTypeId: wt(name).id, people, hours,
            // 一部の日は数量を翌日にまとめて入力した想定で空欄にする
            quantity: rand() < 0.12 ? '' : quantity,
            hard, note: hard ? '高所作業' : '', inputBy: emp.id, order, createdAt: Date.now() + n++,
          };
          if (!(partialInput && i % 2 === 1)) state.entries.push(entry);
          items.push({ place: pick(places), work: name, workTypeId: wt(name).id, people, manDays });
        });
      });
      // 日報: 今日の作業は工数と同じ内容、明日の予定は翌営業日の作業
      dayItems.forEach(({ date, items }, i) => {
        const next = dayItems[i + 1];
        // 出面は作業時間から出した人工を 0.5 刻みで切り上げたもの（準備・片付けの分だけ工数より多くなる）
        const total = Math.ceil(items.reduce((sum, x) => sum + x.manDays, 0) * 2) / 2;
        const subs = total >= 3 && rand() < 0.4 ? [{ name: '△△電設', people: 1 }] : [];
        const tasks = items.map((x) => normalizeTask({
          place: x.place, work: x.work, workTypeId: x.workTypeId,
          status: next && rand() < 0.25 ? 'partial' : 'done',
        }));
        tasks.filter((t) => t.status === 'partial').forEach((t) => { t.memo = '残り約半分'; });
        const tomorrow = (next ? next.items : [{ place: '3F', work: '照明器具取付', workTypeId: (wt('照明器具取付') || {}).id || '' }])
          .map((x) => normalizePlan({ place: x.place, work: x.work, workTypeId: x.workTypeId }));
        state.reports.push(normalizeReport({
          date, siteId: site.id, inputBy: emp.id, weather: pick(['晴', '晴', '曇', '雨']),
          crew: { own: total - subs.reduce((sum, x) => sum + x.people, 0), subs },
          tasks, tomorrow,
          notes: rand() < 0.2 ? '元請と打合せ。天井内の検査日程を確認。' : '',
          // 作成・更新日時はその日の 17:30 とする
          createdAt: new Date(date + 'T17:30:00').getTime(),
          updatedAt: new Date(date + 'T17:30:00').getTime(),
        }));
      });
    }

    // ふりかえりの例（A 現場の 2 日前の日報）
    const aReports = reportsOfSite(state, sites[0].id);
    if (aReports[2]) {
      aReports[2].reflection = '午前中に資材を各階へ上げておいたので、午後の配管がスムーズに進んだ。3F は天井材が先行しているので明日は脚立の段取りを先に。';
    }

    // 現場ノートと予定（稼働中の現場）
    sites[0].notebook = {
      contacts: '元請 ○○建設 現場代理人 佐藤様 090-0000-0000（サンプル）',
      hours: '朝礼 8:00（1F 詰所前）。作業は 8:30〜17:00',
      rules: '入館証を守衛室で受け取り、退館時に返却。病棟側は 9:00〜11:00 騒音作業禁止',
      places: '鍵: 詰所のキーボックス（番号は代理人に確認）。資材: B1 倉庫。図面: 詰所の棚',
      cautions: '稼働中の病院のため、通路に資材を置かない。3F 手術室系統は停電作業禁止',
      other: '',
    };
    sites[1].notebook = {
      contacts: '元請 △△工務店 工事主任 田中様 080-0000-0000（サンプル）',
      hours: '朝礼 7:50（ゲート前）',
      rules: '新規入場時は送り出し教育の書類が必要',
      places: '資材: 1F 東側の仮置き場。図面: 詰所',
      cautions: '', other: '',
    };
    const ahead = (days) => { const d = new Date(todayIso + 'T00:00:00'); d.setDate(d.getDate() + days); return isoLocal(d); };
    state.events.push(
      { id: newId(), siteId: sites[0].id, date: ahead(3), title: '天井内配線の検査（元請立会い）' },
      { id: newId(), siteId: sites[0].id, date: ahead(7), title: '照明器具 搬入（10:00 着）' },
      { id: newId(), siteId: sites[1].id, date: ahead(2), title: '分電盤 搬入' },
    );
    return { sites, employees };
  }

  const Core = {
    addSampleData, isEmptyRow, isSiteDone, dayEntries, saveDaySheet, previousDayRows,
    WEATHERS, TASK_STATUS, NOTEBOOK_FIELDS, normalizeReport, findReport, reportsOfSite, previousReport,
    draftReport, syncCarryOver, validateReport, saveReport, crewTotal, upcomingEvents, reportSubmission, subcontractorNames,
    monthlyMatrix, siteDateRange, siteLabel, normalizeSite,
    DEFAULT_TAXONOMY, DEFAULT_SITE_KINDS, UNCATEGORIZED, emptyState,
    companyRates, companyRatesToCsv, siteCoverage, rateTargetSites, searchReports, workTypesToCsv, importWorkTypesCsv, parseTable, decodeText, mergeDefaultTaxonomy, defaultUnit,
    findOrAddCategory, findOrAddWorkType, workTypesOfCategory,
    newId, round2, parseTime, hoursFromRange, isBlank, entryQuantity, entryManHours, validateEntry,
    filterEntries, aggregate, pivotByDate, productivity,
    entriesToCsv, parseCsv, importCsv, nameLookup, normalizeState,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  else global.Core = Core;
})(typeof window !== 'undefined' ? window : globalThis);
