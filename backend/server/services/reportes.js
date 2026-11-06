'use strict';
// Reportes filtrables por fecha. Cada reporte devuelve { titulo, columnas, filas, totales } y se exporta a CSV (Excel).
const { getConfig } = require('../db');
const { hoy, ahora, rangoPeriodo } = require('../util');
const creditos = require('./creditos');
const productos = require('./productos');
const contabilidad = require('./contabilidad');

const d0 = (desde) => (desde || '2000-01-01') + ' 00:00:00';
const d1 = (hasta) => (hasta || '2999-12-31') + ' 23:59:59';
const d0c = (desde) => desde || '2000-01-01'; // compras.fecha puede no traer hora: sin sufijo entran 'YYYY-MM-DD' y 'YYYY-MM-DD HH:MM:SS'
// Filtro opcional por categoría (o subcategoría) para los reportes de productos.
const catSql = (f) => (f.categoria_id ? `AND (p.categoria_id = ${Number(f.categoria_id)} OR p.subcategoria_id = ${Number(f.categoria_id)})` : '');

const REPORTES = {
  inventario: {
    titulo: 'Inventario actual',
    columnas: [['sku', 'SKU'], ['nombre', 'Producto'], ['categoria', 'Categoría'], ['marca', 'Marca'], ['referencia', 'Referencia'], ['stock', 'Stock'], ['stock_minimo', 'Mínimo'], ['costo_promedio', 'Costo prom. lotes'], ['valor_costo', 'Valor al costo'], ['precio_venta', 'Precio venta'], ['valor_venta', 'Valor potencial'], ['estado', 'Estado'], ['ubicacion', 'Ubicación']],
    consulta: (db, f = {}) => db.prepare(`SELECT p.sku, p.nombre, c.nombre categoria, p.marca, p.referencia, s.stock, p.stock_minimo,
        CASE WHEN s.stock > 0 THEN ROUND(s.valor_costo / s.stock) ELSE p.precio_compra END costo_promedio, s.valor_costo, p.precio_venta, s.stock * p.precio_venta valor_venta, p.estado, p.ubicacion
        FROM productos p JOIN v_stock s ON s.producto_id = p.id LEFT JOIN categorias c ON c.id = p.categoria_id WHERE p.estado <> 'inactivo' ${catSql(f)} ORDER BY p.nombre`).all(),
    totales: ['stock', 'valor_costo', 'valor_venta'],
  },
  kardex: {
    titulo: 'Kardex (movimientos de inventario)',
    columnas: [['fecha', 'Fecha'], ['producto', 'Producto'], ['tipo', 'Tipo'], ['cantidad', 'Cantidad'], ['costo_unitario', 'Costo unit.'], ['stock_resultante', 'Stock después'], ['serial', 'Serial'], ['referencia', 'Referencia'], ['usuario_nombre', 'Usuario'], ['nota', 'Nota']],
    consulta: (db, f) => db.prepare(`SELECT m.fecha, p.nombre producto, m.tipo, m.cantidad, m.costo_unitario, m.stock_resultante, l.serial, COALESCE(v.numero, c.numero, m.referencia_tipo) referencia, m.usuario_nombre, m.nota
        FROM movimientos m JOIN productos p ON p.id = m.producto_id LEFT JOIN lotes l ON l.id = m.lote_id
        LEFT JOIN ventas v ON m.referencia_tipo = 'venta' AND v.id = m.referencia_id LEFT JOIN compras c ON m.referencia_tipo = 'compra' AND c.id = m.referencia_id
        WHERE m.fecha BETWEEN ? AND ? ${f.producto_id ? 'AND m.producto_id = ' + Number(f.producto_id) : ''} ORDER BY m.id DESC LIMIT 5000`).all(d0(f.desde), d1(f.hasta)),
  },
  compras_proveedor: {
    titulo: 'Compras por proveedor',
    columnas: [['proveedor', 'Proveedor'], ['compras', 'N° compras'], ['total', 'Total comprado'], ['pagado', 'Pagado'], ['saldo', 'Saldo pendiente']],
    consulta: (db, f) => db.prepare(`SELECT COALESCE(p.nombre, 'Sin proveedor') proveedor, COUNT(*) compras, SUM(c.total) total, SUM(c.valor_pagado) pagado, SUM(c.saldo_pendiente) saldo
        FROM compras c LEFT JOIN proveedores p ON p.id = c.proveedor_id WHERE c.estado = 'confirmada' AND c.fecha BETWEEN ? AND ? GROUP BY c.proveedor_id ORDER BY total DESC`).all(d0c(f.desde), d1(f.hasta)),
    totales: ['compras', 'total', 'pagado', 'saldo'],
  },
  compras: {
    titulo: 'Compras (detalle)',
    criterios: 'Compras del periodo en pesos. "TRM referencia" es la TRM oficial vigente el día de la compra (fotografía histórica, no cambia); "Tasa aplicada" es la que realmente se usó para el costo (1 en compras en pesos).',
    columnas: [['numero', 'N°'], ['fecha', 'Fecha'], ['proveedor', 'Proveedor'], ['numero_factura', 'Factura'], ['moneda', 'Moneda'], ['tasa_trm', 'TRM referencia'], ['fecha_trm', 'Fecha TRM'], ['tasa_cambio', 'Tasa aplicada'], ['subtotal', 'Subtotal'], ['descuento', 'Descuento'], ['costos_adicionales', 'Fletes/otros'], ['impuestos', 'Impuestos'], ['total', 'Total'], ['valor_pagado', 'Pagado'], ['saldo_pendiente', 'Saldo'], ['estado', 'Estado']],
    consulta: (db, f) => db.prepare(`SELECT c.numero, c.fecha, p.nombre proveedor, c.numero_factura, c.moneda, c.trm_valor tasa_trm, c.trm_fecha fecha_trm, c.tasa_cambio, c.subtotal, c.descuento, c.costos_adicionales, c.impuestos, c.total, c.valor_pagado, c.saldo_pendiente, c.estado
        FROM compras c LEFT JOIN proveedores p ON p.id = c.proveedor_id WHERE c.fecha BETWEEN ? AND ? ORDER BY c.fecha DESC`).all(d0c(f.desde), d1(f.hasta)),
    totales: ['total', 'valor_pagado', 'saldo_pendiente'],
  },
  ventas_cliente: {
    titulo: 'Ventas por cliente',
    columnas: [['cliente', 'Cliente'], ['telefono', 'Teléfono'], ['ventas', 'N° ventas'], ['total', 'Total vendido'], ['ganancia', 'Ganancia'], ['credito', 'Saldo a crédito']],
    consulta: (db, f) => db.prepare(`SELECT COALESCE(c.nombre, 'Consumidor final') cliente, c.telefono, COUNT(*) ventas, SUM(v.total) total, SUM(v.ganancia) ganancia,
        (SELECT COALESCE(SUM(saldo_actual),0) FROM creditos cr WHERE cr.cliente_id = v.cliente_id AND cr.estado NOT IN ('pagado','anulado')) credito
        FROM ventas v LEFT JOIN clientes c ON c.id = v.cliente_id WHERE v.estado <> 'anulada' AND v.fecha BETWEEN ? AND ? GROUP BY v.cliente_id ORDER BY total DESC`).all(d0(f.desde), d1(f.hasta)),
    totales: ['ventas', 'total', 'ganancia'],
  },
  ventas: {
    titulo: 'Ventas (detalle)',
    columnas: [['numero', 'N°'], ['fecha', 'Fecha'], ['cliente', 'Cliente'], ['vendedor', 'Vendedor'], ['subtotal', 'Subtotal'], ['descuento', 'Descuento'], ['total', 'Total'], ['costo_total', 'Costo'], ['ganancia', 'Ganancia'], ['tipo_pago', 'Tipo pago'], ['estado', 'Estado']],
    consulta: (db, f) => db.prepare(`SELECT v.numero, v.fecha, COALESCE(c.nombre,'Consumidor final') cliente, u.nombre vendedor, v.subtotal, v.descuento, v.total, v.costo_total, v.ganancia, v.tipo_pago, v.estado
        FROM ventas v LEFT JOIN clientes c ON c.id = v.cliente_id LEFT JOIN usuarios u ON u.id = v.vendedor_id WHERE v.fecha BETWEEN ? AND ? ORDER BY v.fecha DESC`).all(d0(f.desde), d1(f.hasta)),
    totales: ['total', 'costo_total', 'ganancia'],
  },
  ventas_producto: {
    titulo: 'Ventas y ganancia por producto',
    columnas: [['producto', 'Producto'], ['categoria', 'Categoría'], ['unidades', 'Unidades'], ['total', 'Vendido'], ['costo', 'Costo'], ['ganancia', 'Ganancia'], ['margen_pct', 'Margen %']],
    consulta: (db, f) => db.prepare(`SELECT p.nombre producto, c.nombre categoria, SUM(vi.cantidad - vi.cantidad_devuelta) unidades, SUM(vi.total) total, SUM(vi.costo_total) costo, SUM(vi.total - vi.costo_total) ganancia,
        CASE WHEN SUM(vi.total) > 0 THEN ROUND(SUM(vi.total - vi.costo_total) * 100.0 / SUM(vi.total), 1) ELSE 0 END margen_pct
        FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id JOIN productos p ON p.id = vi.producto_id LEFT JOIN categorias c ON c.id = p.categoria_id
        WHERE v.estado <> 'anulada' AND v.fecha BETWEEN ? AND ? ${catSql(f)} GROUP BY p.id ORDER BY ganancia DESC`).all(d0(f.desde), d1(f.hasta)),
    totales: ['unidades', 'total', 'costo', 'ganancia'],
  },
  costos_lote: {
    titulo: 'Costos por lote',
    columnas: [['producto', 'Producto'], ['serial', 'Serial/estampilla'], ['fecha', 'Fecha compra'], ['proveedor', 'Proveedor'], ['compra', 'Compra'], ['cantidad_inicial', 'Cant. inicial'], ['cantidad_restante', 'Restantes'], ['costo_unitario', 'Costo unit.'], ['precio_venta', 'Precio venta actual'], ['ganancia_unit', 'Ganancia unit. estimada'], ['margen_pct', 'Margen %'], ['estado', 'Estado']],
    consulta: (db, f) => db.prepare(`SELECT p.nombre producto, l.serial, l.fecha, pr.nombre proveedor, c.numero compra, l.cantidad_inicial, l.cantidad_restante, l.costo_unitario, p.precio_venta,
        p.precio_venta - l.costo_unitario ganancia_unit, CASE WHEN p.precio_venta > 0 THEN ROUND((p.precio_venta - l.costo_unitario) * 100.0 / p.precio_venta, 1) ELSE 0 END margen_pct, l.estado
        FROM lotes l JOIN productos p ON p.id = l.producto_id LEFT JOIN proveedores pr ON pr.id = l.proveedor_id LEFT JOIN compras c ON c.id = l.compra_id
        WHERE l.fecha BETWEEN ? AND ? ${f.solo_disponibles ? 'AND l.cantidad_restante > 0' : ''} ${catSql(f)} ORDER BY p.nombre, l.fecha, l.id`).all((f.desde || '2000-01-01'), (f.hasta || '2999-12-31')),
    totales: ['cantidad_restante'],
  },
  creditos_pendientes: {
    titulo: 'Créditos pendientes',
    columnas: [['numero', 'Crédito'], ['cliente_nombre', 'Cliente'], ['cliente_telefono', 'Teléfono'], ['fecha', 'Fecha'], ['venta_numero', 'Venta'], ['saldo_financiado', 'Financiado'], ['total_abonado', 'Abonado'], ['saldo_actual', 'Saldo'], ['proximo_vencimiento', 'Próx. vencimiento'], ['estado', 'Estado']],
    consulta: (db) => creditos.listar(db, { estado: 'vigentes', limite: 5000 }),
    totales: ['saldo_financiado', 'total_abonado', 'saldo_actual'],
  },
  abonos: {
    titulo: 'Abonos por fecha',
    columnas: [['fecha', 'Fecha'], ['credito', 'Crédito'], ['cliente', 'Cliente'], ['valor', 'Valor'], ['metodo_pago', 'Método'], ['referencia', 'Referencia'], ['usuario', 'Registró']],
    consulta: (db, f) => db.prepare(`SELECT p.fecha, c.numero credito, cl.nombre cliente, p.valor, p.metodo_pago, p.referencia, u.nombre usuario
        FROM pagos p JOIN creditos c ON c.id = p.credito_id JOIN clientes cl ON cl.id = c.cliente_id LEFT JOIN usuarios u ON u.id = p.usuario_id
        WHERE p.tipo = 'abono' AND p.anulado = 0 AND p.fecha BETWEEN ? AND ? ORDER BY p.fecha DESC`).all(d0(f.desde), d1(f.hasta)),
    totales: ['valor'],
  },
  cuentas_pagar: {
    titulo: 'Cuentas por pagar',
    columnas: [['numero', 'Compra'], ['proveedor', 'Proveedor'], ['numero_factura', 'Factura'], ['fecha', 'Fecha'], ['fecha_vencimiento', 'Vence'], ['total', 'Total'], ['valor_pagado', 'Pagado'], ['saldo_pendiente', 'Saldo'], ['dias', 'Días para vencer']],
    consulta: (db) => db.prepare(`SELECT c.numero, p.nombre proveedor, c.numero_factura, c.fecha, c.fecha_vencimiento, c.total, c.valor_pagado, c.saldo_pendiente,
        CASE WHEN c.fecha_vencimiento IS NULL THEN NULL ELSE CAST(julianday(c.fecha_vencimiento) - julianday(?) AS INTEGER) END dias
        FROM compras c LEFT JOIN proveedores p ON p.id = c.proveedor_id WHERE c.estado = 'confirmada' AND c.saldo_pendiente > 0 ORDER BY c.fecha_vencimiento`).all(hoy()),
    totales: ['total', 'valor_pagado', 'saldo_pendiente'],
  },
  gastos: {
    titulo: 'Gastos',
    columnas: [['fecha', 'Fecha'], ['categoria', 'Categoría'], ['descripcion', 'Descripción'], ['valor', 'Valor'], ['metodo_pago', 'Método'], ['usuario', 'Registró']],
    consulta: (db, f) => db.prepare(`SELECT g.fecha, g.categoria, g.descripcion, g.valor, g.metodo_pago, u.nombre usuario FROM gastos g LEFT JOIN usuarios u ON u.id = g.usuario_id
        WHERE g.anulado = 0 AND g.fecha BETWEEN ? AND ? ORDER BY g.fecha DESC`).all(d0(f.desde), d1(f.hasta)),
    totales: ['valor'],
  },
  cierres_caja: {
    titulo: 'Cierres de caja',
    columnas: [['id', 'N°'], ['abierta_en', 'Apertura'], ['cerrada_en', 'Cierre'], ['usuario_apertura', 'Abrió'], ['usuario_cierre', 'Cerró'], ['base_inicial', 'Base'], ['ventas_facturadas', 'Ventas facturadas'], ['recaudado', 'Recaudado'], ['egresos', 'Egresos'], ['efectivo_esperado', 'Efectivo esperado'], ['efectivo_contado', 'Contado'], ['diferencia', 'Diferencia']],
    consulta: (db, f) => db.prepare(`SELECT s.*, ua.nombre usuario_apertura, uc.nombre usuario_cierre FROM caja_sesiones s LEFT JOIN usuarios ua ON ua.id = s.usuario_apertura_id LEFT JOIN usuarios uc ON uc.id = s.usuario_cierre_id
        WHERE s.abierta_en BETWEEN ? AND ? ORDER BY s.id DESC`).all(d0(f.desde), d1(f.hasta)).map((s) => {
      const r = s.resumen ? JSON.parse(s.resumen) : {};
      return { ...s, ventas_facturadas: r.ventas_facturadas || 0, recaudado: r.total_ingresos || 0, egresos: r.total_egresos || 0 };
    }),
    totales: ['ventas_facturadas', 'recaudado', 'egresos', 'diferencia'],
  },
  baja_rotacion: {
    titulo: 'Productos de baja rotación',
    columnas: [['nombre', 'Producto'], ['referencia', 'Referencia'], ['stock', 'Stock'], ['valor_costo', 'Valor al costo'], ['precio_venta', 'Precio venta'], ['ultima_venta', 'Última venta']],
    consulta: (db, f) => productos.sinMovimiento(db, Number(f.dias) || getConfig(db, 'dias_sin_movimiento') || 30),
    totales: ['stock', 'valor_costo'],
  },
  rentabilidad_operaciones: {
    titulo: 'Rentabilidad por operación',
    criterios: 'Una fila por producto vendido. Ingreso neto = total facturado en COP − devoluciones. Costo = costo histórico de las unidades vendidas (lote FIFO/promedio, tasa de la compra + gastos prorrateados). Ganancia bruta = ingreso neto − costo. Ganancia neta = bruta − comisiones − gastos de venta prorrateados. Impuestos informativos. Diferencia cambiaria separada (abonos en USD a otra tasa).',
    columnas: [['numero', 'Venta'], ['fecha', 'Fecha'], ['cliente', 'Cliente'], ['nombre_producto', 'Producto'], ['unidades', 'Unidades'], ['moneda', 'Moneda'], ['tasa_cambio', 'Tasa venta'], ['precio_unitario_moneda', 'Precio unit. (moneda)'], ['ingreso_neto', 'Ingreso neto COP'], ['tasa_compra_promedio', 'Tasa compra prom.'], ['costo_usd', 'Costo USD'], ['costo_neto', 'Costo COP'], ['ganancia_bruta', 'Ganancia bruta'], ['comision_item', 'Comisión'], ['gastos_item', 'Gastos venta'], ['ganancia_neta', 'Ganancia neta'], ['margen_pct', 'Margen %'], ['impuestos_item', 'Impuestos (inf.)'], ['diferencia_cambiaria_item', 'Dif. cambiaria'], ['resultado', 'Resultado']],
    consulta: (db, f) => contabilidad.operaciones(db, f).items.map((it) => ({ ...it, unidades: it.cantidad - it.cantidad_devuelta, cliente: it.cliente || 'Consumidor final' })),
    totales: ['unidades', 'ingreso_neto', 'costo_neto', 'ganancia_bruta', 'comision_item', 'gastos_item', 'ganancia_neta', 'impuestos_item', 'diferencia_cambiaria_item'],
  },
  productos_rentabilidad: {
    titulo: 'Productos más y menos rentables',
    criterios: 'Agregado de la rentabilidad por operación del periodo, ordenado de mayor a menor ganancia bruta.',
    columnas: [['nombre', 'Producto'], ['categoria', 'Categoría'], ['unidades', 'Unidades'], ['ingreso', 'Ingreso neto'], ['costo', 'Costo'], ['ganancia_bruta', 'Ganancia bruta'], ['ganancia_neta', 'Ganancia neta'], ['margen_pct', 'Margen %']],
    consulta: (db, f) => {
      const m = new Map();
      for (const it of contabilidad.operaciones(db, f).items) {
        const p = m.get(it.producto_id) || { nombre: it.nombre_producto, categoria: it.categoria, unidades: 0, ingreso: 0, costo: 0, ganancia_bruta: 0, ganancia_neta: 0 };
        p.unidades += it.cantidad - it.cantidad_devuelta; p.ingreso += it.ingreso_neto; p.costo += it.costo_neto; p.ganancia_bruta += it.ganancia_bruta; p.ganancia_neta += it.ganancia_neta; m.set(it.producto_id, p);
      }
      return [...m.values()].map((p) => ({ ...p, margen_pct: p.ingreso > 0 ? Math.round((p.ganancia_bruta * 1000) / p.ingreso) / 10 : 0 })).sort((a, b) => b.ganancia_bruta - a.ganancia_bruta);
    },
    totales: ['unidades', 'ingreso', 'costo', 'ganancia_bruta', 'ganancia_neta'],
  },
  tasas_aplicadas: {
    titulo: 'Tasas de cambio aplicadas a cada operación',
    criterios: 'Compras y ventas del periodo con la moneda, la tasa registrada en el momento de la operación y su origen (TRM oficial, mercado o manual). Las operaciones en COP tienen tasa 1. En compras, "TRM referencia" es la TRM oficial vigente el día de la compra, guardada como fotografía histórica.',
    columnas: [['operacion', 'Operación'], ['numero', 'N°'], ['fecha', 'Fecha'], ['tercero', 'Proveedor / cliente'], ['moneda', 'Moneda'], ['tasa_cambio', 'Tasa aplicada'], ['tasa_origen', 'Origen'], ['tasa_trm', 'TRM referencia'], ['fecha_trm', 'Fecha TRM'], ['total_moneda', 'Total (moneda)'], ['total_cop', 'Total COP'], ['estado', 'Estado'], ['referencia', 'Referencia']],
    consulta: (db, f) => contabilidad.tasasAplicadas(db, f).filas,
    totales: ['total_cop'],
  },
  diferencias_cambiarias: {
    titulo: 'Diferencias cambiarias realizadas',
    criterios: 'Pagos a proveedores y abonos de clientes en USD liquidados a una tasa distinta a la de la compra/venta. Positivo = ganancia cambiaria (se pagó con menos pesos o se cobró con más). No forma parte de la ganancia comercial.',
    columnas: [['fecha', 'Fecha'], ['tipo', 'Tipo'], ['operacion', 'Operación'], ['tercero', 'Tercero'], ['valor_moneda', 'Valor USD'], ['tasa_operacion', 'Tasa operación'], ['tasa_pago', 'Tasa pago'], ['diferencia', 'Diferencia COP'], ['nota', 'Nota']],
    consulta: (db, f) => contabilidad.diferencias(db, f).filas.map((x) => ({ ...x, tipo: x.tipo === 'pago_compra' ? 'Pago a proveedor' : 'Abono de cliente', operacion: x.compra_numero || x.venta_numero, tercero: x.proveedor || x.cliente })),
    totales: ['diferencia'],
  },
  comparacion_mensual: {
    titulo: 'Comparación mensual de resultados',
    criterios: 'Por mes: compras confirmadas, ventas facturadas, devoluciones, costo de lo vendido, ganancia bruta y neta de las operaciones, gastos operativos y utilidad estimada. Diferencia cambiaria separada.',
    columnas: [['mes', 'Mes'], ['compras', 'Compras'], ['ventas', 'Ventas'], ['devoluciones', 'Devoluciones'], ['ventas_netas', 'Ventas netas'], ['costo', 'Costo vendido'], ['ganancia_bruta', 'Ganancia bruta'], ['margen_pct', 'Margen %'], ['ganancia_neta_operaciones', 'Neta operaciones'], ['gastos_operativos', 'Gastos operativos'], ['utilidad_estimada', 'Utilidad estimada'], ['diferencia_cambiaria', 'Dif. cambiaria']],
    consulta: (db, f) => contabilidad.comparacionMensual(db, f).filas,
    totales: ['compras', 'ventas', 'devoluciones', 'ventas_netas', 'costo', 'ganancia_bruta', 'ganancia_neta_operaciones', 'gastos_operativos', 'utilidad_estimada', 'diferencia_cambiaria'],
  },
  precios_proveedores: {
    titulo: 'Comparación de precios de proveedores',
    columnas: [['producto', 'Producto'], ['proveedor', 'Proveedor'], ['ultimo_costo', 'Último costo'], ['costo_minimo', 'Costo mínimo'], ['costo_maximo', 'Costo máximo'], ['compras', 'N° compras'], ['ultima_fecha', 'Última compra']],
    consulta: (db) => db.prepare(`SELECT p.nombre producto, pr.nombre proveedor,
        (SELECT l2.costo_unitario FROM lotes l2 WHERE l2.producto_id = l.producto_id AND l2.proveedor_id = l.proveedor_id AND l2.origen = 'compra' ORDER BY l2.fecha DESC, l2.id DESC LIMIT 1) ultimo_costo,
        MIN(l.costo_unitario) costo_minimo, MAX(l.costo_unitario) costo_maximo, COUNT(DISTINCT l.compra_id) compras, MAX(l.fecha) ultima_fecha
        FROM lotes l JOIN productos p ON p.id = l.producto_id JOIN proveedores pr ON pr.id = l.proveedor_id WHERE l.origen = 'compra' AND l.estado <> 'anulado'
        GROUP BY l.producto_id, l.proveedor_id ORDER BY p.nombre, ultimo_costo`).all(),
  },
};

function lista() {
  return Object.entries(REPORTES).map(([clave, r]) => ({ clave, titulo: r.titulo }));
}

function generar(db, clave, filtros = {}) {
  const def = REPORTES[clave];
  if (!def) return null;
  const f = { ...filtros };
  if (!f.desde && !f.hasta && f.periodo) Object.assign(f, rangoPeriodo(f.periodo));
  const filas = def.consulta(db, f);
  const totales = {};
  for (const col of def.totales || []) totales[col] = filas.reduce((s, x) => s + (Number(x[col]) || 0), 0);
  return { clave, titulo: def.titulo, columnas: def.columnas.map(([clave, titulo]) => ({ clave, titulo })), filas, totales, filtros: f, generado: ahora(), periodo: { desde: f.desde || null, hasta: f.hasta || null }, moneda: 'COP', criterios: def.criterios || 'Valores en pesos colombianos según los registros de la aplicación.' };
}

module.exports = { lista, generar, REPORTES };
