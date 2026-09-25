// Word (.docx) support, run entirely in the browser: the uploaded file never
// leaves the page. Only paragraph text is sent to the Worker for checking.
//
// readDocx() unzips the file and lists the paragraphs of word/document.xml.
// buildTrackedDocx() writes accepted rewrites back into the same document as
// Word tracked changes (w:del / w:ins), so reviewers can accept or reject each
// one in Word. Everything outside the changed paragraphs is copied byte for byte.
//
// Also imported by the Node tests, so it only uses web-standard APIs.

const DOCUMENT_PART = "word/document.xml";
const MAX_DIFF_CELLS = 1_000_000;

export class DocxError extends Error {}

/** Parse a .docx (Blob, ArrayBuffer or Uint8Array). */
export async function readDocx(input) {
  const bytes = await toBytes(input);
  const entries = readZip(bytes);
  const part = entries.find((e) => e.name === DOCUMENT_PART);
  if (!part) throw new DocxError("That file has no document body. Save it as a Word Document (.docx) and try again.");
  const xml = new TextDecoder().decode(await inflate(part));
  return { entries, xml, paragraphs: scanParagraphs(xml) };
}

/**
 * Turn per-clause decisions into new paragraph texts.
 * clauses: [{ block, text, final }] where block is the paragraph index.
 * Returns { edits: [{ index, text }], unmapped: [paragraph index] }.
 */
export function paragraphEdits(paragraphTexts, clauses) {
  const byBlock = new Map();
  for (const c of clauses) {
    if (c.block === undefined) continue;
    if (!byBlock.has(c.block)) byBlock.set(c.block, []);
    byBlock.get(c.block).push(c);
  }

  const edits = [];
  const unmapped = [];
  for (const [index, group] of byBlock) {
    if (group.every((c) => c.final === c.text)) continue;
    // Clause text is the paragraph text with whitespace collapsed, so it can be
    // found in the collapsed paragraph and swapped for the new wording.
    const base = String(paragraphTexts[index] ?? "").replace(/\s+/g, " ");
    let out = "";
    let cursor = 0;
    let ok = true;
    for (const c of group) {
      const at = base.indexOf(c.text, cursor);
      if (at < 0) {
        ok = false;
        break;
      }
      const replacement = c.final === c.text ? c.text : c.final.replace(/\s+/g, " ").trim();
      out += base.slice(cursor, at) + replacement;
      cursor = at + c.text.length;
    }
    if (ok) edits.push({ index, text: out + base.slice(cursor) });
    else unmapped.push(index);
  }
  return { edits, unmapped };
}

/**
 * Apply edits as tracked changes and return { blob, skipped }.
 * skipped lists paragraph indexes that hold content SpecCheck doesn't rewrite
 * safely (fields, hyperlinks, images, existing tracked changes...).
 */
export async function buildTrackedDocx(doc, edits, { author = "SpecCheck", date = new Date() } = {}) {
  const { xml, skipped } = redlineXml(doc.xml, doc.paragraphs, edits, { author, date });
  const data = new TextEncoder().encode(xml);
  const entries = doc.entries.map((e) =>
    e.name === DOCUMENT_PART ? { ...e, usize: data.length, crc: crc32(data), pending: data } : e,
  );
  for (const e of entries) {
    if (e.pending) {
      e.data = await deflate(e.pending);
      e.csize = e.data.length;
      e.method = 8;
      delete e.pending;
    }
  }
  const blob = new Blob([writeZip(entries)], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  return { blob, skipped };
}

// ---------------------------------------------------------------------------
// Tracked changes

export function redlineXml(xml, paragraphs, edits, { author, date }) {
  const attrs = revisionAttrs(xml, author, date);
  const skipped = [];
  // Work from the end so earlier offsets stay valid.
  const ordered = [...edits].sort((a, b) => paragraphs[b.index].start - paragraphs[a.index].start);
  for (const { index, text } of ordered) {
    const p = paragraphs[index];
    const parsed = p.nested ? null : parseSimpleParagraph(xml.slice(p.start, p.end));
    if (!parsed || parsed.chars.map((c) => c.ch).join("") !== p.text) {
      skipped.push(index);
      continue;
    }
    xml = xml.slice(0, p.start) + rebuildParagraph(parsed, text, attrs) + xml.slice(p.end);
  }
  return { xml, skipped: skipped.sort((a, b) => a - b) };
}

function revisionAttrs(xml, author, date) {
  let next = 0;
  for (const m of xml.matchAll(/\bw:id="(\d+)"/g)) next = Math.max(next, Number(m[1]));
  const stamp = date.toISOString().replace(/\.\d{3}Z$/, "Z");
  return () => `w:id="${++next}" w:author="${escapeXml(author)}" w:date="${stamp}"`;
}

function rebuildParagraph(p, newText, attrs) {
  let out = p.open + p.pPr + p.bookmarkStarts.join("");
  for (const seg of diffSegments(p.chars.map((c) => c.ch).join(""), newText)) {
    if (seg.type === "eq") {
      out += runsXml(p.chars, seg.from, seg.to, false);
      continue;
    }
    if (seg.to > seg.from) out += `<w:del ${attrs()}>${runsXml(p.chars, seg.from, seg.to, true)}</w:del>`;
    if (seg.ins) {
      const rPr = (p.chars[seg.from - 1] ?? p.chars[seg.from])?.rPr ?? "";
      out += `<w:ins ${attrs()}><w:r>${rPr}${textXml(seg.ins, "w:t")}</w:r></w:ins>`;
    }
  }
  return out + p.bookmarkEnds.join("") + "</w:p>";
}

// Original characters [from, to) as runs, keeping each run's formatting.
function runsXml(chars, from, to, deleted) {
  let out = "";
  let i = from;
  while (i < to) {
    const rPr = chars[i].rPr;
    let text = "";
    while (i < to && chars[i].rPr === rPr) text += chars[i++].ch;
    out += `<w:r>${rPr}${textXml(text, deleted ? "w:delText" : "w:t")}</w:r>`;
  }
  return out;
}

function textXml(text, tag) {
  return text
    .split(/(\t)/)
    .filter((s) => s !== "")
    .map((s) => (s === "\t" ? "<w:tab/>" : `<${tag} xml:space="preserve">${escapeXml(s)}</${tag}>`))
    .join("");
}

/**
 * Word-level diff of old -> new as segments over the old text:
 *   { type: "eq", from, to } or { type: "chg", from, to, ins }.
 * Whitespace tokens always match each other, so the original spacing and tabs
 * are kept, and a lone space between two changes is folded into one change.
 */
export function diffSegments(oldText, newText) {
  const a = wordTokens(oldText);
  const b = wordTokens(newText);
  const same = (x, y) => (x.ws && y.ws) || x.t === y.t;

  const ops = [];
  if (a.length * b.length > MAX_DIFF_CELLS) {
    a.forEach((t) => ops.push({ op: "del", t }));
    b.forEach((t) => ops.push({ op: "ins", t }));
  } else {
    const w = b.length + 1;
    const dp = new Uint32Array((a.length + 1) * w);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        dp[i * w + j] = same(a[i], b[j]) ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && same(a[i], b[j])) {
        ops.push({ op: "eq", t: a[i++] });
        j++;
      } else if (j >= b.length || (i < a.length && dp[(i + 1) * w + j] >= dp[i * w + j + 1])) {
        ops.push({ op: "del", t: a[i++] });
      } else {
        ops.push({ op: "ins", t: b[j++] });
      }
    }
  }

  const segs = [];
  let pos = 0;
  for (const { op, t } of ops) {
    const type = op === "eq" ? "eq" : "chg";
    let last = segs.at(-1);
    if (!last || last.type !== type) {
      last = { type, from: pos, to: pos, ins: "", ws: true };
      segs.push(last);
    }
    if (op === "ins") {
      last.ins += t.t;
    } else {
      last.to = t.e;
      pos = t.e;
      last.ws &&= t.ws;
    }
  }

  // Fold whitespace-only matches that sit between two changes.
  const merged = [];
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k];
    const prev = merged.at(-1);
    const next = segs[k + 1];
    if (s.type === "eq" && s.ws && prev?.type === "chg" && next?.type === "chg") {
      prev.to = next.to;
      prev.ins += oldText.slice(s.from, s.to) + next.ins;
      k++;
    } else if (s.type === "chg" && prev?.type === "chg") {
      prev.to = s.to;
      prev.ins += s.ins;
    } else {
      merged.push(s);
    }
  }
  return merged.map(({ type, from, to, ins }) => (type === "eq" ? { type, from, to } : { type, from, to, ins }));
}

// Whitespace, words (keeping "user-friendly" and "vendor's" whole), or single punctuation marks.
function wordTokens(text) {
  return [...text.matchAll(/\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}_'’-]/gu)].map((m) => ({ t: m[0], s: m.index, e: m.index + m[0].length, ws: /^\s/.test(m[0]) }));
}

// ---------------------------------------------------------------------------
// XML scanning (document.xml is machine-written, so a tag scanner is enough)

const TOKEN = /<[^>]*>|[^<]+/g;

function* tokens(xml) {
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(xml))) {
    const raw = m[0];
    const start = m.index;
    const end = start + raw.length;
    if (raw[0] !== "<") {
      yield { type: "text", raw, start, end };
    } else if (raw[1] === "?" || raw[1] === "!") {
      yield { type: "other", raw, start, end };
    } else {
      const name = raw.match(/^<\/?([^\s/>]+)/)[1];
      const type = raw[1] === "/" ? "close" : raw.endsWith("/>") ? "self" : "open";
      yield { type, name, raw, start, end };
    }
  }
}

/** Every w:p in document order, with its visible text and source offsets. */
export function scanParagraphs(xml) {
  const paragraphs = [];
  const open = [];
  const stack = [];
  for (const t of tokens(xml)) {
    const para = open.at(-1);
    if (t.type === "open") {
      stack.push(t.name);
      if (t.name === "w:p") {
        if (para) para.nested = true;
        const p = { text: "", start: t.start, end: t.end, nested: false };
        paragraphs.push(p);
        open.push(p);
      }
    } else if (t.type === "close") {
      stack.pop();
      if (t.name === "w:p" && para) {
        para.end = t.end;
        open.pop();
      }
    } else if (t.type === "self") {
      if (t.name === "w:p") paragraphs.push({ text: "", start: t.start, end: t.end, nested: false });
      else if (para && stack.at(-1) === "w:r") {
        if (t.name === "w:tab") para.text += "\t";
        else if (t.name === "w:br" || t.name === "w:cr") para.text += " ";
      }
    } else if (t.type === "text" && para && stack.at(-1) === "w:t") {
      para.text += decodeXml(t.raw);
    }
  }
  return paragraphs.map(({ text, start, end, nested }) => ({ text, start, end, nested }));
}

// A paragraph SpecCheck can rewrite: plain runs of text and tabs, plus bookmarks.
// Returns null for anything else so it's left untouched.
function parseSimpleParagraph(pXml) {
  const list = [...tokens(pXml)];
  if (list[0]?.type !== "open" || list[0].name !== "w:p") return null;
  const p = { open: list[0].raw, pPr: "", bookmarkStarts: [], bookmarkEnds: [], chars: [] };

  let i = 1;
  const last = list.length - 1;
  while (i < last) {
    const t = list[i];
    if (t.type === "text" && t.raw.trim() === "") {
      i++;
    } else if (t.name === "w:pPr") {
      [p.pPr, i] = element(pXml, list, i);
    } else if (t.name === "w:bookmarkStart" || t.name === "w:bookmarkEnd") {
      let raw;
      [raw, i] = element(pXml, list, i);
      (t.name === "w:bookmarkStart" ? p.bookmarkStarts : p.bookmarkEnds).push(raw);
    } else if (t.name === "w:proofErr" && t.type === "self") {
      i++;
    } else if (t.name === "w:r" && t.type === "self") {
      i++;
    } else if (t.name === "w:r" && t.type === "open") {
      i = parseRun(pXml, list, i, p.chars);
      if (i < 0) return null;
    } else {
      return null;
    }
  }
  return p;
}

function parseRun(xml, list, i, chars) {
  let rPr = "";
  i++;
  while (i < list.length) {
    const t = list[i];
    if (t.type === "close" && t.name === "w:r") return i + 1;
    if (t.type === "text" && t.raw.trim() === "") {
      i++;
    } else if (t.name === "w:rPr") {
      [rPr, i] = element(xml, list, i);
    } else if (t.name === "w:t" && t.type === "self") {
      i++;
    } else if (t.name === "w:t" && t.type === "open") {
      i++;
      while (i < list.length && !(list[i].type === "close" && list[i].name === "w:t")) {
        if (list[i].type !== "text") return -1;
        for (const ch of decodeXml(list[i].raw)) chars.push({ ch, rPr });
        i++;
      }
      i++;
    } else if (t.name === "w:tab" && t.type === "self") {
      chars.push({ ch: "\t", rPr });
      i++;
    } else if (t.name === "w:lastRenderedPageBreak" && t.type === "self") {
      i++;
    } else {
      return -1;
    }
  }
  return -1;
}

// Raw XML of the element starting at list[i], and the index just past it.
function element(xml, list, i) {
  const first = list[i];
  if (first.type === "self") return [first.raw, i + 1];
  let depth = 0;
  for (let k = i; k < list.length; k++) {
    const t = list[k];
    if (t.name !== first.name) continue;
    if (t.type === "open") depth++;
    else if (t.type === "close" && --depth === 0) return [xml.slice(first.start, t.end), k + 1];
  }
  throw new DocxError("The document XML is malformed.");
}

function decodeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|lt|gt|amp|quot|apos);/gi, (_, e) => {
    const named = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[e.toLowerCase()];
    if (named) return named;
    return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}

function escapeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Minimal zip (store + deflate, no zip64), using the built-in compression streams

async function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(await input.arrayBuffer());
}

function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const notDocx = () => new DocxError("That doesn't look like a .docx file. Save it as a Word Document (.docx) and try again.");

  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw notDocx();
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || offset === 0xffffffff) throw new DocxError("That document is too large to open.");

  const decoder = new TextDecoder();
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw notDocx();
    const flags = view.getUint16(offset + 8, true);
    if (flags & 1) throw new DocxError("That document is password-protected. Remove the password and try again.");
    const nameLen = view.getUint16(offset + 28, true);
    const entry = {
      flags,
      method: view.getUint16(offset + 10, true),
      time: view.getUint16(offset + 12, true),
      date: view.getUint16(offset + 14, true),
      crc: view.getUint32(offset + 16, true),
      csize: view.getUint32(offset + 20, true),
      usize: view.getUint32(offset + 24, true),
      name: decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen)),
    };
    const local = view.getUint32(offset + 42, true);
    if (view.getUint32(local, true) !== 0x04034b50) throw notDocx();
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    entry.data = bytes.subarray(dataStart, dataStart + entry.csize);
    entries.push(entry);
    offset += 46 + nameLen + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return entries;
}

function writeZip(entries) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const name = encoder.encode(e.name);
    const flags = e.flags & 0x0800; // keep only the UTF-8 name flag
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, flags, true);
    local.setUint16(8, e.method, true);
    local.setUint16(10, e.time, true);
    local.setUint16(12, e.date, true);
    local.setUint32(14, e.crc, true);
    local.setUint32(18, e.csize, true);
    local.setUint32(22, e.usize, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, e.data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, flags, true);
    cd.setUint16(10, e.method, true);
    cd.setUint16(12, e.time, true);
    cd.setUint16(14, e.date, true);
    cd.setUint32(16, e.crc, true);
    cd.setUint32(20, e.csize, true);
    cd.setUint32(24, e.usize, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);

    offset += 30 + name.length + e.data.length;
  }

  const cdSize = central.reduce((sum, c) => sum + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)]);
}

async function inflate(entry) {
  if (entry.method === 0) return entry.data;
  if (entry.method !== 8) throw new DocxError("That document uses an unsupported compression method.");
  return pipe(entry.data, new DecompressionStream("deflate-raw"));
}

function deflate(data) {
  return pipe(data, new CompressionStream("deflate-raw"));
}

async function pipe(data, transform) {
  const stream = new Blob([data]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

let crcTable = null;
function crc32(data) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
