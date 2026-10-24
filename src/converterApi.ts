/**
 * High-level convenience API for the shared HWPX converter.
 */

import * as path from 'path';
import * as fs from 'fs';
import { MarkoToPandocAdapter } from './markoAdapter';
import { parseMarkdownStringWithFrontmatter, convertMetadataToPandocMeta } from './frontmatterParser';
import { MarkdownToHwpx } from './markdownToHwpx';
import { ConversionConfig, DEFAULT_CONFIG } from './config';
import { rewriteLatexSymbols } from './latexSymbols';
import { stripObsidianComments } from './obsidianComments';
import type { ImageAssetResolver, ImagePathResolver } from './types';
import { SecurityError } from './exceptions';
import { ConversionReportCollector, type ConversionReport } from './conversionReport';
import { mapOutsideCode } from './markdownCode';

export interface ConvertOptions {
    referenceDoc?: string;
    config?: ConversionConfig;
    inputPath?: string | null;
    imagePathResolver?: ImagePathResolver;
    imageAssetResolver?: ImageAssetResolver;
}

/**
 * Replace literal `{{title}}` placeholders in the note body with the
 * source file's basename (extension stripped), mirroring Obsidian's
 * Templates plugin convention. No-op when the input path is unknown.
 */
function applyTitlePlaceholder(mdContent: string, inputPath: string | null | undefined): string {
    if (!inputPath || !mdContent.includes('{{title}}')) {
        return mdContent;
    }
    const title = path.basename(inputPath).replace(/\.[^./\\]+$/, '');
    // Code keeps a literal {{title}} (e.g. a template snippet in a code block).
    return mapOutsideCode(mdContent, (text) => text.split('{{title}}').join(title));
}

/** Obsidian syntax the converter does not render yet, reported because it stays as literal text. */
function findLiteralSyntax(markdown: string, report: ConversionReportCollector): void {
    const message = '지원하지 않는 Obsidian 문법이 글자 그대로 남음';
    mapOutsideCode(markdown, (text) => {
        // Wikilinks have no target in an exported document (embeds ![[…]] are images).
        for (const match of text.matchAll(/(?<!!)\[\[([^\]\n]+)\]\]/g)) report.add('literal_syntax', message, match[0].slice(0, 80));
        return text;
    });
}

/**
 * Return path to the bundled blank.hwpx template.
 */
export function getDefaultReferenceDoc(): string {
    const projectRootDefault = path.join(__dirname, '..', '적용템플릿.hwpx');
    if (fs.existsSync(projectRootDefault)) {
        return projectRootDefault;
    }

    const assetDefault = path.join(__dirname, '..', 'obsidian', 'assets', 'templates', '한글 템플릿.hwpx');
    if (fs.existsSync(assetDefault)) {
        return assetDefault;
    }

    return path.join(__dirname, '..', 'obsidian', 'assets', 'templates', 'blank.hwpx');
}

/**
 * Convert a Markdown string to an HWPX file.
 *
 * @param markdownString - Markdown text (may include YAML frontmatter)
 * @param outputPath - Output .hwpx file path
 * @param referenceDoc - Path to reference HWPX template (optional)
 * @param config - Conversion configuration (optional)
 * @param inputPath - Source note path, used for resolving relative images (optional)
 * @param imagePathResolver - Trusted integration callback for resolving image links (optional)
 * @returns What the conversion could not express as written (see conversionReport.ts).
 */
export function convertString(
    markdownString: string,
    outputPath: string,
    options?: ConvertOptions
): Promise<ConversionReport>;

/** @deprecated Positional overload retained for existing integrations. */
export function convertString(
    markdownString: string,
    outputPath: string,
    referenceDoc?: string,
    config?: ConversionConfig,
    inputPath?: string | null,
    imagePathResolver?: ImagePathResolver
): Promise<ConversionReport>;

export async function convertString(
    markdownString: string,
    outputPath: string,
    referenceDocOrOptions?: string | ConvertOptions,
    config?: ConversionConfig,
    inputPath?: string | null,
    imagePathResolver?: ImagePathResolver
): Promise<ConversionReport> {
    const options: ConvertOptions = typeof referenceDocOrOptions === 'object'
        ? referenceDocOrOptions
        : {
            referenceDoc: referenceDocOrOptions,
            config,
            inputPath,
            imagePathResolver,
        };
    const refDoc = options.referenceDoc ?? getDefaultReferenceDoc();
    const cfg = options.config ?? DEFAULT_CONFIG;

    // The note path only names the note; the size limit applies to the text itself.
    const inputBytes = Buffer.byteLength(markdownString, 'utf8');
    if (inputBytes > cfg.MAX_INPUT_FILE_SIZE) {
        throw new SecurityError(`Input markdown too large: ${inputBytes} bytes`);
    }

    // Parse frontmatter and markdown content
    const { metadata, content: rawContent } = parseMarkdownStringWithFrontmatter(markdownString);
    const mdContent = rewriteLatexSymbols(applyTitlePlaceholder(stripObsidianComments(rawContent), options.inputPath), { preserveMath: true });
    const report = new ConversionReportCollector();
    findLiteralSyntax(mdContent, report);

    // Convert to Pandoc-like AST
    const adapter = new MarkoToPandocAdapter();
    const ast = adapter.parse(mdContent);
    ast.meta = convertMetadataToPandocMeta(metadata);
    report.merge(adapter.report.toJSON());

    // Convert AST to HWPX file
    const converterReport = await MarkdownToHwpx.convertToHwpx(
        options.inputPath ?? null,
        outputPath,
        refDoc,
        ast,
        cfg,
        options.imagePathResolver,
        options.imageAssetResolver
    );
    report.merge(converterReport);
    return report.toJSON();
}

/**
 * Convert a Markdown file to an HWPX file. A thin wrapper over convertString:
 * the file path becomes `inputPath` (for `{{title}}` and relative images).
 *
 * @param inputPath - Input .md file path
 * @param outputPath - Output .hwpx file path
 * @param options - Template, config and image resolvers (optional)
 */
export function convertFile(
    inputPath: string,
    outputPath: string,
    options?: Omit<ConvertOptions, 'inputPath'>
): Promise<ConversionReport>;

/** @deprecated Positional overload retained for existing integrations. */
export function convertFile(
    inputPath: string,
    outputPath: string,
    referenceDoc?: string,
    config?: ConversionConfig
): Promise<ConversionReport>;

export async function convertFile(
    inputPath: string,
    outputPath: string,
    referenceDocOrOptions?: string | Omit<ConvertOptions, 'inputPath'>,
    config?: ConversionConfig
): Promise<ConversionReport> {
    const options: Omit<ConvertOptions, 'inputPath'> = typeof referenceDocOrOptions === 'object'
        ? referenceDocOrOptions
        : { referenceDoc: referenceDocOrOptions, config };
    const cfg = options.config ?? DEFAULT_CONFIG;
    const inputSize = fs.statSync(inputPath).size;
    if (inputSize > cfg.MAX_INPUT_FILE_SIZE) {
        throw new SecurityError(`Input file too large: ${inputSize} bytes`);
    }
    return convertString(fs.readFileSync(inputPath, 'utf-8'), outputPath, { ...options, inputPath });
}
