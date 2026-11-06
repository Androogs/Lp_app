'use strict';
// Rentabilidad por responsable comercial y comisiones del vendedor.
// Ganancia operativa de una venta = ingreso neto (facturado − devoluciones) − costo de adquisición de lo vendido (por lote, neto de
// devoluciones) − costos directos registrados en la venta (comisión de pago y gastos de venta). Los impuestos son informativos.
// Comisión = % del vendedor × ganancia comisionable (suma de ganancias positivas y negativas), NUNCA sobre el valor bruto.
// Las ventas del empleador no comisionan (salvo configuración). Las liquidaciones cerradas no se editan: toda corrección posterior
// (devolución, anulación, reasignación) genera un ajuste trazable que se aplica en la siguiente liquidación del mismo vendedor.
const { transaccion, siguienteNumero, getConfig, CONFIG_DEFAULT } = require('../db');
const { err, hoy, ahora, texto, entero, diasEntre, fecha: vFecha, csv } = require('../util');
const { tiene } = require('../permisos');
const auditoria = require('./auditoria');
const { rango } = require('./analitica');

const d0 = (d) => d + ' 00:00:00';
const d1 = (d) => d + ' 23:59:59';

function configComisiones(db) {
  return { ...CONFIG_DEFAULT.comisiones, ...(getConfig(db, 'comisiones') || {}) };
}

// Tipo comercial por defecto según el rol: admin = empleador; vendedor y cajero = vendedor; el resto no vende ('otro').
function tipoPorRol(rol) { return rol === 'admin' ? 'empleador' : ['vendedor', 'cajero'].includes(rol) ? 'vendedor' : 'otro'; }
// Datos comerciales de un usuario: tipo (vendedor/empleador/otro), salario y % de comisión.
function usuarioComercial(db, id) {
  const u = db.prepare('SELECT id, nombre, rol, activo, salario_mensual, comision_pct, tipo_comercial FROM usuarios WHERE id = ?').get(id);
  if (!u) return null;
  return { ...u, tipo_comercial: u.tipo_comercial || tipoPorRol(u.rol) };
}
function tipoUsuario(db, id) { const u = usuarioComercial(db, id); return u ? u.tipo_comercial : null; }

// Salario en los paneles: es mensual y nunca se divide por días.
// - Periodo que arranca el día 1 de un mes (Este mes, Este año): un salario por cada mes calendario que toca.
// - Periodo de 28+ días: sus meses (mín. 1).
// - Periodo más corto (Hoy, 7 días): el salario de un mes como referencia, sin descontarlo del resultado.
function factorSalario(desde, hasta) {
  const dias = diasEntre(desde, hasta) + 1;
  if (desde !== hasta && String(desde).slice(8, 10) === '01') {
    const [y1, m1] = desde.split('-').map(Number); const [y2, m2] = hasta.split('-').map(Number);
    return { dias, factor: (y2 - y1) * 12 + (m2 - m1) + 1, completo: true, prorrateado: false };
  }
  const completo = dias >= 28;
  return { dias, factor: completo ? Math.max(1, Math.round(dias / 30.4)) : 1, completo, prorrateado: false };
}
// Salario de una liquidación: lo que se debe por el rango liquidado (mes de 30 días; un rango corto paga sus días).
function factorLiquidacion(desde, hasta) {
  const dias = diasEntre(desde, hasta) + 1;
  if (dias >= 28) return { dias, factor: Math.max(1, Math.round(dias / 30.4)) };
  return { dias, factor: Math.round((dias / 30) * 10000) / 10000 };
}
// Salario mensual de un trabajador: el suyo si se le registró uno distinto, si no el salario base general.
const salarioDe = (u, cfg) => (u.salario_mensual ?? cfg.salario_defecto);

// Ventas del rango con ganancia operativa, estado de cobro, responsable y comisión calculada venta por venta.
function ventasConGanancia(db, { desde, hasta, vendedor_id, estado_pago, producto_id, venta_id, incluir_anuladas = false, limite = 2000 } = {}) {
  const cfg = configComisiones(db);
  const cond = [];
  const params = [];
  if (venta_id) { cond.push('v.id = ?'); params.push(Number(venta_id)); }
  if (!incluir_anuladas) cond.push("v.estado <> 'anulada'");
  if (desde) { cond.push('v.fecha >= ?'); params.push(d0(desde)); }
  if (hasta) { cond.push('v.fecha <= ?'); params.push(d1(hasta)); }
  if (vendedor_id === 'pendiente') cond.push('v.vendedor_id IS NULL');
  else if (vendedor_id) { cond.push('v.vendedor_id = ?'); params.push(Number(vendedor_id)); }
  if (producto_id) { cond.push('EXISTS (SELECT 1 FROM venta_items vi WHERE vi.venta_id = v.id AND vi.producto_id = ?)'); params.push(Number(producto_id)); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const filas = db.prepare(`SELECT v.id, v.numero, v.fecha, v.estado, v.tipo_pago, v.total, v.descuento, v.costo_total, v.comision AS costo_comision_pago, v.gastos_venta, v.impuestos,
      v.vendedor_id, v.registrado_por, v.responsable_tipo, v.domicilio_id, v.cargo_domicilio, v.cliente_id, c.nombre AS cliente, u.nombre AS responsable, ur.nombre AS registrado_por_nombre,
      (SELECT COALESCE(SUM(d.total),0) FROM devoluciones d WHERE d.venta_id = v.id AND d.tipo <> 'anulacion') AS devuelto,
      (SELECT COALESCE(SUM(di.costo),0) FROM devoluciones d JOIN devolucion_items di ON di.devolucion_id = d.id WHERE d.venta_id = v.id AND d.tipo <> 'anulacion') AS costo_devuelto,
      (SELECT cr.estado FROM creditos cr WHERE cr.venta_id = v.id AND cr.estado <> 'anulado' ORDER BY cr.id DESC LIMIT 1) AS credito_estado,
      (SELECT GROUP_CONCAT(vi.nombre_producto, ', ') FROM venta_items vi WHERE vi.venta_id = v.id) AS resumen
    FROM ventas v LEFT JOIN clientes c ON c.id = v.cliente_id LEFT JOIN usuarios u ON u.id = v.vendedor_id LEFT JOIN usuarios ur ON ur.id = v.registrado_por
    ${where} ORDER BY v.fecha DESC, v.id DESC LIMIT ?`).all(...params, limite);
  const cache = new Map();
  const usuario = (id) => { if (!cache.has(id)) cache.set(id, usuarioComercial(db, id)); return cache.get(id); };
  const salida = filas.map((v) => {
    const ingresoNeto = v.total - v.devuelto;
    const costoNeto = v.costo_total - v.costo_devuelto;
    const costosDirectos = (v.costo_comision_pago || 0) + (v.gastos_venta || 0);
    const ganancia = ingresoNeto - costoNeto - costosDirectos;
    const cobrada = v.tipo_pago === 'contado' || v.credito_estado === 'pagado' || v.credito_estado === null;
    const resp = v.vendedor_id ? usuario(v.vendedor_id) : null;
    const tipo = v.responsable_tipo || (resp ? resp.tipo_comercial : null);
    const pct = resp ? (resp.comision_pct ?? cfg.comision_pct_defecto) : 0;
    const comisiona = !!resp && (tipo === 'vendedor' || (tipo === 'empleador' && !!cfg.empleador_comisiona));
    const devengada = comisiona && v.estado !== 'anulada' && (cfg.devengo === 'cobro' ? cobrada : true);
    const comision = devengada ? Math.round((ganancia * pct) / 100) : 0;
    return { ...v, ingreso_neto: ingresoNeto, costo_neto: costoNeto, costos_directos: costosDirectos, ganancia_operativa: ganancia, cobrada, estado_pago: cobrada ? 'cobrada' : 'pendiente', responsable_tipo: tipo, pendiente_asignacion: !v.vendedor_id, comision_pct: comisiona ? pct : 0, comisiona, devengada, comision };
  });
  return estado_pago ? salida.filter((v) => v.estado_pago === estado_pago) : salida;
}

// Panel de rentabilidad: por responsable (vendedores, empleador, pendientes de asignación) y resultado del negocio.
function resumen(db, filtros = {}, { alcance = 'todos', usuarioId = null } = {}) {
  const cfg = configComisiones(db);
  const r = rango(filtros);
  const propio = alcance === 'propio';
  const ventas = ventasConGanancia(db, { desde: r.desde, hasta: r.hasta, vendedor_id: propio ? usuarioId : filtros.vendedor_id, estado_pago: filtros.estado_pago, producto_id: filtros.producto_id });
  const fs = factorSalario(r.desde, r.hasta);
  const porResp = new Map();
  const nuevo = (u) => ({ vendedor_id: u ? u.id : null, nombre: u ? u.nombre : 'Pendiente de asignación', tipo: u ? u.tipo_comercial : 'sin_asignar', activo: u ? u.activo : 0, ventas: 0, unidades: 0, ingreso_neto: 0, costo: 0, costos_directos: 0, ganancia: 0, ganancia_comisionable: 0, comision: 0, comision_pct: u ? (u.comision_pct ?? cfg.comision_pct_defecto) : 0, pendientes_cobro: 0, pendientes_cobro_valor: 0, salario_mensual: u ? (u.salario_mensual ?? null) : null, salario_general: !!(u && u.salario_mensual == null), salario_estimado: false });
  for (const v of ventas) {
    const k = v.vendedor_id || 0;
    if (!porResp.has(k)) porResp.set(k, nuevo(v.vendedor_id ? usuarioComercial(db, v.vendedor_id) : null));
    const x = porResp.get(k);
    x.ventas += 1; x.ingreso_neto += v.ingreso_neto; x.costo += v.costo_neto; x.costos_directos += v.costos_directos; x.ganancia += v.ganancia_operativa;
    if (v.devengada) x.ganancia_comisionable += v.ganancia_operativa;
    x.comision += v.comision;
    if (!v.cobrada) { x.pendientes_cobro += 1; x.pendientes_cobro_valor += v.ingreso_neto; }
  }
  if (!propio && !filtros.vendedor_id) {
    for (const f of db.prepare("SELECT id FROM usuarios WHERE activo = 1").all()) { const u = usuarioComercial(db, f.id); if (u.tipo_comercial === 'vendedor' && !porResp.has(u.id)) porResp.set(u.id, nuevo(u)); }
  }
  if (propio && usuarioId && !porResp.has(usuarioId)) porResp.set(usuarioId, nuevo(usuarioComercial(db, usuarioId)));
  const responsables = [...porResp.values()].map((x) => {
    const comisiona = x.tipo === 'vendedor' || (x.tipo === 'empleador' && !!cfg.empleador_comisiona);
    const salarioBase = x.tipo === 'vendedor' ? salarioDe(x, cfg) : 0;
    const salarioPeriodo = Math.round(salarioBase * fs.factor);
    return { ...x, comision_pct: comisiona ? x.comision_pct : 0, salario_base: salarioBase, salario_periodo: salarioPeriodo, total_remuneracion: salarioPeriodo + x.comision };
  }).sort((a, b) => (a.tipo === b.tipo ? b.ganancia - a.ganancia : a.tipo === 'vendedor' ? -1 : b.tipo === 'vendedor' ? 1 : a.tipo === 'empleador' ? -1 : 1));
  const suma = (lista, k) => lista.reduce((s, x) => s + (x[k] || 0), 0);
  const vendedores = responsables.filter((x) => x.tipo === 'vendedor');
  const empleadores = responsables.filter((x) => x.tipo === 'empleador');
  const sinAsignar = responsables.find((x) => x.tipo === 'sin_asignar') || null;
  const gananciaTotal = suma(responsables, 'ganancia');
  const comisiones = suma(responsables, 'comision');
  const salarios = suma(vendedores, 'salario_periodo');
  // En periodos de menos de un mes el salario mensual no se descuenta del resultado (no se reparte por días).
  const salariosResultado = fs.completo ? salarios : 0;
  const gastos = propio ? null : db.prepare('SELECT COALESCE(SUM(valor),0) t FROM gastos WHERE anulado = 0 AND fecha BETWEEN ? AND ?').get(d0(r.desde), d1(r.hasta)).t;
  const avisos = [];
  if (!fs.completo && vendedores.length) avisos.push(`El salario es mensual (${cfg.salario_defecto.toLocaleString('es-CO')} por trabajador) y no se reparte por días: en un periodo de ${fs.dias} día(s) se muestra el mes completo y no se descuenta del resultado. Elige «Este mes» para ver el resultado con salarios.`);
  if (sinAsignar) avisos.push(`${sinAsignar.ventas} venta(s) sin responsable asignado: excluidas de las comisiones hasta asignarlas.`);
  if (cfg.devengo === 'cobro') avisos.push('Devengo configurado al cobro: las ventas con saldo pendiente no comisionan hasta que se paguen.');
  return {
    periodo: r, dias: fs.dias, factor_salario: fs.factor, salario_prorrateado: false, salarios_en_resultado: fs.completo, salario_general: cfg.salario_defecto, devengo: cfg.devengo, alcance,
    vendedor: { ventas: suma(vendedores, 'ventas'), ingreso_neto: suma(vendedores, 'ingreso_neto'), ganancia: suma(vendedores, 'ganancia'), ganancia_comisionable: suma(vendedores, 'ganancia_comisionable'), comision: suma(vendedores, 'comision'), salario_periodo: salarios, total_remuneracion: salarios + suma(vendedores, 'comision'), pendientes_cobro: suma(vendedores, 'pendientes_cobro') },
    empleador: { ventas: suma(empleadores, 'ventas'), ingreso_neto: suma(empleadores, 'ingreso_neto'), ganancia: suma(empleadores, 'ganancia'), pendientes_cobro: suma(empleadores, 'pendientes_cobro') },
    sin_asignar: sinAsignar ? { ventas: sinAsignar.ventas, ingreso_neto: sinAsignar.ingreso_neto, ganancia: sinAsignar.ganancia } : null,
    negocio: propio ? null : { ganancia_total: gananciaTotal, comisiones, salarios: salariosResultado, gastos_generales: gastos, resultado: gananciaTotal - comisiones - salariosResultado - gastos, pendientes_cobro: ventas.filter((v) => !v.cobrada).length, pendientes_cobro_valor: ventas.filter((v) => !v.cobrada).reduce((s, v) => s + v.ingreso_neto, 0), estimado: !fs.completo },
    responsables: propio ? responsables.filter((x) => x.vendedor_id === usuarioId) : responsables,
    ventas: ventas.slice(0, 500).map((v) => ({ id: v.id, numero: v.numero, fecha: v.fecha, estado: v.estado, tipo_pago: v.tipo_pago, cliente: v.cliente, resumen: v.resumen, responsable: v.responsable, vendedor_id: v.vendedor_id, responsable_tipo: v.responsable_tipo, registrado_por_nombre: v.registrado_por_nombre, pendiente_asignacion: v.pendiente_asignacion, ingreso_neto: v.ingreso_neto, costo_neto: v.costo_neto, costos_directos: v.costos_directos, ganancia_operativa: v.ganancia_operativa, estado_pago: v.estado_pago, comisiona: v.comisiona, devengada: v.devengada, comision_pct: v.comision_pct, comision: v.comision, domicilio_id: v.domicilio_id, cargo_domicilio: v.cargo_domicilio })),
    avisos,
    criterios: 'Ganancia operativa = ingreso neto − costo de adquisición (por lote) − costos directos de la venta. Comisión = % × ganancia comisionable del vendedor (no sobre el valor bruto). Salario = salario base mensual, igual para todos salvo que a alguien se le registre otro; no se reparte por días: un salario por cada mes del periodo (Este mes = 1, Este año = los meses transcurridos, 28+ días = sus meses) y en periodos más cortos (Hoy, 7 días) se muestra el mes como referencia. Resultado del negocio = ganancia operativa total − salarios (solo en periodos de un mes o más) − comisiones − gastos generales no incluidos en las ventas.',
  };
}

// Cambia el responsable comercial de una venta (queda en auditoría y genera ajuste si la venta ya estaba liquidada).
function reasignar(db, ventaId, { vendedor_id, motivo }, usuario) {
  if (!tiene(usuario, 'comisiones.administrar')) throw err.prohibido('Solo el empleador puede reasignar el responsable de una venta');
  const v = db.prepare('SELECT id, numero, vendedor_id, responsable_tipo FROM ventas WHERE id = ?').get(ventaId);
  if (!v) throw err.noEncontrado('Venta no existe');
  const nuevo = vendedor_id === null || vendedor_id === '' || vendedor_id === 'pendiente' ? null : entero(vendedor_id, 'Responsable');
  if (nuevo && !usuarioComercial(db, nuevo)) throw err.noEncontrado('El usuario responsable no existe');
  const mot = texto(motivo, 'Motivo del cambio', { max: 300 });
  return transaccion(db, () => {
    const tipo = nuevo ? tipoUsuario(db, nuevo) : null;
    db.prepare('UPDATE ventas SET vendedor_id = ?, responsable_tipo = ? WHERE id = ?').run(nuevo, tipo, ventaId);
    auditoria.registrar(db, usuario, 'reasignar_responsable_venta', 'venta', ventaId, { numero: v.numero, antes: { vendedor_id: v.vendedor_id, tipo: v.responsable_tipo }, despues: { vendedor_id: nuevo, tipo }, motivo: mot });
    const ajustes = ajustarPorCambio(db, ventaId, usuario, `Reasignación de responsable: ${mot}`);
    return { ok: true, vendedor_id: nuevo, responsable_tipo: tipo, ajustes };
  });
}

// Si la venta ya estaba en una liquidación cerrada, registra la diferencia de comisión como ajuste (no toca la liquidación).
function ajustarPorCambio(db, ventaId, usuario, motivo) {
  const filas = db.prepare('SELECT lv.*, l.vendedor_id, l.numero AS liquidacion_numero FROM liquidacion_ventas lv JOIN liquidaciones l ON l.id = lv.liquidacion_id WHERE lv.venta_id = ? AND l.estado = ?').all(ventaId, 'cerrada');
  if (!filas.length) return [];
  const actual = ventasConGanancia(db, { venta_id: ventaId, incluir_anuladas: true })[0];
  const salida = [];
  for (const lv of filas) {
    const nueva = actual && actual.estado !== 'anulada' && actual.vendedor_id === lv.vendedor_id ? actual.comision : 0;
    const delta = nueva - lv.comision_actual;
    if (!delta) continue;
    const r = db.prepare('INSERT INTO liquidacion_ajustes(liquidacion_id, venta_id, motivo, comision_anterior, comision_nueva, valor, usuario_id) VALUES (?,?,?,?,?,?,?)').run(lv.liquidacion_id, ventaId, motivo, lv.comision_actual, nueva, delta, usuario ? usuario.id : null);
    db.prepare('UPDATE liquidacion_ventas SET comision_actual = ? WHERE id = ?').run(nueva, lv.id);
    auditoria.registrar(db, usuario, 'ajuste_liquidacion', 'liquidacion', lv.liquidacion_id, { venta_id: ventaId, motivo, comision_anterior: lv.comision_actual, comision_nueva: nueva, ajuste: delta });
    salida.push({ id: Number(r.lastInsertRowid), liquidacion_id: lv.liquidacion_id, liquidacion_numero: lv.liquidacion_numero, valor: delta });
  }
  return salida;
}

// ---------- Liquidaciones ----------
function cerrar(db, { vendedor_id, desde, hasta, notas }, usuario) {
  if (!tiene(usuario, 'comisiones.administrar')) throw err.prohibido('Solo el empleador puede cerrar liquidaciones');
  const id = entero(vendedor_id, 'Vendedor');
  const u = usuarioComercial(db, id);
  if (!u) throw err.noEncontrado('Vendedor no existe');
  const cfg = configComisiones(db);
  if (u.tipo_comercial !== 'vendedor' && !cfg.empleador_comisiona) throw err.conflicto('Ese usuario es empleador: no tiene liquidación de comisiones');
  const f1 = vFecha(desde, 'Desde'), f2 = vFecha(hasta, 'Hasta');
  if (f1 > f2) throw err.datos('El rango de fechas no es válido');
  if (f2 > hoy()) throw err.datos('No se puede liquidar un periodo que aún no termina');
  const solapa = db.prepare("SELECT numero FROM liquidaciones WHERE vendedor_id = ? AND estado = 'cerrada' AND NOT (hasta < ? OR desde > ?)").get(id, f1, f2);
  if (solapa) throw err.conflicto(`El periodo se cruza con la liquidación ${solapa.numero}`);
  const ventas = ventasConGanancia(db, { desde: f1, hasta: f2, vendedor_id: id });
  const pendientesAsignar = db.prepare("SELECT COUNT(*) n FROM ventas WHERE vendedor_id IS NULL AND estado <> 'anulada' AND fecha BETWEEN ? AND ?").get(d0(f1), d1(f2)).n;
  const fs = factorLiquidacion(f1, f2);
  const salario = u.tipo_comercial === 'vendedor' ? Math.round(salarioDe(u, cfg) * fs.factor) : 0;
  const pct = u.comision_pct ?? cfg.comision_pct_defecto;
  const comisionable = ventas.filter((v) => v.devengada).reduce((s, v) => s + v.ganancia_operativa, 0);
  const comision = ventas.reduce((s, v) => s + v.comision, 0);
  const pendientesCobro = ventas.filter((v) => !v.cobrada).length;
  return transaccion(db, () => {
    const ajustes = db.prepare('SELECT a.* FROM liquidacion_ajustes a JOIN liquidaciones l ON l.id = a.liquidacion_id WHERE l.vendedor_id = ? AND a.aplicado_en IS NULL').all(id);
    const ajustesPrevios = ajustes.reduce((s, a) => s + a.valor, 0);
    const numero = siguienteNumero(db, 'liquidacion', 'LQ');
    const r = db.prepare(`INSERT INTO liquidaciones(numero, vendedor_id, desde, hasta, salario, comision_pct, devengo, ventas_n, ingreso_neto, ganancia_operativa, ganancia_comisionable, comision, ajustes_previos, total, pendientes_cobro, notas, cerrada_por)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(numero, id, f1, f2, salario, pct, cfg.devengo, ventas.length, ventas.reduce((s, v) => s + v.ingreso_neto, 0), ventas.reduce((s, v) => s + v.ganancia_operativa, 0), comisionable, comision, ajustesPrevios, salario + comision + ajustesPrevios, pendientesCobro, texto(notas, 'Notas', { opcional: true, max: 1000 }), usuario.id);
    const liqId = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO liquidacion_ventas(liquidacion_id, venta_id, ganancia, comision, comision_actual, comisionable) VALUES (?,?,?,?,?,?)');
    for (const v of ventas) ins.run(liqId, v.id, v.ganancia_operativa, v.comision, v.comision, v.devengada ? 1 : 0);
    if (ajustes.length) db.prepare(`UPDATE liquidacion_ajustes SET aplicado_en = ? WHERE id IN (${ajustes.map(() => '?').join(',')})`).run(liqId, ...ajustes.map((a) => a.id));
    auditoria.registrar(db, usuario, 'cerrar_liquidacion', 'liquidacion', liqId, { numero, vendedor_id: id, desde: f1, hasta: f2, salario, comision, ajustes_previos: ajustesPrevios, total: salario + comision + ajustesPrevios, pendientes_asignar: pendientesAsignar });
    const liq = obtener(db, liqId);
    liq.aviso_pendientes_asignar = pendientesAsignar;
    return liq;
  });
}

function obtener(db, id) {
  const l = db.prepare('SELECT l.*, u.nombre AS vendedor, uc.nombre AS cerrada_por_nombre FROM liquidaciones l JOIN usuarios u ON u.id = l.vendedor_id LEFT JOIN usuarios uc ON uc.id = l.cerrada_por WHERE l.id = ?').get(id);
  if (!l) throw err.noEncontrado('Liquidación no existe');
  l.ventas = db.prepare(`SELECT lv.*, v.numero, v.fecha, v.total, v.estado, v.tipo_pago, c.nombre AS cliente, (SELECT GROUP_CONCAT(vi.nombre_producto, ', ') FROM venta_items vi WHERE vi.venta_id = v.id) AS resumen
                         FROM liquidacion_ventas lv JOIN ventas v ON v.id = lv.venta_id LEFT JOIN clientes c ON c.id = v.cliente_id WHERE lv.liquidacion_id = ? ORDER BY v.fecha`).all(id);
  l.ajustes_recibidos = db.prepare('SELECT a.*, v.numero AS venta_numero, l2.numero AS aplicado_en_numero FROM liquidacion_ajustes a LEFT JOIN ventas v ON v.id = a.venta_id LEFT JOIN liquidaciones l2 ON l2.id = a.aplicado_en WHERE a.liquidacion_id = ? ORDER BY a.id').all(id);
  l.ajustes_aplicados = db.prepare('SELECT a.*, v.numero AS venta_numero, l1.numero AS origen_numero FROM liquidacion_ajustes a LEFT JOIN ventas v ON v.id = a.venta_id JOIN liquidaciones l1 ON l1.id = a.liquidacion_id WHERE a.aplicado_en = ? ORDER BY a.id').all(id);
  l.ajustes_posteriores = l.ajustes_recibidos.reduce((s, a) => s + a.valor, 0);
  return l;
}

function listar(db, { vendedor_id, limite = 100 } = {}) {
  const cond = []; const params = [];
  if (vendedor_id) { cond.push('l.vendedor_id = ?'); params.push(Number(vendedor_id)); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  return db.prepare(`SELECT l.*, u.nombre AS vendedor, (SELECT COALESCE(SUM(a.valor),0) FROM liquidacion_ajustes a WHERE a.liquidacion_id = l.id) AS ajustes_posteriores FROM liquidaciones l JOIN usuarios u ON u.id = l.vendedor_id ${where} ORDER BY l.id DESC LIMIT ?`).all(...params, limite);
}

function anular(db, id, motivo, usuario) {
  if (!tiene(usuario, 'comisiones.administrar')) throw err.prohibido();
  const l = db.prepare('SELECT * FROM liquidaciones WHERE id = ?').get(id);
  if (!l) throw err.noEncontrado('Liquidación no existe');
  if (l.estado === 'anulada') throw err.conflicto('La liquidación ya está anulada');
  const mot = texto(motivo, 'Motivo', { max: 300 });
  return transaccion(db, () => {
    db.prepare("UPDATE liquidaciones SET estado = 'anulada', anulada_por = ?, anulada_en = ?, anulacion_motivo = ? WHERE id = ?").run(usuario.id, ahora(), mot, id);
    db.prepare('UPDATE liquidacion_ajustes SET aplicado_en = NULL WHERE aplicado_en = ?').run(id); // vuelven a quedar pendientes
    auditoria.registrar(db, usuario, 'anular_liquidacion', 'liquidacion', id, { numero: l.numero, motivo: mot });
    return obtener(db, id);
  });
}

// Reporte exportable (CSV/PDF) con el mismo formato que los demás reportes.
function reporte(db, id) {
  const l = obtener(db, id);
  const filas = l.ventas.map((v) => ({ numero: v.numero, fecha: v.fecha, cliente: v.cliente || 'Consumidor final', resumen: v.resumen, total: v.total, ganancia: v.ganancia, comisionable: v.comisionable ? 'Sí' : 'No', comision: v.comision, comision_actual: v.comision_actual }));
  for (const a of l.ajustes_aplicados) filas.push({ numero: `Ajuste ${a.origen_numero}`, fecha: a.fecha, cliente: '', resumen: `${a.motivo} (venta ${a.venta_numero || ''})`, total: 0, ganancia: 0, comisionable: '', comision: a.valor, comision_actual: a.valor });
  return {
    clave: 'liquidacion', titulo: `Liquidación ${l.numero} · ${l.vendedor}`,
    columnas: [['numero', 'Venta'], ['fecha', 'Fecha'], ['cliente', 'Cliente'], ['resumen', 'Productos'], ['total', 'Facturado'], ['ganancia', 'Ganancia operativa'], ['comisionable', 'Comisiona'], ['comision', 'Comisión'], ['comision_actual', 'Comisión vigente']].map(([clave, titulo]) => ({ clave, titulo })),
    filas, totales: { total: l.ingreso_neto, ganancia: l.ganancia_operativa, comision: l.comision + l.ajustes_previos },
    filtros: { desde: l.desde, hasta: l.hasta }, generado: ahora(), periodo: { desde: l.desde, hasta: l.hasta }, moneda: 'COP',
    criterios: `Salario del periodo ${l.salario.toLocaleString('es-CO')} + comisión ${l.comision_pct}% sobre ganancia comisionable ${l.ganancia_comisionable.toLocaleString('es-CO')} = ${l.comision.toLocaleString('es-CO')}; ajustes de periodos anteriores ${l.ajustes_previos.toLocaleString('es-CO')}; total ${l.total.toLocaleString('es-CO')}. Devengo: ${l.devengo === 'cobro' ? 'al cobro' : 'al confirmar la venta'}. Antes de usarla como liquidación oficial de nómina, verifique prestaciones y obligaciones laborales aplicables en Colombia.`,
  };
}
function reporteCsv(db, id) { const r = reporte(db, id); return csv(r.filas, r.columnas); }

module.exports = { configComisiones, usuarioComercial, tipoUsuario, tipoPorRol, ventasConGanancia, resumen, reasignar, ajustarPorCambio, cerrar, obtener, listar, anular, reporte, reporteCsv, factorSalario, factorLiquidacion };
