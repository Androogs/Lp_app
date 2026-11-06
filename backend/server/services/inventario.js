'use strict';
// Inventario por lotes: cada compra crea un lote con su costo; las salidas consumen FIFO
// (primero en entrar, primero en salir) o por identificación específica (serial o número de estampilla).
const { transaccion, getConfig } = require('../db');
const { err, ahora, hoy } = require('../util');
const { tiene } = require('../permisos');
const auditoria = require('./auditoria');

function stockDe(db, productoId) {
  const f = db.prepare('SELECT stock FROM v_stock WHERE producto_id = ?').get(productoId);
  return f ? f.stock : 0;
}

function registrarMovimiento(db, { producto_id, lote_id = null, tipo, cantidad, costo_unitario = 0, referencia_tipo = null, referencia_id = null, nota = null }, usuario) {
  const stock = stockDe(db, producto_id);
  db.prepare(`INSERT INTO movimientos(fecha, producto_id, lote_id, tipo, cantidad, costo_unitario, stock_resultante, referencia_tipo, referencia_id, usuario_id, usuario_nombre, nota)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ahora(), producto_id, lote_id, tipo, cantidad, costo_unitario, stock, referencia_tipo, referencia_id, usuario ? usuario.id : null, usuario ? usuario.nombre : null, nota);
}

function actualizarEstadoProducto(db, productoId) {
  const p = db.prepare('SELECT estado FROM productos WHERE id = ?').get(productoId);
  if (!p) return;
  const stock = stockDe(db, productoId);
  if (p.estado === 'activo' && stock <= 0) db.prepare("UPDATE productos SET estado = 'agotado', actualizado_en = ? WHERE id = ?").run(ahora(), productoId);
  else if (p.estado === 'agotado' && stock > 0) db.prepare("UPDATE productos SET estado = 'activo', actualizado_en = ? WHERE id = ?").run(ahora(), productoId);
}

// Compensa primero los lotes negativos (ventas autorizadas sin stock) antes de crear uno nuevo.
function netearNegativos(db, productoId, cantidad) {
  let restante = cantidad;
  const negativos = db.prepare("SELECT id, cantidad_restante FROM lotes WHERE producto_id = ? AND cantidad_restante < 0 AND estado <> 'anulado' ORDER BY id").all(productoId);
  for (const l of negativos) {
    if (restante <= 0) break;
    const deuda = -l.cantidad_restante;
    const aplica = Math.min(deuda, restante);
    const nuevo = l.cantidad_restante + aplica;
    db.prepare("UPDATE lotes SET cantidad_restante = ?, estado = CASE WHEN ? = 0 THEN 'agotado' ELSE estado END WHERE id = ?").run(nuevo, nuevo, l.id);
    restante -= aplica;
  }
  return restante;
}

function crearLote(db, { producto_id, compra_id = null, compra_item_id = null, proveedor_id = null, fecha, cantidad, costo_unitario, serial = null, origen = 'compra', tipo_movimiento = 'compra', referencia_tipo = null, referencia_id = null, nota = null, moneda = 'COP', tasa_cambio = 1, costo_unitario_moneda = null }, usuario) {
  if (cantidad <= 0) throw err.datos('La cantidad del lote debe ser mayor que cero');
  if (serial) {
    const existe = db.prepare("SELECT id FROM lotes WHERE producto_id = ? AND serial = ? AND cantidad_restante > 0 AND estado <> 'anulado'").get(producto_id, serial);
    if (existe) throw err.conflicto(`El serial/estampilla ${serial} ya está en inventario`);
  }
  const efectiva = netearNegativos(db, producto_id, cantidad);
  let loteId = null;
  if (efectiva > 0) {
    const r = db.prepare(`INSERT INTO lotes(producto_id, compra_id, compra_item_id, proveedor_id, fecha, cantidad_inicial, cantidad_restante, costo_unitario, serial, origen, estado, moneda, tasa_cambio, costo_unitario_moneda)
                          VALUES (?,?,?,?,?,?,?,?,?,?,'disponible',?,?,?)`)
      .run(producto_id, compra_id, compra_item_id, proveedor_id, fecha || hoy(), efectiva, efectiva, costo_unitario, serial, origen, moneda, tasa_cambio, costo_unitario_moneda ?? costo_unitario);
    loteId = Number(r.lastInsertRowid);
  }
  registrarMovimiento(db, { producto_id, lote_id: loteId, tipo: tipo_movimiento, cantidad, costo_unitario, referencia_tipo: referencia_tipo || (compra_id ? 'compra' : null), referencia_id: referencia_id || compra_id, nota }, usuario);
  actualizarEstadoProducto(db, producto_id);
  return loteId;
}

// Descuenta unidades del inventario. Devuelve las asignaciones [{lote_id, cantidad, costo_unitario, serial}].
function consumir(db, { producto_id, cantidad, seriales = null, permitir_negativo = false, tipo_movimiento = 'venta', referencia_tipo = null, referencia_id = null, nota = null }, usuario) {
  if (cantidad <= 0) throw err.datos('La cantidad debe ser mayor que cero');
  const producto = db.prepare('SELECT id, nombre, requiere_serial, precio_compra FROM productos WHERE id = ?').get(producto_id);
  if (!producto) throw err.noEncontrado('Producto no existe');
  const asignaciones = [];
  let faltan = cantidad;
  const datosLote = (l) => ({ moneda_compra: l.moneda || 'COP', tasa_compra: l.tasa_cambio || 1, costo_unitario_moneda: l.costo_unitario_moneda ?? l.costo_unitario });
  // Método de valoración: FIFO (costo del lote que sale) o PROMEDIO (costo promedio ponderado de las existencias al momento de la venta).
  const metodo = String(getConfig(db, 'metodo_valoracion') || 'FIFO').toUpperCase();

  if (seriales && seriales.length) {
    if (seriales.length !== cantidad) throw err.datos(`Debes indicar ${cantidad} serial(es) para ${producto.nombre}`);
    for (const s of seriales) {
      const lote = db.prepare("SELECT * FROM lotes WHERE producto_id = ? AND serial = ? AND cantidad_restante > 0 AND estado <> 'anulado'").get(producto_id, String(s).trim());
      if (!lote) throw err.conflicto(`El serial/estampilla ${s} no está disponible en inventario para ${producto.nombre}`);
      db.prepare("UPDATE lotes SET cantidad_restante = cantidad_restante - 1, estado = CASE WHEN cantidad_restante - 1 <= 0 THEN 'agotado' ELSE estado END WHERE id = ?").run(lote.id);
      asignaciones.push({ lote_id: lote.id, cantidad: 1, costo_unitario: lote.costo_unitario, serial: lote.serial, ...datosLote(lote) });
      faltan -= 1;
    }
  } else {
    const lotes = db.prepare("SELECT * FROM lotes WHERE producto_id = ? AND cantidad_restante > 0 AND estado <> 'anulado' ORDER BY fecha, id").all(producto_id);
    let promedio = null;
    if (metodo === 'PROMEDIO' && lotes.length) {
      const unidades = lotes.reduce((s, l) => s + l.cantidad_restante, 0);
      const valor = lotes.reduce((s, l) => s + l.cantidad_restante * l.costo_unitario, 0);
      promedio = unidades > 0 ? Math.round(valor / unidades) : null;
    }
    for (const l of lotes) {
      if (faltan <= 0) break;
      const toma = Math.min(l.cantidad_restante, faltan);
      db.prepare("UPDATE lotes SET cantidad_restante = cantidad_restante - ?, estado = CASE WHEN cantidad_restante - ? <= 0 THEN 'agotado' ELSE estado END WHERE id = ?").run(toma, toma, l.id);
      asignaciones.push({ lote_id: l.id, cantidad: toma, costo_unitario: promedio ?? l.costo_unitario, serial: l.serial, ...datosLote(l), metodo: promedio !== null ? 'PROMEDIO' : 'FIFO' });
      faltan -= toma;
    }
  }

  if (faltan > 0) {
    if (!permitir_negativo) {
      const disponible = cantidad - faltan;
      throw err.conflicto(`Stock insuficiente de ${producto.nombre}: disponibles ${disponible}, solicitadas ${cantidad}`, { codigo: 'stock_insuficiente', producto_id, disponible, solicitado: cantidad });
    }
    // Lote negativo autorizado: queda registrado y se compensa con la próxima entrada.
    const r = db.prepare(`INSERT INTO lotes(producto_id, fecha, cantidad_inicial, cantidad_restante, costo_unitario, origen, estado, moneda, tasa_cambio, costo_unitario_moneda)
                          VALUES (?,?,0,?,?,'faltante','disponible','COP',1,?)`).run(producto_id, hoy(), -faltan, producto.precio_compra || 0, producto.precio_compra || 0);
    asignaciones.push({ lote_id: Number(r.lastInsertRowid), cantidad: faltan, costo_unitario: producto.precio_compra || 0, serial: null, negativo: true, moneda_compra: 'COP', tasa_compra: 1, costo_unitario_moneda: producto.precio_compra || 0 });
    faltan = 0;
  }

  for (const a of asignaciones) {
    registrarMovimiento(db, { producto_id, lote_id: a.lote_id, tipo: tipo_movimiento, cantidad: -a.cantidad, costo_unitario: a.costo_unitario, referencia_tipo, referencia_id, nota: a.negativo ? 'Salida autorizada sin stock' : nota }, usuario);
  }
  actualizarEstadoProducto(db, producto_id);
  return asignaciones;
}

// Devuelve unidades a los lotes de donde salieron (devoluciones y anulaciones) conservando su costo original.
function restaurar(db, { producto_id, asignaciones, tipo_movimiento = 'devolucion_venta', referencia_tipo = null, referencia_id = null, nota = null }, usuario) {
  for (const a of asignaciones) {
    if (a.cantidad <= 0) continue;
    db.prepare("UPDATE lotes SET cantidad_restante = cantidad_restante + ?, estado = CASE WHEN cantidad_restante + ? > 0 THEN 'disponible' ELSE estado END WHERE id = ?").run(a.cantidad, a.cantidad, a.lote_id);
    registrarMovimiento(db, { producto_id, lote_id: a.lote_id, tipo: tipo_movimiento, cantidad: a.cantidad, costo_unitario: a.costo_unitario, referencia_tipo, referencia_id, nota }, usuario);
  }
  actualizarEstadoProducto(db, producto_id);
}

function ajustar(db, { producto_id, cantidad, motivo, costo_unitario, tipo }, usuario) {
  if (!tiene(usuario, 'inventario.ajustar')) throw err.prohibido('No tienes permiso para ajustar inventario');
  if (!cantidad) throw err.datos('Indica la cantidad a ajustar');
  const producto = db.prepare('SELECT * FROM productos WHERE id = ?').get(producto_id);
  if (!producto) throw err.noEncontrado('Producto no existe');
  return transaccion(db, () => {
    let resultado;
    if (cantidad > 0) {
      const costo = costo_unitario ?? producto.precio_compra ?? 0;
      resultado = crearLote(db, { producto_id, fecha: hoy(), cantidad, costo_unitario: costo, origen: 'ajuste', tipo_movimiento: 'ajuste_entrada', referencia_tipo: 'ajuste', nota: motivo }, usuario);
    } else {
      const permitirNeg = tiene(usuario, 'inventario.stock_negativo') && !!getConfig(db, 'permitir_stock_negativo');
      resultado = consumir(db, { producto_id, cantidad: -cantidad, permitir_negativo: permitirNeg, tipo_movimiento: tipo === 'perdida' ? 'perdida' : 'ajuste_salida', referencia_tipo: 'ajuste', nota: motivo }, usuario);
    }
    auditoria.registrar(db, usuario, 'ajuste_inventario', 'producto', producto_id, { cantidad, motivo, tipo });
    return { stock: stockDe(db, producto_id), resultado };
  });
}

function lotesDe(db, productoId, { soloDisponibles = false } = {}) {
  return db.prepare(`SELECT l.*, pr.nombre AS proveedor_nombre, c.numero AS compra_numero, c.numero_factura
                     FROM lotes l LEFT JOIN proveedores pr ON pr.id = l.proveedor_id LEFT JOIN compras c ON c.id = l.compra_id
                     WHERE l.producto_id = ? ${soloDisponibles ? 'AND l.cantidad_restante > 0 AND l.estado <> \'anulado\'' : ''}
                     ORDER BY l.fecha, l.id`).all(productoId);
}

function kardex(db, productoId, { desde, hasta, limite = 500 } = {}) {
  const cond = ['m.producto_id = ?'];
  const params = [productoId];
  if (desde) { cond.push('m.fecha >= ?'); params.push(desde + ' 00:00:00'); }
  if (hasta) { cond.push('m.fecha <= ?'); params.push(hasta + ' 23:59:59'); }
  return db.prepare(`SELECT m.*, l.serial FROM movimientos m LEFT JOIN lotes l ON l.id = m.lote_id WHERE ${cond.join(' AND ')} ORDER BY m.id DESC LIMIT ?`).all(...params, limite);
}

module.exports = { stockDe, registrarMovimiento, crearLote, consumir, restaurar, ajustar, lotesDe, kardex, actualizarEstadoProducto };
