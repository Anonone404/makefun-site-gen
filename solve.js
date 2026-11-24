// A faster drop-in for makefun-site 1.0.0: run(input) returns exactly what
// makefun-site's build returns for one site { site, templates, files }.
// Written from the reference's README and behavior (front matter, template
// dialect, Markdown subset, slug rule, report), reimplemented here in one
// pass: no token trees for Markdown, no per-character regex escaping, and
// cached slugs. Deterministic: the output is a function of the input alone.

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// ------------------------------------------------------------------ text

const ESC = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** `s` with & < > " ' escaped; the input itself when nothing needs it. */
function esc(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (i > start) out += s.slice(start, i);
      out += ESC[s[i]];
      start = i + 1;
    }
  }
  return out === '' ? s : out + s.slice(start);
}

const SLUG_MAX = 64;
const slugCache = new Map();

/** The slug of `text`, cached: NFKD, combining marks dropped, A-Z lowered,
 * every run of other characters one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), "untitled" when empty. */
function slugOf(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const out = slugOfSlow(text);
  if (slugCache.size < 32768) slugCache.set(text, out);
  return out;
}

function slugOfSlow(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) {
      ascii = false;
      break;
    }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = '';
    if (c >= 65 && c <= 90) keep = String.fromCharCode(c + 32);
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = plain[i];
    if (keep === '') {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** Whether char code `c` is JavaScript whitespace (\s). */
function isSpaceCode(c) {
  return (
    c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32 ||
    c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 ||
    c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279
  );
}

/** The words of body lines: runs of characters other than whitespace.
 * The whitespace test is inlined (no call per character). */
function wordsOfLines(lines) {
  let n = 0;
  for (const line of lines) {
    let inWord = false;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      const sp =
        c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32 ||
        c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 ||
        c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
      if (sp) inWord = false;
      else if (!inWord) {
        inWord = true;
        n++;
      }
    }
  }
  return n;
}

// ------------------------------------------------------------ front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isDigitCode(c) {
  return c >= 48 && c <= 57;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') {
      return { error: 'a quoted string is not closed' };
    }
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          const c = raw.charCodeAt(i);
          if (i === 4 || i === 7) {
            if (c !== 45) ok = false;
          } else if (!isDigitCode(c)) ok = false;
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true'
        ? { value: true }
        : raw === 'false'
          ? { value: false }
          : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64;
      let prevDash = true;
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        const alnum = (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
        if (c === 45) {
          if (prevDash) ok = false;
          prevDash = true;
        } else if (alnum) prevDash = false;
        else ok = false;
      }
      if (ok && prevDash) ok = false;
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether `line` holds only spaces and tabs. */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body lines: { data, bodyLines }, or { error }
 * with the first reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlankLine(line) || line[0] === '#') continue;
    // key: a run of [a-z_], then ':', then end or one space + value.
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if (!((c >= 97 && c <= 122) || c === 95)) break;
      k++;
    }
    if (k === 0 || line[k] !== ':') {
      return { error: `line ${i + 1} is not "key: value"` };
    }
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line[k + 1] === ' ') raw = line.slice(k + 2).replace(/[ \t]+$/, '');
    else return { error: `line ${i + 1} is not "key: value"` };
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyLines: lines.slice(close + 1) };
}

// --------------------------------------------------------------- Markdown

/** Spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** Whether `line` holds only spaces and tabs after position `from`. */
function onlySpacesTabs(line, from) {
  for (let i = from; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function isLangChar(c) {
  return (
    (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
    c === 95 || c === 43 || c === 45
  );
}

/** A fence-open line's language, or null. */
function fenceLang(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let i = 3;
  while (i < line.length && isLangChar(line.charCodeAt(i))) i++;
  if (!onlySpacesTabs(line, i)) return null;
  return line.slice(3, i);
}

/** Whether `line` closes a fence. */
function isFenceClose(line) {
  return line[0] === '`' && line[1] === '`' && line[2] === '`' && onlySpacesTabs(line, 3);
}

/** A heading line's depth and text, or null. */
function headingOf(line) {
  let hashes = 0;
  while (hashes < line.length && line[hashes] === '#') hashes++;
  if (hashes === 0 || hashes > 6) return null;
  const c = line.charCodeAt(hashes);
  if (c !== 32 && c !== 9) return null;
  let i = hashes;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  let end = line.length;
  while (end > i && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end === i) return null;
  return { depth: hashes, text: line.slice(i, end) };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  const head = line.slice(0, 3);
  if (head !== '---' && head !== '***') return false;
  return onlySpacesTabs(line, 3);
}

/** A bullet line's item text, or null. */
function bulletText(line) {
  if ((line[0] === '-' || line[0] === '*') && line[1] === ' ') return line.slice(2);
  return null;
}

/** An ordered-list line's start number and item text, or null. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && isDigitCode(line.charCodeAt(i))) i++;
  if (i === 0 || i > 9) return null;
  if (line[i] !== '.' || line[i + 1] !== ' ') return null;
  return { start: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** Whether `line` continues a list item (2+ spaces, then a non-space). */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i >= 2 && i < line.length && !isSpaceCode(line.charCodeAt(i));
}

/** Whether `line` ends a paragraph. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside an escape, or -1. */
function findUnescaped(s, what, from) {
  const wlen = what.length;
  for (let j = from; j <= s.length - wlen; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The characters inline rendering treats as special. */
const INLINE_SPECIALS = /[\\`*\[&<>"']/g;

/**
 * `s[a..b)` rendered inline, appended to `out`; `env.link(target)` is a
 * link's href. A regex finds the next special (the plain runs between are
 * slices, never re-scanned); specials are handled in place. The regex is
 * shared, so its position is saved and restored around recursion.
 */
function inlineRange(s, a, b, env, out) {
  const re = INLINE_SPECIALS;
  const saved = re.lastIndex;
  let run = a;
  re.lastIndex = a;
  let m;
  while ((m = re.exec(s)) !== null && m.index < b) {
    const j = m.index;
    const c = s[j];
    if (c === '\\') {
      const n = j + 1 < b ? s[j + 1] : '';
      if (n !== '' && ESCAPABLE.has(n)) {
        if (j > run) out.push(s.slice(run, j));
        out.push(n === '>' ? '&gt;' : n);
        run = j + 2;
        re.lastIndex = run;
        continue;
      }
      re.lastIndex = j + 1;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < b && k > j + 1) {
        if (j > run) out.push(s.slice(run, j));
        out.push('<code>', esc(s.slice(j + 1, k)), '</code>');
        run = k + 1;
        re.lastIndex = run;
        continue;
      }
      re.lastIndex = j + 1;
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k !== -1 && k < b && k > j + 2) {
          if (j > run) out.push(s.slice(run, j));
          out.push('<strong>');
          inlineRange(s, j + 2, k, env, out);
          out.push('</strong>');
          run = k + 2;
          re.lastIndex = run;
          continue;
        }
        re.lastIndex = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k !== -1 && k < b && k > j + 1) {
        if (j > run) out.push(s.slice(run, j));
        out.push('<em>');
        inlineRange(s, j + 1, k, env, out);
        out.push('</em>');
        run = k + 1;
        re.lastIndex = run;
        continue;
      }
      re.lastIndex = j + 1;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', j + 1);
      const p = k !== -1 && k < b && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = p === -1 || p >= b ? '' : s.slice(k + 2, p);
      if (target !== '' && !/\s/.test(target)) {
        if (j > run) out.push(s.slice(run, j));
        out.push('<a href="', esc(env.link(target)), '">');
        inlineRange(s, j + 1, k, env, out);
        out.push('</a>');
        run = p + 1;
        re.lastIndex = run;
        continue;
      }
      re.lastIndex = j + 1;
      continue;
    }
    if (j > run) out.push(s.slice(run, j));
    out.push(ESC[c]);
    run = j + 1;
    re.lastIndex = run;
  }
  if (b > run) out.push(s.slice(run, b));
  re.lastIndex = saved;
}

/** `s` rendered inline. */
function inlineStr(s, env) {
  const out = [];
  inlineRange(s, 0, s.length, env, out);
  return out.join('');
}

/**
 * Body lines rendered: HTML (each block followed by "\n"), table of
 * contents (level 2 and 3 headings) and excerpt (first paragraph's HTML).
 */
function renderMarkdown(lines, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < lines.length && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${esc(lang)}"`;
      const code = body.length === 0 ? '' : esc(`${body.join('\n')}\n`);
      blocks.push(`<pre><code${cls}>${code}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugOf(heading.text), ids);
      const html = inlineStr(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line[0] === '>') {
      const body = [];
      while (i < lines.length && lines[i][0] === '>') {
        const l = lines[i++];
        body.push(l[1] === ' ' ? l.slice(2) : l.slice(1));
      }
      const kept = body.map(trimLine).filter((l) => l !== '');
      blocks.push(
        kept.length === 0
          ? '<blockquote>\n</blockquote>'
          : `<blockquote>\n<p>${inlineStr(kept.join('\n'), env)}</p>\n</blockquote>`,
      );
      continue;
    }
    const bText = bulletText(line);
    const oFirst = bText === null ? orderedOf(line) : null;
    if (bText !== null || oFirst !== null) {
      const isOrdered = oFirst !== null;
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        if (isOrdered) {
          const m = orderedOf(l);
          if (m !== null) {
            items.push([trimLine(m.text)]);
            i++;
            continue;
          }
        } else {
          const t = bulletText(l);
          if (t !== null) {
            items.push([trimLine(t)]);
            i++;
            continue;
          }
        }
        if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && oFirst.start !== 1 ? `<ol start="${oFirst.start}">` : `<${tag}>`;
      blocks.push(
        `${open}\n${items.map((parts) => `<li>${inlineStr(parts.join('\n'), env)}</li>\n`).join('')}</${tag}>`,
      );
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inlineStr(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((x) => `${x}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// --------------------------------------------------------------- Templates

const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) {
    throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  }
  return text.split('.');
}

/** Whether `s[a..b)` holds only spaces and tabs. */
function onlySpacesTabsRange(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) {
        throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      }
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone =
      onlySpacesTabsRange(src, lineStart, open) && onlySpacesTabsRange(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) {
          throw new TemplateError(`template "${name}": an else outside an if`);
        }
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) {
    throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  }
  return root.body;
}

/** A value as text: string itself, a number in JavaScript's digits, true/false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** A value as escaped text (what {{ }} writes): as textOf, with strings escaped. */
function escText(v) {
  if (typeof v === 'string') return esc(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(escText).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// ------------------------------------------------------- template codegen
//
// A parsed template compiles once per build into a function
// (S, T, E, D, O, textOf, truthy, lk, gv) that appends to O. S is the scope
// stack (innermost last), T the compiled templates by name, E the escape,
// D the include depth. Compiling removes the per-node dispatch at render
// time; the helpers keep the reference's lookup semantics exactly.

/** First path segment from the nearest scope frame holding it. */
function lk(S, name) {
  for (let i = S.length - 1; i >= 0; i--) {
    if (Object.hasOwn(S[i], name)) return S[i][name];
  }
  return undefined;
}

/** One more path segment: an own property of an object value, else undefined. */
function gv(v, key) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, key) ? v[key] : undefined;
}

/** Generated lookup code for `path` (first segment via lk, the rest via gv). */
function lookupCode(path) {
  let code = `__lk(S, ${JSON.stringify(path[0])})`;
  for (let k = 1; k < path.length; k++) code = `__gv(${code}, ${JSON.stringify(path[k])})`;
  return code;
}

/** `nodes` compiled to a render function (returning its string). The
 * function builds one string with += and returns it: no output array, no
 * join, and includes return their string the same way. */
function compileTemplate(nodes) {
  const parts = ['let _s = \'\';'];
  const gen = (ns) => {
    for (const n of ns) {
      if (n.kind === 'text') parts.push(`_s += ${JSON.stringify(n.text)};`);
      else if (n.kind === 'var') parts.push(`_s += __et(${lookupCode(n.path)});`);
      else if (n.kind === 'raw') parts.push(`_s += __text(${lookupCode(n.path)});`);
      else if (n.kind === 'if') {
        parts.push(`if (__truthy(${lookupCode(n.path)}) !== ${n.not}) {`);
        gen(n.then);
        parts.push('}');
        if (n.else !== null) {
          parts.push('else {');
          gen(n.else);
          parts.push('}');
        }
      } else if (n.kind === 'for') {
        parts.push(
          `{ const __xs = ${lookupCode(n.path)}; if (Array.isArray(__xs)) { for (let __k = 0; __k < __xs.length; __k++) { S.push({ [${JSON.stringify(n.name)}]: __xs[__k], loop: { index: __k + 1, first: __k === 0, last: __k === __xs.length - 1, length: __xs.length } });`,
        );
        gen(n.body);
        parts.push('S.pop(); } } }');
      } else if (n.kind === 'include') {
        parts.push(
          `if (D < ${INCLUDE_DEPTH}) { const __f = T.get(${JSON.stringify(n.name)}); if (__f !== undefined) _s += __f(S, T, E, D + 1, __text, __truthy, __lk, __gv, __et); }`,
        );
      }
    }
  };
  gen(nodes);
  parts.push('return _s;');
  return new Function('S', 'T', 'E', 'D', '__text', '__truthy', '__lk', '__gv', '__et', parts.join('\n'));
}

// ------------------------------------------------------------------ build

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** A page's link record as templates read it. */
const linkOf = (s) =>
  s === null
    ? null
    : {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      };

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(s) {
  return {
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. Sources, in code-unit order of their paths, line ends made "\n".
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      b.sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    } else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter: refused sources and drafts are reported and dropped.
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyLines = fm.bodyLines;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;

  // 3. Permalinks: each page's directory, slug (unique in its directory) and url.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugOf(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }

  // 4. Markdown, each body's links resolved.
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) {
          return target;
        }
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.bodyLines, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = wordsOfLines(s.bodyLines);
  }

  // 5. Collections: posts newest first, then by slug; newer/older neighbours.
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags, grouped by slug, ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => !seen.has(slugOf(name)) && seen.add(slugOf(name)));
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugOf(name);
      if (!bySlug.has(slug)) {
        bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      }
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of b.sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map(
        (name) => bySlug.get(slugOf(name)) ?? { name, slug: slugOf(name), url: '', posts: [] },
      );
    }
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts: every page through its layout, index and tag pages.
  b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const compiled = new Map();
  for (const [name, nodes] of b.templates) compiled.set(name, compileTemplate(nodes));
  const render = (name, vars) => {
    const fn = compiled.get(name);
    if (fn === undefined) return null;
    return fn([{ site, tags: allTags, recent, ...vars }], compiled, esc, 0, textOf, truthy, lk, gv, escText);
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const tagObj = {
      name: t.name,
      slug: t.slug,
      url: t.url,
      count: t.posts.length,
      posts: t.posts.map((p) => b.cards.get(p)),
    };
    const html = render('tag', { tag: tagObj });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pageCount = b.sources.filter((s) => !s.post).length;
  lines.push(
    `built ${pageCount} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`,
  );
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;

  return b.output;
}
