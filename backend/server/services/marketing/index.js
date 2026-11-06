'use strict';
// Adaptadores de plataformas publicitarias. Interfaz común de cada uno:
//   { clave, nombre, variables: [...], instrucciones: [...], configurado(), sincronizar(db, { desde, hasta }) }
// `sincronizar` devuelve { estado: 'ok' | 'error' | 'sin_credenciales', detalle, campanas_actualizadas, metricas_insertadas }.
// Nunca se simulan datos: sin credenciales el adaptador lo dice; con credenciales pero sin implementación, devuelve 'error'.
const meta = require('./meta');
const google = require('./google');
const tiktok = require('./tiktok');
const comun = require('./comun');

const PLATAFORMAS = { meta, google, tiktok };
const lista = () => Object.values(PLATAFORMAS);
const obtener = (clave) => PLATAFORMAS[clave] || null;

module.exports = { PLATAFORMAS, lista, obtener, ...comun };
