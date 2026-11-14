import assert from 'node:assert/strict';
import { it } from 'node:test';
import { serializeSmartSearchParams } from './smartSearchQuery';

it('encodes natural-language searches with spaces and literal plus signs', () => {
  const params = new URLSearchParams({ query: 'friends + family 日本' });
  assert.equal(
    serializeSmartSearchParams(params),
    'query=friends%20%2B%20family%20%E6%97%A5%E6%9C%AC'
  );
});
