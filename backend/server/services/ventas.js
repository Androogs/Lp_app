'use strict';
// Ventas en COP o USD: descuentan inventario por lotes (FIFO/promedio o serial), registran el costo histórico de cada unidad,
// la tarifa aplicada (detal o mayor), la tasa de cambio, pagos, crédito, cargo de domicilio, devoluciones y anulaciones.
const crypto = require('node:crypto');
const { transaccion, siguienteNumero, getConfig } = require('../db');
const { err, ahora, hoy, entero, texto, decimal, fecha: vFecha, monedaValida, tasaValida, montoMoneda, aCop, dec2, copR } = require('../util');
const { tiene } = require('../permisos');
const auditoria = require('./auditoria');
const inventario = require('./inventario');
const creditos = require('./creditos');
const caja = require('./caja');
const comisiones = require('./comisiones');
const marketing = require('./marketing');

// Tarifa de cada producto: precio mayor si el cliente es mayorista o si la venta lleva al menos `unidades_mayor` unidades
// de esa referencia (y el producto tiene precio mayor). La misma regla la usan el punto de venta y los domicilios.
function unidadesMayor(db) { return Math.max(1, Number(getConfig(db, 'unidades_mayor')) || 10); }
function tarifaDe(producto, cantidadReferencia, { mayorista = false, minimo = 10 } = {}) {
  const aplica = producto.precio_mayor > 0 && producto.precio_mayor < producto.precio_venta && (mayorista || cantidadReferencia >= minimo);
  return aplica ? { tarifa: 'mayor', precio: producto.precio_mayor } : { tarifa: 'detal', precio: producto.precio_venta };
}

function clienteDesde(db, datos, usuario) {
  if (datos.cliente_id) {
    const c = db.prepare('SELECT * FROM clientes WHERE id = ?').get(datos.cliente_id);
    if (!c) throw err.noEncontrado('Cliente no existe');
    return c;
  }
  if (datos.cliente_nuevo && datos.cliente_nuevo.nombre) {
    const n = datos.cliente_nuevo;
    const tipo = n.tipo_cliente === 'mayorista' ? 'mayorista' : 'detal';
    const r = db.prepare('INSERT INTO clientes(nombre, telefono, identificacion, email, direccion, barrio, tipo_cliente) VALUES (?,?,?,?,?,?,?)')
      .run(texto(n.nombre, 'Nombre del cliente', { max: 160 }), n.telefono || null, n.identificacion || null, n.email || null, n.direccion || null, n.barrio || null, tipo);
    const id = Number(r.lastInsertRowid);
    auditoria.registrar(db, usuario, 'crear_cliente', 'cliente', id, { nombre: n.nombre, origen: 'venta' });
    return db.prepare('SELECT * FROM clientes WHERE id = ?').get(id);
  }
  return null;
}

function validarTasaVenta(datos, moneda) {
  if (moneda === 'COP') return { tasa: 1, origen: null, nota: null };
  const tasa = tasaValida(datos.tasa_cambio);
  const origen = ['trm', 'mercado', 'manual'].includes(datos.tasa_origen) ? datos.tasa_origen : 'manual';
  const nota = texto(datos.tasa_nota, 'Origen de la tasa', { opcional: true, max: 300 });
  if (origen === 'manual' && !nota) throw err.datos('Indica el origen o motivo de la tasa de cambio manual');
  return { tasa, origen, nota };
}

// `interno` solo lo usan otros servicios (p. ej. domicilios al entregar): nunca llega desde la API.
function crear(db, datos, usuario, interno = {}) {
  if (!tiene(usuario, 'ventas.crear')) throw err.prohibido('No tienes permiso para registrar ventas');
  if (!Array.isArray(datos.items) || !datos.items.length) throw err.datos('Agrega al menos un producto a la venta');
  const metodos = getConfig(db, 'metodos_pago');
  const maxDescPct = Number(getConfig(db, 'descuento_maximo_pct')) || 0;
  const permitirNegativoConfig = !!getConfig(db, 'permitir_stock_negativo');
  const fecha = datos.fecha ? vFecha(datos.fecha, 'Fecha') + (String(datos.fecha).length === 10 ? ' ' + ahora().slice(11) : '') : ahora();
  if (fecha.slice(0, 10) > hoy()) throw err.datos('La fecha de la venta no puede ser futura');
  const moneda = monedaValida(datos.moneda);
  const { tasa, origen: tasaOrigen, nota: tasaNota } = validarTasaVenta(datos, moneda);
  const comision = entero(datos.comision, 'Comisión', { min: 0, opcional: true, defecto: 0 });
  const gastosVenta = entero(datos.gastos_venta, 'Gastos de venta', { min: 0, opcional: true, defecto: 0 });
  const impuestos = entero(datos.impuestos, 'Impuestos', { min: 0, opcional: true, defecto: 0 });
  const cargoDomicilio = entero(datos.cargo_domicilio, 'Valor del domicilio', { min: 0, opcional: true, defecto: 0 });
  if (cargoDomicilio > 0 && moneda !== 'COP') throw err.datos('El cargo de domicilio solo aplica a ventas en pesos');
  const domicilioId = interno.domicilio_id || null;
  const minimoMayor = unidadesMayor(db);
  // Origen comercial de la venta (marketing): campaña elegida al vender y canal por el que llegó el cliente.
  const campanaId = datos.campana_id === undefined || datos.campana_id === null || datos.campana_id === '' ? null : entero(datos.campana_id, 'Campaña');
  if (campanaId && !db.prepare('SELECT id FROM campanas WHERE id = ?').get(campanaId)) throw err.noEncontrado('La campaña indicada no existe');
  const canalOrigen = opcionCanal(db, datos.canal_origen);

  return transaccion(db, () => {
    const cliente = clienteDesde(db, datos, usuario);
    // Responsable comercial: quien registra la venta, salvo que el empleador indique otro (o la deje "pendiente de asignación").
    let vendedorId = usuario.id;
    if (tiene(usuario, 'usuarios.administrar') || tiene(usuario, 'comisiones.administrar')) {
      if (datos.vendedor_id === null || datos.vendedor_id === 'pendiente') vendedorId = null;
      else if (datos.vendedor_id !== undefined && datos.vendedor_id !== '') vendedorId = entero(datos.vendedor_id, 'Responsable comercial');
    }
    if (vendedorId && !db.prepare('SELECT id FROM usuarios WHERE id = ? AND activo = 1').get(vendedorId)) throw err.datos('El responsable comercial no existe o está inactivo');
    const responsableTipo = vendedorId ? comisiones.tipoUsuario(db, vendedorId) : null;
    // 1) Ítems y precios (en la moneda de la venta; se guardan ambos valores). La tarifa (detal o mayor) se decide con el
    //    total de unidades de cada referencia en la venta y el tipo de cliente.
    const mayorista = !!(cliente && cliente.tipo_cliente === 'mayorista');
    const filas = datos.items.map((it, i) => {
      const producto = db.prepare('SELECT * FROM productos WHERE id = ?').get(entero(it.producto_id, `Producto del ítem ${i + 1}`));
      if (!producto) throw err.noEncontrado(`El producto del ítem ${i + 1} no existe`);
      if (producto.estado === 'inactivo') throw err.conflicto(`${producto.nombre} está inactivo`);
      return { it, producto, cantidad: entero(it.cantidad, `Cantidad de ${producto.nombre}`, { min: 1 }) };
    });
    const unidadesPorProducto = new Map();
    for (const f of filas) unidadesPorProducto.set(f.producto.id, (unidadesPorProducto.get(f.producto.id) || 0) + f.cantidad);
    const items = filas.map(({ it, producto, cantidad }) => {
      const { tarifa, precio: precioLista } = tarifaDe(producto, unidadesPorProducto.get(producto.id), { mayorista, minimo: minimoMayor });
      const vacio = it.precio_unitario === undefined || it.precio_unitario === null || it.precio_unitario === '';
      let precioM, precioCop, cambioPrecio;
      if (moneda === 'COP') {
        precioCop = vacio ? precioLista : entero(it.precio_unitario, `Precio de ${producto.nombre}`, { min: 0 });
        precioM = precioCop;
        cambioPrecio = precioCop !== precioLista;
      } else {
        const sugerido = dec2(precioLista / tasa);
        precioM = vacio ? sugerido : montoMoneda(it.precio_unitario, `Precio de ${producto.nombre}`, moneda, { min: 0 });
        precioCop = aCop(precioM, tasa);
        cambioPrecio = Math.abs(precioM - sugerido) > 0.011;
      }
      // Un domicilio respeta el precio pactado al tomar el pedido aunque la lista haya cambiado antes de la entrega.
      if (cambioPrecio && !interno.respetar_precios && !tiene(usuario, 'ventas.cambiar_precio')) throw err.prohibido(`No tienes permiso para cambiar el precio de ${producto.nombre}`);
      const descM = montoMoneda(it.descuento, `Descuento de ${producto.nombre}`, moneda, { min: 0, opcional: true, defecto: 0 });
      const descCop = aCop(descM, tasa);
      const total = cantidad * precioCop - descCop;
      if (total < 0) throw err.datos(`El descuento de ${producto.nombre} supera su valor`);
      const seriales = Array.isArray(it.seriales) ? it.seriales.map((s) => String(s).trim()).filter(Boolean) : [];
      return { producto, cantidad, tarifa, precioLista, precioM, precioCop, descM, descCop, total, totalM: moneda === 'COP' ? total : dec2(cantidad * precioM - descM), seriales };
    });
    const subtotal = items.reduce((a, it) => a + it.cantidad * it.precioCop, 0);
    const subtotalM = moneda === 'COP' ? subtotal : dec2(items.reduce((a, it) => a + it.cantidad * it.precioM, 0));
    const descItems = items.reduce((a, it) => a + it.descCop, 0);
    const descItemsM = moneda === 'COP' ? descItems : dec2(items.reduce((a, it) => a + it.descM, 0));
    let descGlobalM = montoMoneda(datos.descuento, 'Descuento', moneda, { min: 0, opcional: true, defecto: 0 });
    if (datos.descuento_pct) {
      const pct = decimal(datos.descuento_pct, 'Descuento %', { min: 0, max: 100 });
      descGlobalM = moneda === 'COP' ? descGlobalM + copR((subtotal - descItems) * pct / 100) : dec2(descGlobalM + (subtotalM - descItemsM) * pct / 100);
    }
    const descGlobalCop = aCop(descGlobalM, tasa);
    const descuentoTotal = descItems + descGlobalCop;
    if (descuentoTotal > 0) {
      if (!tiene(usuario, 'ventas.descuento')) throw err.prohibido('No tienes permiso para aplicar descuentos');
      const pct = subtotal > 0 ? (descuentoTotal * 100) / subtotal : 0;
      if (pct > maxDescPct && !tiene(usuario, '*') && !tiene(usuario, 'ventas.anular')) throw err.prohibido(`El descuento (${pct.toFixed(1)}%) supera el máximo autorizado (${maxDescPct}%)`);
    }
    const total = subtotal - descuentoTotal + cargoDomicilio;
    const totalM = moneda === 'COP' ? total : dec2(subtotalM - descItemsM - descGlobalM);
    if (total < 0 || totalM < 0) throw err.datos('El total no puede ser negativo');

    // 1b) Verificación previa de existencias
    const permitirNegativo = permitirNegativoConfig && tiene(usuario, 'inventario.stock_negativo') && !!datos.autorizar_stock_negativo;
    if (!permitirNegativo) {
      const porProducto = new Map();
      for (const it of items) porProducto.set(it.producto.id, (porProducto.get(it.producto.id) || 0) + it.cantidad);
      for (const [pid, cant] of porProducto) {
        const disponible = inventario.stockDe(db, pid);
        if (disponible < cant) {
          const nombre = items.find((it) => it.producto.id === pid).producto.nombre;
          throw err.conflicto(`Stock insuficiente de ${nombre}: disponibles ${disponible}, solicitadas ${cant}`, { codigo: 'stock_insuficiente', producto_id: pid, disponible, solicitado: cant, puede_autorizar: permitirNegativoConfig && tiene(usuario, 'inventario.stock_negativo') });
        }
      }
    }

    // 2) Pagos (en la moneda de la venta, a la tasa de la venta)
    const pagos = (Array.isArray(datos.pagos) ? datos.pagos : []).map((p, i) => ({
      metodo: metodos.includes(p.metodo_pago) ? p.metodo_pago : (metodos.includes(p.metodo) ? p.metodo : 'efectivo'),
      valorM: montoMoneda(p.valor, `Valor del pago ${i + 1}`, moneda, { min: 0 }),
      referencia: p.referencia || null,
      comprobante_ruta: p.comprobante_ruta || null,
    })).filter((p) => p.valorM > 0).map((p) => ({ ...p, valorCop: aCop(p.valorM, tasa) }));
    const pagadoM = moneda === 'COP' ? pagos.reduce((a, p) => a + p.valorM, 0) : dec2(pagos.reduce((a, p) => a + p.valorM, 0));
    if (pagadoM > totalM + 0.005) throw err.datos(`Los pagos (${pagadoM}) superan el total de la venta (${totalM})`);
    const saldoM = moneda === 'COP' ? totalM - pagadoM : (dec2(totalM - pagadoM) < 0.01 ? 0 : dec2(totalM - pagadoM));
    const pagadoCop = moneda === 'COP' ? pagadoM : pagos.reduce((a, p) => a + p.valorCop, 0);
    const saldoCop = saldoM === 0 ? 0 : (moneda === 'COP' ? saldoM : Math.max(0, total - pagadoCop));
    if (saldoM > 0 && !cliente) throw err.datos('Para una venta a crédito o con pago parcial debes seleccionar el cliente');
    const tipoPago = saldoM === 0 ? 'contado' : pagadoM === 0 ? 'credito' : 'parcial';

    // 3) Descontar inventario y costo real
    const numero = siguienteNumero(db, 'venta', 'V');
    const token = crypto.randomBytes(16).toString('hex');
    const rv = db.prepare(`INSERT INTO ventas(numero, fecha, cliente_id, vendedor_id, subtotal, descuento, total, costo_total, ganancia, tipo_pago, observaciones, token_publico, caja_sesion_id,
                                              moneda, tasa_cambio, tasa_origen, tasa_nota, subtotal_moneda, total_moneda, comision, gastos_venta, impuestos, registrado_por, responsable_tipo, cargo_domicilio, domicilio_id, campana_id, canal_origen)
                           VALUES (?,?,?,?,?,?,?,0,0,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(numero, fecha, cliente ? cliente.id : null, vendedorId, subtotal, descuentoTotal, total, tipoPago, texto(datos.observaciones, 'Observaciones', { opcional: true, max: 1000 }), token, caja.sesionAbiertaId(db),
        moneda, tasa, tasaOrigen, tasaNota, subtotalM, totalM, comision, gastosVenta, impuestos, usuario.id, responsableTipo, cargoDomicilio, domicilioId, campanaId, canalOrigen);
    const ventaId = Number(rv.lastInsertRowid);
    let costoTotal = 0;
    const insItem = db.prepare('INSERT INTO venta_items(venta_id, producto_id, nombre_producto, cantidad, precio_lista, precio_unitario, descuento, total, costo_total, seriales, tarifa, precio_unitario_moneda, descuento_moneda) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const insLote = db.prepare('INSERT INTO venta_item_lotes(venta_item_id, lote_id, cantidad, costo_unitario, serial, moneda_compra, tasa_compra, costo_unitario_moneda) VALUES (?,?,?,?,?,?,?,?)');
    for (const it of items) {
      const asignaciones = inventario.consumir(db, { producto_id: it.producto.id, cantidad: it.cantidad, seriales: it.seriales.length ? it.seriales : null, permitir_negativo: permitirNegativo, tipo_movimiento: 'venta', referencia_tipo: 'venta', referencia_id: ventaId, nota: numero }, usuario);
      const costoItem = asignaciones.reduce((a, x) => a + x.cantidad * x.costo_unitario, 0);
      costoTotal += costoItem;
      const serialesSalida = asignaciones.map((a) => a.serial).filter(Boolean);
      const ri = insItem.run(ventaId, it.producto.id, it.producto.nombre, it.cantidad, it.precioLista, it.precioCop, it.descCop, it.total, costoItem, serialesSalida.length ? JSON.stringify(serialesSalida) : null, it.tarifa, it.precioM, it.descM);
      for (const a of asignaciones) insLote.run(Number(ri.lastInsertRowid), a.lote_id, a.cantidad, a.costo_unitario, a.serial || null, a.moneda_compra || 'COP', a.tasa_compra || 1, a.costo_unitario_moneda ?? a.costo_unitario);
    }
    db.prepare('UPDATE ventas SET costo_total = ?, ganancia = ?, ganancia_neta = ? WHERE id = ?').run(costoTotal, total - costoTotal, total - costoTotal - comision - gastosVenta, ventaId);

    // 4) Pagos recibidos
    const insPago = db.prepare("INSERT INTO pagos(fecha, tipo, venta_id, cliente_id, valor, metodo_pago, referencia, comprobante_ruta, usuario_id, caja_sesion_id, moneda, valor_moneda, tasa_cambio) VALUES (?,'venta',?,?,?,?,?,?,?,?,?,?,?)");
    for (const p of pagos) insPago.run(fecha, ventaId, cliente ? cliente.id : null, p.valorCop, p.metodo, p.referencia, p.comprobante_ruta, usuario.id, caja.sesionAbiertaId(db), moneda, p.valorM, tasa);

    // 5) Crédito por el saldo
    let creditoId = null;
    if (saldoM > 0) {
      creditoId = creditos.crearDesdeVenta(db, { venta: { id: ventaId, numero, total, moneda, tasa_cambio: tasa, total_moneda: totalM }, cliente_id: cliente.id, saldo: saldoCop, saldo_moneda: saldoM, cuota_inicial: pagadoCop, cuota_inicial_moneda: pagadoM, config: datos.credito || {}, usuario });
    }
    auditoria.registrar(db, usuario, 'crear_venta', 'venta', ventaId, { numero, total, moneda, total_moneda: totalM, tasa_cambio: tasa, tasa_origen: tasaOrigen, costo: costoTotal, tipo_pago: tipoPago, cliente: cliente ? cliente.nombre : null, credito_id: creditoId, responsable_id: vendedorId, responsable_tipo: responsableTipo, tarifa_mayor: items.some((it) => it.tarifa === 'mayor'), cargo_domicilio: cargoDomicilio, domicilio_id: domicilioId, campana_id: campanaId, canal_origen: canalOrigen });
    // 6) Atribución de marketing (campaña elegida, cliente potencial, origen del cliente o ventana). Nunca bloquea la venta.
    try { marketing.atribuirVenta(db, ventaId, usuario); } catch (e) { console.error('[marketing] atribución de la venta', numero, e.message); }
    return obtener(db, ventaId);
  });
}

// Canal por el que llegó el cliente: debe ser uno de los canales configurados en marketing (o vacío).
function opcionCanal(db, valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  const canales = marketing.configMarketing(db).canales;
  if (!canales.includes(valor)) throw err.datos(`Canal de origen no válido (${canales.join(', ')})`);
  return valor;
}

function obtener(db, id) {
  const v = db.prepare(`SELECT v.*, c.nombre AS cliente_nombre, c.telefono AS cliente_telefono, c.identificacion AS cliente_identificacion, c.tipo_cliente AS cliente_tipo, u.nombre AS vendedor_nombre, ur.nombre AS registrado_por_nombre,
                               d.numero AS domicilio_numero, d.direccion AS domicilio_direccion
                        FROM ventas v LEFT JOIN clientes c ON c.id = v.cliente_id LEFT JOIN usuarios u ON u.id = v.vendedor_id LEFT JOIN usuarios ur ON ur.id = v.registrado_por LEFT JOIN domicilios d ON d.id = v.domicilio_id WHERE v.id = ?`).get(id);
  if (!v) throw err.noEncontrado('Venta no existe');
  v.pendiente_asignacion = !v.vendedor_id;
  v.dinero_recibido = db.prepare("SELECT COALESCE(SUM(CASE WHEN tipo = 'reintegro' THEN -valor ELSE valor END),0) t FROM pagos WHERE venta_id = ? AND anulado = 0 AND tipo IN ('venta','abono','reintegro')").get(id).t;
  v.items = db.prepare('SELECT vi.*, p.referencia, p.sku FROM venta_items vi JOIN productos p ON p.id = vi.producto_id WHERE vi.venta_id = ? ORDER BY vi.id').all(id);
  for (const it of v.items) {
    it.seriales = it.seriales ? JSON.parse(it.seriales) : [];
    it.lotes = db.prepare('SELECT vl.*, l.fecha AS lote_fecha, l.compra_id, pr.nombre AS proveedor_nombre, co.numero AS compra_numero FROM venta_item_lotes vl JOIN lotes l ON l.id = vl.lote_id LEFT JOIN proveedores pr ON pr.id = l.proveedor_id LEFT JOIN compras co ON co.id = l.compra_id WHERE vl.venta_item_id = ?').all(it.id);
    it.ganancia = it.total - it.costo_total;
  }
  v.pagos = db.prepare("SELECT p.*, u.nombre AS usuario_nombre FROM pagos p LEFT JOIN usuarios u ON u.id = p.usuario_id WHERE p.venta_id = ? AND p.tipo IN ('venta','abono','reintegro') ORDER BY p.id").all(id);
  v.pagado = v.pagos.filter((p) => !p.anulado && p.tipo !== 'reintegro').reduce((s, p) => s + p.valor, 0);
  v.credito = db.prepare('SELECT * FROM creditos WHERE venta_id = ?').get(id) || null;
  v.diferencias_cambiarias = db.prepare('SELECT * FROM diferencias_cambiarias WHERE venta_id = ? ORDER BY id').all(id);
  v.devoluciones = db.prepare('SELECT d.*, u.nombre AS usuario_nombre FROM devoluciones d LEFT JOIN usuarios u ON u.id = d.usuario_id WHERE d.venta_id = ? ORDER BY d.id').all(id);
  for (const d of v.devoluciones) d.items = db.prepare('SELECT di.*, vi.nombre_producto FROM devolucion_items di JOIN venta_items vi ON vi.id = di.venta_item_id WHERE di.devolucion_id = ?').all(d.id);
  v.total_devuelto = v.devoluciones.reduce((s, d) => s + d.total, 0);
  // Resultado definitivo cuando no queda saldo por cobrar; estimado mientras haya crédito pendiente (en USD depende de la tasa de cada abono).
  v.resultado = v.estado === 'anulada' ? 'anulada' : (!v.credito || ['pagado', 'anulado'].includes(v.credito.estado)) ? 'definitivo' : 'estimado';
  v.diferencia_cambiaria_total = v.diferencias_cambiarias.reduce((s, d) => s + d.diferencia, 0);
  // Atribución de marketing (campaña y canal): confirmada, estimada o desconocida.
  v.atribucion = marketing.atribucionDe(db, id);
  v.campana_nombre = v.campana_id ? (db.prepare('SELECT nombre FROM campanas WHERE id = ?').get(v.campana_id) || {}).nombre || null : null;
  return v;
}

function obtenerPorToken(db, token) {
  const f = db.prepare('SELECT id FROM ventas WHERE token_publico = ?').get(String(token || ''));
  return f ? obtener(db, f.id) : null;
}

function listar(db, { desde, hasta, cliente_id, vendedor_id, estado, tipo_pago, moneda, q, limite = 100, pagina = 1 } = {}) {
  const cond = [];
  const params = [];
  if (desde) { cond.push('v.fecha >= ?'); params.push(desde + ' 00:00:00'); }
  if (hasta) { cond.push('v.fecha <= ?'); params.push(hasta + ' 23:59:59'); }
  if (cliente_id) { cond.push('v.cliente_id = ?'); params.push(cliente_id); }
  if (vendedor_id) { cond.push('v.vendedor_id = ?'); params.push(vendedor_id); }
  if (estado) { cond.push('v.estado = ?'); params.push(estado); }
  if (tipo_pago) { cond.push('v.tipo_pago = ?'); params.push(tipo_pago); }
  if (moneda) { cond.push('v.moneda = ?'); params.push(moneda); }
  if (q) { cond.push('(v.numero LIKE ? OR c.nombre LIKE ? OR EXISTS (SELECT 1 FROM venta_items vi WHERE vi.venta_id = v.id AND vi.nombre_producto LIKE ?))'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const lim = Math.min(Number(limite) || 100, 500);
  const off = (Math.max(Number(pagina) || 1, 1) - 1) * lim;
  const ventas = db.prepare(`SELECT v.id, v.numero, v.fecha, v.total, v.subtotal, v.descuento, v.costo_total, v.ganancia, v.ganancia_neta, v.tipo_pago, v.estado, v.cliente_id, v.moneda, v.tasa_cambio, v.total_moneda, c.nombre AS cliente_nombre, u.nombre AS vendedor_nombre,
                               (SELECT COUNT(*) FROM venta_items vi WHERE vi.venta_id = v.id) AS n_items,
                               (SELECT GROUP_CONCAT(nombre_producto, ', ') FROM venta_items vi WHERE vi.venta_id = v.id) AS resumen
                             FROM ventas v LEFT JOIN clientes c ON c.id = v.cliente_id LEFT JOIN usuarios u ON u.id = v.vendedor_id ${where}
                             ORDER BY v.fecha DESC, v.id DESC LIMIT ? OFFSET ?`).all(...params, lim, off);
  const total = db.prepare(`SELECT COUNT(*) n FROM ventas v LEFT JOIN clientes c ON c.id = v.cliente_id ${where}`).get(...params).n;
  return { ventas, total };
}

// Devuelve dinero: primero reduce el crédito pendiente, el resto sale de caja como reintegro (a la tasa de la venta).
function devolverDinero(db, venta, valor, metodo, usuario, nota) {
  let restante = valor;
  const credito = db.prepare("SELECT * FROM creditos WHERE venta_id = ? AND estado NOT IN ('anulado')").get(venta.id);
  if (credito && credito.saldo_actual > 0 && restante > 0) restante -= creditos.reducirSaldo(db, credito.id, restante, nota, usuario);
  if (restante > 0) {
    const tasa = venta.tasa_cambio || 1;
    db.prepare("INSERT INTO pagos(fecha, tipo, venta_id, cliente_id, valor, metodo_pago, nota, usuario_id, caja_sesion_id, moneda, valor_moneda, tasa_cambio) VALUES (?,'reintegro',?,?,?,?,?,?,?,?,?,?)")
      .run(ahora(), venta.id, venta.cliente_id, restante, metodo || 'efectivo', nota, usuario.id, caja.sesionAbiertaId(db), venta.moneda || 'COP', venta.moneda === 'USD' ? dec2(restante / tasa) : restante, tasa);
  }
  return { aplicado_credito: valor - restante, reintegrado: restante };
}

function restaurarItem(db, item, cantidad, ventaId, tipoMov, usuario, nota) {
  const lotes = db.prepare('SELECT * FROM venta_item_lotes WHERE venta_item_id = ? ORDER BY id DESC').all(item.id);
  let faltan = cantidad;
  let costo = 0;
  const asignaciones = [];
  for (const vl of lotes) {
    if (faltan <= 0) break;
    const disponible = vl.cantidad - vl.cantidad_devuelta;
    if (disponible <= 0) continue;
    const toma = Math.min(disponible, faltan);
    db.prepare('UPDATE venta_item_lotes SET cantidad_devuelta = cantidad_devuelta + ? WHERE id = ?').run(toma, vl.id);
    asignaciones.push({ lote_id: vl.lote_id, cantidad: toma, costo_unitario: vl.costo_unitario });
    costo += toma * vl.costo_unitario;
    faltan -= toma;
  }
  inventario.restaurar(db, { producto_id: item.producto_id, asignaciones, tipo_movimiento: tipoMov, referencia_tipo: 'venta', referencia_id: ventaId, nota }, usuario);
  return costo;
}

function devolver(db, ventaId, datos, usuario) {
  if (!tiene(usuario, 'ventas.devolver')) throw err.prohibido('No tienes permiso para registrar devoluciones');
  const v = obtener(db, ventaId);
  if (v.estado === 'anulada') throw err.conflicto('La venta está anulada');
  if (!Array.isArray(datos.items) || !datos.items.length) throw err.datos('Indica los productos a devolver');
  const tipo = datos.tipo === 'cambio' ? 'cambio' : 'devolucion';
  const motivo = texto(datos.motivo, 'Motivo', { max: 300 });
  return transaccion(db, () => {
    const numero = siguienteNumero(db, 'devolucion', 'DV');
    const rd = db.prepare('INSERT INTO devoluciones(numero, venta_id, fecha, tipo, motivo, total, reintegro_metodo, usuario_id, caja_sesion_id) VALUES (?,?,?,?,?,0,?,?,?)')
      .run(numero, ventaId, ahora(), tipo, motivo, datos.reintegro_metodo || 'efectivo', usuario.id, caja.sesionAbiertaId(db));
    const devId = Number(rd.lastInsertRowid);
    let total = 0;
    for (const d of datos.items) {
      const item = v.items.find((it) => it.id === Number(d.venta_item_id));
      if (!item) throw err.datos('Ítem de venta no válido');
      const maximo = item.cantidad - item.cantidad_devuelta;
      const cantidad = entero(d.cantidad, `Cantidad a devolver de ${item.nombre_producto}`, { min: 1, max: maximo });
      const reingresa = d.reingresa === undefined ? true : !!d.reingresa;
      const valor = copR((item.total / item.cantidad) * cantidad);
      let costo = 0;
      if (reingresa) costo = restaurarItem(db, item, cantidad, ventaId, 'devolucion_venta', usuario, `${numero}: ${motivo}`);
      else {
        const lotes = db.prepare('SELECT * FROM venta_item_lotes WHERE venta_item_id = ? ORDER BY id DESC').all(item.id);
        let faltan = cantidad;
        for (const vl of lotes) { if (faltan <= 0) break; const disp = vl.cantidad - vl.cantidad_devuelta; if (disp <= 0) continue; const toma = Math.min(disp, faltan); db.prepare('UPDATE venta_item_lotes SET cantidad_devuelta = cantidad_devuelta + ? WHERE id = ?').run(toma, vl.id); faltan -= toma; }
      }
      db.prepare('INSERT INTO devolucion_items(devolucion_id, venta_item_id, producto_id, cantidad, valor, costo, reingresa) VALUES (?,?,?,?,?,?,?)').run(devId, item.id, item.producto_id, cantidad, valor, costo, reingresa ? 1 : 0);
      db.prepare('UPDATE venta_items SET cantidad_devuelta = cantidad_devuelta + ? WHERE id = ?').run(cantidad, item.id);
      total += valor;
    }
    db.prepare('UPDATE devoluciones SET total = ? WHERE id = ?').run(total, devId);
    const dinero = devolverDinero(db, v, total, datos.reintegro_metodo, usuario, `Devolución ${numero}`);
    const restantes = db.prepare('SELECT COALESCE(SUM(cantidad - cantidad_devuelta),0) n FROM venta_items WHERE venta_id = ?').get(ventaId).n;
    db.prepare('UPDATE ventas SET estado = ? WHERE id = ?').run(restantes === 0 ? 'devuelta' : 'devuelta_parcial', ventaId);
    auditoria.registrar(db, usuario, tipo === 'cambio' ? 'cambio_venta' : 'devolucion_venta', 'venta', ventaId, { numero, total, motivo, ...dinero });
    const ajustes = comisiones.ajustarPorCambio(db, ventaId, usuario, `Devolución ${numero}: ${motivo}`);
    return { devolucion: { id: devId, numero, total, ...dinero }, ajustes_liquidacion: ajustes, venta: obtener(db, ventaId) };
  });
}

function anular(db, ventaId, motivo, usuario) {
  if (!tiene(usuario, 'ventas.anular')) throw err.prohibido('No tienes permiso para anular ventas');
  const v = obtener(db, ventaId);
  if (v.estado === 'anulada') throw err.conflicto('La venta ya está anulada');
  const mot = texto(motivo, 'Motivo de anulación', { max: 300 });
  return transaccion(db, () => {
    const numero = siguienteNumero(db, 'devolucion', 'DV');
    const rd = db.prepare("INSERT INTO devoluciones(numero, venta_id, fecha, tipo, motivo, total, usuario_id, caja_sesion_id) VALUES (?,?,?,'anulacion',?,0,?,?)").run(numero, ventaId, ahora(), mot, usuario.id, caja.sesionAbiertaId(db));
    const devId = Number(rd.lastInsertRowid);
    let total = 0;
    for (const item of v.items) {
      const cantidad = item.cantidad - item.cantidad_devuelta;
      if (cantidad <= 0) continue;
      const valor = copR((item.total / item.cantidad) * cantidad);
      const costo = restaurarItem(db, item, cantidad, ventaId, 'anulacion_venta', usuario, `Anulación ${numero}: ${mot}`);
      db.prepare('INSERT INTO devolucion_items(devolucion_id, venta_item_id, producto_id, cantidad, valor, costo, reingresa) VALUES (?,?,?,?,?,?,1)').run(devId, item.id, item.producto_id, cantidad, valor, costo);
      db.prepare('UPDATE venta_items SET cantidad_devuelta = cantidad WHERE id = ?').run(item.id);
      total += valor;
    }
    db.prepare('UPDATE devoluciones SET total = ? WHERE id = ?').run(total, devId);
    const abierta = caja.sesionAbiertaId(db);
    let reintegrado = 0;
    for (const p of v.pagos) {
      if (p.anulado || p.tipo === 'reintegro') continue;
      if (p.caja_sesion_id && p.caja_sesion_id === abierta) db.prepare('UPDATE pagos SET anulado = 1, anulado_en = ? WHERE id = ?').run(ahora(), p.id);
      else {
        db.prepare("INSERT INTO pagos(fecha, tipo, venta_id, cliente_id, valor, metodo_pago, nota, usuario_id, caja_sesion_id, moneda, valor_moneda, tasa_cambio) VALUES (?,'reintegro',?,?,?,?,?,?,?,?,?,?)").run(ahora(), ventaId, v.cliente_id, p.valor, p.metodo_pago, `Reintegro por anulación ${numero}`, usuario.id, abierta, p.moneda || 'COP', p.valor_moneda ?? p.valor, p.tasa_cambio || 1);
        reintegrado += p.valor;
      }
    }
    if (v.credito && v.credito.estado !== 'anulado') creditos.anular(db, v.credito.id, `Anulación de la venta ${v.numero}`, usuario);
    // Un domicilio entregado cuya venta se anula queda marcado para que no cuente como entregado en los indicadores.
    if (v.domicilio_id) db.prepare("UPDATE domicilios SET notas = TRIM(COALESCE(notas,'') || ' · Venta anulada: ' || ?), actualizado_en = ? WHERE id = ?").run(mot, ahora(), v.domicilio_id);
    db.prepare("UPDATE ventas SET estado = 'anulada', anulada_en = ?, motivo_anulacion = ? WHERE id = ?").run(ahora(), mot, ventaId);
    // Marketing: el cliente potencial que tenía esta venta como evidencia la pierde (y vuelve a 'interesado' si solo lo convirtió
    // la ventana de atribución). La atribución de la venta se conserva; las métricas ya filtran las anuladas.
    let leadsDesvinculados = 0;
    try { leadsDesvinculados = marketing.desvincularVentaAnulada(db, ventaId); } catch (e) { console.error('[marketing] desvincular venta anulada', v.numero, e.message); }
    auditoria.registrar(db, usuario, 'anular_venta', 'venta', ventaId, { numero: v.numero, motivo: mot, total: v.total, reintegrado, domicilio_id: v.domicilio_id || null, leads_desvinculados: leadsDesvinculados });
    comisiones.ajustarPorCambio(db, ventaId, usuario, `Anulación ${numero}: ${mot}`);
    return obtener(db, ventaId);
  });
}

// Corrección manual de la tasa de una venta en moneda extranjera (sin devoluciones ni abonos posteriores).
function corregirTasa(db, ventaId, datos, usuario) {
  if (!tiene(usuario, 'contabilidad.editar')) throw err.prohibido('No tienes permiso para corregir tasas de cambio');
  const v = obtener(db, ventaId);
  if (v.moneda === 'COP') throw err.conflicto('La venta está en pesos: no tiene tasa de cambio');
  if (v.estado !== 'confirmada') throw err.conflicto('Solo se corrigen ventas confirmadas sin devoluciones');
  if (v.credito && db.prepare("SELECT COUNT(*) n FROM pagos WHERE credito_id = ? AND tipo = 'abono' AND anulado = 0").get(v.credito.id).n) throw err.conflicto('No se puede corregir la tasa: el crédito ya tiene abonos');
  const nueva = tasaValida(datos.tasa_cambio, 'Tasa nueva');
  const motivo = texto(datos.motivo, 'Motivo de la corrección', { max: 300 });
  return transaccion(db, () => {
    const antes = { tasa_cambio: v.tasa_cambio, total: v.total, ganancia: v.ganancia };
    let subtotal = 0, descItems = 0;
    for (const it of v.items) {
      const precioCop = aCop(it.precio_unitario_moneda, nueva);
      const descCop = aCop(it.descuento_moneda || 0, nueva);
      const total = it.cantidad * precioCop - descCop;
      subtotal += it.cantidad * precioCop; descItems += descCop;
      db.prepare('UPDATE venta_items SET precio_unitario = ?, descuento = ?, total = ? WHERE id = ?').run(precioCop, descCop, total, it.id);
    }
    const descGlobalM = dec2((v.descuento - v.items.reduce((s, it) => s + it.descuento, 0)) / v.tasa_cambio);
    const descuentoTotal = descItems + aCop(descGlobalM, nueva);
    const total = subtotal - descuentoTotal;
    db.prepare("UPDATE ventas SET tasa_cambio = ?, tasa_origen = 'manual', tasa_nota = ?, subtotal = ?, descuento = ?, total = ?, ganancia = ? - costo_total, ganancia_neta = ? - costo_total - comision - gastos_venta WHERE id = ?")
      .run(nueva, `Corregida: ${motivo}`, subtotal, descuentoTotal, total, total, total, ventaId);
    db.prepare('UPDATE pagos SET valor = ROUND(valor_moneda * ?), tasa_cambio = ? WHERE venta_id = ? AND anulado = 0').run(nueva, nueva, ventaId);
    if (v.credito) {
      db.prepare('UPDATE creditos SET tasa_cambio = ?, valor_total = ?, saldo_financiado = ROUND(saldo_financiado_moneda * ?), saldo_actual = ROUND(saldo_moneda * ?), valor_cuota = ROUND(valor_cuota / ? * ?) WHERE id = ?').run(nueva, total, nueva, nueva, v.tasa_cambio, nueva, v.credito.id);
      db.prepare('UPDATE credito_cuotas SET valor = ROUND(valor_moneda * ?) WHERE credito_id = ?').run(nueva, v.credito.id);
    }
    auditoria.registrar(db, usuario, 'corregir_tasa_venta', 'venta', ventaId, { antes, despues: { tasa_cambio: nueva, total }, motivo });
    return obtener(db, ventaId);
  });
}

module.exports = { crear, obtener, obtenerPorToken, listar, devolver, anular, corregirTasa, tarifaDe, unidadesMayor };
