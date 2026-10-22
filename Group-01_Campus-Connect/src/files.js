'use strict';
// Which files are allowed, how names are cleaned, and a basic content check.
const fs = require('fs');
const path = require('path');

// extension -> [mime type we send back, content check]
const PDF = 'pdf', PNG = 'png', JPG = 'jpg', GIF = 'gif', WEBP = 'webp', ZIP = 'zip', OLE = 'ole', SZ = '7z', RTF = 'rtf', TEXT = 'text';
const ALLOWED = {
  pdf: ['application/pdf', PDF],
  png: ['image/png', PNG], jpg: ['image/jpeg', JPG], jpeg: ['image/jpeg', JPG], gif: ['image/gif', GIF], webp: ['image/webp', WEBP],
  zip: ['application/zip', ZIP], '7z': ['application/x-7z-compressed', SZ],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', ZIP],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ZIP],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', ZIP],
  odt: ['application/vnd.oasis.opendocument.text', ZIP], ods: ['application/vnd.oasis.opendocument.spreadsheet', ZIP],
  odp: ['application/vnd.oasis.opendocument.presentation', ZIP],
  doc: ['application/msword', OLE], xls: ['application/vnd.ms-excel', OLE], ppt: ['application/vnd.ms-powerpoint', OLE],
  rtf: ['application/rtf', RTF],
  txt: ['text/plain; charset=utf-8', TEXT], md: ['text/plain; charset=utf-8', TEXT], csv: ['text/csv; charset=utf-8', TEXT],
  c: ['text/plain; charset=utf-8', TEXT], cpp: ['text/plain; charset=utf-8', TEXT], h: ['text/plain; charset=utf-8', TEXT],
  java: ['text/plain; charset=utf-8', TEXT], py: ['text/plain; charset=utf-8', TEXT], js: ['text/plain; charset=utf-8', TEXT],
  sql: ['text/plain; charset=utf-8', TEXT], json: ['text/plain; charset=utf-8', TEXT],
};
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function extOf(name) { return path.extname(name).slice(1).toLowerCase(); }
function typeFor(name) { return ALLOWED[extOf(name)] || null; }
function allowedList() { return Object.keys(ALLOWED).sort(); }

// Multer reads names as latin1; turn them back into proper UTF-8, then remove anything risky.
function cleanName(raw) {
  let n = Buffer.from(String(raw || ''), 'latin1').toString('utf8');
  n = path.basename(n.replace(/\\/g, '/')).normalize('NFC');
  n = n.replace(/[\u0000-\u001f\u007f<>:"|?*\/\\]/g, '_').replace(/^\.+/, '').trim();
  if (!n) n = 'file';
  if (n.length > 120) {
    const ext = path.extname(n).slice(0, 12);
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n;
}

function startsWith(buf, bytes) { return bytes.every((b, i) => buf[i] === b); }

// Read the first bytes of the saved file and check that they match what the extension says.
function contentLooksRight(file, kind) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(4096);
  const n = fs.readSync(fd, buf, 0, 4096, 0);
  fs.closeSync(fd);
  const b = buf.subarray(0, n);
  if (n === 0) return false;
  switch (kind) {
    case PDF: return b.subarray(0, 1024).includes('%PDF-');
    case PNG: return startsWith(b, [0x89, 0x50, 0x4e, 0x47]);
    case JPG: return startsWith(b, [0xff, 0xd8, 0xff]);
    case GIF: return startsWith(b, [0x47, 0x49, 0x46, 0x38]);
    case WEBP: return b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP';
    case ZIP: return startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06]);
    case SZ: return startsWith(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
    case OLE: return startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    case RTF: return b.subarray(0, 5).toString() === '{\\rtf';
    case TEXT: return !b.includes(0);
    default: return false;
  }
}

module.exports = { typeFor, allowedList, cleanName, contentLooksRight, extOf, IMAGE_MIMES };
