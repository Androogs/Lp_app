'use strict';
// Panel, reportes, configuración, usuarios, auditoría y respaldos.
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getDb, getConfigTodo, setConfig, CONFIG_DEFAULT, BACKUPS_DIR, DB_PATH } = require('../db');
const seg = require('../seguridad');
const { err, texto, csv, hoy, ahora, entero, booleano } = require('../util');
const auth = require('../auth');
const { requierePermiso } = auth;
const { PERMISOS, ROLES } = require('../permisos');
const dashboard = require('../services/dashboard');
const analitica = require('../services/analitica');
const reportes = require('../services/reportes');
const auditoria = require('../services/auditoria');
const ocr = require('../services/ocr');

const router = express.Router();
const nombreArchivo = (...partes) => partes.map((x) => String(x ?? '').replace(/[^\w.-]/g, '')).filter(Boolean).join('-').slice(0, 120) || 'reporte';

router.get('/dashboard', auth.requiereAuth, (req, res) => {
  res.json(dashboard.panel(getDb(), { periodo: req.query.periodo, desde: req.query.desde, hasta: req.query.hasta }));
});

// ---------- Analítica (paneles visuales) ----------
// Los costos y ganancias solo viajan a quien puede ver inventario; la actividad reciente, a quien ve auditoría.
const filtrosAnalitica = (q) => ({ periodo: q.periodo, desde: q.desde, hasta: q.hasta, dias: q.dias });
router.get('/analitica/panel', auth.requiereAuth, (req, res) => {
  const db = getDb();
  const d = analitica.panel(db, filtrosAnalitica(req.query), { verCostos: auth.tiene(req.usuario, 'inventario.ver'), verAuditoria: auth.tiene(req.usuario, 'auditoria.ver') });
  // Panel del empleador: rentabilidad por responsable y comisiones del periodo; panel del vendedor: solo lo propio.
  const comisiones = require('../services/comisiones');
  if (auth.tiene(req.usuario, 'comisiones.ver') || auth.tiene(req.usuario, 'comisiones.administrar')) d.comisiones = comisiones.resumen(db, filtrosAnalitica(req.query), { alcance: 'todos' });
  else if (auth.tiene(req.usuario, 'comisiones.ver_propias')) d.comisiones = comisiones.resumen(db, filtrosAnalitica(req.query), { alcance: 'propio', usuarioId: req.usuario.id });
  if (auth.tiene(req.usuario, 'domicilios.ver')) d.domicilios = require('../services/domicilios').resumen(db);
  res.json(d);
});
router.get('/analitica/ventas', requierePermiso('ventas.ver'), (req, res) => res.json(analitica.ventas(getDb(), filtrosAnalitica(req.query), { verCostos: auth.tiene(req.usuario, 'inventario.ver') })));
router.get('/analitica/inventario', requierePermiso('inventario.ver'), (req, res) => res.json(analitica.inventario(getDb(), filtrosAnalitica(req.query), { verCostos: true })));
router.get('/analitica/finanzas', requierePermiso('contabilidad.ver', 'caja.ver'), (req, res) => res.json(analitica.finanzas(getDb(), filtrosAnalitica(req.query))));
router.get('/analitica/clientes', requierePermiso('clientes.ver'), (req, res) => res.json(analitica.clientes(getDb(), filtrosAnalitica(req.query))));
router.get('/analitica/compras', requierePermiso('compras.ver', 'proveedores.ver'), (req, res) => res.json(analitica.compras(getDb(), filtrosAnalitica(req.query))));

// ---------- Reportes ----------
router.get('/reportes', requierePermiso('reportes.ver'), (req, res) => res.json(reportes.lista()));
router.get('/reportes/:clave', requierePermiso('reportes.ver'), async (req, res) => {
  const r = reportes.generar(getDb(), req.params.clave, req.query);
  if (!r) throw err.noEncontrado('Reporte no existe');
  if (req.query.formato === 'pdf') {
    const buffer = await require('../services/pdf').reportePdf(getDb(), r);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.descargar ? 'attachment' : 'inline'}; filename="${nombreArchivo(r.clave, r.filtros.desde || 'todo', r.filtros.hasta || hoy())}.pdf"`);
    return res.send(buffer);
  }
  if (req.query.formato === 'csv') {
    const contenido = csv(r.filas, r.columnas);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo(r.clave, r.filtros.desde || 'todo', r.filtros.hasta || hoy())}.csv"`);
    return res.send(contenido);
  }
  res.json(r);
});

// ---------- Configuración ----------
const CLAVES_EDITABLES = ['negocio_nombre', 'negocio_nit', 'negocio_direccion', 'negocio_telefono', 'negocio_ciudad', 'mensaje_comprobante', 'permitir_stock_negativo', 'descuento_maximo_pct', 'dias_alerta_vencimiento', 'metodos_pago', 'categorias_gasto', 'dias_sin_movimiento', 'ocr_modelo', 'permisos_roles', 'metodo_valoracion', 'trm_frecuencia_minutos', 'mercado_frecuencia_minutos', 'unidades_mayor', 'domicilios', 'comisiones', 'asistente'];
// Valida los parámetros de domicilios y de comisiones (solo números en rango; nada de código).
function validarDomicilios(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw err.datos('Parámetros de domicilios inválidos');
  const base = CONFIG_DEFAULT.domicilios;
  const leer = (k, nombre, max) => entero(v[k] ?? base[k], nombre, { min: 0, max });
  return {
    cargo_envio_defecto: leer('cargo_envio_defecto', 'Valor del envío por defecto', 1000000),
    envio_gratis_desde: leer('envio_gratis_desde', 'Envío gratis desde', 100000000),
    minutos_alerta_preparacion: leer('minutos_alerta_preparacion', 'Minutos de alerta en bodega', 1440),
    minutos_alerta_camino: leer('minutos_alerta_camino', 'Minutos de alerta en camino', 1440),
  };
}
function validarComisiones(v) {
  if (!v || typeof v !== 'object') throw err.datos('Parámetros de comisiones inválidos');
  const salida = { salario_defecto: entero(v.salario_defecto ?? CONFIG_DEFAULT.comisiones.salario_defecto, 'Salario por defecto', { min: 0, max: 1000000000 }), comision_pct_defecto: Number(v.comision_pct_defecto ?? CONFIG_DEFAULT.comisiones.comision_pct_defecto), devengo: v.devengo === 'cobro' ? 'cobro' : 'confirmacion', empleador_comisiona: booleano(v.empleador_comisiona) };
  if (!Number.isFinite(salida.comision_pct_defecto) || salida.comision_pct_defecto < 0 || salida.comision_pct_defecto > 100) throw err.datos('El porcentaje de comisión debe estar entre 0 y 100');
  return salida;
}
// Asistente Tino: solo opciones de comportamiento (activo, motor, proveedor, modelo, esfuerzo, límite por hora, voz, nombre, avisos).
// La clave del proveedor vive en variables de entorno y NUNCA se guarda aquí. Los campos no enviados conservan su valor.
function validarAsistente(v, db) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw err.datos('Parámetros del asistente inválidos');
  const { opcion } = require('../util');
  const { getConfig } = require('../db');
  const guardado = getConfig(db, 'asistente');
  const salida = { ...CONFIG_DEFAULT.asistente, esfuerzo: 'low', ...(guardado && typeof guardado === 'object' ? guardado : {}) };
  if (v.activo !== undefined) salida.activo = booleano(v.activo, true);
  if (v.proveedor !== undefined) salida.proveedor = opcion(v.proveedor, 'Proveedor del asistente', ['anthropic', 'openrouter']);
  if (v.modelo !== undefined) {
    const m = texto(v.modelo, 'Modelo del asistente', { max: 80, opcional: true, defecto: CONFIG_DEFAULT.asistente.modelo });
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(m)) throw err.datos('El nombre del modelo solo admite letras, números, puntos, guiones, ":" y "/"');
    salida.modelo = m;
  }
  if (v.esfuerzo !== undefined) salida.esfuerzo = opcion(v.esfuerzo, 'Esfuerzo del asistente', ['low', 'medium', 'high']);
  if (v.limite_mensajes_hora !== undefined) salida.limite_mensajes_hora = entero(v.limite_mensajes_hora, 'Límite de mensajes por hora', { min: 1, max: 1000 });
  if (v.voz !== undefined) salida.voz = booleano(v.voz, true);
  if (v.nombre !== undefined) salida.nombre = texto(v.nombre, 'Nombre del asistente', { max: 40, opcional: true, defecto: 'Tino' });
  if (v.motor !== undefined) salida.motor = opcion(v.motor, 'Motor del asistente', ['auto', 'local', 'ia']);
  if (v.avisos !== undefined) salida.avisos = booleano(v.avisos, true);
  if (v.dias_cobertura !== undefined) salida.dias_cobertura = entero(v.dias_cobertura, 'Días de cobertura para avisos de inventario', { min: 1, max: 60 });
  return salida;
}
router.get('/configuracion', requierePermiso('config.ver'), (req, res) => {
  const c = getConfigTodo(getDb());
  // El token de API solo se muestra completo en el momento de generarlo; después solo se indica si existe.
  c.api_token = c.api_token_hash ? '•••••••••••••••• (generado · por seguridad solo se muestra al crearlo)' : '';
  delete c.api_token_hash;
  c.ocr_disponible = ocr.disponible();
  c.permisos_catalogo = PERMISOS.map(([clave, nombre]) => ({ clave, nombre }));
  c.roles = Object.entries(ROLES).map(([clave, r]) => ({ clave, nombre: r.nombre, permisos_defecto: r.permisos }));
  res.json(c);
});
router.put('/configuracion', requierePermiso('config.editar'), (req, res) => {
  const db = getDb();
  const cambios = {};
  for (const clave of CLAVES_EDITABLES) {
    if (req.body[clave] === undefined) continue;
    let valor = req.body[clave];
    if (['metodos_pago', 'categorias_gasto'].includes(clave)) {
      if (!Array.isArray(valor) || !valor.length) throw err.datos(`${clave} debe ser una lista con al menos un elemento`);
      valor = valor.map((v) => texto(v, clave, { max: 40 }));
    } else if (clave === 'permisos_roles') {
      if (req.usuario.rol !== 'admin') throw err.prohibido('Solo un administrador puede cambiar los permisos de los roles');
      if (valor !== null && typeof valor !== 'object') throw err.datos('permisos_roles inválido');
      if (valor) for (const rol of Object.keys(valor)) {
        if (!ROLES[rol] || rol === 'admin') { delete valor[rol]; continue; }
        // Cada rol debe traer una lista de claves de permiso; otro tipo (texto, número, null) es un 400 y no un 500.
        if (!Array.isArray(valor[rol])) throw err.datos(`permisos_roles.${rol} debe ser una lista de permisos`);
        valor[rol] = [...new Set(valor[rol].filter((p) => typeof p === 'string' && PERMISOS.some(([k]) => k === p)))];
      }
    } else if (['descuento_maximo_pct', 'dias_alerta_vencimiento', 'dias_sin_movimiento'].includes(clave)) {
      valor = entero(valor, clave, { min: 0, max: 100000 });
    } else if (['trm_frecuencia_minutos', 'mercado_frecuencia_minutos'].includes(clave)) {
      valor = entero(valor, clave, { min: 5, max: 1440 });
    } else if (clave === 'metodo_valoracion') {
      valor = String(valor).toUpperCase();
      if (!['FIFO', 'PROMEDIO'].includes(valor)) throw err.datos('Método de valoración inválido (FIFO o PROMEDIO)');
    } else if (clave === 'domicilios') {
      valor = validarDomicilios(valor);
    } else if (clave === 'unidades_mayor') {
      valor = entero(valor, 'Unidades para precio mayorista', { min: 1, max: 10000 });
    } else if (clave === 'comisiones') {
      valor = validarComisiones(valor);
    } else if (clave === 'asistente') {
      valor = validarAsistente(valor, db);
    } else if (clave === 'permitir_stock_negativo') {
      valor = booleano(valor);
    } else {
      valor = texto(valor, clave, { opcional: true, max: 500, defecto: '' });
    }
    setConfig(db, clave, valor);
    cambios[clave] = valor;
  }
  auditoria.registrar(db, req.usuario, 'editar_configuracion', 'configuracion', null, cambios, req.ip);
  res.json({ ok: true, cambios });
});
router.post('/configuracion/api-token', requierePermiso('config.editar'), (req, res) => {
  const db = getDb();
  const token = crypto.randomBytes(32).toString('hex');
  setConfig(db, 'api_token_hash', seg.sha256(token));
  auditoria.registrar(db, req.usuario, 'regenerar_api_token', 'configuracion', null, null, req.ip);
  res.json({ api_token: token });
});

// ---------- Usuarios ----------
// Datos de remuneración de un usuario (salario, % comisión, tipo comercial): solo con comisiones.administrar.
function remuneracionDesde(b, req) {
  if (!auth.tiene(req.usuario, 'comisiones.administrar')) {
    if (b.salario_mensual !== undefined || b.comision_pct !== undefined || b.tipo_comercial !== undefined) throw err.prohibido('No tienes permiso para modificar salarios, comisiones o el tipo comercial');
    return {};
  }
  const r = {};
  if (b.salario_mensual !== undefined) r.salario_mensual = b.salario_mensual === null || b.salario_mensual === '' ? null : entero(b.salario_mensual, 'Salario mensual', { min: 0, max: 1000000000 });
  if (b.comision_pct !== undefined) { r.comision_pct = b.comision_pct === null || b.comision_pct === '' ? null : Number(b.comision_pct); if (r.comision_pct !== null && (!Number.isFinite(r.comision_pct) || r.comision_pct < 0 || r.comision_pct > 100)) throw err.datos('El porcentaje de comisión debe estar entre 0 y 100'); }
  if (b.tipo_comercial !== undefined) { if (b.tipo_comercial && !['vendedor', 'empleador'].includes(b.tipo_comercial)) throw err.datos('Tipo comercial inválido'); r.tipo_comercial = b.tipo_comercial || null; }
  return r;
}
router.get('/usuarios', requierePermiso('usuarios.administrar', 'ventas.crear', 'comisiones.ver', 'domicilios.despachar'), (req, res) => {
  const db = getDb();
  const filas = db.prepare('SELECT id, nombre, usuario, email, telefono, rol, activo, debe_cambiar_clave, creado_en, ultimo_acceso, salario_mensual, comision_pct, tipo_comercial FROM usuarios ORDER BY activo DESC, nombre').all()
    .map((u) => ({ ...u, tipo_comercial: u.tipo_comercial || require('../services/comisiones').tipoPorRol(u.rol) }));
  if (!auth.tiene(req.usuario, 'usuarios.administrar') && !auth.tiene(req.usuario, 'comisiones.administrar')) return res.json(filas.filter((u) => u.activo).map((u) => ({ id: u.id, nombre: u.nombre, rol: u.rol, tipo_comercial: u.tipo_comercial })));
  if (!auth.tiene(req.usuario, 'comisiones.administrar')) return res.json(filas.map((u) => ({ ...u, salario_mensual: undefined, comision_pct: undefined })));
  res.json(filas);
});
router.post('/usuarios', requierePermiso('usuarios.administrar'), async (req, res) => {
  const db = getDb();
  const b = req.body;
  const nombre = texto(b.nombre, 'Nombre', { max: 120 });
  const usuario = texto(b.usuario, 'Usuario', { max: 60 }).toLowerCase().replace(/\s+/g, '');
  if (!/^[a-z0-9._-]{3,60}$/.test(usuario)) throw err.datos('El usuario solo puede tener letras sin tilde, números, punto, guion y guion bajo (mínimo 3)');
  if (!ROLES[b.rol]) throw err.datos('Rol inválido');
  if (b.rol === 'admin' && req.usuario.rol !== 'admin') throw err.prohibido('Solo un administrador puede crear administradores');
  const email = texto(b.email, 'Correo', { opcional: true, max: 120 });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw err.datos('El correo no es válido');
  auth.validarFortaleza(b.clave, { usuario });
  const hash = await auth.hashClave(b.clave);
  if (db.prepare('SELECT id FROM usuarios WHERE usuario = ?').get(usuario)) throw err.conflicto('Ese nombre de usuario ya existe');
  const rem = remuneracionDesde(b, req);
  const r = db.prepare('INSERT INTO usuarios(nombre, usuario, email, telefono, password_hash, rol, debe_cambiar_clave, salario_mensual, comision_pct, tipo_comercial) VALUES (?,?,?,?,?,?,1,?,?,?)')
    .run(nombre, usuario, email, texto(b.telefono, 'Teléfono', { opcional: true, max: 40 }), hash, b.rol, rem.salario_mensual ?? null, rem.comision_pct ?? null, rem.tipo_comercial ?? null);
  const id = Number(r.lastInsertRowid);
  auditoria.registrar(db, req.usuario, 'crear_usuario', 'usuario', id, { nombre, usuario, rol: b.rol, ...rem }, req.ip);
  res.status(201).json(db.prepare('SELECT id, nombre, usuario, email, telefono, rol, activo, debe_cambiar_clave, salario_mensual, comision_pct, tipo_comercial FROM usuarios WHERE id = ?').get(id));
});
router.put('/usuarios/:id', requierePermiso('usuarios.administrar'), (req, res) => {
  const db = getDb();
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(Number(req.params.id));
  if (!u) throw err.noEncontrado('Usuario no existe');
  const b = req.body;
  const rol = b.rol ? (ROLES[b.rol] ? b.rol : null) : u.rol;
  if (!rol) throw err.datos('Rol inválido');
  if ((rol === 'admin' || u.rol === 'admin') && req.usuario.rol !== 'admin') throw err.prohibido('Solo un administrador puede modificar cuentas de administrador');
  const activo = b.activo === undefined ? u.activo : (booleano(b.activo) ? 1 : 0);
  if (u.id === req.usuario.id && (!activo || rol !== 'admin')) throw err.conflicto('No puedes desactivarte ni quitarte el rol de administrador');
  if (rol !== 'admin' && u.rol === 'admin') {
    const admins = db.prepare("SELECT COUNT(*) n FROM usuarios WHERE rol = 'admin' AND activo = 1 AND id <> ?").get(u.id).n;
    if (!admins) throw err.conflicto('Debe quedar al menos un administrador activo');
  }
  const rem = remuneracionDesde(b, req);
  db.prepare('UPDATE usuarios SET nombre = ?, email = ?, telefono = ?, rol = ?, activo = ?, salario_mensual = ?, comision_pct = ?, tipo_comercial = ? WHERE id = ?')
    .run(texto(b.nombre ?? u.nombre, 'Nombre', { max: 120 }), texto(b.email ?? u.email, 'Correo', { opcional: true, max: 120 }), texto(b.telefono ?? u.telefono, 'Teléfono', { opcional: true, max: 40 }), rol, activo,
      rem.salario_mensual !== undefined ? rem.salario_mensual : u.salario_mensual, rem.comision_pct !== undefined ? rem.comision_pct : u.comision_pct, rem.tipo_comercial !== undefined ? rem.tipo_comercial : u.tipo_comercial, u.id);
  if (!activo) db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(u.id);
  const cambiosRem = {};
  for (const k of Object.keys(rem)) if (rem[k] !== u[k]) cambiosRem[k] = { antes: u[k], despues: rem[k] };
  auditoria.registrar(db, req.usuario, Object.keys(cambiosRem).length ? 'editar_remuneracion_usuario' : 'editar_usuario', 'usuario', u.id, { rol, activo, nombre: b.nombre, ...cambiosRem }, req.ip);
  res.json(db.prepare('SELECT id, nombre, usuario, email, telefono, rol, activo, debe_cambiar_clave, salario_mensual, comision_pct, tipo_comercial FROM usuarios WHERE id = ?').get(u.id));
});
router.post('/usuarios/:id/restablecer-clave', requierePermiso('usuarios.administrar'), async (req, res) => {
  const db = getDb();
  const u = db.prepare('SELECT id, usuario FROM usuarios WHERE id = ?').get(Number(req.params.id));
  if (!u) throw err.noEncontrado('Usuario no existe');
  if (db.prepare('SELECT rol FROM usuarios WHERE id = ?').get(u.id).rol === 'admin' && req.usuario.rol !== 'admin') throw err.prohibido('Solo un administrador puede restablecer la contraseña de otro administrador');
  auth.validarFortaleza(req.body.nueva, { usuario: u.usuario });
  db.prepare('UPDATE usuarios SET password_hash = ?, debe_cambiar_clave = 1, intentos_fallidos = 0, bloqueado_hasta = NULL, clave_cambiada_en = ? WHERE id = ?').run(await auth.hashClave(req.body.nueva), ahora(), u.id);
  db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(u.id);
  auditoria.registrar(db, req.usuario, 'restablecer_clave_admin', 'usuario', u.id, null, req.ip);
  res.json({ ok: true });
});
router.get('/usuarios/:id/codigo-recuperacion', requierePermiso('usuarios.administrar'), (req, res) => {
  const db = getDb();
  const r = db.prepare('SELECT codigo, expira_en FROM recuperacion_clave WHERE usuario_id = ? AND usado = 0 AND expira_en > ? AND codigo_hash IS NOT NULL ORDER BY id DESC LIMIT 1').get(Number(req.params.id), ahora());
  const codigo = r ? seg.descifrar(r.codigo, 'recuperacion') : null;
  if (codigo) auditoria.registrar(db, req.usuario, 'ver_codigo_recuperacion', 'usuario', Number(req.params.id), null, req.ip);
  res.setHeader('Cache-Control', 'no-store');
  res.json(codigo ? { codigo, expira_en: r.expira_en } : { codigo: null });
});

// ---------- Auditoría ----------
router.get('/auditoria', requierePermiso('auditoria.ver'), (req, res) => res.json(auditoria.listar(getDb(), req.query)));

// ---------- Respaldos ----------
function crearRespaldo(db) {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const nombre = `respaldo-${hoy()}-${ahora().slice(11).replace(/:/g, '')}.db`;
  const destino = path.join(BACKUPS_DIR, nombre);
  if (fs.existsSync(destino)) fs.unlinkSync(destino);
  db.prepare('VACUUM INTO ?').run(destino);
  return { nombre, ruta: destino, tamano: fs.statSync(destino).size };
}
router.get('/respaldos', requierePermiso('config.ver'), (req, res) => {
  const dir = BACKUPS_DIR;
  const lista = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.db')).map((f) => ({ nombre: f, tamano: fs.statSync(path.join(dir, f)).size, fecha: fs.statSync(path.join(dir, f)).mtime })).sort((a, b) => b.fecha - a.fecha) : [];
  res.json({ respaldos: lista, base_datos: path.basename(DB_PATH) });
});
router.post('/respaldos', requierePermiso('config.editar'), (req, res) => {
  const db = getDb();
  const r = crearRespaldo(db);
  auditoria.registrar(db, req.usuario, 'crear_respaldo', 'respaldo', r.nombre, { tamano: r.tamano }, req.ip);
  res.status(201).json(r);
});
router.get('/respaldos/descargar', requierePermiso('config.editar'), (req, res) => {
  const db = getDb();
  const r = crearRespaldo(db);
  auditoria.registrar(db, req.usuario, 'descargar_respaldo', 'respaldo', r.nombre, null, req.ip);
  res.download(r.ruta, r.nombre);
});

module.exports = { router, crearRespaldo };
