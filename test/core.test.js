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
