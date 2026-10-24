const SUPPORTED_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif']);

/**
 * Convert Obsidian image embeds into ordinary Markdown images so the shared
 * Markdown parser emits Image nodes. Fenced code blocks are intentionally left
 * untouched.
 */
export function rewriteObsidianImageEmbeds(markdown: string): string {
    const lines = markdown.split(/(\r?\n)/);
    let fence: { marker: '`' | '~'; length: number } | null = null;

    return lines.map((part) => {
        if (/^\r?\n$/.test(part)) {
            return part;
        }

        const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(part);
        if (fenceMatch) {
            const marker = fenceMatch[1][0] as '`' | '~';
            if (!fence) {
                fence = { marker, length: fenceMatch[1].length };
            } else if (fence.marker === marker && fenceMatch[1].length >= fence.length) {
                fence = null;
            }
            return part;
        }
        if (fence) {
            return part;
        }

        return rewriteOutsideInlineCode(part);
    }).join('');
}

function rewriteOutsideInlineCode(line: string): string {
    let result = '';
    let plainStart = 0;
    let index = 0;

    while (index < line.length) {
        if (line[index] !== '`') {
            index++;
            continue;
        }

        let runEnd = index;
        while (line[runEnd] === '`') runEnd++;
        const delimiter = line.slice(index, runEnd);
        const closeIndex = line.indexOf(delimiter, runEnd);
        if (closeIndex < 0) {
            break;
        }

        result += rewriteEmbedText(line.slice(plainStart, index));
        const codeEnd = closeIndex + delimiter.length;
        result += line.slice(index, codeEnd);
        index = codeEnd;
        plainStart = codeEnd;
    }

    return result + rewriteEmbedText(line.slice(plainStart));
}

function rewriteEmbedText(text: string): string {
    return text.replace(/!\[\[([^\]\r\n]+)\]\]/g, (original, inner: string) => {
            const pipeIndex = inner.indexOf('|');
            const rawTarget = (pipeIndex >= 0 ? inner.slice(0, pipeIndex) : inner).trim();
            const alias = (pipeIndex >= 0 ? inner.slice(pipeIndex + 1) : '').trim();
            const linkPath = rawTarget.split('#', 1)[0].trim();
            const extension = getExtension(linkPath);
            if (!linkPath || !SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
                return original;
            }

            const filename = linkPath.replace(/\\/g, '/').split('/').pop() ?? linkPath;
            const alt = alias && !/^\d+(?:x\d+)?$/i.test(alias) ? alias : filename;
            return `![${escapeAltText(alt)}](${encodeMarkdownDestination(linkPath)})`;
    });
}

export function isSupportedEmbeddedImagePath(linkPath: string): boolean {
    return SUPPORTED_IMAGE_EXTENSIONS.has(getExtension(linkPath.split('#', 1)[0]));
}

function getExtension(linkPath: string): string {
    const filename = linkPath.replace(/\\/g, '/').split('/').pop() ?? '';
    const dot = filename.lastIndexOf('.');
    return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

function escapeAltText(text: string): string {
    return text.replace(/\\/g, '\\\\').replace(/([[\]])/g, '\\$1');
}

function encodeMarkdownDestination(linkPath: string): string {
    return encodeURI(linkPath)
        .replace(/\(/g, '%28')
        .replace(/\)/g, '%29');
}
