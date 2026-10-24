/**
 * Remove Obsidian comments (`%% … %%`) before the Markdown is parsed. Obsidian
 * hides them in reading view, so they must not reach the exported document.
 *
 * Comments may be inline or span several lines. An unclosed `%%` hides the
 * rest of the note, as in Obsidian. Fenced code blocks and inline code spans
 * are left untouched (mermaid sources use `%%{init: …}%%`), matching the
 * convention used by rewriteObsidianImageEmbeds. Lines left blank by a removed
 * comment are dropped so a comment block does not split a paragraph.
 */
export function stripObsidianComments(markdown: string): string {
    if (!markdown.includes('%%')) {
        return markdown;
    }

    const REMOVED = '\u0000';
    let out = '';
    let index = 0;
    let atLineStart = true;
    let fence: { marker: string; length: number } | null = null;

    while (index < markdown.length) {
        if (atLineStart) {
            const lineEnd = indexOfOrEnd(markdown, '\n', index);
            const line = markdown.slice(index, lineEnd);
            const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
            if (fenceMatch || fence) {
                if (fenceMatch) {
                    const marker = fenceMatch[1][0];
                    if (!fence) {
                        fence = { marker, length: fenceMatch[1].length };
                    } else if (fence.marker === marker && fenceMatch[1].length >= fence.length) {
                        fence = null;
                    }
                }
                out += markdown.slice(index, Math.min(lineEnd + 1, markdown.length));
                index = lineEnd + 1;
                continue;
            }
        }

        const ch = markdown[index];
        if (ch === '`') {
            let runEnd = index;
            while (markdown[runEnd] === '`') runEnd++;
            const delimiter = markdown.slice(index, runEnd);
            const closeIndex = markdown.indexOf(delimiter, runEnd);
            // A code span cannot cross a blank line.
            const blankLine = markdown.slice(runEnd, closeIndex).search(/\n[ \t]*\n/);
            if (closeIndex >= 0 && blankLine < 0) {
                out += markdown.slice(index, closeIndex + delimiter.length);
                index = closeIndex + delimiter.length;
            } else {
                out += delimiter;
                index = runEnd;
            }
            atLineStart = false;
            continue;
        }

        if (ch === '%' && markdown[index + 1] === '%') {
            const closeIndex = markdown.indexOf('%%', index + 2);
            const end = closeIndex >= 0 ? closeIndex + 2 : markdown.length;
            // Keep a single space between the words around an inline comment.
            let resume = end;
            // eslint-disable-next-line no-control-regex -- U+0000 is the REMOVED placeholder
            if (out.length === 0 || /[ \t\n\u0000]$/.test(out)) {
                while (markdown[resume] === ' ' || markdown[resume] === '\t') resume++;
            }
            out += REMOVED;
            index = resume;
            atLineStart = false;
            continue;
        }

        out += ch;
        atLineStart = ch === '\n';
        index++;
    }

    return out
        .split('\n')
        .filter((line) => !(line.includes(REMOVED) && line.split(REMOVED).join('').trim() === ''))
        .join('\n')
        .split(REMOVED).join('');
}

function indexOfOrEnd(text: string, search: string, from: number): number {
    const found = text.indexOf(search, from);
    return found < 0 ? text.length : found;
}
