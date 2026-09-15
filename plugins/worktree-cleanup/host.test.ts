import assert from 'node:assert/strict';
import test from 'node:test';
import { newestMeaningfulTimestamp, unixTimestampMs } from './activity.js';
import { isResidue } from './residue.js';

test('uses commit time when ignored cache churn is the only filesystem activity', () => {
  const commit = Date.parse('2026-09-03T06:49:35Z');
  assert.equal(newestMeaningfulTimestamp(commit, []), commit);
});

test('uses the newest tracked or non-ignored untracked file timestamp', () => {
  const commit = Date.parse('2026-09-03T06:49:35Z');
  const changedFile = Date.parse('2026-09-14T03:00:00Z');
  assert.equal(newestMeaningfulTimestamp(commit, [changedFile]), changedFile);
});

test('parses Git commit seconds safely', () => {
  assert.equal(unixTimestampMs('1788418175'), 1788418175000);
  assert.equal(unixTimestampMs('not-a-timestamp'), null);
});

test('classifies only narrow generated and temporary paths as residue', () => {
  assert.equal(isResidue('node_modules'), true);
  assert.equal(isResidue('shared/node_modules'), true);
  assert.equal(isResidue('backend/ext_storage/logs/.__scheduler.lock'), true);
  assert.equal(isResidue('.DS_Store'), true);
  assert.equal(isResidue('src/feature.ts'), false);
  assert.equal(isResidue('.env'), false);
  assert.equal(isResidue('dist/release.js'), false);
});
