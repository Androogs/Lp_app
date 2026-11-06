'use strict';
// Primitivas de seguridad: hash de contraseñas (bcrypt), política de contraseñas, huellas de tokens y cifrado simétrico.
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { err } = require('./util');

// ---------- Contraseñas ----------
const BCRYPT_MAX_BYTES = 72; // bcrypt ignora lo que pase de 72 bytes: se rechaza en la política.
const SCRYPT_LEGADO = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function hashClave(clave) {
  return bcrypt.hash(String(clave), config.BCRYPT_ROUNDS);
}
function hashClaveSync(clave) {
  return bcrypt.hashSync(String(clave), config.BCRYPT_ROUNDS);
}

// Hash ficticio para igualar el tiempo de respuesta cuando el usuario no existe (evita enumerar usuarios por tiempo).
let hashFicticio = null;
function obtenerHashFicticio() {
  if (!hashFicticio) hashFicticio = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), config.BCRYPT_ROUNDS);
  return hashFicticio;
}

// Verifica una contraseña. Devuelve { ok, rehash } — rehash = true si el hash es de un formato anterior (scrypt) o de
// menor costo y debe actualizarse a bcrypt con el costo actual.
async function verificarClave(clave, almacenado) {
  const c = String(clave ?? '');
  if (!almacenado) { await bcrypt.compare(c, obtenerHashFicticio()); return { ok: false, rehash: false }; }
  if (almacenado.startsWith('scrypt$')) {
    const [, sal, hash] = almacenado.split('$');
    if (!sal || !hash) return { ok: false, rehash: false };
    const calculado = await new Promise((res, rej) => crypto.scrypt(c, sal, 64, SCRYPT_LEGADO, (e, k) => (e ? rej(e) : res(k))));
    const esperado = Buffer.from(hash, 'hex');
    const ok = calculado.length === esperado.length && crypto.timingSafeEqual(calculado, esperado);
    return { ok, rehash: ok };
  }
  if (/^\$2[aby]\$\d{2}\$/.test(almacenado)) {
    const ok = await bcrypt.compare(c, almacenado);
    const costo = Number(almacenado.split('$')[2]);
    return { ok, rehash: ok && costo < config.BCRYPT_ROUNDS };
  }
  return { ok: false, rehash: false };
}

// Política: longitud mínima configurable (10 por defecto), máximo 72 bytes, al menos una letra y un número, sin espacios
// al inicio o al final, distinta del nombre de usuario y no incluida en la lista de contraseñas triviales.
const TRIVIALES = new Set(['1234567890', '0123456789', 'contraseña1', 'contrasena1', 'password1', 'password123', 'qwerty1234', 'admin12345', 'palmira123', 'licores1234', 'abcdef1234', 'abc1234567', '1q2w3e4r5t', 'administrador1']);
function validarFortaleza(clave, { usuario } = {}) {
  if (typeof clave !== 'string' || !clave) throw err.datos('Escribe la contraseña');
  const min = config.PASSWORD_MIN_LENGTH;
  if (clave.length < min) throw err.datos(`La contraseña debe tener al menos ${min} caracteres`);
  if (Buffer.byteLength(clave, 'utf8') > BCRYPT_MAX_BYTES) throw err.datos('La contraseña es demasiado larga (máximo 72 bytes)');
  if (clave !== clave.trim()) throw err.datos('La contraseña no puede empezar ni terminar con espacios');
  if (!/[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(clave) || !/\d/.test(clave)) throw err.datos('La contraseña debe combinar letras y números');
  if (/^(.)\1+$/.test(clave)) throw err.datos('La contraseña no puede ser un solo carácter repetido');
  const baja = clave.toLowerCase();
  if (TRIVIALES.has(baja)) throw err.datos('Esa contraseña es demasiado común; elige otra');
  if (usuario && baja.includes(String(usuario).toLowerCase())) throw err.datos('La contraseña no puede contener el nombre de usuario');
  return clave;
}

// ---------- Tokens ----------
const tokenAleatorio = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (valor) => crypto.createHash('sha256').update(String(valor)).digest('hex');
function igualesSeguro(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
const hmac = (valor, proposito = 'general') => crypto.createHmac('sha256', `${config.appSecret()}:${proposito}`).update(String(valor)).digest('hex');

// ---------- Cifrado simétrico (AES-256-GCM) para datos que deben poder mostrarse de nuevo ----------
function clave(proposito) { return crypto.createHash('sha256').update(`${config.appSecret()}:${proposito}`).digest(); }
function cifrar(texto, proposito = 'general') {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', clave(proposito), iv);
  const datos = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${datos.toString('base64url')}`;
}
function descifrar(cifrado, proposito = 'general') {
  try {
    const [v, iv, tag, datos] = String(cifrado || '').split('.');
    if (v !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', clave(proposito), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(datos, 'base64url')), d.final()]).toString('utf8');
  } catch { return null; }
}

module.exports = { hashClave, hashClaveSync, verificarClave, validarFortaleza, tokenAleatorio, sha256, igualesSeguro, hmac, cifrar, descifrar };
