'use strict';
// Compras a proveedores en COP o USD: cada ítem genera lote(s) con su costo real en pesos
// (tasa de cambio registrada en la compra + prorrateo de fletes/impuestos). La tasa de una compra nunca cambia sola.
//
// Dos tasas distintas conviven en cada compra (ver docs/CONTABILIDAD-TRM.md › "TRM de referencia por compra"):
//  - tasa_cambio / tasa_origen / tasa_nota: la TASA APLICADA a la operación (en COP es 1). Es la que define el costo de los lotes.
//  - trm_valor / trm_fecha / trm_vigencia_hasta / trm_fuente / trm_obtenida_en / trm_captura: fotografía de la TRM OFICIAL vigente
//    el día de la compra, guardada como referencia histórica. Nunca se recalcula ni cambia después (ni al corregir la tasa aplicada).
//    Si la fecha no tenía TRM propia ni en la API (fin de semana / festivo), trm_fuente dice que es la última TRM publicada antes.
const { transaccion, siguienteNumero, getConfig } = require('../db');
const { err, ahora, hoy, entero, texto, fecha: vFecha, monedaValida, tasaValida, montoMoneda, aCop, dec2, copR } = require('../util');
const { tiene } = require('../permisos');
const auditoria = require('./auditoria');
const inventario = require('./inventario');
const caja = require('./caja');
const trm = require('./trm');

const ORIGENES_TASA = ['trm', 'mercado', 'manual'];
// Cómo se obtuvo la TRM de referencia guardada en la compra:
//  automatica = caché local / API oficial al registrar · manual = la escribió el usuario porque no había dato ·
//  historica = completada después desde el histórico local (compras anteriores a esta función) · no_disponible = no hubo dato y nadie la escribió.
const CAPTURAS_TRM = ['automatica', 'manual', 'historica', 'no_disponible'];

// TRM oficial de referencia para una fecha (síncrona: solo mira el histórico local `tasas_cambio`).
// Devuelve { valor, fecha (vigente desde), vigencia_hasta, fuente, obtenido_en, puente } o null si no hay un dato que sirva.
// Misma regla que trm.trmParaFecha: la fila sirve si su vigencia cubre la fecha; si no la cubre y `puente` está permitido, sirve la
// última TRM publicada hasta 4 días antes (trm.puenteTrm, que deja constancia en `fuente`). Esta función no distingue "festivo" de
// "nunca consultado", así que quien llama debe haber intentado antes la API (la ruta POST /api/compras lo hace con trm.trmParaFecha);
// con { puente: false } es estricta: solo una fila que cubra la fecha.
function referenciaTrm(db, fecha, { puente = true } = {}) {
  const dia = String(fecha || hoy()).slice(0, 10);
  const fila = trm.trmVigente(db, dia);
  if (!fila) return null;
  const cubre = (fila.vigencia_hasta || fila.fecha) >= dia;
  const ref = cubre ? fila : (puente ? trm.puenteTrm(fila, dia) : null);
  if (!ref) return null;
  return { valor: ref.valor, fecha: ref.vigencia_desde || ref.fecha, vigencia_hasta: ref.vigencia_hasta || null, fuente: ref.fuente || trm.FUENTE_TRM, obtenido_en: ref.obtenido_en || null, puente: !cubre };
}

// Decide qué TRM de referencia queda guardada en una compra nueva: oficial (automática) > manual del usuario > no disponible.
// Si la referencia vino por el puente, `fuente` ya dice que es la última TRM publicada antes de la fecha (queda en trm_fuente).
function resolverTrmReferencia(db, datos, fechaDia) {
  const ref = referenciaTrm(db, fechaDia);
  if (ref) return { valor: ref.valor, fecha: ref.fecha, vigencia_hasta: ref.vigencia_hasta, fuente: ref.fuente, captura: 'automatica' };
  const manualDada = datos.trm_referencia_manual !== undefined && datos.trm_referencia_manual !== null && String(datos.trm_referencia_manual).trim() !== '';
  if (manualDada) {
    const valor = tasaValida(datos.trm_referencia_manual, 'TRM de referencia manual');
    const nota = texto(datos.trm_referencia_nota, 'Motivo de la TRM de referencia manual', { opcional: true, max: 300 });
    return { valor, fecha: fechaDia, vigencia_hasta: null, fuente: nota ? `Manual: ${nota}` : 'Manual (registrada por el usuario)', captura: 'manual' };
  }
  return { valor: null, fecha: null, vigencia_hasta: null, fuente: null, captura: 'no_disponible' };
}

function proveedorDesde(db, datos, usuario) {
  if (datos.proveedor_id) {
    const p = db.prepare('SELECT * FROM proveedores WHERE id = ?').get(datos.proveedor_id);
    if (!p) throw err.noEncontrado('Proveedor no existe');
    return p;
  }
  if (datos.proveedor_nuevo && datos.proveedor_nuevo.nombre) {
    const n = datos.proveedor_nuevo;
    const r = db.prepare('INSERT INTO proveedores(nombre, identificacion, telefono, email, direccion, contacto) VALUES (?,?,?,?,?,?)')
      .run(texto(n.nombre, 'Nombre del proveedor', { max: 160 }), n.identificacion || null, n.telefono || null, n.email || null, n.direccion || null, n.contacto || null);
    const id = Number(r.lastInsertRowid);
    auditoria.registrar(db, usuario, 'crear_proveedor', 'proveedor', id, { nombre: n.nombre, origen: 'compra' });
    return db.prepare('SELECT * FROM proveedores WHERE id = ?').get(id);
  }
  return null;
}

function detectarDuplicado(db, { proveedor_id, numero_factura, total, fecha }) {
  if (numero_factura) {
    const f = db.prepare("SELECT id, numero, fecha, total FROM compras WHERE estado = 'confirmada' AND numero_factura = ? AND (proveedor_id = ? OR ? IS NULL)").get(numero_factura, proveedor_id, proveedor_id);
    if (f) return { motivo: `Ya existe la compra ${f.numero} con la factura ${numero_factura} (${f.fecha}, total ${f.total})`, compra: f };
  }
  const similares = db.prepare("SELECT id, numero, fecha, total, numero_factura FROM compras WHERE estado = 'confirmada' AND total = ? AND (proveedor_id = ? OR ? IS NULL) AND ABS(julianday(fecha) - julianday(?)) <= 3").all(total, proveedor_id, proveedor_id, fecha);
  if (similares.length) return { motivo: `Hay una compra con el mismo proveedor y total (${similares[0].numero}, ${similares[0].fecha}). Verifica que no sea la misma factura.`, compra: similares[0] };
  return null;
}

// Valida la tasa de cambio de una operación en moneda extranjera y deja constancia de su origen.
function validarTasa(datos, moneda) {
  if (moneda === 'COP') return { tasa: 1, origen: null, nota: null };
  const tasa = tasaValida(datos.tasa_cambio);
  const origen = ORIGENES_TASA.includes(datos.tasa_origen) ? datos.tasa_origen : 'manual';
  const nota = texto(datos.tasa_nota, 'Origen de la tasa', { opcional: true, max: 300 });
  if (origen === 'manual' && !nota) throw err.datos('Indica el origen o motivo de la tasa de cambio manual');
  return { tasa, origen, nota };
}

// Reparte fletes/impuestos (COP) menos el descuento general entre los ítems según su valor y devuelve el costo unitario final en pesos.
function costoFinalUnitario(netoCop, cantidad, subtotalCop, extraNetoCop, nItems) {
  const parte = subtotalCop > 0 ? netoCop / subtotalCop : 1 / nItems;
  return copR((netoCop + extraNetoCop * parte) / cantidad);
}

function crear(db, datos, usuario) {
  if (!tiene(usuario, 'compras.crear')) throw err.prohibido('No tienes permiso para registrar compras');
  if (!Array.isArray(datos.items) || !datos.items.length) throw err.datos('Agrega al menos un producto a la compra');
  // Fecha con hora, como ventas y pagos: el formulario envía solo el día y se completa con la hora actual (los filtros por rango
  // comparan `fecha >= desde` sin hora para que también entren las compras antiguas guardadas como 'YYYY-MM-DD').
  const fecha = datos.fecha ? vFecha(datos.fecha, 'Fecha') + (String(datos.fecha).length === 10 ? ' ' + ahora().slice(11) : '') : ahora();
  if (fecha.slice(0, 10) > hoy()) throw err.datos('La fecha de la compra no puede ser futura');
  const moneda = monedaValida(datos.moneda);
  const { tasa, origen: tasaOrigen, nota: tasaNota } = validarTasa(datos, moneda);
  const numeroFactura = texto(datos.numero_factura, 'Número de factura', { opcional: true, max: 60 });
  const descuentoM = montoMoneda(datos.descuento, 'Descuento', moneda, { min: 0, opcional: true, defecto: 0 });
  const costosAdicionales = entero(datos.costos_adicionales, 'Costos adicionales', { min: 0, opcional: true, defecto: 0 });
  const impuestos = entero(datos.impuestos, 'Impuestos', { min: 0, opcional: true, defecto: 0 });
  const metodos = getConfig(db, 'metodos_pago');
  // Fotografía de la TRM oficial vigente el día de la compra (aparte de la tasa aplicada). Se valida antes de la transacción.
  const trmRef = resolverTrmReferencia(db, datos, fecha.slice(0, 10));

  return transaccion(db, () => {
    const proveedor = proveedorDesde(db, datos, usuario);
    const items = datos.items.map((it, i) => {
      const producto = db.prepare('SELECT * FROM productos WHERE id = ?').get(entero(it.producto_id, `Producto del ítem ${i + 1}`));
      if (!producto) throw err.noEncontrado(`El producto del ítem ${i + 1} no existe`);
      const cantidad = entero(it.cantidad, `Cantidad de ${producto.nombre}`, { min: 1 });
      const costoM = montoMoneda(it.costo_unitario, `Costo unitario de ${producto.nombre}`, moneda, { min: 0 });
      const descItemM = montoMoneda(it.descuento, `Descuento de ${producto.nombre}`, moneda, { min: 0, opcional: true, defecto: 0 });
      let seriales = Array.isArray(it.seriales) ? it.seriales.map((s) => String(s).trim()).filter(Boolean) : [];
      if (producto.requiere_serial) {
        if (seriales.length !== cantidad) throw err.datos(`${producto.nombre} requiere serial o estampilla por unidad: indica ${cantidad} serial(es) (recibidos ${seriales.length})`);
        if (new Set(seriales).size !== seriales.length) throw err.datos(`Hay seriales repetidos en ${producto.nombre}`);
      } else seriales = [];
      const netoM = moneda === 'COP' ? cantidad * costoM - descItemM : dec2(cantidad * costoM - descItemM);
      if (netoM < 0) throw err.datos(`El descuento de ${producto.nombre} supera su valor`);
      return { producto, cantidad, costoM, descItemM, seriales, netoM, netoCop: aCop(netoM, tasa), costoCop: aCop(costoM, tasa), descCop: aCop(descItemM, tasa) };
    });
    const subtotalM = moneda === 'COP' ? items.reduce((a, it) => a + it.netoM, 0) : dec2(items.reduce((a, it) => a + it.netoM, 0));
    const subtotalCop = items.reduce((a, it) => a + it.netoCop, 0);
    const descuentoCop = aCop(descuentoM, tasa);
    const totalM = moneda === 'COP' ? subtotalM - descuentoM : dec2(subtotalM - descuentoM);
    const total = subtotalCop - descuentoCop + costosAdicionales + impuestos;
    if (totalM < 0 || total < 0) throw err.datos('El total de la compra no puede ser negativo');
    // Lo que se le debe al proveedor va en la moneda de la compra. Fletes e impuestos en COP se asumen pagados aparte (van al costo).
    const deudaProveedorM = moneda === 'COP' ? total : totalM;
    const valorPagadoM = montoMoneda(datos.valor_pagado, 'Valor pagado', moneda, { min: 0, max: deudaProveedorM + 0.005, opcional: true, defecto: 0 });
    const valorPagadoCop = moneda === 'COP' ? valorPagadoM : aCop(valorPagadoM, tasa);
    const metodoPago = valorPagadoM > 0 ? (metodos.includes(datos.metodo_pago) ? datos.metodo_pago : 'efectivo') : (datos.metodo_pago || null);
    const saldoM = moneda === 'COP' ? deudaProveedorM - valorPagadoM : Math.max(0, dec2(deudaProveedorM - valorPagadoM));
    const saldoCop = moneda === 'COP' ? saldoM : aCop(saldoM, tasa);
    const vencimiento = datos.fecha_vencimiento ? vFecha(datos.fecha_vencimiento, 'Fecha de vencimiento') : null;

    if (!datos.forzar) {
      const dup = detectarDuplicado(db, { proveedor_id: proveedor ? proveedor.id : null, numero_factura: numeroFactura, total, fecha: fecha.slice(0, 10) });
      if (dup) throw err.conflicto(dup.motivo, { codigo: 'posible_duplicado', compra: dup.compra });
    }

    const numero = siguienteNumero(db, 'compra', 'CP');
    const r = db.prepare(`INSERT INTO compras(numero, proveedor_id, contacto, fecha, numero_factura, subtotal, descuento, costos_adicionales, impuestos, total, metodo_pago, valor_pagado, saldo_pendiente, fecha_vencimiento, notas, usuario_id, documento_id,
                                              moneda, tasa_cambio, tasa_origen, tasa_nota, subtotal_moneda, descuento_moneda, total_moneda, valor_pagado_moneda, saldo_pendiente_moneda,
                                              trm_valor, trm_fecha, trm_vigencia_hasta, trm_fuente, trm_obtenida_en, trm_captura)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(numero, proveedor ? proveedor.id : null, texto(datos.contacto, 'Contacto', { opcional: true, max: 120 }), fecha, numeroFactura, subtotalCop, descuentoCop, costosAdicionales, impuestos, total, metodoPago, valorPagadoCop, saldoCop, vencimiento,
        texto(datos.notas, 'Notas', { opcional: true, max: 1000 }), usuario.id, datos.documento_id || null,
        moneda, tasa, tasaOrigen, tasaNota, subtotalM, descuentoM, totalM, valorPagadoM, saldoM,
        trmRef.valor, trmRef.fecha, trmRef.vigencia_hasta, trmRef.fuente, ahora(), trmRef.captura);
    const compraId = Number(r.lastInsertRowid);

    const extraNeto = costosAdicionales + impuestos - descuentoCop;
    const insItem = db.prepare('INSERT INTO compra_items(compra_id, producto_id, cantidad, costo_unitario, descuento, costo_unitario_final, total, seriales, costo_unitario_moneda, descuento_moneda) VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (const it of items) {
      const costoFinalUnit = costoFinalUnitario(it.netoCop, it.cantidad, subtotalCop, extraNeto, items.length);
      const ri = insItem.run(compraId, it.producto.id, it.cantidad, it.costoCop, it.descCop, costoFinalUnit, it.netoCop, it.seriales.length ? JSON.stringify(it.seriales) : null, it.costoM, it.descItemM);
      const itemId = Number(ri.lastInsertRowid);
      const base = { producto_id: it.producto.id, compra_id: compraId, compra_item_id: itemId, proveedor_id: proveedor ? proveedor.id : null, fecha: fecha.slice(0, 10), costo_unitario: costoFinalUnit, origen: 'compra', tipo_movimiento: 'compra', referencia_tipo: 'compra', referencia_id: compraId, moneda, tasa_cambio: tasa, costo_unitario_moneda: it.costoM };
      if (it.seriales.length) for (const s of it.seriales) inventario.crearLote(db, { ...base, cantidad: 1, serial: s }, usuario);
      else inventario.crearLote(db, { ...base, cantidad: it.cantidad }, usuario);
      if (it.producto.precio_compra !== costoFinalUnit) {
        db.prepare("INSERT INTO historial_precios(producto_id, tipo, precio_anterior, precio_nuevo, usuario_id, usuario_nombre, motivo) VALUES (?,'compra',?,?,?,?,?)")
          .run(it.producto.id, it.producto.precio_compra, costoFinalUnit, usuario.id, usuario.nombre, `Compra ${numero}${moneda !== 'COP' ? ` (${it.costoM} ${moneda} × ${tasa})` : ''}`);
        db.prepare('UPDATE productos SET precio_compra = ?, actualizado_en = ? WHERE id = ?').run(costoFinalUnit, ahora(), it.producto.id);
      }
    }

    if (valorPagadoM > 0) {
      db.prepare("INSERT INTO pagos(fecha, tipo, compra_id, proveedor_id, valor, metodo_pago, nota, usuario_id, caja_sesion_id, moneda, valor_moneda, tasa_cambio) VALUES (?,'pago_proveedor',?,?,?,?,?,?,?,?,?,?)")
        .run(ahora(), compraId, proveedor ? proveedor.id : null, valorPagadoCop, metodoPago, `Pago al registrar la compra ${numero}`, usuario.id, caja.sesionAbiertaId(db), moneda, valorPagadoM, tasa);
    }
    if (datos.documento_id) db.prepare("UPDATE documentos SET estado = 'procesado', compra_id = ? WHERE id = ?").run(compraId, datos.documento_id);
    auditoria.registrar(db, usuario, 'crear_compra', 'compra', compraId, { numero, proveedor: proveedor ? proveedor.nombre : null, total, moneda, total_moneda: totalM, tasa_cambio: tasa, tasa_origen: tasaOrigen, trm_referencia: { valor: trmRef.valor, fecha: trmRef.fecha, captura: trmRef.captura }, items: items.length });
    return obtener(db, compraId);
  });
}

// Completa la TRM de referencia de compras anteriores a esta función (trm_valor y trm_captura vacíos) desde el histórico local.
// Nunca toca la tasa aplicada ni los costos; las compras marcadas 'manual' o 'no_disponible' se respetan tal como quedaron.
// La llama server/index.js al arrancar; puede correr las veces que sea (solo actúa sobre lo que sigue vacío). Nunca lanza.
async function completarTrmHistorica(db, { silencioso = false } = {}) {
  const resultado = { revisadas: 0, completadas: 0, sin_dato: 0, historico_cargado: false };
  try {
    const pendientes = db.prepare("SELECT id, fecha FROM compras WHERE trm_valor IS NULL AND (trm_captura IS NULL OR trm_captura NOT IN ('manual','no_disponible')) ORDER BY fecha, id").all();
    resultado.revisadas = pendientes.length;
    if (!pendientes.length) return resultado;
    // Estricto (sin puente): una fila a ≤ 4 días no basta para dar por cubierta la fecha; si falta la fila exacta se consulta el histórico.
    const sinLocal = pendientes.filter((c) => !referenciaTrm(db, c.fecha.slice(0, 10), { puente: false }));
    if (sinLocal.length && process.env.TRM_DESACTIVAR_RED !== '1') {
      // Un solo intento de traer el histórico oficial desde la compra más antigua sin dato (trm.cargarHistorico ya limita la frecuencia).
      try { resultado.historico_cargado = !!(await trm.cargarHistorico(db, sinLocal[0].fecha.slice(0, 10))); } catch (e) { if (!silencioso) console.error('[trm compras] histórico:', e.message); }
    }
    // El puente (última TRM publicada hasta 4 días antes, con constancia en la fuente) solo se acepta si el histórico oficial sí se
    // consultó y aun así no trajo la fecha (fin de semana / festivo). Si no se pudo consultar, lo no cubierto queda pendiente para la próxima pasada.
    const puente = !sinLocal.length || resultado.historico_cargado;
    const actualizar = db.prepare("UPDATE compras SET trm_valor = ?, trm_fecha = ?, trm_vigencia_hasta = ?, trm_fuente = ?, trm_obtenida_en = ?, trm_captura = 'historica' WHERE id = ? AND trm_valor IS NULL");
    transaccion(db, () => {
      for (const c of pendientes) {
        const ref = referenciaTrm(db, c.fecha.slice(0, 10), { puente });
        if (!ref) { resultado.sin_dato++; continue; }
        actualizar.run(ref.valor, ref.fecha, ref.vigencia_hasta, ref.fuente, ahora(), c.id);
        resultado.completadas++;
      }
    });
    if (!silencioso && resultado.completadas) console.log(`[trm compras] TRM de referencia completada en ${resultado.completadas} compra(s) desde el histórico local${resultado.sin_dato ? ` (${resultado.sin_dato} sin dato todavía)` : ''}`);
  } catch (e) {
    if (!silencioso) console.error('[trm compras]', e.message);
    resultado.error = e.message;
  }
  return resultado;
}

function pagar(db, compraId, datos, usuario) {
  if (!tiene(usuario, 'compras.pagar')) throw err.prohibido('No tienes permiso para registrar pagos a proveedores');
  const c = db.prepare('SELECT * FROM compras WHERE id = ?').get(compraId);
  if (!c) throw err.noEncontrado('Compra no existe');
  if (c.estado !== 'confirmada') throw err.conflicto('La compra está anulada');
  const metodos = getConfig(db, 'metodos_pago');
  const metodo = metodos.includes(datos.metodo_pago) ? datos.metodo_pago : 'efectivo';
  const fechaPago = datos.fecha ? vFecha(datos.fecha, 'Fecha') + (String(datos.fecha).length === 10 ? ' ' + ahora().slice(11) : '') : ahora();
  return transaccion(db, () => {
    let pagoId;
    if (c.moneda !== 'COP') {
      const saldoM = c.saldo_pendiente_moneda ?? 0;
      if (saldoM <= 0) throw err.conflicto('La compra ya está pagada');
      const valorM = montoMoneda(datos.valor_moneda ?? datos.valor, `Valor en ${c.moneda}`, c.moneda, { min: 0.01, max: saldoM + 0.005 });
      const { tasa: tasaPago, origen, nota } = validarTasa({ tasa_cambio: datos.tasa_cambio, tasa_origen: datos.tasa_origen, tasa_nota: datos.tasa_nota }, c.moneda);
      const valorCop = aCop(valorM, tasaPago);
      const r = db.prepare("INSERT INTO pagos(fecha, tipo, compra_id, proveedor_id, valor, metodo_pago, referencia, comprobante_ruta, nota, usuario_id, caja_sesion_id, moneda, valor_moneda, tasa_cambio) VALUES (?,'pago_proveedor',?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(fechaPago, compraId, c.proveedor_id, valorCop, metodo, datos.referencia || null, datos.comprobante_ruta || null, [datos.nota, nota ? `Tasa ${origen}: ${nota}` : null].filter(Boolean).join(' · ') || null, usuario.id, caja.sesionAbiertaId(db), c.moneda, valorM, tasaPago);
      pagoId = Number(r.lastInsertRowid);
      const nuevoSaldoM = Math.max(0, dec2(saldoM - valorM)) < 0.01 ? 0 : dec2(saldoM - valorM);
      db.prepare('UPDATE compras SET valor_pagado = valor_pagado + ?, valor_pagado_moneda = COALESCE(valor_pagado_moneda,0) + ?, saldo_pendiente_moneda = ?, saldo_pendiente = ? WHERE id = ?')
        .run(valorCop, valorM, nuevoSaldoM, aCop(nuevoSaldoM, c.tasa_cambio), compraId);
      // Diferencia cambiaria realizada: pagar a una tasa menor que la de la compra cuesta menos pesos (ganancia) y viceversa.
      const diferencia = copR(valorM * (c.tasa_cambio - tasaPago));
      if (diferencia !== 0) {
        db.prepare("INSERT INTO diferencias_cambiarias(fecha, tipo, compra_id, pago_id, moneda, valor_moneda, tasa_operacion, tasa_pago, diferencia, nota, usuario_id) VALUES (?,'pago_compra',?,?,?,?,?,?,?,?,?)")
          .run(fechaPago, compraId, pagoId, c.moneda, valorM, c.tasa_cambio, tasaPago, diferencia, `Pago de ${valorM} ${c.moneda} de la compra ${c.numero}`, usuario.id);
      }
      auditoria.registrar(db, usuario, 'pago_proveedor', 'compra', compraId, { valor_moneda: valorM, moneda: c.moneda, tasa_pago: tasaPago, tasa_origen: origen, valor_cop: valorCop, diferencia_cambiaria: diferencia, metodo });
    } else {
      if (c.saldo_pendiente <= 0) throw err.conflicto('La compra ya está pagada');
      const valor = entero(datos.valor, 'Valor', { min: 1, max: c.saldo_pendiente });
      const r = db.prepare("INSERT INTO pagos(fecha, tipo, compra_id, proveedor_id, valor, metodo_pago, referencia, comprobante_ruta, nota, usuario_id, caja_sesion_id, moneda, valor_moneda, tasa_cambio) VALUES (?,'pago_proveedor',?,?,?,?,?,?,?,?,?,'COP',?,1)")
        .run(fechaPago, compraId, c.proveedor_id, valor, metodo, datos.referencia || null, datos.comprobante_ruta || null, datos.nota || null, usuario.id, caja.sesionAbiertaId(db), valor);
      pagoId = Number(r.lastInsertRowid);
      db.prepare('UPDATE compras SET valor_pagado = valor_pagado + ?, saldo_pendiente = saldo_pendiente - ?, valor_pagado_moneda = COALESCE(valor_pagado_moneda,0) + ?, saldo_pendiente_moneda = COALESCE(saldo_pendiente_moneda, saldo_pendiente + ?) - ? WHERE id = ?').run(valor, valor, valor, valor, valor, compraId);
      auditoria.registrar(db, usuario, 'pago_proveedor', 'compra', compraId, { valor, metodo });
    }
    return { pago_id: pagoId, compra: obtener(db, compraId) };
  });
}

function anular(db, compraId, motivo, usuario) {
  if (!tiene(usuario, 'compras.anular')) throw err.prohibido('No tienes permiso para anular compras');
  const c = db.prepare('SELECT * FROM compras WHERE id = ?').get(compraId);
  if (!c) throw err.noEncontrado('Compra no existe');
  if (c.estado === 'anulada') throw err.conflicto('La compra ya está anulada');
  return transaccion(db, () => {
    const lotes = db.prepare('SELECT * FROM lotes WHERE compra_id = ?').all(compraId);
    if (lotes.some((l) => l.cantidad_restante !== l.cantidad_inicial)) throw err.conflicto('No se puede anular: ya se vendieron unidades de esta compra. Registra un ajuste de inventario si corresponde.');
    for (const l of lotes) {
      db.prepare("UPDATE lotes SET cantidad_restante = 0, estado = 'anulado' WHERE id = ?").run(l.id);
      inventario.registrarMovimiento(db, { producto_id: l.producto_id, lote_id: l.id, tipo: 'anulacion_compra', cantidad: -l.cantidad_inicial, costo_unitario: l.costo_unitario, referencia_tipo: 'compra', referencia_id: compraId, nota: motivo }, usuario);
      inventario.actualizarEstadoProducto(db, l.producto_id);
    }
    db.prepare('UPDATE pagos SET anulado = 1, anulado_en = ? WHERE compra_id = ? AND anulado = 0').run(ahora(), compraId);
    db.prepare("UPDATE compras SET estado = 'anulada', anulada_en = ?, motivo_anulacion = ?, saldo_pendiente = 0, saldo_pendiente_moneda = 0 WHERE id = ?").run(ahora(), texto(motivo, 'Motivo', { max: 300 }), compraId);
    auditoria.registrar(db, usuario, 'anular_compra', 'compra', compraId, { motivo, total: c.total });
    return obtener(db, compraId);
  });
}

// Corrección manual de la tasa APLICADA de una compra en moneda extranjera. Solo si nada se ha vendido ni pagado después.
// La TRM de referencia histórica (trm_*) no se toca: sigue siendo la TRM oficial que regía el día de la compra.
function corregirTasa(db, compraId, datos, usuario) {
  if (!tiene(usuario, 'contabilidad.editar')) throw err.prohibido('No tienes permiso para corregir tasas de cambio');
  const c = db.prepare('SELECT * FROM compras WHERE id = ?').get(compraId);
  if (!c) throw err.noEncontrado('Compra no existe');
  if (c.moneda === 'COP') throw err.conflicto('La compra está en pesos: no tiene tasa de cambio');
  if (c.estado !== 'confirmada') throw err.conflicto('La compra está anulada');
  const nueva = tasaValida(datos.tasa_cambio, 'Tasa nueva');
  const motivo = texto(datos.motivo, 'Motivo de la corrección', { max: 300 });
  return transaccion(db, () => {
    const lotes = db.prepare('SELECT * FROM lotes WHERE compra_id = ?').all(compraId);
    if (lotes.some((l) => l.cantidad_restante !== l.cantidad_inicial)) throw err.conflicto('No se puede corregir la tasa: ya se vendieron unidades de esta compra');
    const pagosPosteriores = db.prepare('SELECT COUNT(*) n FROM pagos WHERE compra_id = ? AND anulado = 0 AND tasa_cambio <> ?').get(compraId, c.tasa_cambio).n;
    if (pagosPosteriores) throw err.conflicto('No se puede corregir la tasa: hay pagos registrados con otra tasa');
    const antes = { tasa_cambio: c.tasa_cambio, subtotal: c.subtotal, total: c.total, saldo_pendiente: c.saldo_pendiente };
    const items = db.prepare('SELECT * FROM compra_items WHERE compra_id = ?').all(compraId);
    const netosCop = items.map((it) => aCop(dec2(it.cantidad * it.costo_unitario_moneda - (it.descuento_moneda || 0)), nueva));
    const subtotalCop = netosCop.reduce((a, b) => a + b, 0);
    const descuentoCop = aCop(c.descuento_moneda || 0, nueva);
    const extraNeto = c.costos_adicionales + c.impuestos - descuentoCop;
    items.forEach((it, i) => {
      const costoFinal = costoFinalUnitario(netosCop[i], it.cantidad, subtotalCop, extraNeto, items.length);
      const viejoFinal = it.costo_unitario_final;
      db.prepare('UPDATE compra_items SET costo_unitario = ?, descuento = ?, costo_unitario_final = ?, total = ? WHERE id = ?').run(aCop(it.costo_unitario_moneda, nueva), aCop(it.descuento_moneda || 0, nueva), costoFinal, netosCop[i], it.id);
      db.prepare('UPDATE lotes SET costo_unitario = ?, tasa_cambio = ? WHERE compra_item_id = ?').run(costoFinal, nueva, it.id);
      db.prepare("UPDATE movimientos SET costo_unitario = ? WHERE referencia_tipo = 'compra' AND referencia_id = ? AND producto_id = ? AND tipo = 'compra'").run(costoFinal, compraId, it.producto_id);
      db.prepare('UPDATE productos SET precio_compra = ?, actualizado_en = ? WHERE id = ? AND precio_compra = ?').run(costoFinal, ahora(), it.producto_id, viejoFinal);
      db.prepare("INSERT INTO historial_precios(producto_id, tipo, precio_anterior, precio_nuevo, usuario_id, usuario_nombre, motivo) VALUES (?,'compra',?,?,?,?,?)").run(it.producto_id, viejoFinal, costoFinal, usuario.id, usuario.nombre, `Corrección de tasa compra ${c.numero}: ${motivo}`);
    });
    const total = subtotalCop - descuentoCop + c.costos_adicionales + c.impuestos;
    const valorPagadoCop = aCop(c.valor_pagado_moneda || 0, nueva);
    db.prepare('UPDATE compras SET tasa_cambio = ?, tasa_origen = \'manual\', tasa_nota = ?, subtotal = ?, descuento = ?, total = ?, valor_pagado = ?, saldo_pendiente = ? WHERE id = ?')
      .run(nueva, `Corregida: ${motivo}`, subtotalCop, descuentoCop, total, valorPagadoCop, aCop(c.saldo_pendiente_moneda || 0, nueva), compraId);
    db.prepare('UPDATE pagos SET valor = ROUND(valor_moneda * ?), tasa_cambio = ? WHERE compra_id = ? AND anulado = 0').run(nueva, nueva, compraId);
    auditoria.registrar(db, usuario, 'corregir_tasa_compra', 'compra', compraId, { antes, despues: { tasa_cambio: nueva, subtotal: subtotalCop, total }, motivo });
    return obtener(db, compraId);
  });
}

function obtener(db, id) {
  const c = db.prepare(`SELECT c.*, p.nombre AS proveedor_nombre, p.telefono AS proveedor_telefono, u.nombre AS usuario_nombre
                        FROM compras c LEFT JOIN proveedores p ON p.id = c.proveedor_id LEFT JOIN usuarios u ON u.id = c.usuario_id WHERE c.id = ?`).get(id);
  if (!c) throw err.noEncontrado('Compra no existe');
  c.items = db.prepare('SELECT ci.*, pr.nombre AS producto_nombre, pr.referencia, pr.requiere_serial FROM compra_items ci JOIN productos pr ON pr.id = ci.producto_id WHERE ci.compra_id = ? ORDER BY ci.id').all(id);
  for (const it of c.items) it.seriales = it.seriales ? JSON.parse(it.seriales) : [];
  c.lotes = db.prepare('SELECT l.*, pr.nombre AS producto_nombre FROM lotes l JOIN productos pr ON pr.id = l.producto_id WHERE l.compra_id = ? ORDER BY l.id').all(id);
  c.pagos = db.prepare('SELECT p.*, u.nombre AS usuario_nombre FROM pagos p LEFT JOIN usuarios u ON u.id = p.usuario_id WHERE p.compra_id = ? ORDER BY p.id').all(id);
  c.diferencias_cambiarias = db.prepare('SELECT * FROM diferencias_cambiarias WHERE compra_id = ? ORDER BY id').all(id);
  c.documento = c.documento_id ? db.prepare('SELECT id, ruta, mime, nombre, estado FROM documentos WHERE id = ?').get(c.documento_id) : null;
  if (c.moneda !== 'COP' && c.saldo_pendiente_moneda > 0) {
    const vigente = trm.trmVigente(db);
    c.saldo_estimado_hoy = vigente ? { tasa: vigente.valor, fecha: vigente.fecha, valor: aCop(c.saldo_pendiente_moneda, vigente.valor) } : null;
  }
  // TRM oficial de referencia frente a la tasa realmente aplicada (solo tiene sentido en moneda extranjera y si hubo TRM).
  c.comparacion_trm = comparacionTrm(c);
  c.diferencia_tasa = c.comparacion_trm ? c.comparacion_trm.diferencia_tasa : null;
  c.diferencia_pct = c.comparacion_trm ? c.comparacion_trm.diferencia_pct : null;
  c.puede_vender_unidades = c.lotes.every((l) => l.cantidad_restante === l.cantidad_inicial);
  return c;
}

// diferencia_tasa = tasa aplicada − TRM oficial (pesos por dólar); diferencia_pct = diferencia / TRM × 100.
// Positivo: se aplicó una tasa mayor que la TRM (más pesos por dólar); negativo: menor. Es informativo, no cambia costos.
function comparacionTrm(c) {
  if (!c || c.moneda === 'COP' || c.trm_valor === null || c.trm_valor === undefined || !c.tasa_cambio) return null;
  const diferencia = Math.round((c.tasa_cambio - c.trm_valor) * 10000) / 10000;
  return {
    trm_valor: c.trm_valor, trm_fecha: c.trm_fecha, trm_captura: c.trm_captura,
    tasa_cambio: c.tasa_cambio, tasa_origen: c.tasa_origen, tasa_nota: c.tasa_nota,
    diferencia_tasa: diferencia,
    diferencia_pct: c.trm_valor > 0 ? Math.round((diferencia / c.trm_valor) * 10000) / 100 : null,
  };
}

function listar(db, { desde, hasta, proveedor_id, q, estado, con_saldo, moneda, limite = 100, pagina = 1 } = {}) {
  const cond = [];
  const params = [];
  // `desde` sin hora: en SQLite 'YYYY-MM-DD' < 'YYYY-MM-DD 00:00:00', así que con el sufijo las compras guardadas solo con el día
  // (anteriores a guardar la hora) quedaban fuera de su propio día. Sin sufijo entran ambas formas; `hasta` sí lleva 23:59:59.
  if (desde) { cond.push('c.fecha >= ?'); params.push(desde); }
  if (hasta) { cond.push('c.fecha <= ?'); params.push(hasta + ' 23:59:59'); }
  if (proveedor_id) { cond.push('c.proveedor_id = ?'); params.push(proveedor_id); }
  if (estado) { cond.push('c.estado = ?'); params.push(estado); }
  if (moneda) { cond.push('c.moneda = ?'); params.push(moneda); }
  if (con_saldo) cond.push("c.saldo_pendiente > 0 AND c.estado = 'confirmada'");
  if (q) { cond.push('(c.numero LIKE ? OR c.numero_factura LIKE ? OR p.nombre LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const lim = Math.min(Number(limite) || 100, 500);
  const off = (Math.max(Number(pagina) || 1, 1) - 1) * lim;
  const compras = db.prepare(`SELECT c.*, p.nombre AS proveedor_nombre, (SELECT COUNT(*) FROM compra_items ci WHERE ci.compra_id = c.id) AS n_items
                              FROM compras c LEFT JOIN proveedores p ON p.id = c.proveedor_id ${where} ORDER BY c.fecha DESC, c.id DESC LIMIT ? OFFSET ?`).all(...params, lim, off);
  const total = db.prepare(`SELECT COUNT(*) n FROM compras c LEFT JOIN proveedores p ON p.id = c.proveedor_id ${where}`).get(...params).n;
  return { compras, total };
}

function compararProveedores(db, productoId) {
  return db.prepare(`SELECT pr.id AS proveedor_id, pr.nombre AS proveedor, l.costo_unitario, l.moneda, l.tasa_cambio, l.costo_unitario_moneda, l.fecha, c.numero AS compra_numero, l.cantidad_inicial
                     FROM lotes l JOIN proveedores pr ON pr.id = l.proveedor_id LEFT JOIN compras c ON c.id = l.compra_id
                     WHERE l.producto_id = ? AND l.origen = 'compra' AND l.estado <> 'anulado'
                     ORDER BY l.fecha DESC, l.id DESC LIMIT 100`).all(productoId);
}

module.exports = { crear, pagar, anular, corregirTasa, obtener, listar, compararProveedores, detectarDuplicado, validarTasa, referenciaTrm, comparacionTrm, completarTrmHistorica, CAPTURAS_TRM };
