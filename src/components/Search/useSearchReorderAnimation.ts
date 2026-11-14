import { useEffect, useLayoutEffect, useRef } from 'react';
import {
  retargetReorderOrigin,
  shouldAnimateReorder,
  trackReorderAnimation,
  type ReorderPosition,
  type ReorderSnapshot,
} from './reorderAnimation';

interface Options {
  context: string;
  order: string;
  regularResults: string;
  suggestions: unknown;
  smartResults: unknown;
  paginating: boolean;
}

const useClientLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Move existing cards after async search sources change their order. */
export const useSearchReorderAnimation = ({
  context,
  order,
  regularResults,
  suggestions,
  smartResults,
  paginating,
}: Options) => {
  const gridRef = useRef<HTMLUListElement>(null);
  const previous = useRef<ReorderSnapshot | undefined>(undefined);
  const positions = useRef(new Map<string, ReorderPosition>());
  const animations = useRef(new Map<string, Animation>());
  const lastScroll = useRef(0);

  useEffect(() => {
    const activeAnimations = animations.current;
    const onScroll = () => {
      lastScroll.current = performance.now();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      activeAnimations.forEach((animation) => animation.cancel());
    };
  }, []);

  useClientLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const nodes = Array.from(
      grid.querySelectorAll<HTMLElement>(':scope > [data-result-key]')
    );
    const snapshot = {
      context,
      order,
      regularResults,
      suggestions,
      smartResults,
      gridWidth: grid.clientWidth,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
    const reducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const scrolling =
      lastScroll.current > 0 && performance.now() - lastScroll.current < 250;
    // Revalidation that leaves the geometry unchanged should not interrupt a
    // movement already in progress.
    if (
      animations.current.size &&
      previous.current &&
      !scrolling &&
      !paginating &&
      !reducedMotion &&
      previous.current.context === context &&
      previous.current.order === order &&
      previous.current.regularResults === regularResults &&
      previous.current.gridWidth === snapshot.gridWidth &&
      previous.current.viewportWidth === snapshot.viewportWidth &&
      previous.current.viewportHeight === snapshot.viewportHeight
    ) {
      previous.current = snapshot;
      return;
    }
    // Preserve the old animation's visual transform before canceling. React
    // has moved the node to its new slot, so its visual/layout delta is the
    // transform that was applied to its previous slot.
    const visualPositions = new Map<string, ReorderPosition>();
    if (animations.current.size) {
      nodes.forEach((node) => {
        const key = node.dataset.resultKey;
        if (!key || !animations.current.has(key)) return;
        const rect = node.getBoundingClientRect();
        visualPositions.set(key, { x: rect.left, y: rect.top });
      });
    }
    animations.current.forEach((animation) => animation.cancel());
    animations.current.clear();
    const gridRect = grid.getBoundingClientRect();
    const currentPositions = new Map<string, ReorderPosition>();
    const visualOrigins = new Map<string, ReorderPosition>();
    const visible = new Set<string>();
    nodes.forEach((node) => {
      const key = node.dataset.resultKey;
      if (!key) return;
      const rect = node.getBoundingClientRect();
      currentPositions.set(key, {
        x: rect.left - gridRect.left,
        y: rect.top - gridRect.top,
      });
      const visual = visualPositions.get(key);
      const prior = positions.current.get(key);
      if (visual && prior) {
        visualOrigins.set(
          key,
          retargetReorderOrigin(prior, visual, { x: rect.left, y: rect.top })
        );
      }
      if (rect.bottom >= 0 && rect.top <= window.innerHeight) visible.add(key);
    });
    if (
      shouldAnimateReorder(
        previous.current,
        snapshot,
        scrolling,
        paginating,
        reducedMotion
      )
    ) {
      nodes.forEach((node) => {
        const key = node.dataset.resultKey;
        const before =
          key && (visualOrigins.get(key) ?? positions.current.get(key));
        const after = key && currentPositions.get(key);
        if (
          !key ||
          !before ||
          !after ||
          !visible.has(key) ||
          typeof node.animate !== 'function'
        )
          return;
        const x = before.x - after.x;
        const y = before.y - after.y;
        // Very large jumps are easier to follow without a card flying across the page.
        if (Math.abs(x) + Math.abs(y) < 1 || Math.hypot(x, y) > 800) return;
        trackReorderAnimation(
          animations.current,
          key,
          node.animate(
            [
              { transform: `translate(${x}px, ${y}px)` },
              { transform: 'translate(0, 0)' },
            ],
            { duration: 240, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
          )
        );
      });
    }
    previous.current = snapshot;
    positions.current = currentPositions;
  }, [context, order, regularResults, suggestions, smartResults, paginating]);
  return gridRef;
};
