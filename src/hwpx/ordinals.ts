/**
 * Ordinal number styles used by template counters (roman numerals, Latin letters).
 * Split out of markdownToHwpx.ts (plan 2.1).
 */

// Roman numerals a template may write for the first items, as a standalone token.
export const ROMAN_ORDINAL = new RegExp(
    `(?<![A-Za-z0-9])(?:${['XVIII', 'XVII', 'XIII', 'VIII', 'XIV', 'XIX', 'XVI', 'XII', 'III', 'XV', 'XI', 'IX', 'IV', 'VI', 'VII', 'II', 'XX', 'X', 'V', 'I'].join('|')})(?![A-Za-z0-9])`,
    'i'
);


export function toRoman(value: number): string | null {
    if (!Number.isInteger(value) || value < 1 || value > 3999) return null;
    const table: Array<[number, string]> = [
        [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
        [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
    ];
    let rest = value;
    let out = '';
    for (const [amount, symbol] of table) {
        while (rest >= amount) {
            out += symbol;
            rest -= amount;
        }
    }
    return out;
}


/** 1 → A, 26 → Z, 27 → AA (bijective base 26). */
export function toLatinLetters(value: number): string {
    let rest = Math.max(1, Math.floor(value));
    let out = '';
    while (rest > 0) {
        rest -= 1;
        out = String.fromCharCode(65 + (rest % 26)) + out;
        rest = Math.floor(rest / 26);
    }
    return out;
}
