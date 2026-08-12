import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { removeWatermarkFromFile, removeVideoWatermarkFromFile } from '@pilio/gemini-watermark-remover/node';

const PORT = Number(process.env.PORT) || 9010;
const HOST = process.env.HOST || '127.0.0.1';

let sharpModule = null;
let codecPromise = null;

async function getCodec() {
  if (codecPromise) return codecPromise;
  codecPromise = (async () => {
    sharpModule = await import('sharp');
    const sharp = sharpModule.default ?? sharpModule;
    return {
      decodeImageData: async (buffer, ctx = {}) => {
        const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        return { width: info.width, height: info.height, data: Uint8ClampedArray.from(data) };
      },
      encodeImageData: async (imageData, ctx = {}) => {
        const { mimeType } = ctx;
        let encoder = sharp(Buffer.from(imageData.data), { raw: { width: imageData.width, height: imageData.height, channels: 4 } });
        if (mimeType === 'image/jpeg') encoder = encoder.jpeg({ quality: 95 });
        else if (mimeType === 'image/webp') encoder = encoder.webp({ quality: 95 });
        else encoder = encoder.png();
        return encoder.toBuffer();
      },
    };
  })();
  return codecPromise;
}

const UPLOAD_DIR = path.join(os.tmpdir(), 'gemini-watermark-remover-server');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json',
};

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.avi', '.mkv']);

function inferContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function parseMultipart(buffer, boundary) {
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const endBoundary = Buffer.from(`--${boundary}--`);
  const parts = [];

  let pos = 0;
  while (pos < buffer.length) {
    const headerEnd = buffer.indexOf('\r\n\r\n', pos);
    if (headerEnd === -1) break;

    const headerSection = buffer.subarray(pos + boundaryBuffer.length + 2, headerEnd).toString();
    const nameMatch = headerSection.match(/name="([^"]+)"/);
    const filenameMatch = headerSection.match(/filename="([^"]+)"/);
    const contentTypeMatch = headerSection.match(/Content-Type:\s*(.+)/i);

    pos = headerEnd + 4;
    const nextBoundary = buffer.indexOf(boundaryBuffer, pos);
    if (nextBoundary === -1) break;

    const data = buffer.subarray(pos, nextBoundary - 2);

    parts.push({
      name: nameMatch ? nameMatch[1] : '',
      filename: filenameMatch ? filenameMatch[1] : null,
      contentType: contentTypeMatch ? contentTypeMatch[1].trim() : null,
      data,
    });

    pos = nextBoundary;
    if (buffer.subarray(pos, pos + endBoundary.length).equals(endBoundary)) break;
  }

  return parts;
}

function serveStatic(res, filePath) {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': inferContentType(filePath) });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

async function handleRemove(req, res) {
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(.+)/);

  if (!boundaryMatch) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Expected multipart/form-data' }));
    return;
  }

  const boundary = boundaryMatch[1].replace(/^"|"$/g, '');
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));

  req.on('end', async () => {
    const buffer = Buffer.concat(chunks);
    const parts = parseMultipart(buffer, boundary);
    const filePart = parts.find((p) => p.filename);

    if (!filePart) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No file uploaded' }));
      return;
    }

    const inputExt = path.extname(filePart.filename).toLowerCase();
    const jobId = randomUUID();
    const inputPath = path.join(UPLOAD_DIR, `${jobId}${inputExt}`);
    const outputPath = path.join(UPLOAD_DIR, `${jobId}_clean${inputExt}`);

    try {
      fs.writeFileSync(inputPath, filePart.data);

      let result;
      if (VIDEO_EXTENSIONS.has(inputExt)) {
        result = await removeVideoWatermarkFromFile(inputPath, { outputPath });
      } else {
        const codec = await getCodec();
        result = await removeWatermarkFromFile(inputPath, {
          outputPath,
          mimeType: filePart.contentType || inferContentType(filePart.filename),
          decodeImageData: codec.decodeImageData,
          encodeImageData: codec.encodeImageData,
        });
      }

      const cleaned = fs.readFileSync(outputPath);

      res.writeHead(200, {
        'Content-Type': filePart.contentType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="clean_${filePart.filename}"`,
        'X-Watermark-Removed': String(!!result.meta?.applied),
        'X-Decision-Tier': result.meta?.decisionTier || 'unknown',
      });
      res.end(cleaned);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    } finally {
      try { fs.unlinkSync(inputPath); } catch {}
      try { fs.unlinkSync(outputPath); } catch {}
    }
  });
}

function serveIndex(res) {
  const indexPath = path.join(import.meta.dirname, 'public', 'index.html');
  serveStatic(res, indexPath);
}

function serveHealth(res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok' }));
}

function createZip(files) {
  const buffers = [];
  const centralDir = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const dosTime = 0x0000;
    const dosDate = 0x21;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc32(data), 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    buffers.push(localHeader, nameBuf, data);

    const cdEntry = Buffer.alloc(46);
    cdEntry.writeUInt32LE(0x02014b50, 0);
    cdEntry.writeUInt16LE(20, 4);
    cdEntry.writeUInt16LE(20, 6);
    cdEntry.writeUInt16LE(0x0800, 8);
    cdEntry.writeUInt16LE(0, 10);
    cdEntry.writeUInt16LE(dosTime, 12);
    cdEntry.writeUInt16LE(dosDate, 14);
    cdEntry.writeUInt32LE(localHeader.readUInt32LE(14), 16);
    cdEntry.writeUInt32LE(data.length, 20);
    cdEntry.writeUInt32LE(data.length, 24);
    cdEntry.writeUInt16LE(nameBuf.length, 28);
    cdEntry.writeUInt16LE(0, 30);
    cdEntry.writeUInt16LE(0, 32);
    cdEntry.writeUInt16LE(0, 34);
    cdEntry.writeUInt16LE(0, 36);
    cdEntry.writeUInt32LE(0, 38);
    cdEntry.writeUInt32LE(offset, 42);

    centralDir.push({ entry: cdEntry, name: nameBuf });
    offset += 30 + nameBuf.length + data.length;
  }

  const cdOffset = offset;
  for (const { entry, name } of centralDir) {
    buffers.push(entry, name);
    offset += 46 + name.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(offset - cdOffset, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);
  buffers.push(eocd);

  return Buffer.concat(buffers);
}

function crc32(buffer) {
  let crc = -1;
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  for (let i = 0; i < buffer.length; i++) {
    crc = table[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

async function handleRemoveBatch(req, res) {
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(.+)/);

  if (!boundaryMatch) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Expected multipart/form-data' }));
    return;
  }

  const boundary = boundaryMatch[1].replace(/^"|"$/g, '');
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));

  req.on('end', async () => {
    const buffer = Buffer.concat(chunks);
    const parts = parseMultipart(buffer, boundary);
    const fileParts = parts.filter((p) => p.filename);

    if (fileParts.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No files uploaded' }));
      return;
    }

    const codec = await getCodec();
    const results = [];
    const tempFiles = [];

    for (const filePart of fileParts) {
      const inputExt = path.extname(filePart.filename).toLowerCase();
      const jobId = randomUUID();
      const inputPath = path.join(UPLOAD_DIR, `${jobId}${inputExt}`);
      const outputPath = path.join(UPLOAD_DIR, `${jobId}_clean${inputExt}`);
      tempFiles.push(inputPath, outputPath);

      try {
        fs.writeFileSync(inputPath, filePart.data);

        let result;
        if (VIDEO_EXTENSIONS.has(inputExt)) {
          result = await removeVideoWatermarkFromFile(inputPath, { outputPath });
        } else {
          result = await removeWatermarkFromFile(inputPath, {
            outputPath,
            mimeType: filePart.contentType || inferContentType(filePart.filename),
            decodeImageData: codec.decodeImageData,
            encodeImageData: codec.encodeImageData,
          });
        }

        const cleaned = fs.readFileSync(outputPath);
        results.push({
          name: `clean_${filePart.filename}`,
          data: cleaned,
          original: filePart.filename,
          removed: !!result.meta?.applied,
          tier: result.meta?.decisionTier || 'unknown',
        });
      } catch (error) {
        results.push({
          name: filePart.filename,
          data: null,
          original: filePart.filename,
          removed: false,
          tier: 'error',
          error: error.message,
        });
      }
    }

    const summary = results.map((r) => ({
      file: r.original,
      output: r.data ? r.name : null,
      watermark_removed: r.removed,
      decision_tier: r.tier,
      error: r.error || null,
    }));

    const zipFiles = [
      { name: 'summary.json', data: Buffer.from(JSON.stringify(summary, null, 2), 'utf8') },
      ...results
        .filter((r) => r.data)
        .map((r) => ({ name: r.name, data: r.data })),
    ];

    if (zipFiles.length <= 1) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'All files failed processing', summary }));
      return;
    }

    const zip = createZip(zipFiles);

    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="watermark_removed_batch.zip"',
      'X-Processed-Count': String(summary.length),
      'X-Success-Count': String(summary.filter((s) => !s.error).length),
      'X-Failed-Count': String(summary.filter((s) => s.error).length),
      'X-Summary-Base64': Buffer.from(JSON.stringify(summary), 'utf8').toString('base64'),
    });
    res.end(zip);

    for (const f of tempFiles) {
      try { fs.unlinkSync(f); } catch {}
    }
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    serveIndex(res);
  } else if (req.method === 'GET' && url.pathname === '/health') {
    serveHealth(res);
  } else if (req.method === 'POST' && url.pathname === '/remove') {
    handleRemove(req, res);
  } else if (req.method === 'POST' && url.pathname === '/remove-batch') {
    handleRemoveBatch(req, res);
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.listen(PORT, HOST, () => {
  process.stderr.write(`Gemini Watermark Remover server listening on http://${HOST}:${PORT}\n`);
});
