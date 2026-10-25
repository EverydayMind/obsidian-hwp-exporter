import { Guard, StyleError } from './limits';

/** Bound lexical nodes (including attributes) before allocating a DOM tree.
 * Comments, CDATA, processing instructions and quoted '>' never become tags.
 * Strict namespace/well-formedness validation still belongs to xmldom. */
export async function preflightXml(text: string, guard: Guard): Promise<void> {
  let offset = 0, depth = 0;
  guard.xmlNode(0);
  const malformed = (): never => { throw new StyleError('corrupted', 'Malformed XML boundary.'); };
  while (offset < text.length) {
    await guard.tick();
    if (text[offset] !== '<') {
      const next = text.indexOf('<', offset);
      if ((next < 0 ? text.length : next) > offset) guard.xmlNode(depth + 1);
      offset = next < 0 ? text.length : next;
      continue;
    }
    let terminator = '', prefix = 0;
    if (text.startsWith('<!--', offset)) { terminator = '-->'; prefix = 4; }
    else if (text.startsWith('<![CDATA[', offset)) { terminator = ']]>'; prefix = 9; }
    else if (text.startsWith('<?', offset)) { terminator = '?>'; prefix = 2; }
    if (terminator) {
      const end = text.indexOf(terminator, offset + prefix);
      if (end < 0) malformed();
      guard.xmlNode(depth + 1);
      offset = end + terminator.length;
      continue;
    }
    if (text.startsWith('<!', offset)) throw new StyleError('unsupported', 'XML declarations/DTD are unsupported.');
    const closing = text[offset + 1] === '/';
    if (closing) {
      const end = text.indexOf('>', offset + 2);
      if (end < 0 || --depth < 0) malformed();
      offset = end + 1;
      continue;
    }
    const elementDepth = depth + 1;
    guard.xmlNode(elementDepth);
    let quote = '', end = offset + 1;
    for (; end < text.length; end++) {
      if (end % 8192 === 0) await guard.tick();
      const character = text[end];
      if (quote) { if (character === quote) quote = ''; continue; }
      if (character === '"' || character === "'") quote = character;
      else if (character === '=') guard.xmlNode(elementDepth);
      else if (character === '>') break;
    }
    if (end === text.length || quote) malformed();
    let tail = end - 1;
    while (tail > offset && /[ \t\r\n]/.test(text[tail])) tail--;
    if (text[tail] !== '/') depth++;
    offset = end + 1;
  }
  if (depth !== 0) malformed();
  guard.check();
}
