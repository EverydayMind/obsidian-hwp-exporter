/**
 * Pandoc-like AST type definitions for the shared HWPX converter.
 *
 * These types represent the intermediate AST format produced by
 * MarkoToPandocAdapter and consumed by MarkdownToHwpx.
 */

// ============================================================
// Attribute types
// ============================================================

/** Pandoc Attr: [id, classes, key-value pairs] */
export type PandocAttr = [string, string[], [string, string][]];

/** Column width: proportional or default */
export type ColWidthValue =
    | { t: 'ColWidth'; c: number }
    | { t: 'ColWidthDefault' };

/** Column alignment */
export type AlignValue =
    | 'AlignLeft'
    | 'AlignRight'
    | 'AlignCenter'
    | 'AlignDefault';

/** Column spec: [alignment, width] */
export type ColSpec = [AlignValue, ColWidthValue];

// ============================================================
// Inline types
// ============================================================

export interface InlineStr { t: 'Str'; c: string; }
export interface InlineSpace { t: 'Space'; }
export interface InlineSoftBreak { t: 'SoftBreak'; }
export interface InlineLineBreak { t: 'LineBreak'; }
export interface InlineEmph { t: 'Emph'; c: PandocInline[]; }
export interface InlineStrong { t: 'Strong'; c: PandocInline[]; }
export interface InlineStrikeout { t: 'Strikeout'; c: PandocInline[]; }
export interface InlineUnderline { t: 'Underline'; c: PandocInline[]; }
export interface InlineSuperscript { t: 'Superscript'; c: PandocInline[]; }
export interface InlineSubscript { t: 'Subscript'; c: PandocInline[]; }
export interface InlineSmallCaps { t: 'SmallCaps'; c: PandocInline[]; }
export interface InlineCode { t: 'Code'; c: [PandocAttr, string]; }
/** Original LaTeX source, kept separate from ordinary Markdown text. */
export interface InlineMath { t: 'Math'; c: [{ t: 'InlineMath' | 'DisplayMath' }, string]; }
export interface InlineLink { t: 'Link'; c: [PandocAttr, PandocInline[], [string, string]]; }
export interface InlineImage { t: 'Image'; c: [PandocAttr, PandocInline[], [string, string]]; }
export interface InlineRawInline { t: 'RawInline'; c: [string, string]; }
export interface InlineNote { t: 'Note'; c: PandocBlock[]; }
/** Pandoc Span; class `mark` is an Obsidian ==highlight==. */
export interface InlineSpan { t: 'Span'; c: [PandocAttr, PandocInline[]]; }
export interface InlineQuoted { t: 'Quoted'; c: [{ t: string }, PandocInline[]]; }

export type PandocInline =
    | InlineStr
    | InlineSpace
    | InlineSoftBreak
    | InlineLineBreak
    | InlineEmph
    | InlineStrong
    | InlineStrikeout
    | InlineUnderline
    | InlineSuperscript
    | InlineSubscript
    | InlineSmallCaps
    | InlineCode
    | InlineMath
    | InlineLink
    | InlineImage
    | InlineRawInline
    | InlineNote
    | InlineSpan
    | InlineQuoted;

// ============================================================
// Block types
// ============================================================

export interface BlockHeader {
    t: 'Header';
    /** [level, attr, inlines] */
    c: [number, PandocAttr, PandocInline[]];
}

export interface BlockPara {
    t: 'Para';
    c: PandocInline[];
}

export interface BlockPlain {
    t: 'Plain';
    c: PandocInline[];
}

export interface BlockCodeBlock {
    t: 'CodeBlock';
    /** [attr, code] */
    c: [PandocAttr, string];
}

export interface BlockBulletList {
    t: 'BulletList';
    /** Array of items, each item is an array of blocks */
    c: PandocBlock[][];
}

export interface BlockOrderedList {
    t: 'OrderedList';
    /** [[start, style, delim], items[]] */
    c: [[number, { t: string }, { t: string }], PandocBlock[][]];
}

export interface BlockBlockQuote {
    t: 'BlockQuote';
    c: PandocBlock[];
}

export interface BlockHorizontalRule {
    t: 'HorizontalRule';
}

/** Pandoc table cell: [attr, align, rowspan, colspan, blocks] */
export type PandocTableCell = [PandocAttr, AlignValue, number, number, PandocBlock[]];

/** Pandoc table row: [attr, cells] */
export type PandocTableRow = [PandocAttr, PandocTableCell[]];

/** Pandoc table head/foot: [attr, rows] */
export type PandocTableHead = [PandocAttr, PandocTableRow[]];

/** Pandoc table body: [attr, headerRows, headRows, bodyRows] */
export type PandocTableBody = [PandocAttr, number, PandocTableRow[], PandocTableRow[]];

export interface BlockTable {
    t: 'Table';
    /**
     * [attr, caption, colspecs, head, bodies, foot]
     */
    c: [
        PandocAttr,
        [null | PandocInline[], PandocInline[]],
        ColSpec[],
        PandocTableHead,
        PandocTableBody[],
        PandocTableHead,
    ];
}

export interface BlockRawBlock {
    t: 'RawBlock';
    c: [string, string];
}

export interface BlockDiv {
    t: 'Div';
    c: [PandocAttr, PandocBlock[]];
}

export type PandocBlock =
    | BlockHeader
    | BlockPara
    | BlockPlain
    | BlockCodeBlock
    | BlockBulletList
    | BlockOrderedList
    | BlockBlockQuote
    | BlockHorizontalRule
    | BlockTable
    | BlockRawBlock
    | BlockDiv;

// ============================================================
// Meta types
// ============================================================

export interface MetaInlines { t: 'MetaInlines'; c: PandocInline[]; }
export interface MetaList { t: 'MetaList'; c: MetaValue[]; }
export interface MetaMap { t: 'MetaMap'; c: Record<string, MetaValue>; }
export interface MetaBool { t: 'MetaBool'; c: boolean; }
export interface MetaString { t: 'MetaString'; c: string; }
export interface MetaBlocks { t: 'MetaBlocks'; c: PandocBlock[]; }

export type MetaValue =
    | MetaInlines
    | MetaList
    | MetaMap
    | MetaBool
    | MetaString
    | MetaBlocks;

// ============================================================
// Top-level AST
// ============================================================

export interface PandocAST {
    'pandoc-api-version': number[];
    meta: Record<string, MetaValue>;
    blocks: PandocBlock[];
}

// ============================================================
// Image metadata (internal use)
// ============================================================

export interface ImageMeta {
    path: string;
    /** Trusted filesystem path supplied by an integration such as Obsidian. */
    resolvedPath?: string;
    /** Captured image bytes; takes precedence over filesystem lookup. */
    bytes?: Buffer;
    id: string;
    ext: string;
    width: number;
    height: number;
    displayWidthPx?: number;
    displayHeightPx?: number;
}

export type ImagePathResolver = (source: string) => string | null;

export interface ResolvedImageAsset {
    bytes?: Buffer;
    absolutePath?: string;
    ext: 'png' | 'jpg' | 'gif';
    displayWidthPx?: number;
    displayHeightPx?: number;
}

export type ImageAssetResolver = (source: string) => ResolvedImageAsset | null;

// ============================================================
// Style mapping types (internal use)
// ============================================================

export interface StyleInfo {
    style_id: string;
    para_pr_id: string;
    char_pr_id: string;
}

export interface PlaceholderStyle {
    charPrIDRef: string;
    paraPrIDRef: string;
    styleIDRef: string;
    prefix?: string | null;
    prefixCharPrIDRef?: string | null;
    suffix?: string | null;
    suffixCharPrIDRef?: string | null;
    leadingEmptyParagraph?: {
        charPrIDRef: string;
        paraPrIDRef: string;
        styleIDRef: string;
        rawParagraphXml?: string | null;
    } | null;
    markerOwnerParagraph?: string | null;
    table?: unknown; // XML element reference (not used after init)
    /** Paragraph and run that hold a reused heading table in the template (DECISIONS 3.3). */
    tableOwner?: { paraPrIDRef: string | null; runTag: string | null } | null;
    mode: 'plain' | 'table' | 'prefix';
    numberingText?: string | null;
}

export interface CellStyle {
    borderFillIDRef?: string;
    charPrIDRef: string;
    paraPrIDRef: string;
    styleIDRef?: string;
    cellStartTag?: string;
    subListStartTag?: string;
    cellMargin?: { left: number; right: number; top: number; bottom: number };
    borderFill?: {
        leftBorder?: BorderSpec;
        rightBorder?: BorderSpec;
        topBorder?: BorderSpec;
        bottomBorder?: BorderSpec;
        fillColor?: string;
    };
}

export interface BorderSpec {
    type: string;
    width: string;
    color: string;
}

export interface ListStyle {
    charPrIDRef: string;
    paraPrIDRef: string;
    styleIDRef?: string;
    mode?: 'prefix' | 'numbering';
    prefix?: string | null;
    prefixCharPrIDRef?: string | null;
    suffix?: string | null;
    suffixCharPrIDRef?: string | null;
    markerOwnerParagraph?: string | null;
}
