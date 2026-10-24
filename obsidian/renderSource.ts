import type { RenderableBlock } from '../src/renderableBlocks';

export interface RenderSourceOptions {
    mermaidDisableHtmlLabels: boolean;
}

/**
 * Reconstruct a Markdown fenced code block for Obsidian's MarkdownRenderer.
 *
 * RenderableBlock.source intentionally contains only the body of the source
 * fence. Markdown code-block processors, however, are selected by the fence
 * language, so passing source directly would render it as ordinary Markdown.
 */
export function wrapAsFence(language: string, source: string): string {
    const longestRun = Math.max(0, ...(source.match(/`+/g)?.map((run) => run.length) ?? [0]));
    const fence = '`'.repeat(Math.max(3, longestRun + 1));
    const body = source.endsWith('\n') ? source : `${source}\n`;
    return `${fence}${language}\n${body}${fence}`;
}

export function prepareRenderSource(
    block: RenderableBlock,
    options: RenderSourceOptions
): string {
    const source = prepareMermaidSource(block, options);
    return wrapAsFence(block.hint, source);
}

export function prepareMermaidSource(
    block: RenderableBlock,
    options: RenderSourceOptions
): string {
    let source = block.source;
    if (block.hint === 'mermaid' && options.mermaidDisableHtmlLabels
        && !/%%\{\s*init\s*:/i.test(source)
        && /^\s*(?:graph|flowchart|classDiagram|stateDiagram(?:-v2)?)\b/m.test(source)) {
        source = `%%{init: {"flowchart":{"htmlLabels":false}}}%%\n${source}`;
    }
    return source;
}
