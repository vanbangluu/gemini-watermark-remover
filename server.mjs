import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { removeWatermarkFromFile, removeVideoWatermarkFromFile } from '@pilio/gemini-watermark-remover/node';

const PORT = Number(process.env.PORT) || 9010;
const HOST = process.env.HOST || '127.0.0.1';

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
        result = await removeWatermarkFromFile(inputPath, {
          outputPath,
          mimeType: filePart.contentType || inferContentType(filePart.filename),
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    serveIndex(res);
  } else if (req.method === 'GET' && url.pathname === '/health') {
    serveHealth(res);
  } else if (req.method === 'POST' && url.pathname === '/remove') {
    handleRemove(req, res);
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.listen(PORT, HOST, () => {
  process.stderr.write(`Gemini Watermark Remover server listening on http://${HOST}:${PORT}\n`);
});
