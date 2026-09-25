const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../js/core.js');

function sampleState() {
  const s = Core.emptyState();
  s.sites = [{ id: 's1', name: 'A現場' }, { id: 's2', name: 'B現場' }];
  s.categories = [{ id: 'c1', name: '配管工事' }, { id: 'c2', name: '照明・配線器具' }];
  s.workTypes = [
    { id: 'w1', categoryId: 'c1', name: '電線管敷設（露出）', unit: 'm' },
    { id: 'w2', categoryId: 'c2', name: '照明器具取付', unit: '台' },
    { id: 'w3', categoryId: 'c1', name: 'ボックス取付', unit: '個' },
  ];
  s.entries = [
    { id: 'e1', date: '2026-09-01', siteId: 's1', workTypeId: 'w1', people: 3, hours: 8 },
    { id: 'e2', date: '2026-09-01', siteId: 's1', workTypeId: 'w2', people: 2, hours: 4, note: 'カンマ,"引用"' },
    { id: 'e3', date: '2026-09-02', siteId: 's2', workTypeId: 'w1', people: 1, hours: 6 },
    { id: 'e4', date: '2026-09-02', siteId: 's2', workTypeId: 'w3', people: 1, hours: 2 },
  ];
  return s;
}

test('emptyState: 電気設備の標準工種が大分類・小分類で登録される', () => {
  const s = Core.emptyState();
  assert.equal(s.categories.length, Core.DEFAULT_TAXONOMY.length);
  const haikan = s.categories.find((c) => c.name === '配管工事');
  const items = Core.workTypesOfCategory(s, haikan.id);
  assert.ok(items.some((w) => w.name === '電線管敷設（露出）' && w.unit === 'm'));
  // すべての小分類が存在する大分類に属する
  const catIds = new Set(s.categories.map((c) => c.id));
  assert.ok(s.workTypes.every((w) => catIds.has(w.categoryId)));
  // ID の重複がない
  assert.equal(new Set(s.workTypes.map((w) => w.id)).size, s.workTypes.length);
});

test('mergeDefaultTaxonomy: 不足分だけ追加する', () => {
  const s = Core.emptyState();
  const before = s.workTypes.length;
  assert.equal(Core.mergeDefaultTaxonomy(s), 0);
  s.workTypes = s.workTypes.filter((w) => w.name !== 'LAN配線');
  assert.equal(Core.mergeDefaultTaxonomy(s), 1);
  assert.equal(s.workTypes.length, before);
});

test('hoursFromRange: 休憩を差し引き、日跨ぎに対応', () => {
  assert.equal(Core.hoursFromRange('08:00', '17:00', 60), 8);
  assert.equal(Core.hoursFromRange('08:30', '12:00', 0), 3.5);
  assert.equal(Core.hoursFromRange('22:00', '05:00', 60), 6);
  assert.equal(Core.hoursFromRange('bad', '05:00', 0), null);
  assert.equal(Core.hoursFromRange('08:00', '08:30', 60), 0);
});

test('validateEntry', () => {
  const base = { date: '2026-09-01', siteId: 's', workTypeId: 'w', people: 1, hours: 8 };
  assert.deepEqual(Core.validateEntry(base), []);
  assert.equal(Core.validateEntry({ date: '', siteId: '', workTypeId: '', people: 0, hours: 30 }).length, 5);
  assert.deepEqual(Core.validateEntry({ ...base, quantity: '' }), []);
  assert.deepEqual(Core.validateEntry({ ...base, quantity: 12.5 }), []);
  assert.equal(Core.validateEntry({ ...base, quantity: -1 }).length, 1);
});

test('aggregate: 小分類別・大分類別の延べ工数と人工', () => {
  const s = sampleState();
  const byWt = Core.aggregate(s.entries, (e) => e.workTypeId, 8);
  assert.deepEqual(byWt.map((r) => [r.key, r.manHours, r.manDays, r.count]), [
    ['w1', 30, 3.75, 2],
    ['w2', 8, 1, 1],
    ['w3', 2, 0.25, 1],
  ]);
  const catOf = new Map(s.workTypes.map((w) => [w.id, w.categoryId]));
  const byCat = Core.aggregate(s.entries, (e) => catOf.get(e.workTypeId), 8);
  assert.deepEqual(byCat.map((r) => [r.key, r.manHours]), [['c1', 32], ['c2', 8]]);
});

test('filterEntries: 期間・現場・大分類・小分類', () => {
  const s = sampleState();
  const ids = (f) => Core.filterEntries(s.entries, f, s.workTypes).map((e) => e.id);
  assert.deepEqual(ids({ from: '2026-09-02' }), ['e3', 'e4']);
  assert.deepEqual(ids({ siteId: 's1', to: '2026-09-01' }), ['e1', 'e2']);
  assert.deepEqual(ids({ categoryId: 'c1' }), ['e1', 'e3', 'e4']);
  assert.deepEqual(ids({ categoryId: 'c1', workTypeId: 'w3' }), ['e4']);
});

test('pivotByDate', () => {
  const s = sampleState();
  const catOf = new Map(s.workTypes.map((w) => [w.id, w.categoryId]));
  const { dates, rows } = Core.pivotByDate(s.entries, (e) => catOf.get(e.workTypeId));
  assert.deepEqual(dates, ['2026-09-01', '2026-09-02']);
  assert.deepEqual(rows.get('c1'), { '2026-09-01': 24, '2026-09-02': 8 });
});

test('nameLookup: 大分類 › 小分類', () => {
  const names = Core.nameLookup(sampleState());
  assert.equal(names.workTypeFull('w2'), '照明・配線器具 › 照明器具取付');
  assert.equal(names.categoryOfWorkType('w1'), '配管工事');
  assert.equal(names.workType('nope'), '(削除済み)');
});

test('productivity: 歩掛り = 人工合計 ÷ 数量合計（数量未入力日の工数も含む）', () => {
  const workTypes = [
    { id: 'kan', categoryId: 'c1', name: '電線管敷設（露出）', unit: 'm' },
    { id: 'lan', categoryId: 'c2', name: 'LAN配線', unit: 'm' },
  ];
  const entries = [
    // 配管: 2人×8h=2人工 で 60m、翌日 2人×8h=2人工（数量なし）、翌々日 2人×8h=2人工 で 140m
    { date: '2026-09-01', siteId: 'A', workTypeId: 'kan', people: 2, hours: 8, quantity: 60 },
    { date: '2026-09-02', siteId: 'A', workTypeId: 'kan', people: 2, hours: 8, quantity: '' },
    { date: '2026-09-03', siteId: 'B', workTypeId: 'kan', people: 2, hours: 8, quantity: 140 },
    { date: '2026-09-01', siteId: 'A', workTypeId: 'lan', people: 1, hours: 8 },
  ];
  const rows = Core.productivity(entries, workTypes, 8);
  const kan = rows.find((r) => r.workTypeId === 'kan');
  assert.equal(kan.manDays, 6);
  assert.equal(kan.quantity, 200);
  assert.equal(kan.rate, 0.03);       // 6人工 / 200m
  assert.equal(kan.output, 33.33);    // 200m / 6人工
  assert.equal(kan.unit, 'm');
  assert.equal(kan.categoryId, 'c1');
  assert.equal(kan.days, 3);
  assert.equal(kan.quantityDays, 2);

  const lan = rows.find((r) => r.workTypeId === 'lan');
  assert.equal(lan.rate, null);

  const bySite = Core.productivity(entries, workTypes, 8, { bySite: true });
  assert.equal(bySite.find((r) => r.siteId === 'A' && r.workTypeId === 'kan').rate, 0.067); // 4人工 / 60m
  assert.equal(bySite.find((r) => r.siteId === 'B' && r.workTypeId === 'kan').rate, 0.014); // 2人工 / 140m
});

test('productivity: categories を渡すと大分類・小分類の登録順に並ぶ', () => {
  const s = sampleState();
  const rows = Core.productivity(s.entries, s.workTypes, 8, { categories: s.categories });
  assert.deepEqual(rows.map((r) => r.workTypeId), ['w1', 'w3', 'w2']);
});

test('CSV 出力 → 取り込みで往復できる（大分類・小分類・数量）', () => {
  const src = sampleState();
  src.entries[0].quantity = 45.5;
  const csv = Core.entriesToCsv(src, src.entries);
  assert.ok(csv.startsWith('﻿日付,現場,大分類,小分類'));
  assert.match(csv, /配管工事,電線管敷設（露出）,.*,45\.5,m,/);

  const dst = Core.emptyState();
  const before = dst.workTypes.length;
  const { added, errors } = Core.importCsv(dst, csv);
  assert.deepEqual(errors, []);
  assert.equal(added, 4);
  // 標準工種と同名のものは既存の小分類に紐づき、増えない
  assert.equal(dst.workTypes.length, before);
  const names = Core.nameLookup(dst);
  const e1 = dst.entries.find((e) => e.quantity === 45.5);
  assert.equal(names.workTypeFull(e1.workTypeId), '配管工事 › 電線管敷設（露出）');
  const e2 = dst.entries.find((e) => e.hours === 4);
  assert.equal(e2.note, 'カンマ,"引用"');
  assert.ok(dst.sites.some((x) => x.name === 'B現場'));
});

test('importCsv: 旧形式（工種列のみ）は未分類に入れ、不正行はエラー報告', () => {
  const s = Core.emptyState();
  const { added, errors } = Core.importCsv(s, '日付,現場,工種,人数,時間(h/人)\n2026/09/01,A,独自作業,2,8\nxx,A,独自作業,1,8\n');
  assert.equal(added, 1);
  assert.equal(s.entries[0].date, '2026-09-01');
  assert.equal(Core.nameLookup(s).workTypeFull(s.entries[0].workTypeId), '未分類 › 独自作業');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^3行目/);
});

test('normalizeState: 旧データ（大分類なし）は工種を「未分類」にまとめる', () => {
  const s = Core.normalizeState({
    workTypes: [{ id: 'a', name: '照明器具取付' }, { id: 'b', name: '独自工種', unit: '台' }],
    entries: [{ id: 'x', workTypeId: 'a' }],
    settings: { hoursPerManDay: 7.5 },
  });
  assert.equal(s.categories.length, 1);
  assert.equal(s.categories[0].name, '未分類');
  assert.ok(s.workTypes.every((w) => w.categoryId === s.categories[0].id));
  assert.equal(s.workTypes[0].unit, '台'); // 標準工種と同名なら既定単位を補う
  assert.equal(s.workTypes[1].unit, '台');
  assert.equal(s.entries.length, 1);
  assert.equal(s.settings.hoursPerManDay, 7.5);
});

test('normalizeState: 壊れたデータでも既定値で補完', () => {
  const s = Core.normalizeState(null);
  assert.equal(s.entries.length, 0);
  assert.equal(s.categories.length, Core.DEFAULT_TAXONOMY.length);
  const t = Core.normalizeState({ entries: [] });
  assert.equal(t.categories.length, Core.DEFAULT_TAXONOMY.length);
});

test('compareStandards: 複数マスタ・各現場の元請マスタと比較', () => {
  const s = sampleState();
  s.entries = [
    { date: '2026-09-01', siteId: 's1', workTypeId: 'w1', people: 2, hours: 8, quantity: 100 }, // 0.02 人工/m
    { date: '2026-09-01', siteId: 's2', workTypeId: 'w1', people: 3, hours: 8, quantity: 100 }, // 0.03 人工/m
  ];
  const mlit = Core.addRateMaster(s, '国交省');
  const genA = Core.addRateMaster(s, '元請A');
  Core.setRate(mlit, 'w1', 0.025);
  Core.setRate(genA, 'w1', 0.02);
  s.sites[0].rateMasterId = genA.id; // s2 は未設定

  const all = Core.compareStandards(Core.productivity(s.entries, s.workTypes, 8), s, [mlit.id, Core.SITE_MASTER]);
  assert.equal(all[0].rate, 0.025);
  assert.deepEqual(all[0].standards[mlit.id], { masterId: mlit.id, rate: 0.025, ratio: 100 });
  // 現場ごとでない集計では現場マスタは比較できない
  assert.equal(all[0].standards[Core.SITE_MASTER].rate, null);

  const bySite = Core.compareStandards(Core.productivity(s.entries, s.workTypes, 8, { bySite: true }), s, [mlit.id, Core.SITE_MASTER]);
  const a = bySite.find((r) => r.siteId === 's1');
  const b = bySite.find((r) => r.siteId === 's2');
  assert.equal(a.standards[mlit.id].ratio, 80);
  assert.deepEqual(a.standards[Core.SITE_MASTER], { masterId: genA.id, rate: 0.02, ratio: 100 });
  assert.equal(b.standards[mlit.id].ratio, 120);
  assert.equal(b.standards[Core.SITE_MASTER].rate, null);
});

test('setRate / addRateMaster（複製）', () => {
  const s = sampleState();
  const m = Core.addRateMaster(s, '国交省');
  assert.equal(Core.setRate(m, 'w1', '0.04'), true);
  assert.equal(Core.rateOf(m, 'w1'), 0.04);
  assert.equal(Core.setRate(m, 'w1', '-1'), false);
  assert.equal(Core.setRate(m, 'w1', 'abc'), false);
  assert.equal(Core.rateOf(m, 'w1'), 0.04);
  const copy = Core.addRateMaster(s, 'コピー', { copyFromId: m.id });
  Core.setRate(copy, 'w1', 0.05);
  assert.equal(Core.rateOf(m, 'w1'), 0.04); // 元は変わらない
  Core.setRate(m, 'w1', '');
  assert.equal(Core.rateOf(m, 'w1'), null);
});

test('歩掛りマスタ CSV: ひな形出力 → 記入 → 取り込み（未登録の小分類は追加）', () => {
  const s = sampleState();
  const m = Core.addRateMaster(s, '国交省');
  Core.setRate(m, 'w2', 0.15);
  const csv = Core.rateMasterToCsv(s, m);
  const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], '大分類,小分類,単位,歩掛り(人工/単位)');
  assert.equal(lines.length, 1 + s.workTypes.length); // 未登録も空欄で出る
  assert.ok(lines.includes('照明・配線器具,照明器具取付,台,0.15'));

  const dst = Core.addRateMaster(s, '取込先');
  const filled = '﻿' + [
    '大分類,小分類,単位,歩掛り(人工/単位)',
    '配管工事,電線管敷設（露出）,m,0.035',
    '配管工事,ボックス取付,個,',            // 空欄は読み飛ばし
    '配管工事,"電線管敷設（露出）PF16",m,0.03', // 未登録 → 追加
    '配管工事,ケーブルラック敷設,m,abc',       // 不正値
  ].join('\r\n');
  const before = s.workTypes.length;
  const res = Core.importRateMasterCsv(s, dst, filled);
  assert.equal(res.updated, 2);
  assert.equal(res.createdWorkTypes, 1);
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0], /^5行目/);
  assert.equal(s.workTypes.length, before + 1);
  assert.equal(Core.rateOf(dst, 'w1'), 0.035);
  const added = s.workTypes.find((w) => w.name === '電線管敷設（露出）PF16');
  assert.equal(added.categoryId, 'c1');
  assert.equal(added.unit, 'm');
  assert.equal(Core.rateOf(dst, added.id), 0.03);
});

test('normalizeState: 旧形式の小分類の標準歩掛りをマスタへ移行', () => {
  const s = Core.normalizeState({
    categories: [{ id: 'c1', name: '配管工事' }],
    workTypes: [
      { id: 'a', categoryId: 'c1', name: '電線管敷設（露出）', unit: 'm', standardRate: 0.02 },
      { id: 'b', categoryId: 'c1', name: 'ボックス取付', unit: '個', standardRate: '' },
    ],
  });
  assert.equal(s.rateMasters.length, 1);
  assert.deepEqual(s.rateMasters[0].rates, { a: 0.02 });
  assert.deepEqual(s.settings.compareMasterIds, [s.rateMasters[0].id]);
  assert.ok(s.workTypes.every((w) => !('standardRate' in w)));
  // 設定の配列が既定値と共有されていない
  assert.notEqual(Core.emptyState().settings.compareMasterIds, Core.emptyState().settings.compareMasterIds);
});

test('addSampleData: 現場・マスタ・直近 10 営業日の記録を追加し、集計できる', () => {
  const s = Core.emptyState();
  const { sites, masters } = Core.addSampleData(s, '2026-09-25');
  assert.equal(s.sites.length, 2);
  assert.equal(s.rateMasters.length, 2);
  assert.match(masters[0].name, /サンプル/);
  assert.equal(sites[1].rateMasterId, masters[1].id);
  const dates = [...new Set(s.entries.map((e) => e.date))].sort();
  assert.equal(dates.length, 10);
  assert.equal(dates[dates.length - 1], '2026-09-25');
  assert.ok(dates.every((d) => ![0, 6].includes(new Date(d + 'T00:00:00').getDay())));
  assert.ok(s.entries.every((e) => Core.validateEntry(e).length === 0));
  const rows = Core.compareStandards(Core.productivity(s.entries, s.workTypes, 8, { bySite: true }), s, s.settings.compareMasterIds);
  assert.ok(rows.some((r) => r.standards[Core.SITE_MASTER].rate !== null));
  assert.ok(rows.every((r) => r.rate === null || r.standards[masters[0].id].ratio > 50));
  // 同じ日付なら同じ内容になる
  const t = Core.emptyState();
  Core.addSampleData(t, '2026-09-25');
  assert.deepEqual(t.entries.map((e) => [e.date, e.people, e.quantity]), s.entries.map((e) => [e.date, e.people, e.quantity]));
});

test('saveDaySheet: 1 日・1 現場の複数工種をまとめて保存・更新・削除', () => {
  const s = sampleState();
  s.entries = [];
  const rows = [
    { workTypeId: 'w1', people: 2, hours: 4, quantity: 30, worker: '田中' },
    { workTypeId: 'w3', people: 2, hours: 4, quantity: 12 },
    { workTypeId: '', people: 1, hours: 8, quantity: '' }, // 空行は無視
    { workTypeId: 'w2', people: 1, hours: 8, quantity: '', note: '器具 3F' },
  ];
  const r1 = Core.saveDaySheet(s, '2026-09-25', 's1', rows, 1000);
  assert.deepEqual(r1, { errors: [], saved: 3, added: 3, removed: 0 });
  let day = Core.dayEntries(s, '2026-09-25', 's1');
  assert.deepEqual(day.map((e) => [e.workTypeId, e.people * e.hours, e.order]), [['w1', 8, 0], ['w3', 8, 1], ['w2', 8, 2]]);
  assert.ok(s.workers.some((w) => w.name === '田中'));

  // 並べ替え・1 行更新・1 行削除
  const edited = [
    { ...day[2], note: '器具 3F〜4F' },
    { ...day[0], quantity: 35 },
  ];
  const r2 = Core.saveDaySheet(s, '2026-09-25', 's1', edited, 2000);
  assert.deepEqual(r2, { errors: [], saved: 2, added: 0, removed: 1 });
  day = Core.dayEntries(s, '2026-09-25', 's1');
  assert.deepEqual(day.map((e) => e.workTypeId), ['w2', 'w1']);
  assert.equal(day[1].quantity, 35);
  assert.equal(day[1].id, edited[1].id);
  assert.equal(day[1].createdAt, 1000);
  assert.equal(s.entries.length, 2);
});

test('saveDaySheet: エラーがあれば何も変えない / 他の日・現場には触れない', () => {
  const s = sampleState(); // s1 の 9/1 に 2 件、s2 の 9/2 に 2 件
  const before = JSON.stringify(s.entries);
  const bad = Core.saveDaySheet(s, '2026-09-01', 's1', [
    { workTypeId: 'w1', people: 2, hours: 8 },
    { workTypeId: 'w2', people: 0, hours: 30, quantity: -1 },
  ]);
  assert.equal(bad.saved, 0);
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /^作業2: /);
  assert.equal(JSON.stringify(s.entries), before);
  assert.match(Core.saveDaySheet(s, '2026-09-01', '', []).errors[0], /現場/);

  // s1 の 9/1 を全部消しても、s2 の記録は残る
  const res = Core.saveDaySheet(s, '2026-09-01', 's1', []);
  assert.equal(res.removed, 2);
  assert.deepEqual(s.entries.map((e) => e.id).sort(), ['e3', 'e4']);
});

test('saveDaySheet: 時間を変えた行は開始・終了時刻を消す', () => {
  const s = sampleState();
  s.entries = [{ id: 'x', date: '2026-09-25', siteId: 's1', workTypeId: 'w1', people: 1, hours: 8, start: '08:00', end: '17:00', breakMinutes: 60 }];
  Core.saveDaySheet(s, '2026-09-25', 's1', [{ id: 'x', workTypeId: 'w1', people: 2, hours: 8 }]);
  assert.equal(s.entries[0].start, '08:00');
  Core.saveDaySheet(s, '2026-09-25', 's1', [{ id: 'x', workTypeId: 'w1', people: 2, hours: 4 }]);
  assert.equal(s.entries[0].start, '');
});

test('previousDayRows: 同じ現場の直近の日の作業を数量なしで呼び出す', () => {
  const s = sampleState();
  s.entries.push({ id: 'e5', date: '2026-09-03', siteId: 's1', workTypeId: 'w3', people: 2, hours: 8, quantity: 10, note: 'x' });
  const prev = Core.previousDayRows(s, 's1', '2026-09-10');
  assert.equal(prev.date, '2026-09-03');
  assert.deepEqual(prev.rows, [{ workTypeId: 'w3', people: 2, hours: 8, worker: '', quantity: '', note: '' }]);
  assert.equal(Core.previousDayRows(s, 's1', '2026-09-03').date, '2026-09-01');
  assert.equal(Core.previousDayRows(s, 's1', '2026-09-01').date, null);
});
