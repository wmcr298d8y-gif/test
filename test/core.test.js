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
  assert.ok(csv.startsWith('\uFEFF日付,作番,現場,大分類,小分類'));
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

test('normalizeState: 廃止した歩掛りマスタ・比較設定・元請紐づけを取り除き、工事区分を補う', () => {
  const s = Core.normalizeState({
    categories: [{ id: 'c1', name: '配管工事' }],
    workTypes: [{ id: 'a', categoryId: 'c1', name: '電線管敷設（露出）', unit: 'm', standardRate: 0.02 }],
    rateMasters: [{ id: 'm1', name: '国交省', rates: { a: 0.02 } }],
    sites: [{ id: 's1', name: 'A', rateMasterId: 'm1' }],
    settings: { compareMasterIds: ['m1'], hoursPerManDay: 8 },
  });
  assert.equal('rateMasters' in s, false);
  assert.equal('compareMasterIds' in s.settings, false);
  assert.equal('standardRate' in s.workTypes[0], false);
  assert.equal('rateMasterId' in s.sites[0], false);
  assert.deepEqual(s.siteKinds.map((k) => k.name), Core.DEFAULT_SITE_KINDS);
  assert.equal(s.sites[0].kindId, '');
});

function rateState() {
  const s = sampleState();
  s.siteKinds = [{ id: 'k1', name: '新築' }, { id: 'k2', name: '改修' }];
  s.sites = [
    Core.normalizeSite({ id: 'A', name: 'A', status: 'done', kindId: 'k1' }),
    Core.normalizeSite({ id: 'B', name: 'B', status: 'done', kindId: 'k2' }),
    Core.normalizeSite({ id: 'C', name: 'C', status: 'done', kindId: 'k1' }),
    Core.normalizeSite({ id: 'D', name: 'D', status: 'active', kindId: 'k1' }),
  ];
  const e = (siteId, date, people, quantity, hard = false) => ({ id: siteId + date, siteId, date, workTypeId: 'w1', people, hours: 8, quantity, hard });
  s.entries = [
    e('A', '2026-06-01', 2, 100),         // A: 2 人工 / 100m = 0.02
    e('B', '2026-07-01', 2, 50),          // B: 2 人工 / 50m
    e('B', '2026-07-02', 2, '', true),    //    + 数量なしの日（難）2 人工 → B: 4 人工 / 50m = 0.08
    e('C', '2026-08-01', 3, ''),          // C: 数量を一度も入れていない → 計算から除外
    e('D', '2026-09-01', 5, 10),          // D: 稼働中
  ];
  return s;
}

test('companyRates: 完工現場の人工合計 ÷ 数量合計。数量未記録の現場は除外し件数を返す', () => {
  const s = rateState();
  const [r] = Core.companyRates(s);
  assert.equal(r.workTypeId, 'w1');
  assert.equal(r.unit, 'm');
  assert.equal(r.manDays, 6);           // A 2 + B 4（C は除外）
  assert.equal(r.quantity, 150);
  assert.equal(r.rate, 0.04);           // 6 / 150
  assert.equal(r.output, 25);
  assert.equal(r.sites, 2);
  assert.equal(r.sitesNoQuantity, 1);
  assert.equal(r.siteMin, 0.02);
  assert.equal(r.siteMax, 0.08);
  assert.equal(r.hardShare, 33.33);     // 難 2 人工 / 6 人工
});

test('companyRates: 稼働中を含める・工事区分・難度・期間で絞り込む', () => {
  const s = rateState();
  const one = (opt) => Core.companyRates(s, opt)[0] || null;
  assert.equal(one({ doneOnly: false }).sites, 3);         // D を含む
  assert.equal(one({ kindId: 'k1' }).rate, 0.02);          // 新築の完工現場 = A のみ（C は数量なし）
  assert.equal(one({ kindId: 'k2' }).rate, 0.08);
  assert.equal(one({ difficulty: 'normal' }).rate, 0.027); // 難を除く: (2 + 2) / 150
  // 難のみ: 対象は数量なしの日だけ → 数量を記録した現場がないので歩掛りは出ない
  assert.equal(one({ difficulty: 'hard' }).rate, null);
  assert.equal(one({ difficulty: 'hard' }).sitesNoQuantity, 1);
  assert.equal(one({ from: '2026-07-01', to: '2026-07-31' }).rate, 0.08);
});

test('companyRatesToCsv: 条件行と見出し・値', () => {
  const s = rateState();
  const csv = Core.companyRatesToCsv(s, Core.companyRates(s), '完工現場のみ');
  const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], '条件: 完工現場のみ');
  assert.equal(lines[1], '大分類,小分類,単位,実績歩掛り(人工/単位),1人工あたり施工量,現場数,最小,最大,数量合計,人工合計,難の割合(%)');
  assert.equal(lines[2], '配管工事,電線管敷設（露出）,m,0.04,25,2,0.02,0.08,150,6,33.33');
});

test('saveDaySheet / previousDayRows: 難度を保存し、呼び出しでも引き継ぐ', () => {
  const s = sampleState();
  s.entries = [];
  Core.saveDaySheet(s, '2026-09-24', 's1', [{ workTypeId: 'w1', people: 1, hours: 8, hard: true }, { workTypeId: 'w2', people: 1, hours: 8 }]);
  assert.deepEqual(Core.dayEntries(s, '2026-09-24', 's1').map((e) => e.hard), [true, false]);
  assert.deepEqual(Core.previousDayRows(s, 's1', '2026-09-25').rows.map((r) => r.hard), [true, false]);
  const csv = Core.entriesToCsv(s, s.entries);
  assert.match(csv, /,難,/);
  const dst = Core.emptyState();
  Core.importCsv(dst, csv);
  assert.deepEqual(dst.entries.map((e) => e.hard).sort(), [false, true]);
});

test('addSampleData: 稼働中 2・完工 2 現場、社員、工事区分、難度を追加し、自社実績歩掛りを出せる', () => {
  const s = Core.emptyState();
  const { sites, employees } = Core.addSampleData(s, '2026-09-25');
  assert.equal(s.sites.length, 4);
  assert.equal(employees.length, 3);
  assert.deepEqual(sites.map((x) => x.status), ['active', 'active', 'done', 'done']);
  assert.ok(sites.every((x) => s.siteKinds.some((k) => k.id === x.kindId)));
  assert.match(sites[0].code, /^\d{2}-\d{3}$/);
  const datesOf = (site) => [...new Set(s.entries.filter((e) => e.siteId === site.id).map((e) => e.date))].sort();
  assert.equal(datesOf(sites[0]).length, 10);
  assert.equal(datesOf(sites[0]).pop(), '2026-09-25');
  // 完工現場は完工日で記録が終わっている
  for (const site of sites.slice(2)) assert.equal(datesOf(site).pop(), site.completedOn);
  assert.ok(s.entries.every((e) => Core.validateEntry(e).length === 0 && e.inputBy));
  assert.ok(s.entries.some((e) => e.hard) && s.entries.some((e) => !e.hard));
  assert.ok(s.entries.every((e) => [0, 6].indexOf(new Date(e.date + 'T00:00:00').getDay()) < 0));
  const rates = Core.companyRates(s);
  assert.ok(rates.length > 0);
  assert.ok(rates.some((r) => r.sites >= 2));
  for (const r of rates.filter((x) => x.rate !== null)) assert.ok(r.siteMin <= r.rate && r.rate <= r.siteMax);
  // 同じ日付なら同じ内容になる
  const t = Core.emptyState();
  Core.addSampleData(t, '2026-09-25');
  assert.deepEqual(t.entries.map((e) => [e.date, e.people, e.quantity, e.hard]), s.entries.map((e) => [e.date, e.people, e.quantity, e.hard]));
});

test('saveDaySheet: 1 日・1 現場の複数工種をまとめて保存・更新・削除', () => {
  const s = sampleState();
  s.entries = [];
  const rows = [
    { workTypeId: 'w1', people: 2, hours: 4, quantity: 30 },
    { workTypeId: 'w3', people: 2, hours: 4, quantity: 12 },
    { workTypeId: '', people: 1, hours: 8, quantity: '' }, // 空行は無視
    { workTypeId: 'w2', people: 1, hours: 8, quantity: '', note: '器具 3F' },
  ];
  const r1 = Core.saveDaySheet(s, '2026-09-25', 's1', rows, 1000, { inputBy: 'emp1' });
  assert.deepEqual(r1, { errors: [], saved: 3, added: 3, removed: 0 });
  let day = Core.dayEntries(s, '2026-09-25', 's1');
  assert.deepEqual(day.map((e) => [e.workTypeId, e.people * e.hours, e.order]), [['w1', 8, 0], ['w3', 8, 1], ['w2', 8, 2]]);
  assert.ok(day.every((e) => e.inputBy === 'emp1'));

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
  assert.deepEqual(prev.rows, [{ workTypeId: 'w3', people: 2, hours: 8, quantity: '', note: '', hard: false }]);
  assert.equal(Core.previousDayRows(s, 's1', '2026-09-03').date, '2026-09-01');
  assert.equal(Core.previousDayRows(s, 's1', '2026-09-01').date, null);
});

test('saveDaySheet: 入力者の必須チェックと、完工現場への保存禁止', () => {
  const s = sampleState();
  const row = [{ workTypeId: 'w1', people: 1, hours: 8 }];
  assert.match(Core.saveDaySheet(s, '2026-09-25', 's1', row, 1, { requireInputBy: true }).errors[0], /入力者/);
  // 入力者を変えずに再保存したときは前回の入力者を残す
  Core.saveDaySheet(s, '2026-09-25', 's1', row, 1, { inputBy: 'emp1' });
  const saved = Core.dayEntries(s, '2026-09-25', 's1');
  Core.saveDaySheet(s, '2026-09-25', 's1', saved.map((e) => ({ ...e, people: 2 })));
  assert.equal(Core.dayEntries(s, '2026-09-25', 's1')[0].inputBy, 'emp1');

  s.sites[0].status = 'done';
  const before = s.entries.length;
  const res = Core.saveDaySheet(s, '2026-09-26', 's1', row, 1, { inputBy: 'emp1' });
  assert.match(res.errors[0], /完工/);
  assert.equal(s.entries.length, before);
  assert.equal(Core.isSiteDone(s, 's1'), true);
  assert.equal(Core.isSiteDone(s, 's2'), false);
});

test('monthlyMatrix: 月 × 小分類の延べ工数', () => {
  const entries = [
    { date: '2026-08-30', workTypeId: 'a', people: 2, hours: 8 },
    { date: '2026-08-31', workTypeId: 'b', people: 1, hours: 4 },
    { date: '2026-09-01', workTypeId: 'a', people: 1, hours: 8 },
    { date: '2026-09-02', workTypeId: 'a', people: 3, hours: 2.5 },
  ];
  const m = Core.monthlyMatrix(entries, (e) => e.workTypeId);
  assert.deepEqual(m.months, ['2026-08', '2026-09']);
  assert.deepEqual(m.rows.get('a'), { '2026-08': 16, '2026-09': 15.5 });
  assert.deepEqual(m.rows.get('b'), { '2026-08': 4 });
  assert.equal(m.totals.get('a'), 31.5);
  assert.deepEqual(m.monthTotals, { '2026-08': 20, '2026-09': 15.5 });
  assert.equal(m.total, 35.5);
});

test('作番: 表示・CSV・取り込みでの照合', () => {
  const s = sampleState();
  s.sites[0].code = '26-015';
  s.employees = [{ id: 'emp1', code: 'E001', name: '山田 太郎' }];
  s.entries[0].inputBy = 'emp1';
  const names = Core.nameLookup(s);
  assert.equal(names.site('s1'), '26-015 A現場');
  assert.equal(names.siteName('s1'), 'A現場');
  assert.equal(names.site('s2'), 'B現場'); // 作番なし
  const csv = Core.entriesToCsv(s, s.entries);
  assert.match(csv, /2026-09-01,26-015,A現場,配管工事,電線管敷設（露出）,3,8,24,3,,,,山田 太郎,/);

  // 作番で既存の現場に紐づく（現場名が違っていても）
  const dst = Core.emptyState();
  dst.sites = [Core.normalizeSite({ id: 'x', code: '26-015', name: 'A現場（正式名称）' })];
  dst.employees = [{ id: 'emp9', code: 'E001', name: '山田 太郎' }];
  const { added, errors } = Core.importCsv(dst, csv);
  assert.deepEqual(errors, []);
  assert.equal(added, 4);
  assert.equal(dst.sites.length, 2); // A は既存、B は作番なし → 名前で新規
  const a = dst.entries.filter((e) => e.siteId === 'x');
  assert.equal(a.length, 2);
  assert.equal(a.find((e) => e.people === 3).inputBy, 'emp9');
});

test('siteDateRange', () => {
  const s = sampleState();
  assert.deepEqual(Core.siteDateRange(s, 's1'), { first: '2026-09-01', last: '2026-09-01' });
  assert.deepEqual(Core.siteDateRange(s, 'none'), { first: '', last: '' });
});

// ---------- 日報 ----------

function reportState() {
  const s = sampleState();
  s.reports = [];
  s.employees = [{ id: 'emp1', code: 'E001', name: '山田 太郎' }];
  return s;
}

test('日報: 保存・置き換え・空行の除去', () => {
  const s = reportState();
  const r = Core.draftReport(s, '2026-09-24', 's1').report;
  r.inputBy = 'emp1';
  r.weather = '晴';
  r.crew = { own: 3, subs: [{ name: '△△電設', people: 2 }, { name: '', people: 0 }] };
  r.tasks = [
    { id: 't1', place: '2F 西側', work: '配管', workTypeId: 'w1', status: 'done', memo: '' },
    { id: 't2', place: '3F', work: '分電盤 据付', workTypeId: '', status: 'partial', memo: '盤2面のうち1面' },
    { id: 't3', place: '', work: '', status: '', memo: '' }, // 空行
  ];
  r.tomorrow = [{ id: 'p1', place: '3F', work: '盤内結線' }];
  const res = Core.saveReport(s, r, 100, { requireInputBy: true });
  assert.deepEqual(res.errors, []);
  assert.equal(s.reports.length, 1);
  const saved = Core.findReport(s, '2026-09-24', 's1');
  assert.equal(saved.tasks.length, 2);
  assert.deepEqual(saved.crew, { own: 3, subs: [{ name: '△△電設', people: 2 }] });
  assert.equal(Core.crewTotal(saved), 5);
  assert.equal(saved.createdAt, 100);

  // 同じ日・現場は置き換え（作成日時は残る）
  const again = Core.draftReport(s, '2026-09-24', 's1');
  assert.equal(again.saved, true);
  again.report.notes = '元請と打合せ';
  Core.saveReport(s, again.report, 200);
  assert.equal(s.reports.length, 1);
  assert.equal(Core.findReport(s, '2026-09-24', 's1').notes, '元請と打合せ');
  assert.equal(Core.findReport(s, '2026-09-24', 's1').createdAt, 100);
  assert.equal(Core.findReport(s, '2026-09-24', 's1').updatedAt, 200);
});

test('日報: 入力チェック（入力者・作業・協力会社名・完工現場）', () => {
  const s = reportState();
  const r = Core.draftReport(s, '2026-09-24', 's1').report;
  let errs = Core.validateReport(s, r, { requireInputBy: true });
  assert.ok(errs.some((e) => /入力者/.test(e)));
  assert.ok(errs.some((e) => /今日の作業/.test(e)));
  r.notes = '雨天のため作業中止'; // 作業がない日は特記事項があれば保存できる
  r.inputBy = 'emp1';
  assert.deepEqual(Core.validateReport(s, r, { requireInputBy: true }), []);
  r.crew.subs = [{ name: '', people: 2 }];
  assert.ok(Core.validateReport(s, r).some((e) => /協力会社の名前/.test(e)));
  r.crew.subs = [];
  s.sites[0].status = 'done';
  assert.ok(Core.validateReport(s, r).some((e) => /完工/.test(e)));
  assert.equal(Core.saveReport(s, r).report, null);
  assert.equal(s.reports.length, 0);
});

test('日報の下書き: 前回の「明日の予定」＋途中・未着手の持ち越し、出面は前回と同じ', () => {
  const s = reportState();
  s.reports.push(Core.normalizeReport({
    date: '2026-09-24', siteId: 's1',
    crew: { own: 3, subs: [{ name: '△△電設', people: 1 }] },
    tasks: [
      { place: '2F 西側', work: '配管', status: 'done' },
      { place: '3F', work: '分電盤 据付', status: 'partial', memo: '1面残り' },
      { place: '1F', work: 'ボックス取付', status: 'notyet' }, // 旧データの未着手 → 途中として繰越
    ],
    tomorrow: [
      { place: '3F', work: '分電盤 据付' },   // 途中の作業と同じ → 重複させない
      { place: '3F', work: '盤内結線', workTypeId: 'w3' },
    ],
  }));
  // 別の現場・古い日報は影響しない
  s.reports.push(Core.normalizeReport({ date: '2026-09-20', siteId: 's1', tomorrow: [{ work: '古い予定' }] }));
  s.reports.push(Core.normalizeReport({ date: '2026-09-24', siteId: 's2', tomorrow: [{ work: '他現場' }] }));

  const d = Core.draftReport(s, '2026-09-26', 's1'); // 間に休日があっても直近の日報から
  assert.equal(d.saved, false);
  assert.equal(d.fromDate, '2026-09-24');
  // 予定から入った作業は状態が未選択（完了・途中・繰越を選んでもらう）
  assert.deepEqual(d.report.tasks.map((t) => [t.place, t.work, t.status]), [
    ['3F', '分電盤 据付', ''],
    ['3F', '盤内結線', ''],
    ['1F', 'ボックス取付', ''],
  ]);
  assert.equal(d.report.tasks[1].workTypeId, 'w3');
  // 前回途中だった作業の進み具合は参考表示用に引き継ぎ、入力欄（memo）には入れない
  assert.equal(d.report.tasks[0].prevMemo, '1面残り');
  assert.equal(d.report.tasks[0].memo, '');
  // 保存するときは参考表示を残さない
  const s2 = reportState();
  const r2 = { ...d.report, date: '2026-09-26', siteId: 's1', tasks: d.report.tasks.map((t) => ({ ...t, status: 'done' })) };
  Core.saveReport(s2, r2);
  assert.ok(Core.findReport(s2, '2026-09-26', 's1').tasks.every((t) => !t.prevMemo));
  assert.deepEqual(d.report.crew, { own: 3, subs: [{ name: '△△電設', people: 1 }] });
  assert.equal(d.report.weather, '');
  // 最初の日報は空
  assert.equal(Core.draftReport(s, '2026-09-01', 's1').fromDate, null);
});

test('syncCarryOver: 途中・未着手は明日の予定へ自動で入れ、完了にしたら外す（手書きの予定は残す）', () => {
  const r = Core.normalizeReport({
    tasks: [
      { id: 'a', place: '2F', work: '配管', status: 'partial' },
      { id: 'b', place: '3F', work: '盤', status: 'done' },
      { id: 'c', place: '', work: '', status: 'partial' }, // 空行は入れない
      { id: 'e', place: '1F', work: '未選択の作業', status: '' }, // 未選択は入れない
    ],
    tomorrow: [{ id: 'm', place: '1F', work: '器具搬入' }],
  });
  Core.syncCarryOver(r);
  assert.deepEqual(r.tomorrow.map((p) => [p.place, p.work, p.fromTaskId]), [['1F', '器具搬入', ''], ['2F', '配管', 'a']]);
  // 作業の内容を直すと自動の予定も追従
  r.tasks[0].place = '2F 西側';
  Core.syncCarryOver(r);
  assert.equal(r.tomorrow[1].place, '2F 西側');
  // 完了にしたら外れる
  r.tasks[0].status = 'done';
  Core.syncCarryOver(r);
  assert.deepEqual(r.tomorrow.map((p) => p.work), ['器具搬入']);
  // 予定から外した作業は、途中に戻しても自動では入れない
  r.tasks[0].status = 'partial';
  r.tasks[0].skipCarry = true;
  Core.syncCarryOver(r);
  assert.deepEqual(r.tomorrow.map((p) => p.work), ['器具搬入']);
  // 手書きの予定と同じ作業は二重に入れない
  r.tasks.push({ id: 'd', place: '1F', work: '器具搬入', workTypeId: '', status: 'partial', memo: '' });
  Core.syncCarryOver(r);
  assert.equal(r.tomorrow.length, 1);
});

test('予定・提出状況・協力会社の候補', () => {
  const s = reportState();
  s.events = [
    { id: 'e1', siteId: 's1', date: '2026-09-30', title: '検査' },
    { id: 'e2', siteId: 's1', date: '2026-09-20', title: '過去' },
    { id: 'e3', siteId: 's1', date: '2026-09-26', title: '搬入' },
    { id: 'e4', siteId: 's2', date: '2026-09-27', title: '他現場' },
  ];
  assert.deepEqual(Core.upcomingEvents(s, 's1', '2026-09-25').map((e) => e.title), ['搬入', '検査']);
  s.reports.push(Core.normalizeReport({ date: '2026-09-24', siteId: 's1', crew: { own: 1, subs: [{ name: '○○電工', people: 1 }] } }));
  s.reports.push(Core.normalizeReport({ date: '2026-09-25', siteId: 's1', crew: { own: 1, subs: [{ name: '△△電設', people: 2 }] } }));
  s.reports.push(Core.normalizeReport({ date: '2026-09-25', siteId: 's2' }));
  const sub = Core.reportSubmission(s, ['2026-09-24', '2026-09-25']);
  assert.deepEqual([...sub.get('s1')].sort(), ['2026-09-24', '2026-09-25']);
  assert.deepEqual([...sub.get('s2')], ['2026-09-25']);
  assert.deepEqual(Core.subcontractorNames(s), ['○○電工', '△△電設'].sort((a, b) => a.localeCompare(b, 'ja')));
  assert.deepEqual(Core.reportsOfSite(s, 's1').map((r) => r.date), ['2026-09-25', '2026-09-24']);
});

test('サンプル: 日報の「明日の予定」が翌営業日の下書きになる', () => {
  const s = Core.emptyState();
  const { sites } = Core.addSampleData(s, '2026-09-25');
  const reps = Core.reportsOfSite(s, sites[0].id);
  assert.equal(reps.length, 10);
  assert.ok(sites[0].notebook && sites[0].notebook.contacts);
  assert.ok(Core.upcomingEvents(s, sites[0].id, '2026-09-25').length >= 2);
  // 9/24 の明日の予定 = 9/25 の作業
  const d24 = reps.find((r) => r.date === '2026-09-24');
  const d25 = reps.find((r) => r.date === '2026-09-25');
  assert.deepEqual(d24.tomorrow.map((p) => p.work), d25.tasks.map((t) => t.work));
  // 出面の合計は工数（延べ人工）以上
  for (const r of reps) {
    const md = Core.dayEntries(s, r.date, r.siteId).reduce((sum, e) => sum + Core.entryManHours(e), 0) / 8;
    assert.ok(Core.crewTotal(r) >= md, r.date);
  }
});

test('normalizeState: 日報・予定を読み込む（旧データにはなくても空で補う）', () => {
  const s = Core.normalizeState({ reports: [{ date: '2026-09-25', siteId: 's1', tasks: [{ work: '配管' }] }] });
  assert.equal(s.reports[0].tasks[0].status, ''); // 状態なしは未選択
  assert.deepEqual(s.reports[0].crew, { own: 0, subs: [] });
  assert.deepEqual(Core.normalizeState({}).events, []);
});

test('出面は人工（0.5 刻みなど小数）で合計できる', () => {
  const r = Core.normalizeReport({ crew: { own: 2.5, subs: [{ name: '△△電設', people: 1.5 }, { name: '○○電工', people: 0.5 }] } });
  assert.equal(Core.crewTotal(r), 4.5);
  assert.equal(Core.crewTotal(null), 0);
});

test('carryOverTask: 今日やらなかった作業を明日の予定へ繰越（今日の作業からは外す）', () => {
  const r = Core.normalizeReport({
    tasks: [
      { id: 'a', place: '2F', work: '配管', status: '' },
      { id: 'b', place: '3F', work: '盤', status: 'partial' },
      { id: 'c', place: '1F', work: '器具搬入', status: '' },
    ],
    tomorrow: [{ id: 'm', place: '1F', work: '器具搬入' }],
  });
  Core.syncCarryOver(r); // b（途中）が自動で予定に入る
  assert.deepEqual(r.tomorrow.map((p) => p.work), ['器具搬入', '盤']);
  Core.carryOverTask(r, 'a');
  assert.deepEqual(r.tasks.map((t) => t.id), ['b', 'c']);
  assert.deepEqual(r.tomorrow.map((p) => [p.work, p.carried]), [['配管', true], ['器具搬入', false], ['盤', false]]);
  // 途中で自動に入っていた作業を繰越 → 自動の予定は繰越の予定に置き換わる（二重にならない）
  Core.carryOverTask(r, 'b');
  assert.deepEqual(r.tomorrow.map((p) => [p.work, p.carried, p.fromTaskId]), [['盤', true, ''], ['配管', true, ''], ['器具搬入', false, '']]);
  // 同じ作業がすでに予定にある場合は、その予定を繰越の印にするだけ
  Core.carryOverTask(r, 'c');
  assert.equal(r.tomorrow.length, 3);
  assert.equal(r.tomorrow.find((p) => p.work === '器具搬入').carried, true);
  assert.equal(r.tasks.length, 0);
  assert.equal(Core.carryOverTask(r, 'none'), null);
});

test('validateReport: 状態を選んでいない作業があると保存できない', () => {
  const s = reportState();
  const r = Core.normalizeReport({ date: '2026-09-25', siteId: 's1', tasks: [{ place: '2F', work: '配管', status: '' }, { place: '3F', work: '盤', status: 'done' }] });
  assert.ok(Core.validateReport(s, r).some((e) => /状態を選んでいない作業が 1 件/.test(e)));
  r.tasks[0].status = 'partial';
  assert.deepEqual(Core.validateReport(s, r), []);
});
