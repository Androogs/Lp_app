'use strict';
// Autenticación y sesiones.
//  - Contraseñas: bcrypt (ver seguridad.js); los hash scrypt de versiones anteriores se migran solos al iniciar sesión.
//  - Sesión: token aleatorio de 256 bits en cookie HttpOnly + SameSite=Lax (+ Secure y prefijo __Host- con HTTPS).
//    En la base solo se guarda la huella SHA-256 del token. Expira por tiempo absoluto y por inactividad.
//  - CSRF: cada sesión tiene un token propio que el cliente envía en la cabecera X-CSRF-Token en toda petición que
//    modifica datos; además toda escritura en /api exige la cabecera X-Requested-With (fuerza preflight CORS).
//  - Integraciones: cabecera X-Api-Token (se compara contra la huella guardada en configuración).
const config = require('./config');
const { getDb, getConfig } = require('./db');
const { err, ahora } = require('./util');
const { permisosDeRol, tiene } = require('./permisos');
const seg = require('./seguridad');

const COOKIE = config.COOKIE_SECURE ? '__Host-palmira_sid' : 'palmira_sid';
const CABECERA_APP = 'PalmiraGestion';
const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PERMISOS_API = ['documentos.ver', 'documentos.procesar', 'inventario.ver', 'ventas.ver', 'compras.ver', 'clientes.ver', 'creditos.ver', 'reportes.ver'];

const hashClave = seg.hashClave;
const verificarClave = seg.verificarClave;
const validarFortaleza = seg.validarFortaleza;

function leerCookies(req) {
  const salida = {};
  const raw = req.headers.cookie;
  if (!raw) return salida;
  for (const parte of raw.split(';')) {
    const i = parte.indexOf('=');
    if (i <= 0) continue;
    try { salida[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim()); } catch { /* cookie malformada */ }
  }
  return salida;
}

const fechaEn = (ms) => ahora(new Date(Date.now() + ms));
function escribirCookie(res, valor, maxAgeSeg) {
  const partes = [`${COOKIE}=${valor}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeg}`];
  if (config.COOKIE_SECURE) partes.push('Secure');
  res.append('Set-Cookie', partes.join('; '));
}

function crearSesion(db, usuario, req, res) {
  // Rotación: si llegaba con una sesión previa en este navegador, se elimina.
  const previo = leerCookies(req)[COOKIE];
  if (previo) db.prepare('DELETE FROM sesiones WHERE token_hash = ?').run(seg.sha256(previo));
  const token = seg.tokenAleatorio(32);
  const csrf = seg.tokenAleatorio(32);
  db.prepare('INSERT INTO sesiones(token_hash, usuario_id, csrf_token, creado_en, ultimo_uso, expira_en, user_agent, ip) VALUES (?,?,?,?,?,?,?,?)')
    .run(seg.sha256(token), usuario.id, csrf, ahora(), ahora(), fechaEn(config.SESSION_HOURS * 3600 * 1000), String(req.headers['user-agent'] || '').slice(0, 300), req.ip || '');
  db.prepare('UPDATE usuarios SET ultimo_acceso = ?, intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = ?').run(ahora(), usuario.id);
  escribirCookie(res, token, Math.round(config.SESSION_HOURS * 3600));
  return { csrf };
}

function cerrarSesion(db, req, res) {
  const token = leerCookies(req)[COOKIE];
  if (token) db.prepare('DELETE FROM sesiones WHERE token_hash = ?').run(seg.sha256(token));
  escribirCookie(res, '', 0);
}

function limpiarSesionesVencidas(db) {
  const limite = ahora(new Date(Date.now() - config.SESSION_IDLE_MINUTES * 60 * 1000));
  return db.prepare('DELETE FROM sesiones WHERE expira_en < ? OR ultimo_uso < ?').run(ahora(), limite).changes;
}

// admin = empleador; vendedor y cajero = vendedor; otros roles no venden.
function tipoPorRol(rol) { return rol === 'admin' ? 'empleador' : ['vendedor', 'cajero'].includes(rol) ? 'vendedor' : 'otro'; }

function cargarUsuario(db, usuarioId) {
  const u = db.prepare('SELECT id, nombre, usuario, email, telefono, rol, activo, debe_cambiar_clave, salario_mensual, comision_pct, tipo_comercial FROM usuarios WHERE id = ?').get(usuarioId);
  if (!u || !u.activo) return null;
  u.permisos = permisosDeRol(u.rol, getConfig(db, 'permisos_roles'));
  if (!u.tipo_comercial) u.tipo_comercial = tipoPorRol(u.rol);
  return u;
}

// Lo que el propio usuario ve de sí mismo.
function usuarioPublico(u) {
  return { id: u.id, nombre: u.nombre, usuario: u.usuario, email: u.email, telefono: u.telefono, rol: u.rol, debe_cambiar_clave: !!u.debe_cambiar_clave, permisos: [...u.permisos], tipo_comercial: u.tipo_comercial || tipoPorRol(u.rol), salario_mensual: u.salario_mensual ?? null, comision_pct: u.comision_pct ?? null };
}

const esRutaPublica = (req) => String(req.originalUrl || req.url || '').startsWith('/api/publico/');
// Rutas de acceso: no requieren el token CSRF de la sesión (aún no hay sesión o se está creando una nueva).
const SIN_CSRF = new Set(['/api/auth/login', '/api/auth/recuperar', '/api/auth/restablecer']);
const exentaCsrf = (req) => SIN_CSRF.has(String(req.originalUrl || req.url || '').split('?')[0]);

// Middleware: identifica al usuario (sesión o token de API) y aplica la protección CSRF.
function autenticar(req, res, next) {
  req.usuario = null;
  const db = getDb();
  const escritura = !METODOS_SEGUROS.has(req.method);
  const esApiRuta = String(req.originalUrl || req.url || '').startsWith('/api/');

  // Integraciones (n8n): token de API en cabecera. No usa cookies, por eso no aplica CSRF.
  const tokenApi = req.headers['x-api-token'];
  if (tokenApi) {
    const esperado = getConfig(db, 'api_token_hash');
    if (esperado && seg.igualesSeguro(seg.sha256(tokenApi), esperado)) {
      req.usuario = { id: null, nombre: 'Integración API', usuario: 'api', rol: 'api', permisos: new Set(PERMISOS_API) };
      req.esApi = true;
      return next();
    }
    return next(err.noAuth('Token de API inválido'));
  }

  // Toda escritura en la API (salvo el seguimiento público) debe venir de la propia aplicación.
  if (escritura && esApiRuta && !esRutaPublica(req) && req.headers['x-requested-with'] !== CABECERA_APP) {
    return next(err.prohibido('Petición rechazada (cabecera de seguridad ausente)'));
  }

  const token = leerCookies(req)[COOKIE];
  if (!token || token.length > 100) return next();
  const s = db.prepare('SELECT id, usuario_id, csrf_token, expira_en, ultimo_uso FROM sesiones WHERE token_hash = ?').get(seg.sha256(token));
  if (!s) { escribirCookie(res, '', 0); return next(); }
  const ahoraTxt = ahora();
  const limiteInactividad = ahora(new Date(Date.now() - config.SESSION_IDLE_MINUTES * 60 * 1000));
  if (s.expira_en < ahoraTxt || s.ultimo_uso < limiteInactividad) {
    db.prepare('DELETE FROM sesiones WHERE id = ?').run(s.id);
    escribirCookie(res, '', 0);
    return next();
  }
  const usuario = cargarUsuario(db, s.usuario_id);
  if (!usuario) { db.prepare('DELETE FROM sesiones WHERE id = ?').run(s.id); escribirCookie(res, '', 0); return next(); }
  // Renueva la marca de actividad como máximo una vez por minuto (evita escribir en cada petición).
  if (s.ultimo_uso < ahora(new Date(Date.now() - 60 * 1000))) db.prepare('UPDATE sesiones SET ultimo_uso = ? WHERE id = ?').run(ahoraTxt, s.id);
  req.usuario = usuario;
  req.sesion = { id: s.id, csrf: s.csrf_token };

  if (escritura && esApiRuta && !esRutaPublica(req) && !exentaCsrf(req) && !seg.igualesSeguro(req.headers['x-csrf-token'], s.csrf_token)) {
    const e = err.prohibido('La sesión de seguridad expiró. Recarga la página e inténtalo de nuevo.');
    e.codigo = 'csrf_invalido';
    return next(e);
  }
  // Contraseña temporal (asignada por el administrador o inicial): solo se permite consultar y cambiarla.
  if (usuario.debe_cambiar_clave && escritura && esApiRuta && !String(req.originalUrl || '').startsWith('/api/auth/')) {
    const e = err.prohibido('Debes cambiar tu contraseña temporal en Configuración › Mi cuenta antes de continuar.');
    e.codigo = 'cambiar_clave';
    return next(e);
  }
  next();
}

function requiereAuth(req, res, next) {
  if (!req.usuario) return next(err.noAuth());
  next();
}
function requierePermiso(...permisos) {
  return (req, res, next) => {
    if (!req.usuario) return next(err.noAuth());
    if (permisos.some((p) => tiene(req.usuario, p))) return next();
    next(err.prohibido());
  };
}

module.exports = {
  COOKIE, CABECERA_APP, hashClave, verificarClave, validarFortaleza, crearSesion, cerrarSesion, limpiarSesionesVencidas,
  cargarUsuario, usuarioPublico, autenticar, requiereAuth, requierePermiso, leerCookies, tiene, tipoPorRol,
};
