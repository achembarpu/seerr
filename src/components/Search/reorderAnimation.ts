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
