import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReviewerOutput, reviewId } from './review.js';

test('parses a bounded structured reviewer verdict', () => {
  const result = parseReviewerOutput('```json\n{"verdict":"uncertain","confidence":0.4,"intent":"Unknown","rationale":"Needs a person","evidence":[]}\n```');
  assert.equal(result.verdict, 'uncertain');
});

test('review identifiers change when the content fingerprint changes', () => {
  assert.notEqual(reviewId('host', '/tmp/w', 'one'), reviewId('host', '/tmp/w', 'two'));
});
