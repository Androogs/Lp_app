'use strict';
// Tareas de arranque: datos base, administrador inicial y trabajos periódicos (respaldos, limpieza de sesiones, TRM, marketing).
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { ahora } = require('./util');
const seg = require('./seguridad');
const log = require('./log');

// Crea el primer administrador desde INITIAL_ADMIN_USER / INITIAL_ADMIN_PASSWORD si la base no tiene usuarios.
// Queda marcado para cambiar la contraseña en el primer ingreso.
function crearAdminInicial(db) {
  if (db.prepare('SELECT COUNT(*) n FROM usuarios').get().n > 0) return false;
  const usuario = config.INITIAL_ADMIN_USER.toLowerCase();
  const clave = config.INITIAL_ADMIN_PASSWORD;
  if (!usuario || !clave) {
    log.warn('La base no tiene usuarios. Define INITIAL_ADMIN_USER e INITIAL_ADMIN_PASSWORD y reinicia, o ejecuta `npm run crear-admin`.');
    return false;
  }
  if (!/^[a-z0-9._-]{3,60}$/.test(usuario)) throw new Error('INITIAL_ADMIN_USER solo admite letras sin tilde, números, punto, guion y guion bajo (mínimo 3).');
  seg.validarFortaleza(clave, { usuario });
  db.prepare('INSERT INTO usuarios(nombre, usuario, password_hash, rol, debe_cambiar_clave, tipo_comercial, clave_cambiada_en) VALUES (?,?,?,?,1,?,?)')
    .run(config.INITIAL_ADMIN_NAME.slice(0, 120), usuario, seg.hashClaveSync(clave), 'admin', 'empleador', ahora());
  log.info(`Administrador inicial "${usuario}" creado. Deberá cambiar la contraseña al ingresar; luego puedes quitar INITIAL_ADMIN_PASSWORD de las variables de entorno.`);
  return true;
}

function respaldoAutomatico(db) {
  try {
    const { crearRespaldo } = require('./routes/admin');
    const dir = config.BACKUPS_DIR;
    const hoyNombre = `respaldo-${ahora().slice(0, 10)}`;
    if (fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.startsWith(hoyNombre))) return;
    crearRespaldo(db);
    const lista = fs.readdirSync(dir).filter((f) => /^respaldo-.*\.db$/.test(f)).sort();
    while (lista.length > config.BACKUPS_KEEP) fs.unlinkSync(path.join(dir, lista.shift()));
    log.info('Respaldo automático creado');
  } catch (e) { log.error('respaldo automático', { error: e.message }); }
}

function preparar(db) {
  require('./services/productos').asegurarCategorias(db);
  crearAdminInicial(db);
  const { limpiarSesionesVencidas } = require('./auth');
  limpiarSesionesVencidas(db);
  setInterval(() => { try { limpiarSesionesVencidas(db); } catch (e) { log.error('limpieza de sesiones', { error: e.message }); } }, 30 * 60 * 1000).unref();

  if (config.BACKUPS_AUTO && config.DB_PATH !== ':memory:') {
    setTimeout(() => respaldoAutomatico(db), 5000).unref();
    setInterval(() => respaldoAutomatico(db), 6 * 60 * 60 * 1000).unref();
  }
  if (!config.TAREAS_PROGRAMADAS) return;
  // Tasa de cambio: TRM oficial y cotización de mercado (frecuencia configurable).
  require('./services/trm').programar(db);
  // TRM de referencia de compras antiguas (una vez, desde el histórico local).
  const compras = require('./services/compras');
  setTimeout(() => { Promise.resolve(compras.completarTrmHistorica(db)).catch((e) => log.error('trm compras', { error: e.message })); }, 8000).unref();
  // Marketing: sincronización programada con plataformas publicitarias (solo si hay credenciales).
  const marketing = require('./services/marketing');
  if (typeof marketing.programar === 'function') marketing.programar(db);
}

module.exports = { preparar, crearAdminInicial, respaldoAutomatico };
