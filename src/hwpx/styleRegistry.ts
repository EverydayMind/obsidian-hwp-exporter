import { XMLParser } from 'fast-xml-parser';
import { NS, escapeRegex, findMaxAttrValue } from './xmlText';
import type { StyleInfo, AlignValue } from '../types';

type ActiveFormats = Set<string>;

/** Owns header property definitions, derived styles, caches and id allocation. */
export class StyleRegistry {
    public dynamicStyleMap: Record<number, StyleInfo> = {};
    public normalStyleId = '0';
    public normalParaPrId = '1';
    private headerXmlObj: Record<string, unknown> = {};
    private maxCharPrId = 0;
    private maxParaPrId = 0;
    private maxNumberingId = 0;
    public tableBorderFillId = '1';
    private charPrCache: Map<string, number> = new Map();
    public readonly headerXmlRaw: string;
    private extraCharPrXml = '';
    private extraParaPrXml = '';
    private extraNumberingXml = '';
    private alignedParaPrCache: Map<string, string> = new Map();
    public inlineFormatStyle: Record<string, {
        textColor?: string;
        shadeColor?: string;
        fontRefXml?: string;
        bold?: boolean;
        italic?: boolean;
        strikeoutShape?: string;
        strikeoutColor?: string;
        underlineType?: string;
        underlineShape?: string;
        underlineColor?: string;
    }> = {};

    constructor(sourceXml: string) {
        this.headerXmlRaw = sourceXml;
        this.parseStylesAndInitXml(sourceXml);
    }

    get hasChanges(): boolean {
        return !!(this.extraCharPrXml || this.extraParaPrXml || this.extraNumberingXml);
    }

    private parseStylesAndInitXml(headerXml: string): void {
        try {
            const parser = new XMLParser({
                ignoreAttributes: false,
                attributeNamePrefix: '@_',
                isArray: (name) => ['charPr', 'paraPr', 'style', 'borderFill', 'numberings', 'paraHead'].includes(name),
            });
            this.headerXmlObj = parser.parse(headerXml) as Record<string, unknown>;

            // Find max charPr / paraPr IDs
            const charPrs = findAll(this.headerXmlObj, 'hh:charPr');
            for (const c of charPrs) {
                const id = parseInt(attrText(c, '@_id', '0'), 10);
                if (id > this.maxCharPrId) this.maxCharPrId = id;
            }
            const paraPrs = findAll(this.headerXmlObj, 'hh:paraPr');
            for (const p of paraPrs) {
                const id = parseInt(attrText(p, '@_id', '0'), 10);
                if (id > this.maxParaPrId) this.maxParaPrId = id;
            }

            // Use an existing borderFill as the fallback table border style.
            // New tables must not reference a borderFill id that is not present in header.xml.
            const borderFills = findAll(this.headerXmlObj, 'hh:borderFill');
            let maxBf = 0;
            let firstBf: string | null = null;
            for (const bf of borderFills) {
                const idText = attrText(bf, '@_id', '0');
                const id = parseInt(idText, 10);
                if (firstBf === null && idText) firstBf = idText;
                if (id > maxBf) maxBf = id;
            }
            this.tableBorderFillId = firstBf ?? (maxBf > 0 ? String(maxBf) : '1');

            // Find normal style (id=0)
            const styles = findAll(this.headerXmlObj, 'hh:style');
            let normalStyle = styles.find((s) => String(s['@_id']) === '0') ?? styles[0];
            if (normalStyle) {
                this.normalStyleId = attrText(normalStyle, '@_id', '0');
                this.normalParaPrId = attrText(normalStyle, '@_paraPrIDRef', '1');
            }

            // Map outline levels to styles
            const levelToParaPr: Record<number, string> = {};
            for (const pp of paraPrs) {
                const pId = attrText(pp, '@_id', '');
                const headings = findAll(pp, 'hh:heading');
                for (const h of headings) {
                    if (h['@_type'] === 'OUTLINE' && h['@_level'] !== undefined) {
                        const lvl = parseInt(attrText(h, '@_level', ''), 10);
                        if (!(lvl in levelToParaPr)) levelToParaPr[lvl] = pId;
                    }
                }
            }

            const paraPrToStyleInfo: Record<string, { style_id: string; char_pr_id: string }> = {};
            for (const s of styles) {
                const sId = attrText(s, '@_id', '');
                const pRef = attrText(s, '@_paraPrIDRef', '');
                const cRef = attrText(s, '@_charPrIDRef', '');
                if (pRef && !(pRef in paraPrToStyleInfo)) {
                    paraPrToStyleInfo[pRef] = { style_id: sId, char_pr_id: cRef };
                }
            }

            for (const [levelStr, pId] of Object.entries(levelToParaPr)) {
                const level = parseInt(levelStr, 10);
                if (pId in paraPrToStyleInfo) {
                    const info = paraPrToStyleInfo[pId];
                    this.dynamicStyleMap[level] = {
                        style_id: info.style_id,
                        para_pr_id: pId,
                        char_pr_id: info.char_pr_id,
                    };
                }
            }
        } catch (e) {
            console.error('[md2hwpx] Failed to parse header.xml:', e);
        }
    }

    // ============================================================
    // Placeholder style loading
    // ============================================================

    public extractHeaderParaPrXml(paraPrId: string): string | null {
        const xml = this.propertyXml('paraPr', paraPrId, this.headerXmlRaw + this.extraParaPrXml);
        return xml?.endsWith('/>') ? xml.slice(0, -2) + '></hh:paraPr>' : xml;
    }

    public readCharPrDelta(xml: string, bodyXml: string): typeof this.inlineFormatStyle[string] {
        const delta: typeof this.inlineFormatStyle[string] = {};
        const textColor = this.charPrAttrFromXml(xml, 'textColor');
        if (textColor && textColor !== 'none' && textColor !== this.charPrAttrFromXml(bodyXml, 'textColor')) {
            delta.textColor = textColor;
        }
        const shadeColor = this.charPrAttrFromXml(xml, 'shadeColor');
        if (shadeColor && shadeColor !== (this.charPrAttrFromXml(bodyXml, 'shadeColor') ?? 'none')) {
            delta.shadeColor = shadeColor;
        }
        const fontRef = xml.match(/<hh:fontRef\b[^>]*\/>/)?.[0];
        if (fontRef && fontRef !== bodyXml.match(/<hh:fontRef\b[^>]*\/>/)?.[0]) {
            delta.fontRefXml = fontRef;
        }
        if (/<hh:bold\b/.test(xml) && !/<hh:bold\b/.test(bodyXml)) delta.bold = true;
        if (/<hh:italic\b/.test(xml) && !/<hh:italic\b/.test(bodyXml)) delta.italic = true;

        const underline = xml.match(/<hh:underline\b[^>]*\/>/)?.[0] ?? '';
        const underlineType = underline.match(/type="([^"]+)"/)?.[1];
        if (underlineType && underlineType !== 'NONE' && underline !== bodyXml.match(/<hh:underline\b[^>]*\/>/)?.[0]) {
            delta.underlineType = underlineType;
            delta.underlineShape = underline.match(/shape="([^"]+)"/)?.[1] ?? 'SOLID';
            delta.underlineColor = underline.match(/color="([^"]+)"/)?.[1] ?? '#000000';
        }
        const strikeout = xml.match(/<hh:strikeout\b[^>]*\/>/)?.[0] ?? '';
        const strikeoutShape = strikeout.match(/shape="([^"]+)"/)?.[1];
        if (strikeoutShape && strikeoutShape !== 'NONE' && strikeout !== bodyXml.match(/<hh:strikeout\b[^>]*\/>/)?.[0]) {
            delta.strikeoutShape = strikeoutShape;
            delta.strikeoutColor = strikeout.match(/color="([^"]+)"/)?.[1] ?? '#000000';
        }
        return delta;
    }

    /** charPr for `formats` on top of `baseId`; reuses the base when the newest format adds nothing. */
    public getInlineFormatCharPrId(baseId: string, formats: ActiveFormats, format: string): string {
        const delta = this.inlineFormatStyle[format];
        if (!delta || Object.keys(delta).length === 0) return baseId;
        return this.getCharPrId(baseId, formats);
    }

    public charPrAttr(charPrId: string, name: string): string | null {
        const xml = this.extractCharPrXml(charPrId);
        return xml ? this.charPrAttrFromXml(xml, name) : null;
    }

    public charPrAttrFromXml(xml: string, name: string): string | null {
        const openTag = xml.match(/^<hh:charPr\b[^>]*?\/?>/)?.[0] ?? '';
        return openTag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null;
    }

    /** Deltas of the active formats, innermost-wins order (link/code last). */
    private activeFormatDeltas(formats: ActiveFormats): Array<typeof this.inlineFormatStyle[string]> {
        return INLINE_FORMAT_ORDER
            .filter((format) => formats.has(format) && this.inlineFormatStyle[format])
            .map((format) => this.inlineFormatStyle[format]);
    }

    public getCharPrId(baseId: string, formats: ActiveFormats): string {
        const key = `${baseId}|${[...formats].sort().join(',')}`;
        if (this.charPrCache.has(key)) {
            return String(this.charPrCache.get(key));
        }

        this.maxCharPrId++;
        const newId = this.maxCharPrId;
        this.charPrCache.set(key, newId);

        this.extraCharPrXml += this.buildDerivedCharPrXml(baseId, String(newId), formats);

        return String(newId);
    }

    private buildDerivedCharPrXml(baseId: string, newId: string, formats: ActiveFormats): string {
        const baseXml = this.extractCharPrXml(baseId);
        if (!baseXml) {
            return `<hh:charPr id="${newId}" xmlns:hh="${NS.hh}">${this.buildFormatCharPrXml('', formats)}</hh:charPr>`;
        }

        const selfClosingMatch = baseXml.match(/^<hh:charPr\b([^>]*)\/>$/);
        if (selfClosingMatch) {
            const attrs = this.applyTextColorOverride(this.rewriteCharPrAttributes(selfClosingMatch[1], newId), formats);
            return `<hh:charPr${attrs}>${this.buildFormatCharPrXml('', formats)}</hh:charPr>`;
        }

        const fullMatch = baseXml.match(/^<hh:charPr\b([^>]*)>([\s\S]*?)<\/hh:charPr>$/);
        if (!fullMatch) {
            return `<hh:charPr id="${newId}" xmlns:hh="${NS.hh}">${this.buildFormatCharPrXml('', formats)}</hh:charPr>`;
        }

        const attrs = this.applyTextColorOverride(this.rewriteCharPrAttributes(fullMatch[1], newId), formats);
        const innerXml = fullMatch[2] ?? '';
        return `<hh:charPr${attrs}>${this.applyFormatCharPrXml(innerXml, formats)}</hh:charPr>`;
    }

    public extractCharPrXml(charPrId: string): string | null {
        return this.propertyXml('charPr', charPrId, this.headerXmlRaw + this.extraCharPrXml);
    }

    private propertyXml(tag: string, id: string, source: string): string | null {
        // Match the opening tag before choosing the self-closing/full branch.
        // Otherwise a self-closing definition swallows the next full definition.
        const pattern = new RegExp(
            `<hh:${tag}\\b(?=[^>]*\\bid="${escapeRegex(id)}")[^>]*?(?:/>|>[\\s\\S]*?<\\/hh:${tag}>)`
        );
        return source.match(pattern)?.[0] ?? null;
    }

    /** Override the charPr's textColor/shadeColor attributes when an active inline format asks for it. */
    private applyTextColorOverride(attrs: string, formats: ActiveFormats): string {
        let result = attrs;
        for (const name of ['textColor', 'shadeColor'] as const) {
            let value: string | undefined;
            for (const delta of this.activeFormatDeltas(formats)) {
                value = delta[name] ?? value;
            }
            if (!value) continue;
            const pattern = new RegExp(`\\b${name}="[^"]*"`);
            result = pattern.test(result) ? result.replace(pattern, `${name}="${value}"`) : `${result} ${name}="${value}"`;
        }
        return result;
    }

    private rewriteCharPrAttributes(attrs: string, newId: string): string {
        let rewritten = attrs;
        if (/\bid="[^"]*"/.test(rewritten)) {
            rewritten = rewritten.replace(/\bid="[^"]*"/, `id="${newId}"`);
        } else {
            rewritten = ` id="${newId}"${rewritten}`;
        }
        if (!/\sxmlns:hh=/.test(rewritten)) {
            rewritten += ` xmlns:hh="${NS.hh}"`;
        }
        return rewritten;
    }

    private applyFormatCharPrXml(existingInnerXml: string, formats: ActiveFormats): string {
        let xml = existingInnerXml;
        let attrs = '';
        const deltas = this.activeFormatDeltas(formats);

        if ((formats.has('bold') || deltas.some((d) => d.bold)) && !/<hh:bold\b/.test(xml)) {
            attrs += '<hh:bold/>';
        }
        if ((formats.has('italic') || deltas.some((d) => d.italic)) && !/<hh:italic\b/.test(xml)) {
            attrs += '<hh:italic/>';
        }

        // Explicit ~~/<u> use their template look or a plain default; a
        // link/code delta that carries a decoration wins after that.
        let strikeoutTag: string | null = null;
        let underlineTag: string | null = null;
        let fontRefXml: string | null = null;
        if (formats.has('strikeout')) {
            const so = this.inlineFormatStyle['strikeout'];
            strikeoutTag = `<hh:strikeout shape="${so?.strikeoutShape ?? 'SOLID'}" color="${so?.strikeoutColor ?? '#000000'}"/>`;
        }
        if (formats.has('underline')) {
            const un = this.inlineFormatStyle['underline'];
            underlineTag = `<hh:underline type="${un?.underlineType ?? 'BOTTOM'}" shape="${un?.underlineShape ?? 'SOLID'}" color="${un?.underlineColor ?? '#000000'}"/>`;
        }
        for (const delta of deltas) {
            if (delta.strikeoutShape) {
                strikeoutTag = `<hh:strikeout shape="${delta.strikeoutShape}" color="${delta.strikeoutColor ?? '#000000'}"/>`;
            }
            if (delta.underlineType) {
                underlineTag = `<hh:underline type="${delta.underlineType}" shape="${delta.underlineShape ?? 'SOLID'}" color="${delta.underlineColor ?? '#000000'}"/>`;
            }
            fontRefXml = delta.fontRefXml ?? fontRefXml;
        }
        for (const [tag, pattern] of [
            [fontRefXml, /<hh:fontRef\b[^>]*\/>/],
            [strikeoutTag, /<hh:strikeout\b[^>]*\/>/],
            [underlineTag, /<hh:underline\b[^>]*\/>/],
        ] as const) {
            if (!tag) continue;
            if (pattern.test(xml)) {
                xml = xml.replace(pattern, tag);
            } else {
                attrs += tag;
            }
        }
        return xml + attrs;
    }

    private buildFormatCharPrXml(existingInnerXml: string, formats: ActiveFormats): string {
        return this.applyFormatCharPrXml(existingInnerXml, formats).slice(existingInnerXml.length);
    }

    // ============================================================
    // ParaPr helpers
    // ============================================================

    public getOrCreateIndentParaPr(leftIndent: number, baseParaPrId: string): string {
        const key = `indent_${baseParaPrId}_${leftIndent}`;
        if (this.alignedParaPrCache.has(key)) return this.alignedParaPrCache.get(key)!;

        this.maxParaPrId++;
        const newId = String(this.maxParaPrId);
        this.alignedParaPrCache.set(key, newId);

        const baseParaPrXml = this.extractHeaderParaPrXml(baseParaPrId);
        if (baseParaPrXml) {
            let cloned = baseParaPrXml.replace(
                /(<hh:paraPr\b[^>]*\bid=")[^"]+("[^>]*>)/,
                `$1${newId}$2`
            );
            let replacedLeftMargin = false;
            cloned = cloned.replace(
                /(<hc:left\b[^>]*\bvalue=")(-?\d+)(")/g,
                (_match, prefix: string, currentValue: string, suffix: string) => {
                    replacedLeftMargin = true;
                    return `${prefix}${Number(currentValue) + leftIndent}${suffix}`;
                }
            );
            if (!replacedLeftMargin) {
                cloned = cloned.replace(
                    '</hh:paraPr>',
                    `<hh:margin><hc:intent value="0" unit="HWPUNIT"/>` +
                    `<hc:left value="${leftIndent}" unit="HWPUNIT"/>` +
                    `<hc:right value="0" unit="HWPUNIT"/>` +
                    `<hc:prev value="0" unit="HWPUNIT"/>` +
                    `<hc:next value="0" unit="HWPUNIT"/></hh:margin></hh:paraPr>`
                );
            }
            this.extraParaPrXml += cloned;
        } else {
            this.extraParaPrXml += `<hh:paraPr id="${newId}" xmlns:hh="${NS.hh}" xmlns:hc="${NS.hc}">` +
                `<hh:margin><hc:intent value="0" unit="HWPUNIT"/>` +
                `<hc:left value="${leftIndent}" unit="HWPUNIT"/>` +
                `<hc:right value="0" unit="HWPUNIT"/>` +
                `<hc:prev value="0" unit="HWPUNIT"/>` +
                `<hc:next value="0" unit="HWPUNIT"/></hh:margin>` +
                `<hh:lineSpacing type="PERCENT" value="100" unit="HWPUNIT"/>` +
                `</hh:paraPr>`;
        }

        return newId;
    }

    /**
     * Clone a template paraPr with a different horizontal alignment. AlignDefault,
     * an already matching alignment, or a paraPr missing from the template keep
     * the template's paragraph shape unchanged.
     */
    public getOrCreateAlignedParaPr(baseParaPrId: string, align: AlignValue | undefined): string {
        const horizontal = align === 'AlignLeft' ? 'LEFT'
            : align === 'AlignCenter' ? 'CENTER'
                : align === 'AlignRight' ? 'RIGHT' : null;
        if (!horizontal) return baseParaPrId;

        const key = `align_${baseParaPrId}_${horizontal}`;
        const cached = this.alignedParaPrCache.get(key);
        if (cached) return cached;

        const baseParaPrXml = this.extractHeaderParaPrXml(baseParaPrId);
        if (!baseParaPrXml) return baseParaPrId;
        const current = baseParaPrXml.match(/<hh:align\b[^>]*\bhorizontal="([A-Z_]+)"/)?.[1];
        if (current === horizontal) return baseParaPrId;

        this.maxParaPrId++;
        const newId = String(this.maxParaPrId);
        let cloned = baseParaPrXml.replace(/(<hh:paraPr\b[^>]*\bid=")[^"]+("[^>]*>)/, `$1${newId}$2`);
        cloned = current
            ? cloned.replace(/(<hh:align\b[^>]*\bhorizontal=")[A-Z_]+(")/g, `$1${horizontal}$2`)
            : cloned.replace(/^(<hh:paraPr\b[^>]*>)/, `$1<hh:align horizontal="${horizontal}" vertical="BASELINE"/>`);
        this.extraParaPrXml += cloned;
        this.alignedParaPrCache.set(key, newId);
        return newId;
    }

    /**
     * Clone an auto-numbered paraPr (heading type NUMBER) onto a fresh copy of
     * its numbering definition whose level starts at `start`. Paragraphs that
     * share a numbering keep counting across the document in Hangul, so each
     * ordered list needs its own instance to restart. Anything that cannot be
     * resolved in the template keeps the original paraPr.
     */
    public getRestartedNumberingParaPr(paraPrId: string, start: number): string {
        const paraPrXml = this.extractHeaderParaPrXml(paraPrId);
        const heading = paraPrXml?.match(/<hh:heading\b[^>]*\btype="NUMBER"[^>]*\/?>/)?.[0];
        const numberingId = heading?.match(/\bidRef="(\d+)"/)?.[1];
        if (!paraPrXml || !heading || !numberingId) return paraPrId;
        const numberingXml = this.headerXmlRaw.match(new RegExp(
            `<hh:numbering\\b[^>]*\\bid="${numberingId}"[^>]*>[\\s\\S]*?<\\/hh:numbering>`
        ))?.[0];
        if (!numberingXml) return paraPrId;

        this.maxNumberingId = Math.max(
            this.maxNumberingId,
            findMaxAttrValue(this.headerXmlRaw, /<hh:numbering\b[^>]*\bid="(\d+)"/g)
        ) + 1;
        const newNumberingId = String(this.maxNumberingId);
        const headLevel = Number(heading.match(/\blevel="(\d+)"/)?.[1] ?? 0) + 1;
        const safeStart = Math.max(0, Math.floor(start));
        this.extraNumberingXml += numberingXml
            .replace(/^(<hh:numbering\b[^>]*\bid=")\d+(")/, `$1${newNumberingId}$2`)
            .replace(
                new RegExp(`(<hh:paraHead\\b(?=[^>]*\\blevel="${headLevel}")[^>]*\\bstart=")\\d+(")`),
                `$1${safeStart}$2`
            );

        this.maxParaPrId++;
        const newParaPrId = String(this.maxParaPrId);
        this.extraParaPrXml += paraPrXml
            .replace(/(<hh:paraPr\b[^>]*\bid=")[^"]+("[^>]*>)/, `$1${newParaPrId}$2`)
            .replace(heading, heading.replace(/\bidRef="\d+"/, `idRef="${newNumberingId}"`));
        return newParaPrId;
    }

    // ============================================================
    // XML building helpers
    // ============================================================

    public injectIntoHeaderXml(headerXml: string): string {
        let xml = headerXml;

        if (this.extraCharPrXml) {
            xml = this.injectIntoHeaderCollection(xml, 'hh:charPrs', this.extraCharPrXml, 'charPr') ??
                this.injectIntoHeaderCollection(xml, 'hh:charProperties', this.extraCharPrXml, 'charPr') ??
                xml;
        }

        if (this.extraParaPrXml) {
            xml = this.injectIntoHeaderCollection(xml, 'hh:paraPrs', this.extraParaPrXml, 'paraPr') ??
                this.injectIntoHeaderCollection(xml, 'hh:paraProperties', this.extraParaPrXml, 'paraPr') ??
                xml;
        }

        if (this.extraNumberingXml) {
            xml = this.injectIntoHeaderCollection(xml, 'hh:numberings', this.extraNumberingXml, 'numbering') ?? xml;
        }

        return xml;
    }

    private injectIntoHeaderCollection(
        xml: string,
        collectionTag: string,
        fragmentXml: string,
        itemTag: string
    ): string | null {
        const closeTag = `</${collectionTag}>`;
        const insertPos = xml.indexOf(closeTag);
        if (insertPos === -1) return null;

        let updated = xml.slice(0, insertPos) + fragmentXml + xml.slice(insertPos);
        const addedCount = (fragmentXml.match(new RegExp(`<hh:${itemTag}\\b`, 'g')) ?? []).length;
        if (addedCount > 0) {
            const openTagPattern = new RegExp(`(<${collectionTag}\\b[^>]*\\bitemCnt=")(\\d+)(")`);
            updated = updated.replace(openTagPattern, (_match, prefix: string, count: string, suffix: string) =>
                `${prefix}${Number(count) + addedCount}${suffix}`
            );
        }
        return updated;
    }
}

const INLINE_FORMAT_ORDER = ['bold', 'italic', 'underline', 'strikeout', 'highlight', 'link', 'code', 'math'];

/** Deep-search for all nodes matching a tag name in fast-xml-parser output */
/** A parsed attribute as text; fast-xml-parser gives strings (numbers if configured). */
function attrText(node: Record<string, unknown>, name: string, fallback: string): string {
    const value = node[name];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}

function findAll(obj: unknown, tagName: string): Record<string, unknown>[] {
    const results: Record<string, unknown>[] = [];
    if (!obj || typeof obj !== 'object') return results;
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        if (key === tagName) {
            if (Array.isArray(value)) results.push(...(value as Record<string, unknown>[]));
            else if (value && typeof value === 'object') results.push(value as Record<string, unknown>);
        } else {
            results.push(...findAll(value, tagName));
        }
    }
    return results;
}
