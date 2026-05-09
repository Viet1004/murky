/**
 * Pure selector-generation logic for the picker. No DOM events here —
 * the overlay calls these functions to turn a clicked element into a
 * stable, repeating CSS selector that future page loads can re-apply.
 *
 * Strategy (borrowed in spirit from uBlock's epicker.js):
 *   1. Build a ladder of selectors from the clicked element up to <body>.
 *      Each rung: id > classes > tag:nth-of-type. Returned both as
 *      individual rungs (for refinement UI) and as a chained descendant
 *      selector (for resilience against generated class names).
 *   2. Auto-detect the "repeating ancestor" — the first element on the
 *      ladder whose siblings share a similar tag+class signature. That
 *      level is almost always the card / tile / post we want to mask.
 *
 * No uBlock code is reused — only the technique.
 */

const MAX_LADDER_DEPTH = 8;
const MIN_REPEATING_SIBLINGS = 2;
const SIBLING_SIGNATURE_THRESHOLD = 0.6;

export interface SelectorRung {
  /** A short selector for this single element (id / classes / tag:nth). */
  ownSelector: string;
  /** A chained descendant selector from the root down to this element. */
  chainedSelector: string;
  /** How many other elements on the page match `chainedSelector`. */
  matchCount: number;
  /** Element depth from the originally clicked node (0 = the click itself). */
  depthFromClick: number;
}

export interface SelectorLadder {
  rungs: SelectorRung[];
  /** Index of the rung the auto-detector picked as the repeating "card". */
  recommendedIndex: number;
}

/** CSS.escape that falls back gracefully on older runtimes. */
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

/** Normalize a class list so dynamic Tailwind/CSS-modules classes are skipped. */
function stableClasses(el: Element): string[] {
  const classes: string[] = [];
  for (const c of Array.from(el.classList)) {
    if (!c) continue;
    // Skip obviously generated classes: hashes, very long, all-numeric suffixes.
    if (c.length > 40) continue;
    if (/^[a-z]{1,3}-[0-9a-f]{6,}$/.test(c)) continue;
    if (/^_[a-zA-Z0-9]{4,}_/.test(c)) continue; // CSS modules
    classes.push(c);
  }
  return classes;
}

function ownSelectorFor(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (el.id && /^[a-zA-Z][\w-]{0,40}$/.test(el.id)) {
    return `#${cssEscape(el.id)}`;
  }
  const classes = stableClasses(el);
  if (classes.length > 0) {
    return `${tag}.${classes.map(cssEscape).join(".")}`;
  }
  // Fall back to nth-of-type within parent.
  const parent = el.parentElement;
  if (!parent) return tag;
  let i = 1;
  for (const sibling of Array.from(parent.children)) {
    if (sibling === el) break;
    if (sibling.tagName === el.tagName) i++;
  }
  return `${tag}:nth-of-type(${i})`;
}

/**
 * Tag + class signature used to compare siblings. Two siblings count as
 * "similar" if they share tag and at least SIBLING_SIGNATURE_THRESHOLD
 * fraction of their stable class names.
 */
function siblingSignature(el: Element): { tag: string; classes: Set<string> } {
  return { tag: el.tagName, classes: new Set(stableClasses(el)) };
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function countSimilarSiblings(el: Element): number {
  const parent = el.parentElement;
  if (!parent) return 0;
  const target = siblingSignature(el);
  let count = 0;
  for (const sibling of Array.from(parent.children)) {
    if (sibling === el) continue;
    const sig = siblingSignature(sibling);
    if (sig.tag !== target.tag) continue;
    if (jaccard(target.classes, sig.classes) >= SIBLING_SIGNATURE_THRESHOLD) {
      count++;
    }
  }
  return count;
}

/**
 * Build the selector ladder from `el` up to `<body>`. Each rung's
 * chainedSelector is "<parent rung's chained> > <own>" so it survives
 * minor DOM noise above the clicked element.
 */
export function buildLadder(el: Element): SelectorLadder {
  const path: Element[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.body && path.length < MAX_LADDER_DEPTH) {
    path.push(cur);
    cur = cur.parentElement;
  }

  // Build ladder bottom-up, so chainedSelector is built top-down using parent first.
  // Reverse so index 0 is the highest ancestor; we'll re-reverse at the end.
  const topDown = [...path].reverse();
  const chained: string[] = [];
  for (const node of topDown) {
    chained.push(ownSelectorFor(node));
  }

  const rungs: SelectorRung[] = [];
  for (let depthFromClick = 0; depthFromClick < path.length; depthFromClick++) {
    const node = path[depthFromClick];
    const cutFromTop = topDown.length - depthFromClick;
    const chainedSelector = chained.slice(0, cutFromTop).join(" > ");
    const own = chained[cutFromTop - 1];
    let matchCount = 0;
    try {
      matchCount = document.querySelectorAll(chainedSelector).length;
    } catch {
      matchCount = 0;
    }
    rungs.push({
      ownSelector: own,
      chainedSelector,
      matchCount,
      depthFromClick,
    });
  }

  return {
    rungs,
    recommendedIndex: pickRecommendedRung(rungs, path),
  };
}

/**
 * Pick the rung that looks most like a "card / tile / post":
 *   - Has at least MIN_REPEATING_SIBLINGS visually-similar siblings.
 *   - Selector matches a similar number of nodes on the page.
 *   - Prefer the deepest such ancestor (closer to the clicked image is
 *     usually the actual card; further up is the grid container).
 */
function pickRecommendedRung(
  rungs: SelectorRung[],
  path: Element[]
): number {
  let best = -1;
  let bestSiblings = 0;
  for (let i = 0; i < path.length; i++) {
    const siblings = countSimilarSiblings(path[i]);
    const matches = rungs[i].matchCount;
    if (siblings >= MIN_REPEATING_SIBLINGS && matches >= MIN_REPEATING_SIBLINGS + 1) {
      // Tie-break: prefer the deeper (smaller index) candidate when they
      // both qualify — that's the actual card, not the grid container.
      if (best === -1 || siblings > bestSiblings) {
        best = i;
        bestSiblings = siblings;
      }
    }
  }
  return best === -1 ? 0 : best;
}

/**
 * Sanity-check a saved selector at runtime: it must still match
 * something, and its match count shouldn't have exploded (which would
 * mean it's now matching half the page — DOM probably changed under us).
 */
export function selectorIsHealthy(selector: string): boolean {
  try {
    const n = document.querySelectorAll(selector).length;
    return n > 0 && n < 500;
  } catch {
    return false;
  }
}
