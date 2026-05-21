// Document Parser — multi-format document extraction
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const MAX_TEXT_LENGTH = 50000;
const MAX_PDF_PAGES = 50;

const PARSERS = {
  '.txt': parseText,
  '.md': parseText,
  '.csv': parseText,
  '.json': parseText,
  '.xml': parseText,
  '.html': parseText,
  '.htm': parseText,
  '.docx': parseWord,
  '.pdf': parsePDF,
  '.xlsx': parseExcel,
  '.xls': parseExcel,
  '.pptx': parsePowerPoint,
  '.ppt': parsePowerPoint,
  '.png': parseImage,
  '.jpg': parseImage,
  '.jpeg': parseImage,
  '.gif': parseImage,
  '.webp': parseImage,
  '.svg': parseText,
};

function detectAndParse(buffer, fileName) {
  const ext = path.extname(fileName || '').toLowerCase();
  const parser = PARSERS[ext];
  if (!parser) {
    return { error: `Unsupported file type: ${ext || 'unknown'}. Supported: ${Object.keys(PARSERS).join(', ')}` };
  }
  try {
    return parser(buffer, fileName);
  } catch (e) {
    return { error: `Parse error: ${e.message}` };
  }
}

function parseText(buffer, fileName) {
  let text = buffer.toString('utf-8');
  const truncated = text.length > MAX_TEXT_LENGTH;
  if (truncated) text = text.slice(0, MAX_TEXT_LENGTH);
  return {
    text,
    metadata: {
      type: 'text',
      extension: path.extname(fileName || ''),
      fileName: fileName || '',
      size: buffer.length,
      lines: text.split('\n').length,
      truncated
    }
  };
}

async function parseWord(buffer, fileName) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  let text = result.value || '';
  const truncated = text.length > MAX_TEXT_LENGTH;
  if (truncated) text = text.slice(0, MAX_TEXT_LENGTH);
  return {
    text,
    metadata: {
      type: 'docx',
      fileName: fileName || '',
      size: buffer.length,
      truncated,
      warnings: result.messages?.slice(0, 5) || []
    }
  };
}

async function parsePDF(buffer, fileName) {
  const pdfParse = require('pdf-parse');
  const data = await pdfParse(buffer, { max: MAX_PDF_PAGES });
  let text = data.text || '';
  const truncated = text.length > MAX_TEXT_LENGTH;
  if (truncated) text = text.slice(0, MAX_TEXT_LENGTH);
  return {
    text,
    metadata: {
      type: 'pdf',
      fileName: fileName || '',
      size: buffer.length,
      pages: data.numpages || 0,
      truncated
    }
  };
}

function parseExcel(buffer, fileName) {
  const XLSX = require('xlsx');
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheets = workbook.SheetNames || [];
  const results = [];

  for (const name of sheets.slice(0, 10)) {
    const sheet = workbook.Sheets[name];
    const json = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (json.length > 0) {
      results.push(`## Sheet: ${name}\n${json.slice(0, 200).map(row => row.join('\t')).join('\n')}`);
    }
  }

  let text = results.join('\n\n');
  const truncated = text.length > MAX_TEXT_LENGTH;
  if (truncated) text = text.slice(0, MAX_TEXT_LENGTH);

  return {
    text,
    metadata: {
      type: 'xlsx',
      fileName: fileName || '',
      size: buffer.length,
      sheets: sheets,
      truncated
    }
  };
}

async function parsePowerPoint(buffer, fileName) {
  const AdmZip = require('adm-zip');
  const { parseStringPromise } = require('xml2js');

  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  // Find slide XML files
  const slideEntries = entries
    .filter(e => e.entryName.match(/ppt\/slides\/slide\d+\.xml/i))
    .sort((a, b) => {
      const na = parseInt((a.entryName.match(/slide(\d+)/i) || [])[1] || '0');
      const nb = parseInt((b.entryName.match(/slide(\d+)/i) || [])[1] || '0');
      return na - nb;
    })
    .slice(0, 50); // Max 50 slides

  const slides = [];
  for (const entry of slideEntries) {
    const xml = entry.getData().toString('utf-8');
    try {
      const parsed = await parseStringPromise(xml);
      const texts = [];
      // Extract all <a:t> elements (text content in PowerPoint)
      extractPPTXTexts(parsed, texts);
      if (texts.length > 0) {
        slides.push(texts.join(' '));
      }
    } catch {}
  }

  let text = slides.map((s, i) => `## Slide ${i + 1}\n${s}`).join('\n\n');
  const truncated = text.length > MAX_TEXT_LENGTH;
  if (truncated) text = text.slice(0, MAX_TEXT_LENGTH);

  return {
    text: text || '[No text content found in PPTX]',
    metadata: {
      type: 'pptx',
      fileName: fileName || '',
      size: buffer.length,
      slides: slides.length,
      truncated
    }
  };
}

function extractPPTXTexts(obj, texts) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    obj.forEach(item => extractPPTXTexts(item, texts));
    return;
  }
  if (obj['a:t']) {
    if (Array.isArray(obj['a:t'])) {
      obj['a:t'].forEach(t => { if (typeof t === 'string') texts.push(t); else if (t && t._) texts.push(t._); });
    } else if (typeof obj['a:t'] === 'string') {
      texts.push(obj['a:t']);
    }
  }
  // Walk deeper
  Object.values(obj).forEach(v => {
    if (typeof v === 'object' && v !== null) extractPPTXTexts(v, texts);
  });
}

function parseImage(buffer, fileName) {
  const ext = path.extname(fileName || '.png').toLowerCase();
  const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
  const mime = mimeMap[ext] || 'image/png';
  const base64 = buffer.toString('base64');
  const dataUri = `data:${mime};base64,${base64}`;

  return {
    text: `[Image: ${fileName || 'screenshot'}]`,
    metadata: {
      type: 'image',
      fileName: fileName || '',
      size: buffer.length,
      mime,
      dataUri: dataUri.slice(0, 500) + '...' // Don't return full data URI in metadata
    },
    imageData: dataUri
  };
}

/**
 * Fetch a URL and return parsed text content (for page links)
 */
function fetchUrl(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { timeout: 15000, rejectUnauthorized: false }, (res) => {
      if (res.statusCode >= 400) {
        resolve({ error: `HTTP ${res.statusCode}` });
        return;
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        // Strip HTML tags
        const text = data.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&#\d+;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, MAX_TEXT_LENGTH);
        resolve({
          text,
          metadata: {
            type: 'url',
            url,
            statusCode: res.statusCode,
            headers: res.headers
          }
        });
      });
    }).on('error', e => resolve({ error: e.message }));
  });
}

module.exports = { detectAndParse, fetchUrl, PARSERS };
