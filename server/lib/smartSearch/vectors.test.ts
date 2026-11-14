import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cosine, quantize } from './vectors';

describe('compact semantic vectors', () => {
  it('preserves similarity including negative values', () => {
    const a = quantize([1, -2, 3]);
    assert.ok(cosine(a, quantize([2, -4, 6])) > 0.999);
    assert.ok(cosine(a, quantize([-1, 2, -3])) < -0.999);
    assert.equal(cosine(a, Buffer.alloc(2)), 0);
  });
  it('rejects invalid vectors', () => {
    assert.throws(() => quantize([0, 0]));
    assert.throws(() => quantize([NaN, 1]));
  });
});
