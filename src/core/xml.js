// Minimal XML reader/writer (enough for Gating-ML and FlowJo-style documents).
// Works without a DOM, so it runs in Web Workers and Node.

export class XmlError extends Error {}

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENT[e] !== undefined ? ENT[e] : m;
  });
}

export function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function localName(name) {
  const i = name.indexOf(':');
  return i >= 0 ? name.slice(i + 1) : name;
}

/** Parse an XML string into {name, local, attrs, children, text}. */
export function parseXml(src) {
  let i = 0;
  const n = src.length;
  const root = { name: '#document', local: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      top().text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) top().text += decodeEntities(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end < 0) throw new XmlError('Unterminated comment');
      i = end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      if (end < 0) throw new XmlError('Unterminated CDATA section');
      top().text += src.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      if (end < 0) throw new XmlError('Unterminated processing instruction');
      i = end + 2;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      // DOCTYPE or similar; skip to the matching '>' (ignores internal subsets with brackets)
      let depth = 0;
      let j = lt + 2;
      for (; j < n; j++) {
        const c = src[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      i = j + 1;
      continue;
    }
    if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt);
      if (end < 0) throw new XmlError('Unterminated closing tag');
      const name = src.slice(lt + 2, end).trim();
      const cur = stack.pop();
      if (!cur || cur.name !== name) throw new XmlError(`Mismatched closing tag </${name}>`);
      i = end + 1;
      continue;
    }
    // Opening tag
    let j = lt + 1;
    while (j < n && !/[\s/>]/.test(src[j])) j++;
    const name = src.slice(lt + 1, j);
    const node = { name, local: localName(name), attrs: {}, children: [], text: '' };
    // attributes
    for (;;) {
      while (j < n && /\s/.test(src[j])) j++;
      if (j >= n) throw new XmlError('Unterminated tag');
      if (src[j] === '>') {
        top().children.push(node);
        stack.push(node);
        i = j + 1;
        break;
      }
      if (src[j] === '/' && src[j + 1] === '>') {
        top().children.push(node);
        i = j + 2;
        break;
      }
      let k = j;
      while (k < n && !/[\s=/>]/.test(src[k])) k++;
      const an = src.slice(j, k);
      while (k < n && /\s/.test(src[k])) k++;
      if (src[k] !== '=') {
        node.attrs[an] = '';
        j = k;
        continue;
      }
      k++;
      while (k < n && /\s/.test(src[k])) k++;
      const q = src[k];
      if (q !== '"' && q !== "'") throw new XmlError(`Attribute ${an} is not quoted`);
      const end = src.indexOf(q, k + 1);
      if (end < 0) throw new XmlError('Unterminated attribute value');
      node.attrs[an] = decodeEntities(src.slice(k + 1, end));
      j = end + 1;
    }
  }
  if (stack.length !== 1) throw new XmlError(`Unclosed element <${top().name}>`);
  return root;
}

/** Attribute by local name (ignores namespace prefixes). */
export function attr(node, local) {
  if (!node) return undefined;
  if (node.attrs[local] !== undefined) return node.attrs[local];
  for (const k of Object.keys(node.attrs)) if (localName(k) === local) return node.attrs[k];
  return undefined;
}

export function kids(node, local) {
  if (!node) return [];
  return local ? node.children.filter((c) => c.local === local) : node.children;
}

export function kid(node, local) {
  return kids(node, local)[0];
}

export function findAll(node, local, out = []) {
  for (const c of node.children) {
    if (c.local === local) out.push(c);
    findAll(c, local, out);
  }
  return out;
}
