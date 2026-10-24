/** Source ranges in the normalized section XML; end offsets are exclusive. */
export interface TemplateElement {
    tag: string;
    start: number;
    end: number;
    xml: string;
}

export interface TemplateModel {
    elements: TemplateElement[];
    markers: Array<{ text: string; start: number; end: number }>;
}

/** Index paragraph/table/cell boundaries in one pass, including nested tables. */
export class TemplateScanner {
    readonly model: TemplateModel = { elements: [], markers: [] };
    private readonly byTag = new Map<string, TemplateElement[]>();

    constructor(xml: string) {
        const stack: Array<{ tag: string; start: number }> = [];
        const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?hp:(?:p|tbl|tc|subList)\b[^>]*>|\{\{[^{}<>]+\}\}/g;
        for (const match of xml.matchAll(tokens)) {
            const token = match[0];
            if (token.startsWith('<!')) continue;
            const start = match.index;
            const end = start + token.length;
            if (token.startsWith('{{')) {
                this.model.markers.push({ text: token, start, end });
                continue;
            }
            const tag = /^<\/?(hp:\w+)/.exec(token)![1];
            if (token.startsWith('</')) {
                const open = stack.pop();
                if (!open || open.tag !== tag) continue;
                this.model.elements.push({ tag, start: open.start, end, xml: xml.slice(open.start, end) });
            } else if (token.endsWith('/>')) {
                this.model.elements.push({ tag, start, end, xml: token });
            } else {
                stack.push({ tag, start });
            }
        }
        this.model.elements.sort((a, b) => a.start - b.start);
        for (const element of this.model.elements) {
            const entries = this.byTag.get(element.tag) ?? [];
            entries.push(element);
            this.byTag.set(element.tag, entries);
        }
    }

    enclosingAll(tag: string, position: number): TemplateElement[] {
        return (this.byTag.get(tag) ?? []).filter(e => e.start <= position && position < e.end);
    }

    enclosing(tag: string, position: number): TemplateElement | null {
        return this.enclosingAll(tag, position).at(-1) ?? null;
    }

    elementAt(tag: string, start: number): TemplateElement | null {
        return (this.byTag.get(tag) ?? []).find(e => e.start === start) ?? null;
    }
}
