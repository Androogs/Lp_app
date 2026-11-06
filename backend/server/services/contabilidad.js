'use strict';
// Contabilidad y rentabilidad: cruza compras (costo histórico en COP con su tasa), ventas (ingreso en COP con su tasa),
// costos de venta y diferencias cambiarias realizadas. Moneda de presentación: COP.
const { hoy, aFecha, sumarDias, rangoPeriodo, pad } = require('../util');
const trm = require('./trm');

const d0 = (desde) => (desde || '2000-01-01') + ' 00:00:00';
const d1 = (hasta) => (hasta || '2999-12-31') + ' 23:59:59';
const d0c = (desde) => desde || '2000-01-01'; // compras.fecha puede no traer hora (registros anteriores): sin sufijo entran ambas formas

function resolverRango(f = {}) {
  if (f.desde && f.hasta) return { desde: f.desde, hasta: f.hasta };
  if (f.periodo === 'trimestre') { const h = hoy(); const m = Number(h.slice(5, 7)); const ini = `${h.slice(0, 5)}${pad(Math.floor((m - 1) / 3) * 3 + 1)}-01`; return { desde: ini, hasta: h }; }
  if (f.periodo) return rangoPeriodo(f.periodo);
  return rangoPeriodo('mes');
}

// Filtros comunes sobre ítems de venta (producto, categoría, proveedor de los lotes vendidos, moneda de la venta).
function filtrosItems(f) {
  const cond = ["v.estado <> 'anulada'", 'v.fecha BETWEEN ? AND ?'];
  const params = [d0(f.desde), d1(f.hasta)];
  if (f.producto_id) { cond.push('vi.producto_id = ?'); params.push(Number(f.producto_id)); }
  if (f.categoria_id) { cond.push('(p.categoria_id = ? OR p.subcategoria_id = ?)'); params.push(Number(f.categoria_id), Number(f.categoria_id)); }
  if (f.proveedor_id) { cond.push('EXISTS (SELECT 1 FROM venta_item_lotes vl JOIN lotes l ON l.id = vl.lote_id WHERE vl.venta_item_id = vi.id AND l.proveedor_id = ?)'); params.push(Number(f.proveedor_id)); }
  if (f.moneda) { cond.push('v.moneda = ?'); params.push(String(f.moneda).toUpperCase()); }
  if (f.vendedor_id) { cond.push('v.vendedor_id = ?'); params.push(Number(f.vendedor_id)); }
  return { where: cond.join(' AND '), params };
}

// Rentabilidad por operación: una fila por ítem vendido con su costo por lote, tasas, costos de venta y resultado.
function operaciones(db, filtros = {}) {
  const f = { ...filtros, ...resolverRango(filtros) };
  const { where, params } = filtrosItems(f);
  const filas = db.prepare(`SELECT vi.id, vi.venta_id, v.numero, v.fecha, v.estado, v.tipo_pago, v.moneda, v.tasa_cambio, v.tasa_origen, v.comision, v.gastos_venta, v.impuestos, v.total AS venta_total, v.cliente_id, cl.nombre AS cliente,
      vi.producto_id, vi.nombre_producto, p.categoria_id, c.nombre AS categoria, vi.cantidad, vi.cantidad_devuelta, vi.precio_unitario, vi.precio_unitario_moneda, vi.descuento, vi.total, vi.costo_total,
      (SELECT COALESCE(SUM(di.valor),0) FROM devolucion_items di WHERE di.venta_item_id = vi.id) AS devuelto,
      (SELECT COALESCE(SUM(di.costo),0) FROM devolucion_items di WHERE di.venta_item_id = vi.id) AS costo_devuelto,
      (SELECT cr.estado FROM creditos cr WHERE cr.venta_id = v.id) AS credito_estado,
      (SELECT COALESCE(SUM(dc.diferencia),0) FROM diferencias_cambiarias dc WHERE dc.venta_id = v.id) AS diferencia_venta
    FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id JOIN productos p ON p.id = vi.producto_id LEFT JOIN categorias c ON c.id = p.categoria_id LEFT JOIN clientes cl ON cl.id = v.cliente_id
    WHERE ${where} ORDER BY v.fecha DESC, vi.id DESC LIMIT 5000`).all(...params);
  const lotesDe = db.prepare('SELECT vl.lote_id, vl.cantidad, vl.cantidad_devuelta, vl.costo_unitario, vl.moneda_compra, vl.tasa_compra, vl.costo_unitario_moneda, vl.serial, l.fecha AS lote_fecha, co.numero AS compra_numero, pr.nombre AS proveedor FROM venta_item_lotes vl JOIN lotes l ON l.id = vl.lote_id LEFT JOIN compras co ON co.id = l.compra_id LEFT JOIN proveedores pr ON pr.id = l.proveedor_id WHERE vl.venta_item_id = ?');
  const items = filas.map((r) => {
    const lotes = lotesDe.all(r.id);
    const share = r.venta_total > 0 ? r.total / r.venta_total : 0;
    const ingresoNeto = r.total - r.devuelto;
    const costoNeto = r.costo_total - r.costo_devuelto;
    const gananciaBruta = ingresoNeto - costoNeto;
    const comision = Math.round(r.comision * share), gastos = Math.round(r.gastos_venta * share), impuestos = Math.round(r.impuestos * share);
    const gananciaNeta = gananciaBruta - comision - gastos;
    const unidadesUsd = lotes.filter((l) => l.moneda_compra === 'USD');
    const cantUsd = unidadesUsd.reduce((s, l) => s + l.cantidad, 0);
    const tasaCompraProm = cantUsd ? Math.round((unidadesUsd.reduce((s, l) => s + l.cantidad * l.tasa_compra, 0) / cantUsd) * 100) / 100 : null;
    const costoUsd = cantUsd ? Math.round(unidadesUsd.reduce((s, l) => s + l.cantidad * (l.costo_unitario_moneda || 0), 0) * 100) / 100 : null;
    return {
      ...r, lotes, ingreso_neto: ingresoNeto, costo_neto: costoNeto, ganancia_bruta: gananciaBruta, comision_item: comision, gastos_item: gastos, impuestos_item: impuestos, ganancia_neta: gananciaNeta,
      margen_pct: ingresoNeto > 0 ? Math.round((gananciaBruta * 1000) / ingresoNeto) / 10 : 0,
      tasa_compra_promedio: tasaCompraProm, costo_usd: costoUsd,
      diferencia_tasa: r.moneda === 'USD' && tasaCompraProm ? Math.round((r.tasa_cambio - tasaCompraProm) * 100) / 100 : null,
      diferencia_cambiaria_item: Math.round(r.diferencia_venta * share),
      resultado: r.estado === 'anulada' ? 'anulada' : (!r.credito_estado || ['pagado', 'anulado'].includes(r.credito_estado)) ? 'definitivo' : 'estimado',
      metodo_costo: lotes.some((l) => l.metodo === 'PROMEDIO') ? 'PROMEDIO' : 'FIFO',
    };
  });
  const suma = (k) => items.reduce((s, it) => s + (it[k] || 0), 0);
  const totales = { ingreso: suma('total'), devuelto: suma('devuelto'), ingreso_neto: suma('ingreso_neto'), costo: suma('costo_neto'), ganancia_bruta: suma('ganancia_bruta'), comisiones: suma('comision_item'), gastos_venta: suma('gastos_item'), impuestos: suma('impuestos_item'), ganancia_neta: suma('ganancia_neta'), diferencia_cambiaria: suma('diferencia_cambiaria_item'), unidades: items.reduce((s, it) => s + it.cantidad - it.cantidad_devuelta, 0) };
  totales.margen_pct = totales.ingreso_neto > 0 ? Math.round((totales.ganancia_bruta * 1000) / totales.ingreso_neto) / 10 : 0;
  totales.estimados = items.filter((it) => it.resultado === 'estimado').length;
  return { filtros: f, items, totales };
}

// Agrupa fechas en periodos: dia, semana (ISO), mes, trimestre, anio.
function clavePeriodo(fecha, g) {
  const d = aFecha(fecha);
  const y = d.getFullYear();
  if (g === 'dia') return fecha.slice(0, 10);
  if (g === 'semana') { const t = new Date(Date.UTC(y, d.getMonth(), d.getDate())); const dow = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - dow); const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); const w = Math.ceil(((t - y0) / 86400000 + 1) / 7); return `${t.getUTCFullYear()}-S${pad(w)}`; }
  if (g === 'mes') return fecha.slice(0, 7);
  if (g === 'trimestre') return `${y}-T${Math.floor(d.getMonth() / 3) + 1}`;
  return String(y);
}
function etiquetaPeriodo(clave, g) {
  if (g === 'dia') return `${clave.slice(8, 10)}/${clave.slice(5, 7)}`;
  if (g === 'mes') { const m = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']; return `${m[Number(clave.slice(5, 7)) - 1]} ${clave.slice(2, 4)}`; }
  return clave;
}
function serie(db, { desde, hasta, granularidad }) {
  const g = ['dia', 'semana', 'mes', 'trimestre', 'anio'].includes(granularidad) ? granularidad : 'mes';
  const buckets = new Map();
  const asegurar = (k) => { if (!buckets.has(k)) buckets.set(k, { periodo: k, etiqueta: etiquetaPeriodo(k, g), compras: 0, ventas: 0, devoluciones: 0, costo: 0, ganancia_bruta: 0, ganancia_neta: 0, gastos: 0, diferencia_cambiaria: 0 }); return buckets.get(k); };
  // Rellena los periodos vacíos del rango
  for (let f = desde; f <= hasta; f = sumarDias(f, 1)) asegurar(clavePeriodo(f, g));
  for (const r of db.prepare("SELECT fecha, total FROM compras WHERE estado = 'confirmada' AND fecha BETWEEN ? AND ?").all(d0c(desde), d1(hasta))) asegurar(clavePeriodo(r.fecha, g)).compras += r.total;
  for (const r of db.prepare("SELECT fecha, total, costo_total, ganancia, ganancia_neta FROM ventas WHERE estado <> 'anulada' AND fecha BETWEEN ? AND ?").all(d0(desde), d1(hasta))) { const b = asegurar(clavePeriodo(r.fecha, g)); b.ventas += r.total; b.costo += r.costo_total; b.ganancia_bruta += r.ganancia; b.ganancia_neta += r.ganancia_neta; }
  for (const r of db.prepare("SELECT d.fecha, d.total, (SELECT COALESCE(SUM(di.valor - di.costo),0) FROM devolucion_items di WHERE di.devolucion_id = d.id) AS gan FROM devoluciones d WHERE d.tipo <> 'anulacion' AND d.fecha BETWEEN ? AND ?").all(d0(desde), d1(hasta))) { const b = asegurar(clavePeriodo(r.fecha, g)); b.devoluciones += r.total; b.ganancia_bruta -= r.gan; b.ganancia_neta -= r.gan; }
  for (const r of db.prepare('SELECT fecha, valor FROM gastos WHERE anulado = 0 AND fecha BETWEEN ? AND ?').all(d0(desde), d1(hasta))) asegurar(clavePeriodo(r.fecha, g)).gastos += r.valor;
  for (const r of db.prepare('SELECT fecha, diferencia FROM diferencias_cambiarias WHERE fecha BETWEEN ? AND ?').all(d0(desde), d1(hasta))) asegurar(clavePeriodo(r.fecha, g)).diferencia_cambiaria += r.diferencia;
  return { granularidad: g, puntos: [...buckets.values()].sort((a, b) => (a.periodo < b.periodo ? -1 : 1)).map((b) => ({ ...b, ventas_netas: b.ventas - b.devoluciones })) };
}

// Panel financiero del empleador.
function panel(db, filtros = {}) {
  const f = { ...filtros, ...resolverRango(filtros) };
  const ops = operaciones(db, f);
  const t = ops.totales;
  const conFiltro = !!(f.producto_id || f.categoria_id || f.proveedor_id || f.moneda || f.vendedor_id);
  const comprasPeriodo = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total),0) total, COALESCE(SUM(CASE WHEN moneda = 'USD' THEN total_moneda ELSE 0 END),0) total_usd, COALESCE(SUM(CASE WHEN moneda = 'USD' THEN 1 ELSE 0 END),0) n_usd FROM compras WHERE estado = 'confirmada' AND fecha BETWEEN ? AND ?`).get(d0c(f.desde), d1(f.hasta));
  const capital = db.prepare("SELECT COALESCE(SUM(total),0) t FROM compras WHERE estado = 'confirmada'").get().t;
  const inventario = db.prepare("SELECT COALESCE(SUM(s.valor_costo),0) valor_costo, COALESCE(SUM(s.stock * p.precio_venta),0) valor_venta, COALESCE(SUM(s.stock),0) unidades FROM productos p JOIN v_stock s ON s.producto_id = p.id WHERE p.estado <> 'inactivo'").get();
  const inventarioUsd = db.prepare("SELECT COALESCE(SUM(cantidad_restante * costo_unitario),0) cop, COALESCE(SUM(cantidad_restante * costo_unitario_moneda),0) usd, COALESCE(SUM(cantidad_restante),0) unidades FROM lotes WHERE moneda = 'USD' AND cantidad_restante > 0 AND estado <> 'anulado'").get();
  const gastosOperativos = db.prepare('SELECT COALESCE(SUM(valor),0) t FROM gastos WHERE anulado = 0 AND fecha BETWEEN ? AND ?').get(d0(f.desde), d1(f.hasta)).t;
  const difs = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(diferencia),0) neto, COALESCE(SUM(CASE WHEN diferencia > 0 THEN diferencia ELSE 0 END),0) ganancia, COALESCE(SUM(CASE WHEN diferencia < 0 THEN diferencia ELSE 0 END),0) perdida FROM diferencias_cambiarias WHERE fecha BETWEEN ? AND ?').get(d0(f.desde), d1(f.hasta));
  const porProducto = new Map();
  for (const it of ops.items) {
    const p = porProducto.get(it.producto_id) || { producto_id: it.producto_id, nombre: it.nombre_producto, categoria: it.categoria, unidades: 0, ingreso: 0, costo: 0, ganancia_bruta: 0, ganancia_neta: 0 };
    p.unidades += it.cantidad - it.cantidad_devuelta; p.ingreso += it.ingreso_neto; p.costo += it.costo_neto; p.ganancia_bruta += it.ganancia_bruta; p.ganancia_neta += it.ganancia_neta;
    porProducto.set(it.producto_id, p);
  }
  const productos = [...porProducto.values()].map((p) => ({ ...p, margen_pct: p.ingreso > 0 ? Math.round((p.ganancia_bruta * 1000) / p.ingreso) / 10 : 0 }));
  const masRentables = [...productos].sort((a, b) => b.ganancia_bruta - a.ganancia_bruta).slice(0, 8);
  const menosRentables = [...productos].sort((a, b) => a.ganancia_bruta - b.ganancia_bruta).slice(0, 8);
  const trmVig = trm.trmVigente(db);
  const trmIni = trm.trmVigente(db, f.desde);
  const mercado = trm.mercadoUltimo(db);
  return {
    periodo: { desde: f.desde, hasta: f.hasta, granularidad: f.granularidad || 'mes' }, filtros_activos: conFiltro,
    capital_invertido: capital,
    inventario: { valor_costo: inventario.valor_costo, valor_venta: inventario.valor_venta, unidades: inventario.unidades, usd: { cop: inventarioUsd.cop, usd: Math.round(inventarioUsd.usd * 100) / 100, unidades: inventarioUsd.unidades, valor_hoy: trmVig ? Math.round(inventarioUsd.usd * trmVig.valor) : null } },
    compras: { cantidad: comprasPeriodo.n, total: comprasPeriodo.total, total_usd: Math.round(comprasPeriodo.total_usd * 100) / 100, n_usd: comprasPeriodo.n_usd },
    ventas: { total: t.ingreso, devoluciones: t.devuelto, netas: t.ingreso_neto, unidades: t.unidades, operaciones: ops.items.length, estimadas: t.estimados },
    costo_vendido: t.costo, ganancia_bruta: t.ganancia_bruta, margen_pct: t.margen_pct,
    costos_venta: { comisiones: t.comisiones, gastos_venta: t.gastos_venta, impuestos: t.impuestos }, ganancia_neta_operaciones: t.ganancia_neta,
    gastos_operativos: gastosOperativos, ganancia_neta_estimada: t.ganancia_neta - (conFiltro ? 0 : gastosOperativos),
    diferencias_cambiarias: { ...difs, nota: 'Diferencia realizada al pagar o cobrar en USD a una tasa distinta a la de la operación. No forma parte de la ganancia comercial.' },
    productos: { mas_rentables: masRentables, menos_rentables: menosRentables, total: productos.length },
    serie: serie(db, { desde: f.desde, hasta: f.hasta, granularidad: f.granularidad }),
    trm: { vigente: trmVig ? { valor: trmVig.valor, fecha: trmVig.fecha } : null, inicio_periodo: trmIni ? { valor: trmIni.valor, fecha: trmIni.fecha } : null, variacion_periodo: trmVig && trmIni ? Math.round((trmVig.valor - trmIni.valor) * 100) / 100 : null, mercado: mercado ? { valor: mercado.valor, fecha: mercado.fecha } : null },
    criterios: 'Ingresos y costos en COP. Costo de ventas por lote (FIFO o promedio según configuración) al costo histórico de adquisición (tasa de la compra + gastos prorrateados). Ganancia bruta = ingreso neto − costo. Ganancia neta estimada = bruta − comisiones − gastos de venta − gastos operativos del periodo (sin filtros). Impuestos informativos. Diferencia cambiaria separada.',
  };
}

// Historial financiero de un producto.
function producto(db, id) {
  const p = db.prepare('SELECT p.*, s.stock, s.valor_costo FROM productos p JOIN v_stock s ON s.producto_id = p.id WHERE p.id = ?').get(id);
  if (!p) return null;
  const lotes = db.prepare(`SELECT l.*, co.numero AS compra_numero, co.tasa_origen, pr.nombre AS proveedor FROM lotes l LEFT JOIN compras co ON co.id = l.compra_id LEFT JOIN proveedores pr ON pr.id = l.proveedor_id WHERE l.producto_id = ? AND l.estado <> 'anulado' ORDER BY l.fecha, l.id`).all(id);
  const ventas = db.prepare(`SELECT vi.id, v.id AS venta_id, v.numero, v.fecha, v.estado, v.moneda, v.tasa_cambio, vi.cantidad, vi.cantidad_devuelta, vi.precio_unitario, vi.precio_unitario_moneda, vi.total, vi.costo_total,
      (SELECT COALESCE(SUM(di.valor),0) FROM devolucion_items di WHERE di.venta_item_id = vi.id) devuelto, (SELECT COALESCE(SUM(di.costo),0) FROM devolucion_items di WHERE di.venta_item_id = vi.id) costo_devuelto
    FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id WHERE vi.producto_id = ? AND v.estado <> 'anulada' ORDER BY v.fecha DESC`).all(id);
  const lotesDe = db.prepare('SELECT vl.lote_id, vl.cantidad, vl.costo_unitario, vl.moneda_compra, vl.tasa_compra, vl.costo_unitario_moneda, l.fecha AS lote_fecha, co.numero AS compra_numero FROM venta_item_lotes vl JOIN lotes l ON l.id = vl.lote_id LEFT JOIN compras co ON co.id = l.compra_id WHERE vl.venta_item_id = ?');
  for (const v of ventas) { v.lotes = lotesDe.all(v.id); v.ingreso_neto = v.total - v.devuelto; v.costo_neto = v.costo_total - v.costo_devuelto; v.ganancia = v.ingreso_neto - v.costo_neto; v.unidades = v.cantidad - v.cantidad_devuelta; }
  const unidadesVendidas = ventas.reduce((s, v) => s + v.unidades, 0);
  const ingreso = ventas.reduce((s, v) => s + v.ingreso_neto, 0);
  const costo = ventas.reduce((s, v) => s + v.costo_neto, 0);
  const comprasUsd = lotes.filter((l) => l.moneda === 'USD' && l.origen === 'compra');
  const ventasUsd = ventas.filter((v) => v.moneda === 'USD');
  const tasaCompraProm = comprasUsd.length ? Math.round((comprasUsd.reduce((s, l) => s + l.cantidad_inicial * l.tasa_cambio, 0) / comprasUsd.reduce((s, l) => s + l.cantidad_inicial, 0)) * 100) / 100 : null;
  const tasaVentaProm = ventasUsd.length ? Math.round((ventasUsd.reduce((s, v) => s + v.unidades * v.tasa_cambio, 0) / Math.max(1, ventasUsd.reduce((s, v) => s + v.unidades, 0))) * 100) / 100 : null;
  const comprados = lotes.filter((l) => l.origen === 'compra');
  const costos = comprados.map((l) => l.costo_unitario);
  const trmVig = trm.trmVigente(db);
  const stockUsd = lotes.filter((l) => l.moneda === 'USD' && l.cantidad_restante > 0).reduce((s, l) => s + l.cantidad_restante * (l.costo_unitario_moneda || 0), 0);
  return {
    producto: { id: p.id, nombre: p.nombre, referencia: p.referencia, precio_venta: p.precio_venta, precio_compra: p.precio_compra, stock: p.stock, valor_costo: p.valor_costo },
    compras: lotes, ventas,
    resumen: {
      unidades_compradas: comprados.reduce((s, l) => s + l.cantidad_inicial, 0), unidades_vendidas: unidadesVendidas, stock: p.stock, valor_inventario: p.valor_costo,
      costo_promedio_actual: p.stock > 0 ? Math.round(p.valor_costo / p.stock) : null, costo_minimo: costos.length ? Math.min(...costos) : null, costo_maximo: costos.length ? Math.max(...costos) : null, costo_ultimo: comprados.length ? comprados[comprados.length - 1].costo_unitario : null,
      precio_promedio_venta: unidadesVendidas ? Math.round(ingreso / unidadesVendidas) : null, ingreso_total: ingreso, costo_vendido: costo, ganancia_acumulada: ingreso - costo, margen_pct: ingreso > 0 ? Math.round(((ingreso - costo) * 1000) / ingreso) / 10 : 0,
      tasa_compra_promedio: tasaCompraProm, tasa_venta_promedio: tasaVentaProm, diferencia_tasas: tasaCompraProm && tasaVentaProm ? Math.round((tasaVentaProm - tasaCompraProm) * 100) / 100 : null,
      inventario_usd: stockUsd ? { usd: Math.round(stockUsd * 100) / 100, valor_hoy: trmVig ? Math.round(stockUsd * trmVig.valor) : null, trm: trmVig ? trmVig.valor : null } : null,
    },
    evolucion_costo: comprados.map((l) => ({ fecha: l.fecha, costo_unitario: l.costo_unitario, moneda: l.moneda, tasa_cambio: l.tasa_cambio, costo_unitario_moneda: l.costo_unitario_moneda, compra_numero: l.compra_numero })),
  };
}

function diferencias(db, filtros = {}) {
  const f = { ...filtros, ...resolverRango(filtros) };
  const filas = db.prepare(`SELECT dc.*, co.numero AS compra_numero, v.numero AS venta_numero, cr.numero AS credito_numero, pr.nombre AS proveedor, cl.nombre AS cliente, u.nombre AS usuario_nombre
    FROM diferencias_cambiarias dc LEFT JOIN compras co ON co.id = dc.compra_id LEFT JOIN ventas v ON v.id = dc.venta_id LEFT JOIN creditos cr ON cr.id = dc.credito_id
    LEFT JOIN proveedores pr ON pr.id = co.proveedor_id LEFT JOIN clientes cl ON cl.id = v.cliente_id LEFT JOIN usuarios u ON u.id = dc.usuario_id
    WHERE dc.fecha BETWEEN ? AND ? ORDER BY dc.fecha DESC, dc.id DESC`).all(d0(f.desde), d1(f.hasta));
  const totales = { neto: filas.reduce((s, x) => s + x.diferencia, 0), ganancia: filas.filter((x) => x.diferencia > 0).reduce((s, x) => s + x.diferencia, 0), perdida: filas.filter((x) => x.diferencia < 0).reduce((s, x) => s + x.diferencia, 0), operaciones: filas.length };
  return { periodo: { desde: f.desde, hasta: f.hasta }, filas, totales };
}

function tasasAplicadas(db, filtros = {}) {
  const f = { ...filtros, ...resolverRango(filtros) };
  // En compras se agrega la TRM oficial de referencia (fotografía histórica del día de la compra); las ventas no la guardan.
  const compras = db.prepare(`SELECT 'compra' AS operacion, c.numero, c.fecha, c.estado, pr.nombre AS tercero, c.moneda, c.tasa_cambio, c.tasa_origen, c.trm_valor AS tasa_trm, c.trm_fecha AS fecha_trm, c.trm_captura, c.total_moneda AS total_moneda, c.total AS total_cop, c.numero_factura AS referencia FROM compras c LEFT JOIN proveedores pr ON pr.id = c.proveedor_id WHERE c.fecha BETWEEN ? AND ? ${f.moneda ? 'AND c.moneda = ?' : ''}`).all(d0c(f.desde), d1(f.hasta), ...(f.moneda ? [f.moneda] : []));
  const ventas = db.prepare(`SELECT 'venta' AS operacion, v.numero, v.fecha, v.estado, cl.nombre AS tercero, v.moneda, v.tasa_cambio, v.tasa_origen, NULL AS tasa_trm, NULL AS fecha_trm, NULL AS trm_captura, v.total_moneda, v.total AS total_cop, v.tipo_pago AS referencia FROM ventas v LEFT JOIN clientes cl ON cl.id = v.cliente_id WHERE v.fecha BETWEEN ? AND ? ${f.moneda ? 'AND v.moneda = ?' : ''}`).all(d0(f.desde), d1(f.hasta), ...(f.moneda ? [f.moneda] : []));
  const filas = [...compras, ...ventas].sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
  return { periodo: { desde: f.desde, hasta: f.hasta }, filas };
}

function comparacionMensual(db, filtros = {}) {
  const f = { ...filtros };
  if (!f.desde) { const h = hoy(); f.desde = `${Number(h.slice(0, 4)) - 1}-${h.slice(5, 7)}-01`; }
  if (!f.hasta) f.hasta = hoy();
  const s = serie(db, { desde: f.desde, hasta: f.hasta, granularidad: 'mes' });
  const filas = s.puntos.map((b) => ({ mes: b.periodo, compras: b.compras, ventas: b.ventas, devoluciones: b.devoluciones, ventas_netas: b.ventas_netas, costo: b.costo, ganancia_bruta: b.ganancia_bruta, margen_pct: b.ventas_netas > 0 ? Math.round((b.ganancia_bruta * 1000) / b.ventas_netas) / 10 : 0, ganancia_neta_operaciones: b.ganancia_neta, gastos_operativos: b.gastos, utilidad_estimada: b.ganancia_neta - b.gastos, diferencia_cambiaria: b.diferencia_cambiaria }));
  return { periodo: { desde: f.desde, hasta: f.hasta }, filas };
}

module.exports = { operaciones, panel, producto, diferencias, tasasAplicadas, comparacionMensual, serie, resolverRango };
