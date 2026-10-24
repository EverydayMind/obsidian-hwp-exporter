/**
 * YAML front matter parser.
 * Frontmatter parsing helpers used by the shared HWPX converter.
 * TypeScript: gray-matter library
 */

import matter from 'gray-matter';
import type {
    MetaValue,
    MetaInlines,
    PandocInline,
} from './types';

export interface FrontmatterResult {
    metadata: Record<string, unknown>;
    content: string;
}

/**
 * Parse a Markdown string with YAML front matter.
 * Returns (metadata, markdownContent).
 */
export function parseMarkdownStringWithFrontmatter(markdownText: string): FrontmatterResult {
    const parsed = matter(markdownText);
    return {
        metadata: parsed.data,
        content: parsed.content,
    };
}

/**
 * Convert front matter metadata to Pandoc meta format.
 *
 * Input:  {"title": "Doc Title", "author": "Name"}
 * Output: {"title": {t: "MetaInlines", c: [{t:"Str",c:"Doc"},{t:"Space"},{t:"Str",c:"Title"}]}, ...}
 */
export function convertMetadataToPandocMeta(
    metadata: Record<string, unknown>
): Record<string, MetaValue> {
    const pandocMeta: Record<string, MetaValue> = {};

    for (const [key, value] of Object.entries(metadata)) {
        if (typeof value === 'string') {
            const inlines = textToInlines(value);
            pandocMeta[key] = { t: 'MetaInlines', c: inlines };
        } else if (Array.isArray(value)) {
            const items = value.map((v): MetaInlines => {
                const inlines = textToInlines(String(v));
                return { t: 'MetaInlines', c: inlines };
            });
            pandocMeta[key] = { t: 'MetaList', c: items };
        } else if (value instanceof Date) {
            // YAML dates (date: 2026-10-21) arrive as UTC midnight; keep them as written.
            const iso = Number.isNaN(value.getTime()) ? '' : value.toISOString();
            pandocMeta[key] = { t: 'MetaString', c: iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso };
        } else if (value !== null && typeof value === 'object') {
            pandocMeta[key] = {
                t: 'MetaMap',
                c: convertMetadataToPandocMeta(value as Record<string, unknown>),
            };
        } else if (typeof value === 'boolean') {
            pandocMeta[key] = { t: 'MetaBool', c: value };
        } else if (typeof value === 'number') {
            pandocMeta[key] = {
                t: 'MetaInlines',
                c: [{ t: 'Str', c: String(value) }],
            };
        } else {
            // Left: null, undefined (and bigint, which YAML parsers do not produce).
            const inlines = textToInlines(typeof value === 'bigint' ? value.toString() : '');
            pandocMeta[key] = { t: 'MetaInlines', c: inlines };
        }
    }

    return pandocMeta;
}

/**
 * Convert a plain text string to Pandoc inline elements (Str and Space).
 */
function textToInlines(text: string): PandocInline[] {
    if (!text) return [];

    const result: PandocInline[] = [];
    const words = text.split(' ');

    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        if (word) {
            result.push({ t: 'Str', c: word });
        }
        if (i < words.length - 1) {
            result.push({ t: 'Space' });
        }
    }

    return result;
}
