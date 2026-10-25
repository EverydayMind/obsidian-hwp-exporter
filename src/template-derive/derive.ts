import type { Document, Element } from '@xmldom/xmldom';
import { parseProfileNote } from './profile';
import { derivationDigest, validateStyleJson } from './schema';
import { byteDigest } from './digest';
import { Guard, StyleError } from './limits';
import { readBoundedZip } from './boundedZip';
import { children, descendants, first, is, NS, parseXml } from './xml';
import { allElements, ancestor, canonicalPrefixes, indexSection, serialize } from './dom';
import { collectAssets, newPackageManifest, packageBytes, sanitizeHeader } from './sanitizePackage';
import { markerInventory, payloadDigest, readProvenance, writeProvenance } from './provenance';
import { assertSupportedSection, validateReferences } from './validate';
import { inspectTemplateXml } from '../templateInspector';

export const DERIVATION_MARKERS = ['BODY', ...Array.from({ length: 9 }, (_, index) => `H${index + 1}`), 'CAPTION', 'FOOTNOTE', 'CELL_BODY', ...['HEADER', 'TOP', 'MIDDLE', 'BOTTOM'].flatMap(row => ['LEFT', 'CENTER', 'RIGHT'].map(column => `CELL_${row}_${column}`))];
export function validDerivationMarker(marker: string): boolean { return ![...marker].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) && (DERIVATION_MARKERS.includes(marker) || /^[^A-Za-z{}<>\r\n][^{}<>\r\n]{0,15}$/.test(marker)); }
export function ownText(paragraph: Element): string { return allElements(paragraph).filter(node => is(node, 't', NS.para) && ancestor(node, 'p') === paragraph).map(node => node.textContent ?? '').join(''); }
function replaceText(paragraph: Element, value: string) {
  const leaves = allElements(paragraph).filter(node => is(node, 't', NS.para) && ancestor(node, 'p') === paragraph);
  if (!leaves.length) throw new StyleError('unsupported', 'Selected paragraph has no text leaf.');
  for (const leaf of leaves) while (leaf.firstChild) leaf.removeChild(leaf.firstChild);
  leaves[0].appendChild(paragraph.ownerDocument!.createTextNode(value));
}
function make(document: Document, tag: string, attrs: Record<string, string | number> = {}, content: Element[] = []): Element {
  const node = document.createElementNS(NS.para, `hp:${tag}`); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value)); for (const child of content) node.appendChild(child); return node;
}
function cleanParagraphAttributes(paragraph: Element): void {
  const paragraphAttributes = new Set(['id', 'paraPrIDRef', 'styleIDRef', 'pageBreak', 'columnBreak', 'merged']);
  for (const attribute of Array.from(paragraph.attributes)) if (!paragraphAttributes.has(attribute.name)) paragraph.removeAttributeNode(attribute);
}
function cleanParagraph(document: Document, source: Element, marker = ''): Element {
  const p = document.importNode<Element>(source, false);
  cleanParagraphAttributes(p);
  const run = children(source).find(node => is(node, 'run', NS.para)), char = run?.getAttribute('charPrIDRef');
  const r = make(document, 'run', char !== null && char !== undefined ? { charPrIDRef: char } : {}), t = make(document, 't');
  t.appendChild(document.createTextNode(marker)); r.appendChild(t); p.appendChild(r); return p;
}
function ruleTable(document: Document, source: Element, marker: string, width: number, borderFill: string): Element {
  const sourceTable = ancestor(source, 'tbl');
  if (sourceTable) {
    if (descendants(sourceTable, 'tbl', NS.para).length) throw new StyleError('unsupported', 'Nested rule-table derivation unsupported.');
    const wrapper = ancestor(sourceTable, 'p'); if (!wrapper) throw new StyleError('corrupted', 'Table wrapper missing.');
    const output = document.importNode<Element>(wrapper, true), originalParagraphs = descendants(wrapper, 'p', NS.para), copiedParagraphs = descendants(output, 'p', NS.para);
    // Eliminate every original paragraph body in this rule table; geometry and
    // cell styles remain. The selected paragraph alone receives the marker.
    for (const [index, p] of copiedParagraphs.entries()) p.parentNode!.replaceChild(cleanParagraph(document, originalParagraphs[index], originalParagraphs[index] === source ? `{{${marker}}}` : ''), p);
    const copiedTable = descendants(output, 'tbl', NS.para)[0];
    if (!copiedTable) throw new StyleError('corrupted', 'Rule table disappeared.');
    copiedTable.parentNode!.removeChild(copiedTable);
    while (output.firstChild) output.removeChild(output.firstChild);
    const originalRun = children(wrapper).find(node => is(node, 'run', NS.para));
    const wrapperRun = originalRun ? document.importNode<Element>(originalRun, false) : make(document, 'run');
    wrapperRun.appendChild(copiedTable); output.appendChild(wrapperRun);
    return output;
  }
  const p = cleanParagraph(document, source, `{{${marker}}}`), cell = make(document, 'tc', { name: '', header: 0, hasMargin: 1, protect: 0, editable: 0, dirty: 0, borderFillIDRef: borderFill }, [
    make(document, 'subList', { id: '', textDirection: 'HORIZONTAL', lineWrap: 'BREAK', vertAlign: 'TOP', linkListIDRef: 0, linkListNextIDRef: 0, textWidth: 0, textHeight: 0, hasTextRef: 0, hasNumRef: 0 }, [p]),
    make(document, 'cellAddr', { colAddr: 0, rowAddr: 0 }), make(document, 'cellSpan', { colSpan: 1, rowSpan: 1 }), make(document, 'cellSz', { width, height: 1000 }), make(document, 'cellMargin', { left: 0, right: 0, top: 0, bottom: 0 }),
  ]);
  const table = make(document, 'tbl', { id: 0, zOrder: 0, numberingType: 'TABLE', textWrap: 'TOP_AND_BOTTOM', textFlow: 'BOTH_SIDES', lock: 0, dropcapstyle: 'None', pageBreak: 'CELL', repeatHeader: 0, rowCnt: 1, colCnt: 1, cellSpacing: 0, borderFillIDRef: borderFill, noAdjust: 0 }, [
    make(document, 'sz', { width, widthRelTo: 'ABSOLUTE', height: 1000, heightRelTo: 'ABSOLUTE', protect: 0 }), make(document, 'pos', { treatAsChar: 1, affectLSpacing: 0, flowWithText: 1, allowOverlap: 0, holdAnchorAndSO: 0, vertRelTo: 'PARA', horzRelTo: 'COLUMN', vertAlign: 'TOP', horzAlign: 'LEFT', vertOffset: 0, horzOffset: 0 }), make(document, 'outMargin', { left: 0, right: 0, top: 0, bottom: 0 }), make(document, 'inMargin', { left: 0, right: 0, top: 0, bottom: 0 }), make(document, 'tr', {}, [cell]),
  ]);
  const wrapper = cleanParagraph(document, source); wrapper.firstChild!.appendChild(table); return wrapper;
}

export async function deriveTemplate(input: { sampleBytes: Uint8Array; profileBytes: Uint8Array; expectedSampleSha256: string; expectedProfileSha256: string; signal?: AbortSignal }): Promise<{ bytes: Uint8Array; report: Record<string, unknown> }> {
  const guard = new Guard(input.signal); guard.check();
  if (byteDigest(input.sampleBytes) !== input.expectedSampleSha256 || byteDigest(input.profileBytes) !== input.expectedProfileSha256) throw new StyleError('source_changed', 'Sample/profile hash mismatch.');
  const { machine } = await parseProfileNote(new TextDecoder('utf-8', { fatal: true }).decode(input.profileBytes));
  if (machine.snapshot.source.format !== 'hwpx' || machine.snapshot.source.sha256 !== input.expectedSampleSha256) throw new StyleError('unsupported', 'Derivation requires a profile measured from this HWPX copy.');
  if (!machine.bindings.some(binding => binding.marker === 'BODY') || machine.bindings.some(binding => !validDerivationMarker(binding.marker)) || new Set(machine.bindings.map(binding => binding.marker)).size !== machine.bindings.length) throw new StyleError('unsupported', 'Unique supported markers including BODY required.');
  const zip = await readBoundedZip(input.sampleBytes, guard);
  if ([...zip.keys()].filter(name => /^Contents\/section\d+\.xml$/.test(name)).length !== 1 || machine.snapshot.sections.length !== 1) throw new StyleError('unsupported', 'Only single-section derivation is supported.');
  const read = async (name: string) => { const bytes = zip.get(name); if (!bytes) throw new StyleError('corrupted', 'Missing HWPX package member.'); return canonicalPrefixes(await parseXml(bytes, guard)); };
  const header = await read('Contents/header.xml'), source = await read('Contents/section0.xml'), sourcePackage = await read('Contents/content.hpf');
  if (!is(header.documentElement!, 'head', NS.head) || !is(source.documentElement!, 'sec', NS.section)) throw new StyleError('corrupted', 'Invalid semantic document root.');
  assertSupportedSection(source);
  const indexed = indexSection(source.documentElement!);
  if (JSON.stringify(indexed.nodes) !== JSON.stringify(machine.snapshot.nodes)) throw new StyleError('source_changed', 'Profile/source structure mismatch.');
  const section = canonicalPrefixes(source), root = section.documentElement!;
  while (root.firstChild) root.removeChild(root.firstChild);
  const firstParagraph = children(source.documentElement!).find(node => is(node, 'p', NS.para)), sectionProperties = first(source.documentElement!, 'secPr', NS.para);
  if (!firstParagraph || !sectionProperties) throw new StyleError('corrupted', 'First paragraph/section properties missing.');
  const body = machine.bindings.find(binding => binding.marker === 'BODY')!, bodyParagraph = indexed.elements.get(body.representativeRef)!;
  const firstOutput = cleanParagraph(section, bodyParagraph), firstRun = firstOutput.firstChild!;
  firstRun.insertBefore(section.importNode(sectionProperties, true), firstRun.firstChild);
  const columns = first(source.documentElement!, 'colPr', NS.para); if (columns) firstRun.appendChild(make(section, 'ctrl', {}, [section.importNode<Element>(columns, true)]));
  root.appendChild(firstOutput);
  const fixed = (position: string) => machine.fixedRegions.filter(region => region.position === position).map(region => {
    const original = indexed.elements.get(region.ref); if (!original) throw new StyleError('corrupted', 'Fixed region missing.');
    const clone = section.importNode<Element>(original, true), paragraphs = [original, ...descendants(original, 'p', NS.para)].filter(node => is(node, 'p', NS.para)), clonedParagraphs = [clone, ...descendants(clone, 'p', NS.para)].filter(node => is(node, 'p', NS.para));
    for (const replacement of region.replacements) { const index = paragraphs.indexOf(indexed.elements.get(replacement.paragraphRef)!); if (index < 0) throw new StyleError('corrupted', 'Meta replacement outside fixed region.'); replaceText(clonedParagraphs[index], `{{META:${replacement.metaKey}}}`); }
    for (const secPr of descendants(clone, 'secPr', NS.para)) secPr.parentNode!.removeChild(secPr);
    return clone;
  });
  for (const node of fixed('before_content')) root.appendChild(node);
  const page = first(source, 'pagePr', NS.para), margin = first(page, 'margin', NS.para), width = Number(page?.getAttribute('width')) - Number(margin?.getAttribute('left')) - Number(margin?.getAttribute('right')) - Number(margin?.getAttribute('gutter'));
  if (!Number.isFinite(width) || width <= 0) throw new StyleError('unsupported', 'Measured positive page content width required.');
  const borderFill = descendants(header, 'borderFill', NS.head)[0]?.getAttribute('id'); if (!borderFill) throw new StyleError('unsupported', 'Source border definition required.');
  for (const binding of machine.bindings) { await guard.tick(); root.appendChild(ruleTable(section, indexed.elements.get(binding.representativeRef)!, binding.marker, width, borderFill)); }
  root.appendChild(cleanParagraph(section, bodyParagraph, '{{CONTENT}}'));
  for (const node of fixed('after_content')) root.appendChild(node);
  // One monotonically allocated paragraph/object ID space, plus exact field
  // pairing. XML cache segments are removed after every textual change.
  let id = 1; const fieldIds = new Map<string, string>();
  for (const node of allElements(section)) if (is(node, 'fieldBegin', NS.para)) { const old = node.getAttribute('id'); if (!old || fieldIds.has(old)) throw new StyleError('unsupported', 'Ambiguous field IDs.'); fieldIds.set(old, String(id++)); }
  for (const node of allElements(section).reverse()) {
    if (is(node, 'p', NS.para)) cleanParagraphAttributes(node);
    if (is(node, 'linesegarray', NS.para)) { node.parentNode!.removeChild(node); continue; }
    if (is(node, 'fieldBegin', NS.para)) { const fresh = fieldIds.get(node.getAttribute('id')!)!; node.setAttribute('id', fresh); node.setAttribute('fieldid', fresh); }
    else if (is(node, 'fieldEnd', NS.para)) { const fresh = fieldIds.get(node.getAttribute('beginIDRef') ?? ''); if (!fresh) throw new StyleError('corrupted', 'Unpaired field end.'); node.setAttribute('beginIDRef', fresh); node.setAttribute('fieldid', fresh); }
    else if (node.namespaceURI === NS.para && (is(node, 'p', NS.para) || node.hasAttribute('id') && !['subList', 'secPr', 'colPr'].includes(node.localName ?? ''))) { const fresh = String(id++); node.setAttribute('id', fresh); if (node.hasAttribute('instid')) node.setAttribute('instid', fresh); if (node.hasAttribute('instId')) node.setAttribute('instId', fresh); }
  }
  sanitizeHeader(header, section); validateReferences(header, section);
  const assets = collectAssets(section, sourcePackage, zip), manifest = newPackageManifest(assets);
  const inventory = markerInventory(descendants(section, 'p', NS.para).map(ownText));
  writeProvenance(manifest, machine.snapshot.source.sha256, await derivationDigest(machine), inventory, payloadDigest(header, section, manifest, assets));
  const inspection = inspectTemplateXml(serialize(header), serialize(section));
  if (inspection.unknownMarkers.length || !inspection.markers.some(marker => marker.marker === '{{BODY}}')) throw new StyleError('unsupported', 'Exporter could not recognize the derived rules.');
  guard.check(); const bytes = await packageBytes(header, section, manifest, assets); guard.check();
  const report = await getDerivationReport(bytes, byteDigest(bytes), input.signal);
  return { bytes, report };
}

export async function getDerivationReport(bytes: Uint8Array, expectedSha256: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (byteDigest(bytes) !== expectedSha256) throw new StyleError('source_changed', 'Derived file hash changed.');
  const guard = new Guard(signal), zip = await readBoundedZip(bytes, guard);
  const read = async (name: string) => { const data = zip.get(name); if (!data) throw new StyleError('corrupted', 'Derived package member missing.'); return parseXml(data, guard); };
  const section = await read('Contents/section0.xml'), manifest = await read('Contents/content.hpf'), header = await read('Contents/header.xml');
  assertSupportedSection(section); validateReferences(header, section);
  const indexed = indexSection(section.documentElement!), inventory = markerInventory(descendants(section, 'p', NS.para).map(ownText));
  const assets = collectAssets(section, manifest, zip), provenance = readProvenance(manifest, inventory, payloadDigest(header, section, manifest, assets));
  const allowed = new Set(['mimetype', 'version.xml', 'META-INF/container.xml', 'META-INF/manifest.xml', 'Contents/header.xml', 'Contents/section0.xml', 'Contents/content.hpf', ...assets.map(asset => asset.path)]);
  if ([...zip.keys()].some(path => !path.endsWith('/') && !allowed.has(path))) provenance.provenance = { state: 'unverified', reason: 'Package has additional members outside the derived resource graph.' };
  if (new TextDecoder().decode(zip.get('mimetype')) !== 'application/hwp+zip') throw new StyleError('corrupted', 'Invalid HWPX mimetype.');

  const fixedTexts = [...indexed.elements].filter(([, element]) => is(element, 'p', NS.para)).map(([ref, element]) => ({ ref, text: ownText(element) })).filter(item => item.text && !item.text.includes('{{'));
  const normalizedHeader = canonicalPrefixes(header), normalizedSection = canonicalPrefixes(section);
  const inspection = inspectTemplateXml(serialize(normalizedHeader), serialize(normalizedSection));
  const missingRoles = DERIVATION_MARKERS.filter(marker => !inventory.some(item => item.marker === marker));
  return validateStyleJson<Record<string, unknown>>('report', { missingRoles, fallbacks: inspection.fallbacks, schema: 'report-style-derivation-report/1', outputHash: expectedSha256, ...provenance, markerInventory: inventory, fixedTexts, assets: assets.map(({ path, sha256 }) => ({ path, sha256 })), unsupported: [], layout: { state: 'not_measured' } });
}
