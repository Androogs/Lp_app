'use strict';
// Registro mínimo con marca de tiempo y nivel. En producción escribe una línea JSON por evento (fácil de leer en los logs
// del hosting); en desarrollo, texto legible.
const config = require('./config');

const NIVELES = { debug: 10, info: 20, warn: 30, error: 40 };
const minimo = NIVELES[config.LOG_LEVEL] || NIVELES.info;

function escribir(nivel, mensaje, datos) {
  if (NIVELES[nivel] < minimo || (config.PRUEBAS && nivel !== 'error')) return;
  const salida = nivel === 'error' || nivel === 'warn' ? console.error : console.log;
  if (config.PRODUCCION) salida(JSON.stringify({ t: new Date().toISOString(), nivel, mensaje, ...(datos || {}) }));
  else salida(`[${new Date().toLocaleTimeString('es-CO')}] ${nivel.toUpperCase()} ${mensaje}${datos ? ' ' + JSON.stringify(datos) : ''}`);
}

module.exports = {
  debug: (m, d) => escribir('debug', m, d),
  info: (m, d) => escribir('info', m, d),
  warn: (m, d) => escribir('warn', m, d),
  error: (m, d) => escribir('error', m, d),
};
