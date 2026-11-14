import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cosine, prepareCosine, quantize } from './vectors';

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
  it('produces the same scores for prepared queries, signed bytes, and slices', () => {
    const bytes = Buffer.from([5, 0, 127, 128, 255, 17, 10, 30, 60]);
    const query = bytes.subarray(1, 6);
    const score = prepareCosine(query);
    for (const candidate of [
      bytes.subarray(3, 8),
      Buffer.from([255, 128, 0, 127, 1]),
      Buffer.alloc(5),
      Buffer.alloc(4),
    ]) {
      assert.equal(score(candidate), cosine(query, candidate));
    }
    assert.equal(prepareCosine(Buffer.alloc(0))(Buffer.alloc(0)), 0);
    assert.equal(prepareCosine(Buffer.alloc(3))(Buffer.alloc(3)), 0);
  });
});
