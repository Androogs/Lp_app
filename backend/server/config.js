'use strict';
// Configuración central de Licores Palmira · Gestión. Lee variables de entorno (y el archivo .env si existe), aplica valores por defecto seguros
// y valida lo imprescindible antes de arrancar. Ningún otro módulo debe leer process.env directamente para la configuración
// de seguridad: todo pasa por aquí.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const RAIZ = path.join(__dirname, '..'); // carpeta backend/

// ---------- Carga de .env (sin dependencias: process.loadEnvFile existe desde Node 20.12 / 21.7) ----------
// Las variables definidas en el sistema (p. ej. en hPanel de Hostinger) tienen prioridad sobre el archivo.
(function cargarEnv() {
  const archivo = process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : path.join(RAIZ, '.env');
  if (!fs.existsSync(archivo)) return;
  try { process.loadEnvFile(archivo); } catch (e) { console.error(`[config] No se pudo leer ${archivo}: ${e.message}`); }
})();

const env = process.env;
const texto = (v, defecto = '') => (v === undefined || v === null || String(v).trim() === '' ? defecto : String(v).trim());
const numero = (v, defecto, { min = -Infinity, max = Infinity } = {}) => {
  const n = Number(v);
  if (v === undefined || v === '' || !Number.isFinite(n)) return defecto;
  return Math.min(max, Math.max(min, n));
};
const bool = (v, defecto) => {
  if (v === undefined || v === '') return defecto;
  return ['1', 'true', 'si', 'sí', 'yes', 'on'].includes(String(v).trim().toLowerCase());
};

const NODE_ENV = ['production', 'development', 'test'].includes(env.NODE_ENV) ? env.NODE_ENV : 'development';
const PRODUCCION = NODE_ENV === 'production';
const PRUEBAS = NODE_ENV === 'test';

// Zona horaria del negocio: todas las fechas se guardan en hora local de Colombia.
if (!env.TZ) process.env.TZ = 'America/Bogota';

const DATA_DIR = path.resolve(RAIZ, texto(env.DATA_DIR, 'data'));
const DB_POR_DEFECTO = path.join(DATA_DIR, 'palmira.db');
const DB_PATH = texto(env.DB_PATH) === ':memory:' ? ':memory:' : path.resolve(RAIZ, texto(env.DB_PATH, DB_POR_DEFECTO));

const APP_URL = texto(env.APP_URL).replace(/\/+$/, '');
if (APP_URL && !/^https?:\/\/[^\s/]+$/i.test(APP_URL)) {
  throw new Error(`APP_URL inválida ("${APP_URL}"). Usa el dominio completo, p. ej. https://panel.tunegocio.com (sin rutas).`);
}

// ---------- Secreto de la aplicación ----------
// Se usa para cifrar los códigos de recuperación de contraseña. Si no se define, se genera uno aleatorio y se guarda en
// DATA_DIR/.app-secret (permisos 600) para que sobreviva a los reinicios.
function resolverSecreto() {
  const dado = texto(env.APP_SECRET);
  if (dado) {
    if (dado.length < 32) throw new Error('APP_SECRET debe tener al menos 32 caracteres. Genera uno con: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"');
    if (/cambia|change|ejemplo|example|secret|xxxx/i.test(dado) && PRODUCCION) throw new Error('APP_SECRET parece un valor de ejemplo. Genera uno aleatorio antes de publicar.');
    return dado;
  }
  if (PRUEBAS || DB_PATH === ':memory:') return crypto.randomBytes(48).toString('base64url');
  const archivo = path.join(DATA_DIR, '.app-secret');
  try {
    if (fs.existsSync(archivo)) return fs.readFileSync(archivo, 'utf8').trim();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const nuevo = crypto.randomBytes(48).toString('base64url');
    fs.writeFileSync(archivo, nuevo, { mode: 0o600 });
    console.warn(`[config] APP_SECRET no definido: se generó uno y se guardó en ${archivo}.`);
    return nuevo;
  } catch (e) {
    throw new Error(`No se pudo crear APP_SECRET en ${archivo} (${e.message}). Define APP_SECRET en las variables de entorno.`);
  }
}

const config = Object.freeze({
  RAIZ,
  // Build de producción del frontend (React + Vite). Por defecto ../frontend/dist.
  FRONTEND_DIST: path.resolve(RAIZ, texto(env.FRONTEND_DIST, path.join('..', 'frontend', 'dist'))),
  NODE_ENV,
  PRODUCCION,
  PRUEBAS,
  HOST: texto(env.HOST, '0.0.0.0'),
  PORT: numero(env.PORT, 3400, { min: 1, max: 65535 }),
  APP_URL,
  DATA_DIR,
  DB_PATH,
  UPLOADS_DIR: path.join(DATA_DIR, 'archivos'),
  BACKUPS_DIR: path.join(DATA_DIR, 'respaldos'),

  // Proxy inverso (Hostinger, Nginx, Cloudflare): número de saltos de confianza para leer la IP real y el protocolo.
  TRUST_PROXY: texto(env.TRUST_PROXY, '1'),
  FORCE_HTTPS: bool(env.FORCE_HTTPS, PRODUCCION),
  COOKIE_SECURE: bool(env.COOKIE_SECURE, PRODUCCION),

  // Sesiones: expiración absoluta y por inactividad.
  SESSION_HOURS: numero(env.SESSION_HOURS, 12, { min: 1, max: 24 * 30 }),
  SESSION_IDLE_MINUTES: numero(env.SESSION_IDLE_MINUTES, 120, { min: 5, max: 24 * 60 }),

  // Contraseñas y bloqueo de cuenta.
  BCRYPT_ROUNDS: numero(env.BCRYPT_ROUNDS, PRUEBAS ? 4 : 12, { min: 4, max: 15 }),
  PASSWORD_MIN_LENGTH: numero(env.PASSWORD_MIN_LENGTH, 10, { min: 8, max: 64 }),
  LOGIN_MAX_ATTEMPTS: numero(env.LOGIN_MAX_ATTEMPTS, 5, { min: 3, max: 50 }),
  LOGIN_LOCK_MINUTES: numero(env.LOGIN_LOCK_MINUTES, 15, { min: 1, max: 24 * 60 }),

  // Límite de peticiones a la API por IP (ventana de 5 minutos).
  RATE_LIMIT_API: numero(env.RATE_LIMIT_API, 1500, { min: 50, max: 100000 }),

  // Tamaño máximo del cuerpo JSON: general y para rutas que reciben archivos en base64.
  BODY_LIMIT: texto(env.BODY_LIMIT, '1mb'),
  UPLOAD_BODY_LIMIT: texto(env.UPLOAD_BODY_LIMIT, '20mb'),

  // Respaldos automáticos de la base de datos.
  BACKUPS_AUTO: bool(env.BACKUPS_AUTO, !PRUEBAS),
  BACKUPS_KEEP: numero(env.BACKUPS_KEEP, 14, { min: 1, max: 365 }),

  // Tareas en segundo plano (TRM, marketing). Se apagan en pruebas.
  TAREAS_PROGRAMADAS: bool(env.TAREAS_PROGRAMADAS, !PRUEBAS),

  // Administrador inicial (solo se usa si la base no tiene usuarios).
  INITIAL_ADMIN_USER: texto(env.INITIAL_ADMIN_USER),
  INITIAL_ADMIN_PASSWORD: texto(env.INITIAL_ADMIN_PASSWORD),
  INITIAL_ADMIN_NAME: texto(env.INITIAL_ADMIN_NAME, 'Administrador'),

  // Muestra los usuarios de demostración en la pantalla de acceso (solo fuera de producción).
  MOSTRAR_DEMO: !PRODUCCION && bool(env.MOSTRAR_DEMO, true),

  LOG_LEVEL: texto(env.LOG_LEVEL, PRODUCCION ? 'info' : 'debug'),
});

let secreto = null;
function appSecret() {
  if (!secreto) secreto = resolverSecreto();
  return secreto;
}

// Advertencias de despliegue (no detienen el arranque).
function advertenciasProduccion() {
  const avisos = [];
  if (!config.PRODUCCION) return avisos;
  if (!config.APP_URL) avisos.push('APP_URL no está definida: los enlaces compartidos (comprobantes, seguimiento web) usarán el dominio de la petición.');
  if (!config.COOKIE_SECURE) avisos.push('COOKIE_SECURE=false en producción: la cookie de sesión viajaría sin HTTPS. Actívalo en cuanto tengas SSL.');
  if (config.DATA_DIR.startsWith(config.FRONTEND_DIST)) avisos.push('DATA_DIR está dentro de la carpeta pública del frontend: los datos podrían quedar expuestos. Muévelo fuera.');
  return avisos;
}

module.exports = { ...config, appSecret, advertenciasProduccion };
