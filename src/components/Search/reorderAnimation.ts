export interface ReorderSnapshot {
  context: string;
  order: string;
  regularResults: string;
  suggestions: unknown;
  smartResults: unknown;
  gridWidth: number;
  viewportWidth: number;
  viewportHeight: number;
}

/** Animate only a new local/smart result order within the current search. */
export const shouldAnimateReorder = (
  previous: ReorderSnapshot | undefined,
  current: ReorderSnapshot,
  scrolling: boolean,
  paginating: boolean,
  reducedMotion: boolean
): boolean =>
  !!previous &&
  !scrolling &&
  !paginating &&
  !reducedMotion &&
  previous.context === current.context &&
  previous.regularResults === current.regularResults &&
  previous.gridWidth === current.gridWidth &&
  previous.viewportWidth === current.viewportWidth &&
  previous.viewportHeight === current.viewportHeight &&
  previous.order !== current.order &&
  (previous.suggestions !== current.suggestions ||
    previous.smartResults !== current.smartResults);

export interface ReorderPosition {
  x: number;
  y: number;
}

/** Continue from the old visual position when a second reorder interrupts one. */
export const retargetReorderOrigin = (
  previous: ReorderPosition,
  visual: ReorderPosition,
  layout: ReorderPosition
): ReorderPosition => ({
  x: previous.x + visual.x - layout.x,
  y: previous.y + visual.y - layout.y,
});

/** Forget finished or canceled animations without deleting a newer replacement. */
export const trackReorderAnimation = <T extends { finished: Promise<unknown> }>(
  animations: Map<string, T>,
  key: string,
  animation: T
): void => {
  animations.set(key, animation);
  const forget = () => {
    if (animations.get(key) === animation) animations.delete(key);
  };
  void animation.finished.then(forget, forget);
};
