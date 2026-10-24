import { Lexer } from 'marked';
import type { Token, Tokens } from 'marked';
import * as path from 'path';

export type RenderableKind = 'code-block' | 'svg-file';

export type BlockContext =
    | { kind: 'top-level' }
    | { kind: 'indented'; linePrefix: string }
    | { kind: 'inline' };

export interface SizeHint {
    widthPx: number;
    heightPx?: number;
}

export interface RenderableBlock {
    kind: RenderableKind;
    context: BlockContext;
    start: number;
    end: number;
    source: string;
    original: string;
    hint: string;
    alt: string;
    sizeHint?: SizeHint;
}

export interface ScanRenderableBlocksOptions {
    languages?: Iterable<string>;
    includeSvgFiles?: boolean;
}

export interface SpliceResult {
    markdown: string;
    inserted: { syntheticPath: string; insertOffset: number }[];
}

interface Range {
    start: number;
    end: number;
}

interface FenceBlock extends Range {
    source: string;
    language: string;
    context: BlockContext;
}

const DEFAULT_LANGUAGES = new Set(['mermaid']);

export function scanRenderableBlocks(
    markdown: string,
    options: ScanRenderableBlocksOptions = {}
): RenderableBlock[] {
    const languages = new Set([...options.languages ?? DEFAULT_LANGUAGES].map((value) => value.toLowerCase()));
    const excluded: Range[] = [];
    const blocks: RenderableBlock[] = [];

    const frontmatter = findFrontmatterRange(markdown);
    if (frontmatter) excluded.push(frontmatter);

    const fences = scanFencedBlocks(markdown);
    for (const fence of fences) {
        excluded.push(fence);
        if (languages.has(fence.language)) {
            blocks.push({
                kind: 'code-block',
                context: fence.context,
                start: fence.start,
                end: fence.end,
                source: fence.source,
                original: markdown.slice(fence.start, fence.end),
                hint: fence.language,
                alt: fence.language,
            });
        }
    }

    const inlineCodeRanges = scanInlineCodeRanges(markdown, excluded);
    excluded.push(...inlineCodeRanges);
    if (options.includeSvgFiles !== false) {
        blocks.push(...scanObsidianSvgEmbeds(markdown, excluded));
        blocks.push(...scanMarkdownSvgImages(markdown, excluded));
    }

    const unique = new Map<string, RenderableBlock>();
    for (const block of blocks) {
        const key = `${block.start}:${block.end}`;
        if (!unique.has(key)) unique.set(key, block);
    }
    return [...unique.values()].sort((a, b) => a.start - b.start);
}

export function spliceBlocks(
    markdown: string,
    replacements: { block: RenderableBlock; syntheticPath: string | null }[]
): SpliceResult {
    const ordered = [...replacements].sort((a, b) => b.block.start - a.block.start);
    let result = markdown;
    const inserted: { syntheticPath: string; insertOffset: number }[] = [];

    for (const { block, syntheticPath } of ordered) {
        if (syntheticPath === null) continue;
        const replacement = formatReplacement(block, syntheticPath);
        result = result.slice(0, block.start) + replacement + result.slice(block.end);
        inserted.push({
            syntheticPath,
            insertOffset: block.start,
        });
    }

    return { markdown: result, inserted: inserted.reverse() };
}

export function parseSizeHint(alias: string): SizeHint | undefined {
    const value = alias.trim();
    const match = /^(\d+)(?:x(\d+))?$/i.exec(value);
    if (!match) return undefined;
    const widthPx = Number(match[1]);
    const heightPx = match[2] ? Number(match[2]) : undefined;
    if (!isPositiveFinite(widthPx) || (heightPx !== undefined && !isPositiveFinite(heightPx))) {
        return undefined;
    }
    return { widthPx, heightPx };
}

export function isSvgPath(source: string): boolean {
    const withoutFragment = source.split('#', 1)[0].trim();
    return path.extname(withoutFragment).toLowerCase() === '.svg';
}

function scanFencedBlocks(markdown: string): FenceBlock[] {
    const lines = getLines(markdown);
    const result: FenceBlock[] = [];
    let open: {
        start: number;
        endOfOpeningLine: number;
        marker: '`' | '~';
        length: number;
        language: string;
        prefix: string;
        context: BlockContext;
    } | null = null;

    for (const line of lines) {
        const match = /^(.*?)([`~]{3,})([^\r\n]*)$/.exec(line.text);
        const fence = match && (match[2][0] === '`' || match[2][0] === '~') ? match : null;
        if (!open) {
            if (!fence || fence[1].replace(/ /g, '').length > 0 && !isIndentedFencePrefix(fence[1])) continue;
            const marker = fence[2][0] as '`' | '~';
            const info = fence[3].trim();
            const language = (info.split(/[\s{]/, 1)[0] ?? '').toLowerCase();
            const prefix = fence[1];
            open = {
                start: line.start,
                endOfOpeningLine: line.end,
                marker,
                length: fence[2].length,
                language,
                prefix,
                context: classifyFenceContext(prefix),
            };
            continue;
        }

        if (fence && fence[2][0] === open.marker && fence[2].length >= open.length) {
            const end = line.end;
            const contentStart = open.endOfOpeningLine;
            const contentEnd = line.start;
            const rawContent = markdownSliceForLines(markdown, contentStart, contentEnd);
            const source = removeLinePrefix(rawContent, open.prefix);
            result.push({
                start: open.start,
                end,
                source,
                language: open.language,
                context: open.context,
            });
            open = null;
        }
    }
    return result;
}

function scanObsidianSvgEmbeds(markdown: string, excluded: Range[]): RenderableBlock[] {
    const blocks: RenderableBlock[] = [];
    const pattern = /!\[\[([^\]\r\n]+)\]\]/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(markdown))) {
        const rawStart = match.index;
        const rawEnd = rawStart + match[0].length;
        if (overlapsAny(rawStart, rawEnd, excluded)) continue;

        const inner = match[1];
        const pipe = inner.indexOf('|');
        const source = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
        if (!isSvgPath(source)) continue;
        const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() : '';
        const line = lineBoundsAt(markdown, rawStart);
        const before = markdown.slice(line.start, rawStart);
        const after = markdown.slice(rawEnd, line.end).trim();
        const standalone = after.length === 0 && isStandalonePrefix(before);
        const prefix = standalone ? markdown.slice(line.start, rawStart) : '';
        const context: BlockContext = standalone
            ? prefix.length > 0 ? { kind: 'indented', linePrefix: prefix } : { kind: 'top-level' }
            : { kind: 'inline' };
        const start = standalone ? line.start : rawStart;
        const end = standalone ? line.end : rawEnd;
        blocks.push({
            kind: 'svg-file',
            context,
            start,
            end,
            source,
            original: markdown.slice(start, end),
            hint: source,
            alt: alias && !parseSizeHint(alias) ? alias : path.basename(source),
            sizeHint: parseSizeHint(alias),
        });
    }
    return blocks;
}

function scanMarkdownSvgImages(markdown: string, excluded: Range[]): RenderableBlock[] {
    const blocks: RenderableBlock[] = [];
    let tokens: Token[];
    try {
        tokens = Lexer.lex(markdown);
    } catch {
        return blocks;
    }

    let cursor = 0;
    const walk = (items: Token[], parentStart: number, parentRaw: string): void => {
        let childCursor = 0;
        for (const token of items) {
            const raw = typeof token.raw === 'string' ? token.raw : '';
            const relative = raw ? findRawOffset(parentRaw, raw, childCursor) : -1;
            if (relative < 0) continue;
            const absoluteStart = rawEndOffset(markdown, parentStart, parentRaw.slice(0, relative));
            const absoluteEnd = rawEndOffset(markdown, absoluteStart, raw);
            childCursor = relative + raw.length;

            if (token.type === 'image') {
                const image = token as Tokens.Image;
                if (isSvgPath(image.href)
                    && !overlapsAny(absoluteStart, absoluteEnd, excluded)
                    && normalizeLineEndings(markdown.slice(absoluteStart, absoluteEnd)) === normalizeLineEndings(raw)) {
                    const bounds = lineBoundsAt(markdown, absoluteStart);
                    const before = markdown.slice(bounds.start, absoluteStart);
                    const after = markdown.slice(absoluteEnd, bounds.end).trim();
                    const standalone = after.length === 0 && isStandalonePrefix(before);
                    blocks.push({
                        kind: 'svg-file',
                        context: standalone
                            ? bounds.start === absoluteStart
                                ? { kind: 'top-level' }
                                : { kind: 'indented', linePrefix: markdown.slice(bounds.start, absoluteStart) }
                            : { kind: 'inline' },
                        start: standalone ? bounds.start : absoluteStart,
                        end: standalone ? bounds.end : absoluteEnd,
                        source: image.href,
                        original: markdown.slice(standalone ? bounds.start : absoluteStart, standalone ? bounds.end : absoluteEnd),
                        hint: image.href,
                        alt: image.text || path.basename(image.href),
                    });
                }
            }

            const nested = (token as Token & { tokens?: Token[] }).tokens;
            if (nested && nested.length > 0) walk(nested, absoluteStart, raw);
            for (const group of nestedTokenGroups(token)) {
                walk(group, absoluteStart, raw);
            }
        }
    };

    for (const token of tokens) {
        const raw = typeof token.raw === 'string' ? token.raw : '';
        if (!raw) continue;
        const start = findRawOffset(markdown, raw, cursor);
        if (start < 0) continue;
        cursor = rawEndOffset(markdown, start, raw);
        if (!overlapsAny(start, cursor, excluded)) {
            walk([token], start, raw);
        }
    }
    return blocks;
}

function formatReplacement(block: RenderableBlock, syntheticPath: string): string {
    const alt = escapeAlt(block.alt || path.basename(block.hint));
    const image = `![${alt}](${syntheticPath})`;
    const lineEnding = /\r?\n$/.exec(block.original)?.[0] ?? '';
    if (block.context.kind === 'indented') {
        return `${block.context.linePrefix}${image}${lineEnding}`;
    }
    return `${image}${block.context.kind === 'inline' ? '' : lineEnding}`;
}

function nestedTokenGroups(token: Token): Token[][] {
    const value = token as Token & {
        items?: { tokens?: Token[] }[];
        header?: { tokens?: Token[] }[];
        rows?: { tokens?: Token[] }[][];
    };
    const groups: Token[][] = [];
    for (const item of value.items ?? []) {
        if (item.tokens?.length) groups.push(item.tokens);
    }
    for (const cell of value.header ?? []) {
        if (cell.tokens?.length) groups.push(cell.tokens);
    }
    for (const row of value.rows ?? []) {
        for (const cell of row) {
            if (cell.tokens?.length) groups.push(cell.tokens);
        }
    }
    return groups;
}

function escapeAlt(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/[[\]]/g, (character) => `\\${character}`);
}

function findFrontmatterRange(markdown: string): Range | null {
    const firstLine = /^(---|\+\+\+)\r?\n/.exec(markdown);
    if (!firstLine || firstLine[1] !== '---') return null;
    const close = /^(---|\.\.\.)\s*\r?$/gm;
    close.lastIndex = firstLine[0].length;
    const match = close.exec(markdown);
    return match ? { start: 0, end: match.index + match[0].length } : { start: 0, end: markdown.length };
}

function scanInlineCodeRanges(markdown: string, excluded: Range[]): Range[] {
    const result: Range[] = [];
    const pattern = /(`+)([\s\S]*?)\1/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(markdown))) {
        if (!overlapsAny(match.index, match.index + match[0].length, excluded)) {
            result.push({ start: match.index, end: match.index + match[0].length });
        }
    }
    return result;
}

function getLines(markdown: string): { start: number; end: number; text: string }[] {
    const result: { start: number; end: number; text: string }[] = [];
    let start = 0;
    while (start <= markdown.length) {
        const newline = markdown.indexOf('\n', start);
        const end = newline >= 0 ? newline + 1 : markdown.length;
        result.push({ start, end, text: markdown.slice(start, end).replace(/\r?\n$/, '') });
        if (newline < 0) break;
        start = newline + 1;
    }
    return result;
}

function lineBoundsAt(markdown: string, offset: number): { start: number; end: number } {
    const start = markdown.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
    const newline = markdown.indexOf('\n', offset);
    return { start, end: newline >= 0 ? newline + 1 : markdown.length };
}

function markdownSliceForLines(markdown: string, start: number, end: number): string {
    return markdown.slice(start, end);
}

function removeLinePrefix(value: string, prefix: string): string {
    if (!prefix) return value;
    return value.split(/(?<=\n)/).map((line) => line.startsWith(prefix) ? line.slice(prefix.length) : line).join('');
}

function classifyFenceContext(prefix: string): BlockContext {
    if (!prefix) return { kind: 'top-level' };
    return { kind: 'indented', linePrefix: prefix };
}

function isStandalonePrefix(prefix: string): boolean {
    return /^(?: {0,3}(?:> ?|(?:[-+*]|\d+[.)]) ?)?|)$/.test(prefix);
}

function isIndentedFencePrefix(prefix: string): boolean {
    return /^ {0,3}(?:> ?|(?:[-+*]|\d+[.)]) ?)?$/.test(prefix);
}

function overlapsAny(start: number, end: number, ranges: Range[]): boolean {
    return ranges.some((range) => start < range.end && end > range.start);
}

function normalizeLineEndings(value: string): string {
    return value.replace(/\r\n/g, '\n');
}

function findRawOffset(haystack: string, needle: string, from: number): number {
    const normalizedNeedle = normalizeLineEndings(needle);
    const direct = haystack.indexOf(needle, from);
    if (direct >= 0) return direct;
    const parts = normalizedNeedle.split('\n').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp(parts.join('\\r?\\n'), 'g');
    pattern.lastIndex = from;
    const match = pattern.exec(haystack);
    return match?.index ?? -1;
}

function rawEndOffset(markdown: string, start: number, raw: string): number {
    let sourceIndex = start;
    for (let rawIndex = 0; rawIndex < raw.length; rawIndex += 1) {
        if (raw[rawIndex] === '\n' && markdown[sourceIndex] === '\r') sourceIndex += 1;
        sourceIndex += 1;
    }
    return sourceIndex;
}

function isPositiveFinite(value: number): boolean {
    return Number.isFinite(value) && value > 0;
}
