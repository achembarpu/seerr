import { useEffect, useLayoutEffect, useRef } from 'react';
import { shouldAnimateReorder, type ReorderSnapshot } from './reorderAnimation';

interface Options {
  context: string;
  order: string;
  regularResults: string;
  suggestions: unknown;
  smartResults: unknown;
  paginating: boolean;
}

type Position = { x: number; y: number };
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
  const positions = useRef(new Map<string, Position>());
  const animations = useRef<Animation[]>([]);
  const lastScroll = useRef(0);

  useEffect(() => {
    const onScroll = () => {
      lastScroll.current = performance.now();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      animations.current.forEach((animation) => animation.cancel());
    };
  }, []);

  useClientLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const nodes = Array.from(
      grid.querySelectorAll<HTMLElement>(':scope > [data-result-key]')
    );
    // Cancel previous FLIP transforms before measuring the new layout.
    animations.current.forEach((animation) => animation.cancel());
    animations.current = [];
    const gridRect = grid.getBoundingClientRect();
    const currentPositions = new Map<string, Position>();
    const visible = new Set<string>();
    nodes.forEach((node) => {
      const key = node.dataset.resultKey;
      if (!key) return;
      const rect = node.getBoundingClientRect();
      currentPositions.set(key, {
        x: rect.left - gridRect.left,
        y: rect.top - gridRect.top,
      });
      if (rect.bottom >= 0 && rect.top <= window.innerHeight) visible.add(key);
    });
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
        const before = key && positions.current.get(key);
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
        animations.current.push(
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
