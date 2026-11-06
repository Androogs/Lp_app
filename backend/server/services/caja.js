'use strict';
// Caja: apertura, cierre, entradas/salidas y conciliación de efectivo.
const { transaccion } = require('../db');
const { err, ahora, entero, texto } = require('../util');
const auditoria = require('./auditoria');

function sesionAbierta(db) {
  return db.prepare("SELECT * FROM caja_sesiones WHERE estado = 'abierta' ORDER BY id DESC LIMIT 1").get() || null;
}
function sesionAbiertaId(db) {
  const s = sesionAbierta(db);
  return s ? s.id : null;
}

function abrir(db, datos, usuario) {
  if (sesionAbierta(db)) throw err.conflicto('Ya hay una caja abierta. Ciérrala antes de abrir otra.');
  const base = entero(datos.base_inicial, 'Base inicial', { min: 0, opcional: true, defecto: 0 });
  const notas = texto(datos.notas, 'Notas', { opcional: true, max: 500 });
  const r = db.prepare('INSERT INTO caja_sesiones(abierta_en, usuario_apertura_id, base_inicial, notas) VALUES (?,?,?,?)').run(ahora(), usuario.id, base, notas);
  const id = Number(r.lastInsertRowid);
  auditoria.registrar(db, usuario, 'abrir_caja', 'caja', id, { base_inicial: base });
  return obtener(db, id);
}

function resumen(db, sesionId) {
  const porMetodo = (sql, params = []) => {
    const salida = {};
    for (const f of db.prepare(sql).all(sesionId, ...params)) salida[f.metodo] = f.total;
    return salida;
  };
  const ingresos = porMetodo("SELECT metodo_pago AS metodo, SUM(valor) AS total FROM pagos WHERE caja_sesion_id = ? AND anulado = 0 AND tipo IN ('venta','abono') GROUP BY metodo_pago");
  const ventasCobradas = porMetodo("SELECT metodo_pago AS metodo, SUM(valor) AS total FROM pagos WHERE caja_sesion_id = ? AND anulado = 0 AND tipo = 'venta' GROUP BY metodo_pago");
  // Domicilios entregados en este turno: lo que trajeron los repartidores (contraentrega) y los envíos cobrados.
  const domicilios = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total),0) total, COALESCE(SUM(cargo_domicilio),0) envios FROM ventas WHERE caja_sesion_id = ? AND domicilio_id IS NOT NULL AND estado <> 'anulada'").get(sesionId);
  const abonos = porMetodo("SELECT metodo_pago AS metodo, SUM(valor) AS total FROM pagos WHERE caja_sesion_id = ? AND anulado = 0 AND tipo = 'abono' GROUP BY metodo_pago");
  const pagosProveedor = porMetodo("SELECT metodo_pago AS metodo, SUM(valor) AS total FROM pagos WHERE caja_sesion_id = ? AND anulado = 0 AND tipo = 'pago_proveedor' GROUP BY metodo_pago");
  const reintegros = porMetodo("SELECT metodo_pago AS metodo, SUM(valor) AS total FROM pagos WHERE caja_sesion_id = ? AND anulado = 0 AND tipo = 'reintegro' GROUP BY metodo_pago");
  const gastos = porMetodo('SELECT metodo_pago AS metodo, SUM(valor) AS total FROM gastos WHERE caja_sesion_id = ? AND anulado = 0 GROUP BY metodo_pago');
  const entradas = db.prepare("SELECT COALESCE(SUM(valor),0) t FROM caja_movimientos WHERE caja_sesion_id = ? AND tipo = 'entrada'").get(sesionId).t;
  const salidas = db.prepare("SELECT COALESCE(SUM(valor),0) t FROM caja_movimientos WHERE caja_sesion_id = ? AND tipo = 'salida'").get(sesionId).t;
  const ventas = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total),0) total, COALESCE(SUM(CASE WHEN tipo_pago <> 'contado' THEN 1 ELSE 0 END),0) n_credito FROM ventas WHERE caja_sesion_id = ? AND estado <> 'anulada'").get(sesionId);
  const creditoOtorgado = db.prepare("SELECT COALESCE(SUM(c.saldo_financiado),0) t FROM creditos c JOIN ventas v ON v.id = c.venta_id WHERE v.caja_sesion_id = ? AND v.estado <> 'anulada'").get(sesionId).t;
  const suma = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  const sesion = db.prepare('SELECT * FROM caja_sesiones WHERE id = ?').get(sesionId);
  const efectivoEsperado = (sesion.base_inicial || 0) + (ingresos.efectivo || 0) + entradas - (pagosProveedor.efectivo || 0) - (reintegros.efectivo || 0) - (gastos.efectivo || 0) - salidas;
  return {
    base_inicial: sesion.base_inicial,
    ingresos, ventas_cobradas: ventasCobradas, abonos, pagos_proveedor: pagosProveedor, reintegros, gastos, domicilios,
    entradas, salidas,
    total_ingresos: suma(ingresos), total_egresos: suma(pagosProveedor) + suma(reintegros) + suma(gastos),
    ventas_facturadas: ventas.total, ventas_cantidad: ventas.n, ventas_a_credito: ventas.n_credito, credito_otorgado: creditoOtorgado,
    efectivo_esperado: efectivoEsperado,
  };
}

function cerrar(db, datos, usuario) {
  const s = sesionAbierta(db);
  if (!s) throw err.conflicto('No hay una caja abierta');
  const contado = entero(datos.efectivo_contado, 'Efectivo contado', { min: 0 });
  const notas = texto(datos.notas, 'Notas', { opcional: true, max: 1000 });
  return transaccion(db, () => {
    const r = resumen(db, s.id);
    const diferencia = contado - r.efectivo_esperado;
    db.prepare("UPDATE caja_sesiones SET cerrada_en = ?, usuario_cierre_id = ?, efectivo_esperado = ?, efectivo_contado = ?, diferencia = ?, resumen = ?, notas = COALESCE(?, notas), estado = 'cerrada' WHERE id = ?")
      .run(ahora(), usuario.id, r.efectivo_esperado, contado, diferencia, JSON.stringify(r), notas, s.id);
    auditoria.registrar(db, usuario, 'cerrar_caja', 'caja', s.id, { efectivo_esperado: r.efectivo_esperado, efectivo_contado: contado, diferencia });
    return obtener(db, s.id);
  });
}

function movimiento(db, datos, usuario) {
  const s = sesionAbierta(db);
  if (!s) throw err.conflicto('Abre la caja antes de registrar movimientos');
  const tipo = datos.tipo === 'salida' ? 'salida' : 'entrada';
  const valor = entero(datos.valor, 'Valor', { min: 1 });
  const concepto = texto(datos.concepto, 'Concepto', { max: 200 });
  const r = db.prepare('INSERT INTO caja_movimientos(caja_sesion_id, fecha, tipo, concepto, valor, usuario_id) VALUES (?,?,?,?,?,?)').run(s.id, ahora(), tipo, concepto, valor, usuario.id);
  auditoria.registrar(db, usuario, 'movimiento_caja', 'caja', s.id, { tipo, concepto, valor });
  return db.prepare('SELECT * FROM caja_movimientos WHERE id = ?').get(Number(r.lastInsertRowid));
}

function obtener(db, id) {
  const s = db.prepare(`SELECT s.*, ua.nombre AS usuario_apertura, uc.nombre AS usuario_cierre FROM caja_sesiones s
                        LEFT JOIN usuarios ua ON ua.id = s.usuario_apertura_id LEFT JOIN usuarios uc ON uc.id = s.usuario_cierre_id WHERE s.id = ?`).get(id);
  if (!s) throw err.noEncontrado('Sesión de caja no existe');
  s.resumen = s.estado === 'abierta' ? resumen(db, id) : (s.resumen ? JSON.parse(s.resumen) : resumen(db, id));
  s.movimientos = db.prepare('SELECT m.*, u.nombre AS usuario_nombre FROM caja_movimientos m LEFT JOIN usuarios u ON u.id = m.usuario_id WHERE caja_sesion_id = ? ORDER BY id DESC').all(id);
  s.pagos = db.prepare(`SELECT p.*, u.nombre AS usuario_nombre, v.numero AS venta_numero, cr.numero AS credito_numero, c.numero AS compra_numero
                        FROM pagos p LEFT JOIN usuarios u ON u.id = p.usuario_id LEFT JOIN ventas v ON v.id = p.venta_id LEFT JOIN creditos cr ON cr.id = p.credito_id LEFT JOIN compras c ON c.id = p.compra_id
                        WHERE p.caja_sesion_id = ? ORDER BY p.id DESC`).all(id);
  s.gastos = db.prepare('SELECT * FROM gastos WHERE caja_sesion_id = ? AND anulado = 0 ORDER BY id DESC').all(id);
  return s;
}

function historial(db, { limite = 60 } = {}) {
  return db.prepare(`SELECT s.id, s.abierta_en, s.cerrada_en, s.base_inicial, s.efectivo_esperado, s.efectivo_contado, s.diferencia, s.estado, ua.nombre AS usuario_apertura, uc.nombre AS usuario_cierre
                     FROM caja_sesiones s LEFT JOIN usuarios ua ON ua.id = s.usuario_apertura_id LEFT JOIN usuarios uc ON uc.id = s.usuario_cierre_id
                     ORDER BY s.id DESC LIMIT ?`).all(limite);
}

module.exports = { sesionAbierta, sesionAbiertaId, abrir, cerrar, resumen, movimiento, obtener, historial };
