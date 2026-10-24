/**
 * Pandoc-like AST to HWPX XML converter.
 * Uses jszip + fast-xml-parser with string-based XML generation.
 */

import { TemplateScanner } from './hwpx/templateScanner';
import { StyleRegistry } from './hwpx/styleRegistry';
import * as fs from 'fs';
import * as path from 'path';
import { ConversionConfig, DEFAULT_CONFIG } from './config';
import { TemplateError, ConversionError, SecurityError } from './exceptions';
import type {
    PandocAST,
    PandocBlock,
    PandocInline,
    PandocAttr,
    AlignValue,
    InlineImage,
    PlaceholderStyle,
    CellStyle,
    ListStyle,
    ImageMeta,
    ImageAssetResolver,
    ImagePathResolver,
} from './types';
import { HP_TEXT_PATTERN, OBJECT_ELEMENT_PATTERN, OBJECT_START_TAG_PATTERN, TEMPLATE_WRAPPER_END, TEMPLATE_WRAPPER_START, decodeTemplateElements, decodeTemplateTextRun, encodeTemplateText, escapeXml, findMaxAttrValue, removeOutermostElements, splitTopLevelParagraphs, stripInvalidXmlChars, templatePlainText, templateTextContent, unescapeXml } from './hwpx/xmlText';
import { ROMAN_ORDINAL, toLatinLetters, toRoman } from './hwpx/ordinals';
import { figureCaption, formatMetaDate, getPlainText, getPrefixComparableText, metaValueToText, removePrefixComparableCharacters } from './hwpx/inlineText';
import { NUMERIC_CELL, contentColumnWidths } from './hwpx/tableLayout';
import { extractParagraphStartTag, readTemplate, replaceParagraphAttr, stripTemplateWrapperMarkers, writeHwpxOutput } from './hwpx/packaging';
import { readImagePixelSize, imageBinaryExtension } from './imageDimensions';
import { ConversionReportCollector, type ConversionReport } from './conversionReport';
import { normalizeTemplateMarkers, optionFlag, type MarkerOptions } from './templateMarkers';
import { latexMathToUnicode } from './latexSymbols';

type ActiveFormats = Set<string>;

export interface ImageSizeSource {
    displayWidthPx?: number;
    displayHeightPx?: number;
}

function isPositiveFinite(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function pickBaseImageSize(
    asset: ImageSizeSource,
    bytes: Buffer | undefined,
    config: ConversionConfig
): { width: number; height: number } {
    if (!config.USE_NATIVE_IMAGE_SIZE) {
        return { width: config.IMAGE_DEFAULT_WIDTH, height: config.IMAGE_DEFAULT_HEIGHT };
    }

    if (isPositiveFinite(asset.displayWidthPx) && isPositiveFinite(asset.displayHeightPx)) {
        return {
            width: asset.displayWidthPx * config.LUNIT_PER_PX,
            height: asset.displayHeightPx * config.LUNIT_PER_PX,
        };
    }

    const intrinsic = bytes ? readImagePixelSize(bytes) : null;
    if (intrinsic && isPositiveFinite(intrinsic.width) && isPositiveFinite(intrinsic.height)) {
        return {
            width: intrinsic.width * config.LUNIT_PER_PX,
            height: intrinsic.height * config.LUNIT_PER_PX,
        };
    }

    return { width: config.IMAGE_DEFAULT_WIDTH, height: config.IMAGE_DEFAULT_HEIGHT };
}

function clampImageSize(
    size: { width: number; height: number },
    availableWidth: number,
    config: ConversionConfig
): { width: number; height: number } {
    const safeWidth = isPositiveFinite(size.width) ? size.width : config.IMAGE_DEFAULT_WIDTH;
    const safeHeight = isPositiveFinite(size.height) ? size.height : config.IMAGE_DEFAULT_HEIGHT;
    const safeAvailable = isPositiveFinite(availableWidth)
        ? availableWidth
        : config.IMAGE_MAX_WIDTH;
    const maxWidth = Math.max(1, Math.min(safeAvailable, config.IMAGE_MAX_WIDTH));
    const maxHeight = Math.max(1, config.IMAGE_MAX_HEIGHT);
    const ratio = Math.min(1, maxWidth / safeWidth, maxHeight / safeHeight);
    const width = safeWidth * ratio;
    const height = safeHeight * ratio;
    return {
        width: isPositiveFinite(width) ? Math.max(1, Math.round(width)) : 1,
        height: isPositiveFinite(height) ? Math.max(1, Math.round(height)) : 1,
    };
}

export function resolveImageSize(
    asset: ImageSizeSource,
    bytes: Buffer | undefined,
    availableWidth: number,
    config: ConversionConfig
): { width: number; height: number } {
    return clampImageSize(pickBaseImageSize(asset, bytes, config), availableWidth, config);
}

// ============================================================
// Char-property cache key helper
// ============================================================

interface TemplateTextSegment {
    charPrIDRef: string;
    text: string;
}

interface WrappedPlaceholderText {
    prefix: string;
    prefixCharPrIDRef: string | null;
    suffix: string;
    suffixCharPrIDRef: string | null;
}

interface RuleTemplateFragment {
    contentXml: string;
    tableXml: string;
    tableStart: number;
    tableEnd: number;
}

interface TableRuleTemplate {
    ownerParagraphXml: string;
    markerTableXml: string;
    contentXml: string;
}

interface TableLayoutTemplate {
    startTag: string;
    szXml: string;
    posXml: string;
    outMarginXml: string;
    inMarginXml: string;
}

interface DirectTableTemplate {
    ownerParagraphXml: string;
    tableStart: number;
    tableEnd: number;
}

type PrefixPlaceholderKind = 'literal' | 'number' | 'number-period';

interface PrefixPlaceholderRule {
    marker: string;
    token: string;
    leadingSpaces: number;
    spacingMode: 'exact' | 'any';
    kind: PrefixPlaceholderKind;
    style: PlaceholderStyle;
    sourceOrder: number;
}

interface PrefixPlaceholderMatch {
    rule: PrefixPlaceholderRule;
    inlinePrefixLength: number;
}

interface PrefixPlaceholderCoreMatch {
    rule: PrefixPlaceholderRule;
    tokenLength: number;
}

interface HeadingPrefixRule {
    marker: string;
    level: number;
    pattern: RegExp;
    strip: boolean;
    specificity: number;
    style: PlaceholderStyle;
}

// ============================================================
// MarkdownToHwpx
// ============================================================

export class MarkdownToHwpx {
    // Placeholder patterns

    private ast: PandocAST;
    private styles: StyleRegistry;
    private headerXmlContent: string;
    private sectionXmlContent: string;
    private scanners = new Map<string, TemplateScanner>();

    private scanner(xml: string): TemplateScanner {
        let scanner = this.scanners.get(xml);
        if (!scanner) {
            scanner = new TemplateScanner(xml);
            this.scanners.set(xml, scanner);
        }
        return scanner;
    }
    private config: ConversionConfig;
    private inputDir: string | null = null;
    private imagePathResolver?: ImagePathResolver;
    private imageAssetResolver?: ImageAssetResolver;
    private availableWidthStack: number[] = [];

    /** Width left for content: the innermost container, else the template page's text width (plan 2.3). */
    private get availableWidth(): number {
        if (this.rootWidth === undefined) this.rootWidth = this.pageTextWidth() ?? this.config.IMAGE_MAX_WIDTH;
        return this.availableWidthStack.at(-1) ?? this.rootWidth;
    }
    private rootWidth: number | undefined;

    // Style maps
    private placeholderStyles: Record<string, PlaceholderStyle> = {};
    private prefixPlaceholderRules: PrefixPlaceholderRule[] = [];
    private headingPrefixRules: HeadingPrefixRule[] = [];
    private cellStyles: Record<string, CellStyle> = {};
    private listStyles: Record<string, ListStyle> = {};
    private templateTableWidth: number | null = null;
    private templateTableBorderFillId: string | null = null;
    private tableRuleTemplate: TableRuleTemplate | null = null;
    private directTableTemplate: DirectTableTemplate | null = null;
    private tableLayoutTemplate: TableLayoutTemplate | null = null;
    private warnedMissingTableRuleTemplate = false;

    // Header counters for auto-numbering
    private headerCounters: Record<number, number> = {};
    private hasEmittedBlock = false;

    // Images
    images: ImageMeta[] = [];
    title: string | null = null;

    // Paragraph ID counter (0 is reserved for the secPr paragraph)
    private paraIdCounter = 1;
    // Tables, pictures and shapes share one id space (above every template object id).
    private objectIdCounter = 1;
    private fieldIdCounter = 1;
    private footnoteCounter = 0;

    /** Characters XML cannot hold that were dropped from body text (for the conversion report). */
    removedControlCharCount = 0;
    /** What this conversion could not express as written (see conversionReport.ts). */
    readonly report = new ConversionReportCollector();
    private noteName: string | null = null;
    private markerOptions = new Map<string, MarkerOptions>();
    /** Variant chosen by <!-- hwpx:style=… --> (or a callout name) for the block being rendered. */
    private styleVariant: string | null = null;
    /** Callout type → quote style key, from {{QUOTE_*|callouts=…}} (overrides CALLOUT_QUOTE_TYPES). */
    private calloutAliases = new Map<string, string>();
    /** Emoji lists from {{QUOTE_*|emoji=…}}, checked before QUOTE_EMOJI_TYPES. */
    private quoteEmoji: { key: string; emojis: string[] }[] = [];
    /** Variant of {{QUOTE:…|lead}}, for quotes that come before any body block. */
    private leadQuoteVariant: string | null = null;
    /** 0-based list level that top-level lists start at, from the last heading's {{Hn|list=…}}. */
    private listStartLevel = 0;
    private figureCounter = 0;
    private tableCaptionCounter = 0;

    constructor(
        jsonAst: PandocAST,
        headerXmlContent: string,
        sectionXmlContent: string,
        inputPath: string | null = null,
        config: ConversionConfig | null = null,
        imagePathResolver?: ImagePathResolver,
        imageAssetResolver?: ImageAssetResolver
    ) {
        this.ast = jsonAst;
        this.headerXmlContent = headerXmlContent;
        this.sectionXmlContent = sectionXmlContent;
        this.config = config ?? DEFAULT_CONFIG;
        this.imagePathResolver = imagePathResolver;
        this.imageAssetResolver = imageAssetResolver;

        if (inputPath) {
            this.inputDir = path.dirname(path.resolve(inputPath));
            this.noteName = path.basename(inputPath).replace(/\.[^./\\]+$/, '');
        }

        this.extractMetadata();
        // Template-side {{META:*}} (rule fragments, fixed regions, header/footer)
        // is filled before anything reads the template; note text is untouched.
        this.sectionXmlContent = this.substituteMetaMarkers(this.sectionXmlContent);
        // {{KIND|option=value}}: options go to a side table, markers back to their plain form.
        const markers = normalizeTemplateMarkers(this.sectionXmlContent);
        this.sectionXmlContent = markers.xml;
        this.markerOptions = markers.options;
        for (const marker of markers.unknownOptions) {
            this.report.add('template_option_unknown', '템플릿 marker의 알 수 없는 옵션을 무시함', marker);
        }
        this.styles = new StyleRegistry(this.headerXmlContent);
        if (this.sectionXmlContent) {
            this.objectIdCounter = Math.max(
                findMaxAttrValue(this.sectionXmlContent, /<hp:(?!p\b|fieldBegin\b|fieldEnd\b)[A-Za-z]+\b[^>]*\sid="(\d+)"/g),
                findMaxAttrValue(this.sectionXmlContent, /<hp:[A-Za-z]+\b[^>]*\sinstid="(\d+)"/g)
            ) + 1;
            this.fieldIdCounter = findMaxAttrValue(this.sectionXmlContent, /<hp:fieldBegin\b[^>]*\bid="(\d+)"/g) + 1;
            this.loadPlaceholderStyles();
        }
    }

    /**
     * The template rules this converter loaded, for the template inspector.
     * Marker text → the style ids it resolved to; nothing here is rendered.
     */
    describeTemplateRules(): Array<{
        marker: string;
        kind: 'block' | 'heading_number' | 'prefix' | 'list' | 'cell';
        paraPrIDRef: string;
        charPrIDRef: string;
        styleIDRef?: string;
        mode?: string;
    }> {
        const blocks = Object.entries(this.placeholderStyles).map(([name, style]) => ({
            marker: `{{${name}}}`, kind: 'block' as const, mode: style.mode,
            paraPrIDRef: style.paraPrIDRef, charPrIDRef: style.charPrIDRef, styleIDRef: style.styleIDRef,
        }));
        const headingNumbers = this.headingPrefixRules.map((rule) => ({
            marker: rule.marker, kind: 'heading_number' as const,
            paraPrIDRef: rule.style.paraPrIDRef, charPrIDRef: rule.style.charPrIDRef, styleIDRef: rule.style.styleIDRef,
        }));
        const prefixes = this.prefixPlaceholderRules.map((rule) => ({
            marker: rule.marker, kind: 'prefix' as const, mode: rule.kind,
            paraPrIDRef: rule.style.paraPrIDRef, charPrIDRef: rule.style.charPrIDRef, styleIDRef: rule.style.styleIDRef,
        }));
        const lists = Object.entries(this.listStyles).map(([name, style]) => ({
            marker: `{{LIST_${name}}}`, kind: 'list' as const, mode: style.mode,
            paraPrIDRef: style.paraPrIDRef, charPrIDRef: style.charPrIDRef, styleIDRef: style.styleIDRef,
        }));
        const cells = Object.entries(this.cellStyles).map(([name, style]) => ({
            marker: `{{CELL_${name}}}`, kind: 'cell' as const,
            mode: this.tableRuleTemplate ? 'rule_table' : this.directTableTemplate ? 'direct_table' : undefined,
            paraPrIDRef: style.paraPrIDRef, charPrIDRef: style.charPrIDRef, styleIDRef: style.styleIDRef,
        }));
        return [...blocks, ...headingNumbers, ...prefixes, ...lists, ...cells];
    }

    // ============================================================
    // Static entry points
    // ============================================================

    /** @see readTemplate in ./hwpx/packaging */
    static readonly readTemplate = readTemplate;
    /** @see writeHwpxOutput in ./hwpx/packaging */
    static readonly writeHwpxOutput = writeHwpxOutput;

    static async convertToHwpx(
        inputPath: string | null,
        outputPath: string,
        referencePath: string,
        jsonAst: PandocAST,
        config: ConversionConfig | null = null,
        imagePathResolver?: ImagePathResolver,
        imageAssetResolver?: ImageAssetResolver
    ): Promise<ConversionReport> {
        const cfg = config ?? DEFAULT_CONFIG;

        MarkdownToHwpx.validateInputs(inputPath, referencePath, jsonAst, cfg);

        const { headerXml, sectionXml, refDocBytes } =
            await readTemplate(referencePath);

        const converter = new MarkdownToHwpx(
            jsonAst, headerXml, sectionXml, inputPath, cfg, imagePathResolver, imageAssetResolver
        );
        const {
            xmlBody, newHeaderXml, templateSectionXml, keepFirstParagraph,
        } = converter.convert();

        await writeHwpxOutput(
            outputPath, refDocBytes, xmlBody, newHeaderXml,
            converter.images, converter.title, inputPath,
            templateSectionXml, keepFirstParagraph
        );
        return converter.report.toJSON();
    }

    // ============================================================
    // Validation
    // ============================================================

    private static validateInputs(
        inputPath: string | null,
        referencePath: string,
        jsonAst: PandocAST,
        config: ConversionConfig
    ): void {
        if (!fs.existsSync(referencePath)) {
            throw new TemplateError(`Reference template not found: ${referencePath}`);
        }
        if (!jsonAst) {
            throw new ConversionError('jsonAst parameter is required');
        }
        // inputPath may name a note that only exists in memory (convertString);
        // its text size is checked by the caller.
        if (inputPath !== null && fs.existsSync(inputPath)) {
            const inputSize = fs.statSync(inputPath).size;
            if (inputSize > config.MAX_INPUT_FILE_SIZE) {
                throw new SecurityError(`Input file too large: ${inputSize} bytes`);
            }
        }
        const refSize = fs.statSync(referencePath).size;
        if (refSize > config.MAX_TEMPLATE_FILE_SIZE) {
            throw new SecurityError(`Template file too large: ${refSize} bytes`);
        }
    }

    static validateImagePath(imagePath: string, baseDir: string | null = null): void {
        if (path.isAbsolute(imagePath)) {
            throw new SecurityError(`Absolute image paths are not allowed: ${imagePath}`);
        }
        const normalized = path.normalize(imagePath);
        const parts = normalized.replace(/\\/g, '/').split('/');
        if (parts.includes('..')) {
            throw new SecurityError(`Directory traversal in image path is not allowed: ${imagePath}`);
        }
        if (baseDir) {
            const resolved = path.normalize(path.join(baseDir, imagePath));
            const baseResolved = path.normalize(baseDir);
            if (!resolved.startsWith(baseResolved + path.sep) && resolved !== baseResolved) {
                throw new SecurityError(`Image path resolves outside input directory: ${imagePath}`);
            }
        }
    }

    // ============================================================
    // Metadata extraction
    // ============================================================

    /**
     * `{{META:key}}` / `{{META:key|format=YYYY. M. D.}}` → the frontmatter value
     * (`title` falls back to the note name). A missing key becomes empty text
     * and is reported.
     */
    private substituteMetaMarkers(xml: string): string {
        if (!xml.includes('{{META:')) return xml;
        return xml.replace(/\{\{META:([^{}|<>]+?)(?:\|format=([^{}<>]*))?\}\}/g, (_match, rawKey: string, rawFormat?: string) => {
            const key = unescapeXml(rawKey).trim();
            const value = this.metaText(key);
            if (value === null) {
                this.report.add('meta_missing', 'frontmatter에 없는 META 값을 빈칸으로 둠', key);
                return '';
            }
            return escapeXml(rawFormat ? formatMetaDate(value, unescapeXml(rawFormat)) : value);
        });
    }

    private metaText(key: string): string | null {
        const meta = this.ast?.meta ?? {};
        const value = meta[key] ?? Object.entries(meta).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
        if (value) return metaValueToText(value);
        return key.toLowerCase() === 'title' ? this.noteName : null;
    }

    /** Table variant: the block's <!-- hwpx:style --> or the note's `hwpx-table` frontmatter. */
    private tableVariant(): string | null {
        return this.styleVariant ?? this.metaText('hwpx-table');
    }

    private extractMetadata(): void {
        if (!this.ast) return;
        const meta = this.ast.meta ?? {};
        if ('title' in meta) {
            const tObj = meta['title'];
            if (tObj.t === 'MetaInlines') {
                this.title = getPlainText(tObj.c);
            } else if (tObj.t === 'MetaString') {
                this.title = tObj.c;
            }
        }
    }

    // ============================================================
    // Placeholder style loading
    // ============================================================

    private loadPlaceholderStyles(): void {
        if (!this.sectionXmlContent) return;
        try {
            this.extractPlaceholdersFromSection(this.sectionXmlContent);
        } catch (e) {
            console.warn('[md2hwpx] Failed to load placeholder styles:', e);
        }
    }

    private extractPlaceholdersFromSection(sectionXml: string): void {
        for (const name of [
            'BODY', 'CODE', 'CODE_INLINE', 'LINK', 'HR',
            'QUOTE', 'QUOTE_INFO', 'QUOTE_WARN', 'QUOTE_SUCCESS', 'QUOTE_DANGER',
            'STRONG', 'EMPH', 'STRIKE', 'UNDERLINE', 'HIGHLIGHT', 'FOOTNOTE', 'FIGURE', 'MATH', 'MATH_INLINE',
        ]) {
            const ph = `{{${name}}}`;
            const style = this.extractGeneralPlaceholderStyle(sectionXml, ph);
            if (style) {
                this.placeholderStyles[name] = style;
            }
        }
        // Markers whose paragraph text around the marker matters ("그림 {{#}}. {{CAPTION}}",
        // "☐ {{TASK_OPEN}}"): read like headings, prefix and suffix included.
        for (const name of ['CAPTION', 'TABLE_CAPTION', 'CODE_LANG', 'TASK_OPEN', 'TASK_DONE']) {
            if (!sectionXml.includes(`{{${name}}}`)) continue;
            const style = this.extractHeaderPlaceholderStyle(sectionXml, `{{${name}}}`);
            if (style) this.placeholderStyles[name] = style;
        }
        // Further quote kinds ({{QUOTE_NOTE}}) and template callout/emoji aliases:
        // {{QUOTE_WARN|callouts=warning,caution|emoji=⚠️,❗}} (plan 3.3).
        for (const match of sectionXml.matchAll(/\{\{(QUOTE_[A-Z0-9]+)\}\}/g)) {
            if (this.placeholderStyles[match[1]]) continue;
            const style = this.extractGeneralPlaceholderStyle(sectionXml, match[0], match.index);
            if (style) this.placeholderStyles[match[1]] = style;
        }
        for (const [marker, options] of this.markerOptions) {
            const key = /^\{\{(QUOTE(?:_[A-Z0-9]+)?)\}\}$/.exec(marker)?.[1];
            if (!key) continue;
            const list = (value: string | true | undefined): string[] =>
                typeof value === 'string' ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
            for (const type of list(options.callouts)) this.calloutAliases.set(type.toLowerCase(), key);
            const emojis = list(options.emoji);
            if (emojis.length > 0) this.quoteEmoji.push({ key, emojis });
        }

        // {{CALLOUT_<TYPE>}} (one per Obsidian callout type) and {{CALLOUT_TITLE}}.
        for (const match of sectionXml.matchAll(/\{\{(CALLOUT_[\p{L}\p{N}_]+)\}\}/gu)) {
            if (this.placeholderStyles[match[1]]) continue;
            const style = this.extractGeneralPlaceholderStyle(sectionXml, match[0], match.index);
            if (style) {
                this.placeholderStyles[match[1]] = style;
            }
        }

        // Named variants (plan 3.6): {{BODY:요약}}, {{H2:부록}}, {{QUOTE:주의}}, {{CODE:작게}}.
        // A numbered-heading rule such as {{H2:1.}} is not a variant.
        for (const match of sectionXml.matchAll(/\{\{((?:H[1-9]|BODY|CODE|QUOTE|HR):([^{}:|<>\r\n]+))\}\}/g)) {
            const [ph, key, variant] = match;
            if (this.placeholderStyles[key] || /^(?:1(?:\.1)*[.)]?|\(1(?:\.1)*\))$/.test(variant)) continue;
            const style = key.startsWith('H')
                ? this.extractHeaderPlaceholderStyle(sectionXml, ph)
                : this.extractGeneralPlaceholderStyle(sectionXml, ph, match.index);
            if (style) this.placeholderStyles[key] = style;
        }
        // {{QUOTE:요약|lead}}: quotes before any body block (a report's summary box) use this variant.
        for (const [marker, options] of this.markerOptions) {
            const variant = /^\{\{QUOTE:([^{}:|]+)\}\}$/.exec(marker)?.[1];
            if (variant && options.lead && this.placeholderStyles[`QUOTE:${variant}`]) this.leadQuoteVariant = variant;
        }
        for (const match of sectionXml.matchAll(/\{\{CELL_([A-Z_]+:[^{}:|<>\r\n]+)\}\}/g)) {
            const style = this.extractCellStyle(sectionXml, match[0]);
            if (style) this.cellStyles[match[1]] = style;
        }

        this.loadPrefixPlaceholderRules(sectionXml);
        this.loadHeadingPrefixRules(sectionXml);
        this.loadInlineFormatStyles();

        for (let level = 1; level <= 9; level++) {
            const ph = `{{H${level}}}`;
            if (!sectionXml.includes(ph)) continue;

            const style = this.extractHeaderPlaceholderStyle(sectionXml, ph);
            if (style) {
                this.placeholderStyles[`H${level}`] = style;
            }
        }

        const listPlaceholderPattern = /\{\{LIST_(BULLET|ORDERED)_(\d+)\}\}/g;
        for (const match of sectionXml.matchAll(listPlaceholderPattern)) {
            const listType = match[1];
            const level = match[2];
            const ph = match[0];
            const style = this.extractListPlaceholderStyle(sectionXml, ph);
            if (style) {
                this.listStyles[`${listType}_${level}`] = style;
            }
        }

        const cellPlaceholderPattern = /\{\{CELL_([A-Z_]+)\}\}/g;
        for (const match of sectionXml.matchAll(cellPlaceholderPattern)) {
            const key = match[1];
            const ph = match[0];
            const style = this.extractCellStyle(sectionXml, ph);
            if (!style) continue;

            this.cellStyles[key] = style;
            if (this.tableRuleTemplate === null) {
                const ruleFragment = this.findSingleCellRuleTemplateFragment(sectionXml, sectionXml.indexOf(ph), ph);
                if (ruleFragment) {
                    const ownerParagraph = this.findEnclosingParagraph(sectionXml, ruleFragment.tableStart);
                    if (ownerParagraph) {
                        this.tableRuleTemplate = {
                            ownerParagraphXml: ownerParagraph.paraXml,
                            markerTableXml: ruleFragment.tableXml,
                            contentXml: ruleFragment.contentXml,
                        };
                    }
                }
            }
            const tableCtx = this.findEnclosingTable(sectionXml, sectionXml.indexOf(ph));
            if (tableCtx) {
                if (this.directTableTemplate === null) {
                    const ownerParagraph = this.findEnclosingParagraph(sectionXml, tableCtx.tableStart);
                    if (ownerParagraph) {
                        this.directTableTemplate = {
                            ownerParagraphXml: ownerParagraph.paraXml,
                            tableStart: tableCtx.tableStart - ownerParagraph.paraStart,
                            tableEnd: tableCtx.tableEnd - ownerParagraph.paraStart,
                        };
                    }
                }
                if (this.templateTableWidth === null) {
                    this.templateTableWidth = this.extractTableWidth(tableCtx.tableXml);
                }
                if (this.templateTableBorderFillId === null) {
                    this.templateTableBorderFillId = this.extractTableBorderFillId(tableCtx.tableXml);
                }
                if (this.tableLayoutTemplate === null) {
                    this.tableLayoutTemplate = this.extractTableLayoutTemplate(tableCtx.tableXml);
                }
            }
        }
    }

    /** Scoped numeric heading rules. Numbers in the pattern are digit wildcards,
     * punctuation is literal, and a whitespace/end boundary prevents matching years
     * or decimal numbers as an unrelated numbering scheme. No user regex executes.
     */
    private loadHeadingPrefixRules(sectionXml: string): void {
        for (const match of sectionXml.matchAll(/\{\{H([1-9]):([^{}:\s]+)(?::(keep|strip))?\}\}/g)) {
            const [marker, level, token, mode] = match;
            if (!/^(?:1(?:\.1)*[.)]?|\(1(?:\.1)*\))$/.test(token)) continue;
            if (this.headingPrefixRules.some(rule => rule.marker === marker)) {
                console.warn(`[md2hwpx] Duplicate heading prefix marker "${marker}"; keeping first definition.`);
                this.report.add('template_marker_duplicate', '템플릿 marker가 두 번 정의되어 첫 정의를 씀', marker);
                continue;
            }
            const style = this.extractGeneralPlaceholderStyle(sectionXml, marker, match.index);
            if (!style) continue;
            const source = token.split('').map(char => char === '1'
                ? '[0-9]+'
                : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
            this.headingPrefixRules.push({
                marker, level: Number(level), pattern: new RegExp(`^${source}(?=\\s|$)`),
                strip: mode === 'strip', specificity: token.length, style,
            });
        }
        // More specific hierarchical/delimited patterns win over bare numbers.
        this.headingPrefixRules.sort((a, b) => b.specificity - a.specificity);
    }

    private loadPrefixPlaceholderRules(sectionXml: string): void {
        const prefixPlaceholderPattern = /\{\{( *)([^\sA-Za-z_{}][^\s{}]*)\}\}/g;

        for (const match of sectionXml.matchAll(prefixPlaceholderPattern)) {
            const marker = match[0];
            const spaces = match[1] ?? '';
            const markerToken = match[2] ?? '';
            // {{#}} / {{#:가}} is the counter position token (formatCounterText), not a prefix rule.
            if (markerToken.startsWith('#')) continue;
            const anySpacing = spaces.length === 0 && markerToken.startsWith('~');
            const token = anySpacing ? markerToken.slice(1) : markerToken;

            if (!token) {
                console.warn(`[md2hwpx] Ignoring prefix placeholder without a bullet token: ${marker}`);
                this.report.add('template_marker_ignored', '템플릿 marker를 인식하지 못해 무시함', marker);
                continue;
            }

            let kind: PrefixPlaceholderKind;
            if (/^\d+\.$/.test(token)) {
                kind = 'number-period';
            } else if (/^\d+$/.test(token)) {
                kind = 'number';
            } else if (/^[\p{P}\p{S}\p{Script=Hangul}]+$/u.test(token)) {
                kind = 'literal';
            } else {
                console.warn(`[md2hwpx] Ignoring unsupported prefix placeholder token: ${marker}`);
                this.report.add('template_marker_ignored', '템플릿 marker를 인식하지 못해 무시함', marker);
                continue;
            }

            // The template is scanned as raw XML. Ampersand and less-than
            // must be entity-escaped in XML text, so they are not supported
            // by this string-based marker loader. Greater-than and quotes are
            // valid character data and remain available for tokens such as
            // {{->}}.
            if (/[&<]/.test(token)) {
                console.warn(
                    `[md2hwpx] Ignoring prefix placeholder token with XML-reserved characters: ${marker}`
                );
                this.report.add('template_marker_ignored', '템플릿 marker를 인식하지 못해 무시함', marker);
                continue;
            }

            if (this.prefixPlaceholderRules.some((rule) => rule.marker === marker)) {
                console.warn(
                    `[md2hwpx] Duplicate prefix placeholder marker "${marker}" — keeping first definition.`
                );
                this.report.add('template_marker_duplicate', '템플릿 marker가 두 번 정의되어 첫 정의를 씀', marker);
                continue;
            }

            const position = match.index ?? sectionXml.indexOf(marker);
            const style = this.extractGeneralPlaceholderStyle(sectionXml, marker, position);
            if (!style) continue;

            this.prefixPlaceholderRules.push({
                marker,
                token,
                leadingSpaces: spaces.length,
                spacingMode: anySpacing ? 'any' : 'exact',
                kind,
                style,
                sourceOrder: this.prefixPlaceholderRules.length,
            });
        }

        this.prefixPlaceholderRules.sort(comparePrefixPlaceholderRules);
    }

    private extractGeneralPlaceholderStyle(
        sectionXml: string,
        placeholder: string,
        position?: number
    ): PlaceholderStyle | null {
        const pos = position ?? this.scanner(sectionXml).model.markers.find(marker => marker.text === placeholder)?.start ?? -1;
        if (pos === -1) return null;

        const paraCtx = this.findEnclosingParagraph(sectionXml, pos);
        if (!paraCtx) return null;

        const paraStyle = this.extractParaStyleFromParagraph(paraCtx.paraXml, placeholder);
        if (!paraStyle) return null;

        const ruleFragment = this.findSingleCellRuleTemplateFragment(sectionXml, pos, placeholder);
        const wrapped = this.extractWrappedTextAroundPlaceholder(paraCtx.paraXml, placeholder);
        // A quote rule may lead each paragraph with a mark, e.g. "※<tab>{{QUOTE}}".
        const quoteMark = !wrapped && placeholder.startsWith('{{QUOTE')
            ? this.extractPrefixBeforePlaceholder(paraCtx.paraXml, placeholder)
            : null;
        return {
            ...paraStyle,
            mode: 'plain',
            prefix: wrapped?.prefix ?? (quoteMark?.prefix || null),
            prefixCharPrIDRef: wrapped?.prefixCharPrIDRef ?? (quoteMark?.prefix ? quoteMark.prefixCharPrIDRef : null),
            suffix: wrapped?.suffix ?? null,
            suffixCharPrIDRef: wrapped?.suffixCharPrIDRef ?? null,
            markerOwnerParagraph: ruleFragment?.contentXml ?? null,
        };
    }

    private extractListPlaceholderStyle(sectionXml: string, placeholder: string): ListStyle | null {
        const pos = this.scanner(sectionXml).model.markers.find(marker => marker.text === placeholder)?.start ?? -1;
        if (pos === -1) return null;

        const paraCtx = this.findEnclosingParagraph(sectionXml, pos);
        if (!paraCtx) return null;

        const paraStyle = this.extractParaStyleFromParagraph(paraCtx.paraXml, placeholder);
        if (!paraStyle) return null;

        const prefixInfo = this.extractPrefixBeforePlaceholder(paraCtx.paraXml, placeholder);
        const wrapped = this.extractWrappedTextAroundPlaceholder(paraCtx.paraXml, placeholder);
        const hasNumbering = this.paraPrHasNumbering(paraStyle.paraPrIDRef);
        const prefix = wrapped?.prefix ?? prefixInfo.prefix;
        const ruleFragment = this.findSingleCellRuleTemplateFragment(sectionXml, pos, placeholder);

        return {
            ...paraStyle,
            mode: hasNumbering ? 'numbering' : 'prefix',
            prefix: hasNumbering ? null : (prefix.length > 0 ? prefix : null),
            prefixCharPrIDRef: hasNumbering
                ? null
                : (wrapped?.prefixCharPrIDRef ?? (prefix.length > 0 ? prefixInfo.prefixCharPrIDRef : null)),
            suffix: hasNumbering ? null : (wrapped?.suffix ? wrapped.suffix : null),
            suffixCharPrIDRef: hasNumbering ? null : (wrapped?.suffixCharPrIDRef ?? null),
            markerOwnerParagraph: ruleFragment?.contentXml ?? null,
        };
    }

    private extractCellStyle(sectionXml: string, placeholder: string): CellStyle | null {
        const pos = this.scanner(sectionXml).model.markers.find(marker => marker.text === placeholder)?.start ?? -1;
        if (pos === -1) return null;

        const cellCtx = this.findEnclosingCell(sectionXml, pos);
        const paraCtx = this.findEnclosingParagraph(sectionXml, pos);
        if (!cellCtx || !paraCtx) return null;

        const paraStyle = this.extractParaStyleFromParagraph(paraCtx.paraXml, placeholder);
        if (!paraStyle) return null;

        const borderFillMatch = cellCtx.cellXml.match(/borderFillIDRef="(\d+)"/);

        return {
            ...paraStyle,
            borderFillIDRef: borderFillMatch?.[1] ?? this.styles.tableBorderFillId,
            cellStartTag: cellCtx.cellXml.match(/^<hp:tc\b[^>]*>/)?.[0],
            subListStartTag: cellCtx.cellXml.match(/<hp:subList\b[^>]*>/)?.[0],
            cellMargin: this.extractCellMargin(cellCtx.cellXml),
        };
    }

    private findEnclosingTable(xml: string, markerPos: number): { tableXml: string; tableStart: number; tableEnd: number } | null {
        const table = this.scanner(xml).enclosing('hp:tbl', markerPos);
        return table ? { tableXml: table.xml, tableStart: table.start, tableEnd: table.end } : null;
    }


    private findEnclosingTables(xml: string, markerPos: number): { tableXml: string; tableStart: number; tableEnd: number }[] {
        return this.scanner(xml).enclosingAll('hp:tbl', markerPos)
            .map(table => ({ tableXml: table.xml, tableStart: table.start, tableEnd: table.end }));
    }


    private findSingleCellRuleTemplateFragment(
        sectionXml: string,
        markerPos: number,
        placeholder: string
    ): RuleTemplateFragment | null {
        const enclosingTables = this.findEnclosingTables(sectionXml, markerPos);
        for (const tableCtx of enclosingTables) {
            if (!tableCtx.tableXml.includes(placeholder)) {
                continue;
            }
            if (!this.hasSingleCellTableShape(tableCtx.tableXml)) {
                continue;
            }

            const contentXml = this.extractFirstCellSubListInnerXml(tableCtx.tableXml);
            if (contentXml === null) {
                continue;
            }

            return {
                tableXml: tableCtx.tableXml,
                contentXml,
                tableStart: tableCtx.tableStart,
                tableEnd: tableCtx.tableEnd,
            };
        }

        return null;
    }

    private hasSingleCellTableShape(tableXml: string): boolean {
        const startTag = tableXml.match(/^<hp:tbl\b[^>]*>/)?.[0] ?? '';
        const hasOneColumn = /\b(?:colCount|colCnt)="1"/.test(startTag);
        const hasOneRow = /\b(?:rowCount|rowCnt)="1"/.test(startTag);
        return hasOneColumn && hasOneRow;
    }

    private extractFirstCellSubListInnerXml(tableXml: string): string | null {
        const subListStart = tableXml.indexOf('<hp:subList');
        if (subListStart === -1) {
            return null;
        }

        const subList = this.extractElementAt(tableXml, subListStart, 'hp:subList');
        if (!subList) {
            return null;
        }

        const openEnd = subList.xml.indexOf('>');
        if (openEnd === -1 || !subList.xml.endsWith('</hp:subList>')) {
            return null;
        }

        return subList.xml.slice(openEnd + 1, -'</hp:subList>'.length);
    }

    private extractElementAt(xml: string, elementStart: number, tagName: string): { xml: string; start: number; end: number } | null {
        return this.scanner(xml).elementAt(tagName, elementStart);
    }


    private findEnclosingCell(xml: string, markerPos: number): { cellXml: string; cellStart: number; cellEnd: number } | null {
        const cell = this.scanner(xml).enclosing('hp:tc', markerPos);
        return cell ? { cellXml: cell.xml, cellStart: cell.start, cellEnd: cell.end } : null;
    }


    private extractCellMargin(cellXml: string): { left: number; right: number; top: number; bottom: number } {
        const marginMatch = cellXml.match(
            /<hp:cellMargin\b[^>]*left="(\d+)"[^>]*right="(\d+)"[^>]*top="(\d+)"[^>]*bottom="(\d+)"/
        );
        if (!marginMatch) {
            return this.config.CELL_MARGIN_DEFAULT;
        }

        return {
            left: parseInt(marginMatch[1], 10),
            right: parseInt(marginMatch[2], 10),
            top: parseInt(marginMatch[3], 10),
            bottom: parseInt(marginMatch[4], 10),
        };
    }

    private extractTableWidth(tableXml: string): number | null {
        const widthMatch = tableXml.match(/<hp:sz\b[^>]*width="(\d+)"/);
        return widthMatch?.[1] ? parseInt(widthMatch[1], 10) : null;
    }

    private extractTableBorderFillId(tableXml: string): string | null {
        const startTag = tableXml.match(/^<hp:tbl\b[^>]*>/)?.[0] ?? '';
        return startTag.match(/\bborderFillIDRef="(\d+)"/)?.[1] ?? null;
    }

    private extractTableLayoutTemplate(tableXml: string): TableLayoutTemplate | null {
        const startTag = tableXml.match(/^<hp:tbl\b[^>]*>/)?.[0] ?? '';
        if (!startTag) return null;

        return {
            startTag,
            szXml: tableXml.match(/<hp:sz\b[^>]*\/>/)?.[0] ?? '',
            posXml: tableXml.match(/<hp:pos\b[^>]*\/>/)?.[0] ?? '',
            outMarginXml: tableXml.match(/<hp:outMargin\b[^>]*\/>/)?.[0] ?? '',
            inMarginXml: tableXml.match(/<hp:inMargin\b[^>]*\/>/)?.[0] ?? '',
        };
    }

    private findTableNumberingText(tableXml: string, placeholder: string): string | null {
        for (const match of tableXml.matchAll(HP_TEXT_PATTERN)) {
            const text = templateTextContent(match[2] ?? '').trim();
            if (!text) continue;
            if (text.includes(placeholder)) continue;
            if (/\{\{[A-Z0-9_]+\}\}/.test(text)) continue;
            // Labels such as "장" sit next to the number cell; only a text the
            // counter can rewrite is the heading number.
            if (this.formatCounterText(text, 2) === text) continue;
            return text;
        }
        return null;
    }

    private paraPrHasNumbering(paraPrId: string): boolean {
        const paraPrBlock = this.styles.extractHeaderParaPrXml(paraPrId);
        if (!paraPrBlock) return false;
        return /<hh:numPr\b/.test(paraPrBlock) || /<hh:heading\b[^>]*type="NUMBER"/.test(paraPrBlock);
    }

    private extractHeaderPlaceholderStyle(sectionXml: string, placeholder: string): PlaceholderStyle | null {
        const pos = this.scanner(sectionXml).model.markers.find(marker => marker.text === placeholder)?.start ?? -1;
        if (pos === -1) return null;

        const ruleFragment = this.findSingleCellRuleTemplateFragment(sectionXml, pos, placeholder);
        const tableCtx = this.findEnclosingTable(sectionXml, pos);
        const isMarkerTable = !!ruleFragment || (tableCtx ? this.isSingleCellMarkerTable(tableCtx.tableXml, placeholder) : false);
        if (tableCtx && !isMarkerTable) {
            const paraCtx = this.findEnclosingParagraph(sectionXml, pos);
            if (!paraCtx) return null;

            const paraStyle = this.extractParaStyleFromParagraph(paraCtx.paraXml, placeholder);
            if (!paraStyle) return null;

            // Keep the paragraph shape and <hp:run> that hold the table in the template:
            // Hangul does not show a reused inline table without its run (DECISIONS 3.3).
            const ownerStart = sectionXml.lastIndexOf('<hp:p ', tableCtx.tableStart);
            const ownerTag = ownerStart >= 0 ? /^<hp:p\b[^>]*>/.exec(sectionXml.slice(ownerStart))?.[0] : undefined;
            const runStart = sectionXml.lastIndexOf('<hp:run', tableCtx.tableStart);
            const runTag = runStart > ownerStart ? /^<hp:run\b[^>]*>(?=\s*<hp:tbl\b)/.exec(sectionXml.slice(runStart))?.[0] ?? null : null;
            return {
                ...paraStyle,
                mode: 'table',
                table: tableCtx.tableXml,
                tableOwner: { paraPrIDRef: ownerTag ? /\bparaPrIDRef="(\d+)"/.exec(ownerTag)?.[1] ?? null : null, runTag },
                numberingText: this.findTableNumberingText(tableCtx.tableXml, placeholder),
            };
        }

        const paraCtx = this.findEnclosingParagraph(sectionXml, pos);
        if (!paraCtx) return null;

        const paraStyle = this.extractParaStyleFromParagraph(paraCtx.paraXml, placeholder);
        if (!paraStyle) return null;

        const prefixInfo = this.extractPrefixBeforePlaceholder(paraCtx.paraXml, placeholder);
        const leadingEmpty = this.extractLeadingEmptyParagraphStyle(sectionXml, paraCtx.paraStart);
        const wrapped = this.extractWrappedTextAroundPlaceholder(paraCtx.paraXml, placeholder);
        const prefix = wrapped?.prefix ?? prefixInfo.prefix;
        const prefixCharPrIDRef = wrapped?.prefixCharPrIDRef ?? prefixInfo.prefixCharPrIDRef;
        const suffix = wrapped?.suffix ?? null;
        const suffixCharPrIDRef = wrapped?.suffixCharPrIDRef ?? null;
        const hasPrefix = prefix.length > 0;
        const hasSuffix = !!suffix;
        return {
            ...paraStyle,
            mode: (hasPrefix || hasSuffix) ? 'prefix' : 'plain',
            prefix: hasPrefix ? prefix : null,
            prefixCharPrIDRef: hasPrefix ? prefixCharPrIDRef : null,
            suffix,
            suffixCharPrIDRef,
            leadingEmptyParagraph: leadingEmpty,
            markerOwnerParagraph: ruleFragment?.contentXml ?? null,
            numberingText: null,
        };
    }

    private isSingleCellMarkerTable(tableXml: string, placeholder: string): boolean {
        if (!tableXml.includes(placeholder)) {
            return false;
        }

        if (!/(?:colCount="1"|colCnt="1")/.test(tableXml)) {
            return false;
        }
        if (!/(?:rowCount="1"|rowCnt="1")/.test(tableXml)) {
            return false;
        }

        const cellCount = (tableXml.match(/<hp:tc\b/g) ?? []).length;
        if (cellCount !== 1) {
            return false;
        }

        const placeholders = [...tableXml.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)];
        return placeholders.length === 1 && placeholders[0][0] === placeholder;
    }

    private findEnclosingParagraph(xml: string, markerPos: number): { paraXml: string; paraStart: number; paraEnd: number } | null {
        const para = this.scanner(xml).enclosing('hp:p', markerPos);
        return para ? { paraXml: para.xml, paraStart: para.start, paraEnd: para.end } : null;
    }


    private extractParaStyleFromParagraph(
        paraXml: string,
        placeholderForCharPr?: string
    ): { charPrIDRef: string; paraPrIDRef: string; styleIDRef: string } | null {
        const paraPrMatch = paraXml.match(/paraPrIDRef="(\d+)"/);
        const styleMatch = paraXml.match(/styleIDRef="(\d+)"/);

        const runPattern = /<hp:run\b[^>]*charPrIDRef="(\d+)"[^>]*>([\s\S]*?)<\/hp:run>/g;
        let charPrIDRef = '0';
        let foundPlaceholderRun = false;

        for (const match of paraXml.matchAll(runPattern)) {
            const runCharPr = match[1];
            const runInner = match[2] ?? '';
            const runTexts = templatePlainText(runInner);

            if (placeholderForCharPr && runTexts.includes(placeholderForCharPr)) {
                charPrIDRef = runCharPr;
                foundPlaceholderRun = true;
                break;
            }
            if (!placeholderForCharPr && runCharPr) {
                charPrIDRef = runCharPr;
                break;
            }
        }

        if (!foundPlaceholderRun && placeholderForCharPr) {
            const fallback = paraXml.match(/<hp:run\b[^>]*charPrIDRef="(\d+)"/);
            if (fallback?.[1]) {
                charPrIDRef = fallback[1];
            }
        }

        return {
            charPrIDRef,
            paraPrIDRef: paraPrMatch?.[1] ?? this.styles.normalParaPrId,
            styleIDRef: styleMatch?.[1] ?? this.styles.normalStyleId,
        };
    }

    private extractPrefixBeforePlaceholder(
        paraXml: string,
        placeholder: string
    ): { prefix: string; prefixCharPrIDRef: string | null } {
        const runPattern = /<hp:run\b[^>]*charPrIDRef="(\d+)"[^>]*>([\s\S]*?)<\/hp:run>/g;
        let prefix = '';
        let prefixCharPrIDRef: string | null = null;

        for (const match of paraXml.matchAll(runPattern)) {
            const runCharPr = match[1];
            const runInner = match[2] ?? '';
            const runText = templatePlainText(runInner);

            if (!runText) {
                continue;
            }

            const idx = runText.indexOf(placeholder);
            if (idx !== -1) {
                const before = runText.slice(0, idx);
                if (before.length > 0) {
                    prefix += before;
                    prefixCharPrIDRef = runCharPr;
                }
                break;
            }

            prefix += runText;
            prefixCharPrIDRef = runCharPr;
        }

        return { prefix, prefixCharPrIDRef };
    }

    private extractWrappedTextAroundPlaceholder(
        paraXml: string,
        placeholder: string
    ): WrappedPlaceholderText | null {
        const segments = this.extractTextSegmentsFromParagraph(paraXml);
        if (segments.length === 0) return null;

        const paragraphText = segments.map((segment) => segment.text).join('');
        const placeholderStart = paragraphText.indexOf(placeholder);
        if (placeholderStart === -1) return null;

        const wrapperStart = paragraphText.lastIndexOf(TEMPLATE_WRAPPER_START, placeholderStart);
        if (wrapperStart === -1) return null;

        const wrapperEnd = paragraphText.indexOf(
            TEMPLATE_WRAPPER_END,
            placeholderStart + placeholder.length
        );
        if (wrapperEnd === -1) return null;

        const contentStart = wrapperStart + TEMPLATE_WRAPPER_START.length;
        const placeholderEnd = placeholderStart + placeholder.length;
        if (contentStart > placeholderStart || placeholderEnd > wrapperEnd) {
            return null;
        }

        return {
            prefix: paragraphText.slice(contentStart, placeholderStart),
            prefixCharPrIDRef: this.findSegmentCharPrInRange(
                segments,
                contentStart,
                placeholderStart,
                'end'
            ),
            suffix: paragraphText.slice(placeholderEnd, wrapperEnd),
            suffixCharPrIDRef: this.findSegmentCharPrInRange(
                segments,
                placeholderEnd,
                wrapperEnd,
                'start'
            ),
        };
    }

    private extractTextSegmentsFromParagraph(paraXml: string): TemplateTextSegment[] {
        const runPattern = /<hp:run\b[^>]*charPrIDRef="(\d+)"[^>]*>([\s\S]*?)<\/hp:run>/g;
        const segments: TemplateTextSegment[] = [];

        for (const match of paraXml.matchAll(runPattern)) {
            const charPrIDRef = match[1];
            const runInner = match[2] ?? '';
            const runText = templatePlainText(runInner);

            if (!runText) {
                continue;
            }

            segments.push({ charPrIDRef, text: runText });
        }

        return segments;
    }

    private findSegmentCharPrInRange(
        segments: TemplateTextSegment[],
        rangeStart: number,
        rangeEnd: number,
        bias: 'start' | 'end'
    ): string | null {
        if (rangeStart >= rangeEnd) return null;

        let cursor = 0;
        let matchedCharPr: string | null = null;

        for (const segment of segments) {
            const segStart = cursor;
            const segEnd = segStart + segment.text.length;
            cursor = segEnd;

            const overlapStart = Math.max(rangeStart, segStart);
            const overlapEnd = Math.min(rangeEnd, segEnd);
            if (overlapStart >= overlapEnd) {
                continue;
            }

            matchedCharPr = segment.charPrIDRef;
            if (bias === 'start') {
                return matchedCharPr;
            }
        }

        return matchedCharPr;
    }

    private extractLeadingEmptyParagraphStyle(
        xml: string,
        currentParaStart: number
    ): { charPrIDRef: string; paraPrIDRef: string; styleIDRef: string; rawParagraphXml: string } | null {
        const before = xml.slice(0, currentParaStart);
        const prevStart = before.lastIndexOf('<hp:p ');
        if (prevStart === -1) return null;

        const prevEndClose = xml.indexOf('</hp:p>', prevStart);
        if (prevEndClose === -1 || prevEndClose >= currentParaStart) return null;

        const prevParaXml = xml.slice(prevStart, prevEndClose + '</hp:p>'.length);
        if (!this.isSemanticallyEmptyParagraph(prevParaXml)) {
            return null;
        }

        const paraStyle = this.extractParaStyleFromParagraph(prevParaXml);
        if (!paraStyle) {
            return null;
        }

        return {
            ...paraStyle,
            rawParagraphXml: prevParaXml,
        };
    }

    private isSemanticallyEmptyParagraph(paraXml: string): boolean {
        const text = templatePlainText(paraXml);
        if (/\{\{[A-Z0-9_]+\}\}/.test(text)) {
            return false;
        }
        return text.replace(/\u00A0/g, ' ').trim().length === 0;
    }

    // ============================================================
    // Main convert()
    // ============================================================

    convert(): {
        xmlBody: string;
        newHeaderXml: string | null;
        /** The template section after {{META:*}} substitution (what section0.xml is built from). */
        templateSectionXml: string;
        /** The template's first paragraph is a cover to keep as is ({{CONTENT}} mode). */
        keepFirstParagraph: boolean;
    } {
        // The template's first paragraph (secPr + ctrl) is added by buildSection0.
        const blocks = this.ast.blocks ?? [];
        const bodyParts: string[] = [];
        this.paraIdCounter = 1; // start body paragraphs from id=1 (0 is the secPr paragraph)
        const layout = this.extractContentLayout();
        // A cover before the body counts as emitted content (e.g. H1 page breaks).
        this.hasEmittedBlock = !!layout && (layout.keepFirstParagraph || layout.before.length > 0);

        // Until the first body block, plain quotes take the {{QUOTE:…|lead}} variant (headings don't count).
        let beforeBody = true;
        blocks.forEach((block, index) => {
            const caption = this.tableCaptionAt(blocks, index);
            const lead = beforeBody && !caption && block.t === 'BlockQuote' && this.leadQuoteVariant;
            if (!lead && block.t !== 'Header') beforeBody = false;
            const xml = caption
                ? this.renderCaption('TABLE_CAPTION', caption, ++this.tableCaptionCounter)
                : lead ? this.withStyleVariant(lead, () => this.processBlock(block)) : this.processBlock(block);
            if (xml) {
                bodyParts.push(xml);
                this.hasEmittedBlock = true;
            }
        });
        this.report.add(
            'control_chars_removed', 'XML에 넣을 수 없는 제어문자를 지움', undefined, this.removedControlCharCount
        );

        // Inject extra char/para pr definitions into header XML
        let newHeaderXml: string | null = null;
        if (this.styles.hasChanges) {
            newHeaderXml = this.styles.injectIntoHeaderXml(this.headerXmlContent);
        }

        const body = bodyParts.join('\n');
        return {
            xmlBody: layout ? [layout.before, body, layout.after].filter(Boolean).join('\n') : body,
            newHeaderXml,
            templateSectionXml: this.sectionXmlContent,
            keepFirstParagraph: layout?.keepFirstParagraph ?? false,
        };
    }

    /**
     * {{CONTENT}} mode: the body goes where the {{CONTENT}} paragraph is, and
     * the template's own top-level paragraphs around it (cover, approval box,
     * notices) are kept. On each side, everything from the first to the last
     * paragraph holding a marker is the rule area (rules and their labels) and
     * is dropped, as are blank paragraphs right after it and at the very end.
     * Returns null without a top-level {{CONTENT}} paragraph (template body
     * dropped, as before).
     */
    private extractContentLayout(): { before: string; after: string; keepFirstParagraph: boolean } | null {
        if (!this.sectionXmlContent.includes('{{CONTENT}}')) return null;
        const paragraphs = splitTopLevelParagraphs(this.sectionXmlContent);
        const anchor = paragraphs.findIndex((para) => templatePlainText(para).includes('{{CONTENT}}'));
        if (anchor === -1) return null;

        const isRule = (para: string): boolean => /\{\{[^{}<>\r\n]{1,40}\}\}/.test(para);
        const isBlank = (para: string): boolean =>
            templatePlainText(para).replace(/\u00A0/g, ' ').trim() === '' && !OBJECT_ELEMENT_PATTERN.test(para);
        const keep = (list: string[]): string[] => {
            const firstRule = list.findIndex(isRule);
            let lastRule = -1;
            list.forEach((para, index) => { if (isRule(para)) lastRule = index; });
            let resume = lastRule + 1;
            while (resume < list.length && isBlank(list[resume])) resume++;
            const fixed = firstRule === -1 ? list : [...list.slice(0, firstRule), ...list.slice(resume)];
            return fixed.map((para) => this.reassignObjectIds(stripTemplateWrapperMarkers(para)));
        };

        const before = anchor === 0 ? [] : keep(paragraphs.slice(1, anchor));
        const after = keep(paragraphs.slice(anchor + 1));
        while (after.length > 0 && isBlank(after[after.length - 1])) after.pop();
        const first = paragraphs[0] ?? '';
        return {
            before: before.join('\n'),
            after: after.join('\n'),
            keepFirstParagraph: anchor !== 0 && !isRule(first) && !isBlank(first),
        };
    }

    // ============================================================
    // Block processing
    // ============================================================

    private processBlock(block: PandocBlock): string | null {
        if (!block || typeof block !== 'object') return null;
        switch (block.t) {
            case 'Header':
                return this.handleHeader(block.c);
            case 'Para':
                return this.handleTextBlock(block.c, 'BODY');
            case 'Plain':
                return this.handleTextBlock(block.c, 'BODY');
            case 'BulletList':
                return this.handleBulletList(block.c, this.listStartLevel);
            case 'OrderedList':
                return this.handleOrderedList(block.c, this.listStartLevel);
            case 'CodeBlock':
                return this.handleCodeBlock(block.c);
            case 'Table':
                return this.handleTable(block.c);
            case 'BlockQuote':
                return this.handleBlockquote(block.c, 0);
            case 'Div':
                if (block.c[0][1].includes('callout')) {
                    return this.handleCallout(block.c, 0);
                }
                if (block.c[0][1].includes('math')) {
                    // $$ … $$: the {{MATH}} paragraph shape, else BODY (plan 3.3, step 1: text only).
                    const name = this.placeholderStyles['MATH'] ? 'MATH' : 'BODY';
                    return block.c[1]
                        .map((child) => (child.t === 'Para' || child.t === 'Plain' ? this.handleTextBlock(child.c, name) : this.processBlock(child)))
                        .filter((xml) => xml).join('\n') || null;
                }
                if (block.c[0][1].includes('hwpx-style')) {
                    const variant = block.c[0][2].find(([key]) => key === 'style')?.[1] ?? null;
                    return this.withStyleVariant(variant, () =>
                        block.c[1].map((child) => this.processBlock(child)).filter((xml) => xml).join('\n') || null);
                }
                return block.c[1].map((child) => this.processBlock(child)).filter((xml) => xml).join('\n') || null;
            case 'HorizontalRule':
                return this.handleHorizontalRule();
            default:
                return null;
        }
    }

    // ============================================================
    // Header handler
    // ============================================================

    private matchPrefixRule(text: string): PrefixPlaceholderMatch | null {
        const leading = text.match(/^ */)?.[0] ?? '';
        const match = this.matchPrefixRuleCore(text.slice(leading.length), leading.length, true);
        return match
            ? { rule: match.rule, inlinePrefixLength: leading.length + match.tokenLength }
            : null;
    }

    private matchExactPrefixRule(
        text: string,
        sourceLeadingSpaces: number
    ): PrefixPlaceholderMatch | null {
        const match = this.matchPrefixRuleCore(text, sourceLeadingSpaces, false);
        return match
            ? { rule: match.rule, inlinePrefixLength: match.tokenLength }
            : null;
    }

    private matchPrefixRuleCore(
        rest: string,
        leadingSpaces: number,
        allowAny: boolean
    ): PrefixPlaceholderCoreMatch | null {
        for (const rule of this.prefixPlaceholderRules) {
            if (rule.spacingMode === 'exact' && rule.leadingSpaces !== leadingSpaces) {
                continue;
            }
            if (rule.spacingMode === 'any' && !allowAny) {
                continue;
            }
            const numberPeriod = rule.kind === 'number-period' ? rest.match(/^\d+\./)?.[0] : null;
            if (numberPeriod) {
                return { rule, tokenLength: numberPeriod.length };
            }
            const number = rule.kind === 'number' ? rest.match(/^\d+/)?.[0] : null;
            if (number) {
                return { rule, tokenLength: number.length };
            }
            if (rule.kind === 'literal' && rest.startsWith(rule.token)) {
                return { rule, tokenLength: rule.token.length };
            }
        }
        return null;
    }

    private handleHeader(content: [number, unknown, PandocInline[]]): string {
        const level = content[0];
        let inlines = content[2];

        // Page break before H1 by config; {{Hn|pageBreak}} / {{Hn|pageBreak=no}} decide per level.
        let pageBreak = 0;
        // The config is the fallback: a template H1 whose paragraph shape breaks the page decides it.
        const h1BreaksItself = level === 1 && /\bpageBreakBefore="1"/.test(
            this.styles.extractHeaderParaPrXml(this.placeholderStyles['H1']?.paraPrIDRef ?? '') ?? ''
        );
        if (level === 1 && this.hasEmittedBlock && this.config.PAGE_BREAK_BEFORE_H1 && !h1BreaksItself) {
            pageBreak = 1;
        }
        const pageBreakOption = optionFlag(this.markerOptions.get(`{{H${level}}}`)?.pageBreak);
        if (pageBreakOption !== undefined) {
            pageBreak = pageBreakOption && this.hasEmittedBlock ? 1 : 0;
        }
        // {{H3|list=2}}: lists under this heading start at LIST_*_2 (report items nest under it).
        const listOption = Number(this.markerOptions.get(`{{H${level}}}`)?.list);
        this.listStartLevel = Number.isInteger(listOption) && listOption >= 1 ? Math.min(listOption, 7) - 1 : 0;

        for (const childLevel of Object.keys(this.headerCounters).map((value) => parseInt(value, 10))) {
            if (childLevel > level) {
                delete this.headerCounters[childLevel];
            }
        }

        this.headerCounters[level] = (this.headerCounters[level] ?? 0) + 1;
        const counter = this.headerCounters[level];

        const comparableText = getPrefixComparableText(inlines);
        for (const rule of this.headingPrefixRules) {
            if (rule.level !== level) continue;
            const match = comparableText.match(rule.pattern);
            if (!match) continue;
            const prefixLength = match[0].length +
                (comparableText.slice(match[0].length).match(/^\s*/)?.[0].length ?? 0);
            const contentInlines = rule.strip
                ? removePrefixComparableCharacters(inlines, prefixLength) : inlines;
            const rendered = this.renderMarkerOwnerParagraph(
                contentInlines, rule.marker, rule.style, pageBreak, counter
            );
            if (rendered) return rendered;
            if (rule.style.mode === 'table') {
                return this.handleHeaderInTable(contentInlines, rule.marker, rule.style, pageBreak, counter);
            }
            return this.handleHeaderStyled(contentInlines, rule.style, pageBreak, counter);
        }

        const attr = content[1] as PandocAttr | undefined;
        const leadingSpacesRaw = attr?.[2]?.find(([key]) => key === 'prefixLeadSpaces')?.[1];
        const leadingSpaces = leadingSpacesRaw !== undefined
            ? Number.parseInt(leadingSpacesRaw, 10)
            : null;
        if (leadingSpaces !== null && Number.isFinite(leadingSpaces) && leadingSpaces >= 0) {
            const prefixMatch = this.matchExactPrefixRule(
                getPrefixComparableText(inlines),
                leadingSpaces
            );
            if (prefixMatch) {
                const prefixRule = prefixMatch.rule;
                const contentInlines = prefixRule.kind === 'literal'
                    ? removePrefixComparableCharacters(inlines, prefixMatch.inlinePrefixLength)
                    : inlines;
                const renderedFromMarkerOwner = this.renderMarkerOwnerParagraph(
                    contentInlines,
                    prefixRule.marker,
                    prefixRule.style,
                    pageBreak,
                    counter
                );
                if (renderedFromMarkerOwner) {
                    return renderedFromMarkerOwner;
                }
                if (prefixRule.style.mode === 'table') {
                    return this.handleHeaderInTable(
                        contentInlines,
                        prefixRule.marker,
                        prefixRule.style,
                        pageBreak,
                        counter
                    );
                }
                return this.handleHeaderStyled(contentInlines, prefixRule.style, pageBreak, counter);
            }
        }

        // Check placeholder styles first
        const phKey = `H${level}` in this.placeholderStyles
            ? this.variantKey(`H${level}`, this.placeholderStyles)
            : `H${level}`;
        const phMarker = `{{${phKey}}}`;
        if (phKey in this.placeholderStyles) {
            const props = this.placeholderStyles[phKey];
            // {{H3|num=%1.%2.%3.}}: %n is the running counter of level n.
            const numFormat = this.markerOptions.get(phMarker)?.num;
            if (typeof numFormat === 'string') {
                const numberText = numFormat.replace(/%([1-9])/g, (_m, n: string) => String(this.headerCounters[Number(n)] ?? 0));
                inlines = [{ t: 'Str', c: numberText }, { t: 'Space' }, ...inlines];
            }
            const renderedFromMarkerOwner = this.renderMarkerOwnerParagraph(
                inlines,
                phMarker,
                props,
                pageBreak,
                counter
            );
            if (renderedFromMarkerOwner) {
                return renderedFromMarkerOwner;
            }
            if (props.mode === 'table') {
                return this.handleHeaderInTable(inlines, phMarker, props, pageBreak, counter);
            }
            return this.handleHeaderStyled(inlines, props, pageBreak, counter);
        }

        this.noteStyleFallback(`H${level}`);
        // Fall back to dynamic style map (outline levels from header.xml)
        if (level in this.styles.dynamicStyleMap) {
            const s = this.styles.dynamicStyleMap[level];
            return this.buildParagraph(
                inlines,
                s.style_id,
                s.para_pr_id,
                s.char_pr_id,
                pageBreak
            );
        }

        // Last resort: normal style
        return this.buildParagraph(
            inlines,
            this.styles.normalStyleId,
            this.styles.normalParaPrId,
            '0',
            pageBreak
        );
    }

    private handleHeaderStyled(
        inlines: PandocInline[],
        props: PlaceholderStyle,
        pageBreak = 0,
        counter = 1
    ): string {
        const parts: string[] = [];
        if (props.leadingEmptyParagraph && this.hasEmittedBlock) {
            if (props.leadingEmptyParagraph.rawParagraphXml) {
                parts.push(this.cloneTemplateParagraph(props.leadingEmptyParagraph.rawParagraphXml));
            } else {
                parts.push(this.buildEmptyParagraph(
                    props.leadingEmptyParagraph.styleIDRef,
                    props.leadingEmptyParagraph.paraPrIDRef,
                    props.leadingEmptyParagraph.charPrIDRef
                ));
            }
        }

        parts.push(this.buildParagraph(
            inlines,
            props.styleIDRef,
            props.paraPrIDRef,
            props.charPrIDRef,
            pageBreak,
            props.prefix ? this.formatCounterText(props.prefix, counter) : undefined,
            props.prefixCharPrIDRef ?? undefined,
            props.suffix ?? undefined,
            props.suffixCharPrIDRef ?? undefined
        ));

        return parts.join('\n');
    }

    private renderMarkerOwnerParagraph(
        inlines: PandocInline[],
        placeholderMarker: string,
        props: PlaceholderStyle,
        pageBreak = 0,
        counter = 1,
        includeSurroundings = true
    ): string | null {
        const ownerParagraphXml = props.markerOwnerParagraph;
        if (!ownerParagraphXml) {
            return null;
        }

        const placeholderPos = ownerParagraphXml.indexOf(placeholderMarker);
        if (placeholderPos === -1) {
            return null;
        }

        const placeholderParagraph = this.findEnclosingParagraph(ownerParagraphXml, placeholderPos);
        if (!placeholderParagraph) {
            return null;
        }

        const renderedPlaceholderParagraph = this.renderPlaceholderParagraphFromTemplate(
            placeholderParagraph.paraXml,
            inlines,
            placeholderMarker,
            props,
            counter
        );
        // List items must stay tight: drop the blank spacer paragraphs the
        // template author drew around the marker. Block markers (headers/body)
        // keep them to reproduce the intended whitespace.
        let rendered = includeSurroundings
            ? ownerParagraphXml.slice(0, placeholderParagraph.paraStart)
                + renderedPlaceholderParagraph
                + ownerParagraphXml.slice(placeholderParagraph.paraEnd)
            : renderedPlaceholderParagraph;
        rendered = stripTemplateWrapperMarkers(rendered);
        if (pageBreak) {
            rendered = this.applyPageBreakToOuterParagraph(rendered);
        }
        // The owner paragraph is the template's captured marker block (e.g. the
        // {{H1}} title box), cloned verbatim for every match. Its <hp:tbl id="...">
        // must be reassigned too, or every heading reusing this marker ends up with
        // the same table id, which corrupts the floating-object anchor list and
        // makes Hangul hang on open.
        return this.reassignObjectIds(rendered);
    }

    /**
     * For a block-level placeholder authored inside a 1x1 rule table, return the
     * cloned template paragraphs that sit before/after the placeholder paragraph
     * (typically blank spacer lines). Lets QUOTE/HR reproduce the surrounding
     * whitespace the template author drew, exactly like headers/BODY do.
     */
    private extractMarkerSurroundings(
        props: PlaceholderStyle,
        placeholderMarker: string
    ): { leading: string; trailing: string } {
        const ownerXml = props.markerOwnerParagraph;
        if (!ownerXml) return { leading: '', trailing: '' };

        const pos = ownerXml.indexOf(placeholderMarker);
        if (pos === -1) return { leading: '', trailing: '' };

        const para = this.findEnclosingParagraph(ownerXml, pos);
        if (!para) return { leading: '', trailing: '' };

        const leadingRaw = ownerXml.slice(0, para.paraStart).trim();
        const trailingRaw = ownerXml.slice(para.paraEnd).trim();
        return {
            leading: leadingRaw ? this.cloneTemplateParagraph(leadingRaw) : '',
            trailing: trailingRaw ? this.cloneTemplateParagraph(trailingRaw) : '',
        };
    }

    private handleHeaderInTable(
        inlines: PandocInline[],
        placeholderMarker: string,
        props: PlaceholderStyle,
        pageBreak = 0,
        counter = 1
    ): string {
        const rawTableXml = typeof props.table === 'string' ? props.table : null;
        if (!rawTableXml) {
            return this.handleHeaderStyled(inlines, props, pageBreak, counter);
        }

        let tableXml = this.removeTemplateElements(rawTableXml);
        tableXml = stripTemplateWrapperMarkers(tableXml);
        if (props.numberingText) {
            tableXml = this.replaceTemplateNumberingText(tableXml, props.numberingText, counter);
        }

        const headerText = encodeTemplateText(getPlainText(inlines), []);
        tableXml = tableXml.split(placeholderMarker).join(headerText);
        // Each H1 (etc.) reuses the same captured template table verbatim, so its
        // <hp:tbl id="..."> collides across multiple headings unless reassigned here too
        // (mirrors the reassignObjectIds() path used for {{CELL_*}} table templates).
        tableXml = this.reassignObjectIds(tableXml);

        const owner = props.tableOwner;
        const wrapper = this.createParaStart(this.styles.normalStyleId, owner?.paraPrIDRef ?? this.styles.normalParaPrId, pageBreak);
        return owner?.runTag
            ? `${wrapper}${owner.runTag}${tableXml}</hp:run></hp:p>`
            : wrapper + tableXml + '</hp:p>';
    }

    // ============================================================
    // Text block (Para / Plain)
    // ============================================================

    private handleTextBlock(content: PandocInline[], basePlaceholderName = 'BODY', asFigure = true): string {
        // An image-only paragraph: {{FIGURE}} shape and a numbered {{CAPTION}} (plan 3.3).
        if (asFigure && basePlaceholderName === 'BODY' && (this.placeholderStyles['FIGURE'] || this.placeholderStyles['CAPTION'])) {
            const images = content.filter((inline): inline is InlineImage => inline.t === 'Image');
            const imageOnly = images.length > 0
                && content.every((inline) => ['Image', 'Space', 'SoftBreak', 'LineBreak'].includes(inline.t));
            if (imageOnly) {
                const figure = this.handleTextBlock(content, this.placeholderStyles['FIGURE'] ? 'FIGURE' : 'BODY', false);
                const captionText = figureCaption(images[0]);
                if (!this.placeholderStyles['CAPTION'] || !captionText) return figure;
                const caption = this.renderCaption('CAPTION', [{ t: 'Str', c: captionText }], ++this.figureCounter);
                return [figure, caption].join('\n');
            }
        }
        const placeholderName = this.placeholderStyles[basePlaceholderName]
            ? this.variantKey(basePlaceholderName, this.placeholderStyles)
            : basePlaceholderName;
        const prefixMatch = placeholderName === 'BODY'
            ? this.matchPrefixRule(getPrefixComparableText(content))
            : null;
        const prefixRule = prefixMatch?.rule ?? null;
        const renderedContent = prefixMatch?.rule.kind === 'literal'
            ? removePrefixComparableCharacters(content, prefixMatch.inlinePrefixLength)
            : content;
        const props = prefixRule?.style ?? this.placeholderStyles[placeholderName];
        if (props) {
            const placeholderMarker = prefixRule?.marker ?? `{{${placeholderName}}}`;
            const renderedFromMarkerOwner = this.renderMarkerOwnerParagraph(
                renderedContent,
                placeholderMarker,
                props
            );
            if (renderedFromMarkerOwner) {
                return renderedFromMarkerOwner;
            }
            return this.buildParagraph(
                renderedContent,
                props.styleIDRef,
                props.paraPrIDRef,
                props.charPrIDRef,
                0,
                props.prefix ?? undefined,
                props.prefixCharPrIDRef ?? undefined,
                props.suffix ?? undefined,
                props.suffixCharPrIDRef ?? undefined
            );
        }
        this.noteStyleFallback(placeholderName);
        return this.buildParagraph(content, this.styles.normalStyleId, this.styles.normalParaPrId, '0');
    }

    // ============================================================
    // Code block
    // ============================================================

    private handleCodeBlock(content: [unknown, string]): string {
        const code = content[1] ?? '';
        const lines = code.split('\n');
        const parts: string[] = [];
        if (!this.placeholderStyles['CODE']) this.noteStyleFallback('CODE');
        const codeKey = this.placeholderStyles['CODE'] ? this.variantKey('CODE', this.placeholderStyles) : 'CODE';
        const props = this.placeholderStyles[codeKey] ?? this.placeholderStyles['BODY'];
        // Like the other block markers, {{CODE}} reproduces the blank lines drawn
        // around it in its rule table; {{CODE_LANG}} labels the language.
        const surroundings = this.placeholderStyles[codeKey]
            ? this.extractMarkerSurroundings(this.placeholderStyles[codeKey], `{{${codeKey}}}`)
            : { leading: '', trailing: '' };
        const language = ((content[0] as PandocAttr | undefined)?.[1]?.[0] ?? '').trim();
        const styleId = props?.styleIDRef ?? this.styles.normalStyleId;
        const paraPrId = props?.paraPrIDRef ?? this.styles.normalParaPrId;
        const charPrId = props?.charPrIDRef ?? '0';
        for (const line of lines) {
            const para = this.createParaStart(styleId, paraPrId);
            const run = this.textRun(line, charPrId, new Set()) || `<hp:run charPrIDRef="${charPrId}"><hp:t></hp:t></hp:run>`;
            parts.push(para + run + '</hp:p>');
        }
        const label = language && this.placeholderStyles['CODE_LANG']
            ? this.handleTextBlock([{ t: 'Str', c: language }], 'CODE_LANG')
            : '';
        return [surroundings.leading, label, ...parts, surroundings.trailing].filter((part) => part).join('\n');
    }

    // ============================================================
    // Blockquote
    // ============================================================

    // Leading-emoji -> callout variant. Specific categories are checked before
    // the broad INFO bucket. Only the semantic mapping lives here; the colours
    // and box shapes come entirely from the matched template placeholder.
    private static readonly QUOTE_EMOJI_TYPES: { key: string; emojis: string[] }[] = [
        { key: 'QUOTE_WARN', emojis: ['⚠️', '⚠', '❗', '❕', '🚨'] },
        { key: 'QUOTE_SUCCESS', emojis: ['✅', '✔️', '✔', '☑️'] },
        { key: 'QUOTE_DANGER', emojis: ['❌', '🚫', '⛔', '🛑'] },
        { key: 'QUOTE_INFO', emojis: ['💡', 'ℹ️', '📌', '✍️', '🔎', '🔍', '📝', '📍', '💬'] },
    ];

    private selectQuoteStyleKey(content: PandocBlock[]): string {
        const firstText = content.find((b) => b.t === 'Para' || b.t === 'Plain');
        if (firstText) {
            const text = getPlainText((firstText as { c: PandocInline[] }).c).replace(/^[\s\u00A0]+/, '');
            for (const { key, emojis } of [...this.quoteEmoji, ...MarkdownToHwpx.QUOTE_EMOJI_TYPES]) {
                if (emojis.some((e) => text.startsWith(e)) && this.placeholderStyles[key]) {
                    return key;
                }
            }
        }
        return 'QUOTE';
    }

    /**
     * `base:variant` when a variant is active and the template defines it; otherwise
     * `base` (and the missing variant is reported).
     */
    private variantKey(base: string, styles: Record<string, unknown>, variant = this.styleVariant): string {
        if (!variant) return base;
        const key = `${base}:${variant}`;
        if (key in styles) return key;
        this.report.add('style_variant_missing', '템플릿에 없는 변형 스타일이라 기본 스타일을 씀', `{{${base}:${variant}}}`);
        return base;
    }

    private withStyleVariant<T>(variant: string | null, render: () => T): T {
        const previous = this.styleVariant;
        this.styleVariant = variant;
        try {
            return render();
        } finally {
            this.styleVariant = previous;
        }
    }

    /** A numbered caption paragraph ({{CAPTION}}, {{TABLE_CAPTION}}): the template text around the marker carries {{#}}. */
    private renderCaption(name: string, inlines: PandocInline[], counter: number): string {
        const props = this.placeholderStyles[name];
        return this.renderMarkerOwnerParagraph(inlines, `{{${name}}}`, props, 0, counter)
            ?? this.handleHeaderStyled(inlines, props, 0, counter);
    }

    /** "표: …" / "Table: …" / ": …" right before or after a table, when the template has {{TABLE_CAPTION}}. */
    private tableCaptionAt(blocks: PandocBlock[], index: number): PandocInline[] | null {
        const block = blocks[index];
        if (!this.placeholderStyles['TABLE_CAPTION'] || (block.t !== 'Para' && block.t !== 'Plain')) return null;
        if (blocks[index + 1]?.t !== 'Table' && blocks[index - 1]?.t !== 'Table') return null;
        const text = getPrefixComparableText(block.c);
        const label = /^(?:Table|표)\s*[:：]\s*|^:\s+/.exec(text);
        if (!label) return null;
        return removePrefixComparableCharacters(block.c, label[0].length);
    }

    /** Record a block drawn without a template rule for its marker (e.g. H4, QUOTE, LIST_BULLET_2). */
    private noteStyleFallback(marker: string): void {
        this.report.add('style_fallback', '템플릿에 규칙이 없어 기본 모양으로 그린 요소', `{{${marker}}}`);
    }

    // Obsidian callout types → the emoji quote styles that already exist, used
    // when the template has no {{CALLOUT_<TYPE>}} for that type.
    private static readonly CALLOUT_QUOTE_TYPES: Record<string, string> = {
        note: 'QUOTE_INFO', abstract: 'QUOTE_INFO', summary: 'QUOTE_INFO', tldr: 'QUOTE_INFO',
        info: 'QUOTE_INFO', todo: 'QUOTE_INFO', tip: 'QUOTE_INFO', hint: 'QUOTE_INFO',
        important: 'QUOTE_INFO', example: 'QUOTE_INFO',
        success: 'QUOTE_SUCCESS', check: 'QUOTE_SUCCESS', done: 'QUOTE_SUCCESS',
        question: 'QUOTE_WARN', help: 'QUOTE_WARN', faq: 'QUOTE_WARN',
        warning: 'QUOTE_WARN', caution: 'QUOTE_WARN', attention: 'QUOTE_WARN',
        failure: 'QUOTE_DANGER', fail: 'QUOTE_DANGER', missing: 'QUOTE_DANGER',
        danger: 'QUOTE_DANGER', error: 'QUOTE_DANGER', bug: 'QUOTE_DANGER',
    };

    /**
     * Render an Obsidian callout (Div.callout from the adapter). Style lookup:
     * {{CALLOUT_<TYPE>}} → mapped {{QUOTE_*}} → {{QUOTE}}. The title uses
     * {{CALLOUT_TITLE_<X>}} for the chosen style (X = TYPE, or INFO/WARN/… of
     * QUOTE_X), then {{CALLOUT_TITLE}}, otherwise a bold first line in the
     * callout's own style.
     */
    private handleCallout([attr, blocks]: [PandocAttr, PandocBlock[]], level: number): string {
        const type = attr[2].find(([key]) => key === 'type')?.[1] ?? 'note';
        // Custom types may be any word, e.g. `> [!회의]` → {{CALLOUT_회의}}.
        const calloutKey = `CALLOUT_${type.toUpperCase().replace(/[^\p{L}\p{N}]/gu, '_')}`;
        const quoteKey = [calloutKey, this.calloutAliases.get(type) ?? MarkdownToHwpx.CALLOUT_QUOTE_TYPES[type]]
            .find((key) => key && !/^CALLOUT_TITLE(?:_|$)/.test(key) && this.placeholderStyles[key]) ?? 'QUOTE';
        const titleKey = [`CALLOUT_TITLE_${quoteKey.replace(/^(?:CALLOUT|QUOTE)_/, '')}`, 'CALLOUT_TITLE']
            .find((key) => this.placeholderStyles[key]);

        const titleBlock = blocks[0]?.t === 'Div' && blocks[0].c[0][1].includes('callout-title') ? blocks[0] : null;
        const titlePlain = titleBlock?.c[1][0];
        const titleInlines = titlePlain && (titlePlain.t === 'Plain' || titlePlain.t === 'Para') ? titlePlain.c : [];
        const body = titleBlock ? blocks.slice(1) : blocks;
        if (!this.placeholderStyles[calloutKey] && this.placeholderStyles[`BODY:${type}`]) {
            // A callout named after a body variant renders as that variant's paragraphs (plan 3.6).
            const paragraphs: PandocBlock[] = [
                ...(titleInlines.length ? [{ t: 'Para', c: [{ t: 'Strong', c: titleInlines }] } as PandocBlock] : []),
                ...body,
            ];
            return this.withStyleVariant(type, () =>
                paragraphs.map((child) => this.processBlock(child)).filter((xml) => xml).join('\n'));
        }
        if (titleInlines.length === 0) {
            return this.handleBlockquote(body, level, quoteKey);
        }
        if (titleKey) {
            return this.handleBlockquote(body, level, quoteKey, this.handleTextBlock(titleInlines, titleKey));
        }
        return this.handleBlockquote(
            [{ t: 'Para', c: [{ t: 'Strong', c: titleInlines }] }, ...body],
            level,
            quoteKey
        );
    }

    private handleBlockquote(content: PandocBlock[], level = 0, quoteKeyOverride?: string, leadXml?: string): string {
        if (level > this.config.MAX_NESTING_DEPTH) return '';
        const results: string[] = leadXml ? [leadXml] : [];
        // Prefer a dedicated {{QUOTE}} (or emoji-specific {{QUOTE_*}}) template
        // style so themes can express callout boxes (shading / left accent
        // border / text colour) purely in the template. Fall back to BODY style
        // + hardcoded indent otherwise.
        const selectedKey = quoteKeyOverride ?? this.selectQuoteStyleKey(content);
        const quoteKey = this.placeholderStyles[selectedKey] && level === 0
            ? this.variantKey(selectedKey, this.placeholderStyles)
            : selectedKey;
        const quoteStyle = this.placeholderStyles[quoteKey];
        if (!quoteStyle && level === 0) this.noteStyleFallback(quoteKey);
        const baseStyle = quoteStyle ?? this.placeholderStyles['BODY'];
        const styleId = baseStyle?.styleIDRef ?? this.styles.normalStyleId;
        const baseParaPrId = baseStyle?.paraPrIDRef ?? this.styles.normalParaPrId;
        const charPrId = baseStyle?.charPrIDRef ?? '0';
        for (const block of content) {
            if (block.t === 'BlockQuote') {
                results.push(this.handleBlockquote(block.c, level + 1));
            } else if (block.t === 'Div' && block.c[0][1].includes('callout')) {
                results.push(this.handleCallout(block.c, level + 1));
            } else if (block.t === 'Para' || block.t === 'Plain') {
                let paraPrId = baseParaPrId;
                let indent = 0;
                if (quoteStyle) {
                    // Keep the template's box paraPr for the first level; deeper
                    // levels get an additional left indent derived from it.
                    paraPrId = level === 0
                        ? baseParaPrId
                        : this.styles.getOrCreateIndentParaPr(
                            level * this.config.BLOCKQUOTE_INDENT_PER_LEVEL,
                            baseParaPrId
                        );
                    indent = level * this.config.BLOCKQUOTE_INDENT_PER_LEVEL;
                } else {
                    indent = this.config.BLOCKQUOTE_LEFT_INDENT +
                        level * this.config.BLOCKQUOTE_INDENT_PER_LEVEL;
                    paraPrId = this.styles.getOrCreateIndentParaPr(indent, baseParaPrId);
                }
                // The rule's lead mark ("※<tab>") is not repeated when the text already starts with it.
                const mark = quoteStyle?.prefix?.trim();
                const prefix = mark && !getPlainText(block.c).trimStart().startsWith(mark) ? quoteStyle?.prefix ?? undefined : undefined;
                this.availableWidthStack.push(Math.max(1, this.availableWidth - indent));
                try {
                    results.push(this.buildParagraph(block.c, styleId, paraPrId, charPrId, 0,
                        prefix, prefix ? quoteStyle?.prefixCharPrIDRef ?? undefined : undefined));
                } finally {
                    this.availableWidthStack.pop();
                }
            } else {
                const xml = this.processBlock(block);
                if (xml) results.push(xml);
            }
        }
        const body = results.join('\n');
        // Reproduce the blank spacer lines drawn around the {{QUOTE}} marker in
        // the template (only at the outermost quote level).
        if (quoteStyle && level === 0) {
            const { leading, trailing } = this.extractMarkerSurroundings(
                quoteStyle,
                `{{${quoteKey}}}`
            );
            return [leading, body, trailing].filter((part) => part).join('\n');
        }
        return body;
    }

    // ============================================================
    // Horizontal rule
    // ============================================================

    private handleHorizontalRule(): string {
        // Prefer a dedicated {{HR}} template style: a single paragraph whose
        // paraPr carries a bottom border renders as a divider line. The line's
        // color/thickness lives entirely in the template. Fall back to two
        // empty BODY paragraphs (spacer) when no {{HR}} style is defined.
        const hrStyle = this.placeholderStyles['HR'];
        if (hrStyle) {
            const line = this.buildEmptyParagraph(
                hrStyle.styleIDRef,
                hrStyle.paraPrIDRef,
                hrStyle.charPrIDRef
            );
            const { leading, trailing } = this.extractMarkerSurroundings(hrStyle, '{{HR}}');
            return [leading, line, trailing].filter((part) => part).join('\n');
        }

        this.noteStyleFallback('HR');
        const props = this.placeholderStyles['BODY'];
        const styleId = props?.styleIDRef ?? this.styles.normalStyleId;
        const paraPrId = props?.paraPrIDRef ?? this.styles.normalParaPrId;
        const charPrId = props?.charPrIDRef ?? '0';

        return [
            this.buildEmptyParagraph(styleId, paraPrId, charPrId),
            this.buildEmptyParagraph(styleId, paraPrId, charPrId),
        ].join('\n');
    }

    // ============================================================
    // Bullet list
    // ============================================================

    /**
     * Render the leading paragraph of a single list item (the bullet/number
     * line). Shared by bullet and ordered lists so both honour the same
     * template marker / numbering / prefix logic.
     */
    private renderListItemParagraph(
        inlines: PandocInline[],
        listStyle: ListStyle | undefined,
        placeholderName: string,
        level: number,
        counter: number,
        fallbackPrefix: string
    ): string {
        if (listStyle) {
            if (listStyle.markerOwnerParagraph) {
                const rendered = this.renderMarkerOwnerParagraph(
                    inlines,
                    `{{${placeholderName}}}`,
                    { ...listStyle, styleIDRef: listStyle.styleIDRef ?? this.styles.normalStyleId, mode: 'prefix' },
                    0,
                    counter,
                    false
                );
                if (rendered) {
                    // A restarted numbering list swaps in its own paraPr.
                    const templateParaPr = rendered.match(/^<hp:p\b[^>]*\bparaPrIDRef="(\d+)"/)?.[1];
                    return listStyle.mode === 'numbering' && templateParaPr && templateParaPr !== listStyle.paraPrIDRef
                        ? rendered.replace(/^(<hp:p\b[^>]*\bparaPrIDRef=")\d+(")/, `$1${listStyle.paraPrIDRef}$2`)
                        : rendered;
                }
            }
            if (listStyle.mode === 'numbering') {
                return this.buildParagraph(
                    inlines,
                    listStyle.styleIDRef ?? this.styles.normalStyleId,
                    listStyle.paraPrIDRef,
                    listStyle.charPrIDRef
                );
            }
            const prefix = listStyle.prefix
                ? this.formatCounterText(listStyle.prefix, counter)
                : undefined;
            return this.buildParagraph(
                inlines,
                listStyle.styleIDRef ?? this.styles.normalStyleId,
                listStyle.paraPrIDRef,
                listStyle.charPrIDRef,
                0,
                prefix,
                listStyle.prefixCharPrIDRef ?? listStyle.charPrIDRef,
                listStyle.suffix ?? undefined,
                listStyle.suffixCharPrIDRef ?? undefined
            );
        }

        this.noteStyleFallback(placeholderName);
        const indent = this.config.LIST_INDENT_PER_LEVEL * (level + 1);
        const bodyStyle = this.placeholderStyles['BODY'];
        const baseParaPrId = bodyStyle?.paraPrIDRef ?? this.styles.normalParaPrId;
        const paraPrId = this.styles.getOrCreateIndentParaPr(indent, baseParaPrId);
        const prefixInlines: PandocInline[] = [{ t: 'Str', c: fallbackPrefix + '\u00A0' }];
        return this.buildParagraph(
            [...prefixInlines, ...inlines],
            bodyStyle?.styleIDRef ?? this.styles.normalStyleId,
            paraPrId,
            bodyStyle?.charPrIDRef ?? '0'
        );
    }

    private handleBulletList(items: PandocBlock[][], level = 0): string {
        if (level > this.config.MAX_NESTING_DEPTH) return '';
        const results: string[] = [];
        const listStyle = this.listStyles[`BULLET_${level + 1}`];
        const bullet = this.config.LIST_BULLET_CHARS[level % this.config.LIST_BULLET_CHARS.length];

        for (const itemBlocks of items) {
            let marked = false;
            this.availableWidthStack.push(Math.max(
                1,
                this.availableWidth - this.config.LIST_INDENT_PER_LEVEL * (level + 1)
            ));
            try {
                for (const block of itemBlocks) {
                    if (block.t === 'BulletList') {
                        results.push(this.handleBulletList(block.c, level + 1));
                    } else if (block.t === 'OrderedList') {
                        results.push(this.handleOrderedList(block.c, level + 1));
                    } else if (!marked && (block.t === 'Para' || block.t === 'Plain')) {
                        // The item's first text block carries the bullet marker.
                        results.push(this.renderListItemParagraph(
                            block.c, listStyle, `LIST_BULLET_${level + 1}`, level, 1, bullet
                        ));
                        marked = true;
                    } else {
                        // Continuation paragraphs, blockquotes (callouts), code blocks,
                        // tables, etc. inside the item render as their own blocks.
                        const xml = this.processBlock(block);
                        if (xml) results.push(xml);
                    }
                }
            } finally {
                this.availableWidthStack.pop();
            }
        }
        return results.join('\n');
    }

    // ============================================================
    // Ordered list
    // ============================================================

    private handleOrderedList(
        content: [[number, unknown, unknown], PandocBlock[][]],
        level = 0
    ): string {
        if (level > this.config.MAX_NESTING_DEPTH) return '';
        const items = content[1];
        const startNum = content[0][0] ?? 1;
        const results: string[] = [];
        const templateListStyle = this.listStyles[`ORDERED_${level + 1}`];
        // Hangul continues an auto-numbered paragraph shape across the whole
        // document, so every ordered list gets its own numbering instance.
        const listStyle = templateListStyle?.mode === 'numbering'
            ? { ...templateListStyle, paraPrIDRef: this.styles.getRestartedNumberingParaPr(templateListStyle.paraPrIDRef, startNum) }
            : templateListStyle;

        let counter = startNum;
        for (const itemBlocks of items) {
            let marked = false;
            this.availableWidthStack.push(Math.max(
                1,
                this.availableWidth - this.config.LIST_INDENT_PER_LEVEL * (level + 1)
            ));
            try {
                for (const block of itemBlocks) {
                    if (block.t === 'BulletList') {
                        results.push(this.handleBulletList(block.c, level + 1));
                    } else if (block.t === 'OrderedList') {
                        results.push(this.handleOrderedList(block.c, level + 1));
                    } else if (!marked && (block.t === 'Para' || block.t === 'Plain')) {
                        // The item's first text block carries the number; one number
                        // per item regardless of how many child blocks it holds.
                        results.push(this.renderListItemParagraph(
                            block.c, listStyle, `LIST_ORDERED_${level + 1}`, level, counter, `${counter}.`
                        ));
                        marked = true;
                    } else {
                        // Continuation paragraphs, blockquotes (callouts), code blocks,
                        // tables, etc. inside the item render as their own blocks.
                        const xml = this.processBlock(block);
                        if (xml) results.push(xml);
                    }
                }
            } finally {
                this.availableWidthStack.pop();
            }
            counter++;
        }
        return results.join('\n');
    }

    // ============================================================
    // Table
    // ============================================================

    private handleTable(content: unknown[]): string {
        const tableXml = this.buildMarkdownTableXml(content);
        if (!tableXml) {
            return '';
        }

        const renderedFromTemplate = this.renderTableRuleTemplate(tableXml);
        if (renderedFromTemplate) {
            return renderedFromTemplate;
        }

        // Hangul drops a table that is a direct child of <hp:p> (2026-10-23); it sits in a run as in Hangul's own files.
        const paraId = this.paraIdCounter++;
        return `<hp:p id="${paraId}" paraPrIDRef="${this.styles.normalParaPrId}" styleIDRef="${this.styles.normalStyleId}" pageBreak="0" columnBreak="0" merged="0">` +
            `<hp:run charPrIDRef="0">${tableXml}</hp:run>` +
            `</hp:p>`;
    }

    private buildMarkdownTableXml(content: unknown[]): string {
        // content: [attr, caption, specs, head, bodies, foot]
        const specs = content[2] as [string, unknown][];
        const head = content[3] as [unknown, unknown[][]];
        const bodies = content[4] as [unknown, number, unknown[], unknown[][]][];

        const colCount = specs.length;
        if (colCount === 0) {
            console.warn('[md2hwpx] Skipping table because it has no columns in the parsed Markdown AST.');
            this.report.add('table_skipped', '열이나 행이 없는 표를 건너뜀');
            return '';
        }

        // Inside a list item, quote or table cell the template width would
        // overflow; shrink to the space left there (columns keep their ratios).
        const templateWidth = this.tableWidthOption() ?? this.templateTableWidth ?? this.config.TABLE_WIDTH;
        const totalWidth = this.availableWidthStack.length > 0
            ? Math.max(1, Math.min(templateWidth, this.availableWidth))
            : templateWidth;
        const tableBorderFillId = this.templateTableBorderFillId ?? this.styles.tableBorderFillId;

        // Calculate column widths
        let colWidths: number[] = specs.map(([, w]) => {
            const wObj = w as { t: string; c?: number };
            if (wObj.t === 'ColWidth' && typeof wObj.c === 'number') {
                return Math.round(wObj.c * totalWidth);
            }
            return Math.round(totalWidth / colCount);
        });

        // Collect all rows
        const headRows = (head[1] ?? []);
        const bodyRows: unknown[][] = [];
        for (const body of bodies) {
            for (const row of body[3]) bodyRows.push(row);
        }
        const totalBodyRows = bodyRows.length;
        const headerRowCount = headRows.length;

        const allRows: { row: unknown[]; isHeader: boolean }[] = [
            ...headRows.map((r) => ({ row: r, isHeader: true })),
            ...bodyRows.map((r) => ({ row: r, isHeader: false })),
        ];

        // Equal separator dashes say nothing about widths: size columns by content
        // (plan 3.5) unless {{TABLE|columns=equal}}.
        if (this.markerOptions.get('{{TABLE}}')?.columns !== 'equal' && specs.every(([, w], _i, all) => {
            const width = w as { t: string; c?: number };
            const firstWidth = all[0][1] as { t: string; c?: number };
            return width.t !== 'ColWidth' || (firstWidth.t === 'ColWidth' && Math.abs((width.c ?? 0) - (firstWidth.c ?? 0)) < 1e-9);
        })) {
            colWidths = contentColumnWidths(allRows.map(({ row }) => (row as [unknown, unknown[][]])[1]), colCount, totalWidth);
        }

        const rowCount = allRows.length;
        if (rowCount === 0) {
            console.warn('[md2hwpx] Skipping table because it has no rows in the parsed Markdown AST.');
            this.report.add('table_skipped', '열이나 행이 없는 표를 건너뜀');
            return '';
        }

        // Build rows with hp:tr wrappers
        const rowXmlParts: string[] = [];
        let cellPartsForRow: string[] = [];
        const rowSpanOccupancy = Array.from({ length: colCount }, () => 0);

        for (let rowIdx = 0; rowIdx < allRows.length; rowIdx++) {
            const { row, isHeader } = allRows[rowIdx];
            const cells = (row as [unknown, unknown[][]])[1];

            cellPartsForRow = [];
            // Track which logical columns are filled in this row, either by an
            // incoming rowSpan from a previous row or by a cell emitted below.
            // HWP crashes loading a table whose rows do not cover every column,
            // so any gaps are padded with empty filler cells afterwards.
            const covered = Array.from(
                { length: colCount },
                (_, c) => rowSpanOccupancy[c] > 0
            );
            let logicalCol = 0;
            for (let colIdx = 0; colIdx < cells.length; colIdx++) {
                const cell = cells[colIdx] as [unknown, unknown, number, number, PandocBlock[]];
                const cellBlocks = cell[4] ?? [];
                while (logicalCol < colCount && rowSpanOccupancy[logicalCol] > 0) {
                    logicalCol += 1;
                }
                if (logicalCol >= colCount) {
                    console.warn('[md2hwpx] Skipping table cell that exceeds the logical column count.');
                    continue;
                }
                const rowSpan = Math.max(1, cell[2] ?? 1);
                const colSpan = Math.max(1, Math.min(cell[3] ?? 1, colCount - logicalCol));
                const colW = colWidths
                    .slice(logicalCol, logicalCol + colSpan)
                    .reduce((sum, width) => sum + width, 0)
                    || Math.round(totalWidth / colCount) * colSpan;

                const cellStyle = this.resolveCellStyle({
                    isHeader, rowIdx, headerRowCount, totalBodyRows, logicalCol, colSpan, colCount,
                    text: cellBlocks.map((blk) => (blk.t === 'Plain' || blk.t === 'Para' ? getPlainText(blk.c) : '')).join(' '),
                });
                const charPrId = cellStyle?.charPrIDRef ?? '0';
                // `:---:`/`---:` (or HTML align) override only the horizontal
                // alignment of the template cell's paragraph shape.
                const paraPrId = this.styles.getOrCreateAlignedParaPr(
                    cellStyle?.paraPrIDRef ?? this.styles.normalParaPrId,
                    cell[1] as AlignValue
                );
                const styleId = cellStyle?.styleIDRef ?? this.styles.normalStyleId;
                const borderFillId = cellStyle?.borderFillIDRef ?? this.styles.tableBorderFillId;
                const cm = cellStyle?.cellMargin ?? this.config.CELL_MARGIN_DEFAULT;

                // Cell content paragraphs
                let cellContentXml = '';
                // Images and nested tables inside the cell fit its inner width.
                this.availableWidthStack.push(Math.max(1, colW - cm.left - cm.right));
                try {
                    for (const blk of cellBlocks) {
                        const typedBlk = blk;
                        if (typedBlk.t === 'Plain' || typedBlk.t === 'Para') {
                            const para = this.createParaStart(styleId, paraPrId);
                            const inlineXml = this.processInlines(typedBlk.c, charPrId);
                            const runXml = inlineXml || this.buildEmptyRun(charPrId);
                            cellContentXml += para + runXml + '</hp:p>';
                        } else {
                            const xml = this.processBlock(typedBlk);
                            if (xml) cellContentXml += xml;
                        }
                    }
                } finally {
                    this.availableWidthStack.pop();
                }
                if (!cellContentXml) {
                    const cellParagraph = this.createParaStart(styleId, paraPrId) +
                        this.buildEmptyRun(charPrId) +
                        '</hp:p>';
                    cellContentXml = cellParagraph;
                }

                cellPartsForRow.push(this.buildTableCellXml({
                    cellStyle,
                    borderFillId,
                    cellContentXml,
                    colIdx: logicalCol,
                    rowIdx,
                    colSpan,
                    rowSpan,
                    colW,
                    cm,
                }));
                for (let c = logicalCol; c < logicalCol + colSpan; c++) {
                    covered[c] = true;
                }
                if (rowSpan > 1) {
                    for (let occupiedCol = logicalCol; occupiedCol < logicalCol + colSpan; occupiedCol++) {
                        rowSpanOccupancy[occupiedCol] = Math.max(
                            rowSpanOccupancy[occupiedCol],
                            rowSpan
                        );
                    }
                }
                logicalCol += colSpan;
            }

            // Pad any columns left uncovered (e.g. rows with fewer cells than
            // colCount, or malformed/flattened HTML tables) so the grid is
            // complete and Hangul can open the document.
            for (let fillCol = 0; fillCol < colCount; fillCol++) {
                if (covered[fillCol]) continue;
                cellPartsForRow.push(
                    this.buildFillerCellXml(rowIdx, fillCol, isHeader, headerRowCount, totalBodyRows, colCount, colWidths[fillCol])
                );
                covered[fillCol] = true;
            }

            rowXmlParts.push(`<hp:tr>${cellPartsForRow.join('')}</hp:tr>`);
            for (let occupiedCol = 0; occupiedCol < rowSpanOccupancy.length; occupiedCol++) {
                rowSpanOccupancy[occupiedCol] = Math.max(0, rowSpanOccupancy[occupiedCol] - 1);
            }
        }

        const tableId = this.objectIdCounter++;
        const tableStartTag = this.buildTableStartTag(tableId, tableBorderFillId, colCount, rowCount);
        const tableLayoutXml = this.buildTableLayoutXml(totalWidth, rowCount);

        return tableStartTag +
            tableLayoutXml +
            '\n' +
            rowXmlParts.join('\n') + '\n' +
            `</hp:tbl>`;
    }

    /**
     * Template cell rule for one cell. Body cells try, in order: {{CELL_NUMBER}}
     * (numeric text), {{CELL_STUB}} (first column), {{CELL_ODD|EVEN[_<col>]}}
     * (stripes), then the position rule {{CELL_<row>_<col>}}; {{CELL_BODY}} last.
     * Each candidate prefers the active table variant ({{CELL_X:compact}}).
     */
    private resolveCellStyle(cell: {
        isHeader: boolean; rowIdx: number; headerRowCount: number; totalBodyRows: number;
        logicalCol: number; colSpan: number; colCount: number; text: string;
    }): CellStyle | undefined {
        const bodyRow = cell.rowIdx - cell.headerRowCount;
        const rowType = cell.isHeader ? 'HEADER'
            : bodyRow === 0 ? 'TOP' : bodyRow === cell.totalBodyRows - 1 ? 'BOTTOM' : 'MIDDLE';
        const colType = cell.logicalCol === 0 ? 'LEFT'
            : cell.logicalCol + cell.colSpan >= cell.colCount ? 'RIGHT' : 'CENTER';
        const candidates: string[] = [];
        if (!cell.isHeader) {
            if (cell.text.trim() && NUMERIC_CELL.test(cell.text.trim())) candidates.push('NUMBER');
            if (cell.logicalCol === 0) candidates.push('STUB');
            const stripe = bodyRow % 2 === 0 ? 'ODD' : 'EVEN';
            candidates.push(`${stripe}_${colType}`, stripe);
        }
        candidates.push(`${rowType}_${colType}`);
        const variant = this.tableVariant();
        for (const key of candidates) {
            if (variant && this.cellStyles[`${key}:${variant}`]) return this.cellStyles[`${key}:${variant}`];
            if (this.cellStyles[key]) {
                if (variant) this.variantKey(key, this.cellStyles, variant);
                return this.cellStyles[key];
            }
        }
        return this.cellStyles['BODY'];
    }

    /**
     * Builds an empty 1x1 cell used to fill columns that no real cell covers,
     * keeping the table grid complete so Hangul does not crash on load.
     */
    private buildFillerCellXml(
        rowIdx: number,
        logicalCol: number,
        isHeader: boolean,
        headerRowCount: number,
        totalBodyRows: number,
        colCount: number,
        colW: number
    ): string {
        const cellStyle = this.resolveCellStyle({
            isHeader, rowIdx, headerRowCount, totalBodyRows, logicalCol, colSpan: 1, colCount, text: '',
        });
        const charPrId = cellStyle?.charPrIDRef ?? '0';
        const paraPrId = cellStyle?.paraPrIDRef ?? this.styles.normalParaPrId;
        const styleId = cellStyle?.styleIDRef ?? this.styles.normalStyleId;
        const borderFillId = cellStyle?.borderFillIDRef ?? this.styles.tableBorderFillId;
        const cm = cellStyle?.cellMargin ?? this.config.CELL_MARGIN_DEFAULT;
        const cellContentXml = this.createParaStart(styleId, paraPrId) +
            this.buildEmptyRun(charPrId) +
            '</hp:p>';

        return this.buildTableCellXml({
            cellStyle,
            borderFillId,
            cellContentXml,
            colIdx: logicalCol,
            rowIdx,
            colSpan: 1,
            rowSpan: 1,
            colW,
            cm,
        });
    }

    private buildTableCellXml(args: {
        cellStyle?: CellStyle;
        borderFillId: string;
        cellContentXml: string;
        colIdx: number;
        rowIdx: number;
        colSpan: number;
        rowSpan: number;
        colW: number;
        cm: { left: number; right: number; top: number; bottom: number };
    }): string {
        const cellStartTag = this.rewriteCellStartTag(args.cellStyle?.cellStartTag, args.borderFillId);
        const subListStartTag = args.cellStyle?.subListStartTag
            ?? '<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">';

        return cellStartTag +
            subListStartTag +
            args.cellContentXml +
            `</hp:subList>` +
            `<hp:cellAddr colAddr="${args.colIdx}" rowAddr="${args.rowIdx}"/>` +
            `<hp:cellSpan colSpan="${args.colSpan}" rowSpan="${args.rowSpan}"/>` +
            `<hp:cellSz width="${args.colW}" height="2000" widthRelTo="ABSOLUTE" heightRelTo="ABSOLUTE"/>` +
            `<hp:cellMargin left="${args.cm.left}" right="${args.cm.right}" top="${args.cm.top}" bottom="${args.cm.bottom}"/>` +
            `</hp:tc>`;
    }

    private rewriteCellStartTag(templateStartTag: string | undefined, borderFillId: string): string {
        if (!templateStartTag) {
            return `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${borderFillId}">`;
        }
        if (/\bborderFillIDRef="[^"]*"/.test(templateStartTag)) {
            return templateStartTag.replace(/\bborderFillIDRef="[^"]*"/, `borderFillIDRef="${borderFillId}"`);
        }
        return templateStartTag.replace(/>$/, ` borderFillIDRef="${borderFillId}">`);
    }

    private buildTableStartTag(
        tableId: number,
        borderFillId: string,
        colCount: number,
        rowCount: number
    ): string {
        const template = this.tableLayoutTemplate?.startTag;
        if (!template) {
            // Attributes of a table Hangul saves; rowCnt/colCnt must be the real counts or the file does not open.
            return `<hp:tbl id="${tableId}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" ` +
                `textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="0" ` +
                `rowCnt="${rowCount}" colCnt="${colCount}" cellSpacing="0" borderFillIDRef="${borderFillId}" noAdjust="0">`;
        }

        let tag = template
            .replace(/\bid="[^"]*"/, `id="${tableId}"`)
            .replace(/\bborderFillIDRef="[^"]*"/, `borderFillIDRef="${borderFillId}"`);

        if (/\bcolCnt="[^"]*"/.test(tag)) {
            tag = tag.replace(/\bcolCnt="[^"]*"/, `colCnt="${colCount}"`);
        } else if (/\bcolCount="[^"]*"/.test(tag)) {
            tag = tag.replace(/\bcolCount="[^"]*"/, `colCount="${colCount}"`);
        } else {
            tag = tag.replace(/>$/, ` colCnt="${colCount}">`);
        }

        if (/\browCnt="[^"]*"/.test(tag)) {
            tag = tag.replace(/\browCnt="[^"]*"/, `rowCnt="${rowCount}"`);
        } else if (/\browCount="[^"]*"/.test(tag)) {
            tag = tag.replace(/\browCount="[^"]*"/, `rowCount="${rowCount}"`);
        } else {
            tag = tag.replace(/>$/, ` rowCnt="${rowCount}">`);
        }

        return tag;
    }

    private buildTableLayoutXml(totalWidth: number, rowCount: number): string {
        const layout = this.tableLayoutTemplate;
        const estimatedHeight = Math.max(1200, rowCount * 2000);
        if (!layout) {
            // No template table to copy: the placement Hangul writes for a new table.
            return `<hp:sz width="${totalWidth}" widthRelTo="ABSOLUTE" height="${estimatedHeight}" heightRelTo="ABSOLUTE" protect="0"/>` +
                '<hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" ' +
                'vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>' +
                '<hp:outMargin left="0" right="0" top="0" bottom="0"/>' +
                '<hp:inMargin left="510" right="510" top="141" bottom="141"/>';
        }

        const szXml = layout.szXml
            ? layout.szXml
                .replace(/\bwidth="[^"]*"/, `width="${totalWidth}"`)
                .replace(/\bheight="[^"]*"/, `height="${estimatedHeight}"`)
            : `<hp:sz width="${totalWidth}" widthRelTo="ABSOLUTE" height="${estimatedHeight}" heightRelTo="ABSOLUTE" protect="0"/>`;

        return [
            szXml,
            // Preserve the template's table placement mode, including
            // treatAsChar. The template is the source of truth for table
            // layout and users may intentionally choose floating placement.
            layout.posXml,
            layout.outMarginXml,
            layout.inMarginXml,
        ].filter(Boolean).join('');
    }

    /** {{TABLE|width=avail|100%|80%|<hwpunit>}} against the page text width; null keeps the template width. */
    private tableWidthOption(): number | null {
        const option = this.markerOptions.get('{{TABLE}}')?.width;
        if (typeof option !== 'string' || option === 'template') return null;
        if (/^\d+$/.test(option)) return Number(option);
        const page = this.pageTextWidth();
        if (!page) return null;
        if (option === 'avail') return page;
        const percent = /^(\d{1,3}(?:\.\d+)?)%$/.exec(option);
        return percent ? Math.max(1, Math.round(page * Math.min(100, Number(percent[1])) / 100)) : null;
    }

    /** Text width of the template page: paper width (height when landscape) minus left/right margins and gutter. */
    private pageTextWidth(): number | null {
        const pagePr = this.sectionXmlContent.match(/<hp:pagePr\b[^>]*>/)?.[0];
        const margin = this.sectionXmlContent.match(/<hp:pagePr\b[\s\S]*?<hp:margin\b[^>]*>/)?.[0].match(/<hp:margin\b[^>]*>/)?.[0];
        if (!pagePr || !margin) return null;
        const attr = (tag: string, name: string): number => Number(tag.match(new RegExp(`\\b${name}="(\\d+)"`))?.[1] ?? 0);
        const paper = /\blandscape="NARROWLY"/.test(pagePr) ? attr(pagePr, 'height') : attr(pagePr, 'width');
        const width = paper - attr(margin, 'left') - attr(margin, 'right') - attr(margin, 'gutter');
        return width > 0 ? width : null;
    }

    private renderTableRuleTemplate(tableXml: string): string | null {
        const ruleTemplate = this.tableRuleTemplate;
        if (!ruleTemplate) {
            const renderedDirectTemplate = this.renderDirectTableTemplate(tableXml);
            if (renderedDirectTemplate) {
                return renderedDirectTemplate;
            }
            if (!this.warnedMissingTableRuleTemplate) {
                console.warn(
                    '[md2hwpx] No CELL_* table template rule was found; using generated table XML fallback.'
                );
                this.report.add('table_template_fallback', '템플릿에 표 규칙(CELL_*)이 없어 기본 표로 만듦');
                this.warnedMissingTableRuleTemplate = true;
            }
            return null;
        }

        const innerTable = this.findFirstTableContainingCellMarker(ruleTemplate.contentXml);
        if (!innerTable) {
            console.warn('[md2hwpx] Table template rule was found, but no inner CELL_* table could be located.');
            return null;
        }

        const renderedContent = ruleTemplate.contentXml.slice(0, innerTable.start)
            + tableXml
            + ruleTemplate.contentXml.slice(innerTable.end);
        return this.reassignObjectIds(stripTemplateWrapperMarkers(renderedContent));
    }

    private renderDirectTableTemplate(tableXml: string): string | null {
        const template = this.directTableTemplate;
        if (!template) {
            return null;
        }

        const renderedParagraph = template.ownerParagraphXml.slice(0, template.tableStart)
            + tableXml
            + template.ownerParagraphXml.slice(template.tableEnd);
        return this.reassignObjectIds(stripTemplateWrapperMarkers(renderedParagraph));
    }

    private findFirstTableContainingCellMarker(xml: string): { xml: string; start: number; end: number } | null {
        const tagPattern = /<hp:tbl\b[^>]*>|<\/hp:tbl>/g;
        const stack: number[] = [];

        for (let match = tagPattern.exec(xml); match; match = tagPattern.exec(xml)) {
            if (match[0].startsWith('<hp:tbl')) {
                stack.push(match.index);
                continue;
            }

            const start = stack.pop();
            if (start === undefined) {
                continue;
            }
            const end = match.index + match[0].length;
            const tableXml = xml.slice(start, end);
            if (/\{\{CELL_[A-Z_]+\}\}/.test(tableXml)) {
                return { xml: tableXml, start, end };
            }
        }

        return null;
    }

    // ============================================================
    // Inline processing
    // ============================================================

    private processInlines(inlines: PandocInline[], baseCharPrId = '0', formats: ActiveFormats = new Set()): string {
        if (!Array.isArray(inlines)) return '';
        const parts: string[] = [];
        for (const item of inlines) {
            const xml = this.processInline(item, baseCharPrId, formats);
            if (xml) parts.push(xml);
        }
        return parts.join('');
    }

    private processInline(item: PandocInline, baseCharPrId: string, formats: ActiveFormats): string {
        switch (item.t) {
            case 'Math': {
                const mathFormats = new Set([...formats, 'math']);
                const mathId = this.styles.getInlineFormatCharPrId(baseCharPrId, mathFormats, 'math');
                return this.textRun(latexMathToUnicode(item.c[1]), mathId, mathFormats);
            }
            case 'Str':
                return this.textRun(item.c, baseCharPrId, formats);
            case 'Space':
                return this.textRun(' ', baseCharPrId, formats);
            case 'SoftBreak':
                return this.textRun(' ', baseCharPrId, formats);
            case 'LineBreak':
                return `<hp:run charPrIDRef="${baseCharPrId}"><hp:t><hp:lineBreak/></hp:t></hp:run>`;
            case 'Strong': {
                const newFmt = new Set(formats);
                newFmt.add('bold');
                const newId = this.styles.getCharPrId(baseCharPrId, newFmt);
                return this.processInlines(item.c, newId, newFmt);
            }
            case 'Emph': {
                const newFmt = new Set(formats);
                newFmt.add('italic');
                const newId = this.styles.getCharPrId(baseCharPrId, newFmt);
                return this.processInlines(item.c, newId, newFmt);
            }
            case 'Strikeout': {
                const newFmt = new Set(formats);
                newFmt.add('strikeout');
                const newId = this.styles.getCharPrId(baseCharPrId, newFmt);
                return this.processInlines(item.c, newId, newFmt);
            }
            case 'Underline': {
                const newFmt = new Set(formats);
                newFmt.add('underline');
                const newId = this.styles.getCharPrId(baseCharPrId, newFmt);
                return this.processInlines(item.c, newId, newFmt);
            }
            case 'Code': {
                // Inline code applies the {{CODE_INLINE}} (else {{CODE}}) look on
                // top of the surrounding run, so `**\`x\`**` stays bold and code in
                // a heading keeps the heading size.
                const codeFormats = new Set([...formats, 'code']);
                const codeCharPrId = this.styles.getInlineFormatCharPrId(baseCharPrId, codeFormats, 'code');
                return this.textRun(item.c[1], codeCharPrId, codeFormats);
            }
            case 'Link': {
                const [, linkInlines, linkTarget] = item.c;
                const url = linkTarget[0];
                const linkFormats = new Set([...formats, 'link']);
                const linkId = this.styles.getInlineFormatCharPrId(baseCharPrId, linkFormats, 'link');
                const innerXml = this.processInlines(linkInlines, linkId, linkFormats);
                return this.buildHyperlinkField(url, innerXml, linkId);
            }
            case 'Image':
                return this.handleImageInline(item.c, baseCharPrId);
            case 'Note':
                return this.buildFootnote(item.c, baseCharPrId);
            case 'Span': {
                const task = item.c[0][1].includes('task-done') ? 'TASK_DONE'
                    : item.c[0][1].includes('task-open') ? 'TASK_OPEN' : null;
                if (task) {
                    // The box symbol written next to {{TASK_OPEN}}/{{TASK_DONE}}, in its glyph style.
                    const style = this.placeholderStyles[task];
                    const symbol = (style?.prefix ?? '').trim();
                    if (style && symbol) return this.textRun(symbol, style.prefixCharPrIDRef ?? style.charPrIDRef, formats);
                    return this.processInlines(item.c[1], style?.charPrIDRef ?? baseCharPrId, formats);
                }
                if (!item.c[0][1].includes('mark')) {
                    return this.processInlines(item.c[1], baseCharPrId, formats);
                }
                const markFormats = new Set([...formats, 'highlight']);
                const markId = this.styles.getInlineFormatCharPrId(baseCharPrId, markFormats, 'highlight');
                return this.processInlines(item.c[1], markId, markFormats);
            }
            case 'RawInline':
                return ''; // Skip HTML
            default:
                return '';
        }
    }

    private textRun(rawText: string, charPrId: string, _formats: ActiveFormats): string {
        // Body text enters the XML here; count what escapeXml would silently drop.
        const text = stripInvalidXmlChars(rawText);
        this.removedControlCharCount += rawText.length - text.length;
        if (!text) return '';
        // A raw U+0009 TAB byte inside <hp:t> is not valid HWPML (tabs must be the
        // <hp:tab/> control element); Hangul hangs indefinitely when it encounters
        // one while opening the document. Source markdown can contain literal tabs
        // (e.g. pasted table data), so split them out here rather than trusting
        // upstream content to be clean. The element goes inside <hp:t>, as Hangul
        // saves it: a run-level <hp:tab/> opens but takes no width (checked 2026-10-21).
        // Template prefixes decode <hp:lineBreak/> to \n; write it back as the element.
        const inner = text.split('\t')
            .map((seg) => seg.split('\n').map(escapeXml).join('<hp:lineBreak/>'))
            .join('<hp:tab/>');
        return `<hp:run charPrIDRef="${charPrId}"><hp:t>${inner}</hp:t></hp:run>`;
    }

    // Mirrors a hyperlink saved by Hangul: the field controls live inside runs,
    // fieldBegin carries its target in <hp:parameters>, and fieldEnd points back
    // to the begin by id. The link text runs sit between the two controls.
    private buildHyperlinkField(url: string, innerXml: string, charPrId: string): string {
        const id = this.fieldIdCounter++;
        // Command escapes ':' ';' '\' with a backslash; the suffix is what Hangul writes.
        const command = `${url.replace(/[\\:;]/g, '\\$&')};1;5;-1;`;
        return `<hp:run charPrIDRef="${charPrId}"><hp:ctrl>` +
            `<hp:fieldBegin id="${id}" type="HYPERLINK" name="" editable="0" dirty="1" zorder="-1" fieldid="${id}">` +
            `<hp:parameters cnt="6" name="">` +
            `<hp:integerParam name="Prop">0</hp:integerParam>` +
            `<hp:stringParam name="Command">${escapeXml(command)}</hp:stringParam>` +
            `<hp:stringParam name="Path">${escapeXml(url)}</hp:stringParam>` +
            `<hp:stringParam name="Category">HWPHYPERLINK_TYPE_URL</hp:stringParam>` +
            `<hp:stringParam name="TargetType">HWPHYPERLINK_TARGET_HYPERLINK</hp:stringParam>` +
            `<hp:stringParam name="DocOpenType">HWPHYPERLINK_JUMP_DONTCARE</hp:stringParam>` +
            `</hp:parameters></hp:fieldBegin></hp:ctrl></hp:run>` +
            innerXml +
            `<hp:run charPrIDRef="${charPrId}"><hp:ctrl><hp:fieldEnd beginIDRef="${id}" fieldid="${id}"/></hp:ctrl></hp:run>`;
    }

    private handleImageInline(
        content: [unknown, PandocInline[], [string, string]],
        charPrId = '0'
    ): string {
        const src = content[2][0];
        if (!src) return '';

        if (/^[a-z]+:\/\//i.test(src) || /^data:/i.test(src)) {
            this.report.add('image_remote', '원격·data 그림은 포함하지 않고 글자로 남김', src.slice(0, 200));
            return this.textRun(`[Image: ${src}]`, charPrId, new Set());
        }

        const synthetic = /^hwpx-render-[a-f0-9]+-\d{3}\.png$/i.test(src);
        let asset: ReturnType<NonNullable<ImageAssetResolver>> | null = null;
        if (this.imageAssetResolver) {
            try {
                asset = this.imageAssetResolver(src);
            } catch (error) {
                if (synthetic) {
                    throw new ConversionError(`Captured image resolver failed for ${src}: ${String(error)}`);
                }
                console.warn(`[md2hwpx] Image asset resolver failed for ${src}:`, error);
            }
        }
        if (synthetic && !asset) {
            throw new ConversionError(`Captured image asset is missing: ${src}`);
        }
        if (asset && !asset.bytes && !asset.absolutePath) {
            if (synthetic) {
                throw new ConversionError(`Captured image asset has no bytes or path: ${src}`);
            }
            asset = null;
        }

        let resolvedPath: string | null = null;
        if (asset?.absolutePath) {
            if (path.isAbsolute(asset.absolutePath) && fs.existsSync(asset.absolutePath)) {
                resolvedPath = path.normalize(asset.absolutePath);
            } else if (!asset.bytes) {
                if (synthetic) {
                    throw new ConversionError(`Captured image asset path is invalid: ${src}`);
                }
                asset = null;
            }
        }

        if (!asset && this.imagePathResolver) {
            try {
                const candidate = this.imagePathResolver(src);
                if (candidate && path.isAbsolute(candidate) && fs.existsSync(candidate)) {
                    resolvedPath = path.normalize(candidate);
                }
            } catch (error) {
                console.warn(`[md2hwpx] Image resolver failed for ${src}:`, error);
            }
        }

        if (synthetic && !asset) {
            throw new ConversionError(`Captured image asset could not be resolved: ${src}`);
        }

        if (!asset && !resolvedPath) {
            // Unresolved image paths remain restricted to the source note directory.
            try {
                MarkdownToHwpx.validateImagePath(src, this.inputDir);
            } catch {
                console.warn(`[md2hwpx] Skipping image due to security: ${src}`);
                this.report.add('image_blocked', '노트 폴더 밖을 가리키는 그림을 보안상 건너뜀', src);
                return this.textRun(`[Image: ${src}]`, charPrId, new Set());
            }
            const candidates: string[] = [src];
            if (this.inputDir) {
                candidates.push(path.join(this.inputDir, src));
            }
            if (!candidates.some((candidate) => fs.existsSync(candidate))) {
                this.report.add('image_missing', '그림 파일을 찾지 못해 글자로 남김', src);
                return this.textRun(`[Image: ${src}]`, charPrId, new Set());
            }
        }

        if (this.images.length >= this.config.MAX_IMAGE_COUNT) {
            console.warn('[md2hwpx] Max image count reached');
            this.report.add('image_limit', '그림 개수 한도를 넘은 그림을 글자로 남김', src);
            return this.textRun(`[Image limit exceeded: ${src}]`, charPrId, new Set());
        }

        let bytes = asset?.bytes;
        if (!bytes && resolvedPath) {
            try {
                bytes = fs.readFileSync(resolvedPath);
            } catch (error) {
                if (synthetic) {
                    throw new ConversionError(`Captured image bytes could not be read: ${src}`);
                }
                console.warn(`[md2hwpx] Image could not be read: ${src}`, error);
                this.report.add('image_unreadable', '그림 파일을 읽지 못함', src);
            }
        }

        const finalExt = asset?.ext ?? imageBinaryExtension(resolvedPath ?? src);

        const imgId = `img${String(this.images.length + 1).padStart(3, '0')}`;
        const picId = String(this.objectIdCounter++);
        const size = resolveImageSize(asset ?? {}, bytes, this.availableWidth, this.config);
        const width = size.width;
        const height = size.height;

        this.images.push({
            path: src,
            resolvedPath: resolvedPath ?? asset?.absolutePath,
            bytes,
            id: imgId,
            ext: finalExt,
            width,
            height,
            displayWidthPx: asset?.displayWidthPx,
            displayHeightPx: asset?.displayHeightPx,
        });

        return `<hp:run charPrIDRef="0">` +
            `<hp:pic id="${picId}" zOrder="0" numberingType="PICTURE" ` +
            `textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" ` +
            `dropcapstyle="None" href="" groupLevel="0" instid="${picId}" reverse="0">` +
            `<hp:offset x="0" y="0"/>` +
            `<hp:orgSz width="${width}" height="${height}"/>` +
            `<hp:curSz width="${width}" height="${height}"/>` +
            `<hp:flip horizontal="0" vertical="0"/>` +
            `<hp:rotationInfo angle="0" centerX="0" centerY="0" rotateimage="0"/>` +
            `<hp:renderingInfo>` +
            `<hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>` +
            `<hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>` +
            `<hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>` +
            `</hp:renderingInfo>` +
            `<hc:img binaryItemIDRef="${imgId}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/>` +
            `<hp:imgRect>` +
            `<hc:pt0 x="0" y="0"/>` +
            `<hc:pt1 x="${width}" y="0"/>` +
            `<hc:pt2 x="${width}" y="${height}"/>` +
            `<hc:pt3 x="0" y="${height}"/>` +
            `</hp:imgRect>` +
            `<hp:imgClip left="0" right="${width}" top="0" bottom="${height}"/>` +
            `<hp:inMargin left="0" right="0" top="0" bottom="0"/>` +
            `<hp:imgDim dimwidth="${width}" dimheight="${height}"/>` +
            `<hp:effects/>` +
            `<hp:sz width="${width}" widthRelTo="ABSOLUTE" height="${height}" heightRelTo="ABSOLUTE" protect="0"/>` +
            `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" ` +
            `holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" ` +
            `vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` +
            `<hp:outMargin left="0" right="0" top="0" bottom="0"/>` +
            `</hp:pic>` +
            `<hp:t/>` +
            `</hp:run>`;
    }

    // ============================================================
    // CharPr management
    // ============================================================

    // Read per-format style deltas from the inline-format placeholders. Only the
    // properties that differ from BODY are kept, so e.g. a {{STRONG}} authored as
    // "bold, same colour as body" adds nothing and bold inside a coloured heading
    // keeps the heading colour.
    private loadInlineFormatStyles(): void {
        const bodyColor = this.styles.charPrAttr(this.placeholderStyles['BODY']?.charPrIDRef ?? '0', 'textColor');
        const formatToPlaceholder: [string, string][] = [
            ['bold', 'STRONG'], ['italic', 'EMPH'], ['strikeout', 'STRIKE'], ['underline', 'UNDERLINE'],
        ];
        for (const [format, key] of formatToPlaceholder) {
            const ph = this.placeholderStyles[key];
            if (!ph) continue;
            const xml = this.styles.extractCharPrXml(ph.charPrIDRef);
            if (!xml) continue;

            const style: typeof this.styles.inlineFormatStyle[string] = {};
            const textColor = this.styles.charPrAttrFromXml(xml, 'textColor');
            if (textColor && textColor !== 'none' && textColor !== bodyColor) {
                style.textColor = textColor;
            }
            if (format === 'strikeout') {
                const tag = xml.match(/<hh:strikeout\b[^>]*\/>/)?.[0] ?? '';
                const shape = tag.match(/shape="([^"]+)"/)?.[1];
                if (shape && shape !== 'NONE') {
                    style.strikeoutShape = shape;
                    style.strikeoutColor = tag.match(/color="([^"]+)"/)?.[1] ?? '#000000';
                }
            }
            if (format === 'underline') {
                const tag = xml.match(/<hh:underline\b[^>]*\/>/)?.[0] ?? '';
                const type = tag.match(/type="([^"]+)"/)?.[1];
                if (type && type !== 'NONE') {
                    style.underlineType = type;
                    style.underlineShape = tag.match(/shape="([^"]+)"/)?.[1] ?? 'SOLID';
                    style.underlineColor = tag.match(/color="([^"]+)"/)?.[1] ?? '#000000';
                }
            }
            if (Object.keys(style).length > 0) {
                this.styles.inlineFormatStyle[format] = style;
            }
        }

        // Links and inline code carry a fuller look (colour, shading, font face,
        // bold/italic, decoration) but never a size, so a link or code span in a
        // heading stays heading-sized. Inline code falls back to the {{CODE}}
        // block style's look.
        const bodyXml = this.styles.extractCharPrXml(this.placeholderStyles['BODY']?.charPrIDRef ?? '0') ?? '';
        for (const [format, keys] of [['link', ['LINK']], ['code', ['CODE_INLINE', 'CODE']], ['highlight', ['HIGHLIGHT']], ['math', ['MATH_INLINE']]] as const) {
            const key = keys.find((candidate) => this.placeholderStyles[candidate]);
            const xml = key ? this.styles.extractCharPrXml(this.placeholderStyles[key].charPrIDRef) : null;
            if (xml) {
                this.styles.inlineFormatStyle[format] = this.styles.readCharPrDelta(xml, bodyXml);
            }
        }
        // Without {{LINK}}, links still need to look like links (config default).
        this.styles.inlineFormatStyle['link'] ??= {
            textColor: this.config.LINK_COLOR,
            ...(this.config.LINK_UNDERLINE
                ? { underlineType: 'BOTTOM', underlineShape: 'SOLID', underlineColor: this.config.LINK_COLOR }
                : {}),
        };
        // Without {{HIGHLIGHT}}, ==text== gets the config shading.
        this.styles.inlineFormatStyle['highlight'] ??= { shadeColor: this.config.HIGHLIGHT_COLOR };
    }

    // ============================================================
    // Footnotes
    // ============================================================

    /**
     * A native Hangul footnote, structured as Hangul saves one: the control
     * sits in the reference run, and the note's first paragraph starts with
     * the auto number in the template's footnote number format.
     */
    private buildFootnote(blocks: PandocBlock[], charPrId: string): string {
        const number = ++this.footnoteCounter;
        const style = this.footnoteParagraphStyle();
        const numberFormat = this.footnoteNumberFormat();
        const autoNum = `<hp:ctrl><hp:autoNum num="${number}" numType="FOOTNOTE">${numberFormat}</hp:autoNum></hp:ctrl>`;

        const paragraphs: string[] = [];
        let numbered = false;
        for (const block of blocks) {
            if ((block.t === 'Para' || block.t === 'Plain') && !numbered) {
                paragraphs.push(
                    this.createParaStart(style.styleIDRef, style.paraPrIDRef) +
                    `<hp:run charPrIDRef="${style.charPrIDRef}">${autoNum}<hp:t> </hp:t></hp:run>` +
                    this.processInlines(block.c, style.charPrIDRef) +
                    '</hp:p>'
                );
                numbered = true;
            } else if (block.t === 'Para' || block.t === 'Plain') {
                paragraphs.push(this.buildParagraph(block.c, style.styleIDRef, style.paraPrIDRef, style.charPrIDRef));
            } else {
                const xml = this.processBlock(block);
                if (xml) paragraphs.push(xml);
            }
        }
        if (!numbered) {
            paragraphs.unshift(
                this.createParaStart(style.styleIDRef, style.paraPrIDRef) +
                `<hp:run charPrIDRef="${style.charPrIDRef}">${autoNum}<hp:t/></hp:run></hp:p>`
            );
        }

        const suffix = numberFormat.match(/\bsuffixChar="([^"]*)"/)?.[1] ?? '';
        const suffixAttr = suffix ? ` suffixChar="${unescapeXml(suffix).codePointAt(0)}"` : '';
        return `<hp:run charPrIDRef="${charPrId}"><hp:ctrl>` +
            `<hp:footNote number="${number}"${suffixAttr} instId="${this.objectIdCounter++}">` +
            '<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" ' +
            'linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">' +
            paragraphs.join('') +
            '</hp:subList></hp:footNote></hp:ctrl></hp:run>';
    }

    /** {{FOOTNOTE}}, else the template's 각주 (Footnote) paragraph style, else BODY. */
    private footnoteParagraphStyle(): { styleIDRef: string; paraPrIDRef: string; charPrIDRef: string } {
        const marker = this.placeholderStyles['FOOTNOTE'];
        if (marker) return marker;
        const styleTag = this.styles.headerXmlRaw.match(/<hh:style\b[^>]*\bengName="Footnote"[^>]*>/)?.[0];
        if (styleTag) {
            const attr = (name: string): string | undefined => styleTag.match(new RegExp(`\\b${name}="(\\d+)"`))?.[1];
            const styleIDRef = attr('id');
            const paraPrIDRef = attr('paraPrIDRef');
            const charPrIDRef = attr('charPrIDRef');
            if (styleIDRef && paraPrIDRef && charPrIDRef) return { styleIDRef, paraPrIDRef, charPrIDRef };
        }
        this.noteStyleFallback('FOOTNOTE');
        const body = this.placeholderStyles['BODY'];
        return {
            styleIDRef: body?.styleIDRef ?? this.styles.normalStyleId,
            paraPrIDRef: body?.paraPrIDRef ?? this.styles.normalParaPrId,
            charPrIDRef: body?.charPrIDRef ?? '0',
        };
    }

    /** The number format the template's section gives footnotes (secPr footNotePr). */
    private footnoteNumberFormat(): string {
        const footNotePr = this.sectionXmlContent.match(/<hp:footNotePr\b[\s\S]*?<\/hp:footNotePr>/)?.[0] ?? '';
        return footNotePr.match(/<hp:autoNumFormat\b[^>]*\/>/)?.[0]
            ?? '<hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/>';
    }

    private buildParagraph(
        inlines: PandocInline[],
        styleId: string,
        paraPrId: string,
        charPrId: string,
        pageBreak = 0,
        prefix?: string,
        prefixCharPrId?: string,
        suffix?: string,
        suffixCharPrId?: string
    ): string {
        const para = this.createParaStart(styleId, paraPrId, pageBreak);
        let content = '';
        if (prefix) {
            content += this.textRun(prefix, prefixCharPrId ?? charPrId, new Set());
        }
        content += this.processInlines(inlines, charPrId);
        if (suffix) {
            content += this.textRun(suffix, suffixCharPrId ?? charPrId, new Set());
        }
        return this.refreshParagraphLineSegArray(para + content + '</hp:p>');
    }

    private buildEmptyParagraph(styleId: string, paraPrId: string, charPrId: string): string {
        const para = this.createParaStart(styleId, paraPrId);
        return para + this.buildEmptyRun(charPrId) + '</hp:p>';
    }

    private buildEmptyRun(charPrId: string): string {
        return `<hp:run charPrIDRef="${charPrId}"><hp:t/></hp:run>`;
    }

    private renderPlaceholderParagraphFromTemplate(
        templateParagraphXml: string,
        inlines: PandocInline[],
        placeholderMarker: string,
        props: PlaceholderStyle,
        counter = 1
    ): string {
        const startTag = extractParagraphStartTag(templateParagraphXml);
        if (!startTag) {
            return this.buildParagraph(
                inlines,
                props.styleIDRef,
                props.paraPrIDRef,
                props.charPrIDRef,
                0,
                props.prefix ? this.formatCounterText(props.prefix, counter) : undefined,
                props.prefixCharPrIDRef ?? undefined,
                props.suffix ?? undefined,
                props.suffixCharPrIDRef ?? undefined
            );
        }

        const placeholder = placeholderMarker;
        const renderedInlineXml = this.processInlines(inlines, props.charPrIDRef);
        let replaced = false;
        const renderedFromTemplate = templateParagraphXml.replace(
            /<hp:run\b([^>]*\bcharPrIDRef="[^"]+"[^>]*)>((?:\s*(?:<hp:t(?:\s[^>]*)?\/>|<hp:t(?:\s[^>]*)?>[\s\S]*?<\/hp:t>|<hp:(?!t\b)[A-Za-z]+\b[^>]*\/>))+)\s*<\/hp:run>/g,
            (match, runAttrs: string, runInner: string) => {
                if (replaced) {
                    return match;
                }

                const decoded = decodeTemplateTextRun(runInner);
                const placeholderIndex = decoded?.text.indexOf(placeholder) ?? -1;
                if (!decoded || placeholderIndex === -1) {
                    return match;
                }

                replaced = true;
                // Substitute the running counter into any literal ordinal the
                // template author typed around the placeholder (e.g. " 1. " for
                // {{LIST_ORDERED_n}}). formatCounterText is a no-op when there is
                // no number/roman/Korean ordinal, so plain prefixes are untouched.
                const beforeText = this.formatCounterText(decoded.text.slice(0, placeholderIndex), counter);
                const afterText = decoded.text.slice(placeholderIndex + placeholder.length);
                const textRun = (text: string): string => text
                    ? `<hp:run${runAttrs}><hp:t${decoded.textAttrs}>${encodeTemplateText(text, decoded.elements)}</hp:t></hp:run>`
                    : '';
                return textRun(beforeText) + renderedInlineXml + textRun(afterText);
            }
        );

        if (replaced) {
            return this.refreshParagraphLineSegArray(stripTemplateWrapperMarkers(renderedFromTemplate));
        }

        let content = '';
        if (props.prefix) {
            const prefixCharPrId = props.prefixCharPrIDRef ?? props.charPrIDRef;
            content += this.textRun(this.formatCounterText(props.prefix, counter), prefixCharPrId, new Set());
        }
        content += this.processInlines(inlines, props.charPrIDRef);
        if (props.suffix) {
            const suffixCharPrId = props.suffixCharPrIDRef ?? props.charPrIDRef;
            content += this.textRun(props.suffix, suffixCharPrId, new Set());
        }

        return this.refreshParagraphLineSegArray(`${startTag}${content}</hp:p>`);
    }

    private refreshParagraphLineSegArray(paraXml: string): string {
        // Only this paragraph's own lines: a footnote (or table cell) nests whole
        // paragraphs in <hp:subList>, and counting their line breaks gives the
        // outer paragraph extra line segments that Hangul refuses to open.
        const ownXml = removeOutermostElements(paraXml, 'hp:subList');
        const lineBreakCount = (ownXml.match(/<hp:lineBreak\s*\/>/g) ?? []).length;
        if (lineBreakCount === 0) {
            return paraXml;
        }

        const existingLineSegArray = ownXml.match(/<hp:linesegarray[\s\S]*?<\/hp:linesegarray>/)?.[0] ?? null;
        const lineTextPositions = this.computeLineTextPositions(ownXml);
        const lineSegArray = this.buildParagraphLineSegArray(
            existingLineSegArray,
            lineBreakCount + 1,
            lineTextPositions
        );

        if (existingLineSegArray) {
            // The paragraph's own array follows any nested content.
            const at = paraXml.lastIndexOf(existingLineSegArray);
            return paraXml.slice(0, at) + lineSegArray + paraXml.slice(at + existingLineSegArray.length);
        }
        return paraXml.replace(/<\/hp:p>$/, `${lineSegArray}</hp:p>`);
    }

    private computeLineTextPositions(paraXml: string): number[] {
        const contentBeforeLineSeg = paraXml.replace(/<hp:linesegarray[\s\S]*?<\/hp:linesegarray>/g, '');
        const lineBreakMarker = '\u0000LINEBREAK\u0000';
        const flattened = unescapeXml(
            contentBeforeLineSeg
                .replace(/<hp:lineBreak\s*\/>/g, lineBreakMarker)
                .replace(/<[^>]+>/g, '')
        );
        const lines = flattened.split(lineBreakMarker);
        const positions: number[] = [];
        let pos = 0;
        for (let i = 0; i < lines.length; i++) {
            positions.push(pos);
            pos += [...lines[i]].length + 1;
        }
        return positions;
    }

    private buildParagraphLineSegArray(
        templateLineSegArray: string | null,
        lineCount: number,
        lineTextPositions: number[]
    ): string {
        const templateLineSeg = templateLineSegArray?.match(/<hp:lineseg\b[^>]*\/>/)?.[0] ?? '';
        const attr = (name: string, fallback: string): string =>
            templateLineSeg.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? fallback;

        const firstVertPos = Number(attr('vertpos', '0'));
        const vertSize = Number(attr('vertsize', '1200'));
        const textHeight = attr('textheight', String(vertSize));
        const baseline = attr('baseline', String(Math.round(vertSize * 0.85)));
        const spacing = Number(attr('spacing', String(Math.round(vertSize * 0.5))));
        const horzPos = attr('horzpos', '0');
        const horzSize = attr('horzsize', '0');
        const flags = attr('flags', '393216');
        const lineStep = vertSize + spacing;

        const lines: string[] = [];
        for (let i = 0; i < lineCount; i++) {
            lines.push(
                `<hp:lineseg textpos="${lineTextPositions[i] ?? 0}" ` +
                `vertpos="${firstVertPos + lineStep * i}" ` +
                `vertsize="${vertSize}" textheight="${textHeight}" baseline="${baseline}" ` +
                `spacing="${spacing}" horzpos="${horzPos}" horzsize="${horzSize}" flags="${flags}"/>`
            );
        }
        return `<hp:linesegarray>${lines.join('')}</hp:linesegarray>`;
    }

    private cloneTemplateParagraph(rawParagraphXml: string): string {
        return this.reassignObjectIds(stripTemplateWrapperMarkers(rawParagraphXml));
    }

    private createParaStart(styleId: string, paraPrId: string, pageBreak = 0): string {
        const id = this.paraIdCounter++;
        const pb = pageBreak ? ' pageBreak="1"' : '';
        return `<hp:p id="${id}" paraPrIDRef="${paraPrId}" styleIDRef="${styleId}"${pb} columnBreak="0" merged="0">`;
    }

    private removeTemplateElements(xml: string): string {
        return removeOutermostElements(xml.replace(/<hp:secPr[\s\S]*?<\/hp:secPr>/g, ''), 'hp:ctrl')
            .replace(/<hp:linesegarray[\s\S]*?<\/hp:linesegarray>/g, '')
            .replace(/<hp:label\b[^>]*\/>/g, '')
            .replace(/<hp:label\b[\s\S]*?<\/hp:label>/g, '');
    }

    private reassignParagraphIds(xml: string): string {
        return xml.replace(/<hp:p\b([^>]*)\bid="[^"]*"([^>]*)>/g, (_match, before, after) => {
            const nextId = this.paraIdCounter++;
            return `<hp:p${before}id="${nextId}"${after}>`;
        });
    }

    /**
     * Give a cloned template fragment fresh ids: paragraphs, every object with a
     * numeric id (tables, pictures, shapes, equations …; instid follows id), and
     * fields (fieldEnd follows its fieldBegin). Duplicate object ids corrupt the
     * floating-object anchor list and make Hangul hang on open.
     */
    private reassignObjectIds(xml: string): string {
        const withObjectIds = this.reassignParagraphIds(xml).replace(OBJECT_START_TAG_PATTERN, (tag) => {
            if (!/\sid="\d+"/.test(tag)) return tag;
            const nextId = this.objectIdCounter++;
            return tag.replace(/(\s)id="\d+"/, `$1id="${nextId}"`).replace(/(\s)instid="\d+"/, `$1instid="${nextId}"`);
        });

        const fieldIds = new Map<string, string>();
        return withObjectIds
            .replace(/<hp:fieldBegin\b[^>]*>/g, (tag) => {
                const oldId = tag.match(/\sid="(\d+)"/)?.[1];
                if (!oldId) return tag;
                const nextId = String(this.fieldIdCounter++);
                fieldIds.set(oldId, nextId);
                return tag.replace(/(\s)id="\d+"/, `$1id="${nextId}"`).replace(/(\s)fieldid="\d+"/, `$1fieldid="${nextId}"`);
            })
            .replace(/<hp:fieldEnd\b[^>]*>/g, (tag) => {
                const nextId = fieldIds.get(tag.match(/\sbeginIDRef="(\d+)"/)?.[1] ?? '');
                if (!nextId) return tag;
                return tag.replace(/(\s)beginIDRef="\d+"/, `$1beginIDRef="${nextId}"`)
                    .replace(/(\s)fieldid="\d+"/, `$1fieldid="${nextId}"`);
            });
    }

    private applyPageBreakToOuterParagraph(xml: string): string {
        const startTag = extractParagraphStartTag(xml);
        if (!startTag) {
            return xml;
        }

        const updatedStartTag = replaceParagraphAttr(startTag, 'pageBreak', '1');
        return updatedStartTag + xml.slice(startTag.length);
    }

    private replaceTemplateNumberingText(xml: string, targetText: string, counter: number): string {
        let replaced = false;
        return xml.replace(HP_TEXT_PATTERN, (match, attrs: string, innerText: string) => {
            if (replaced) return match;
            if (templateTextContent(innerText).trim() !== targetText.trim()) {
                return match;
            }

            replaced = true;
            const elements: string[] = [];
            const decoded = decodeTemplateElements(innerText, elements);
            return `<hp:t${attrs}>${encodeTemplateText(this.formatCounterText(decoded, counter), elements)}</hp:t>`;
        });
    }

    /**
     * Writes the running counter into a template's number text. `{{#}}`,
     * `{{#:가}}`, `{{#:①}}` … mark the place explicitly; otherwise the first
     * ordinal-looking token is used: roman numeral, circled number/consonant,
     * a number used as an ordinal (`1.` `1)` `(1)`) or else the first number, a standalone
     * Korean ordinal letter, then `A.`/`a)`/`(a)`. Text without one is left as is.
     */
    private formatCounterText(templateText: string, counter: number): string {
        if (templateText.includes('{{#')) {
            return templateText.replace(/\{\{#(?::([^{}]*))?\}\}/g, (_m, style?: string) =>
                this.ordinalText(counter, style?.trim() || '1', templateText));
        }
        const at = (match: RegExpExecArray, text: string): string =>
            templateText.slice(0, match.index) + text + templateText.slice(match.index + match[0].length);
        let match: RegExpExecArray | null;

        if ((match = ROMAN_ORDINAL.exec(templateText))) {
            return at(match, this.ordinalText(counter, match[0] === match[0].toLowerCase() ? 'i' : 'I', templateText));
        }
        if ((match = /[\u2160-\u216B\u2170-\u217B\u2460-\u2473\u3260-\u326D]/.exec(templateText))) {
            return at(match, this.ordinalText(counter, match[0], templateText));
        }
        if ((match = /\d+(?=[.)\]])|(?<=\()\d+/.exec(templateText) ?? /\d+/.exec(templateText))) {
            return at(match, String(counter));
        }
        // A standalone ordinal letter only: `[가-하]` spans almost every Hangul
        // syllable and would turn a label such as "요약" into "가약".
        if ((match = /(?<![가-힣])[가나다라마바사아자차카타파하](?![가-힣])/.exec(templateText))) {
            return at(match, this.ordinalText(counter, '가', templateText));
        }
        // Only the first letter counts as a Latin ordinal, so "Q." stays "Q.".
        if ((match = /(?<![A-Za-z])[Aa](?=[.)])|(?<=\()[Aa](?=\))/.exec(templateText))) {
            return at(match, this.ordinalText(counter, match[0], templateText));
        }
        return templateText;
    }

    /** The counter in one ordinal style; past the end of a finite sequence the plain number, reported. */
    private ordinalText(counter: number, style: string, source: string): string {
        const overflow = (): string => {
            this.report.add('counter_out_of_range', '번호가 템플릿 번호 형식의 범위를 넘어 숫자로 표시함', `${source.trim()} → ${counter}`);
            return String(counter);
        };
        const fromRange = (first: number, size: number): string =>
            counter >= 1 && counter <= size ? String.fromCodePoint(first + counter - 1) : overflow();
        const code = style.codePointAt(0) ?? 0;
        if (style === 'I' || style === 'i') {
            const roman = toRoman(counter);
            if (!roman) return overflow();
            return style === 'i' ? roman.toLowerCase() : roman;
        }
        if (code >= 0x2160 && code <= 0x216B) return fromRange(0x2160, 12); // Ⅰ … Ⅻ
        if (code >= 0x2170 && code <= 0x217B) return fromRange(0x2170, 12); // ⅰ … ⅻ
        if (code >= 0x2460 && code <= 0x2473) return fromRange(0x2460, 20); // ① … ⑳
        if (code >= 0x3260 && code <= 0x326D) return fromRange(0x3260, 14); // ㉠ … ㉭
        if (/^[가-힣]$/.test(style)) {
            const letters = '가나다라마바사아자차카타파하';
            return counter >= 1 && counter <= letters.length ? letters[counter - 1] : overflow();
        }
        if (style === 'A' || style === 'a') {
            const letters = toLatinLetters(counter);
            return style === 'a' ? letters.toLowerCase() : letters;
        }
        return String(counter);
    }

    // ============================================================
    // Header XML injection
    // ============================================================


}

// Order in which inline format deltas stack; later entries win on conflicts.


function comparePrefixPlaceholderRules(
    left: PrefixPlaceholderRule,
    right: PrefixPlaceholderRule
): number {
    const rank = (rule: PrefixPlaceholderRule): number => {
        if (rule.spacingMode === 'exact') {
            if (rule.kind === 'number-period') return 0;
            if (rule.kind === 'number') return 1;
            return 2;
        }
        if (rule.kind === 'number-period') return 3;
        if (rule.kind === 'number') return 4;
        return 5;
    };

    const rankDifference = rank(left) - rank(right);
    if (rankDifference !== 0) return rankDifference;

    if (left.kind === 'literal' && right.kind === 'literal') {
        const lengthDifference = right.token.length - left.token.length;
        if (lengthDifference !== 0) return lengthDifference;
    }

    return left.sourceOrder - right.sourceOrder;
}
