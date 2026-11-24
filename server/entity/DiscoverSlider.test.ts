import { defaultSliders, DiscoverSliderType } from '@server/constants/discover';
import { getRepository } from '@server/datasource';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import DiscoverSlider from './DiscoverSlider';

setupTestDb();

it('adds smart recommendations after Trending while preserving a customized layout', async () => {
  const sliders = getRepository(DiscoverSlider);
  const existing = defaultSliders
    .filter(({ type }) => type !== DiscoverSliderType.SMART_RECOMMENDATIONS)
    .map((slider) => new DiscoverSlider(slider));
  const trending = existing.find(
    ({ type }) => type === DiscoverSliderType.TRENDING
  )!;
  const studios = existing.find(
    ({ type }) => type === DiscoverSliderType.STUDIOS
  )!;
  [trending.order, studios.order] = [studios.order, trending.order];
  studios.enabled = false;
  await sliders.save(existing);

  const original = await sliders.find({ order: { order: 'ASC' } });
  await DiscoverSlider.bootstrapSliders();
  const updated = await sliders.find({ order: { order: 'ASC' } });
  const recs = updated.findIndex(
    ({ type }) => type === DiscoverSliderType.SMART_RECOMMENDATIONS
  );
  assert.equal(updated[recs - 1]?.type, DiscoverSliderType.TRENDING);
  assert.deepEqual(
    updated
      .filter((_, i) => i !== recs)
      .map(({ id, enabled }) => ({ id, enabled })),
    original.map(({ id, enabled }) => ({ id, enabled }))
  );

  await DiscoverSlider.bootstrapSliders();
  assert.equal(await sliders.count(), updated.length);
});
