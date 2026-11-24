import { defaultSliders, DiscoverSliderType } from '@server/constants/discover';
import { getRepository } from '@server/datasource';
import logger from '@server/logger';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  MoreThanOrEqual,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity()
class DiscoverSlider {
  public static async bootstrapSliders(): Promise<void> {
    const sliderRepository = getRepository(DiscoverSlider);

    await sliderRepository.manager.transaction(async (manager) => {
      const sliders = manager.getRepository(DiscoverSlider);
      for (const defaults of defaultSliders) {
        const existing = await sliders.findOneBy({ type: defaults.type });
        if (existing) continue;

        const slider = new DiscoverSlider(defaults);
        if (slider.type === DiscoverSliderType.SMART_RECOMMENDATIONS) {
          const trending = await sliders.findOneBy({
            type: DiscoverSliderType.TRENDING,
          });
          if (trending) slider.order = trending.order + 1;
          await sliders.increment(
            { order: MoreThanOrEqual(slider.order) },
            'order',
            1
          );
        }
        logger.info('Creating built-in discovery slider', {
          label: 'Discover Slider',
          slider,
        });
        await sliders.save(slider);
      }
    });
  }

  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'int' })
  public type: DiscoverSliderType;

  @Column({ type: 'int' })
  public order: number;

  @Column({ default: false })
  public isBuiltIn: boolean;

  @Column({ default: true })
  public enabled: boolean;

  @Column({ nullable: true })
  // Title is not required for built in sliders because we will
  // use translations for them.
  public title?: string;

  @Column({ nullable: true })
  public data?: string;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<DiscoverSlider>) {
    Object.assign(this, init);
  }
}

export default DiscoverSlider;
