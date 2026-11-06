'use strict';
// Analítica para los paneles visuales (tablero, ventas, inventario, finanzas, clientes, compras).
// Reutiliza las mismas definiciones que dashboard.js y contabilidad.js: ventas netas = facturado − devoluciones,
// ganancia bruta = ganancia de las ventas − ganancia reintegrada por devoluciones, utilidad estimada = ganancia bruta − gastos.
// Nada se inventa: cuando no hay datos del periodo anterior la variación es null y la interfaz lo indica.
const { hoy, aFecha, sumarDias, sumarMeses, rangoPeriodo, diasEntre, pad } = require('../util');
const dashboard = require('./dashboard');
const creditos = require('./creditos');
const productos = require('./productos');

const d0 = (d) => d + ' 00:00:00';
const d1 = (d) => d + ' 23:59:59';
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const PRESETS = ['hoy', '7d', '30d', 'semana', 'mes', 'anio'];

// ---------- Rangos ----------
// periodo: hoy | 7d | 30d | semana | mes | anio | rango (con desde/hasta) | todo
function rango({ periodo = 'mes', desde, hasta } = {}) {
  const h = hoy();
  if (desde && hasta && /^\d{4}-\d{2}-\d{2}$/.test(desde) && /^\d{4}-\d{2}-\d{2}$/.test(hasta) && desde <= hasta) return { periodo: 'rango', desde, hasta };
  if (periodo === 'todo') {
    return { periodo: 'todo', desde: '2000-01-01', hasta: h };
  }
  if (periodo === '7d') return { periodo, desde: sumarDias(h, -6), hasta: h };
  if (periodo === '30d') return { periodo, desde: sumarDias(h, -29), hasta: h };
  if (PRESETS.includes(periodo)) return { periodo, ...rangoPeriodo(periodo) };
  return { periodo: 'mes', ...rangoPeriodo('mes') };
}

// Periodo anterior comparable: misma duración inmediatamente antes; para mes/año, el mismo tramo del mes/año anterior.
function anterior(r) {
  if (r.periodo === 'todo') return null;
  if (r.periodo === 'mes') return { desde: sumarMeses(r.desde, -1), hasta: sumarMeses(r.hasta, -1) };
  if (r.periodo === 'anio') {
    const a = aFecha(r.desde), b = aFecha(r.hasta);
    return { desde: hoy(new Date(a.getFullYear() - 1, a.getMonth(), a.getDate())), hasta: hoy(new Date(b.getFullYear() - 1, b.getMonth(), b.getDate())) };
  }
  const n = diasEntre(r.desde, r.hasta) + 1;
  return { desde: sumarDias(r.desde, -n), hasta: sumarDias(r.desde, -1) };
}

// Agrupación de la serie según la longitud del periodo.
function granularidad(r) {
  if (r.periodo === 'hoy') return 'hora';
  const n = diasEntre(r.desde, r.hasta) + 1;
  if (n <= 1) return 'hora';
  if (n <= 62) return 'dia';
  if (n <= 200) return 'semana';
  return 'mes';
}

function variacion(actual, anteriorValor) {
  if (anteriorValor === null || anteriorValor === undefined) return { pct: null, diferencia: null };
  const dif = actual - anteriorValor;
  return { pct: anteriorValor ? Math.round((dif * 1000) / Math.abs(anteriorValor)) / 10 : null, diferencia: dif };
}

// ---------- Series temporales ----------
function claveBucket(fecha, g) {
  const f = String(fecha);
  if (g === 'hora') return f.slice(11, 13) || '00';
  if (g === 'dia') return f.slice(0, 10);
  if (g === 'semana') { const d = aFecha(f); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return hoy(d); }
  return f.slice(0, 7);
}
function etiquetaBucket(clave, g) {
  if (g === 'hora') return `${clave}:00`;
  if (g === 'dia' || g === 'semana') return `${clave.slice(8, 10)}/${clave.slice(5, 7)}`;
  return `${MESES[Number(clave.slice(5, 7)) - 1]} ${clave.slice(2, 4)}`;
}
function bucketsVacios(r, g) {
  const m = new Map();
  const nuevo = (k) => ({ clave: k, etiqueta: etiquetaBucket(k, g), ventas: 0, devoluciones: 0, netas: 0, costo: 0, ganancia_bruta: 0, gastos: 0, compras: 0, recibido: 0, n: 0, utilidad: 0 });
  if (g === 'hora') { for (let i = 0; i < 24; i++) { const k = pad(i); m.set(k, nuevo(k)); } return m; }
  for (let f = r.desde; f <= r.hasta; f = sumarDias(f, 1)) { const k = claveBucket(f, g); if (!m.has(k)) m.set(k, nuevo(k)); }
  return m;
}
// Serie del periodo con ventas, devoluciones, costo, ganancia bruta, gastos, compras y dinero recibido por bucket.
function serie(db, r, g, { costos = true } = {}) {
  const m = bucketsVacios(r, g);
  const b = (fecha) => { const k = claveBucket(fecha, g); if (!m.has(k)) m.set(k, { clave: k, etiqueta: etiquetaBucket(k, g), ventas: 0, devoluciones: 0, netas: 0, costo: 0, ganancia_bruta: 0, gastos: 0, compras: 0, recibido: 0, n: 0, utilidad: 0 }); return m.get(k); };
  for (const v of db.prepare("SELECT fecha, total, costo_total, ganancia FROM ventas WHERE estado <> 'anulada' AND fecha BETWEEN ? AND ?").all(d0(r.desde), d1(r.hasta))) {
    const x = b(v.fecha); x.ventas += v.total; x.n += 1; x.costo += v.costo_total; x.ganancia_bruta += v.ganancia;
  }
  for (const d of db.prepare("SELECT d.fecha, d.total, (SELECT COALESCE(SUM(di.valor - di.costo),0) FROM devolucion_items di WHERE di.devolucion_id = d.id) gan FROM devoluciones d WHERE d.tipo <> 'anulacion' AND d.fecha BETWEEN ? AND ?").all(d0(r.desde), d1(r.hasta))) {
    const x = b(d.fecha); x.devoluciones += d.total; x.ganancia_bruta -= d.gan;
  }
  for (const gto of db.prepare('SELECT fecha, valor FROM gastos WHERE anulado = 0 AND fecha BETWEEN ? AND ?').all(d0(r.desde), d1(r.hasta))) b(gto.fecha).gastos += gto.valor;
  for (const c of db.prepare("SELECT fecha, total FROM compras WHERE estado = 'confirmada' AND fecha BETWEEN ? AND ?").all(r.desde, d1(r.hasta))) b(c.fecha).compras += c.total;
  for (const p of db.prepare("SELECT fecha, CASE WHEN tipo = 'reintegro' THEN -valor ELSE valor END valor FROM pagos WHERE anulado = 0 AND tipo IN ('venta','abono','reintegro') AND fecha BETWEEN ? AND ?").all(d0(r.desde), d1(r.hasta))) b(p.fecha).recibido += p.valor;
  const puntos = [...m.values()].sort((a, c) => (a.clave < c.clave ? -1 : 1)).map((x) => {
    x.netas = x.ventas - x.devoluciones;
    x.utilidad = x.ganancia_bruta - x.gastos;
    if (!costos) { delete x.costo; delete x.ganancia_bruta; delete x.utilidad; }
    return x;
  });
  return { granularidad: g, puntos };
}

// ---------- Distribuciones ----------
function metodosPago(db, r) {
  const filas = db.prepare("SELECT metodo_pago metodo, SUM(CASE WHEN tipo = 'reintegro' THEN -valor ELSE valor END) total, SUM(CASE WHEN tipo = 'venta' THEN 1 ELSE 0 END) pagos_venta, SUM(CASE WHEN tipo = 'abono' THEN 1 ELSE 0 END) abonos FROM pagos WHERE anulado = 0 AND tipo IN ('venta','abono','reintegro') AND fecha BETWEEN ? AND ? GROUP BY metodo_pago ORDER BY total DESC").all(d0(r.desde), d1(r.hasta));
  const total = filas.reduce((s, f) => s + f.total, 0);
  const credito = db.prepare("SELECT COALESCE(SUM(saldo_financiado),0) t, COUNT(*) n FROM creditos WHERE estado <> 'anulado' AND fecha BETWEEN ? AND ?").get(d0(r.desde), d1(r.hasta));
  const dom = db.prepare("SELECT COALESCE(SUM(total),0) t, COUNT(*) n FROM ventas WHERE estado <> 'anulada' AND domicilio_id IS NOT NULL AND fecha BETWEEN ? AND ?").get(d0(r.desde), d1(r.hasta));
  return { total, items: filas.map((f) => ({ ...f, pct: total > 0 ? Math.round((f.total * 1000) / total) / 10 : 0 })), credito_otorgado: credito.t, creditos: credito.n, domicilios_total: dom.t, domicilios_n: dom.n };
}

function masVendidos(db, r, limite = 8, costos = true) {
  const filas = db.prepare(`SELECT p.id, p.nombre, c.nombre categoria, SUM(vi.cantidad - vi.cantidad_devuelta) unidades, SUM(vi.total) total, SUM(vi.total - vi.costo_total) ganancia
      FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id JOIN productos p ON p.id = vi.producto_id LEFT JOIN categorias c ON c.id = p.categoria_id
      WHERE v.estado <> 'anulada' AND v.fecha BETWEEN ? AND ? GROUP BY p.id HAVING unidades > 0 ORDER BY unidades DESC, total DESC LIMIT ?`).all(d0(r.desde), d1(r.hasta), limite);
  if (!costos) filas.forEach((f) => { delete f.ganancia; });
  return filas;
}

function distribucionInventario(db, costos = true) {
  const base = `FROM productos p JOIN v_stock s ON s.producto_id = p.id LEFT JOIN categorias c ON c.id = p.categoria_id WHERE p.estado <> 'inactivo'`;
  const grupo = (expr) => db.prepare(`SELECT ${expr} etiqueta, SUM(s.stock) unidades, COUNT(*) productos, SUM(s.valor_costo) valor_costo, SUM(s.stock * p.precio_venta) valor_venta ${base} AND s.stock > 0 GROUP BY etiqueta ORDER BY unidades DESC`).all()
    .map((f) => (costos ? f : { etiqueta: f.etiqueta, unidades: f.unidades, productos: f.productos, valor_venta: f.valor_venta }));
  const estado = db.prepare(`SELECT CASE WHEN s.stock <= 0 THEN 'Agotados' WHEN s.stock <= p.stock_minimo THEN 'Pocas unidades' ELSE 'Con stock' END etiqueta, COUNT(*) productos, SUM(CASE WHEN s.stock > 0 THEN s.stock ELSE 0 END) unidades ${base} AND p.estado IN ('activo','agotado') GROUP BY etiqueta`).all();
  return { categoria: grupo("COALESCE(c.nombre, 'Sin categoría')"), marca: grupo("COALESCE(NULLIF(TRIM(p.marca), ''), 'Sin marca')"), estado };
}

// Licores frente a complementos (bebidas, snacks, hielo, cigarrillos, anchetas…), en unidades disponibles.
const COMPLEMENTOS = ['Bebidas y energizantes', 'Snacks y pasabocas', 'Cigarrillos', 'Vaporizadores', 'Desechables y hielo', 'Anchetas y regalos'];
function licoresComplementos(db) {
  const lista = COMPLEMENTOS.map(() => '?').join(',');
  return db.prepare(`SELECT COALESCE(SUM(CASE WHEN c.nombre IN (${lista}) THEN 0 ELSE s.stock END),0) licores, COALESCE(SUM(CASE WHEN c.nombre IN (${lista}) THEN s.stock ELSE 0 END),0) complementos,
      SUM(CASE WHEN (c.nombre IS NULL OR c.nombre NOT IN (${lista})) AND s.stock > 0 THEN 1 ELSE 0 END) productos_licores, SUM(CASE WHEN c.nombre IN (${lista}) AND s.stock > 0 THEN 1 ELSE 0 END) productos_complementos
    FROM productos p JOIN v_stock s ON s.producto_id = p.id LEFT JOIN categorias c ON c.id = p.categoria_id WHERE p.estado <> 'inactivo' AND s.stock > 0`).get(...COMPLEMENTOS, ...COMPLEMENTOS, ...COMPLEMENTOS, ...COMPLEMENTOS);
}

function rotacion(db, dias, costos = true) {
  const desde = sumarDias(hoy(), -dias);
  const alta = db.prepare(`SELECT p.id, p.nombre, s.stock, SUM(vi.cantidad - vi.cantidad_devuelta) unidades, COUNT(DISTINCT v.id) ventas
      FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id JOIN productos p ON p.id = vi.producto_id JOIN v_stock s ON s.producto_id = p.id
      WHERE v.estado <> 'anulada' AND v.fecha >= ? GROUP BY p.id HAVING unidades > 0 ORDER BY unidades DESC LIMIT 8`).all(d0(desde));
  const baja = productos.sinMovimiento(db, dias).slice(0, 8).map((p) => (costos ? p : { id: p.id, nombre: p.nombre, referencia: p.referencia, stock: p.stock, ultima_venta: p.ultima_venta }));
  return { dias, alta, baja };
}

function reposicion(db, limite = 30) {
  return db.prepare(`SELECT p.id, p.nombre, p.referencia, s.stock, p.stock_minimo, c.nombre categoria,
      (SELECT pr.nombre FROM lotes l JOIN proveedores pr ON pr.id = l.proveedor_id WHERE l.producto_id = p.id AND l.origen = 'compra' ORDER BY l.fecha DESC, l.id DESC LIMIT 1) proveedor,
      (SELECT l.costo_unitario FROM lotes l WHERE l.producto_id = p.id AND l.origen = 'compra' ORDER BY l.fecha DESC, l.id DESC LIMIT 1) ultimo_costo
    FROM productos p JOIN v_stock s ON s.producto_id = p.id LEFT JOIN categorias c ON c.id = p.categoria_id
    WHERE p.estado IN ('activo','agotado') AND s.stock <= p.stock_minimo ORDER BY s.stock, p.nombre LIMIT ?`).all(limite);
}

function cartera(db) {
  creditos.recalcularTodos(db);
  const c = db.prepare("SELECT COALESCE(SUM(saldo_actual),0) pendiente, COUNT(*) vigentes, SUM(CASE WHEN estado = 'vencido' THEN 1 ELSE 0 END) vencidos, COALESCE(SUM(CASE WHEN estado = 'vencido' THEN saldo_actual ELSE 0 END),0) saldo_vencido, COUNT(DISTINCT cliente_id) clientes FROM creditos WHERE estado NOT IN ('pagado','anulado')").get();
  const p = db.prepare("SELECT COALESCE(SUM(saldo_pendiente),0) total, COUNT(*) n, SUM(CASE WHEN fecha_vencimiento IS NOT NULL AND fecha_vencimiento < ? THEN 1 ELSE 0 END) vencidas FROM compras WHERE estado = 'confirmada' AND saldo_pendiente > 0").get(hoy());
  return { ...c, por_pagar: p.total, facturas_pendientes: p.n, facturas_vencidas: p.vencidas };
}

function actividadReciente(db, limite = 8) {
  return db.prepare('SELECT id, fecha, usuario_nombre, accion, entidad, entidad_id FROM auditoria ORDER BY id DESC LIMIT ?').all(limite);
}

// ---------- Paneles por módulo ----------
function panel(db, filtros = {}, { verCostos = true, verAuditoria = false } = {}) {
  const r = rango(filtros);
  const ant = anterior(r);
  const g = granularidad(r);
  const h = hoy();
  const act = dashboard.resumenPeriodo(db, r.desde, r.hasta);
  const prev = ant ? dashboard.resumenPeriodo(db, ant.desde, ant.hasta) : null;
  const hoyR = dashboard.resumenPeriodo(db, h, h);
  const ayerR = dashboard.resumenPeriodo(db, sumarDias(h, -1), sumarDias(h, -1));
  const mes = { periodo: 'mes', ...rangoPeriodo('mes') };
  const mesAntR = anterior(mes);
  const mesAct = dashboard.resumenPeriodo(db, mes.desde, mes.hasta);
  const mesAnt = dashboard.resumenPeriodo(db, mesAntR.desde, mesAntR.hasta);
  const inv = dashboard.inventarioResumen(db);
  const cel = licoresComplementos(db);
  const cart = cartera(db);
  const clientesTotal = db.prepare('SELECT COUNT(*) n FROM clientes WHERE activo = 1').get().n;
  const clientesNuevos = db.prepare('SELECT COUNT(*) n FROM clientes WHERE activo = 1 AND creado_en BETWEEN ? AND ?').get(d0(r.desde), d1(r.hasta)).n;
  const clientesNuevosAnt = ant ? db.prepare('SELECT COUNT(*) n FROM clientes WHERE activo = 1 AND creado_en BETWEEN ? AND ?').get(d0(ant.desde), d1(ant.hasta)).n : null;
  const al = dashboard.alertas(db);
  const agotados = db.prepare(`SELECT p.id, p.nombre, p.referencia, s.stock, p.stock_minimo FROM productos p JOIN v_stock s ON s.producto_id = p.id WHERE p.estado IN ('activo','agotado') AND s.stock <= 0 ORDER BY p.nombre LIMIT 20`).all();
  const salida = {
    periodo: r, anterior: ant, granularidad: g, generado: h,
    kpis: {
      ventas_hoy: { total: hoyR.ventas.netas, cantidad: hoyR.ventas.cantidad, anterior: ayerR.ventas.netas, variacion: variacion(hoyR.ventas.netas, ayerR.ventas.netas) },
      ventas_mes: { total: mesAct.ventas.netas, cantidad: mesAct.ventas.cantidad, anterior: mesAnt.ventas.netas, hasta: mes.hasta, anterior_hasta: mesAntR.hasta, variacion: variacion(mesAct.ventas.netas, mesAnt.ventas.netas) },
      ventas_periodo: { total: act.ventas.netas, cantidad: act.ventas.cantidad, devoluciones: act.ventas.devoluciones, anterior: prev ? prev.ventas.netas : null, variacion: variacion(act.ventas.netas, prev ? prev.ventas.netas : null), recibido: act.total_recibido, compras: act.compras.total, gastos: act.gastos },
      ganancia: verCostos ? { ganancia_bruta: act.ventas.ganancia_bruta, margen_pct: act.ventas.margen_pct, gastos: act.gastos, utilidad: act.utilidad_estimada, costo: act.ventas.costo, anterior: prev ? prev.utilidad_estimada : null, variacion: variacion(act.utilidad_estimada, prev ? prev.utilidad_estimada : null) } : null,
      inventario: { unidades: inv.unidades, productos: inv.productos, licores: cel.licores, complementos: cel.complementos, productos_licores: cel.productos_licores, productos_complementos: cel.productos_complementos, valor_costo: verCostos ? inv.valor_costo : null, valor_venta: inv.valor_venta },
      stock_bajo: { pocas: inv.pocas, agotados: inv.agotados, total: inv.pocas + inv.agotados },
      por_cobrar: { pendiente: cart.pendiente, vigentes: cart.vigentes, vencidos: cart.vencidos, saldo_vencido: cart.saldo_vencido, clientes: cart.clientes, por_pagar: cart.por_pagar, facturas_pendientes: cart.facturas_pendientes, facturas_vencidas: cart.facturas_vencidas },
      clientes: { total: clientesTotal, nuevos: clientesNuevos, nuevos_anterior: clientesNuevosAnt, variacion: variacion(clientesNuevos, clientesNuevosAnt) },
    },
    serie: serie(db, r, g, { costos: verCostos }),
    serie_hoy: serie(db, { desde: h, hasta: h }, 'hora', { costos: verCostos }),
    serie_mes: serie(db, mes, 'dia', { costos: verCostos }),
    metodos_pago: metodosPago(db, r),
    mas_vendidos: masVendidos(db, r, 8, verCostos),
    inventario_distribucion: distribucionInventario(db, verCostos),
    alertas: { ...al, agotados, cuotas_vencidas: al.cuotas_proximas.filter((q) => q.fecha_vencimiento < h), cuotas_por_vencer: al.cuotas_proximas.filter((q) => q.fecha_vencimiento >= h) },
    actividad: verAuditoria ? actividadReciente(db, 8) : [],
    ultimas_ventas: db.prepare(`SELECT v.id, v.numero, v.fecha, v.total, v.tipo_pago, v.estado, c.nombre AS cliente FROM ventas v LEFT JOIN clientes c ON c.id = v.cliente_id ORDER BY v.id DESC LIMIT 8`).all(),
    documentos_pendientes: db.prepare("SELECT COUNT(*) n FROM documentos WHERE estado = 'pendiente'").get().n,
  };
  return salida;
}

function ventas(db, filtros = {}, { verCostos = true } = {}) {
  const r = rango(filtros);
  const ant = anterior(r);
  const g = granularidad(r);
  const act = dashboard.resumenPeriodo(db, r.desde, r.hasta);
  const prev = ant ? dashboard.resumenPeriodo(db, ant.desde, ant.hasta) : null;
  const promedio = act.ventas.cantidad ? Math.round(act.ventas.netas / act.ventas.cantidad) : 0;
  const promedioAnt = prev && prev.ventas.cantidad ? Math.round(prev.ventas.netas / prev.ventas.cantidad) : null;
  const porTipo = db.prepare("SELECT tipo_pago, COUNT(*) n, SUM(total) total FROM ventas WHERE estado <> 'anulada' AND fecha BETWEEN ? AND ? GROUP BY tipo_pago").all(d0(r.desde), d1(r.hasta));
  const porVendedor = db.prepare("SELECT COALESCE(u.nombre, 'Sin vendedor') vendedor, COUNT(*) n, SUM(v.total) total FROM ventas v LEFT JOIN usuarios u ON u.id = v.vendedor_id WHERE v.estado <> 'anulada' AND v.fecha BETWEEN ? AND ? GROUP BY v.vendedor_id ORDER BY total DESC LIMIT 8").all(d0(r.desde), d1(r.hasta));
  const unidades = db.prepare("SELECT COALESCE(SUM(vi.cantidad - vi.cantidad_devuelta),0) n FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id WHERE v.estado <> 'anulada' AND v.fecha BETWEEN ? AND ?").get(d0(r.desde), d1(r.hasta)).n;
  return {
    periodo: r, anterior: ant, granularidad: g,
    resumen: {
      total: act.ventas.netas, facturado: act.ventas.total, devoluciones: act.ventas.devoluciones, cantidad: act.ventas.cantidad, unidades, promedio,
      variacion_total: variacion(act.ventas.netas, prev ? prev.ventas.netas : null), variacion_cantidad: variacion(act.ventas.cantidad, prev ? prev.ventas.cantidad : null), variacion_promedio: variacion(promedio, promedioAnt),
      ganancia_bruta: verCostos ? act.ventas.ganancia_bruta : null, margen_pct: verCostos ? act.ventas.margen_pct : null, variacion_ganancia: verCostos ? variacion(act.ventas.ganancia_bruta, prev ? prev.ventas.ganancia_bruta : null) : null,
      recibido: act.total_recibido, credito_otorgado: act.credito_otorgado.total,
    },
    serie: serie(db, r, g, { costos: verCostos }),
    metodos_pago: metodosPago(db, r),
    mas_vendidos: masVendidos(db, r, 8, verCostos),
    por_tipo_pago: porTipo,
    por_vendedor: porVendedor,
  };
}

function inventario(db, filtros = {}, { verCostos = true } = {}) {
  const inv = dashboard.inventarioResumen(db);
  const cel = licoresComplementos(db);
  const dias = Number(filtros.dias) || 30;
  return {
    resumen: { unidades: inv.unidades, productos: inv.productos, pocas: inv.pocas, agotados: inv.agotados, valor_costo: verCostos ? inv.valor_costo : null, valor_venta: inv.valor_venta, ganancia_potencial: verCostos ? inv.valor_venta - inv.valor_costo : null, licores: cel.licores, complementos: cel.complementos },
    distribucion: distribucionInventario(db, verCostos),
    rotacion: rotacion(db, dias, verCostos),
    reposicion: reposicion(db, 30),
  };
}

function finanzas(db, filtros = {}) {
  const r = rango(filtros);
  const ant = anterior(r);
  const g = granularidad(r);
  const act = dashboard.resumenPeriodo(db, r.desde, r.hasta);
  const prev = ant ? dashboard.resumenPeriodo(db, ant.desde, ant.hasta) : null;
  const gastosCat = db.prepare('SELECT categoria etiqueta, SUM(valor) total, COUNT(*) n FROM gastos WHERE anulado = 0 AND fecha BETWEEN ? AND ? GROUP BY categoria ORDER BY total DESC').all(d0(r.desde), d1(r.hasta));
  const pagosProveedor = db.prepare("SELECT COALESCE(SUM(valor),0) t, COUNT(*) n FROM pagos WHERE anulado = 0 AND tipo = 'pago_proveedor' AND fecha BETWEEN ? AND ?").get(d0(r.desde), d1(r.hasta));
  const v = (k, fn) => variacion(fn(act), prev ? fn(prev) : null);
  return {
    periodo: r, anterior: ant, granularidad: g,
    resumen: {
      ingresos: act.ventas.netas, facturado: act.ventas.total, devoluciones: act.ventas.devoluciones, costo_vendido: act.ventas.costo, ganancia_bruta: act.ventas.ganancia_bruta, margen_pct: act.ventas.margen_pct,
      gastos: act.gastos, utilidad: act.utilidad_estimada, recibido: act.total_recibido, recibido_por_metodo: act.recibido, abonos: act.abonos.total, credito_otorgado: act.credito_otorgado.total, compras: act.compras.total, pagos_proveedor: pagosProveedor.t,
      variacion: { ingresos: v('i', (x) => x.ventas.netas), costo: v('c', (x) => x.ventas.costo), ganancia_bruta: v('g', (x) => x.ventas.ganancia_bruta), gastos: v('ga', (x) => x.gastos), utilidad: v('u', (x) => x.utilidad_estimada), recibido: v('r', (x) => x.total_recibido) },
    },
    cartera: cartera(db),
    gastos_por_categoria: gastosCat,
    serie: serie(db, r, g, { costos: true }),
    metodos_pago: metodosPago(db, r),
  };
}

function clientes(db, filtros = {}) {
  const r = rango(filtros);
  const ant = anterior(r);
  const g = granularidad(r);
  const total = db.prepare('SELECT COUNT(*) n FROM clientes WHERE activo = 1').get().n;
  const nuevos = db.prepare('SELECT COUNT(*) n FROM clientes WHERE activo = 1 AND creado_en BETWEEN ? AND ?').get(d0(r.desde), d1(r.hasta)).n;
  const nuevosAnt = ant ? db.prepare('SELECT COUNT(*) n FROM clientes WHERE activo = 1 AND creado_en BETWEEN ? AND ?').get(d0(ant.desde), d1(ant.hasta)).n : null;
  const compradores = db.prepare("SELECT COUNT(DISTINCT cliente_id) n FROM ventas WHERE estado <> 'anulada' AND cliente_id IS NOT NULL AND fecha BETWEEN ? AND ?").get(d0(r.desde), d1(r.hasta)).n;
  const recurrentesPeriodo = db.prepare(`SELECT COUNT(*) n FROM (SELECT v.cliente_id FROM ventas v WHERE v.estado <> 'anulada' AND v.cliente_id IS NOT NULL AND v.fecha BETWEEN ? AND ?
      AND EXISTS (SELECT 1 FROM ventas v2 WHERE v2.cliente_id = v.cliente_id AND v2.estado <> 'anulada' AND v2.fecha < ?) GROUP BY v.cliente_id)`).get(d0(r.desde), d1(r.hasta), d0(r.desde)).n;
  const recurrentes = db.prepare("SELECT COUNT(*) n FROM (SELECT cliente_id FROM ventas WHERE estado <> 'anulada' AND cliente_id IS NOT NULL GROUP BY cliente_id HAVING COUNT(*) >= 2)").get().n;
  const conCompras = db.prepare("SELECT COUNT(DISTINCT cliente_id) n FROM ventas WHERE estado <> 'anulada' AND cliente_id IS NOT NULL").get().n;
  const top = db.prepare(`SELECT c.id, c.nombre, COUNT(*) ventas, SUM(v.total) total, MAX(v.fecha) ultima FROM ventas v JOIN clientes c ON c.id = v.cliente_id WHERE v.estado <> 'anulada' AND v.fecha BETWEEN ? AND ? GROUP BY c.id ORDER BY total DESC LIMIT 8`).all(d0(r.desde), d1(r.hasta));
  const ventasConCliente = db.prepare("SELECT SUM(CASE WHEN cliente_id IS NULL THEN 1 ELSE 0 END) sin_cliente, SUM(CASE WHEN cliente_id IS NOT NULL THEN 1 ELSE 0 END) con_cliente, COALESCE(SUM(CASE WHEN cliente_id IS NULL THEN total ELSE 0 END),0) total_sin, COALESCE(SUM(CASE WHEN cliente_id IS NOT NULL THEN total ELSE 0 END),0) total_con FROM ventas WHERE estado <> 'anulada' AND fecha BETWEEN ? AND ?").get(d0(r.desde), d1(r.hasta));
  // Evolución de registros por bucket
  const m = bucketsVacios(r, g);
  for (const c of db.prepare('SELECT creado_en FROM clientes WHERE activo = 1 AND creado_en BETWEEN ? AND ?').all(d0(r.desde), d1(r.hasta))) { const k = claveBucket(c.creado_en, g); if (!m.has(k)) m.set(k, { clave: k, etiqueta: etiquetaBucket(k, g), n: 0 }); m.get(k).n += 1; }
  const registros = [...m.values()].sort((a, b) => (a.clave < b.clave ? -1 : 1)).map((x) => ({ clave: x.clave, etiqueta: x.etiqueta, nuevos: x.n }));
  // Acumulado por mes (últimos 12 meses) para ver el crecimiento de la base
  const h = hoy();
  const acumulado = [];
  for (let i = 11; i >= 0; i--) {
    const fin = i === 0 ? h : sumarDias(sumarMeses(h.slice(0, 8) + '01', -i + 1), -1);
    acumulado.push({ clave: fin.slice(0, 7), etiqueta: etiquetaBucket(fin.slice(0, 7), 'mes'), total: db.prepare('SELECT COUNT(*) n FROM clientes WHERE activo = 1 AND creado_en <= ?').get(d1(fin)).n });
  }
  return {
    periodo: r, anterior: ant, granularidad: g,
    resumen: { total, nuevos, nuevos_anterior: nuevosAnt, variacion_nuevos: variacion(nuevos, nuevosAnt), compradores_periodo: compradores, recurrentes_periodo: recurrentesPeriodo, recurrentes, con_compras: conCompras, con_credito: cartera(db).clientes },
    top, ventas_con_cliente: ventasConCliente, registros: { granularidad: g, puntos: registros }, acumulado,
  };
}

function compras(db, filtros = {}) {
  const r = rango(filtros);
  const ant = anterior(r);
  const g = granularidad(r);
  const tot = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total),0) total, COALESCE(SUM(valor_pagado),0) pagado, COALESCE(SUM(saldo_pendiente),0) saldo FROM compras WHERE estado = 'confirmada' AND fecha BETWEEN ? AND ?").get(r.desde, d1(r.hasta));
  const totAnt = ant ? db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total),0) total FROM compras WHERE estado = 'confirmada' AND fecha BETWEEN ? AND ?").get(ant.desde, d1(ant.hasta)) : null;
  const porProveedor = db.prepare(`SELECT COALESCE(p.id, 0) id, COALESCE(p.nombre, 'Sin proveedor') proveedor, COUNT(*) compras, SUM(c.total) total, SUM(c.valor_pagado) pagado, SUM(c.saldo_pendiente) saldo
      FROM compras c LEFT JOIN proveedores p ON p.id = c.proveedor_id WHERE c.estado = 'confirmada' AND c.fecha BETWEEN ? AND ? GROUP BY c.proveedor_id ORDER BY total DESC`).all(r.desde, d1(r.hasta));
  const unidades = db.prepare("SELECT COALESCE(SUM(ci.cantidad),0) n FROM compra_items ci JOIN compras c ON c.id = ci.compra_id WHERE c.estado = 'confirmada' AND c.fecha BETWEEN ? AND ?").get(d0(r.desde), d1(r.hasta)).n;
  const m = bucketsVacios(r, g);
  for (const c of db.prepare("SELECT fecha, total FROM compras WHERE estado = 'confirmada' AND fecha BETWEEN ? AND ?").all(r.desde, d1(r.hasta))) { const k = claveBucket(c.fecha, g); if (!m.has(k)) m.set(k, { clave: k, etiqueta: etiquetaBucket(k, g), compras: 0, n: 0 }); const b = m.get(k); b.compras += c.total; b.n += 1; }
  const puntos = [...m.values()].sort((a, b) => (a.clave < b.clave ? -1 : 1)).map((x) => ({ clave: x.clave, etiqueta: x.etiqueta, compras: x.compras, n: x.n }));
  const cart = cartera(db);
  return {
    periodo: r, anterior: ant, granularidad: g,
    resumen: { total: tot.total, cantidad: tot.n, pagado: tot.pagado, saldo: tot.saldo, unidades, variacion_total: variacion(tot.total, totAnt ? totAnt.total : null), variacion_cantidad: variacion(tot.n, totAnt ? totAnt.n : null), por_pagar: cart.por_pagar, facturas_pendientes: cart.facturas_pendientes, facturas_vencidas: cart.facturas_vencidas, proveedores_activos: porProveedor.length },
    por_proveedor: porProveedor,
    serie: { granularidad: g, puntos },
    reposicion: reposicion(db, 20),
  };
}

module.exports = { rango, anterior, granularidad, variacion, serie, metodosPago, masVendidos, distribucionInventario, licoresComplementos, rotacion, reposicion, cartera, panel, ventas, inventario, finanzas, clientes, compras };
