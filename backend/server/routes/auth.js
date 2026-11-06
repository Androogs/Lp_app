'use strict';
// Inicio y cierre de sesión, sesión actual, cambio y recuperación de contraseña.
const express = require('express');
const crypto = require('node:crypto');
const config = require('../config');
const { getDb, getConfigTodo } = require('../db');
const { err, ahora, texto, ErrorApp } = require('../util');
const auth = require('../auth');
const seg = require('../seguridad');
const limites = require('../limites');
const auditoria = require('../services/auditoria');
const ocr = require('../services/ocr');
const caja = require('../services/caja');

const router = express.Router();
const MSG_CREDENCIALES = 'Usuario o contraseña incorrectos';
const msgBloqueo = () => `Demasiados intentos fallidos. Espera ${config.LOGIN_LOCK_MINUTES} minutos e inténtalo de nuevo.`;
const CODIGO_INTENTOS = 5;
const CODIGO_MINUTOS = 30;

// Bloqueo para nombres de usuario que no existen (misma respuesta que para los que sí: no revela cuáles existen).
const fallosDesconocidos = new Map();
function registrarFalloDesconocido(usuario) {
  if (fallosDesconocidos.size > 5000) fallosDesconocidos.clear();
  const e = fallosDesconocidos.get(usuario) || { n: 0, hasta: 0 };
  e.n += 1;
  if (e.n >= config.LOGIN_MAX_ATTEMPTS) { e.hasta = Date.now() + config.LOGIN_LOCK_MINUTES * 60000; e.n = 0; }
  fallosDesconocidos.set(usuario, e);
}
const desconocidoBloqueado = (usuario) => (fallosDesconocidos.get(usuario)?.hasta || 0) > Date.now();

function configPublica(db) {
  const c = getConfigTodo(db);
  return {
    negocio_nombre: c.negocio_nombre, negocio_nit: c.negocio_nit, negocio_direccion: c.negocio_direccion, negocio_telefono: c.negocio_telefono, negocio_ciudad: c.negocio_ciudad,
    metodos_pago: c.metodos_pago, categorias_gasto: c.categorias_gasto, descuento_maximo_pct: c.descuento_maximo_pct, permitir_stock_negativo: !!c.permitir_stock_negativo,
    dias_alerta_vencimiento: c.dias_alerta_vencimiento, ocr_disponible: ocr.disponible(), metodo_valoracion: c.metodo_valoracion,
    clave_min: config.PASSWORD_MIN_LENGTH, demo: config.MOSTRAR_DEMO,
    unidades_mayor: Number(c.unidades_mayor) || 10, domicilios: c.domicilios,
  };
}

const leerUsuario = (v) => texto(v, 'Usuario', { max: 60 }).toLowerCase().replace(/\s+/g, '');
const leerClave = (v) => { if (typeof v !== 'string' || !v || v.length > 200) throw err.noAuth(MSG_CREDENCIALES); return v; };

router.post('/login', limites.login, async (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const usuario = leerUsuario(b.usuario);
  const u = db.prepare('SELECT * FROM usuarios WHERE usuario = ?').get(usuario);
  if ((u && u.bloqueado_hasta && u.bloqueado_hasta > ahora()) || (!u && desconocidoBloqueado(usuario))) {
    throw new ErrorApp(429, msgBloqueo(), 'bloqueado');
  }
  let clave;
  try { clave = leerClave(b.clave); } catch (e) { if (!u) registrarFalloDesconocido(usuario); throw e; }
  const { ok, rehash } = await auth.verificarClave(clave, u ? u.password_hash : null);
  if (!u || !u.activo || !ok) {
    if (u) {
      const intentos = (u.intentos_fallidos || 0) + 1;
      if (intentos >= config.LOGIN_MAX_ATTEMPTS) {
        db.prepare('UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = ? WHERE id = ?').run(ahora(new Date(Date.now() + config.LOGIN_LOCK_MINUTES * 60000)), u.id);
        auditoria.registrar(db, null, 'cuenta_bloqueada', 'usuario', u.id, { minutos: config.LOGIN_LOCK_MINUTES }, req.ip);
      } else db.prepare('UPDATE usuarios SET intentos_fallidos = ? WHERE id = ?').run(intentos, u.id);
    } else registrarFalloDesconocido(usuario);
    auditoria.registrar(db, null, 'login_fallido', 'usuario', usuario.slice(0, 60), null, req.ip);
    throw err.noAuth(MSG_CREDENCIALES);
  }
  if (rehash) db.prepare('UPDATE usuarios SET password_hash = ? WHERE id = ?').run(await auth.hashClave(clave), u.id);
  const { csrf } = auth.crearSesion(db, u, req, res);
  auditoria.registrar(db, u, 'login', 'usuario', u.id, null, req.ip);
  const cargado = auth.cargarUsuario(db, u.id);
  res.json({ usuario: auth.usuarioPublico(cargado), config: configPublica(db), caja: caja.sesionAbierta(db), csrf });
});

router.post('/logout', (req, res) => {
  const db = getDb();
  if (req.usuario) auditoria.registrar(db, req.usuario, 'logout', 'usuario', req.usuario.id, null, req.ip);
  auth.cerrarSesion(db, req, res);
  res.json({ ok: true });
});

router.get('/yo', (req, res) => {
  const db = getDb();
  res.setHeader('Cache-Control', 'no-store');
  if (!req.usuario || req.esApi) return res.status(401).json({ error: 'No autenticado', codigo: 'no_autenticado', config: { negocio_nombre: getConfigTodo(db).negocio_nombre, demo: config.MOSTRAR_DEMO, clave_min: config.PASSWORD_MIN_LENGTH } });
  res.json({ usuario: auth.usuarioPublico(req.usuario), config: configPublica(db), caja: caja.sesionAbierta(db), csrf: req.sesion.csrf });
});

router.post('/cambiar-clave', auth.requiereAuth, async (req, res) => {
  if (req.esApi) throw err.prohibido();
  const db = getDb();
  const b = req.body || {};
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.usuario.id);
  const { ok } = await auth.verificarClave(typeof b.actual === 'string' ? b.actual : '', u.password_hash);
  if (!ok) throw err.datos('La contraseña actual no es correcta');
  auth.validarFortaleza(b.nueva, { usuario: u.usuario });
  if (b.nueva === b.actual) throw err.datos('La nueva contraseña debe ser distinta de la actual');
  db.prepare('UPDATE usuarios SET password_hash = ?, debe_cambiar_clave = 0, clave_cambiada_en = ? WHERE id = ?').run(await auth.hashClave(b.nueva), ahora(), u.id);
  db.prepare('DELETE FROM sesiones WHERE usuario_id = ? AND id <> ?').run(u.id, req.sesion.id);
  auditoria.registrar(db, req.usuario, 'cambiar_clave', 'usuario', u.id, null, req.ip);
  res.json({ ok: true });
});

// Recuperación: genera un código de 6 dígitos válido 30 minutos y 5 intentos. Se guarda cifrado (para que el administrador
// pueda verlo y entregarlo, ya que no hay correo configurado) y con su huella HMAC para verificarlo.
router.post('/recuperar', limites.recuperar, (req, res) => {
  const db = getDb();
  const usuario = leerUsuario((req.body || {}).usuario);
  const u = db.prepare('SELECT id FROM usuarios WHERE usuario = ? AND activo = 1').get(usuario);
  if (u) {
    const codigo = String(crypto.randomInt(100000, 1000000));
    db.prepare('UPDATE recuperacion_clave SET usado = 1 WHERE usuario_id = ? AND usado = 0').run(u.id);
    db.prepare('INSERT INTO recuperacion_clave(usuario_id, codigo, codigo_hash, expira_en) VALUES (?,?,?,?)')
      .run(u.id, seg.cifrar(codigo, 'recuperacion'), seg.hmac(`${u.id}:${codigo}`, 'recuperacion'), ahora(new Date(Date.now() + CODIGO_MINUTOS * 60000)));
    auditoria.registrar(db, null, 'solicitar_recuperacion', 'usuario', u.id, null, req.ip);
  }
  res.json({ ok: true, mensaje: `Si el usuario existe, se generó un código de recuperación válido por ${CODIGO_MINUTOS} minutos. Pídeselo al administrador del negocio.` });
});

router.post('/restablecer', limites.restablecer, async (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const usuario = leerUsuario(b.usuario);
  const codigo = texto(b.codigo, 'Código', { max: 10 }).replace(/\s+/g, '');
  const u = db.prepare('SELECT id, usuario FROM usuarios WHERE usuario = ? AND activo = 1').get(usuario);
  const r = u && db.prepare('SELECT * FROM recuperacion_clave WHERE usuario_id = ? AND usado = 0 AND expira_en > ? AND codigo_hash IS NOT NULL ORDER BY id DESC LIMIT 1').get(u.id, ahora());
  if (!r) throw err.datos('Código inválido o vencido');
  if (!seg.igualesSeguro(seg.hmac(`${u.id}:${codigo}`, 'recuperacion'), r.codigo_hash)) {
    const intentos = r.intentos + 1;
    db.prepare('UPDATE recuperacion_clave SET intentos = ?, usado = CASE WHEN ? >= ? THEN 1 ELSE usado END WHERE id = ?').run(intentos, intentos, CODIGO_INTENTOS, r.id);
    auditoria.registrar(db, null, 'codigo_recuperacion_fallido', 'usuario', u.id, { intentos }, req.ip);
    throw err.datos(intentos >= CODIGO_INTENTOS ? 'Código inválido. Se superó el número de intentos: solicita un código nuevo.' : 'Código inválido o vencido');
  }
  auth.validarFortaleza(b.nueva, { usuario: u.usuario });
  db.prepare('UPDATE usuarios SET password_hash = ?, debe_cambiar_clave = 0, clave_cambiada_en = ?, intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = ?').run(await auth.hashClave(b.nueva), ahora(), u.id);
  db.prepare('UPDATE recuperacion_clave SET usado = 1, codigo = NULL WHERE usuario_id = ?').run(u.id);
  db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(u.id);
  auditoria.registrar(db, null, 'restablecer_clave', 'usuario', u.id, null, req.ip);
  res.json({ ok: true });
});

module.exports = { router, configPublica };
