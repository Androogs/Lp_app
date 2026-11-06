'use strict';
// Productos, categorías, clientes y proveedores.
const express = require('express');
const { getDb } = require('../db');
const { err, texto, booleano } = require('../util');
const { requierePermiso } = require('../auth');
const { tiene } = require('../permisos');
const productos = require('../services/productos');
const inventario = require('../services/inventario');
const compras = require('../services/compras');
const creditos = require('../services/creditos');
const archivos = require('../services/archivos');
const auditoria = require('../services/auditoria');

const router = express.Router();

// ---------- Productos ----------
router.get('/productos', requierePermiso('inventario.ver', 'ventas.crear', 'domicilios.crear'), (req, res) => {
  const q = req.query;
  res.json(productos.listar(getDb(), { q: q.q, categoria_id: q.categoria_id, estado: q.estado, stock_bajo: booleano(q.stock_bajo), agotados: booleano(q.agotados), orden: q.orden === 'vendidos' ? 'vendidos' : undefined, limite: q.limite, pagina: q.pagina }));
});
router.get('/productos/codigo/:codigo', requierePermiso('inventario.ver', 'ventas.crear'), (req, res) => {
  const p = productos.buscarPorCodigo(getDb(), req.params.codigo);
  if (!p) return res.status(404).json({ error: 'No hay ningún producto con ese código', codigo: 'no_encontrado' });
  res.json(p);
});
router.get('/productos/:id', requierePermiso('inventario.ver', 'ventas.crear'), (req, res) => {
  const p = productos.obtener(getDb(), Number(req.params.id));
  if (!tiene(req.usuario, 'inventario.ver')) { delete p.lotes; delete p.historial_precios; delete p.proveedores; }
  res.json(p);
});
router.post('/productos', requierePermiso('inventario.editar'), (req, res) => {
  res.status(201).json(productos.crear(getDb(), req.body, req.usuario));
});
router.put('/productos/:id', requierePermiso('inventario.editar', 'inventario.cambiar_precio'), (req, res) => {
  res.json(productos.actualizar(getDb(), Number(req.params.id), req.body, req.usuario));
});
router.post('/productos/:id/fotos', requierePermiso('inventario.editar'), (req, res) => {
  const db = getDb();
  productos.obtener(db, Number(req.params.id));
  const archivo = archivos.guardarDesdeBase64(req.body.imagen || req.body.archivo, req.body.mime, req.body.nombre);
  res.status(201).json(productos.agregarFoto(db, Number(req.params.id), archivo, req.usuario));
});
router.delete('/productos/:id/fotos/:fotoId', requierePermiso('inventario.editar'), (req, res) => {
  const f = productos.eliminarFoto(getDb(), Number(req.params.id), Number(req.params.fotoId), req.usuario);
  archivos.eliminar(f.ruta);
  res.json({ ok: true });
});
router.post('/productos/:id/ajuste', requierePermiso('inventario.ajustar'), (req, res) => {
  const b = req.body;
  res.json(inventario.ajustar(getDb(), { producto_id: Number(req.params.id), cantidad: Number(b.cantidad), motivo: texto(b.motivo, 'Motivo', { max: 300 }), costo_unitario: b.costo_unitario === undefined || b.costo_unitario === '' ? undefined : Number(b.costo_unitario), tipo: b.tipo }, req.usuario));
});
router.get('/productos/:id/kardex', requierePermiso('inventario.ver'), (req, res) => {
  res.json(inventario.kardex(getDb(), Number(req.params.id), { desde: req.query.desde, hasta: req.query.hasta }));
});
router.get('/productos/:id/proveedores', requierePermiso('inventario.ver', 'proveedores.ver'), (req, res) => {
  res.json(compras.compararProveedores(getDb(), Number(req.params.id)));
});

// ---------- Categorías ----------
router.get('/categorias', (req, res) => res.json(productos.categorias(getDb())));
router.post('/categorias', requierePermiso('inventario.editar'), (req, res) => res.status(201).json(productos.crearCategoria(getDb(), req.body, req.usuario)));
router.put('/categorias/:id', requierePermiso('inventario.editar'), (req, res) => res.json(productos.actualizarCategoria(getDb(), Number(req.params.id), req.body, req.usuario)));

// ---------- Clientes ----------
function validarPersona(b, existente = {}) {
  return {
    nombre: texto(b.nombre ?? existente.nombre, 'Nombre', { max: 160 }),
    telefono: texto(b.telefono ?? existente.telefono, 'Teléfono', { opcional: true, max: 40 }),
    identificacion: texto(b.identificacion ?? existente.identificacion, 'Identificación', { opcional: true, max: 40 }),
    email: texto(b.email ?? existente.email, 'Correo', { opcional: true, max: 120 }),
    direccion: texto(b.direccion ?? existente.direccion, 'Dirección', { opcional: true, max: 200 }),
    notas: texto(b.notas ?? existente.notas, 'Observaciones', { opcional: true, max: 1000 }),
  };
}

// Datos propios del cliente de una licorera: tipo (detal o mayorista: tiendas, bares, eventos) y barrio para domicilios.
function datosCliente(b, existente = {}) {
  const tipo = b.tipo_cliente ?? existente.tipo_cliente ?? 'detal';
  if (!['detal', 'mayorista'].includes(tipo)) throw err.datos('El tipo de cliente debe ser detal o mayorista');
  return { tipo_cliente: tipo, barrio: texto(b.barrio ?? existente.barrio, 'Barrio', { opcional: true, max: 120 }) };
}

router.get('/clientes', requierePermiso('clientes.ver', 'ventas.crear', 'domicilios.crear'), (req, res) => {
  const db = getDb();
  const q = req.query.q ? `%${req.query.q}%` : null;
  const filas = db.prepare(`SELECT c.*, (SELECT COALESCE(SUM(saldo_actual),0) FROM creditos cr WHERE cr.cliente_id = c.id AND cr.estado NOT IN ('pagado','anulado')) AS saldo_pendiente,
                              (SELECT COUNT(*) FROM ventas v WHERE v.cliente_id = c.id AND v.estado <> 'anulada') AS n_ventas,
                              (SELECT MAX(fecha) FROM ventas v WHERE v.cliente_id = c.id) AS ultima_compra
                            FROM clientes c WHERE c.activo = 1 ${q ? 'AND (c.nombre LIKE ? OR c.telefono LIKE ? OR c.identificacion LIKE ? OR c.direccion LIKE ?)' : ''} ${req.query.tipo === 'mayorista' || req.query.tipo === 'detal' ? `AND c.tipo_cliente = '${req.query.tipo}'` : ''} ORDER BY c.nombre LIMIT 300`).all(...(q ? [q, q, q, q] : []));
  res.json(filas);
});
// Origen comercial del cliente (marketing): canal por el que llegó y campaña de origen. Ambos opcionales.
function origenCliente(db, b, existente = {}) {
  const salida = {};
  if (b.origen_canal !== undefined || !existente.id) {
    const canales = require('../services/marketing').configMarketing(db).canales;
    const canal = b.origen_canal === undefined ? existente.origen_canal : b.origen_canal;
    if (canal !== null && canal !== undefined && canal !== '' && !canales.includes(canal)) throw err.datos(`Canal de origen no válido (${canales.join(', ')})`);
    salida.origen_canal = canal || null;
  } else salida.origen_canal = existente.origen_canal ?? null;
  if (b.origen_campana_id !== undefined || !existente.id) {
    const v = b.origen_campana_id === undefined ? existente.origen_campana_id : b.origen_campana_id;
    const id = v === null || v === undefined || v === '' ? null : Number(v);
    if (id !== null && (!Number.isInteger(id) || !db.prepare('SELECT id FROM campanas WHERE id = ?').get(id))) throw err.datos('La campaña de origen no existe');
    salida.origen_campana_id = id;
  } else salida.origen_campana_id = existente.origen_campana_id ?? null;
  return salida;
}

router.get('/clientes/:id', requierePermiso('clientes.ver', 'ventas.crear', 'domicilios.crear'), (req, res) => {
  const db = getDb();
  const c = db.prepare('SELECT c.*, ca.nombre AS origen_campana_nombre, l.nombre AS origen_lead_nombre, l.fecha AS origen_lead_fecha FROM clientes c LEFT JOIN campanas ca ON ca.id = c.origen_campana_id LEFT JOIN marketing_leads l ON l.id = c.origen_lead_id WHERE c.id = ?').get(Number(req.params.id));
  if (!c) throw err.noEncontrado('Cliente no existe');
  c.ventas = db.prepare(`SELECT v.id, v.numero, v.fecha, v.total, v.tipo_pago, v.estado, (SELECT GROUP_CONCAT(nombre_producto, ', ') FROM venta_items vi WHERE vi.venta_id = v.id) AS resumen FROM ventas v WHERE v.cliente_id = ? ORDER BY v.id DESC LIMIT 100`).all(c.id);
  c.creditos = creditos.listar(db, { cliente_id: c.id, limite: 100 });
  c.saldo_pendiente = c.creditos.filter((x) => !['pagado', 'anulado'].includes(x.estado)).reduce((s, x) => s + x.saldo_actual, 0);
  c.abonos = db.prepare("SELECT p.*, cr.numero AS credito_numero FROM pagos p JOIN creditos cr ON cr.id = p.credito_id WHERE p.cliente_id = ? AND p.tipo = 'abono' AND p.anulado = 0 ORDER BY p.id DESC LIMIT 100").all(c.id);
  c.proximos_vencimientos = db.prepare(`SELECT q.fecha_vencimiento, q.valor - q.pagado AS pendiente, cr.numero FROM credito_cuotas q JOIN creditos cr ON cr.id = q.credito_id WHERE cr.cliente_id = ? AND q.estado <> 'pagada' AND cr.estado NOT IN ('pagado','anulado') ORDER BY q.fecha_vencimiento LIMIT 10`).all(c.id);
  c.total_comprado = db.prepare("SELECT COALESCE(SUM(total),0) t FROM ventas WHERE cliente_id = ? AND estado <> 'anulada'").get(c.id).t;
  res.json(c);
});
router.post('/clientes', requierePermiso('clientes.editar', 'ventas.crear'), (req, res) => {
  const db = getDb();
  const d = { ...validarPersona(req.body), ...datosCliente(req.body), ...origenCliente(db, req.body) };
  const r = db.prepare('INSERT INTO clientes(nombre, telefono, identificacion, email, direccion, barrio, tipo_cliente, notas, origen_canal, origen_campana_id) VALUES (?,?,?,?,?,?,?,?,?,?)').run(d.nombre, d.telefono, d.identificacion, d.email, d.direccion, d.barrio, d.tipo_cliente, d.notas, d.origen_canal, d.origen_campana_id);
  const id = Number(r.lastInsertRowid);
  auditoria.registrar(db, req.usuario, 'crear_cliente', 'cliente', id, d, req.ip);
  res.status(201).json(db.prepare('SELECT c.*, ca.nombre AS origen_campana_nombre FROM clientes c LEFT JOIN campanas ca ON ca.id = c.origen_campana_id WHERE c.id = ?').get(id));
});
router.put('/clientes/:id', requierePermiso('clientes.editar'), (req, res) => {
  const db = getDb();
  const c = db.prepare('SELECT * FROM clientes WHERE id = ?').get(Number(req.params.id));
  if (!c) throw err.noEncontrado('Cliente no existe');
  const d = { ...validarPersona(req.body, c), ...datosCliente(req.body, c), ...origenCliente(db, req.body, c) };
  db.prepare('UPDATE clientes SET nombre=?, telefono=?, identificacion=?, email=?, direccion=?, barrio=?, tipo_cliente=?, notas=?, origen_canal=?, origen_campana_id=? WHERE id=?').run(d.nombre, d.telefono, d.identificacion, d.email, d.direccion, d.barrio, d.tipo_cliente, d.notas, d.origen_canal, d.origen_campana_id, c.id);
  auditoria.registrar(db, req.usuario, 'editar_cliente', 'cliente', c.id, { antes: c, despues: d }, req.ip);
  res.json(db.prepare('SELECT c.*, ca.nombre AS origen_campana_nombre FROM clientes c LEFT JOIN campanas ca ON ca.id = c.origen_campana_id WHERE c.id = ?').get(c.id));
});
router.delete('/clientes/:id', requierePermiso('eliminar'), (req, res) => {
  const db = getDb();
  const saldo = db.prepare("SELECT COALESCE(SUM(saldo_actual),0) t FROM creditos WHERE cliente_id = ? AND estado NOT IN ('pagado','anulado')").get(Number(req.params.id)).t;
  if (saldo > 0) throw err.conflicto('El cliente tiene saldo pendiente; no se puede desactivar');
  db.prepare('UPDATE clientes SET activo = 0 WHERE id = ?').run(Number(req.params.id));
  auditoria.registrar(db, req.usuario, 'desactivar_cliente', 'cliente', req.params.id, null, req.ip);
  res.json({ ok: true });
});
router.get('/clientes/:id/estado-cuenta', requierePermiso('clientes.ver', 'creditos.ver'), (req, res) => {
  res.json(creditos.estadoCuenta(getDb(), Number(req.params.id)));
});

// ---------- Proveedores ----------
router.get('/proveedores', requierePermiso('proveedores.ver', 'compras.crear'), (req, res) => {
  const db = getDb();
  const q = req.query.q ? `%${req.query.q}%` : null;
  res.json(db.prepare(`SELECT p.*, (SELECT COALESCE(SUM(saldo_pendiente),0) FROM compras c WHERE c.proveedor_id = p.id AND c.estado = 'confirmada') AS saldo_pendiente,
                         (SELECT COUNT(*) FROM compras c WHERE c.proveedor_id = p.id AND c.estado = 'confirmada') AS n_compras,
                         (SELECT MAX(fecha) FROM compras c WHERE c.proveedor_id = p.id) AS ultima_compra
                       FROM proveedores p WHERE p.activo = 1 ${q ? 'AND (p.nombre LIKE ? OR p.telefono LIKE ? OR p.identificacion LIKE ?)' : ''} ORDER BY p.nombre LIMIT 300`).all(...(q ? [q, q, q] : [])));
});
router.get('/proveedores/:id', requierePermiso('proveedores.ver'), (req, res) => {
  const db = getDb();
  const p = db.prepare('SELECT * FROM proveedores WHERE id = ?').get(Number(req.params.id));
  if (!p) throw err.noEncontrado('Proveedor no existe');
  p.compras = compras.listar(db, { proveedor_id: p.id, limite: 200 }).compras;
  p.saldo_pendiente = p.compras.filter((c) => c.estado === 'confirmada').reduce((s, c) => s + c.saldo_pendiente, 0);
  p.total_comprado = p.compras.filter((c) => c.estado === 'confirmada').reduce((s, c) => s + c.total, 0);
  p.pagos = db.prepare("SELECT p.*, c.numero AS compra_numero FROM pagos p LEFT JOIN compras c ON c.id = p.compra_id WHERE p.proveedor_id = ? AND p.tipo = 'pago_proveedor' AND p.anulado = 0 ORDER BY p.id DESC LIMIT 200").all(p.id);
  p.productos = db.prepare(`SELECT pr.id, pr.nombre, pr.referencia, COUNT(*) AS lotes, SUM(l.cantidad_inicial) AS unidades, MIN(l.costo_unitario) AS costo_min, MAX(l.costo_unitario) AS costo_max,
                              (SELECT costo_unitario FROM lotes l2 WHERE l2.producto_id = pr.id AND l2.proveedor_id = l.proveedor_id ORDER BY l2.fecha DESC, l2.id DESC LIMIT 1) AS ultimo_costo, MAX(l.fecha) AS ultima_fecha
                            FROM lotes l JOIN productos pr ON pr.id = l.producto_id WHERE l.proveedor_id = ? AND l.origen = 'compra' GROUP BY pr.id ORDER BY ultima_fecha DESC`).all(p.id);
  p.por_periodo = db.prepare("SELECT substr(fecha,1,7) AS mes, SUM(total) AS total, COUNT(*) AS n FROM compras WHERE proveedor_id = ? AND estado = 'confirmada' GROUP BY mes ORDER BY mes DESC LIMIT 12").all(p.id);
  p.documentos = db.prepare('SELECT d.id, d.ruta, d.mime, d.nombre, c.numero AS compra_numero FROM documentos d JOIN compras c ON c.id = d.compra_id WHERE c.proveedor_id = ? ORDER BY d.id DESC LIMIT 50').all(p.id);
  res.json(p);
});
router.post('/proveedores', requierePermiso('proveedores.editar', 'compras.crear'), (req, res) => {
  const db = getDb();
  const d = validarPersona(req.body);
  const contacto = texto(req.body.contacto, 'Contacto', { opcional: true, max: 120 });
  const r = db.prepare('INSERT INTO proveedores(nombre, identificacion, telefono, email, direccion, contacto, notas) VALUES (?,?,?,?,?,?,?)').run(d.nombre, d.identificacion, d.telefono, d.email, d.direccion, contacto, d.notas);
  const id = Number(r.lastInsertRowid);
  auditoria.registrar(db, req.usuario, 'crear_proveedor', 'proveedor', id, d, req.ip);
  res.status(201).json(db.prepare('SELECT * FROM proveedores WHERE id = ?').get(id));
});
router.put('/proveedores/:id', requierePermiso('proveedores.editar'), (req, res) => {
  const db = getDb();
  const p = db.prepare('SELECT * FROM proveedores WHERE id = ?').get(Number(req.params.id));
  if (!p) throw err.noEncontrado('Proveedor no existe');
  const d = validarPersona(req.body, p);
  const contacto = texto(req.body.contacto ?? p.contacto, 'Contacto', { opcional: true, max: 120 });
  db.prepare('UPDATE proveedores SET nombre=?, identificacion=?, telefono=?, email=?, direccion=?, contacto=?, notas=? WHERE id=?').run(d.nombre, d.identificacion, d.telefono, d.email, d.direccion, contacto, d.notas, p.id);
  auditoria.registrar(db, req.usuario, 'editar_proveedor', 'proveedor', p.id, { antes: p, despues: d }, req.ip);
  res.json(db.prepare('SELECT * FROM proveedores WHERE id = ?').get(p.id));
});
router.delete('/proveedores/:id', requierePermiso('eliminar'), (req, res) => {
  const db = getDb();
  db.prepare('UPDATE proveedores SET activo = 0 WHERE id = ?').run(Number(req.params.id));
  auditoria.registrar(db, req.usuario, 'desactivar_proveedor', 'proveedor', req.params.id, null, req.ip);
  res.json({ ok: true });
});

module.exports = router;
