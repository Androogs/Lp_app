'use strict';
// Domicilios: pedidos que llegan por WhatsApp, teléfono o la web y se entregan con la flota propia.
// Flujo: recibido → en_preparacion → en_camino → entregado (crea la venta) | cancelado.
// El inventario se descuenta al entregar (la venta usa el mismo motor de lotes FIFO); antes de eso el pedido solo reserva
// información, por eso se advierte si una referencia no alcanza pero no se bloquea la toma del pedido.
const { transaccion, siguienteNumero, getConfig, CONFIG_DEFAULT } = require('../db');
const { err, ahora, hoy, entero, texto, opcion } = require('../util');
const { tiene } = require('../permisos');
const auditoria = require('./auditoria');
const inventario = require('./inventario');
const ventas = require('./ventas');

const ESTADOS = ['recibido', 'en_preparacion', 'en_camino', 'entregado', 'cancelado'];
const ABIERTOS = ['recibido', 'en_preparacion', 'en_camino'];
const CANALES = ['whatsapp', 'telefono', 'web', 'presencial', 'otro'];

function configDomicilios(db) {
  const c = getConfig(db, 'domicilios');
  return { ...CONFIG_DEFAULT.domicilios, ...(c && typeof c === 'object' ? c : {}) };
}

const minutosDesde = (t) => (t ? Math.max(0, Math.round((Date.now() - new Date(String(t).replace(' ', 'T')).getTime()) / 60000)) : null);

// Ítems con la misma regla de tarifa del punto de venta (detal o mayor según unidades por referencia y tipo de cliente).
function calcularItems(db, lista, mayorista) {
  if (!Array.isArray(lista) || !lista.length) throw err.datos('Agrega al menos un producto al pedido');
  const minimo = ventas.unidadesMayor(db);
  const filas = lista.map((it, i) => {
    const producto = db.prepare('SELECT * FROM productos WHERE id = ?').get(entero(it.producto_id, `Producto ${i + 1}`));
    if (!producto) throw err.noEncontrado(`El producto ${i + 1} no existe`);
    if (producto.estado === 'inactivo') throw err.conflicto(`${producto.nombre} está inactivo`);
    return { producto, cantidad: entero(it.cantidad, `Cantidad de ${producto.nombre}`, { min: 1, max: 10000 }) };
  });
  const unidades = new Map();
  for (const f of filas) unidades.set(f.producto.id, (unidades.get(f.producto.id) || 0) + f.cantidad);
  return filas.map(({ producto, cantidad }) => {
    const { tarifa, precio } = ventas.tarifaDe(producto, unidades.get(producto.id), { mayorista, minimo });
    return { producto, cantidad, tarifa, precio, total: precio * cantidad };
  });
}

function clientePara(db, datos, usuario) {
  if (datos.cliente_id) {
    const c = db.prepare('SELECT * FROM clientes WHERE id = ?').get(entero(datos.cliente_id, 'Cliente'));
    if (!c) throw err.noEncontrado('El cliente no existe');
    return c;
  }
  // Cliente nuevo: se crea con el teléfono y la dirección del pedido para el próximo domicilio.
  if (datos.guardar_cliente === false) return null;
  const nombre = texto(datos.cliente_nombre, 'Nombre del cliente', { max: 160 });
  const telefono = texto(datos.telefono, 'Teléfono', { max: 40 });
  const existente = db.prepare("SELECT * FROM clientes WHERE REPLACE(REPLACE(telefono,' ',''),'-','') = ? AND activo = 1 LIMIT 1").get(telefono.replace(/[\s-]/g, ''));
  if (existente) return existente;
  const r = db.prepare("INSERT INTO clientes(nombre, telefono, direccion, barrio, tipo_cliente, origen_canal) VALUES (?,?,?,?,'detal',?)")
    .run(nombre, telefono, datos.direccion || null, datos.barrio || null, CANALES.includes(datos.canal) && datos.canal !== 'telefono' && datos.canal !== 'otro' ? datos.canal : null);
  const id = Number(r.lastInsertRowid);
  auditoria.registrar(db, usuario, 'crear_cliente', 'cliente', id, { nombre, origen: 'domicilio' });
  return db.prepare('SELECT * FROM clientes WHERE id = ?').get(id);
}

function validarCabecera(db, datos, cliente) {
  const cfg = configDomicilios(db);
  const metodos = getConfig(db, 'metodos_pago') || [];
  const d = {
    canal: datos.canal ? opcion(datos.canal, 'Canal', CANALES) : 'whatsapp',
    cliente_nombre: texto(datos.cliente_nombre || (cliente && cliente.nombre), 'Nombre del cliente', { max: 160 }),
    telefono: texto(datos.telefono || (cliente && cliente.telefono), 'Teléfono de contacto', { max: 40 }),
    direccion: texto(datos.direccion || (cliente && cliente.direccion), 'Dirección de entrega', { max: 240 }),
    barrio: texto(datos.barrio ?? (cliente && cliente.barrio), 'Barrio', { opcional: true, max: 120 }),
    indicaciones: texto(datos.indicaciones, 'Indicaciones', { opcional: true, max: 500 }),
    metodo_pago: metodos.includes(datos.metodo_pago) ? datos.metodo_pago : 'efectivo',
    paga_con: datos.paga_con ? entero(datos.paga_con, 'Paga con', { min: 0 }) : null,
    hora_compromiso: datos.hora_compromiso ? texto(datos.hora_compromiso, 'Hora de entrega', { max: 5 }) : null,
    notas: texto(datos.notas, 'Notas', { opcional: true, max: 1000 }),
  };
  if (d.hora_compromiso && !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.hora_compromiso)) throw err.datos('La hora de entrega debe tener el formato HH:MM');
  d.cargoSolicitado = datos.cargo_envio === undefined || datos.cargo_envio === null || datos.cargo_envio === ''
    ? null : entero(datos.cargo_envio, 'Valor del envío', { min: 0, max: 1000000 });
  d.cfg = cfg;
  return d;
}

function totales(items, cargoSolicitado, cfg) {
  const subtotal = items.reduce((s, it) => s + it.total, 0);
  const gratis = cfg.envio_gratis_desde > 0 && subtotal >= cfg.envio_gratis_desde;
  const cargo = cargoSolicitado !== null ? cargoSolicitado : (gratis ? 0 : cfg.cargo_envio_defecto);
  return { subtotal, cargo, total: subtotal + cargo };
}

function guardarItems(db, domicilioId, items) {
  db.prepare('DELETE FROM domicilio_items WHERE domicilio_id = ?').run(domicilioId);
  const ins = db.prepare('INSERT INTO domicilio_items(domicilio_id, producto_id, nombre_producto, cantidad, precio_unitario, tarifa, total) VALUES (?,?,?,?,?,?,?)');
  for (const it of items) ins.run(domicilioId, it.producto.id, it.producto.nombre, it.cantidad, it.precio, it.tarifa, it.total);
}

function crear(db, datos, usuario) {
  if (!tiene(usuario, 'domicilios.crear')) throw err.prohibido('No tienes permiso para tomar pedidos a domicilio');
  return transaccion(db, () => {
    const cliente = clientePara(db, datos, usuario);
    const d = validarCabecera(db, datos, cliente);
    const items = calcularItems(db, datos.items, !!(cliente && cliente.tipo_cliente === 'mayorista'));
    const t = totales(items, d.cargoSolicitado, d.cfg);
    const numero = siguienteNumero(db, 'domicilio', 'D');
    const r = db.prepare(`INSERT INTO domicilios(numero, estado, canal, fecha, cliente_id, cliente_nombre, telefono, direccion, barrio, indicaciones, subtotal, cargo_envio, total,
                            metodo_pago, paga_con, hora_compromiso, notas, creado_por, actualizado_en) VALUES (?,'recibido',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(numero, d.canal, ahora(), cliente ? cliente.id : null, d.cliente_nombre, d.telefono, d.direccion, d.barrio, d.indicaciones, t.subtotal, t.cargo, t.total,
        d.metodo_pago, d.paga_con, d.hora_compromiso, d.notas, usuario.id, ahora());
    const id = Number(r.lastInsertRowid);
    guardarItems(db, id, items);
    auditoria.registrar(db, usuario, 'crear_domicilio', 'domicilio', id, { numero, total: t.total, cliente: d.cliente_nombre, canal: d.canal });
    return obtener(db, id);
  });
}

// Se puede corregir mientras no haya salido de la bodega.
function actualizar(db, id, datos, usuario) {
  if (!tiene(usuario, 'domicilios.crear') && !tiene(usuario, 'domicilios.despachar')) throw err.prohibido('No tienes permiso para modificar domicilios');
  const actual = db.prepare('SELECT * FROM domicilios WHERE id = ?').get(id);
  if (!actual) throw err.noEncontrado('El domicilio no existe');
  if (!['recibido', 'en_preparacion'].includes(actual.estado)) throw err.conflicto('El pedido ya salió de la bodega: no se puede modificar');
  return transaccion(db, () => {
    const cliente = actual.cliente_id ? db.prepare('SELECT * FROM clientes WHERE id = ?').get(actual.cliente_id) : null;
    const d = validarCabecera(db, { ...actual, cargo_envio: actual.cargo_envio, ...datos }, cliente);
    const items = Array.isArray(datos.items)
      ? calcularItems(db, datos.items, !!(cliente && cliente.tipo_cliente === 'mayorista'))
      : null;
    const subtotal = items ? items.reduce((s, it) => s + it.total, 0) : actual.subtotal;
    const cargo = d.cargoSolicitado !== null ? d.cargoSolicitado : actual.cargo_envio;
    db.prepare(`UPDATE domicilios SET canal=?, cliente_nombre=?, telefono=?, direccion=?, barrio=?, indicaciones=?, subtotal=?, cargo_envio=?, total=?, metodo_pago=?, paga_con=?,
                hora_compromiso=?, notas=?, actualizado_en=? WHERE id=?`)
      .run(d.canal, d.cliente_nombre, d.telefono, d.direccion, d.barrio, d.indicaciones, subtotal, cargo, subtotal + cargo, d.metodo_pago, d.paga_con, d.hora_compromiso, d.notas, ahora(), id);
    if (items) guardarItems(db, id, items);
    auditoria.registrar(db, usuario, 'editar_domicilio', 'domicilio', id, { numero: actual.numero, total: subtotal + cargo });
    return obtener(db, id);
  });
}

// Avance de estado. 'entregar' crea la venta con los productos, el pago contraentrega y el cargo del envío.
function cambiarEstado(db, id, accion, datos, usuario) {
  if (!tiene(usuario, 'domicilios.despachar')) throw err.prohibido('No tienes permiso para despachar domicilios');
  const dom = db.prepare('SELECT * FROM domicilios WHERE id = ?').get(id);
  if (!dom) throw err.noEncontrado('El domicilio no existe');
  const t = ahora();
  return transaccion(db, () => {
    if (accion === 'preparar') {
      if (dom.estado !== 'recibido') throw err.conflicto('Solo un pedido recibido pasa a preparación');
      db.prepare("UPDATE domicilios SET estado = 'en_preparacion', preparado_en = ?, actualizado_en = ? WHERE id = ?").run(t, t, id);
    } else if (accion === 'despachar') {
      if (!['recibido', 'en_preparacion'].includes(dom.estado)) throw err.conflicto('Ese pedido ya salió o está cerrado');
      const repartidorId = entero(datos.repartidor_id, 'Repartidor');
      const rep = db.prepare('SELECT * FROM repartidores WHERE id = ? AND activo = 1').get(repartidorId);
      if (!rep) throw err.datos('Elige un repartidor activo');
      // Antes de salir se confirma que hay existencias (el pedido no puede ir incompleto).
      for (const it of db.prepare('SELECT producto_id, nombre_producto, SUM(cantidad) cantidad FROM domicilio_items WHERE domicilio_id = ? GROUP BY producto_id').all(id)) {
        const disponible = inventario.stockDe(db, it.producto_id);
        if (disponible < it.cantidad) throw err.conflicto(`No alcanza ${it.nombre_producto}: hay ${disponible} y el pedido lleva ${it.cantidad}`, { codigo: 'stock_insuficiente' });
      }
      db.prepare("UPDATE domicilios SET estado = 'en_camino', repartidor_id = ?, preparado_en = COALESCE(preparado_en, ?), despachado_en = ?, actualizado_en = ? WHERE id = ?").run(repartidorId, t, t, t, id);
    } else if (accion === 'entregar') {
      if (dom.estado !== 'en_camino') throw err.conflicto('Solo se entrega un pedido que está en camino');
      if (!tiene(usuario, 'ventas.crear')) throw err.prohibido('Para cerrar la entrega necesitas permiso para registrar ventas');
      const items = db.prepare('SELECT * FROM domicilio_items WHERE domicilio_id = ? ORDER BY id').all(id);
      const metodos = getConfig(db, 'metodos_pago') || [];
      const metodo = metodos.includes(datos.metodo_pago) ? datos.metodo_pago : (dom.metodo_pago || 'efectivo');
      // Por defecto se cobra todo contraentrega; un cliente con cuenta puede quedar con saldo (venta a crédito).
      const cobrado = datos.valor_cobrado === undefined || datos.valor_cobrado === null || datos.valor_cobrado === ''
        ? dom.total : entero(datos.valor_cobrado, 'Valor cobrado', { min: 0, max: dom.total });
      if (cobrado < dom.total && !dom.cliente_id) throw err.datos('Para dejar saldo pendiente el pedido debe tener un cliente registrado');
      const venta = ventas.crear(db, {
        cliente_id: dom.cliente_id || undefined,
        items: items.map((it) => ({ producto_id: it.producto_id, cantidad: it.cantidad, precio_unitario: it.precio_unitario })),
        cargo_domicilio: dom.cargo_envio,
        pagos: cobrado > 0 ? [{ metodo_pago: metodo, valor: cobrado, referencia: datos.referencia || dom.numero }] : [],
        canal_origen: canalVenta(db, dom.canal),
        observaciones: `Domicilio ${dom.numero} · ${dom.direccion}${dom.barrio ? ', ' + dom.barrio : ''}`,
        credito: cobrado < dom.total ? { numero_cuotas: 1, frecuencia: 'mensual', condiciones: `Saldo del domicilio ${dom.numero}` } : undefined,
      }, usuario, { domicilio_id: id, respetar_precios: true });
      db.prepare("UPDATE domicilios SET estado = 'entregado', entregado_en = ?, venta_id = ?, metodo_pago = ?, actualizado_en = ? WHERE id = ?").run(t, venta.id, metodo, t, id);
    } else if (accion === 'cancelar') {
      if (!ABIERTOS.includes(dom.estado)) throw err.conflicto('El pedido ya está cerrado');
      const motivo = texto(datos.motivo, 'Motivo de la cancelación', { max: 300 });
      db.prepare("UPDATE domicilios SET estado = 'cancelado', cancelado_en = ?, motivo_cancelacion = ?, actualizado_en = ? WHERE id = ?").run(t, motivo, t, id);
    } else if (accion === 'reabrir') {
      // Un pedido que vuelve a bodega (el cliente no estaba, dirección errada) regresa a preparación.
      if (dom.estado !== 'en_camino') throw err.conflicto('Solo un pedido en camino puede volver a la bodega');
      db.prepare("UPDATE domicilios SET estado = 'en_preparacion', despachado_en = NULL, repartidor_id = NULL, actualizado_en = ? WHERE id = ?").run(t, id);
    } else throw err.datos('Acción no válida');
    auditoria.registrar(db, usuario, `domicilio_${accion}`, 'domicilio', id, { numero: dom.numero, de: dom.estado, motivo: datos.motivo || undefined });
    return obtener(db, id);
  });
}

// El canal del domicilio se lleva a la venta solo si existe como canal de marketing.
function canalVenta(db, canal) {
  try {
    const canales = require('./marketing').configMarketing(db).canales;
    return canales.includes(canal) ? canal : null;
  } catch { return null; }
}

function decorar(db, d, cfg) {
  const desde = d.estado === 'en_camino' ? d.despachado_en : d.fecha;
  d.minutos = ABIERTOS.includes(d.estado) ? minutosDesde(desde) : null;
  d.minutos_entrega = d.estado === 'entregado' && d.entregado_en ? Math.round((new Date(d.entregado_en.replace(' ', 'T')) - new Date(d.fecha.replace(' ', 'T'))) / 60000) : null;
  const limite = d.estado === 'en_camino' ? cfg.minutos_alerta_camino : cfg.minutos_alerta_preparacion;
  d.atrasado = d.minutos !== null && limite > 0 && d.minutos > limite;
  d.cambio = d.paga_con && d.paga_con > d.total ? d.paga_con - d.total : 0;
  return d;
}

const SELECT = `SELECT d.*, r.nombre AS repartidor_nombre, r.vehiculo AS repartidor_vehiculo, r.placa AS repartidor_placa, r.telefono AS repartidor_telefono,
  u.nombre AS creado_por_nombre, c.tipo_cliente, v.numero AS venta_numero, v.estado AS venta_estado,
  (SELECT COUNT(*) FROM domicilio_items i WHERE i.domicilio_id = d.id) AS n_items,
  (SELECT COALESCE(SUM(cantidad),0) FROM domicilio_items i WHERE i.domicilio_id = d.id) AS unidades,
  (SELECT GROUP_CONCAT(cantidad || ' × ' || nombre_producto, ', ') FROM domicilio_items i WHERE i.domicilio_id = d.id) AS resumen
  FROM domicilios d LEFT JOIN repartidores r ON r.id = d.repartidor_id LEFT JOIN usuarios u ON u.id = d.creado_por
  LEFT JOIN clientes c ON c.id = d.cliente_id LEFT JOIN ventas v ON v.id = d.venta_id`;

function obtener(db, id) {
  const d = db.prepare(`${SELECT} WHERE d.id = ?`).get(id);
  if (!d) throw err.noEncontrado('El domicilio no existe');
  d.items = db.prepare(`SELECT i.*, p.precio_venta, p.precio_mayor, p.capacidad, (SELECT ruta FROM producto_fotos f WHERE f.producto_id = i.producto_id ORDER BY principal DESC, id LIMIT 1) AS foto
                        FROM domicilio_items i JOIN productos p ON p.id = i.producto_id WHERE i.domicilio_id = ? ORDER BY i.id`).all(id);
  for (const it of d.items) it.stock = inventario.stockDe(db, it.producto_id);
  return decorar(db, d, configDomicilios(db));
}

function listar(db, { estado, q, desde, hasta, repartidor_id, limite = 200 } = {}) {
  const cond = []; const params = [];
  if (estado === 'abiertos') cond.push(`d.estado IN (${ABIERTOS.map(() => '?').join(',')})`), params.push(...ABIERTOS);
  else if (estado) { cond.push('d.estado = ?'); params.push(opcion(estado, 'Estado', ESTADOS)); }
  if (desde) { cond.push('d.fecha >= ?'); params.push(desde + ' 00:00:00'); }
  if (hasta) { cond.push('d.fecha <= ?'); params.push(hasta + ' 23:59:59'); }
  if (repartidor_id) { cond.push('d.repartidor_id = ?'); params.push(Number(repartidor_id)); }
  if (q) { const like = `%${String(q).trim()}%`; cond.push('(d.numero LIKE ? OR d.cliente_nombre LIKE ? OR d.telefono LIKE ? OR d.direccion LIKE ? OR d.barrio LIKE ?)'); params.push(like, like, like, like, like); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const cfg = configDomicilios(db);
  const filas = db.prepare(`${SELECT} ${where} ORDER BY CASE d.estado WHEN 'en_camino' THEN 0 WHEN 'en_preparacion' THEN 1 WHEN 'recibido' THEN 2 ELSE 3 END, d.fecha DESC LIMIT ?`)
    .all(...params, Math.min(Number(limite) || 200, 500));
  return filas.map((d) => decorar(db, d, cfg));
}

// Resumen del día y del mes para el tablero, el Inicio, los avisos y el asistente.
function resumen(db) {
  const cfg = configDomicilios(db);
  const h = hoy();
  const porEstado = Object.fromEntries(ESTADOS.map((e) => [e, 0]));
  for (const f of db.prepare("SELECT estado, COUNT(*) n FROM domicilios WHERE estado IN ('recibido','en_preparacion','en_camino') OR fecha >= ? GROUP BY estado").all(h + ' 00:00:00')) porEstado[f.estado] = f.n;
  const abiertos = listar(db, { estado: 'abiertos', limite: 500 });
  const hoyEnt = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total),0) total, COALESCE(SUM(cargo_envio),0) envios, AVG((julianday(entregado_en) - julianday(fecha)) * 1440) prom FROM domicilios WHERE estado = 'entregado' AND entregado_en >= ?").get(h + ' 00:00:00');
  const mes = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total),0) total, AVG((julianday(entregado_en) - julianday(fecha)) * 1440) prom FROM domicilios WHERE estado = 'entregado' AND entregado_en >= ?").get(h.slice(0, 8) + '01 00:00:00');
  const porRepartidor = db.prepare(`SELECT r.id, r.nombre, r.vehiculo, r.placa,
      SUM(CASE WHEN d.estado = 'en_camino' THEN 1 ELSE 0 END) en_camino,
      SUM(CASE WHEN d.estado = 'entregado' AND d.entregado_en >= ? THEN 1 ELSE 0 END) entregados_hoy
    FROM repartidores r LEFT JOIN domicilios d ON d.repartidor_id = r.id WHERE r.activo = 1 GROUP BY r.id ORDER BY en_camino DESC, r.nombre`).all(h + ' 00:00:00');
  return {
    por_estado: porEstado,
    abiertos: abiertos.length,
    por_despachar: abiertos.filter((d) => d.estado !== 'en_camino').length,
    en_camino: abiertos.filter((d) => d.estado === 'en_camino').length,
    atrasados: abiertos.filter((d) => d.atrasado).map((d) => ({ id: d.id, numero: d.numero, estado: d.estado, cliente_nombre: d.cliente_nombre, minutos: d.minutos, barrio: d.barrio })),
    hoy: { entregados: hoyEnt.n, total: hoyEnt.total, envios: hoyEnt.envios, minutos_promedio: hoyEnt.prom ? Math.round(hoyEnt.prom) : null },
    mes: { entregados: mes.n, total: mes.total, minutos_promedio: mes.prom ? Math.round(mes.prom) : null },
    repartidores: porRepartidor,
    config: cfg,
  };
}

// ---------- Repartidores ----------
function repartidores(db, { todos = false } = {}) {
  return db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM domicilios d WHERE d.repartidor_id = r.id AND d.estado = 'en_camino') AS en_camino
                     FROM repartidores r ${todos ? '' : 'WHERE r.activo = 1'} ORDER BY r.activo DESC, r.nombre`).all();
}
function guardarRepartidor(db, id, datos, usuario) {
  if (!tiene(usuario, 'domicilios.despachar')) throw err.prohibido('No tienes permiso para administrar repartidores');
  const actual = id ? db.prepare('SELECT * FROM repartidores WHERE id = ?').get(id) : null;
  if (id && !actual) throw err.noEncontrado('El repartidor no existe');
  const v = {
    nombre: texto(datos.nombre ?? actual?.nombre, 'Nombre', { max: 120 }),
    telefono: texto(datos.telefono ?? actual?.telefono, 'Teléfono', { opcional: true, max: 40 }),
    vehiculo: texto(datos.vehiculo ?? actual?.vehiculo, 'Vehículo', { opcional: true, max: 80 }),
    placa: texto(datos.placa ?? actual?.placa, 'Placa', { opcional: true, max: 12 }),
    activo: datos.activo === undefined ? (actual ? actual.activo : 1) : (datos.activo ? 1 : 0),
  };
  if (v.placa) v.placa = v.placa.toUpperCase();
  let rid = id;
  if (actual) db.prepare('UPDATE repartidores SET nombre=?, telefono=?, vehiculo=?, placa=?, activo=? WHERE id=?').run(v.nombre, v.telefono, v.vehiculo, v.placa, v.activo, id);
  else rid = Number(db.prepare('INSERT INTO repartidores(nombre, telefono, vehiculo, placa, activo) VALUES (?,?,?,?,?)').run(v.nombre, v.telefono, v.vehiculo, v.placa, v.activo).lastInsertRowid);
  auditoria.registrar(db, usuario, actual ? 'editar_repartidor' : 'crear_repartidor', 'repartidor', rid, v);
  return db.prepare('SELECT * FROM repartidores WHERE id = ?').get(rid);
}

module.exports = { ESTADOS, ABIERTOS, CANALES, configDomicilios, crear, actualizar, cambiarEstado, obtener, listar, resumen, repartidores, guardarRepartidor, calcularItems };
