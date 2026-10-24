/**
 * Table layout helpers: numeric cells and content-based column widths (plan 3.5).
 * Split out of markdownToHwpx.ts (plan 2.1).
 */

import type { PandocBlock } from '../types';
import { getPlainText } from './inlineText';

// A cell that holds only a number: 1,200 / -3.5 / 12% / ₩1,000 / 1,000원.
export const NUMERIC_CELL = /^[-+±]?[₩$€¥£]?\s?\d[\d,]*(?:\.\d+)?\s?(?:%|원|천원|백만원|억원|개|건|명|회|배)?$/;


/** Display width of text: wide (Hangul, CJK, fullwidth) characters count as two. */
export function displayWidth(text: string): number {
    let width = 0;
    for (const ch of text) {
        width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
    }
    return width;
}


/** Column widths proportional to the longest cell text, each kept between 10% and 60% of the table. */
export function contentColumnWidths(rows: unknown[][], colCount: number, totalWidth: number): number[] {
    const longest = Array.from({ length: colCount }, () => 4);
    for (const cells of rows) {
        let col = 0;
        for (const raw of cells) {
            const cell = raw as [unknown, unknown, number, number, PandocBlock[]];
            const span = Math.max(1, cell[3] ?? 1);
            if (span === 1 && col < colCount) {
                const text = (cell[4] ?? []).map((blk) => (blk.t === 'Plain' || blk.t === 'Para' ? getPlainText(blk.c) : '')).join(' ');
                longest[col] = Math.max(longest[col], displayWidth(text.trim()));
            }
            col += span;
        }
    }
    const minRatio = Math.min(0.1, 1 / colCount);
    const maxRatio = Math.max(0.6, 1 / colCount);
    // Columns that hit a bound are fixed there; the rest share what is left by length.
    const fixed = new Map<number, number>();
    let ratios: number[] = [];
    for (let pass = 0; pass <= colCount; pass++) {
        const free = longest.map((_v, i) => i).filter((i) => !fixed.has(i));
        const remaining = 1 - [...fixed.values()].reduce((a, b) => a + b, 0);
        const freeSum = free.reduce((sum, i) => sum + longest[i], 0) || 1;
        ratios = longest.map((value, i) => fixed.get(i) ?? (value / freeSum) * remaining);
        const over = free.filter((i) => ratios[i] > maxRatio);
        const under = free.filter((i) => ratios[i] < minRatio);
        if (over.length === 0 && under.length === 0) break;
        over.forEach((i) => fixed.set(i, maxRatio));
        if (over.length === 0) under.forEach((i) => fixed.set(i, minRatio));
    }
    return ratios.map((r) => Math.round(r * totalWidth));
}
