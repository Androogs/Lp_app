'use strict';
// Almacenamiento de fotos, facturas y comprobantes. Los archivos llegan como data URL (base64) desde el celular o el computador.
// Defensas: lista blanca de tipos, verificación de la firma real del archivo (magic bytes), tamaño máximo, nombre aleatorio
// generado por el servidor y carpeta fuera del directorio público.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { UPLOADS_DIR } = require('../db');
const { err } = require('../util');

const MAX_BYTES = 12 * 1024 * 1024;
const TIPOS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
};
const MIME_POR_EXT = Object.fromEntries(Object.entries(TIPOS).map(([m, e]) => [e, m]));

// Detecta el tipo por el contenido, no por lo que declara el cliente.
function tipoReal(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('ascii', 0, 6))) return 'image/gif';
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

// Acepta "data:image/jpeg;base64,...." o base64 crudo + mime.
function guardarDesdeBase64(dato, mimeSugerido, nombreOriginal) {
  if (!dato || typeof dato !== 'string') throw err.datos('Archivo vacío');
  let b64 = dato;
  const m = /^data:([\w/+.-]+);base64,(.*)$/s.exec(dato);
  if (m) b64 = m[2];
  if (b64.length > Math.ceil(MAX_BYTES / 3) * 4 + 8) throw err.datos('El archivo supera el máximo de 12 MB');
  if (!/^[A-Za-z0-9+/=\s_-]*$/.test(b64)) throw err.datos('El archivo está dañado (codificación inválida)');
  const buffer = Buffer.from(b64, 'base64');
  if (!buffer.length) throw err.datos('El archivo está vacío o dañado');
  if (buffer.length > MAX_BYTES) throw err.datos('El archivo supera el máximo de 12 MB');
  const mime = tipoReal(buffer);
  if (!mime) throw err.datos(`Tipo de archivo no permitido (${(m && m[1]) || mimeSugerido || 'desconocido'}). Usa JPG, PNG, WEBP o PDF.`);
  const ahora = new Date();
  const carpeta = `${ahora.getFullYear()}/${String(ahora.getMonth() + 1).padStart(2, '0')}`;
  fs.mkdirSync(path.join(UPLOADS_DIR, carpeta), { recursive: true });
  const nombre = `${crypto.randomBytes(16).toString('hex')}.${TIPOS[mime]}`;
  const ruta = `${carpeta}/${nombre}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, ruta), buffer, { mode: 0o640 });
  const limpio = String(nombreOriginal || '').replace(/[\u0000-\u001f<>"\\/|?*]/g, '').trim().slice(0, 120);
  return { ruta, mime, tamano: buffer.length, nombre: limpio || nombre };
}

const RUTA_VALIDA = /^\d{4}\/\d{2}\/[a-f0-9]{24,64}\.(jpg|png|webp|gif|pdf)$/;
function rutaAbsoluta(ruta) {
  const r = String(ruta || '');
  if (!RUTA_VALIDA.test(r)) throw err.noEncontrado('Archivo no encontrado');
  const base = path.resolve(UPLOADS_DIR);
  const abs = path.resolve(base, r);
  if (!abs.startsWith(base + path.sep)) throw err.prohibido('Ruta inválida');
  return abs;
}
const mimeDe = (ruta) => MIME_POR_EXT[path.extname(String(ruta)).slice(1).toLowerCase()] || 'application/octet-stream';

function leerComoBase64(ruta) {
  const abs = rutaAbsoluta(ruta);
  return { mime: mimeDe(abs), data: fs.readFileSync(abs).toString('base64') };
}

function eliminar(ruta) {
  try { fs.unlinkSync(rutaAbsoluta(ruta)); } catch { /* ya no existe */ }
}

module.exports = { guardarDesdeBase64, rutaAbsoluta, leerComoBase64, eliminar, mimeDe, tipoReal, TIPOS, MAX_BYTES };
