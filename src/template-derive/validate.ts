import { allElements, indexSection } from './dom';
import { NS, is, descendants, type Document } from './xml';
import { StyleError } from './limits';

export function assertSupportedSection(document: Document): void {
  const refs = new Map([...indexSection(document.documentElement!).elements].map(([ref, node]) => [node, ref]));
  const unsupported = (node: import('@xmldom/xmldom').Element, message: string): never => {
    let cursor: import('@xmldom/xmldom').Node | null = node;
    while (cursor?.nodeType === 1 && !refs.has(cursor as import('@xmldom/xmldom').Element)) cursor = cursor.parentNode;
    const ref = cursor ? refs.get(cursor as import('@xmldom/xmldom').Element) ?? 's0' : 's0';
    throw new StyleError('unsupported', `${message} At ${ref}.`, [ref]);
  };
  for (const node of allElements(document)) {
    if (node.namespaceURI && ![NS.para, NS.core, NS.section, 'http://www.hancom.co.kr/hwpml/2016/paragraph', 'http://www.hancom.co.kr/hwpml/2016/HwpUnitChar'].includes(node.namespaceURI)) unsupported(node, 'Unknown section element namespace.');
    if (node.namespaceURI !== NS.para) continue;
    if (['ole', 'container', 'shape', 'rect', 'line', 'ellipse', 'arc', 'polygon', 'curve', 'textart', 'equation', 'drawText', 'connectLine', 'video', 'chart', 'trackChange', 'trackChangeTag', 'autoToc', 'memo', 'masterPage'].includes(node.localName ?? '')) unsupported(node, `Unsupported element: ${node.localName}`);
    if (is(node, 'colPr', NS.para) && node.getAttribute('colCount') !== '1') unsupported(node, 'Multiple columns are not yet supported for derivation.');
    if (is(node, 'pic', NS.para) || is(node, 'tbl', NS.para)) {
      const pos = descendants(node, 'pos', NS.para)[0];
      if (pos?.getAttribute('treatAsChar') !== '1') unsupported(node, 'Floating table/image derivation unsupported.');
    }
    if (is(node, 'fieldBegin', NS.para) && node.getAttribute('type') === 'HYPERLINK') unsupported(node, 'External/field hyperlink derivation unsupported.');
  }
}
export function validateReferences(header: Document, section: Document): void {
  const maps = new Map<string, Set<string>>();
  for (const tag of ['charPr', 'paraPr', 'style', 'borderFill', 'numbering', 'bullet', 'tabPr']) {
    const ids = new Set<string>();
    for (const element of descendants(header, tag, NS.head)) { const id = element.getAttribute('id'); if (id === null || ids.has(id)) throw new StyleError('corrupted', 'Duplicate/missing definition ID.'); ids.add(id); }
    maps.set(tag, ids);
  }
  const referenceTypes: Record<string, string> = { charPrIDRef: 'charPr', paraPrIDRef: 'paraPr', styleIDRef: 'style', borderFillIDRef: 'borderFill', tabPrIDRef: 'tabPr' };
  for (const element of [...allElements(header), ...allElements(section)]) for (const attr of Array.from(element.attributes)) {
    const tag = referenceTypes[attr.localName ?? ''];
    // Hancom emits UINT32_MAX for a numbering/bullet head without a separate
    // character style. Preserve that sentinel only in its header definition.
    const parent = element.parentNode;
    if (tag === 'charPr' && attr.value === '4294967295' &&
        element.ownerDocument === header && is(element, 'paraHead', NS.head) &&
        parent?.nodeType === 1 && (is(parent as import('@xmldom/xmldom').Element, 'numbering', NS.head) || is(parent as import('@xmldom/xmldom').Element, 'bullet', NS.head))) continue;
    if (tag && !maps.get(tag)?.has(attr.value)) throw new StyleError('corrupted', `Unresolved ${tag} reference.`);
  }
  const ids = new Set<string>(), paragraphIds = new Set<string>();
  for (const element of allElements(section)) {
    if (!element.hasAttribute('id') || element.namespaceURI !== NS.para) continue;
    const id = element.getAttribute('id')!; if (!id || element.localName === 'subList' || element.localName === 'secPr') continue;
    const target = is(element, 'p', NS.para) ? paragraphIds : ids;
    if (target.has(id)) throw new StyleError('corrupted', 'Duplicate paragraph/object ID.'); target.add(id);
  }
  if (!descendants(section, 'secPr', NS.para).length) throw new StyleError('corrupted', 'Section properties missing.');
}
