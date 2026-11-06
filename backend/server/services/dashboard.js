'use strict';
// Indicadores del panel principal. Todo se calcula en el servidor a partir de los movimientos reales.
const { getConfig } = require('../db');
const { hoy, rangoPeriodo, sumarDias } = require('../util');
const creditos = require('./creditos');
const productos = require('./productos');

function sumaPeriodo(db, sql, desde, hasta) {
  return db.prepare(sql).get(desde + ' 00:00:00', hasta + ' 23:59:59');
}

function resumenPeriodo(db, desde, hasta) {
  const ventas = sumaPeriodo(db, "SELECT COUNT(*) n, COALESCE(SUM(total),0) total, COALESCE(SUM(costo_total),0) costo, COALESCE(SUM(ganancia),0) ganancia FROM ventas WHERE estado <> 'anulada' AND fecha BETWEEN ? AND ?", desde, hasta);
  const devoluciones = sumaPeriodo(db, "SELECT COALESCE(SUM(d.total),0) total, COALESCE(SUM(di.valor - di.costo),0) ganancia FROM devoluciones d JOIN devolucion_items di ON di.devolucion_id = d.id WHERE d.tipo <> 'anulacion' AND d.fecha BETWEEN ? AND ?", desde, hasta);
  const compras = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total),0) total FROM compras WHERE estado = 'confirmada' AND fecha BETWEEN ? AND ?").get(desde, hasta + ' 23:59:59'); // sin ' 00:00:00': las compras anteriores se guardaron solo con el día
  const gastos = sumaPeriodo(db, 'SELECT COALESCE(SUM(valor),0) total FROM gastos WHERE anulado = 0 AND fecha BETWEEN ? AND ?', desde, hasta);
  const recibido = {};
  for (const f of db.prepare("SELECT metodo_pago m, SUM(CASE WHEN tipo = 'reintegro' THEN -valor ELSE valor END) t FROM pagos WHERE anulado = 0 AND tipo IN ('venta','abono','reintegro') AND fecha BETWEEN ? AND ? GROUP BY metodo_pago").all(desde + ' 00:00:00', hasta + ' 23:59:59')) recibido[f.m] = f.t;
  const abonos = sumaPeriodo(db, "SELECT COALESCE(SUM(valor),0) total, COUNT(*) n FROM pagos WHERE anulado = 0 AND tipo = 'abono' AND fecha BETWEEN ? AND ?", desde, hasta);
  const creditoOtorgado = sumaPeriodo(db, "SELECT COALESCE(SUM(saldo_financiado),0) total, COUNT(*) n FROM creditos WHERE estado <> 'anulado' AND fecha BETWEEN ? AND ?", desde, hasta);
  const ventasNetas = ventas.total - devoluciones.total;
  const gananciaBruta = ventas.ganancia - devoluciones.ganancia;
  return {
    desde, hasta,
    ventas: { cantidad: ventas.n, total: ventas.total, devoluciones: devoluciones.total, netas: ventasNetas, costo: ventas.costo, ganancia_bruta: gananciaBruta, margen_pct: ventasNetas > 0 ? Math.round((gananciaBruta * 1000) / ventasNetas) / 10 : 0 },
    compras: { cantidad: compras.n, total: compras.total },
    gastos: gastos.total,
    utilidad_estimada: gananciaBruta - gastos.total,
    recibido, total_recibido: Object.values(recibido).reduce((a, b) => a + b, 0),
    abonos: { total: abonos.total, cantidad: abonos.n },
    credito_otorgado: creditoOtorgado,
  };
}

function inventarioResumen(db) {
  const f = db.prepare(`SELECT COALESCE(SUM(s.valor_costo),0) valor_costo, COALESCE(SUM(s.stock * p.precio_venta),0) valor_venta, COALESCE(SUM(s.stock),0) unidades,
                          SUM(CASE WHEN s.stock > 0 AND s.stock <= p.stock_minimo THEN 1 ELSE 0 END) pocas,
                          SUM(CASE WHEN s.stock <= 0 AND p.estado IN ('activo','agotado') THEN 1 ELSE 0 END) agotados,
                          COUNT(*) productos
                        FROM productos p JOIN v_stock s ON s.producto_id = p.id WHERE p.estado <> 'inactivo'`).get();
  return f;
}

// Alertas operativas: cuotas próximas/vencidas, facturas de proveedor por pagar y productos en o bajo el mínimo.
function alertas(db) {
  const h = hoy();
  const diasAlerta = getConfig(db, 'dias_alerta_vencimiento') || 7;
  const cuotasProximas = db.prepare(`SELECT q.fecha_vencimiento, q.valor - q.pagado AS pendiente, c.numero, c.id AS credito_id, cl.nombre AS cliente, cl.telefono
                                     FROM credito_cuotas q JOIN creditos c ON c.id = q.credito_id JOIN clientes cl ON cl.id = c.cliente_id
                                     WHERE q.estado <> 'pagada' AND c.estado NOT IN ('pagado','anulado') AND q.fecha_vencimiento <= ?
                                     ORDER BY q.fecha_vencimiento LIMIT 30`).all(sumarDias(h, diasAlerta));
  const comprasVencen = db.prepare(`SELECT c.id, c.numero, c.numero_factura, c.fecha_vencimiento, c.saldo_pendiente, p.nombre AS proveedor FROM compras c LEFT JOIN proveedores p ON p.id = c.proveedor_id
                                    WHERE c.estado = 'confirmada' AND c.saldo_pendiente > 0 AND (c.fecha_vencimiento IS NULL OR c.fecha_vencimiento <= ?) ORDER BY c.fecha_vencimiento LIMIT 30`).all(sumarDias(h, diasAlerta));
  const stockBajo = db.prepare(`SELECT p.id, p.nombre, p.referencia, s.stock, p.stock_minimo FROM productos p JOIN v_stock s ON s.producto_id = p.id
                                WHERE p.estado IN ('activo','agotado') AND s.stock <= p.stock_minimo ORDER BY s.stock, p.nombre LIMIT 50`).all();
  return { cuotas_proximas: cuotasProximas, compras_por_pagar: comprasVencen, stock_bajo: stockBajo, dias_alerta: diasAlerta };
}

function panel(db, { periodo = 'hoy', desde, hasta } = {}) {
  const rango = desde && hasta ? { desde, hasta } : rangoPeriodo(periodo);
  creditos.recalcularTodos(db);
  const h = hoy();
  const diasSinMov = getConfig(db, 'dias_sin_movimiento') || 30;
  const cartera = db.prepare("SELECT COALESCE(SUM(saldo_actual),0) pendiente, COUNT(*) vigentes, SUM(CASE WHEN estado = 'vencido' THEN 1 ELSE 0 END) vencidos, COALESCE(SUM(CASE WHEN estado = 'vencido' THEN saldo_actual ELSE 0 END),0) saldo_vencido FROM creditos WHERE estado NOT IN ('pagado','anulado')").get();
  const porPagar = db.prepare("SELECT COALESCE(SUM(saldo_pendiente),0) total, COUNT(*) n, SUM(CASE WHEN fecha_vencimiento IS NOT NULL AND fecha_vencimiento < ? THEN 1 ELSE 0 END) vencidas FROM compras WHERE estado = 'confirmada' AND saldo_pendiente > 0").get(h);
  const { cuotas_proximas: cuotasProximas, compras_por_pagar: comprasVencen, stock_bajo: stockBajo } = alertas(db);
  const masVendidos = db.prepare(`SELECT p.id, p.nombre, SUM(vi.cantidad - vi.cantidad_devuelta) unidades, SUM(vi.total) total, SUM(vi.total - vi.costo_total) ganancia
                                  FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id JOIN productos p ON p.id = vi.producto_id
                                  WHERE v.estado <> 'anulada' AND v.fecha BETWEEN ? AND ? GROUP BY p.id ORDER BY unidades DESC, total DESC LIMIT 10`).all(rango.desde + ' 00:00:00', rango.hasta + ' 23:59:59');
  // Serie diaria de los últimos 14 días para el gráfico
  const serie = [];
  for (let i = 13; i >= 0; i--) {
    const d = sumarDias(h, -i);
    const f = db.prepare("SELECT COALESCE(SUM(total),0) total, COUNT(*) n FROM ventas WHERE estado <> 'anulada' AND fecha BETWEEN ? AND ?").get(d + ' 00:00:00', d + ' 23:59:59');
    serie.push({ fecha: d, total: f.total, ventas: f.n });
  }
  const ultimasVentas = db.prepare(`SELECT v.id, v.numero, v.fecha, v.total, v.tipo_pago, v.estado, c.nombre AS cliente FROM ventas v LEFT JOIN clientes c ON c.id = v.cliente_id ORDER BY v.id DESC LIMIT 8`).all();
  return {
    periodo: rango,
    resumen: resumenPeriodo(db, rango.desde, rango.hasta),
    hoy: resumenPeriodo(db, h, h),
    semana: resumenPeriodo(db, rangoPeriodo('semana').desde, h),
    mes: resumenPeriodo(db, rangoPeriodo('mes').desde, h),
    inventario: inventarioResumen(db),
    cartera: { ...cartera, por_pagar: porPagar.total, facturas_pendientes: porPagar.n, facturas_vencidas: porPagar.vencidas },
    alertas: { cuotas_proximas: cuotasProximas, compras_por_pagar: comprasVencen, stock_bajo: stockBajo },
    mas_vendidos: masVendidos,
    sin_movimiento: productos.sinMovimiento(db, diasSinMov).slice(0, 10),
    serie_ventas: serie,
    ultimas_ventas: ultimasVentas,
    documentos_pendientes: db.prepare("SELECT COUNT(*) n FROM documentos WHERE estado = 'pendiente'").get().n,
  };
}

module.exports = { panel, resumenPeriodo, inventarioResumen, alertas };
