'use strict';
// Límites de peticiones por IP (memoria del proceso). Respuesta uniforme en JSON y en español.
const { rateLimit } = require('express-rate-limit');
const config = require('./config');

function limitador({ ventanaMin, max, mensaje, soloFallos = false }) {
  return rateLimit({
    windowMs: ventanaMin * 60 * 1000,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: soloFallos,
    skip: () => config.PRUEBAS && process.env.LIMITES_EN_PRUEBAS !== '1',
    handler: (req, res) => res.status(429).json({ error: mensaje, codigo: 'demasiadas_peticiones' }),
  });
}

module.exports = {
  api: limitador({ ventanaMin: 5, max: config.RATE_LIMIT_API, mensaje: 'Demasiadas peticiones. Espera un momento e inténtalo de nuevo.' }),
  login: limitador({ ventanaMin: 15, max: 20, soloFallos: true, mensaje: 'Demasiados intentos de inicio de sesión desde esta conexión. Espera 15 minutos.' }),
  recuperar: limitador({ ventanaMin: 15, max: 5, mensaje: 'Demasiadas solicitudes de recuperación. Espera 15 minutos.' }),
  restablecer: limitador({ ventanaMin: 15, max: 10, mensaje: 'Demasiados intentos con códigos de recuperación. Espera 15 minutos.' }),
  comprobante: limitador({ ventanaMin: 5, max: 120, mensaje: 'Demasiadas consultas de comprobantes.' }),
};
