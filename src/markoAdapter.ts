/**
 * Markdown AST to Pandoc-like dict adapter.
 * Markdown token adapter built on top of marked.
 * TypeScript: marked library (CommonMark + GFM)
 *
 * Converts marked's token-based AST to the dict format expected
 * by MarkdownToHwpx handlers.
 */

import { Marked, type TokenizerExtension } from 'marked';
import { ConversionReportCollector } from './conversionReport';
import { INLINE_MATH_PATTERN, latexMathToUnicode } from './latexSymbols';
import type {
    PandocAST,
    PandocBlock,
    PandocInline,
    PandocAttr,
    AlignValue,
    ColWidthValue,
    ColSpec,
    PandocTableRow,
    PandocTableCell,
    PandocTableBody,
    PandocTableHead,
} from './types';

// ============================================================
// Extended header info (levels 7-9)
// ============================================================

interface ExtendedHeaderInfo {
    level: number;
    content: string;
}

// ============================================================
// marked token types (subset we need)
// ============================================================

interface MarkedTableCell {
    text?: string;
    tokens?: MarkedToken[];
    align?: string | null;
    header?: boolean;
}

interface MarkedToken {
    type: string;
    raw?: string;
    text?: string;
    depth?: number;         // heading level
    ordered?: boolean;
    start?: number | '';
    lang?: string;
    tokens?: MarkedToken[];
    items?: MarkedToken[];
    // marked v12: table header is array of cell objects
    header?: MarkedTableCell[];
    align?: (string | null)[];
    // marked v12: rows is array of array of cell objects
    rows?: MarkedTableCell[][];
    task?: boolean;
    checked?: boolean;
}

interface HtmlTableCell {
    html: string;
    header: boolean;
    rowSpan: number;
    colSpan: number;
    align: AlignValue;
}

interface HtmlTableRow {
    cells: HtmlTableCell[];
    inHead: boolean;
}

interface HtmlInlineFrame {
    tag: string;
    inlines: PandocInline[];
    href: string;
}

// ============================================================
// Obsidian syntax marked does not know
// ============================================================

/** `==text==` → highlight token (Obsidian highlight). */
const HIGHLIGHT_EXTENSION: TokenizerExtension = {
    name: 'highlight',
    level: 'inline',
    start(src: string) {
        const index = src.indexOf('==');
        return index < 0 ? undefined : index;
    },
    tokenizer(src: string) {
        const match = /^==(?=[^\s=])([\s\S]*?[^\s=])==(?!=)/.exec(src);
        return match
            ? { type: 'highlight', raw: match[0], text: match[1], tokens: this.lexer.inlineTokens(match[1]) }
            : undefined;
    },
};

/** `[^id]` → footnote reference token. */
const FOOTNOTE_REF_EXTENSION: TokenizerExtension = {
    name: 'footnoteRef',
    level: 'inline',
    start(src: string) {
        const index = src.indexOf('[^');
        return index < 0 ? undefined : index;
    },
    tokenizer(src: string) {
        const match = /^\[\^([^\]\s]+)\](?!:)/.exec(src);
        return match ? { type: 'footnoteRef', raw: match[0], text: match[1] } : undefined;
    },
};

/** `[^id]: text` with indented continuation lines → footnote definition token. */
const FOOTNOTE_DEF_EXTENSION: TokenizerExtension = {
    name: 'footnoteDef',
    level: 'block',
    start(src: string) {
        return /^\[\^[^\]\s]+\]:/m.exec(src)?.index;
    },
    tokenizer(src: string) {
        const match = /^\[\^([^\]\s]+)\]:[ \t]*([^\n]*(?:\n[ \t]+[^\n]*)*)(?:\n|$)/.exec(src);
        if (!match) return undefined;
        const body = match[2].replace(/^(?: {1,4}|\t)/gm, '');
        return { type: 'footnoteDef', raw: match[0], text: match[1], tokens: this.lexer.blockTokens(body, []) };
    },
};

const MATH_INLINE_EXTENSION: TokenizerExtension = {
    name: 'mathInline',
    level: 'inline',
    start(src: string) { return INLINE_MATH_PATTERN.exec(src)?.index; },
    tokenizer(src: string) {
        const match = INLINE_MATH_PATTERN.exec(src);
        return match?.index === 0 ? { type: 'mathInline', raw: match[0], text: match[1] } : undefined;
    },
};

/** `$$ … $$` over several lines → display-math token. */
const MATH_BLOCK_EXTENSION: TokenizerExtension = {
    name: 'mathBlock',
    level: 'block',
    start(src: string) {
        return /^\$\$/m.exec(src)?.index;
    },
    tokenizer(src: string) {
        const match = /^\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/.exec(src);
        return match ? { type: 'mathBlock', raw: match[0], text: match[1].trim() } : undefined;
    },
};

// A private instance so the global `marked` (and other plugins using it) stays untouched.
const OBSIDIAN_MARKED = new Marked({ gfm: true, breaks: false })
    .use({ extensions: [HIGHLIGHT_EXTENSION, FOOTNOTE_REF_EXTENSION, FOOTNOTE_DEF_EXTENSION, MATH_BLOCK_EXTENSION, MATH_INLINE_EXTENSION] });

// ============================================================
// MarkoToPandocAdapter
// ============================================================

export class MarkoToPandocAdapter {
    // Regex to match extended headers (7-9 levels)
    private static readonly EXTENDED_HEADER_RE = /^(#{7,9})\s+(.+)$/;
    // Regex to match table separator lines
    private static readonly TABLE_SEPARATOR_RE = /^\|[\s:]*-/;

    private extendedHeaders: Record<string, ExtendedHeaderInfo> = {};
    /** Footnote id → its definition blocks, for the current parse(). */
    private footnotes = new Map<string, PandocBlock[]>();
    /** Problems found by the last parse(), for the conversion report. */
    report = new ConversionReportCollector();

    // ============================================================
    // Preprocessing
    // ============================================================

    /** Preprocess markdown to handle header levels 7-9. */
    private preprocessExtendedHeaders(markdownText: string): string {
        this.extendedHeaders = {};
        const lines = markdownText.split('\n');
        const processed: string[] = [];
        let counter = 0;

        for (const line of lines) {
            const match = MarkoToPandocAdapter.EXTENDED_HEADER_RE.exec(line);
            if (match) {
                const hashes = match[1];
                const content = match[2];
                const level = hashes.length;
                const placeholder = `EXTHEADER${counter}MARKER`;
                this.extendedHeaders[placeholder] = { level, content };
                processed.push('');
                processed.push(placeholder);
                processed.push('');
                counter++;
            } else {
                processed.push(line);
            }
        }

        return processed.join('\n');
    }

    /**
     * Count table separator rows outside fenced code. Only used to warn when a
     * table-looking block did not parse as a table.
     */
    private static countTableSeparatorLines(markdownText: string): number {
        let count = 0;
        let fence: string | null = null;
        for (const line of markdownText.split('\n')) {
            const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
            if (fenceMatch) {
                if (!fence) fence = fenceMatch[1][0];
                else if (fenceMatch[1][0] === fence) fence = null;
                continue;
            }
            if (fence) continue;

            const stripped = line.trim();
            if (!MarkoToPandocAdapter.TABLE_SEPARATOR_RE.test(stripped)) continue;
            const cells = stripped.split('|').slice(1, -1).map((c) => c.trim());
            if (cells.length > 0 && cells.every((c) => !c || /^:?-+:?$/.test(c))) {
                count++;
            }
        }
        return count;
    }

    /**
     * Dash counts of a table token's own separator row (the second line of its
     * raw source). Reading the token, not the whole note, keeps separator-like
     * lines in code blocks from shifting widths onto later tables and covers
     * tables inside blockquotes and tables without outer pipes.
     */
    private static dashCountsFromTableRaw(raw: string | undefined): Record<number, number> | null {
        const separator = (raw ?? '').split('\n')[1]?.trim();
        if (!separator) return null;
        const cells = separator.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
        if (cells.length === 0 || !cells.every((c) => /^:?-+:?$/.test(c))) return null;
        const dashCounts: Record<number, number> = {};
        cells.forEach((cell, colIdx) => {
            dashCounts[colIdx] = (cell.match(/-/g) || []).length;
        });
        return dashCounts;
    }

    /** Get width info dict for a column from a table's dash counts. */
    private getColWidthInfo(colDashes: Record<number, number> | null, colIdx: number): ColWidthValue {
        if (!colDashes) return { t: 'ColWidthDefault' };

        const totalDashes = Object.values(colDashes).reduce((a, b) => a + b, 0);
        if (totalDashes === 0 || colDashes[colIdx] === undefined) {
            return { t: 'ColWidthDefault' };
        }
        return { t: 'ColWidth', c: colDashes[colIdx] / totalDashes };
    }

    // ============================================================
    // Main parse entry point
    // ============================================================

    /**
     * Parse markdown and return Pandoc-like AST dict.
     */
    public parse(markdownText: string): PandocAST {
        // Reset state
        this.extendedHeaders = {};
        this.report = new ConversionReportCollector();

        // Preprocess extended headers
        const processedText = this.preprocessExtendedHeaders(markdownText);

        // Use marked lexer with GFM enabled (plus Obsidian highlight/footnotes)
        const tokens = OBSIDIAN_MARKED.lexer(processedText);

        // Footnote definitions are collected first so references can carry their
        // text; the definitions themselves are not output where they stand.
        this.footnotes = new Map();
        for (const token of tokens as MarkedToken[]) {
            if (token.type === 'footnoteDef' && token.text && !this.footnotes.has(token.text)) {
                this.footnotes.set(token.text, this.convertBlocks(token.tokens ?? []));
            }
        }
        const tableTokenCount = tokens.filter((token) => (token as MarkedToken).type === 'table').length;
        const tableLikeSeparatorCount = MarkoToPandocAdapter.countTableSeparatorLines(markdownText);
        if (tableLikeSeparatorCount > tableTokenCount) {
            console.warn(
                `[md2hwpx] Found ${tableLikeSeparatorCount} table-like separator row(s), ` +
                `but marked parsed only ${tableTokenCount} table token(s). ` +
                'Check that each Markdown table has a valid header row and separator row.'
            );
            this.report.add(
                'table_parse_mismatch',
                '표처럼 보이는 줄이 표로 해석되지 않음(머리 행과 구분 행을 확인)',
                undefined,
                tableLikeSeparatorCount - tableTokenCount
            );
        }

        const blocks: PandocBlock[] = [];
        for (const token of tokens) {
            const block = this.convertBlock(token);
            if (block !== null) {
                const restored = this.restoreExtendedHeader(block);
                blocks.push(restored);
            }
        }
        applyStyleDirectives(blocks);

        return {
            'pandoc-api-version': [1, 23, 1],
            meta: {},
            blocks,
        };
    }

    // ============================================================
    // Extended header restoration
    // ============================================================

    private restoreExtendedHeader(block: PandocBlock): PandocBlock {
        if (block.t !== 'Para') return block;
        const inlines = block.c;
        if (inlines.length !== 1) return block;
        const first = inlines[0];
        if (first.t !== 'Str') return block;

        const text = first.c;
        if (text in this.extendedHeaders) {
            const info = this.extendedHeaders[text];
            return this.createExtendedHeaderBlock(info.level, info.content);
        }
        return block;
    }

    private createExtendedHeaderBlock(level: number, content: string): PandocBlock {
        const inlines = this.convertRawText(content);
        return {
            t: 'Header',
            c: [level, ['', [], []] as PandocAttr, inlines],
        };
    }

    // ============================================================
    // Block converters
    // ============================================================

    private convertBlocks(tokens: MarkedToken[]): PandocBlock[] {
        return tokens
            .map((token) => this.convertBlock(token))
            .filter((block): block is PandocBlock => block !== null);
    }

    private convertBlock(token: MarkedToken): PandocBlock | null {
        switch (token.type) {
            case 'heading':
                return this.convertHeading(token);
            case 'paragraph':
                return this.convertParagraph(token);
            case 'list':
                return this.convertList(token);
            case 'code':
                return this.convertCode(token);
            case 'table':
                return this.convertTable(token);
            case 'blockquote':
                return this.convertBlockquote(token);
            case 'hr':
                return { t: 'HorizontalRule' };
            case 'html':
                return this.convertRawBlock(token);
            case 'mathBlock': {
                // Div.math: one paragraph, a line break per source line (plan 3.3, {{MATH}}).
                const lines = latexMathToUnicode(token.text ?? '').split('\n');
                const inlines: PandocInline[] = lines.flatMap((line, index) =>
                    [...(index > 0 ? [{ t: 'LineBreak' } as PandocInline] : []), ...this.convertRawText(line.trim())]);
                return { t: 'Div', c: [['', ['math'], []], [{ t: 'Para', c: inlines }]] };
            }
            case 'space':
                return null;
            default:
                return null;
        }
    }

    private convertHeading(token: MarkedToken): PandocBlock {
        const level = token.depth ?? 1;
        const inlines = token.tokens
            ? this.convertInlineTokens(token.tokens)
            : this.convertRawText(token.text ?? '');
        const attr: PandocAttr = ['', [], []];
        const atxMatch = /^(#+)( *)/.exec(token.raw ?? '');
        if (atxMatch) {
            const separatorSpaces = atxMatch[2].length;
            const contentLeadingSpaces = Math.max(0, separatorSpaces - 1);
            attr[2].push(['prefixLeadSpaces', String(contentLeadingSpaces)]);
        }
        return {
            t: 'Header',
            c: [level, attr, inlines],
        };
    }

    private convertParagraph(token: MarkedToken): PandocBlock {
        const inlines = token.tokens
            ? this.convertInlineTokens(token.tokens)
            : this.convertRawText(token.text ?? '');
        return { t: 'Para', c: inlines };
    }

    private convertList(token: MarkedToken): PandocBlock {
        const items = (token.items ?? []).map((item) => {
            const itemBlocks: PandocBlock[] = [];
            // Span.task-open|task-done lets {{TASK_OPEN}}/{{TASK_DONE}} restyle the box; the text stays "[ ]"/"[x]".
            const taskPrefix: PandocInline[] = item.task
                ? [
                    { t: 'Span', c: [['', [item.checked ? 'task-done' : 'task-open'], []] as PandocAttr, [{ t: 'Str', c: item.checked ? '[x]' : '[ ]' }]] },
                    { t: 'Space' },
                ]
                : [];
            if (item.tokens) {
                for (const child of item.tokens) {
                    if (child.type === 'text' && child.tokens) {
                        // Inline content inside a list item
                        const inlines = this.convertInlineTokens(child.tokens);
                        const prefixed = taskPrefix.length > 0
                            ? [...taskPrefix, ...inlines]
                            : inlines;
                        if (inlines.length > 0) {
                            // Use Para for loose items, Plain for tight
                            itemBlocks.push({ t: 'Plain', c: prefixed });
                        }
                    } else {
                        const block = this.convertBlock(child);
                        if (block !== null) itemBlocks.push(block);
                    }
                }
            } else if (item.text !== undefined) {
                const inlines = this.convertRawText(item.text);
                itemBlocks.push({
                    t: 'Plain',
                    c: taskPrefix.length > 0 ? [...taskPrefix, ...inlines] : inlines,
                });
            }
            return itemBlocks;
        });

        if (token.ordered) {
            const start = typeof token.start === 'number' ? token.start : 1;
            return {
                t: 'OrderedList',
                c: [[start, { t: 'Decimal' }, { t: 'Period' }], items],
            };
        } else {
            return { t: 'BulletList', c: items };
        }
    }

    private convertCode(token: MarkedToken): PandocBlock {
        const lang = token.lang ?? '';
        const code = token.text ?? '';
        return {
            t: 'CodeBlock',
            c: [['', lang ? [lang] : [], []] as PandocAttr, code],
        };
    }

    private static readonly ALIGN_MAP: Record<string, AlignValue> = {
        left: 'AlignLeft',
        center: 'AlignCenter',
        right: 'AlignRight',
    };

    private convertTable(token: MarkedToken): PandocBlock {
        const header = token.header ?? [];
        const rows = token.rows ?? [];
        const aligns = token.align ?? [];

        const dashCounts = MarkoToPandocAdapter.dashCountsFromTableRaw(token.raw);
        const colCount = header.length;
        if (colCount === 0) {
            console.warn('[md2hwpx] Parsed a table token with no header columns; the table may be skipped.');
        }

        // Column specs
        const specs: ColSpec[] = [];
        for (let colIdx = 0; colIdx < colCount; colIdx++) {
            const alignStr = aligns[colIdx]
                ? (MarkoToPandocAdapter.ALIGN_MAP[aligns[colIdx] as string] ?? 'AlignDefault')
                : 'AlignDefault';
            const widthInfo = this.getColWidthInfo(dashCounts, colIdx);
            specs.push([alignStr, widthInfo]);
        }

        // Header row - each cell is a MarkedTableCell object with .tokens
        const headCells: PandocTableCell[] = header.map((cell, colIdx) => {
            const inlines = cell.tokens
                ? this.convertInlineTokens(cell.tokens)
                : this.convertRawText(cell.text ?? '');
            const plain: PandocBlock = { t: 'Plain', c: inlines };
            const align = specs[colIdx]?.[0] ?? 'AlignDefault';
            return [['', [], []] as PandocAttr, align, 1, 1, [plain]];
        });
        const headRow: PandocTableRow = [['', [], []] as PandocAttr, headCells];
        const head: PandocTableHead = [['', [], []] as PandocAttr, [headRow]];

        // Body rows - each row is an array of MarkedTableCell objects
        const bodyRows: PandocTableRow[] = rows.map((rowCells) => {
            const cells: PandocTableCell[] = rowCells.map((cell, colIdx) => {
                const inlines = cell.tokens
                    ? this.convertInlineTokens(cell.tokens)
                    : this.convertRawText(cell.text ?? '');
                const plain: PandocBlock = { t: 'Plain', c: inlines };
                const align = specs[colIdx]?.[0] ?? 'AlignDefault';
                return [['', [], []] as PandocAttr, align, 1, 1, [plain]];
            });
            return [['', [], []] as PandocAttr, cells];
        });

        const bodies: PandocTableBody[] = bodyRows.length > 0
            ? [[['', [], []] as PandocAttr, 0, [], bodyRows]]
            : [];
        const foot: PandocTableHead = [['', [], []] as PandocAttr, []];

        return {
            t: 'Table',
            c: [
                ['', [], []] as PandocAttr,
                [null, []],
                specs,
                head,
                bodies,
                foot,
            ],
        };
    }

    private convertBlockquote(token: MarkedToken): PandocBlock {
        const blocks: PandocBlock[] = [];
        if (token.tokens) {
            for (const child of token.tokens) {
                const block = this.convertBlock(child);
                if (block !== null) blocks.push(block);
            }
        }
        applyStyleDirectives(blocks);
        return this.convertCallout(blocks) ?? { t: 'BlockQuote', c: blocks };
    }

    /**
     * Obsidian callout `> [!type]± title` → Div with class `callout`, attribute
     * `type`, and a `callout-title` Div holding the title (Obsidian shows the
     * capitalized type when the title is empty). The rest of the first
     * paragraph and the following blocks are the callout body.
     */
    private convertCallout(blocks: PandocBlock[]): PandocBlock | null {
        const first = blocks[0];
        if (!first || first.t !== 'Para') return null;
        const head = first.c[0];
        const match = head?.t === 'Str' ? /^\[!([\p{L}\p{N}_-]+)\]([+-]?)(.*)$/u.exec(head.c) : null;
        if (!match) return null;

        const type = match[1].toLowerCase();
        const rest: PandocInline[] = match[3] ? [{ t: 'Str', c: match[3] }, ...first.c.slice(1)] : first.c.slice(1);
        const breakIndex = rest.findIndex((inline) => inline.t === 'LineBreak' || inline.t === 'SoftBreak');
        const titleInlines = trimInlineSpaces(breakIndex >= 0 ? rest.slice(0, breakIndex) : rest);
        const bodyInlines = breakIndex >= 0 ? trimInlineSpaces(rest.slice(breakIndex + 1)) : [];
        const title: PandocInline[] = titleInlines.length > 0
            ? titleInlines
            : [{ t: 'Str', c: type.charAt(0).toUpperCase() + type.slice(1) }];

        const body: PandocBlock[] = [
            { t: 'Div', c: [['', ['callout-title'], []], [{ t: 'Plain', c: title }]] },
            ...(bodyInlines.length > 0 ? [{ t: 'Para', c: bodyInlines } as PandocBlock] : []),
            ...blocks.slice(1),
        ];
        const attrs: [string, string][] = [['type', type]];
        if (match[2]) attrs.push(['fold', match[2]]);
        return { t: 'Div', c: [['', ['callout'], attrs], body] };
    }

    private convertRawBlock(token: MarkedToken): PandocBlock {
        const html = token.text ?? token.raw ?? '';
        return this.convertHtmlTable(html) ?? { t: 'RawBlock', c: ['html', html] };
    }

    private convertHtmlTable(html: string): PandocBlock | null {
        const tableStart = html.search(/<table\b/i);
        if (tableStart < 0) return null;

        // Match the outer table's balanced close so a nested <table> inside a
        // cell does not truncate it at the inner </table>.
        const openEnd = html.indexOf('>', tableStart) + 1;
        if (openEnd <= 0) return null;
        const tableInner = html.slice(openEnd, this.findBalancedTableEnd(html, openEnd).innerEnd);

        const rows = this.extractHtmlRows(tableInner);
        if (rows.length === 0) return null;
        const colCount = Math.max(...rows.map((row) =>
            row.cells.reduce((sum, cell) => sum + cell.colSpan, 0)
        ));
        const specs: ColSpec[] = Array.from(
            { length: colCount },
            (_, colIdx) => [this.getHtmlColumnAlignment(rows, colIdx), { t: 'ColWidthDefault' }]
        );
        const convertedRows = rows.map((row) => this.convertHtmlTableRow(row));
        const explicitHeadCount = rows.filter((row) => row.inHead).length;
        let headerRowCount = explicitHeadCount;
        if (headerRowCount === 0) {
            headerRowCount = rows.findIndex((row) => !row.cells.every((cell) => cell.header));
            if (headerRowCount < 0) headerRowCount = rows.length;
        }

        const headRows = convertedRows.slice(0, headerRowCount);
        const bodyRows = convertedRows.slice(headerRowCount);
        const head: PandocTableHead = [['', [], []] as PandocAttr, headRows];
        const bodies: PandocTableBody[] = bodyRows.length > 0
            ? [[['', [], []] as PandocAttr, 0, [], bodyRows]]
            : [];
        const foot: PandocTableHead = [['', [], []] as PandocAttr, []];

        return {
            t: 'Table',
            c: [
                ['', [], []] as PandocAttr,
                [null, []],
                specs,
                head,
                bodies,
                foot,
            ],
        };
    }

    private convertHtmlTableRow(row: HtmlTableRow): PandocTableRow {
        const cells: PandocTableCell[] = row.cells.map((cell) => [
            ['', [], []] as PandocAttr,
            cell.align,
            cell.rowSpan,
            cell.colSpan,
            this.convertHtmlCellBlocks(cell.html),
        ]);
        return [['', [], []] as PandocAttr, cells];
    }

    /**
     * Converts a table cell's inner HTML into Pandoc blocks, keeping any nested
     * <table> as a real nested Table block instead of flattening it into the
     * surrounding table. Text before/after a nested table becomes Plain blocks.
     */
    private convertHtmlCellBlocks(html: string): PandocBlock[] {
        const blocks: PandocBlock[] = [];
        let textBuf = '';
        const flushText = () => {
            if (textBuf.trim()) {
                blocks.push({ t: 'Plain', c: this.convertHtmlInlineFragment(textBuf) });
            }
            textBuf = '';
        };

        let i = 0;
        const tablePattern = /<table\b/gi;
        while (i < html.length) {
            tablePattern.lastIndex = i;
            const match = tablePattern.exec(html);
            if (!match) {
                textBuf += html.slice(i);
                break;
            }
            textBuf += html.slice(i, match.index);
            const openEnd = html.indexOf('>', match.index) + 1;
            if (openEnd <= 0) {
                textBuf += html.slice(match.index);
                break;
            }
            const balanced = this.findBalancedTableEnd(html, openEnd);
            const nestedTableHtml = html.slice(match.index, balanced.afterClose);
            flushText();
            const nested = this.convertHtmlTable(nestedTableHtml);
            if (nested) blocks.push(nested);
            i = balanced.afterClose;
        }
        flushText();

        if (blocks.length === 0) {
            blocks.push({ t: 'Plain', c: this.convertHtmlInlineFragment(html) });
        }
        return blocks;
    }

    /** Extracts the direct-child rows of a table, resolving thead/tbody/tfoot. */
    private extractHtmlRows(tableInner: string): HtmlTableRow[] {
        const rows: HtmlTableRow[] = [];
        const sections = this.extractDirectChildren(tableInner, ['tr', 'thead', 'tbody', 'tfoot']);
        for (const section of sections) {
            if (section.tag === 'tr') {
                const row = this.buildHtmlRow(section.content, false);
                if (row) rows.push(row);
                continue;
            }
            const inHead = section.tag === 'thead';
            for (const tr of this.extractDirectChildren(section.content, ['tr'])) {
                const row = this.buildHtmlRow(tr.content, inHead);
                if (row) rows.push(row);
            }
        }
        return rows;
    }

    private buildHtmlRow(rowInner: string, inHead: boolean): HtmlTableRow | null {
        const cells: HtmlTableCell[] = [];
        for (const cellNode of this.extractDirectChildren(rowInner, ['td', 'th'])) {
            const attrs = this.parseHtmlAttributes(cellNode.attrs);
            cells.push({
                html: cellNode.content,
                header: cellNode.tag === 'th',
                rowSpan: parseHtmlSpan(attrs.rowspan),
                colSpan: parseHtmlSpan(attrs.colspan),
                align: this.getHtmlCellAlignment(attrs),
            });
        }
        if (cells.length === 0) return null;
        return { cells, inHead };
    }

    /**
     * Walks `inner` and returns its direct-child elements whose tag is in
     * `childTags`, skipping over any nested <table> so descendant rows/cells
     * are not mistaken for direct children.
     */
    private extractDirectChildren(
        inner: string,
        childTags: string[]
    ): Array<{ tag: string; attrs: string; content: string }> {
        const results: Array<{ tag: string; attrs: string; content: string }> = [];
        const tagSet = new Set(childTags.map((t) => t.toLowerCase()));
        const tagPattern = /<\s*(\/?)([a-z][a-z0-9]*)\b([^>]*)>/gi;
        let match: RegExpExecArray | null;
        while ((match = tagPattern.exec(inner))) {
            const isClose = match[1] === '/';
            const name = match[2].toLowerCase();
            if (isClose) continue;
            if (name === 'table') {
                tagPattern.lastIndex = this.findBalancedTableEnd(inner, tagPattern.lastIndex).afterClose;
                continue;
            }
            if (tagSet.has(name)) {
                const close = this.findChildClose(inner, name, tagPattern.lastIndex);
                results.push({
                    tag: name,
                    attrs: match[3] ?? '',
                    content: inner.slice(tagPattern.lastIndex, close.innerEnd),
                });
                tagPattern.lastIndex = close.afterClose;
            }
        }
        return results;
    }

    /**
     * Given an index just after an opening <table ...> tag, returns the start
     * of the matching </table> and the index after it, honoring nested tables.
     */
    private findBalancedTableEnd(html: string, from: number): { innerEnd: number; afterClose: number } {
        const pattern = /<\s*(\/?)table\b[^>]*>/gi;
        pattern.lastIndex = from;
        let depth = 1;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(html))) {
            if (match[1] === '/') {
                depth -= 1;
                if (depth === 0) return { innerEnd: match.index, afterClose: pattern.lastIndex };
            } else {
                depth += 1;
            }
        }
        return { innerEnd: html.length, afterClose: html.length };
    }

    /**
     * Finds the matching close tag for a child element (e.g. tr/td/th) opened
     * just before `from`, skipping nested tables and same-name descendants.
     */
    private findChildClose(html: string, name: string, from: number): { innerEnd: number; afterClose: number } {
        const pattern = new RegExp(`<\\s*(/?)(table|${name})\\b[^>]*>`, 'gi');
        pattern.lastIndex = from;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(html))) {
            const isClose = match[1] === '/';
            const tag = match[2].toLowerCase();
            if (tag === 'table') {
                if (!isClose) {
                    pattern.lastIndex = this.findBalancedTableEnd(html, pattern.lastIndex).afterClose;
                }
                continue;
            }
            // tag === name
            if (isClose) {
                return { innerEnd: match.index, afterClose: pattern.lastIndex };
            }
            pattern.lastIndex = this.findChildClose(html, name, pattern.lastIndex).afterClose;
        }
        return { innerEnd: html.length, afterClose: html.length };
    }

    private parseHtmlAttributes(source: string): Record<string, string> {
        const attrs: Record<string, string> = {};
        const pattern = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
        for (const match of source.matchAll(pattern)) {
            attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
        }
        return attrs;
    }

    private getHtmlCellAlignment(attrs: Record<string, string>): AlignValue {
        const styleAlign = attrs.style?.match(/(?:^|;)\s*text-align\s*:\s*(left|center|right)/i)?.[1];
        const align = (attrs.align || styleAlign || '').toLowerCase();
        return MarkoToPandocAdapter.ALIGN_MAP[align] ?? 'AlignDefault';
    }

    private getHtmlColumnAlignment(rows: HtmlTableRow[], targetCol: number): AlignValue {
        for (const row of rows) {
            let logicalCol = 0;
            for (const cell of row.cells) {
                if (targetCol >= logicalCol && targetCol < logicalCol + cell.colSpan) {
                    if (cell.align !== 'AlignDefault') return cell.align;
                    break;
                }
                logicalCol += cell.colSpan;
            }
        }
        return 'AlignDefault';
    }

    private convertHtmlInlineFragment(html: string): PandocInline[] {
        const root: HtmlInlineFrame = { tag: '', inlines: [], href: '' };
        const stack: HtmlInlineFrame[] = [root];
        const append = (inline: PandocInline): void => {
            stack[stack.length - 1].inlines.push(inline);
        };
        const appendBreak = (): void => {
            const current = stack[stack.length - 1].inlines;
            if (current.length > 0 && current[current.length - 1].t !== 'LineBreak') {
                current.push({ t: 'LineBreak' });
            }
        };

        const tokenPattern = /<!--[\s\S]*?-->|<[^>]+>|[^<]+/g;
        for (const match of html.matchAll(tokenPattern)) {
            const part = match[0];
            if (part.startsWith('<!--')) continue;
            if (!part.startsWith('<')) {
                stack[stack.length - 1].inlines.push(...this.convertRawText(decodeHtmlText(part)));
                continue;
            }

            const closeMatch = part.match(/^<\/\s*([\w-]+)/);
            if (closeMatch) {
                const tag = closeMatch[1].toLowerCase();
                const frameIndex = stack.map((frame) => frame.tag).lastIndexOf(tag);
                if (frameIndex > 0) {
                    while (stack.length - 1 >= frameIndex) {
                        const frame = stack.pop()!;
                        const wrapped = this.wrapHtmlInlineFrame(frame);
                        if (wrapped) append(wrapped);
                    }
                }
                if (['p', 'div', 'li'].includes(tag)) appendBreak();
                continue;
            }

            const openMatch = part.match(/^<\s*([\w-]+)\b([^>]*)>/);
            if (!openMatch) continue;
            const tag = openMatch[1].toLowerCase();
            if (tag === 'br') {
                append({ t: 'LineBreak' });
                continue;
            }
            if (['p', 'div', 'li'].includes(tag)) {
                appendBreak();
                continue;
            }
            if (['strong', 'b', 'em', 'i', 'del', 's', 'strike', 'code', 'a'].includes(tag)) {
                const attrs = this.parseHtmlAttributes(openMatch[2] ?? '');
                stack.push({ tag, inlines: [], href: decodeHtmlText(attrs.href ?? '') });
            }
        }

        while (stack.length > 1) {
            const wrapped = this.wrapHtmlInlineFrame(stack.pop()!);
            if (wrapped) append(wrapped);
        }
        while (root.inlines[root.inlines.length - 1]?.t === 'LineBreak') {
            root.inlines.pop();
        }
        return root.inlines;
    }

    private wrapHtmlInlineFrame(frame: HtmlInlineFrame): PandocInline | null {
        if (frame.inlines.length === 0) return null;
        if (frame.tag === 'strong' || frame.tag === 'b') return { t: 'Strong', c: frame.inlines };
        if (frame.tag === 'em' || frame.tag === 'i') return { t: 'Emph', c: frame.inlines };
        if (['del', 's', 'strike'].includes(frame.tag)) return { t: 'Strikeout', c: frame.inlines };
        if (frame.tag === 'code') {
            return { t: 'Code', c: [['', [], []] as PandocAttr, inlineText(frame.inlines)] };
        }
        if (frame.tag === 'a') {
            return { t: 'Link', c: [['', [], []] as PandocAttr, frame.inlines, [frame.href, '']] };
        }
        return frame.inlines[0] ?? null;
    }

    // ============================================================
    // Inline converters
    // ============================================================

    private convertInlineTokens(tokens: MarkedToken[]): PandocInline[] {
        const result: PandocInline[] = [];
        for (const token of tokens) {
            const inlines = this.convertInline(token);
            if (Array.isArray(inlines)) {
                result.push(...inlines);
            } else if (inlines !== null) {
                result.push(inlines);
            }
        }
        return result;
    }

    private convertInline(token: MarkedToken): PandocInline | PandocInline[] | null {
        switch (token.type) {
            case 'mathInline':
                return { t: 'Math', c: [{ t: 'InlineMath' }, token.text ?? ''] };
            case 'text': {
                // Text tokens can have child tokens (for inline formatting)
                if (token.tokens && token.tokens.length > 0) {
                    return this.convertInlineTokens(token.tokens);
                }
                return this.convertRawText(token.text ?? '');
            }
            case 'em': {
                const inlines = token.tokens
                    ? this.convertInlineTokens(token.tokens)
                    : this.convertRawText(token.text ?? '');
                return { t: 'Emph', c: inlines };
            }
            case 'strong': {
                const inlines = token.tokens
                    ? this.convertInlineTokens(token.tokens)
                    : this.convertRawText(token.text ?? '');
                return { t: 'Strong', c: inlines };
            }
            case 'del': {
                // Strikethrough (GFM)
                const inlines = token.tokens
                    ? this.convertInlineTokens(token.tokens)
                    : this.convertRawText(token.text ?? '');
                return { t: 'Strikeout', c: inlines };
            }
            case 'codespan': {
                return { t: 'Code', c: [['', [], []] as PandocAttr, token.text ?? ''] };
            }
            case 'link': {
                const inlines = token.tokens
                    ? this.convertInlineTokens(token.tokens)
                    : this.convertRawText(token.text ?? '');
                const href = (token as unknown as { href?: string }).href ?? '';
                const title = (token as unknown as { title?: string }).title ?? '';
                return { t: 'Link', c: [['', [], []] as PandocAttr, inlines, [href, title]] };
            }
            case 'image': {
                const inlines = this.convertRawText(token.text ?? '');
                const href = (token as unknown as { href?: string }).href ?? '';
                const title = (token as unknown as { title?: string }).title ?? '';
                return { t: 'Image', c: [['', [], []] as PandocAttr, inlines, [href, title]] };
            }
            case 'br': {
                return { t: 'LineBreak' };
            }
            case 'html': {
                const html = (token.raw ?? token.text ?? '').trim();
                if (/^<br\s*\/?\s*>$/i.test(html)) {
                    return { t: 'LineBreak' };
                }
                return { t: 'RawInline', c: ['html', token.text ?? ''] };
            }
            case 'escape': {
                return this.convertRawText(token.text ?? '');
            }
            case 'highlight': {
                return { t: 'Span', c: [['', ['mark'], []] as PandocAttr, this.convertInlineTokens(token.tokens ?? [])] };
            }
            case 'footnoteRef': {
                // A reference without a definition stays as written.
                const blocks = this.footnotes.get(token.text ?? '');
                if (!blocks) {
                    this.report.add('footnote_undefined', '정의가 없는 각주 참조를 글자 그대로 남김', token.raw);
                    return this.convertRawText(token.raw ?? '');
                }
                return { t: 'Note', c: blocks };
            }
            default:
                if (token.text !== undefined) {
                    return this.convertRawText(token.text);
                }
                return null;
        }
    }

    /**
     * Convert raw text to Str and Space tokens.
     */
    public convertRawText(text: string): PandocInline[] {
        if (!text) return [];

        const result: PandocInline[] = [];
        const lines = decodeMarkedText(text).split('\n');

        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            const parts = lines[lineIndex].split(' ');
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                if (part) {
                    result.push({ t: 'Str', c: part });
                }
                if (i < parts.length - 1) {
                    result.push({ t: 'Space' });
                }
            }
            if (lineIndex < lines.length - 1) {
                result.push({ t: 'LineBreak' });
            }
        }

        return result;
    }
}

function decodeMarkedText(text: string): string {
    return text
        .replace(/&(apos|#39|#x27);/gi, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function parseHtmlSpan(value: string | undefined): number {
    const parsed = Number.parseInt(value ?? '1', 10);
    if (!Number.isFinite(parsed) || parsed < 1) return 1;
    return Math.min(parsed, 100);
}

function decodeHtmlText(text: string): string {
    const named: Record<string, string> = {
        amp: '&',
        apos: "'",
        gt: '>',
        lt: '<',
        nbsp: '\u00A0',
        quot: '"',
    };
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
        if (body.startsWith('#x') || body.startsWith('#X')) {
            const codePoint = Number.parseInt(body.slice(2), 16);
            return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
        }
        if (body.startsWith('#')) {
            const codePoint = Number.parseInt(body.slice(1), 10);
            return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
        }
        return named[body.toLowerCase()] ?? entity;
    });
}

function inlineText(inlines: PandocInline[]): string {
    return inlines.map((inline) => {
        switch (inline.t) {
            case 'Str': return inline.c;
            case 'Space': return ' ';
            case 'SoftBreak':
            case 'LineBreak': return '\n';
            case 'Strong':
            case 'Emph':
            case 'Underline':
            case 'Strikeout': return inlineText(inline.c);
            case 'Code': return inline.c[1];
            case 'Link': return inlineText(inline.c[1]);
            default: return '';
        }
    }).join('');
}

function trimInlineSpaces(inlines: PandocInline[]): PandocInline[] {
    const isSpace = (inline: PandocInline | undefined): boolean =>
        inline?.t === 'Space' || inline?.t === 'SoftBreak' || inline?.t === 'LineBreak';
    let start = 0;
    let end = inlines.length;
    while (start < end && isSpace(inlines[start])) start++;
    while (end > start && isSpace(inlines[end - 1])) end--;
    return inlines.slice(start, end);
}

const STYLE_DIRECTIVE = /^<!--\s*hwpx:style\s*=\s*([^\s>]+?)\s*-->\s*$/;

/**
 * `<!-- hwpx:style=요약 -->` before a block picks the template variant `{{BODY:요약}}`
 * (`{{H2:요약}}` …) for it: the directive is removed and the next block is wrapped
 * in a Div with class `hwpx-style` (plan 3.6).
 */
function applyStyleDirectives(blocks: PandocBlock[]): void {
    for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        const match = block.t === 'RawBlock' && block.c[0] === 'html' ? STYLE_DIRECTIVE.exec(block.c[1].trim()) : null;
        if (!match) continue;
        const next = blocks[index + 1];
        if (next) {
            blocks.splice(index, 2, { t: 'Div', c: [['', ['hwpx-style'], [['style', match[1]]]], [next]] });
        } else {
            blocks.splice(index, 1);
        }
    }
}
