// Narrow TOML patcher. Understands exactly two shapes:
//   1. top-level string scalars (key = "value") before the first [header]
//   2. whole tables addressed by exact header name
// Everything else is passed through byte for byte. This is not a TOML
// round-tripper and must never claim to be one.

function eolOf(content) { return content.includes('\r\n') ? '\r\n' : '\n'; }
function toLines(content, eol) { return content.length ? content.split(eol) : []; }
function headerIndex(lines) {
  const i = lines.findIndex((l) => /^\s*\[/.test(l));
  return i === -1 ? lines.length : i;
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function keyRe(key) {
  return new RegExp(`^\\s*${escapeRe(key)}\\s*=\\s*"([^"]*)"`);
}
function tableBounds(lines, header) {
  const startRe = new RegExp(`^\\s*\\[\\s*${escapeRe(header)}\\s*\\]\\s*(#.*)?$`);
  const start = lines.findIndex((l) => startRe.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) { end = i; break; }
  }
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1;
  return { start, end };
}

export function getTopLevel(content, key) {
  const eol = eolOf(content);
  const lines = toLines(content, eol);
  const top = lines.slice(0, headerIndex(lines));
  for (const line of top) {
    const m = line.match(keyRe(key));
    if (m) return m[1];
  }
  return null;
}

export function setTopLevel(content, key, value) {
  const eol = eolOf(content);
  const lines = toLines(content, eol);
  const hi = headerIndex(lines);
  const re = keyRe(key);
  for (let i = 0; i < hi; i += 1) {
    if (re.test(lines[i])) {
      lines[i] = `${key} = "${value}"`;
      return lines.join(eol);
    }
  }
  // insert at end of top region, before separator blanks that precede the header
  let insertAt = hi;
  while (insertAt > 0 && lines[insertAt - 1].trim() === '') insertAt -= 1;
  lines.splice(insertAt, 0, `${key} = "${value}"`);
  let out = lines.join(eol);
  if (!out.endsWith(eol)) out += eol;
  return out;
}

export function deleteTopLevel(content, key) {
  const eol = eolOf(content);
  const lines = toLines(content, eol);
  const hi = headerIndex(lines);
  const re = keyRe(key);
  for (let i = 0; i < hi; i += 1) {
    if (re.test(lines[i])) { lines.splice(i, 1); return lines.join(eol); }
  }
  return content;
}

export function getTableText(content, header) {
  const eol = eolOf(content);
  const lines = toLines(content, eol);
  const b = tableBounds(lines, header);
  if (!b) return null;
  return lines.slice(b.start, b.end).join('\n'); // normalized \n for comparisons
}

export function setTable(content, header, bodyLines) {
  const eol = eolOf(content);
  const lines = toLines(content, eol);
  const table = [`[${header}]`, ...bodyLines];
  const b = tableBounds(lines, header);
  if (b) {
    lines.splice(b.start, b.end - b.start, ...table);
  } else {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    if (lines.length) lines.push('');
    lines.push(...table);
  }
  let out = lines.join(eol);
  if (!out.endsWith(eol)) out += eol;
  return out;
}

export function deleteTable(content, header) {
  const eol = eolOf(content);
  const lines = toLines(content, eol);
  const b = tableBounds(lines, header);
  if (!b) return content;
  let start = b.start;
  if (start > 0 && lines[start - 1].trim() === '') start -= 1;
  lines.splice(start, b.end - start);
  return lines.join(eol);
}
