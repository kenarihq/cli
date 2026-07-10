import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli.js';

test('main is callable', async () => {
  assert.equal(typeof main, 'function');
});
