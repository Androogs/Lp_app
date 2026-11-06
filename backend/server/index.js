'use strict';
// Servidor HTTP de Licores Palmira · Gestión (Express 5). Producción: `npm start` · desarrollo: `npm run dev`.
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const helmet = require('helmet');
const config = require('./config');
const { getDb, cerrarDb } = require('./db');
const { ErrorApp } = require('./util');
const auth = require('./auth');
const limites = require('./limites');
const log = require('./log');

// Interfaz: build de producción del frontend React (frontend/dist). En desarrollo la sirve Vite (puerto 5173) con proxy a
// esta API, así que aquí puede no existir todavía.
const PUBLIC_DIR = config.FRONTEND_DIST;
const HAY_BUILD = fs.existsSync(path.join(PUBLIC_DIR, 'index.html'));
const SCRIPT_SEGUIMIENTO = path.join(config.RAIZ, 'assets', 'palmira-seguimiento.js');

// Rutas que reciben archivos en base64 (fotos, facturas, comprobantes): único lugar con cuerpo grande permitido.
const RUTAS_ARCHIVOS = /^\/api\/(documentos|ventas|gastos|webhooks\/documentos|productos\/\d+\/fotos|compras\/\d+\/pagos|creditos\/\d+\/abonos)\/?$/;

function cabecerasSeguridad() {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        mediaSrc: ["'self'", 'blob:'],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(config.FORCE_HTTPS ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    strictTransportSecurity: config.PRODUCCION && config.FORCE_HTTPS ? { maxAge: 31536000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    frameguard: { action: 'deny' },
  });
}

function crearApp() {
  const app = express();
  app.set('trust proxy', /^\d+$/.test(config.TRUST_PROXY) ? Number(config.TRUST_PROXY) : config.TRUST_PROXY);
  app.disable('x-powered-by');
  app.set('etag', 'strong');

  // HTTPS obligatorio detrás del proxy del hosting.
  if (config.FORCE_HTTPS) {
    app.use((req, res, next) => {
      if (req.secure || req.path === '/api/salud') return next();
      if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(301, `https://${req.get('host')}${req.originalUrl}`);
      res.status(403).json({ error: 'Se requiere HTTPS', codigo: 'https_requerido' });
    });
  }

  app.use(cabecerasSeguridad());
  app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()');
    // El script de seguimiento y su API se cargan desde la página web del negocio (otro dominio).
    if (req.path.startsWith('/marketing/') || req.path.startsWith('/api/publico/')) res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Cuerpos JSON: 1 MB por defecto; solo las rutas de archivos aceptan cuerpos grandes. Las rutas públicas de marketing
  // usan sus propios parsers (20 kB).
  const jsonGeneral = express.json({ limit: config.BODY_LIMIT });
  const jsonArchivos = express.json({ limit: config.UPLOAD_BODY_LIMIT });
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/publico/')) return next();
    return (req.method === 'POST' && RUTAS_ARCHIVOS.test(req.path) ? jsonArchivos : jsonGeneral)(req, res, next);
  });

  app.use('/api', limites.api);
  app.use(auth.autenticar);

  app.get('/api/salud', (req, res) => {
    let bd = 'ok';
    try { getDb().prepare('SELECT 1').get(); } catch { bd = 'error'; }
    res.status(bd === 'ok' ? 200 : 503).json({ ok: bd === 'ok', bd, hora: new Date().toISOString() });
  });
  app.use('/api/auth', require('./routes/auth').router);
  // Marketing público (sin sesión): valida su propio token, limita por IP y acepta CORS. Debe ir antes de requiereAuth.
  const marketingRutas = require('./routes/marketing');
  app.use('/api/publico/marketing', marketingRutas.publico);
  app.use('/api', auth.requiereAuth);
  app.use('/api', require('./routes/catalogo'));
  app.use('/api', require('./routes/operaciones'));
  app.use('/api', require('./routes/admin').router);
  app.use('/api', require('./routes/contabilidad'));
  app.use('/api', require('./routes/domicilios'));
  app.use('/api', require('./routes/comisiones'));
  app.use('/api', marketingRutas.router);
  app.use('/api', require('./routes/asistente'));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada', codigo: 'no_encontrado' }));

  app.use('/comprobante', require('./routes/comprobante'));

  // Script de seguimiento web: se incrusta desde la página del negocio (otro dominio).
  app.get('/marketing/palmira-seguimiento.js', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type('application/javascript').sendFile(SCRIPT_SEGUIMIENTO);
  });

  // Archivos estáticos del build de Vite: index.html y sw.js siempre se revalidan; /assets (con huella) se cachea un año.
  app.use(express.static(PUBLIC_DIR, {
    index: false,
    dotfiles: 'deny',
    setHeaders: (res, p) => {
      const nombre = path.basename(p);
      if (nombre === 'index.html' || nombre === 'sw.js' || nombre.endsWith('.webmanifest')) res.setHeader('Cache-Control', 'no-cache');
      else if (/[\\/]assets[\\/]/.test(p) || /[\\/](icons|vendor)[\\/]/.test(p)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  // Aplicación de una sola página: cualquier otra ruta GET devuelve index.html.
  app.get(/^\/(?!api\/|comprobante\/).*/, (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    const indice = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(indice)) return res.sendFile(indice);
    res.status(503).type('html').send('<!doctype html><meta charset="utf-8"><title>Licores Palmira</title><body style="font-family:sans-serif;background:#120f0c;color:#f6efe4;padding:40px"><h1>Licores Palmira · API en funcionamiento</h1><p>La interfaz aún no está compilada. En desarrollo ábrela en <b>http://localhost:5173</b> (npm run dev); para producción ejecuta <b>npm run build</b>.</p></body>');
  });
  app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada', codigo: 'no_encontrado' }));

  // Manejo de errores uniforme en JSON: nunca se envían trazas al cliente.
  // eslint-disable-next-line no-unused-vars
  app.use((e, req, res, next) => {
    if (res.headersSent) return;
    if (e && e.type === 'entity.too.large') return res.status(413).json({ error: 'El archivo o los datos enviados son demasiado grandes', codigo: 'muy_grande' });
    if (e && e.type === 'entity.parse.failed') return res.status(400).json({ error: 'Cuerpo de la petición inválido', codigo: 'json_invalido' });
    if (e instanceof ErrorApp || (e && e.status && e.status < 500)) {
      const status = e.status || 400;
      return res.status(status).json({ error: e.message, codigo: e.codigo || 'error', ...(e.extra || {}) });
    }
    log.error('error no controlado', { metodo: req.method, ruta: req.originalUrl, error: e && e.stack ? e.stack : String(e) });
    res.status(500).json({ error: 'Error interno del servidor', codigo: 'interno' });
  });
  return app;
}

function iniciar(puerto = config.PORT) {
  for (const aviso of config.advertenciasProduccion()) log.warn(aviso);
  if (!HAY_BUILD) log.warn(config.PRODUCCION ? 'No existe frontend/dist: ejecuta `npm run build` en la raíz del proyecto.' : 'Interfaz en desarrollo: ábrela con Vite en http://localhost:5173');
  const db = getDb();
  require('./arranque').preparar(db);
  const app = crearApp();
  const servidor = app.listen(puerto, config.HOST, () => {
    log.info(`Licores Palmira · Gestión ${require('../package.json').version} escuchando en http://${config.HOST === '0.0.0.0' ? 'localhost' : config.HOST}:${puerto}`, { entorno: config.NODE_ENV, datos: config.DATA_DIR, interfaz: HAY_BUILD ? path.relative(config.RAIZ, PUBLIC_DIR) : 'vite (desarrollo)' });
  });
  servidor.headersTimeout = 65000;
  servidor.requestTimeout = 120000;

  // Apagado ordenado: termina las peticiones en curso y cierra la base de datos.
  const apagar = (senal) => {
    log.info(`Señal ${senal}: cerrando servidor…`);
    servidor.close(() => { cerrarDb(); process.exit(0); });
    setTimeout(() => { cerrarDb(); process.exit(0); }, 10000).unref();
  };
  process.once('SIGTERM', () => apagar('SIGTERM'));
  process.once('SIGINT', () => apagar('SIGINT'));
  return servidor;
}

process.on('unhandledRejection', (e) => log.error('promesa rechazada sin manejar', { error: e && e.stack ? e.stack : String(e) }));

if (require.main === module) {
  try { iniciar(); } catch (e) {
    console.error(`\n[Licores Palmira] No se pudo iniciar: ${e.message}\n`);
    process.exit(1);
  }
}

module.exports = { crearApp, iniciar };
