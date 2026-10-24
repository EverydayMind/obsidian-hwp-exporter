/**
 * Apply `fn` to the parts of a Markdown text that are not code: fenced code
 * blocks and inline code spans pass through unchanged. Line endings are kept.
 * Same fence rules as rewriteObsidianImageEmbeds.
 */
export function mapOutsideCode(markdown: string, fn: (text: string) => string): string {
    let fence: { marker: string; length: number } | null = null;
    return markdown.split(/(\r?\n)/).map((part) => {
        if (/^\r?\n$/.test(part)) return part;
        const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(part);
        if (fenceMatch) {
            const marker = fenceMatch[1][0];
            if (!fence) fence = { marker, length: fenceMatch[1].length };
            else if (fence.marker === marker && fenceMatch[1].length >= fence.length) fence = null;
            return part;
        }
        if (fence) return part;
        // split() with two groups yields [text, span, backticks, text, …].
        return part.split(/((`+)[\s\S]*?\2)/).map((segment, index) => {
            if (index % 3 === 1) return segment;
            if (index % 3 === 2) return '';
            return fn(segment);
        }).join('');
    }).join('');
}
