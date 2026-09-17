const test = require('node:test');
const assert = require('node:assert/strict');
const { ValorantOcrState, parseScore, parseTimer } = require('../electron/valorant-ocr-state.cjs');

test('numeric OCR normalization fixes common glyph substitutions', () => {
  assert.deepEqual(parseScore(' O8 '), { value: 8, normalized: '08', valid: true });
  assert.deepEqual(parseTimer('I:O7'), { value: 67, normalized: '1:07', valid: true });
  assert.equal(parseTimer('9:99').valid, false);
});

test('scores lock, advance by one, and never decrease or jump', () => {
  const state = new ValorantOcrState();
  state.observe('homeScore', { text: '3', confidence: 0.97 }, 1000);
  assert.equal(state.snapshot(1000).fields.homeScore.value, 3);
  state.observe('homeScore', { text: '2', confidence: 0.99 }, 1100);
  assert.equal(state.snapshot(1100).fields.homeScore.value, 3);
  assert.equal(state.snapshot(1100).fields.homeScore.reason, 'score-decrease');
  state.observe('homeScore', { text: '5', confidence: 0.99 }, 1200);
  assert.equal(state.snapshot(1200).fields.homeScore.value, 3);
  state.observe('homeScore', { text: '4', confidence: 0.97 }, 1300);
  assert.equal(state.snapshot(1300).fields.homeScore.value, 4);
});

test('one-frame medium-confidence hallucinations are rejected', () => {
  const state = new ValorantOcrState();
  state.observe('awayScore', { text: '7', confidence: 0.8 }, 1000);
  assert.equal(state.snapshot(1000).fields.awayScore.value, null);
  state.observe('awayScore', { text: '1', confidence: 0.8 }, 1100);
  assert.equal(state.snapshot(1100).fields.awayScore.value, null);
  state.observe('awayScore', { text: '1', confidence: 0.8 }, 1200);
  assert.equal(state.snapshot(1200).fields.awayScore.value, 1);
});

test('timer predicts between reads and rejects implausible jumps', () => {
  const state = new ValorantOcrState();
  state.observe('timer', { text: '1:30', confidence: 0.95 }, 1000);
  assert.equal(state.snapshot(2000).fields.timer.displayValue, '1:29');
  state.observe('timer', { text: '0:20', confidence: 0.99 }, 2100);
  assert.equal(state.snapshot(2100).fields.timer.value, 89);
  assert.equal(state.snapshot(2100).fields.timer.reason, 'timer-jump');
  state.observe('timer', { text: '1:28', confidence: 0.9 }, 2200);
  assert.equal(state.snapshot(2200).fields.timer.value, 88);
});

test('stale fields retain trusted values and clear resets all locks', () => {
  const state = new ValorantOcrState();
  state.observe('homeScore', { text: '4', confidence: 0.99 }, 1000);
  const stale = state.snapshot(7001).fields.homeScore;
  assert.equal(stale.value, 4);
  assert.equal(stale.stale, true);
  const cleared = state.clear(8000);
  assert.equal(cleared.fields.homeScore.value, null);
  assert.equal(cleared.metrics.accepted, 0);
});
