'use strict';
// Utilidades compartidas: errores, fechas en hora local, validación y formato colombiano.

class ErrorApp extends Error {
  constructor(status, mensaje, codigo, extra) {
    super(mensaje);
    this.status = status;
    this.codigo = codigo || 'error';
    if (extra) this.extra = extra;
  }
}
const err = {
  datos: (m, extra) => new ErrorApp(400, m, 'datos_invalidos', extra),
  noAuth: (m = 'Debes iniciar sesión') => new ErrorApp(401, m, 'no_autenticado'),
  prohibido: (m = 'No tienes permiso para esta acción') => new ErrorApp(403, m, 'sin_permiso'),
  noEncontrado: (m = 'No encontrado') => new ErrorApp(404, m, 'no_encontrado'),
  conflicto: (m, extra) => new ErrorApp(409, m, 'conflicto', extra),
};

const pad = (n) => String(n).padStart(2, '0');

function ahora(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function hoy(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function aFecha(texto) {
  // 'YYYY-MM-DD' o 'YYYY-MM-DD HH:MM:SS' → Date local
  if (texto instanceof Date) return texto;
  const [f, h = '00:00:00'] = String(texto).trim().split(/[ T]/);
  const [y, m, d] = f.split('-').map(Number);
  const [hh = 0, mm = 0, ss = 0] = h.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, ss);
}
function sumarDias(fecha, dias) {
  const d = aFecha(fecha);
  d.setDate(d.getDate() + dias);
  return hoy(d);
}
function sumarMeses(fecha, meses) {
  const d = aFecha(fecha);
  const dia = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + meses);
  const ultimo = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(dia, ultimo));
  return hoy(d);
}
function sumarFrecuencia(fecha, frecuencia, n) {
  switch (frecuencia) {
    case 'diaria': return sumarDias(fecha, n);
    case 'semanal': return sumarDias(fecha, 7 * n);
    case 'quincenal': return sumarDias(fecha, 15 * n);
    case 'mensual': default: return sumarMeses(fecha, n);
  }
}
function diasEntre(a, b) {
  const ms = aFecha(b).setHours(0, 0, 0, 0) - aFecha(a).setHours(0, 0, 0, 0);
  return Math.round(ms / 86400000);
}
function rangoPeriodo(periodo, base = new Date()) {
  const h = hoy(base);
  if (periodo === 'hoy') return { desde: h, hasta: h };
  if (periodo === 'semana') {
    const d = aFecha(h);
    const dow = (d.getDay() + 6) % 7; // lunes = 0
    return { desde: sumarDias(h, -dow), hasta: h };
  }
  if (periodo === 'mes') return { desde: h.slice(0, 8) + '01', hasta: h };
  if (periodo === 'anio') return { desde: h.slice(0, 5) + '01-01', hasta: h };
  return { desde: h, hasta: h };
}
function esFechaValida(t) {
  return typeof t === 'string' && /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(t) && !isNaN(aFecha(t).getTime());
}

// ---- Validación ----
function entero(v, nombre, { min = -Infinity, max = Infinity, opcional = false, defecto } = {}) {
  if (v === undefined || v === null || v === '') {
    if (opcional) return defecto === undefined ? null : defecto;
    throw err.datos(`${nombre} es obligatorio`);
  }
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[.\s$]/g, '').replace(',', '.'));
  if (!Number.isFinite(n)) throw err.datos(`${nombre} debe ser un número`);
  const r = Math.round(n);
  if (r < min) throw err.datos(`${nombre} no puede ser menor que ${min}`);
  if (r > max) throw err.datos(`${nombre} no puede ser mayor que ${max}`);
  return r;
}
function decimal(v, nombre, { min = -Infinity, max = Infinity, opcional = false, defecto = 0 } = {}) {
  if (v === undefined || v === null || v === '') {
    if (opcional) return defecto;
    throw err.datos(`${nombre} es obligatorio`);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw err.datos(`${nombre} debe ser un número`);
  if (n < min || n > max) throw err.datos(`${nombre} fuera de rango`);
  return n;
}
function texto(v, nombre, { max = 500, opcional = false, defecto = null } = {}) {
  if (v === undefined || v === null || String(v).trim() === '') {
    if (opcional) return defecto;
    throw err.datos(`${nombre} es obligatorio`);
  }
  const t = String(v).trim();
  if (t.length > max) throw err.datos(`${nombre} es demasiado largo (máx. ${max})`);
  return t;
}
function booleano(v, defecto = false) {
  if (v === undefined || v === null || v === '') return defecto;
  if (typeof v === 'boolean') return v;
  return ['1', 'true', 'si', 'sí', 'on'].includes(String(v).toLowerCase());
}
function opcion(v, nombre, lista, { opcional = false, defecto = null } = {}) {
  if (v === undefined || v === null || v === '') {
    if (opcional) return defecto;
    throw err.datos(`${nombre} es obligatorio`);
  }
  if (!lista.includes(v)) throw err.datos(`${nombre} no es válido (${lista.join(', ')})`);
  return v;
}
function fecha(v, nombre, { opcional = false, defecto = null } = {}) {
  if (v === undefined || v === null || v === '') {
    if (opcional) return defecto;
    throw err.datos(`${nombre} es obligatoria`);
  }
  if (!esFechaValida(v)) throw err.datos(`${nombre} no tiene un formato válido (AAAA-MM-DD)`);
  return v;
}

// ---- Monedas ----
const MONEDAS = ['COP', 'USD'];
// Redondeo a 2 decimales (centavos) para montos en moneda extranjera y a entero para pesos.
const dec2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const copR = (n) => Math.round(Number(n) + Number.EPSILON);
// Convierte un monto en moneda extranjera a pesos con la tasa indicada (entero).
const aCop = (montoMoneda, tasa) => copR(Number(montoMoneda) * Number(tasa));
function monedaValida(v, { defecto = 'COP' } = {}) {
  if (v === undefined || v === null || v === '') return defecto;
  const m = String(v).toUpperCase();
  if (!MONEDAS.includes(m)) throw err.datos(`Moneda no soportada (${v}). Usa COP o USD.`);
  return m;
}
function tasaValida(v, nombre = 'Tasa de cambio') {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw err.datos(`${nombre} debe ser un número mayor que cero`);
  if (n < 100 || n > 100000) throw err.datos(`${nombre} fuera de rango (${n}); revisa el valor en pesos por dólar`);
  return Math.round(n * 10000) / 10000;
}
// Monto en la moneda de la operación: entero si es COP, 2 decimales si es USD.
function montoMoneda(v, nombre, moneda, opts = {}) {
  if (moneda === 'COP') return entero(v, nombre, opts);
  const n = decimal(v, nombre, opts);
  return dec2(n);
}

// ---- Formato colombiano ----
function cop(n) {
  const v = Math.round(Number(n) || 0);
  const s = Math.abs(v).toLocaleString('es-CO', { maximumFractionDigits: 0 });
  return (v < 0 ? '-$ ' : '$ ') + s;
}
function usd(n) {
  const v = Number(n) || 0;
  return (v < 0 ? '-US$ ' : 'US$ ') + Math.abs(v).toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function monto(n, moneda) { return moneda === 'USD' ? usd(n) : cop(n); }
function fechaCO(t, conHora = false) {
  if (!t) return '';
  const d = aFecha(t);
  const f = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  return conHora ? `${f} ${pad(d.getHours())}:${pad(d.getMinutes())}` : f;
}

// CSV compatible con Excel en español (separador ; y BOM).
// Las celdas de texto que empiezan por = + - @ tabulador o retorno de carro se neutralizan con un apóstrofo para que la hoja de
// cálculo no las evalúe como fórmula (inyección CSV con datos que llegan del formulario público o de la plataforma); los números
// (incluidos negativos como "-5000" o "-12,5") quedan intactos.
const ES_NUMERO = /^[+-]?\d+([.,]\d+)?$/;
function csv(filas, columnas) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    let s = typeof v === 'number' ? String(v).replace('.', ',') : String(v);
    if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s) && !ES_NUMERO.test(s)) s = "'" + s;
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const cab = columnas.map((c) => esc(c.titulo || c.clave)).join(';');
  const cuerpo = filas.map((f) => columnas.map((c) => esc(typeof c.valor === 'function' ? c.valor(f) : f[c.clave])).join(';'));
  return '﻿' + [cab, ...cuerpo].join('\r\n');
}

function slug(t) {
  return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}


// URL pública de la aplicación para enlaces compartidos. Usa APP_URL si está definida (recomendado en producción); si no,
// el host de la petición validado (nunca cabeceras X-Forwarded-Host sin validar).
function urlBase(req) {
  const config = require('./config');
  if (config.APP_URL) return config.APP_URL;
  const host = String(req.get('host') || 'localhost').toLowerCase();
  const seguro = /^[a-z0-9.-]+(:\d{1,5})?$/.test(host) ? host : 'localhost';
  return `${req.protocol === 'https' ? 'https' : 'http'}://${seguro}`;
}

module.exports = {
  urlBase,
  ErrorApp, err, ahora, hoy, aFecha, sumarDias, sumarMeses, sumarFrecuencia, diasEntre, rangoPeriodo, esFechaValida,
  entero, decimal, texto, booleano, opcion, fecha, cop, usd, monto, fechaCO, csv, slug, pad,
  MONEDAS, dec2, copR, aCop, monedaValida, tasaValida, montoMoneda,
};
