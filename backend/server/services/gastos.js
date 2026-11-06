'use strict';
const { getConfig } = require('../db');
const { err, ahora, entero, texto, fecha: vFecha } = require('../util');
const { tiene } = require('../permisos');
const auditoria = require('./auditoria');
const caja = require('./caja');

function crear(db, datos, usuario) {
  if (!tiene(usuario, 'caja.gastos')) throw err.prohibido('No tienes permiso para registrar gastos');
  const categorias = getConfig(db, 'categorias_gasto') || [];
  const categoria = texto(datos.categoria, 'Categoría', { max: 60 });
  if (categorias.length && !categorias.includes(categoria)) categorias.push(categoria);
  const valor = entero(datos.valor, 'Valor', { min: 1 });
  const metodos = getConfig(db, 'metodos_pago');
  const metodo = metodos.includes(datos.metodo_pago) ? datos.metodo_pago : 'efectivo';
  const fecha = datos.fecha ? vFecha(datos.fecha, 'Fecha') : ahora();
  const r = db.prepare('INSERT INTO gastos(fecha, categoria, descripcion, valor, metodo_pago, proveedor_id, comprobante_ruta, usuario_id, caja_sesion_id) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(fecha.length === 10 ? fecha + ' ' + ahora().slice(11) : fecha, categoria, texto(datos.descripcion, 'Descripción', { opcional: true, max: 300 }), valor, metodo,
      datos.proveedor_id || null, datos.comprobante_ruta || null, usuario.id, caja.sesionAbiertaId(db));
  const id = Number(r.lastInsertRowid);
  auditoria.registrar(db, usuario, 'crear_gasto', 'gasto', id, { categoria, valor, metodo });
  return db.prepare('SELECT * FROM gastos WHERE id = ?').get(id);
}

function listar(db, { desde, hasta, categoria, limite = 300 } = {}) {
  const cond = ['g.anulado = 0'];
  const params = [];
  if (desde) { cond.push('g.fecha >= ?'); params.push(desde + ' 00:00:00'); }
  if (hasta) { cond.push('g.fecha <= ?'); params.push(hasta + ' 23:59:59'); }
  if (categoria) { cond.push('g.categoria = ?'); params.push(categoria); }
  return db.prepare(`SELECT g.*, u.nombre AS usuario_nombre, p.nombre AS proveedor_nombre FROM gastos g LEFT JOIN usuarios u ON u.id = g.usuario_id LEFT JOIN proveedores p ON p.id = g.proveedor_id
                     WHERE ${cond.join(' AND ')} ORDER BY g.fecha DESC, g.id DESC LIMIT ?`).all(...params, limite);
}

function anular(db, id, usuario) {
  if (!tiene(usuario, 'eliminar') && !tiene(usuario, 'caja.operar')) throw err.prohibido();
  const g = db.prepare('SELECT * FROM gastos WHERE id = ?').get(id);
  if (!g) throw err.noEncontrado('Gasto no existe');
  db.prepare('UPDATE gastos SET anulado = 1 WHERE id = ?').run(id);
  auditoria.registrar(db, usuario, 'anular_gasto', 'gasto', id, { valor: g.valor, categoria: g.categoria });
  return { ok: true };
}

module.exports = { crear, listar, anular };
