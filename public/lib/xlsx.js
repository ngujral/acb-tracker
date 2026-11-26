// Minimal .xlsx reader: returns the first worksheet as an array of rows (arrays of strings).
// An .xlsx file is a zip of XML files. Uses the built-in DecompressionStream, so there are no
// dependencies and the file never leaves the device. Works in modern browsers and Node 18+.

const td = new TextDecoder();

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function readZipEntries(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This is not a valid .xlsx file.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('This .xlsx file is damaged.');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = td.decode(buf.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, csize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    has: (name) => entries.has(name),
    async text(name) {
      const e = entries.get(name);
      if (!e) return null;
      const start = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
      const data = buf.subarray(start, start + e.csize);
      if (e.method === 0) return td.decode(data);
      if (e.method === 8) return td.decode(await inflateRaw(data));
      throw new Error('Unsupported compression in .xlsx file.');
    },
  };
}

const decodeXml = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const textOf = (xml) => {
  let out = '';
  for (const m of xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)) out += m[1];
  return decodeXml(out);
};

const colIndex = (ref) => {
  const letters = ref.match(/^[A-Z]+/)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

async function firstSheetPath(zip) {
  const wb = await zip.text('xl/workbook.xml');
  const rels = await zip.text('xl/_rels/workbook.xml.rels');
  const sheet = wb && wb.match(/<(?:\w+:)?sheet\b[^>]*\br:id="([^"]+)"/);
  if (sheet && rels) {
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = m[0].match(/\bId="([^"]+)"/)?.[1];
      const target = m[0].match(/\bTarget="([^"]+)"/)?.[1];
      if (id === sheet[1] && target) {
        const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
        if (zip.has(path)) return path;
      }
    }
  }
  return 'xl/worksheets/sheet1.xml';
}

/** @param {ArrayBuffer|Uint8Array} data */
export async function readXlsx(data) {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  const zip = readZipEntries(buf);
  const sstXml = await zip.text('xl/sharedStrings.xml');
  const shared = sstXml ? [...sstXml.matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((m) => textOf(m[1])) : [];
  const sheetXml = await zip.text(await firstSheetPath(zip));
  if (!sheetXml) throw new Error('No worksheet found in this .xlsx file.');
  const rows = [];
  for (const rm of sheetXml.matchAll(/<(?:\w+:)?row\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    const row = [];
    const body = rm[1] || '';
    let next = 0;
    for (const cm of body.matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const attrs = cm[1];
      const inner = cm[2] || '';
      const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
      const idx = ref ? colIndex(ref) : next;
      const type = attrs.match(/\bt="([^"]+)"/)?.[1];
      const v = inner.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/)?.[1];
      let value = '';
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = textOf(inner);
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
      else value = v != null ? decodeXml(v) : '';
      row[idx] = value;
      next = idx + 1;
    }
    for (let i = 0; i < row.length; i++) if (row[i] == null) row[i] = '';
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}
