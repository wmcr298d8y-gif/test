const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../js/core.js');

function sampleState() {
  const s = Core.emptyState();
  s.sites = [{ id: 's1', name: 'A現場' }, { id: 's2', name: 'B現場' }];
  s.workTypes = [{ id: 'w1', name: '土工事' }, { id: 'w2', name: '型枠工事' }];
  s.entries = [
    { id: 'e1', date: '2026-09-01', siteId: 's1', workTypeId: 'w1', people: 3, hours: 8 },
    { id: 'e2', date: '2026-09-01', siteId: 's1', workTypeId: 'w2', people: 2, hours: 4, note: 'カンマ,"引用"' },
    { id: 'e3', date: '2026-09-02', siteId: 's2', workTypeId: 'w1', people: 1, hours: 6 },
  ];
  return s;
}

test('hoursFromRange: 休憩を差し引き、日跨ぎに対応', () => {
  assert.equal(Core.hoursFromRange('08:00', '17:00', 60), 8);
  assert.equal(Core.hoursFromRange('08:30', '12:00', 0), 3.5);
  assert.equal(Core.hoursFromRange('22:00', '05:00', 60), 6);
  assert.equal(Core.hoursFromRange('bad', '05:00', 0), null);
  assert.equal(Core.hoursFromRange('08:00', '08:30', 60), 0);
});

test('validateEntry', () => {
  assert.deepEqual(Core.validateEntry({ date: '2026-09-01', siteId: 's', workTypeId: 'w', people: 1, hours: 8 }), []);
  assert.equal(Core.validateEntry({ date: '', siteId: '', workTypeId: '', people: 0, hours: 30 }).length, 5);
});

test('aggregate: 工種別の延べ工数と人工', () => {
  const s = sampleState();
  const rows = Core.aggregate(s.entries, (e) => e.workTypeId, 8);
  assert.deepEqual(rows.map((r) => [r.key, r.manHours, r.manDays, r.count]), [
    ['w1', 30, 3.75, 2],
    ['w2', 8, 1, 1],
  ]);
});

test('filterEntries: 期間と現場', () => {
  const s = sampleState();
  assert.deepEqual(Core.filterEntries(s.entries, { from: '2026-09-02' }).map((e) => e.id), ['e3']);
  assert.deepEqual(Core.filterEntries(s.entries, { siteId: 's1', to: '2026-09-01' }).map((e) => e.id), ['e1', 'e2']);
});

test('pivotByWorkTypeAndDate', () => {
  const { dates, rows } = Core.pivotByWorkTypeAndDate(sampleState().entries);
  assert.deepEqual(dates, ['2026-09-01', '2026-09-02']);
  assert.deepEqual(rows.get('w1'), { '2026-09-01': 24, '2026-09-02': 6 });
});

test('CSV 出力 → 取り込みで往復できる', () => {
  const src = sampleState();
  const csv = Core.entriesToCsv(src, src.entries);
  assert.ok(csv.startsWith('﻿日付,現場,工種'));

  const dst = Core.emptyState();
  const { added, errors } = Core.importCsv(dst, csv);
  assert.deepEqual(errors, []);
  assert.equal(added, 3);
  assert.ok(dst.sites.some((x) => x.name === 'B現場'));
  const e2 = dst.entries.find((e) => e.hours === 4);
  assert.equal(e2.note, 'カンマ,"引用"');
  const names = Core.nameLookup(dst);
  assert.equal(names.workType(e2.workTypeId), '型枠工事');
});

test('importCsv: 不正行はエラーとして報告', () => {
  const s = Core.emptyState();
  const { added, errors } = Core.importCsv(s, '日付,現場,工種,人数,時間(h/人)\n2026/09/01,A,土工事,2,8\nxx,A,土工事,1,8\n');
  assert.equal(added, 1);
  assert.equal(s.entries[0].date, '2026-09-01');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^3行目/);
});

test('normalizeState: 壊れたデータでも既定値で補完', () => {
  const s = Core.normalizeState({ entries: [{ id: 'x' }], settings: { hoursPerManDay: 7.5 } });
  assert.equal(s.entries.length, 1);
  assert.equal(s.settings.hoursPerManDay, 7.5);
  assert.equal(s.workTypes.length, Core.DEFAULT_WORK_TYPES.length);
  assert.equal(Core.normalizeState(null).entries.length, 0);
});

test('productivity: 歩掛り = 人工合計 ÷ 数量合計（数量未入力日の工数も含む）', () => {
  const s = Core.emptyState();
  s.workTypes = [{ id: 'kata', name: '型枠工事', unit: 'm²', standardRate: 0.1 }, { id: 'do', name: '土工事', unit: 'm³', standardRate: '' }];
  s.entries = [
    // 型枠: 4人×8h=4人工 で 30m²、翌日 2人×8h=2人工（数量なし）、翌々日 2人×8h=2人工 で 50m²
    { date: '2026-09-01', siteId: 'A', workTypeId: 'kata', people: 4, hours: 8, quantity: 30 },
    { date: '2026-09-02', siteId: 'A', workTypeId: 'kata', people: 2, hours: 8, quantity: '' },
    { date: '2026-09-03', siteId: 'B', workTypeId: 'kata', people: 2, hours: 8, quantity: 50 },
    // 土工事: 数量なし
    { date: '2026-09-01', siteId: 'A', workTypeId: 'do', people: 1, hours: 8 },
  ];
  const rows = Core.productivity(s.entries, s.workTypes, 8);
  const kata = rows.find((r) => r.workTypeId === 'kata');
  assert.equal(kata.manDays, 8);
  assert.equal(kata.quantity, 80);
  assert.equal(kata.rate, 0.1);       // 8人工 / 80m²
  assert.equal(kata.output, 10);      // 80m² / 8人工
  assert.equal(kata.ratio, 100);      // 標準 0.1 と同じ
  assert.equal(kata.unit, 'm²');
  assert.equal(kata.days, 3);
  assert.equal(kata.quantityDays, 2);

  const doko = rows.find((r) => r.workTypeId === 'do');
  assert.equal(doko.rate, null);
  assert.equal(doko.ratio, null);

  const bySite = Core.productivity(s.entries, s.workTypes, 8, { bySite: true });
  const a = bySite.find((r) => r.siteId === 'A' && r.workTypeId === 'kata');
  const b = bySite.find((r) => r.siteId === 'B' && r.workTypeId === 'kata');
  assert.equal(a.rate, 0.2);          // 6人工 / 30m²
  assert.equal(b.rate, 0.04);         // 2人工 / 50m²
  assert.equal(a.ratio, 200);
});

test('validateEntry: 数量は任意だが負数は不可', () => {
  const base = { date: '2026-09-01', siteId: 's', workTypeId: 'w', people: 1, hours: 8 };
  assert.deepEqual(Core.validateEntry({ ...base, quantity: '' }), []);
  assert.deepEqual(Core.validateEntry({ ...base, quantity: 12.5 }), []);
  assert.equal(Core.validateEntry({ ...base, quantity: -1 }).length, 1);
});

test('数量・単位も CSV で往復できる', () => {
  const src = Core.emptyState();
  src.sites = [{ id: 's1', name: 'A現場' }];
  src.workTypes = [{ id: 'w1', name: '鉄筋工事', unit: 't', standardRate: '' }];
  src.entries = [{ id: 'e1', date: '2026-09-01', siteId: 's1', workTypeId: 'w1', people: 5, hours: 8, quantity: 2.5 }];
  const csv = Core.entriesToCsv(src, src.entries);
  assert.match(csv, /,2\.5,t,/);
  const dst = Core.emptyState();
  dst.workTypes = [];
  const { added } = Core.importCsv(dst, csv);
  assert.equal(added, 1);
  assert.equal(dst.entries[0].quantity, 2.5);
  assert.equal(dst.workTypes[0].unit, 't');
});

test('normalizeState: 単位のない旧データの工種に既定単位を補う', () => {
  const s = Core.normalizeState({ workTypes: [{ id: 'a', name: '型枠工事' }, { id: 'b', name: '独自工種' }, { id: 'c', name: '土工事', unit: '台' }] });
  assert.equal(s.workTypes[0].unit, 'm²');
  assert.equal(s.workTypes[1].unit, '');
  assert.equal(s.workTypes[2].unit, '台');
});
