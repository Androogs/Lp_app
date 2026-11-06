'use strict';
// Marketing y analítica comercial: campañas, métricas por día (manuales o sincronizadas), eventos de la página web (UTM),
// clientes potenciales (leads), atribución de cada venta a una campaña, rentabilidad por campaña e integraciones con
// plataformas publicitarias. Documentación de reglas en docs/MARKETING.md.
//
// Reglas de oro:
//  - Nada se inventa: cuando no hay datos, el valor es null (sin dato) o 0 (hubo registro y fue cero).
//  - Inversión de una campaña en un periodo = suma de campana_metricas.gasto de los días del periodo, tomando por día la fila
//    de origen 'sincronizacion' si existe y, si no, la 'manual' (nunca ambas) + gasto_manual de la campaña cuando no tiene
//    ninguna métrica por día y su vigencia (fecha_inicio..fecha_fin, o la fecha de creación) toca el periodo.
//  - Las ventas anuladas no cuentan en ninguna métrica (la atribución se conserva pero se filtra por v.estado <> 'anulada').
//  - Atribución de ventas (en orden): campana_en_venta → lead_vinculado → cliente_origen → ventana_lead (estimada) →
//    solo_canal (desconocida con canal) → sin_datos (desconocida).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { transaccion, getConfig, setConfig, CONFIG_DEFAULT } = require('../db');
const { err, ahora, hoy, aFecha, sumarDias, entero, texto, opcion, fecha: vFecha, csv, slug, pad } = require('../util');
const { tiene } = require('../permisos');
const auditoria = require('./auditoria');
const { rango, granularidad } = require('./analitica');
const adaptadores = require('./marketing/index');

const d0 = (d) => d + ' 00:00:00';
const d1 = (d) => d + ' 23:59:59';
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const PLATAFORMAS = ['meta', 'google', 'tiktok', 'whatsapp', 'organico', 'otra'];
const OBJETIVOS = ['ventas', 'mensajes', 'trafico', 'reconocimiento', 'otro'];
const ESTADOS_CAMPANA = ['borrador', 'activa', 'pausada', 'finalizada'];
const ESTADOS_LEAD = ['nuevo', 'contactado', 'interesado', 'convertido', 'perdido'];
const TIPOS_EVENTO = ['visita', 'producto', 'clic_contacto', 'formulario', 'conversacion', 'compra'];
const TIPOS_EVENTO_PUBLICO = ['visita', 'producto', 'clic_contacto', 'formulario', 'conversacion'];
const REGLAS = { campana_en_venta: 'Campaña elegida al vender', lead_vinculado: 'Cliente creado desde un cliente potencial de la campaña', cliente_origen: 'Campaña de origen registrada en el cliente', ventana_lead: 'Cliente potencial con el mismo teléfono dentro de la ventana de atribución', solo_canal: 'Solo se conoce el canal, sin campaña', sin_datos: 'Sin información de origen', manual: 'Asignada a mano desde Marketing' };
const FRECUENCIA_SINC_HORAS = 6;

function configMarketing(db) {
  const base = CONFIG_DEFAULT.marketing;
  const c = getConfig(db, 'marketing') || {};
  return { ...base, ...c, canales: Array.isArray(c.canales) && c.canales.length ? c.canales : base.canales };
}
const periodoDe = (f = {}) => rango({ periodo: f.periodo || '30d', desde: f.desde, hasta: f.hasta });
const division = (a, b, dec = 0) => (b > 0 && a !== null && a !== undefined ? Math.round((a / b) * Math.pow(10, dec)) / Math.pow(10, dec) : null);
const digitos = (t) => String(t || '').replace(/\D/g, '');
const telClave = (t) => { const d = digitos(t); return d.length >= 7 ? d.slice(-10) : ''; };

// ---------- Buckets para series (misma lógica que analitica.js) ----------
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
function serieVacia(r, g) {
  const m = new Map();
  const nuevo = (k) => ({ clave: k, etiqueta: etiquetaBucket(k, g), inversion: 0, ingresos: 0, leads: 0, ventas: 0, visitas: 0, consultas: 0 });
  if (g === 'hora') { for (let i = 0; i < 24; i++) m.set(pad(i), nuevo(pad(i))); return m; }
  for (let f = r.desde; f <= r.hasta; f = sumarDias(f, 1)) { const k = claveBucket(f, g); if (!m.has(k)) m.set(k, nuevo(k)); }
  return m;
}

// ============================================================================================
// Campañas
// ============================================================================================
function utmUnico(db, base, exceptoId = null) {
  let s = slug(base).slice(0, 100) || 'campana';
  let candidato = s; let n = 2;
  while (db.prepare('SELECT id FROM campanas WHERE utm_campaign = ? AND id <> COALESCE(?, -1)').get(candidato, exceptoId)) candidato = `${s}-${n++}`;
  return candidato;
}
function sanearCampana(db, datos, actual = null) {
  const d = {};
  const pon = (k, v) => { if (datos[k] !== undefined || !actual) d[k] = v; };
  pon('nombre', texto(datos.nombre ?? (actual && actual.nombre), 'Nombre de la campaña', { max: 160 }));
  pon('plataforma', opcion(datos.plataforma ?? (actual && actual.plataforma), 'Plataforma', PLATAFORMAS, { opcional: true, defecto: 'otra' }));
  pon('objetivo', opcion(datos.objetivo ?? (actual && actual.objetivo), 'Objetivo', OBJETIVOS, { opcional: true, defecto: null }));
  pon('fecha_inicio', vFecha(datos.fecha_inicio ?? (actual && actual.fecha_inicio), 'Fecha de inicio', { opcional: true }));
  pon('fecha_fin', vFecha(datos.fecha_fin ?? (actual && actual.fecha_fin), 'Fecha de fin', { opcional: true }));
  const ini = d.fecha_inicio ?? (actual && actual.fecha_inicio); const fin = d.fecha_fin ?? (actual && actual.fecha_fin);
  if (ini && fin && fin < ini) throw err.datos('La fecha de fin no puede ser anterior a la de inicio');
  pon('presupuesto', entero(datos.presupuesto ?? (actual && actual.presupuesto), 'Presupuesto', { min: 0, opcional: true, defecto: 0 }));
  pon('gasto_manual', entero(datos.gasto_manual ?? (actual && actual.gasto_manual), 'Gasto', { min: 0, opcional: true, defecto: 0 }));
  const enlace = texto(datos.enlace_destino ?? (actual && actual.enlace_destino), 'Enlace de destino', { opcional: true, max: 500 });
  if (enlace && !/^https?:\/\/\S+$/i.test(enlace)) throw err.datos('El enlace de destino debe empezar por http:// o https://');
  pon('enlace_destino', enlace);
  pon('utm_source', texto(datos.utm_source ?? (actual && actual.utm_source), 'utm_source', { opcional: true, max: 120 }));
  pon('utm_medium', texto(datos.utm_medium ?? (actual && actual.utm_medium), 'utm_medium', { opcional: true, max: 120 }));
  pon('id_externo', texto(datos.id_externo ?? (actual && actual.id_externo), 'Id en la plataforma', { opcional: true, max: 120 }));
  pon('observaciones', texto(datos.observaciones ?? (actual && actual.observaciones), 'Observaciones', { opcional: true, max: 2000 }));
  if (datos.estado !== undefined || !actual) d.estado = opcion(datos.estado ?? (actual && actual.estado), 'Estado', ESTADOS_CAMPANA, { opcional: true, defecto: 'borrador' });
  // utm_campaign: el que escriba el usuario (normalizado) o uno único a partir del nombre.
  if (datos.utm_campaign !== undefined || !actual) {
    const pedido = texto(datos.utm_campaign, 'utm_campaign', { opcional: true, max: 120 });
    if (pedido) {
      const s = slug(pedido);
      if (!s) throw err.datos('utm_campaign solo puede tener letras, números y guiones');
      if (db.prepare('SELECT id FROM campanas WHERE utm_campaign = ? AND id <> COALESCE(?, -1)').get(s, actual ? actual.id : null)) throw err.conflicto(`Ya existe una campaña con utm_campaign "${s}"`);
      d.utm_campaign = s;
    } else if (!actual || !actual.utm_campaign) d.utm_campaign = utmUnico(db, d.nombre || (actual && actual.nombre), actual ? actual.id : null);
  }
  if (!d.utm_source && !actual) d.utm_source = d.plataforma === 'otra' ? null : d.plataforma;
  if (!d.utm_medium && !actual) d.utm_medium = ['meta', 'google', 'tiktok'].includes(d.plataforma) ? 'cpc' : (d.plataforma === 'organico' ? 'organic' : 'social');
  return d;
}
function productosValidos(db, lista) {
  if (lista === undefined) return undefined;
  if (!Array.isArray(lista)) throw err.datos('Los productos deben ser una lista de ids');
  const ids = [...new Set(lista.map((x) => entero(typeof x === 'object' && x ? x.id ?? x.producto_id : x, 'Producto')))];
  for (const id of ids) if (!db.prepare('SELECT id FROM productos WHERE id = ?').get(id)) throw err.noEncontrado(`El producto ${id} no existe`);
  return ids;
}
function guardarProductos(db, campanaId, ids) {
  db.prepare('DELETE FROM campana_productos WHERE campana_id = ?').run(campanaId);
  const ins = db.prepare('INSERT INTO campana_productos(campana_id, producto_id) VALUES (?,?)');
  for (const id of ids) ins.run(campanaId, id);
}

function crearCampana(db, datos, usuario) {
  if (!tiene(usuario, 'marketing.editar')) throw err.prohibido('No tienes permiso para crear campañas');
  const d = sanearCampana(db, datos || {});
  const productos = productosValidos(db, datos.productos) || [];
  return transaccion(db, () => {
    const r = db.prepare(`INSERT INTO campanas(nombre, plataforma, objetivo, estado, fecha_inicio, fecha_fin, presupuesto, gasto_manual, enlace_destino, utm_source, utm_medium, utm_campaign, id_externo, observaciones, usuario_id)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(d.nombre, d.plataforma, d.objetivo, d.estado, d.estado === 'activa' && !d.fecha_inicio ? hoy() : d.fecha_inicio, d.fecha_fin, d.presupuesto, d.gasto_manual, d.enlace_destino, d.utm_source, d.utm_medium, d.utm_campaign, d.id_externo, d.observaciones, usuario.id);
    const id = Number(r.lastInsertRowid);
    guardarProductos(db, id, productos);
    auditoria.registrar(db, usuario, 'crear_campana', 'campana', id, { ...d, productos });
    return obtenerCampana(db, id);
  });
}
function actualizarCampana(db, id, datos, usuario) {
  if (!tiene(usuario, 'marketing.editar')) throw err.prohibido('No tienes permiso para editar campañas');
  const actual = db.prepare('SELECT * FROM campanas WHERE id = ?').get(id);
  if (!actual) throw err.noEncontrado('Campaña no existe');
  const d = sanearCampana(db, datos || {}, actual);
  const productos = productosValidos(db, datos.productos);
  return transaccion(db, () => {
    const campos = Object.keys(d).filter((k) => k !== 'estado');
    if (campos.length) db.prepare(`UPDATE campanas SET ${campos.map((k) => `${k} = ?`).join(', ')}, actualizado_en = ? WHERE id = ?`).run(...campos.map((k) => d[k]), ahora(), id);
    if (d.estado && d.estado !== actual.estado) aplicarEstado(db, actual, d.estado);
    if (productos) guardarProductos(db, id, productos);
    auditoria.registrar(db, usuario, 'editar_campana', 'campana', id, { antes: actual, despues: { ...d, productos } });
    return obtenerCampana(db, id);
  });
}
function aplicarEstado(db, c, estado) {
  const h = hoy();
  db.prepare('UPDATE campanas SET estado = ?, fecha_inicio = CASE WHEN ? = \'activa\' AND fecha_inicio IS NULL THEN ? ELSE fecha_inicio END, fecha_fin = CASE WHEN ? = \'finalizada\' AND fecha_fin IS NULL THEN ? ELSE fecha_fin END, actualizado_en = ? WHERE id = ?')
    .run(estado, estado, h, estado, h, ahora(), c.id);
}
function cambiarEstadoCampana(db, id, estado, usuario) {
  if (!tiene(usuario, 'marketing.editar')) throw err.prohibido('No tienes permiso para cambiar el estado de una campaña');
  const c = db.prepare('SELECT * FROM campanas WHERE id = ?').get(id);
  if (!c) throw err.noEncontrado('Campaña no existe');
  const nuevo = opcion(estado, 'Estado', ESTADOS_CAMPANA);
  if (nuevo === c.estado) return obtenerCampana(db, id);
  return transaccion(db, () => {
    aplicarEstado(db, c, nuevo);
    auditoria.registrar(db, usuario, 'estado_campana', 'campana', id, { antes: c.estado, despues: nuevo });
    return obtenerCampana(db, id);
  });
}
function fijarProductos(db, id, lista, usuario) {
  if (!tiene(usuario, 'marketing.editar')) throw err.prohibido('No tienes permiso para editar campañas');
  if (!db.prepare('SELECT id FROM campanas WHERE id = ?').get(id)) throw err.noEncontrado('Campaña no existe');
  const ids = productosValidos(db, lista) || [];
  return transaccion(db, () => { guardarProductos(db, id, ids); auditoria.registrar(db, usuario, 'productos_campana', 'campana', id, { productos: ids }); return obtenerCampana(db, id); });
}

// ---------- Inversión y métricas por campaña (regla de prioridad sincronización > manual + gasto_manual) ----------
const COND_PRIORIDAD = "(m.origen = 'sincronizacion' OR NOT EXISTS (SELECT 1 FROM campana_metricas s WHERE s.campana_id = m.campana_id AND s.fecha = m.fecha AND s.origen = 'sincronizacion'))";
function metricasPorCampana(db, r, { campana_id = null } = {}) {
  const filas = db.prepare(`SELECT m.campana_id, SUM(m.gasto) gasto, SUM(m.impresiones) impresiones, SUM(m.alcance) alcance, SUM(m.clics) clics, SUM(m.conversaciones) conversaciones, SUM(m.resultados) resultados, COUNT(*) dias
      FROM campana_metricas m WHERE m.fecha BETWEEN ? AND ? ${campana_id ? 'AND m.campana_id = ?' : ''} AND ${COND_PRIORIDAD} GROUP BY m.campana_id`).all(r.desde, r.hasta, ...(campana_id ? [campana_id] : []));
  const mapa = new Map(filas.map((f) => [f.campana_id, { inversion: f.gasto || 0, impresiones: f.impresiones, alcance: f.alcance, clics: f.clics, conversaciones: f.conversaciones, resultados: f.resultados, dias: f.dias, con_metricas: true, gasto_manual_aplicado: 0 }]));
  const sinMetricas = db.prepare(`SELECT c.id, c.gasto_manual FROM campanas c WHERE c.gasto_manual > 0 ${campana_id ? 'AND c.id = ?' : ''}
      AND NOT EXISTS (SELECT 1 FROM campana_metricas m WHERE m.campana_id = c.id)
      AND COALESCE(c.fecha_inicio, substr(c.creado_en, 1, 10)) <= ? AND COALESCE(c.fecha_fin, ?) >= ?`).all(...(campana_id ? [campana_id] : []), r.hasta, hoy(), r.desde);
  for (const c of sinMetricas) mapa.set(c.id, { inversion: c.gasto_manual, impresiones: null, alcance: null, clics: null, conversaciones: null, resultados: null, dias: 0, con_metricas: false, gasto_manual_aplicado: c.gasto_manual });
  return mapa;
}
// Inversión por fecha (para las series). El gasto_manual sin métricas se asigna al primer día de vigencia dentro del periodo.
function inversionPorFecha(db, r) {
  const m = new Map();
  for (const f of db.prepare(`SELECT m.fecha, SUM(m.gasto) gasto FROM campana_metricas m WHERE m.fecha BETWEEN ? AND ? AND ${COND_PRIORIDAD} GROUP BY m.fecha`).all(r.desde, r.hasta)) m.set(f.fecha, (m.get(f.fecha) || 0) + (f.gasto || 0));
  for (const c of db.prepare(`SELECT c.gasto_manual, COALESCE(c.fecha_inicio, substr(c.creado_en, 1, 10)) ini FROM campanas c WHERE c.gasto_manual > 0 AND NOT EXISTS (SELECT 1 FROM campana_metricas m WHERE m.campana_id = c.id)
      AND COALESCE(c.fecha_inicio, substr(c.creado_en, 1, 10)) <= ? AND COALESCE(c.fecha_fin, ?) >= ?`).all(r.hasta, hoy(), r.desde)) { const f = c.ini < r.desde ? r.desde : c.ini; m.set(f, (m.get(f) || 0) + c.gasto_manual); }
  return m;
}
// Ventas atribuidas (confirmadas/estimadas) del periodo, con ingreso neto y costos reales (ventas anuladas excluidas).
// `limite` solo se usa para listas (ficha de campaña); los agregados (resumen, panel, embudo, rentabilidad) van sin LIMIT para
// que las sumas nunca se trunquen.
function ventasAtribuidas(db, r, { campana_id = null, tipos = ['confirmada', 'estimada'], limite = null } = {}) {
  const lim = Number(limite) > 0 ? Math.min(Number(limite), 5000) : null;
  return db.prepare(`SELECT a.venta_id id, a.tipo, a.regla, a.canal, a.campana_id, a.lead_id, v.numero, v.fecha, v.cliente_id, v.total, v.costo_total, v.comision, v.gastos_venta, v.impuestos, v.estado, c.nombre cliente, ca.nombre campana,
        (SELECT COALESCE(SUM(d.total),0) FROM devoluciones d WHERE d.venta_id = v.id AND d.tipo <> 'anulacion') devuelto,
        (SELECT COALESCE(SUM(di.costo),0) FROM devoluciones d JOIN devolucion_items di ON di.devolucion_id = d.id WHERE d.venta_id = v.id AND d.tipo <> 'anulacion') costo_devuelto
      FROM marketing_atribuciones a JOIN ventas v ON v.id = a.venta_id LEFT JOIN clientes c ON c.id = v.cliente_id LEFT JOIN campanas ca ON ca.id = a.campana_id
      WHERE v.estado <> 'anulada' AND a.tipo IN (${tipos.map(() => '?').join(',')}) AND v.fecha BETWEEN ? AND ? ${campana_id ? 'AND a.campana_id = ?' : ''}
      ORDER BY v.fecha DESC, v.id DESC ${lim ? 'LIMIT ?' : ''}`).all(...tipos, d0(r.desde), d1(r.hasta), ...(campana_id ? [campana_id] : []), ...(lim ? [lim] : []))
    .map((v) => ({ ...v, ingreso_neto: v.total - v.devuelto, costo_productos: v.costo_total - v.costo_devuelto, costos_variables: (v.gastos_venta || 0) + (v.comision || 0) + (v.impuestos || 0) }));
}
function leadsPorCampana(db, r) {
  const m = new Map();
  for (const f of db.prepare('SELECT campana_id, COUNT(*) n, SUM(estado = \'convertido\') convertidos FROM marketing_leads WHERE campana_id IS NOT NULL AND fecha BETWEEN ? AND ? GROUP BY campana_id').all(d0(r.desde), d1(r.hasta))) m.set(f.campana_id, { leads: f.n, convertidos: f.convertidos });
  return m;
}
// Resumen por campaña (inversión, métricas, leads, ventas, ingresos, roas, cac) para un rango; `ids` limita a esas campañas.
function resumenCampanas(db, r, { ids = null } = {}) {
  const met = metricasPorCampana(db, r);
  const leads = leadsPorCampana(db, r);
  const ventas = ventasAtribuidas(db, r);
  const porVenta = new Map();
  for (const v of ventas) {
    if (!v.campana_id) continue;
    if (!porVenta.has(v.campana_id)) porVenta.set(v.campana_id, { ventas: 0, confirmadas: 0, estimadas: 0, ingresos: 0, ingresos_confirmados: 0, ingresos_estimados: 0, clientes: new Set(), costo_productos: 0, costos_variables: 0 });
    const x = porVenta.get(v.campana_id);
    x.ventas++; x.ingresos += v.ingreso_neto; x.costo_productos += v.costo_productos; x.costos_variables += v.costos_variables;
    if (v.tipo === 'confirmada') { x.confirmadas++; x.ingresos_confirmados += v.ingreso_neto; } else { x.estimadas++; x.ingresos_estimados += v.ingreso_neto; }
    x.clientes.add(v.cliente_id ? 'c' + v.cliente_id : 'v' + v.id);
  }
  const todos = ids || [...new Set([...met.keys(), ...leads.keys(), ...porVenta.keys()])];
  const salida = new Map();
  for (const id of todos) {
    const m = met.get(id) || { inversion: 0, impresiones: null, alcance: null, clics: null, conversaciones: null, resultados: null, dias: 0, con_metricas: false, gasto_manual_aplicado: 0 };
    const l = leads.get(id) || { leads: 0, convertidos: 0 };
    const v = porVenta.get(id) || { ventas: 0, confirmadas: 0, estimadas: 0, ingresos: 0, ingresos_confirmados: 0, ingresos_estimados: 0, clientes: new Set(), costo_productos: 0, costos_variables: 0 };
    const clientes = v.clientes.size;
    salida.set(id, { ...m, leads: l.leads, leads_convertidos: l.convertidos, ventas: v.ventas, ventas_confirmadas: v.confirmadas, ventas_estimadas: v.estimadas, ingresos: v.ingresos, ingresos_confirmados: v.ingresos_confirmados, ingresos_estimados: v.ingresos_estimados, clientes, costo_productos: v.costo_productos, costos_variables: v.costos_variables,
      // Sin inversión no hay CAC ni costo por lead (null, igual que en el panel): un 0 diría "costó cero", que no es cierto.
      roas: division(v.ingresos, m.inversion, 2), cac: m.inversion > 0 ? division(m.inversion, clientes) : null, costo_por_lead: m.inversion > 0 ? division(m.inversion, l.leads) : null });
  }
  return salida;
}

function listarCampanas(db, { estado, plataforma, q, periodo, desde, hasta, limite = 200 } = {}, { conCifras = true } = {}) {
  const cond = []; const params = [];
  if (estado === 'abiertas') cond.push("c.estado IN ('activa','pausada')");
  else if (estado && estado !== 'todas') cond.push('c.estado = ?'), params.push(opcion(estado, 'Estado', ESTADOS_CAMPANA));
  if (plataforma) cond.push('c.plataforma = ?'), params.push(opcion(plataforma, 'Plataforma', PLATAFORMAS));
  // Sin cifras (solo marketing.leads) el filtro busca únicamente en los campos que esa persona ve: observaciones e id_externo
  // quedan fuera para que el conteo `total` no sirva de oráculo de texto interno.
  if (q && conCifras) { cond.push('(c.nombre LIKE ? OR c.utm_campaign LIKE ? OR c.id_externo LIKE ? OR c.observaciones LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  else if (q) { cond.push('(c.nombre LIKE ? OR c.utm_campaign LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const filas = db.prepare(`SELECT c.*, u.nombre usuario_nombre, (SELECT COUNT(*) FROM campana_productos cp WHERE cp.campana_id = c.id) productos_n
      FROM campanas c LEFT JOIN usuarios u ON u.id = c.usuario_id ${where} ORDER BY CASE c.estado WHEN 'activa' THEN 0 WHEN 'pausada' THEN 1 WHEN 'borrador' THEN 2 ELSE 3 END, c.actualizado_en DESC, c.id DESC LIMIT ?`).all(...params, Math.min(Number(limite) || 200, 1000));
  const total = db.prepare(`SELECT COUNT(*) n FROM campanas c ${where}`).get(...params).n;
  if (!conCifras) return { campanas: filas.map((c) => ({ id: c.id, nombre: c.nombre, plataforma: c.plataforma, estado: c.estado, objetivo: c.objetivo, utm_campaign: c.utm_campaign, fecha_inicio: c.fecha_inicio, fecha_fin: c.fecha_fin })), total };
  const r = periodo || (desde && hasta) ? periodoDe({ periodo, desde, hasta }) : { periodo: 'todo', desde: '2000-01-01', hasta: hoy() };
  const res = resumenCampanas(db, r, { ids: filas.map((c) => c.id) });
  return { periodo: r, campanas: filas.map((c) => ({ ...c, ...res.get(c.id) })), total };
}

function enlaces(db, c) {
  let utm = null;
  if (c.enlace_destino) {
    try {
      const u = new URL(c.enlace_destino);
      if (c.utm_source) u.searchParams.set('utm_source', c.utm_source);
      if (c.utm_medium) u.searchParams.set('utm_medium', c.utm_medium);
      if (c.utm_campaign) u.searchParams.set('utm_campaign', c.utm_campaign);
      utm = u.toString();
    } catch { utm = null; }
  }
  const tel = digitos(getConfig(db, 'negocio_telefono'));
  const telWa = tel ? (tel.length === 10 ? '57' + tel : tel) : '';
  const whatsapp = telWa ? `https://wa.me/${telWa}?text=${encodeURIComponent(`Hola, vengo de ${c.nombre}`)}` : null;
  return { utm, whatsapp, telefono_negocio: tel || null };
}
function obtenerCampana(db, id, { periodo, desde, hasta } = {}) {
  const c = db.prepare('SELECT c.*, u.nombre usuario_nombre FROM campanas c LEFT JOIN usuarios u ON u.id = c.usuario_id WHERE c.id = ?').get(id);
  if (!c) throw err.noEncontrado('Campaña no existe');
  c.productos = db.prepare('SELECT p.id, p.nombre, p.referencia, p.precio_venta, s.stock FROM campana_productos cp JOIN productos p ON p.id = cp.producto_id LEFT JOIN v_stock s ON s.producto_id = p.id WHERE cp.campana_id = ? ORDER BY p.nombre').all(id);
  const todo = { periodo: 'todo', desde: '2000-01-01', hasta: hoy() };
  const r = periodo || (desde && hasta) ? periodoDe({ periodo, desde, hasta }) : todo;
  c.periodo = r;
  c.resumen = resumenCampanas(db, r, { ids: [id] }).get(id);
  c.resumen_total = r.periodo === 'todo' ? c.resumen : resumenCampanas(db, todo, { ids: [id] }).get(id);
  c.metricas = listarMetricas(db, id, { limite: 90 });
  c.leads = db.prepare('SELECT l.id, l.fecha, l.nombre, l.telefono, l.canal, l.estado, l.producto_texto, l.cliente_id, l.venta_id, p.nombre producto_nombre FROM marketing_leads l LEFT JOIN productos p ON p.id = l.producto_id WHERE l.campana_id = ? ORDER BY l.id DESC LIMIT 20').all(id);
  c.ventas = ventasAtribuidas(db, todo, { campana_id: id, limite: 20 }).map((v) => ({ id: v.id, numero: v.numero, fecha: v.fecha, cliente: v.cliente, total: v.total, ingreso_neto: v.ingreso_neto, tipo: v.tipo, regla: v.regla, regla_texto: REGLAS[v.regla] || v.regla, canal: v.canal }));
  c.eventos = db.prepare('SELECT tipo, COUNT(*) n FROM marketing_eventos WHERE campana_id = ? GROUP BY tipo').all(id).reduce((o, f) => ({ ...o, [f.tipo]: f.n }), {});
  c.enlaces = enlaces(db, c);
  c.ultima_sincronizacion = c.id_externo ? db.prepare('SELECT * FROM marketing_sincronizaciones WHERE plataforma = ? ORDER BY id DESC LIMIT 1').get(c.plataforma) || null : null;
  return c;
}

// ---------- Métricas por día ----------
function guardarMetricas(db, campanaId, datos, usuario) {
  if (!tiene(usuario, 'marketing.editar')) throw err.prohibido('No tienes permiso para registrar métricas');
  if (!db.prepare('SELECT id FROM campanas WHERE id = ?').get(campanaId)) throw err.noEncontrado('Campaña no existe');
  const filas = Array.isArray(datos.filas) ? datos.filas : [datos];
  if (!filas.length) throw err.datos('Indica al menos un día');
  const limpias = filas.map((f, i) => {
    const fecha = vFecha(f.fecha, `Fecha de la fila ${i + 1}`);
    if (fecha > hoy()) throw err.datos('No se registran métricas de fechas futuras');
    const num = (k, nombre) => (f[k] === undefined || f[k] === null || f[k] === '' ? null : entero(f[k], nombre, { min: 0 }));
    return { fecha: fecha.slice(0, 10), impresiones: num('impresiones', 'Impresiones'), alcance: num('alcance', 'Alcance'), clics: num('clics', 'Clics'), gasto: entero(f.gasto, 'Gasto', { min: 0, opcional: true, defecto: 0 }), conversaciones: num('conversaciones', 'Conversaciones'), resultados: num('resultados', 'Resultados') };
  });
  return transaccion(db, () => {
    const up = db.prepare(`INSERT INTO campana_metricas(campana_id, fecha, impresiones, alcance, clics, gasto, conversaciones, resultados, origen, usuario_id, creado_en) VALUES (?,?,?,?,?,?,?,?,'manual',?,?)
      ON CONFLICT(campana_id, fecha, origen) DO UPDATE SET impresiones = excluded.impresiones, alcance = excluded.alcance, clics = excluded.clics, gasto = excluded.gasto, conversaciones = excluded.conversaciones, resultados = excluded.resultados, usuario_id = excluded.usuario_id, creado_en = excluded.creado_en`);
    for (const f of limpias) up.run(campanaId, f.fecha, f.impresiones, f.alcance, f.clics, f.gasto, f.conversaciones, f.resultados, usuario.id, ahora());
    auditoria.registrar(db, usuario, 'metricas_campana', 'campana', campanaId, { filas: limpias });
    return { ok: true, guardadas: limpias.length, metricas: listarMetricas(db, campanaId, { limite: 90 }) };
  });
}
function eliminarMetrica(db, campanaId, fecha, usuario) {
  if (!tiene(usuario, 'marketing.editar')) throw err.prohibido('No tienes permiso para borrar métricas');
  const f = vFecha(fecha, 'Fecha');
  const r = db.prepare("DELETE FROM campana_metricas WHERE campana_id = ? AND fecha = ? AND origen = 'manual'").run(campanaId, f.slice(0, 10));
  auditoria.registrar(db, usuario, 'borrar_metrica_campana', 'campana', campanaId, { fecha: f, borradas: Number(r.changes) });
  return { ok: true, borradas: Number(r.changes) };
}
function listarMetricas(db, campanaId, { desde, hasta, limite = 120 } = {}) {
  const cond = ['m.campana_id = ?']; const params = [campanaId];
  if (desde) { cond.push('m.fecha >= ?'); params.push(desde); }
  if (hasta) { cond.push('m.fecha <= ?'); params.push(hasta); }
  const filas = db.prepare(`SELECT m.*, u.nombre usuario_nombre, ${COND_PRIORIDAD} prevalece FROM campana_metricas m LEFT JOIN usuarios u ON u.id = m.usuario_id WHERE ${cond.join(' AND ')} ORDER BY m.fecha DESC, m.origen DESC LIMIT ?`).all(...params, Math.min(Number(limite) || 120, 1000));
  return filas.map((f) => ({ ...f, prevalece: !!f.prevalece }));
}

// ============================================================================================
// Clientes potenciales (leads)
// ============================================================================================
function campanaPorUtm(db, utm) {
  const t = String(utm || '').trim();
  if (!t) return null;
  const porSlug = db.prepare('SELECT id FROM campanas WHERE lower(utm_campaign) = lower(?)').get(t);
  if (porSlug) return porSlug.id;
  if (/^\d+$/.test(t)) { const porId = db.prepare('SELECT id FROM campanas WHERE id = ?').get(Number(t)); if (porId) return porId.id; }
  const porSlugLimpio = db.prepare('SELECT id FROM campanas WHERE utm_campaign = ?').get(slug(t));
  return porSlugLimpio ? porSlugLimpio.id : null;
}
function productoPorTexto(db, textoProducto, idSugerido) {
  if (idSugerido && /^\d+$/.test(String(idSugerido))) { const p = db.prepare('SELECT id FROM productos WHERE id = ?').get(Number(idSugerido)); if (p) return p.id; }
  const t = String(textoProducto || '').trim();
  if (!t) return null;
  const p = db.prepare('SELECT id FROM productos WHERE lower(nombre) = lower(?) OR sku = ? OR referencia = ? OR codigo_barras = ? LIMIT 1').get(t, t, t, t);
  return p ? p.id : null;
}
// `canalesExtra`: canales aceptados aunque no estén en la configuración (el formulario web siempre entra como 'web').
function sanearLead(db, datos, actual = null, { canalesExtra = [] } = {}) {
  const cfg = configMarketing(db);
  const canales = [...new Set([...cfg.canales, ...canalesExtra])];
  const d = {};
  const v = (k, val) => { if (datos[k] !== undefined || !actual) d[k] = val; };
  v('nombre', texto(datos.nombre ?? (actual && actual.nombre), 'Nombre', { opcional: true, max: 160 }));
  v('telefono', texto(datos.telefono ?? (actual && actual.telefono), 'Teléfono', { opcional: true, max: 40 }));
  v('email', texto(datos.email ?? (actual && actual.email), 'Correo', { opcional: true, max: 160 }));
  v('mensaje', texto(datos.mensaje ?? (actual && actual.mensaje), 'Mensaje', { opcional: true, max: 2000 }));
  v('notas', texto(datos.notas ?? (actual && actual.notas), 'Notas', { opcional: true, max: 2000 }));
  v('producto_texto', texto(datos.producto_texto ?? (actual && actual.producto_texto), 'Producto', { opcional: true, max: 200 }));
  if (datos.canal !== undefined || !actual) d.canal = opcion(datos.canal ?? (actual && actual.canal), 'Canal', canales, { opcional: true, defecto: 'otro' });
  if (datos.campana_id !== undefined || !actual) {
    const id = datos.campana_id === null || datos.campana_id === '' || datos.campana_id === undefined ? null : entero(datos.campana_id, 'Campaña');
    if (id && !db.prepare('SELECT id FROM campanas WHERE id = ?').get(id)) throw err.noEncontrado('La campaña no existe');
    d.campana_id = id || (!actual && datos.utm_campaign ? campanaPorUtm(db, datos.utm_campaign) : null);
  }
  if (datos.producto_id !== undefined || !actual) {
    const id = datos.producto_id === null || datos.producto_id === '' || datos.producto_id === undefined ? null : entero(datos.producto_id, 'Producto');
    if (id && !db.prepare('SELECT id FROM productos WHERE id = ?').get(id)) throw err.noEncontrado('El producto no existe');
    d.producto_id = id || (!actual ? productoPorTexto(db, d.producto_texto) : null);
  }
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign']) if (datos[k] !== undefined || !actual) d[k] = texto(datos[k], k, { opcional: true, max: 120 });
  if (datos.visitante !== undefined || !actual) d.visitante = texto(datos.visitante, 'Visitante', { opcional: true, max: 80 });
  if (datos.fecha !== undefined && datos.fecha) { const f = vFecha(datos.fecha, 'Fecha'); d.fecha = f.length === 10 ? f + ' ' + ahora().slice(11) : f; }
  const final = { ...(actual || {}), ...d };
  if (!final.nombre && !final.telefono && !final.email && !final.mensaje) throw err.datos('Indica al menos el nombre, el teléfono, el correo o el mensaje del cliente potencial');
  return d;
}
const puedeLeads = (u) => tiene(u, 'marketing.leads') || tiene(u, 'marketing.editar');

function crearLead(db, datos, usuario, { auditar = true, canalesExtra = [] } = {}) {
  if (usuario && !puedeLeads(usuario)) throw err.prohibido('No tienes permiso para registrar clientes potenciales');
  const d = sanearLead(db, datos || {}, null, { canalesExtra });
  const r = db.prepare(`INSERT INTO marketing_leads(fecha, nombre, telefono, email, mensaje, canal, utm_source, utm_medium, utm_campaign, campana_id, visitante, producto_id, producto_texto, estado, notas, usuario_id)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'nuevo',?,?)`)
    .run(d.fecha || ahora(), d.nombre, d.telefono, d.email, d.mensaje, d.canal, d.utm_source, d.utm_medium, d.utm_campaign, d.campana_id, d.visitante, d.producto_id, d.producto_texto, d.notas, usuario ? usuario.id : null);
  const id = Number(r.lastInsertRowid);
  if (auditar) auditoria.registrar(db, usuario, 'crear_lead', 'lead', id, { nombre: d.nombre, telefono: d.telefono, canal: d.canal, campana_id: d.campana_id });
  return obtenerLead(db, id);
}
function obtenerLead(db, id) {
  const l = db.prepare(`SELECT l.*, c.nombre campana_nombre, c.plataforma campana_plataforma, p.nombre producto_nombre, cl.nombre cliente_nombre, v.numero venta_numero, u.nombre usuario_nombre
      FROM marketing_leads l LEFT JOIN campanas c ON c.id = l.campana_id LEFT JOIN productos p ON p.id = l.producto_id LEFT JOIN clientes cl ON cl.id = l.cliente_id LEFT JOIN ventas v ON v.id = l.venta_id LEFT JOIN usuarios u ON u.id = l.usuario_id WHERE l.id = ?`).get(id);
  if (!l) throw err.noEncontrado('Cliente potencial no existe');
  l.eventos = l.visitante ? db.prepare('SELECT id, fecha, tipo, pagina, producto_texto FROM marketing_eventos WHERE visitante = ? ORDER BY id DESC LIMIT 30').all(l.visitante) : [];
  return l;
}
function listarLeads(db, { estado, canal, campana_id, q, desde, hasta, limite = 200, pagina = 1 } = {}) {
  const cond = []; const params = [];
  if (estado && estado !== 'todos') { if (estado === 'abiertos') cond.push("l.estado IN ('nuevo','contactado','interesado')"); else cond.push('l.estado = ?'), params.push(opcion(estado, 'Estado', ESTADOS_LEAD)); }
  if (canal) { cond.push('l.canal = ?'); params.push(canal); }
  if (campana_id) { cond.push('l.campana_id = ?'); params.push(Number(campana_id)); }
  if (desde) { cond.push('l.fecha >= ?'); params.push(d0(desde)); }
  if (hasta) { cond.push('l.fecha <= ?'); params.push(d1(hasta)); }
  if (q) { cond.push('(l.nombre LIKE ? OR l.telefono LIKE ? OR l.email LIKE ? OR l.mensaje LIKE ? OR l.producto_texto LIKE ?)'); params.push(...Array(5).fill(`%${q}%`)); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const lim = Math.min(Number(limite) || 200, 1000); const off = (Math.max(Number(pagina) || 1, 1) - 1) * lim;
  const leads = db.prepare(`SELECT l.*, c.nombre campana_nombre, p.nombre producto_nombre, cl.nombre cliente_nombre, v.numero venta_numero FROM marketing_leads l LEFT JOIN campanas c ON c.id = l.campana_id LEFT JOIN productos p ON p.id = l.producto_id LEFT JOIN clientes cl ON cl.id = l.cliente_id LEFT JOIN ventas v ON v.id = l.venta_id ${where} ORDER BY l.fecha DESC, l.id DESC LIMIT ? OFFSET ?`).all(...params, lim, off);
  const total = db.prepare(`SELECT COUNT(*) n FROM marketing_leads l ${where}`).get(...params).n;
  const conteo = db.prepare('SELECT estado, COUNT(*) n FROM marketing_leads GROUP BY estado').all().reduce((o, f) => ({ ...o, [f.estado]: f.n }), {});
  return { leads, total, conteo };
}
function actualizarLead(db, id, datos, usuario) {
  if (!puedeLeads(usuario)) throw err.prohibido('No tienes permiso para editar clientes potenciales');
  const actual = db.prepare('SELECT * FROM marketing_leads WHERE id = ?').get(id);
  if (!actual) throw err.noEncontrado('Cliente potencial no existe');
  const d = sanearLead(db, datos || {}, actual);
  const campos = Object.keys(d);
  if (campos.length) db.prepare(`UPDATE marketing_leads SET ${campos.map((k) => `${k} = ?`).join(', ')}, actualizado_en = ? WHERE id = ?`).run(...campos.map((k) => d[k]), ahora(), id);
  auditoria.registrar(db, usuario, 'editar_lead', 'lead', id, { antes: actual, despues: d });
  return obtenerLead(db, id);
}
function cambiarEstadoLead(db, id, estado, usuario, nota) {
  if (!puedeLeads(usuario)) throw err.prohibido('No tienes permiso para atender clientes potenciales');
  const l = db.prepare('SELECT * FROM marketing_leads WHERE id = ?').get(id);
  if (!l) throw err.noEncontrado('Cliente potencial no existe');
  const nuevo = opcion(estado, 'Estado', ESTADOS_LEAD);
  if (nuevo === 'convertido' && !l.cliente_id) throw err.conflicto('Para marcarlo como convertido usa "Convertir en cliente" o vincúlalo a un cliente existente');
  const n = texto(nota, 'Nota', { opcional: true, max: 500 });
  db.prepare('UPDATE marketing_leads SET estado = ?, notas = CASE WHEN ? IS NULL THEN notas ELSE TRIM(COALESCE(notas, \'\') || char(10) || ?) END, actualizado_en = ? WHERE id = ?').run(nuevo, n, n ? `${ahora().slice(0, 16)} · ${usuario.nombre}: ${n}` : null, ahora(), id);
  auditoria.registrar(db, usuario, 'estado_lead', 'lead', id, { antes: l.estado, despues: nuevo, nota: n });
  return obtenerLead(db, id);
}
// Marca el origen del cliente si aún no lo tiene (nunca pisa un origen ya registrado).
function fijarOrigenCliente(db, clienteId, { canal, campana_id, lead_id }) {
  db.prepare('UPDATE clientes SET origen_canal = COALESCE(origen_canal, ?), origen_campana_id = COALESCE(origen_campana_id, ?), origen_lead_id = COALESCE(origen_lead_id, ?) WHERE id = ?').run(canal || null, campana_id || null, lead_id || null, clienteId);
}
function convertirLead(db, id, datos, usuario) {
  if (!puedeLeads(usuario)) throw err.prohibido('No tienes permiso para convertir clientes potenciales');
  const l = db.prepare('SELECT * FROM marketing_leads WHERE id = ?').get(id);
  if (!l) throw err.noEncontrado('Cliente potencial no existe');
  if (l.cliente_id) throw err.conflicto('Este cliente potencial ya está vinculado a un cliente');
  const nombre = texto((datos && datos.nombre) || l.nombre, 'Nombre del cliente', { max: 160 });
  const telefono = texto((datos && datos.telefono) ?? l.telefono, 'Teléfono', { opcional: true, max: 40 });
  const email = texto((datos && datos.email) ?? l.email, 'Correo', { opcional: true, max: 120 });
  const identificacion = texto(datos && datos.identificacion, 'Identificación', { opcional: true, max: 40 });
  const direccion = texto(datos && datos.direccion, 'Dirección', { opcional: true, max: 200 });
  return transaccion(db, () => {
    const r = db.prepare('INSERT INTO clientes(nombre, telefono, identificacion, email, direccion, notas, origen_canal, origen_campana_id, origen_lead_id) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(nombre, telefono, identificacion, email, direccion, l.mensaje ? `Llegó por marketing: ${l.mensaje}`.slice(0, 1000) : null, l.canal, l.campana_id, l.id);
    const clienteId = Number(r.lastInsertRowid);
    db.prepare("UPDATE marketing_leads SET estado = 'convertido', cliente_id = ?, actualizado_en = ? WHERE id = ?").run(clienteId, ahora(), id);
    auditoria.registrar(db, usuario, 'crear_cliente', 'cliente', clienteId, { nombre, origen: 'lead', lead_id: id, canal: l.canal, campana_id: l.campana_id });
    auditoria.registrar(db, usuario, 'convertir_lead', 'lead', id, { cliente_id: clienteId });
    return { lead: obtenerLead(db, id), cliente: db.prepare('SELECT * FROM clientes WHERE id = ?').get(clienteId) };
  });
}
// Un lead ya convertido (con cliente_id) no se vincula a otro cliente: 409. Con `forzar` y permiso marketing.editar se re-vincula,
// el cliente anterior pierde este lead como origen (y la campaña/canal que venían de él) y queda auditado como 'revincular_lead'.
function vincularLead(db, id, clienteId, usuario, { forzar = false, motivo } = {}) {
  if (!puedeLeads(usuario)) throw err.prohibido('No tienes permiso para vincular clientes potenciales');
  const l = db.prepare('SELECT * FROM marketing_leads WHERE id = ?').get(id);
  if (!l) throw err.noEncontrado('Cliente potencial no existe');
  const cid = entero(clienteId, 'Cliente');
  const c = db.prepare('SELECT * FROM clientes WHERE id = ?').get(cid);
  if (!c) throw err.noEncontrado('Cliente no existe');
  if (l.cliente_id === cid) return { lead: obtenerLead(db, id), cliente: c }; // ya está vinculado a ese cliente
  const reVincular = !!l.cliente_id;
  if (reVincular) {
    if (!forzar) throw err.conflicto('Este cliente potencial ya está vinculado a otro cliente. Para cambiarlo envía forzar: true (requiere permiso para editar marketing).');
    if (!tiene(usuario, 'marketing.editar')) throw err.prohibido('Solo quien edita marketing puede re-vincular un cliente potencial ya convertido');
  }
  const mot = texto(motivo, 'Motivo', { opcional: true, max: 300 });
  return transaccion(db, () => {
    if (reVincular) {
      db.prepare(`UPDATE clientes SET origen_lead_id = NULL, origen_campana_id = CASE WHEN origen_campana_id IS ? THEN NULL ELSE origen_campana_id END,
          origen_canal = CASE WHEN origen_canal IS ? THEN NULL ELSE origen_canal END WHERE id = ? AND origen_lead_id = ?`).run(l.campana_id, l.canal, l.cliente_id, l.id);
    }
    db.prepare(`UPDATE marketing_leads SET estado = 'convertido', cliente_id = ?, venta_id = CASE WHEN ? THEN NULL ELSE venta_id END, actualizado_en = ? WHERE id = ?`).run(cid, reVincular ? 1 : 0, ahora(), id);
    fijarOrigenCliente(db, cid, { canal: l.canal, campana_id: l.campana_id, lead_id: l.id });
    auditoria.registrar(db, usuario, reVincular ? 'revincular_lead' : 'vincular_lead', 'lead', id, { cliente_id: cid, cliente: c.nombre, cliente_anterior_id: l.cliente_id || null, forzado: reVincular, motivo: mot });
    return { lead: obtenerLead(db, id), cliente: db.prepare('SELECT * FROM clientes WHERE id = ?').get(cid) };
  });
}
// Al anular una venta (ventas.anular la llama dentro de su transacción): los leads que la tenían como evidencia pierden venta_id;
// si la conversión venía SOLO de la ventana de atribución (regla 4, estimada) el lead vuelve a 'interesado' (sigue vinculado al
// cliente, pero deja de contar como convertido). Un lead convertido a mano o por lead_vinculado conserva su estado.
function desvincularVentaAnulada(db, ventaId) {
  const r = db.prepare(`UPDATE marketing_leads SET venta_id = NULL,
      estado = CASE WHEN estado = 'convertido' AND EXISTS (SELECT 1 FROM marketing_atribuciones a WHERE a.venta_id = ? AND a.lead_id = marketing_leads.id AND a.regla = 'ventana_lead') THEN 'interesado' ELSE estado END,
      actualizado_en = ? WHERE venta_id = ?`).run(ventaId, ahora(), ventaId);
  return Number(r.changes);
}
function resumenLeads(db, filtros = {}) {
  const r = periodoDe(filtros);
  const porEstado = Object.fromEntries(ESTADOS_LEAD.map((e) => [e, 0]));
  for (const f of db.prepare('SELECT estado, COUNT(*) n FROM marketing_leads WHERE fecha BETWEEN ? AND ? GROUP BY estado').all(d0(r.desde), d1(r.hasta))) porEstado[f.estado] = f.n;
  const porCanal = db.prepare('SELECT canal, COUNT(*) n, SUM(estado = \'convertido\') convertidos FROM marketing_leads WHERE fecha BETWEEN ? AND ? GROUP BY canal ORDER BY n DESC').all(d0(r.desde), d1(r.hasta));
  const porCampana = db.prepare('SELECT l.campana_id, c.nombre campana, COUNT(*) n, SUM(l.estado = \'convertido\') convertidos FROM marketing_leads l LEFT JOIN campanas c ON c.id = l.campana_id WHERE l.fecha BETWEEN ? AND ? GROUP BY l.campana_id ORDER BY n DESC').all(d0(r.desde), d1(r.hasta));
  const total = Object.values(porEstado).reduce((s, n) => s + n, 0);
  const ultimos = listarLeads(db, { desde: r.desde, hasta: r.hasta, limite: 10 }).leads;
  const sinAtender = db.prepare("SELECT COUNT(*) n FROM marketing_leads WHERE estado = 'nuevo'").get().n;
  return { periodo: r, total, por_estado: porEstado, por_canal: porCanal, por_campana: porCampana, convertidos: porEstado.convertido, tasa_conversion: division(porEstado.convertido * 100, total, 1), sin_atender_total: sinAtender, ultimos };
}

// ============================================================================================
// Seguimiento web: eventos públicos con token, límite por IP y script incrustable
// ============================================================================================
const limites = new Map(); // ip → { n, hasta }: eventos de cualquier tipo
const limitesLeads = new Map(); // ip → { n, hasta }: clientes potenciales NUEVOS creados desde el formulario web
const LIMITE_POR_MINUTO = 120;
const LIMITE_LEADS_POR_MINUTO = 5;
const HORAS_DEDUP_LEAD = 24;
const LIMITE_CUERPO_BYTES = 20 * 1024; // mismo tope que los parsers del router público
function permite(mapa, ip, tope) {
  const ahoraMs = Date.now();
  const k = ip || 'desconocida';
  const e = mapa.get(k);
  if (!e || e.hasta < ahoraMs) { mapa.set(k, { n: 1, hasta: ahoraMs + 60000 }); if (mapa.size > 5000) for (const [kk, v] of mapa) if (v.hasta < ahoraMs) mapa.delete(kk); return true; }
  e.n += 1;
  return e.n <= tope;
}
const permiteIp = (ip) => permite(limites, ip, LIMITE_POR_MINUTO);
const permiteLead = (ip) => permite(limitesLeads, ip, LIMITE_LEADS_POR_MINUTO);
const errLimite = (m) => { const e = err.datos(m); e.status = 429; e.codigo = 'limite'; return e; };
function reiniciarLimites() { limites.clear(); limitesLeads.clear(); }
function tokenValido(db, token) {
  const esperado = String(configMarketing(db).token_seguimiento || '');
  const recibido = String(token || '');
  if (!esperado || esperado.length < 16 || !recibido) return false;
  const a = Buffer.from(recibido); const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Entrada pública: los campos largos se RECORTAN (nunca se descarta un evento ni un lead por longitud).
const recortar = (v, max) => { if (v === undefined || v === null) return null; const s = String(v).trim().slice(0, max).trim(); return s || null; };
const campo = (obj, claves, max) => { for (const k of claves) { const v = obj && obj[k]; if (v !== undefined && v !== null && String(v).trim() !== '') return recortar(v, max); } return null; };

// Lead abierto (nuevo/contactado/interesado) de las últimas 24 h con el mismo teléfono (últimos 10 dígitos) o el mismo correo.
function leadAbiertoRepetido(db, { telefono, email }) {
  const clave = telClave(telefono); const correo = String(email || '').trim().toLowerCase();
  if (!clave && !correo) return null;
  const desde = ahora(new Date(Date.now() - HORAS_DEDUP_LEAD * 3600000));
  const candidatos = db.prepare("SELECT id, telefono, email FROM marketing_leads WHERE estado IN ('nuevo','contactado','interesado') AND fecha >= ? AND (telefono IS NOT NULL OR email IS NOT NULL) ORDER BY id DESC").all(desde);
  return candidatos.find((l) => (clave && telClave(l.telefono) === clave) || (correo && String(l.email || '').trim().toLowerCase() === correo)) || null;
}
// El formulario repetido completa los datos que faltaban, acumula el mensaje (tope 2000) y deja una nota (una por día).
function actualizarLeadRepetido(db, leadId, d) {
  const nota = `${ahora().slice(0, 16)} · Volvió a enviar el formulario web`;
  db.prepare(`UPDATE marketing_leads SET nombre = COALESCE(nombre, ?), telefono = COALESCE(telefono, ?), email = COALESCE(email, ?),
      mensaje = CASE WHEN ? IS NULL THEN mensaje WHEN mensaje IS NULL OR mensaje = '' THEN ? WHEN mensaje = ? THEN mensaje ELSE substr(mensaje || char(10) || ?, 1, 2000) END,
      producto_id = COALESCE(producto_id, ?), producto_texto = COALESCE(producto_texto, ?), campana_id = COALESCE(campana_id, ?),
      utm_source = COALESCE(utm_source, ?), utm_medium = COALESCE(utm_medium, ?), utm_campaign = COALESCE(utm_campaign, ?), visitante = COALESCE(visitante, ?),
      notas = CASE WHEN COALESCE(notas, '') LIKE ? THEN notas ELSE substr(TRIM(COALESCE(notas, '') || char(10) || ?), 1, 2000) END, actualizado_en = ? WHERE id = ?`)
    .run(d.nombre, d.telefono, d.email, d.mensaje, d.mensaje, d.mensaje, d.mensaje, d.producto_id, d.producto_texto, d.campana_id, d.utm_source, d.utm_medium, d.utm_campaign, d.visitante, `%${hoy()}%Volvió a enviar el formulario web%`, nota, ahora(), leadId);
}

// Registra un evento enviado por el script de la página web. Nunca devuelve datos del negocio.
// Orden de las defensas: tamaño → límite por IP (cuenta también los intentos con token inválido) → token → tipo.
function registrarEventoPublico(db, cuerpo, { ip, userAgent } = {}) {
  let b = cuerpo;
  if (typeof b === 'string') {
    if (Buffer.byteLength(b) > LIMITE_CUERPO_BYTES) { const e = err.datos('El evento es demasiado grande'); e.status = 413; e.codigo = 'muy_grande'; throw e; }
    try { b = JSON.parse(b); } catch { throw err.datos('Cuerpo inválido'); }
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw err.datos('Cuerpo inválido');
  if (!permiteIp(ip)) throw errLimite('Demasiados eventos desde esta dirección; espera un minuto');
  if (!tokenValido(db, b.token)) throw err.noAuth('Token de seguimiento inválido');
  const tipo = opcion(b.tipo, 'Tipo de evento', TIPOS_EVENTO_PUBLICO);
  const t = (k, max) => recortar(b[k], max);
  const visitante = t('visitante', 80);
  const utm = { utm_source: t('utm_source', 120), utm_medium: t('utm_medium', 120), utm_campaign: t('utm_campaign', 120), utm_content: t('utm_content', 120), utm_term: t('utm_term', 120) };
  const pagina = t('pagina', 500); const referente = t('referente', 500); const productoTexto = t('producto_texto', 200);
  const datos = b.datos && typeof b.datos === 'object' && !Array.isArray(b.datos) ? b.datos : null;
  let datosJson = null;
  if (datos) { datosJson = JSON.stringify(datos); if (datosJson.length > 4000) datosJson = JSON.stringify({ truncado: true, claves: Object.keys(datos).slice(0, 30) }); }
  const campanaId = campanaPorUtm(db, utm.utm_campaign);
  const productoId = productoPorTexto(db, productoTexto, datos && datos.producto_id);
  const ipHash = ip ? crypto.createHash('sha256').update(`${ip}:${configMarketing(db).token_seguimiento}`).digest('hex') : null;
  // Formulario → cliente potencial (canal 'web' aunque no esté en la configuración). Si en las últimas 24 h ya hay un lead
  // abierto con el mismo teléfono o correo, se actualiza ese en vez de crear otro; los leads nuevos tienen su propio tope por IP.
  let leadDatos = null; let leadRepetido = null;
  if (tipo === 'formulario') {
    const nombre = campo(datos, ['nombre', 'name', 'nombres', 'full_name'], 160);
    const telefono = campo(datos, ['telefono', 'teléfono', 'phone', 'tel', 'whatsapp', 'celular'], 40);
    const email = campo(datos, ['email', 'correo', 'mail'], 160);
    const mensaje = campo(datos, ['mensaje', 'message', 'comentario', 'comentarios', 'consulta'], 2000);
    if (nombre || telefono || email || mensaje) {
      leadDatos = { nombre, telefono, email, mensaje, canal: 'web', campana_id: campanaId, utm_source: utm.utm_source, utm_medium: utm.utm_medium, utm_campaign: utm.utm_campaign, visitante, producto_id: productoId, producto_texto: productoTexto };
      leadRepetido = leadAbiertoRepetido(db, { telefono, email });
      if (!leadRepetido && !permiteLead(ip)) throw errLimite('Demasiados formularios desde esta dirección; espera un minuto');
    }
  }
  return transaccion(db, () => {
    let leadId = null;
    if (leadDatos && leadRepetido) { actualizarLeadRepetido(db, leadRepetido.id, leadDatos); leadId = leadRepetido.id; }
    else if (leadDatos) {
      // El lead nunca tumba el registro del evento: si algo falla queda en consola y el evento se guarda sin lead.
      try { leadId = crearLead(db, leadDatos, null, { auditar: false, canalesExtra: ['web'] }).id; }
      catch (e) { console.error('[marketing] cliente potencial del formulario web no creado:', e.message); }
    }
    const r = db.prepare(`INSERT INTO marketing_eventos(tipo, visitante, utm_source, utm_medium, utm_campaign, utm_content, utm_term, campana_id, producto_id, producto_texto, pagina, referente, ip_hash, user_agent, datos, lead_id)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(tipo, visitante, utm.utm_source, utm.utm_medium, utm.utm_campaign, utm.utm_content, utm.utm_term, campanaId, productoId, productoTexto, pagina, referente, ipHash, userAgent ? String(userAgent).slice(0, 300) : null, datosJson, leadId);
    return { ok: true, id: Number(r.lastInsertRowid), lead: !!leadId };
  });
}
function listarEventos(db, { tipo, campana_id, visitante, desde, hasta, limite = 200 } = {}) {
  const cond = []; const params = [];
  if (tipo) { cond.push('e.tipo = ?'); params.push(opcion(tipo, 'Tipo', TIPOS_EVENTO)); }
  if (campana_id) { cond.push('e.campana_id = ?'); params.push(Number(campana_id)); }
  if (visitante) { cond.push('e.visitante = ?'); params.push(visitante); }
  if (desde) { cond.push('e.fecha >= ?'); params.push(d0(desde)); }
  if (hasta) { cond.push('e.fecha <= ?'); params.push(d1(hasta)); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const eventos = db.prepare(`SELECT e.id, e.fecha, e.tipo, e.visitante, e.utm_source, e.utm_medium, e.utm_campaign, e.utm_content, e.campana_id, c.nombre campana_nombre, e.producto_id, p.nombre producto_nombre, e.producto_texto, e.pagina, e.referente, e.lead_id
      FROM marketing_eventos e LEFT JOIN campanas c ON c.id = e.campana_id LEFT JOIN productos p ON p.id = e.producto_id ${where} ORDER BY e.id DESC LIMIT ?`).all(...params, Math.min(Number(limite) || 200, 1000));
  const total = db.prepare(`SELECT COUNT(*) n FROM marketing_eventos e ${where}`).get(...params).n;
  const porTipo = db.prepare(`SELECT e.tipo, COUNT(*) n FROM marketing_eventos e ${where} GROUP BY e.tipo`).all(...params).reduce((o, f) => ({ ...o, [f.tipo]: f.n }), {});
  return { eventos, total, por_tipo: porTipo };
}
let scriptCache = null;
function scriptSeguimiento(db, base) {
  const cfg = configMarketing(db);
  if (!cfg.token_seguimiento) return '/* Licores Palmira: el seguimiento web no está configurado. Genera el token en Marketing › Integraciones. */\n';
  if (!scriptCache) scriptCache = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'palmira-seguimiento.js'), 'utf8');
  return `window.PALMIRA_SEGUIMIENTO = ${JSON.stringify({ token: cfg.token_seguimiento, endpoint: `${base}/api/publico/marketing/eventos` })};\n${scriptCache}`;
}
function seguimiento(db, base, usuario) {
  const cfg = configMarketing(db);
  const token = cfg.token_seguimiento || '';
  const h = hoy(); const hace7 = sumarDias(h, -6);
  const total = db.prepare('SELECT COUNT(*) n, MAX(fecha) ultimo FROM marketing_eventos').get();
  const semana = db.prepare('SELECT COUNT(*) n, COUNT(DISTINCT visitante) visitantes FROM marketing_eventos WHERE fecha BETWEEN ? AND ?').get(d0(hace7), d1(h));
  const porTipo = db.prepare('SELECT tipo, COUNT(*) n FROM marketing_eventos WHERE fecha BETWEEN ? AND ? GROUP BY tipo').all(d0(hace7), d1(h)).reduce((o, f) => ({ ...o, [f.tipo]: f.n }), {});
  const verToken = tiene(usuario, 'marketing.configurar');
  const urlScript = `${base}/api/publico/marketing/seguimiento.js`;
  const urlEventos = `${base}/api/publico/marketing/eventos`;
  return {
    activo: !!token,
    token: verToken ? token : (token ? '••••••••' + token.slice(-4) : ''),
    url_script: urlScript, url_eventos: urlEventos,
    fragmento: token ? `<script src="${urlScript}" async></script>` : null,
    fragmento_alterno: token && verToken ? `<script src="${base}/marketing/palmira-seguimiento.js" data-token="${token}" data-endpoint="${urlEventos}" async></script>` : null,
    ejemplos: {
      producto: '<script>window.PALMIRA_PRODUCTO = "Old Parr 12 Años 1000 ml";</script>  (o en cualquier etiqueta: data-palmira-producto="Old Parr 12 Años 1000 ml")',
      contacto: '<a href="https://wa.me/573218677680" data-palmira-contacto>Escríbenos por WhatsApp</a>  (los enlaces wa.me, tel: y mailto: se detectan solos)',
      formulario: '<form data-palmira-formulario><input name="nombre"><input name="telefono"><input name="email"><textarea name="mensaje"></textarea><button>Enviar</button></form>',
      enlace: 'Enlaces con UTM: https://tu-pagina.com/?utm_source=meta&utm_medium=cpc&utm_campaign=<utm_campaign de la campaña>',
    },
    instrucciones: [
      'Pega el fragmento antes de </body> en todas las páginas de tu sitio (o en la plantilla general).',
      'El script guarda un identificador anónimo del visitante en su navegador, lee los parámetros utm_* de la dirección y los conserva 30 días.',
      'Envía automáticamente: "visita" al cargar, "producto" si la página define window.PALMIRA_PRODUCTO o data-palmira-producto, "clic_contacto" al tocar enlaces de WhatsApp, teléfono o correo, y "formulario" al enviar formularios con data-palmira-formulario (crea un cliente potencial con el nombre, teléfono y correo).',
      'Comparte los enlaces de tus anuncios con los parámetros UTM que genera cada campaña: así las visitas, consultas y ventas se asocian a esa campaña.',
      'Si el token se filtra, rótalo: el anterior deja de funcionar al instante y debes actualizar el fragmento en la página.',
      `Protección contra abuso: máximo ${LIMITE_POR_MINUTO} eventos y ${LIMITE_LEADS_POR_MINUTO} clientes potenciales nuevos por minuto desde una misma dirección; un formulario repetido (mismo teléfono o correo en ${HORAS_DEDUP_LEAD} h) actualiza el cliente potencial abierto en vez de duplicarlo.`,
    ],
    estadisticas: { eventos_total: total.n, ultimo_evento: total.ultimo, eventos_7d: semana.n, visitantes_7d: semana.visitantes, por_tipo_7d: porTipo, limite_por_minuto: LIMITE_POR_MINUTO, limite_leads_por_minuto: LIMITE_LEADS_POR_MINUTO, horas_deduplicacion_leads: HORAS_DEDUP_LEAD },
  };
}
function rotarToken(db, usuario) {
  if (!tiene(usuario, 'marketing.configurar')) throw err.prohibido('No tienes permiso para configurar el seguimiento web');
  const cfg = configMarketing(db);
  const nuevo = crypto.randomBytes(24).toString('hex');
  setConfig(db, 'marketing', { ...cfg, token_seguimiento: nuevo });
  auditoria.registrar(db, usuario, cfg.token_seguimiento ? 'rotar_token_seguimiento' : 'crear_token_seguimiento', 'configuracion', 'marketing', { antes_terminaba_en: cfg.token_seguimiento ? cfg.token_seguimiento.slice(-4) : null });
  return { ok: true, token: nuevo };
}

// ============================================================================================
// Atribución de ventas
// ============================================================================================
function atribucionDe(db, ventaId) {
  const a = db.prepare('SELECT a.*, c.nombre campana_nombre, c.plataforma campana_plataforma, l.nombre lead_nombre, l.telefono lead_telefono, u.nombre usuario_nombre FROM marketing_atribuciones a LEFT JOIN campanas c ON c.id = a.campana_id LEFT JOIN marketing_leads l ON l.id = a.lead_id LEFT JOIN usuarios u ON u.id = a.usuario_id WHERE a.venta_id = ?').get(ventaId);
  if (!a) return null;
  return { ...a, regla_texto: REGLAS[a.regla] || a.regla };
}
function guardarAtribucion(db, ventaId, { campana_id = null, lead_id = null, tipo, regla, canal = null }, usuario) {
  db.prepare(`INSERT INTO marketing_atribuciones(venta_id, campana_id, lead_id, tipo, regla, canal, usuario_id, creado_en) VALUES (?,?,?,?,?,?,?,?)
              ON CONFLICT(venta_id) DO UPDATE SET campana_id = excluded.campana_id, lead_id = excluded.lead_id, tipo = excluded.tipo, regla = excluded.regla, canal = excluded.canal, usuario_id = excluded.usuario_id, creado_en = excluded.creado_en`)
    .run(ventaId, campana_id, lead_id, tipo, regla, canal, usuario ? usuario.id : null, ahora());
}
// Decide y guarda la atribución de una venta según las reglas documentadas (en orden). Idempotente: se puede volver a llamar.
function atribuirVenta(db, ventaId, usuario) {
  const v = db.prepare('SELECT id, fecha, cliente_id, campana_id, canal_origen FROM ventas WHERE id = ?').get(ventaId);
  if (!v) throw err.noEncontrado('Venta no existe');
  const cliente = v.cliente_id ? db.prepare('SELECT id, telefono, origen_canal, origen_campana_id, origen_lead_id FROM clientes WHERE id = ?').get(v.cliente_id) : null;
  const existeCampana = (id) => !!(id && db.prepare('SELECT id FROM campanas WHERE id = ?').get(id));
  const canalBase = v.canal_origen || (cliente && cliente.origen_canal) || null;
  let res = null;
  // 1) Campaña elegida al vender
  if (existeCampana(v.campana_id)) res = { campana_id: v.campana_id, tipo: 'confirmada', regla: 'campana_en_venta', canal: canalBase };
  // 2) Cliente creado desde un lead con campaña
  if (!res && cliente && cliente.origen_lead_id) {
    const lead = db.prepare('SELECT * FROM marketing_leads WHERE id = ?').get(cliente.origen_lead_id);
    if (lead && existeCampana(lead.campana_id)) {
      res = { campana_id: lead.campana_id, lead_id: lead.id, tipo: 'confirmada', regla: 'lead_vinculado', canal: v.canal_origen || lead.canal || canalBase };
      db.prepare("UPDATE marketing_leads SET estado = 'convertido', cliente_id = COALESCE(cliente_id, ?), venta_id = COALESCE(venta_id, ?), actualizado_en = ? WHERE id = ?").run(cliente.id, ventaId, ahora(), lead.id);
    }
  }
  // 3) Campaña de origen registrada en el cliente
  if (!res && cliente && existeCampana(cliente.origen_campana_id)) res = { campana_id: cliente.origen_campana_id, tipo: 'confirmada', regla: 'cliente_origen', canal: canalBase };
  // 4) Lead no convertido con el mismo teléfono dentro de la ventana de atribución → estimada
  if (!res && cliente && telClave(cliente.telefono)) {
    const ventana = Number(configMarketing(db).ventana_atribucion_dias) || 30;
    const clave = telClave(cliente.telefono);
    const candidatos = db.prepare("SELECT * FROM marketing_leads WHERE campana_id IS NOT NULL AND estado <> 'convertido' AND venta_id IS NULL AND telefono IS NOT NULL AND fecha BETWEEN ? AND ? ORDER BY fecha DESC").all(d0(sumarDias(v.fecha, -ventana)), v.fecha);
    const lead = candidatos.find((l) => telClave(l.telefono) === clave && existeCampana(l.campana_id));
    if (lead) {
      res = { campana_id: lead.campana_id, lead_id: lead.id, tipo: 'estimada', regla: 'ventana_lead', canal: v.canal_origen || lead.canal || canalBase };
      db.prepare("UPDATE marketing_leads SET estado = 'convertido', cliente_id = ?, venta_id = ?, actualizado_en = ? WHERE id = ?").run(cliente.id, ventaId, ahora(), lead.id);
      fijarOrigenCliente(db, cliente.id, { canal: lead.canal, campana_id: lead.campana_id, lead_id: lead.id });
    }
  }
  // 5) Solo canal · 6) Sin datos
  if (!res) res = canalBase ? { tipo: 'desconocida', regla: 'solo_canal', canal: canalBase } : { tipo: 'desconocida', regla: 'sin_datos', canal: null };
  guardarAtribucion(db, ventaId, res, usuario);
  return atribucionDe(db, ventaId);
}
function cambiarAtribucion(db, ventaId, datos, usuario) {
  if (!tiene(usuario, 'marketing.editar')) throw err.prohibido('No tienes permiso para cambiar la atribución de una venta');
  const v = db.prepare('SELECT id, numero, estado, campana_id, canal_origen FROM ventas WHERE id = ?').get(ventaId);
  if (!v) throw err.noEncontrado('Venta no existe');
  const cfg = configMarketing(db);
  const campanaId = datos.campana_id === null || datos.campana_id === '' || datos.campana_id === undefined ? null : entero(datos.campana_id, 'Campaña');
  if (campanaId && !db.prepare('SELECT id FROM campanas WHERE id = ?').get(campanaId)) throw err.noEncontrado('La campaña no existe');
  const canal = opcion(datos.canal, 'Canal', cfg.canales, { opcional: true, defecto: v.canal_origen || null });
  const motivo = texto(datos.motivo, 'Motivo', { opcional: true, max: 300 });
  const antes = atribucionDe(db, ventaId);
  return transaccion(db, () => {
    db.prepare('UPDATE ventas SET campana_id = ?, canal_origen = ? WHERE id = ?').run(campanaId, canal, ventaId);
    if (campanaId) guardarAtribucion(db, ventaId, { campana_id: campanaId, tipo: 'confirmada', regla: 'manual', canal }, usuario);
    else guardarAtribucion(db, ventaId, { tipo: 'desconocida', regla: 'manual', canal }, usuario);
    const despues = atribucionDe(db, ventaId);
    auditoria.registrar(db, usuario, 'cambiar_atribucion_venta', 'venta', ventaId, { numero: v.numero, antes: antes ? { campana_id: antes.campana_id, tipo: antes.tipo, regla: antes.regla } : null, despues: { campana_id: despues.campana_id, tipo: despues.tipo, regla: despues.regla, canal }, motivo });
    return despues;
  });
}

// ============================================================================================
// Panel, embudo y rentabilidad
// ============================================================================================
function conteoEventos(db, r) {
  const hay = !!db.prepare('SELECT 1 FROM marketing_eventos LIMIT 1').get();
  const porTipo = {}; const visitantes = {};
  for (const f of db.prepare('SELECT tipo, COUNT(*) n, COUNT(DISTINCT visitante) visitantes FROM marketing_eventos WHERE fecha BETWEEN ? AND ? GROUP BY tipo').all(d0(r.desde), d1(r.hasta))) { porTipo[f.tipo] = f.n; visitantes[f.tipo] = f.visitantes; }
  const n = (t) => (hay ? (porTipo[t] || 0) : null);
  return { hay, por_tipo: porTipo, visitas: n('visita'), visitantes: hay ? (visitantes.visita || 0) : null, producto: n('producto'), contacto: hay ? (porTipo.clic_contacto || 0) + (porTipo.formulario || 0) + (porTipo.conversacion || 0) : null };
}
function productosInteres(db, r, limite = 8) {
  const m = new Map();
  const suma = (clave, nombre, productoId, n) => { if (!m.has(clave)) m.set(clave, { producto_id: productoId, nombre, interacciones: 0, eventos: 0, leads: 0 }); const x = m.get(clave); x.interacciones += n; return x; };
  for (const f of db.prepare("SELECT e.producto_id, COALESCE(p.nombre, e.producto_texto) nombre, COUNT(*) n FROM marketing_eventos e LEFT JOIN productos p ON p.id = e.producto_id WHERE e.tipo = 'producto' AND e.fecha BETWEEN ? AND ? AND (e.producto_id IS NOT NULL OR e.producto_texto IS NOT NULL) GROUP BY COALESCE(e.producto_id, lower(e.producto_texto))").all(d0(r.desde), d1(r.hasta))) suma(f.producto_id ? 'p' + f.producto_id : 't' + String(f.nombre).toLowerCase(), f.nombre, f.producto_id, f.n).eventos += f.n;
  for (const f of db.prepare('SELECT l.producto_id, COALESCE(p.nombre, l.producto_texto) nombre, COUNT(*) n FROM marketing_leads l LEFT JOIN productos p ON p.id = l.producto_id WHERE l.fecha BETWEEN ? AND ? AND (l.producto_id IS NOT NULL OR l.producto_texto IS NOT NULL) GROUP BY COALESCE(l.producto_id, lower(l.producto_texto))').all(d0(r.desde), d1(r.hasta))) suma(f.producto_id ? 'p' + f.producto_id : 't' + String(f.nombre).toLowerCase(), f.nombre, f.producto_id, f.n).leads += f.n;
  return [...m.values()].sort((a, b) => b.interacciones - a.interacciones).slice(0, limite);
}
function panel(db, filtros = {}) {
  const r = periodoDe(filtros);
  const g = granularidad(r);
  const met = metricasPorCampana(db, r);
  let inversion = 0; const sumas = { impresiones: null, alcance: null, clics: null, conversaciones: null, resultados: null };
  for (const m of met.values()) { inversion += m.inversion || 0; for (const k of Object.keys(sumas)) if (m[k] !== null && m[k] !== undefined) sumas[k] = (sumas[k] || 0) + m[k]; }
  const camp = db.prepare("SELECT COALESCE(SUM(estado = 'activa'),0) activas, COALESCE(SUM(estado = 'pausada'),0) pausadas, COALESCE(SUM(estado = 'finalizada'),0) finalizadas, COALESCE(SUM(estado = 'borrador'),0) borradores, COUNT(*) total FROM campanas").get();
  const ev = conteoEventos(db, r);
  const consultas = ev.contacto === null && sumas.conversaciones === null ? null : (ev.contacto || 0) + (sumas.conversaciones || 0);
  const leadsR = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(estado = 'convertido'),0) convertidos, COALESCE(SUM(estado = 'nuevo'),0) nuevos FROM marketing_leads WHERE fecha BETWEEN ? AND ?").get(d0(r.desde), d1(r.hasta));
  const ventas = ventasAtribuidas(db, r);
  const conf = ventas.filter((v) => v.tipo === 'confirmada'); const est = ventas.filter((v) => v.tipo === 'estimada');
  const ingresos = { confirmados: conf.reduce((s, v) => s + v.ingreso_neto, 0), estimados: est.reduce((s, v) => s + v.ingreso_neto, 0) };
  ingresos.total = ingresos.confirmados + ingresos.estimados;
  const clientesCompraron = new Set(ventas.map((v) => (v.cliente_id ? 'c' + v.cliente_id : 'v' + v.id))).size;
  const ventasTotales = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total),0) total FROM ventas WHERE estado <> 'anulada' AND fecha BETWEEN ? AND ?").get(d0(r.desde), d1(r.hasta));
  // Por campaña
  const res = resumenCampanas(db, r);
  const nombres = new Map(db.prepare('SELECT id, nombre, plataforma, estado FROM campanas').all().map((c) => [c.id, c]));
  const porCampana = [...res.entries()].map(([id, x]) => ({ id, nombre: (nombres.get(id) || {}).nombre || `Campaña ${id}`, plataforma: (nombres.get(id) || {}).plataforma || null, estado: (nombres.get(id) || {}).estado || null, inversion: x.inversion, impresiones: x.impresiones, alcance: x.alcance, clics: x.clics, leads: x.leads, ventas: x.ventas, ventas_confirmadas: x.ventas_confirmadas, ventas_estimadas: x.ventas_estimadas, clientes: x.clientes, ingresos: x.ingresos, roas: x.roas, cac: x.cac, costo_por_lead: x.costo_por_lead }))
    .sort((a, b) => (b.ingresos - a.ingresos) || (b.leads - a.leads) || (b.inversion - a.inversion));
  // Por canal (leads + ventas atribuidas con canal)
  const canales = new Map();
  const canalDe = (k) => { if (!canales.has(k)) canales.set(k, { canal: k, leads: 0, leads_convertidos: 0, ventas: 0, ingresos: 0 }); return canales.get(k); };
  for (const f of db.prepare("SELECT canal, COUNT(*) n, COALESCE(SUM(estado = 'convertido'),0) conv FROM marketing_leads WHERE fecha BETWEEN ? AND ? GROUP BY canal").all(d0(r.desde), d1(r.hasta))) { const c = canalDe(f.canal || 'otro'); c.leads += f.n; c.leads_convertidos += f.conv; }
  for (const v of ventas) if (v.canal) { const c = canalDe(v.canal); c.ventas += 1; c.ingresos += v.ingreso_neto; }
  const porCanal = [...canales.values()].sort((a, b) => (b.leads + b.ventas) - (a.leads + a.ventas));
  // Series
  const m = serieVacia(r, g);
  const b = (fecha) => { const k = claveBucket(fecha, g); if (!m.has(k)) m.set(k, { clave: k, etiqueta: etiquetaBucket(k, g), inversion: 0, ingresos: 0, leads: 0, ventas: 0, visitas: 0, consultas: 0 }); return m.get(k); };
  for (const [f, gasto] of inversionPorFecha(db, r)) b(f).inversion += gasto;
  for (const v of ventas) { const x = b(v.fecha); x.ingresos += v.ingreso_neto; x.ventas += 1; }
  for (const f of db.prepare('SELECT fecha FROM marketing_leads WHERE fecha BETWEEN ? AND ?').all(d0(r.desde), d1(r.hasta))) b(f.fecha).leads += 1;
  for (const f of db.prepare("SELECT fecha, tipo FROM marketing_eventos WHERE fecha BETWEEN ? AND ? AND tipo IN ('visita','clic_contacto','formulario','conversacion')").all(d0(r.desde), d1(r.hasta))) { const x = b(f.fecha); if (f.tipo === 'visita') x.visitas += 1; else x.consultas += 1; }
  const series = [...m.values()].sort((a, c) => (a.clave < c.clave ? -1 : 1));
  const hayDatos = inversion > 0 || ventas.length > 0 || leadsR.n > 0 || ev.hay || camp.total > 0;
  return {
    periodo: { periodo: r.periodo, desde: r.desde, hasta: r.hasta }, granularidad: g, hay_datos: hayDatos,
    inversion_total: inversion,
    campanas: { activas: camp.activas, pausadas: camp.pausadas, finalizadas: camp.finalizadas, borradores: camp.borradores, total: camp.total, con_inversion: [...met.values()].filter((x) => x.inversion > 0).length },
    impresiones: sumas.impresiones, alcance: sumas.alcance, clics: sumas.clics, resultados_plataforma: sumas.resultados,
    visitas: ev.visitas, visitantes: ev.visitantes, seguimiento_web_activo: ev.hay,
    consultas, consultas_detalle: { web: ev.contacto, plataforma: sumas.conversaciones },
    leads: leadsR.n, leads_convertidos: leadsR.convertidos, leads_nuevos: leadsR.nuevos,
    clientes_compraron: clientesCompraron,
    ventas_atribuidas: { confirmadas: conf.length, estimadas: est.length, total: ventas.length },
    ingresos_atribuidos: ingresos,
    ventas_totales_periodo: { cantidad: ventasTotales.n, total: ventasTotales.total, pct_atribuidas: division(ventas.length * 100, ventasTotales.n, 1) },
    costo_por_lead: inversion > 0 ? division(inversion, leadsR.n) : null,
    cac: inversion > 0 ? division(inversion, clientesCompraron) : null,
    roas: inversion > 0 ? division(ingresos.total, inversion, 2) : null,
    tasa_conversion_visitas_clientes: ev.visitas ? division(clientesCompraron * 100, ev.visitas, 2) : null,
    tasa_conversion_leads: leadsR.n ? division(leadsR.convertidos * 100, leadsR.n, 1) : null,
    productos_interes: productosInteres(db, r),
    por_campana: porCampana,
    por_canal: porCanal,
    series,
  };
}
function embudo(db, filtros = {}) {
  const r = periodoDe(filtros);
  const met = metricasPorCampana(db, r);
  const sumas = { impresiones: null, clics: null, conversaciones: null };
  for (const m of met.values()) for (const k of Object.keys(sumas)) if (m[k] !== null && m[k] !== undefined) sumas[k] = (sumas[k] || 0) + m[k];
  const ev = conteoEventos(db, r);
  const leads = db.prepare('SELECT COUNT(*) n FROM marketing_leads WHERE fecha BETWEEN ? AND ?').get(d0(r.desde), d1(r.hasta)).n;
  const ventas = ventasAtribuidas(db, r);
  const contacto = ev.contacto === null && sumas.conversaciones === null ? null : (ev.contacto || 0) + (sumas.conversaciones || 0);
  const etapas = [
    { clave: 'impresiones', nombre: 'Impresiones', valor: sumas.impresiones, fuente: 'métricas de las campañas (manuales o sincronizadas)' },
    { clave: 'clics', nombre: 'Clics en el anuncio', valor: sumas.clics, fuente: 'métricas de las campañas' },
    { clave: 'visitas', nombre: 'Visitas a la página web', valor: ev.visitas, fuente: 'script de seguimiento web' },
    { clave: 'producto', nombre: 'Producto consultado', valor: ev.producto, fuente: 'páginas de producto con el script' },
    { clave: 'contacto', nombre: 'Contacto (WhatsApp, llamada, formulario)', valor: contacto, fuente: 'clics de contacto y formularios de la web + conversaciones reportadas por la plataforma' },
    { clave: 'leads', nombre: 'Clientes potenciales', valor: leads, fuente: 'clientes potenciales registrados (web, WhatsApp, en el local…)' },
    { clave: 'compra', nombre: 'Compras atribuidas', valor: ventas.length, fuente: 'ventas atribuidas a una campaña (confirmadas y estimadas)' },
  ];
  let previa = null; let primera = null;
  for (const e of etapas) {
    e.sin_dato = e.valor === null || e.valor === undefined;
    e.pct_paso = !e.sin_dato && previa && previa.valor > 0 ? division(e.valor * 100, previa.valor, 1) : null;
    e.pct_total = !e.sin_dato && primera && primera.valor > 0 ? division(e.valor * 100, primera.valor, 2) : null;
    e.desde = previa ? previa.clave : null;
    if (!e.sin_dato) { if (!primera && e.valor > 0) primera = e; if (e.valor > 0 || !previa) previa = e; }
  }
  return { periodo: { periodo: r.periodo, desde: r.desde, hasta: r.hasta }, etapas, ventas: { confirmadas: ventas.filter((v) => v.tipo === 'confirmada').length, estimadas: ventas.filter((v) => v.tipo === 'estimada').length }, nota: 'Cada porcentaje compara la etapa con la anterior que sí tiene dato. Las etapas "sin dato" no tienen fuente conectada (no significa cero).' };
}
function rentabilidad(db, filtros = {}) {
  if (filtros.campana_id && !db.prepare('SELECT id FROM campanas WHERE id = ?').get(Number(filtros.campana_id))) throw err.noEncontrado('Campaña no existe');
  const r = periodoDe(filtros);
  const ids = filtros.campana_id ? [Number(filtros.campana_id)] : null;
  const res = resumenCampanas(db, r, { ids });
  const info = new Map(db.prepare('SELECT id, nombre, plataforma, estado, presupuesto FROM campanas').all().map((c) => [c.id, c]));
  const campanas = [...res.entries()].map(([id, x]) => {
    const c = info.get(id) || {};
    const margen = x.ingresos - x.costo_productos - x.costos_variables;
    return { id, nombre: c.nombre || `Campaña ${id}`, plataforma: c.plataforma || null, estado: c.estado || null, presupuesto: c.presupuesto || 0,
      inversion: x.inversion, ventas: x.ventas, ventas_confirmadas: x.ventas_confirmadas, ventas_estimadas: x.ventas_estimadas, clientes: x.clientes, leads: x.leads,
      ingresos: x.ingresos, ingresos_confirmados: x.ingresos_confirmados, ingresos_estimados: x.ingresos_estimados, costo_productos: x.costo_productos, costos_variables: x.costos_variables,
      margen_contribucion: margen, margen_pct: division(margen * 100, x.ingresos, 1), roas: x.roas, cac: x.cac, costo_por_lead: x.costo_por_lead, utilidad_estimada: margen - x.inversion, rentable: x.inversion > 0 || x.ingresos > 0 ? margen - x.inversion > 0 : null };
  }).filter((c) => c.inversion > 0 || c.ventas > 0 || c.leads > 0 || ids).sort((a, b) => b.utilidad_estimada - a.utilidad_estimada);
  const suma = (k) => campanas.reduce((s, c) => s + (c[k] || 0), 0);
  // Clientes del total = clientes DISTINTOS del periodo (un cliente que compró con dos campañas cuenta una vez, igual que en el
  // panel); la columna `clientes` por campaña no es aditiva.
  const listadas = new Set(campanas.map((c) => c.id));
  const clientesDistintos = new Set(ventasAtribuidas(db, r, { campana_id: ids ? ids[0] : null }).filter((v) => v.campana_id && listadas.has(v.campana_id)).map((v) => (v.cliente_id ? 'c' + v.cliente_id : 'v' + v.id))).size;
  const totales = { inversion: suma('inversion'), ventas: suma('ventas'), clientes: clientesDistintos, leads: suma('leads'), ingresos: suma('ingresos'), ingresos_confirmados: suma('ingresos_confirmados'), ingresos_estimados: suma('ingresos_estimados'), costo_productos: suma('costo_productos'), costos_variables: suma('costos_variables'), margen_contribucion: suma('margen_contribucion') };
  totales.utilidad_estimada = totales.margen_contribucion - totales.inversion;
  totales.roas = division(totales.ingresos, totales.inversion, 2);
  totales.cac = totales.inversion > 0 ? division(totales.inversion, totales.clientes) : null;
  totales.margen_pct = division(totales.margen_contribucion * 100, totales.ingresos, 1);
  return { periodo: { periodo: r.periodo, desde: r.desde, hasta: r.hasta }, campanas, totales,
    nota: 'ROAS = ingresos atribuidos ÷ inversión. Un ROAS mayor que 1 no implica rentabilidad: la utilidad estimada descuenta el costo real de los productos vendidos (por lote), los costos variables de cada venta (gastos de venta, comisión e impuestos) y la inversión publicitaria. Las ventas estimadas se cuentan igual que las confirmadas; las anuladas no cuentan.' };
}

// ============================================================================================
// Integraciones y sincronización programada
// ============================================================================================
const enCurso = new Set();
function integraciones(db) {
  const plataformas = adaptadores.lista().map((p) => {
    const ultima = db.prepare('SELECT * FROM marketing_sincronizaciones WHERE plataforma = ? ORDER BY id DESC LIMIT 1').get(p.clave) || null;
    const ultimaOk = db.prepare("SELECT inicio, fin FROM marketing_sincronizaciones WHERE plataforma = ? AND estado = 'ok' ORDER BY id DESC LIMIT 1").get(p.clave) || null;
    if (ultima && ultima.detalle) { try { ultima.detalle = JSON.parse(ultima.detalle); } catch { /* texto */ } }
    const campanas = db.prepare('SELECT COUNT(*) n FROM campanas WHERE plataforma = ? AND id_externo IS NOT NULL').get(p.clave).n;
    return { clave: p.clave, nombre: p.nombre, configurado: p.configurado(), variables: p.variables, instrucciones: p.instrucciones, ultima, ultima_ok: ultimaOk, en_curso: enCurso.has(p.clave), campanas_sincronizadas: campanas, implementado: p.clave === 'meta' };
  });
  return { plataformas, programada: plataformas.some((p) => p.configurado), frecuencia_horas: FRECUENCIA_SINC_HORAS, historial: db.prepare('SELECT * FROM marketing_sincronizaciones ORDER BY id DESC LIMIT 20').all().map((s) => { try { s.detalle = s.detalle ? JSON.parse(s.detalle) : null; } catch { /* texto */ } return s; }) };
}
async function sincronizar(db, clave, usuario, { desde, hasta } = {}) {
  if (usuario && !tiene(usuario, 'marketing.configurar')) throw err.prohibido('No tienes permiso para sincronizar plataformas publicitarias');
  const p = adaptadores.obtener(clave);
  if (!p) throw err.noEncontrado(`Plataforma desconocida: ${clave}`);
  if (enCurso.has(clave)) throw err.conflicto('Ya hay una sincronización en curso para esa plataforma');
  const h = hoy();
  const rangoS = { desde: desde ? vFecha(desde, 'Desde').slice(0, 10) : sumarDias(h, -29), hasta: hasta ? vFecha(hasta, 'Hasta').slice(0, 10) : h };
  const r = db.prepare('INSERT INTO marketing_sincronizaciones(plataforma, usuario_id) VALUES (?, ?)').run(clave, usuario ? usuario.id : null);
  const id = Number(r.lastInsertRowid);
  enCurso.add(clave);
  let resultado;
  try { resultado = await p.sincronizar(db, rangoS); }
  catch (e) { resultado = { estado: 'error', detalle: { mensaje: e.message }, campanas_actualizadas: 0, metricas_insertadas: 0 }; }
  finally { enCurso.delete(clave); }
  const estado = ['ok', 'error', 'sin_credenciales'].includes(resultado.estado) ? resultado.estado : 'error';
  db.prepare('UPDATE marketing_sincronizaciones SET fin = ?, estado = ?, detalle = ?, campanas_actualizadas = ?, metricas_insertadas = ? WHERE id = ?')
    .run(ahora(), estado, JSON.stringify({ ...(resultado.detalle || {}), rango: rangoS }), resultado.campanas_actualizadas || 0, resultado.metricas_insertadas || 0, id);
  if (usuario) auditoria.registrar(db, usuario, 'sincronizar_marketing', 'marketing_sincronizacion', id, { plataforma: clave, estado, ...rangoS });
  const fila = db.prepare('SELECT * FROM marketing_sincronizaciones WHERE id = ?').get(id);
  try { fila.detalle = JSON.parse(fila.detalle); } catch { /* texto */ }
  return fila;
}
// Al arrancar: si alguna plataforma tiene credenciales, sincroniza a los 30 s y luego cada 6 horas. Si ninguna, no hace nada.
function programar(db) {
  const configuradas = adaptadores.lista().filter((p) => p.configurado());
  if (!configuradas.length) return null;
  const correr = () => { for (const p of configuradas) sincronizar(db, p.clave, null).catch((e) => console.error(`[marketing] sincronización ${p.clave}:`, e.message)); };
  setTimeout(correr, 30000).unref();
  const t = setInterval(correr, FRECUENCIA_SINC_HORAS * 60 * 60 * 1000);
  t.unref();
  return t;
}

// ============================================================================================
// Exportaciones CSV
// ============================================================================================
function csvCampanas(db, filtros) {
  const { campanas } = listarCampanas(db, filtros);
  return csv(campanas, [
    { clave: 'id', titulo: 'Id' }, { clave: 'nombre', titulo: 'Campaña' }, { clave: 'plataforma', titulo: 'Plataforma' }, { clave: 'objetivo', titulo: 'Objetivo' }, { clave: 'estado', titulo: 'Estado' },
    { clave: 'fecha_inicio', titulo: 'Inicio' }, { clave: 'fecha_fin', titulo: 'Fin' }, { clave: 'presupuesto', titulo: 'Presupuesto' }, { clave: 'inversion', titulo: 'Inversión' },
    { clave: 'impresiones', titulo: 'Impresiones' }, { clave: 'alcance', titulo: 'Alcance' }, { clave: 'clics', titulo: 'Clics' }, { clave: 'leads', titulo: 'Clientes potenciales' }, { clave: 'ventas', titulo: 'Ventas atribuidas' },
    { clave: 'ventas_confirmadas', titulo: 'Confirmadas' }, { clave: 'ventas_estimadas', titulo: 'Estimadas' }, { clave: 'ingresos', titulo: 'Ingresos atribuidos' }, { clave: 'roas', titulo: 'ROAS' }, { clave: 'cac', titulo: 'CAC' },
    { clave: 'utm_campaign', titulo: 'utm_campaign' }, { clave: 'id_externo', titulo: 'Id externo' },
  ]);
}
function csvLeads(db, filtros) {
  const { leads } = listarLeads(db, { ...filtros, limite: 1000 });
  return csv(leads, [
    { clave: 'id', titulo: 'Id' }, { clave: 'fecha', titulo: 'Fecha' }, { clave: 'nombre', titulo: 'Nombre' }, { clave: 'telefono', titulo: 'Teléfono' }, { clave: 'email', titulo: 'Correo' }, { clave: 'canal', titulo: 'Canal' },
    { clave: 'campana_nombre', titulo: 'Campaña' }, { titulo: 'Producto', valor: (l) => l.producto_nombre || l.producto_texto || '' }, { clave: 'estado', titulo: 'Estado' }, { clave: 'mensaje', titulo: 'Mensaje' },
    { clave: 'cliente_nombre', titulo: 'Cliente' }, { clave: 'venta_numero', titulo: 'Venta' }, { clave: 'utm_source', titulo: 'utm_source' }, { clave: 'utm_medium', titulo: 'utm_medium' }, { clave: 'utm_campaign', titulo: 'utm_campaign' }, { clave: 'notas', titulo: 'Notas' },
  ]);
}

module.exports = {
  PLATAFORMAS, OBJETIVOS, ESTADOS_CAMPANA, ESTADOS_LEAD, TIPOS_EVENTO, REGLAS, configMarketing,
  crearCampana, actualizarCampana, obtenerCampana, listarCampanas, cambiarEstadoCampana, fijarProductos, guardarMetricas, eliminarMetrica, listarMetricas,
  crearLead, obtenerLead, listarLeads, actualizarLead, cambiarEstadoLead, convertirLead, vincularLead, desvincularVentaAnulada, resumenLeads,
  registrarEventoPublico, listarEventos, scriptSeguimiento, seguimiento, rotarToken, reiniciarLimites, LIMITE_POR_MINUTO, LIMITE_LEADS_POR_MINUTO, LIMITE_CUERPO_BYTES,
  atribuirVenta, atribucionDe, cambiarAtribucion,
  panel, embudo, rentabilidad,
  integraciones, sincronizar, programar,
  csvCampanas, csvLeads,
};
