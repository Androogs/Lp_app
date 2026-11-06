'use strict';
// Créditos, cuotas y abonos. Cada abono queda registrado como un pago independiente (nunca se sobrescribe).
// Un crédito nacido de una venta en USD se lleva en USD: cada abono registra su tasa y genera diferencia cambiaria frente a la tasa de la venta.
const { transaccion, siguienteNumero, getConfig } = require('../db');
const { err, ahora, hoy, entero, texto, decimal, fecha: vFecha, sumarFrecuencia, diasEntre, montoMoneda, tasaValida, aCop, dec2, copR } = require('../util');
const { tiene } = require('../permisos');
const auditoria = require('./auditoria');
const caja = require('./caja');

const FRECUENCIAS = ['diaria', 'semanal', 'quincenal', 'mensual'];

// Crea el crédito (se llama dentro de la transacción de la venta).
function crearDesdeVenta(db, { venta, cliente_id, saldo, saldo_moneda, cuota_inicial, cuota_inicial_moneda, config = {}, usuario }) {
  const moneda = venta.moneda || 'COP';
  const tasa = venta.tasa_cambio || 1;
  const interes = decimal(config.interes_pct, 'Interés', { min: 0, max: 100, opcional: true, defecto: 0 });
  const n = entero(config.numero_cuotas, 'Número de cuotas', { min: 1, max: 120, opcional: true, defecto: 1 });
  const frecuencia = FRECUENCIAS.includes(config.frecuencia) ? config.frecuencia : 'mensual';
  const saldoM = moneda === 'COP' ? saldo : (saldo_moneda ?? dec2(saldo / tasa));
  const financiadoM = moneda === 'COP' ? copR(saldoM * (1 + interes / 100)) : dec2(saldoM * (1 + interes / 100));
  const financiadoCop = moneda === 'COP' ? financiadoM : aCop(financiadoM, tasa);
  const primera = config.primera_fecha ? vFecha(config.primera_fecha, 'Primera fecha de pago') : sumarFrecuencia(hoy(), frecuencia, 1);
  const numero = siguienteNumero(db, 'credito', 'CR');
  const valorCuotaM = moneda === 'COP' ? Math.ceil(financiadoM / n) : dec2(Math.ceil((financiadoM / n) * 100) / 100);
  const r = db.prepare(`INSERT INTO creditos(numero, venta_id, cliente_id, fecha, valor_total, cuota_inicial, saldo_financiado, interes_pct, numero_cuotas, valor_cuota, frecuencia, primera_fecha, saldo_actual, estado, responsable_id, condiciones, moneda, tasa_cambio, saldo_financiado_moneda, saldo_moneda)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'al_dia',?,?,?,?,?,?)`)
    .run(numero, venta.id, cliente_id, ahora(), venta.total, cuota_inicial, financiadoCop, interes, n, moneda === 'COP' ? valorCuotaM : aCop(valorCuotaM, tasa), frecuencia, primera, financiadoCop,
      config.responsable_id || usuario.id, texto(config.condiciones, 'Condiciones', { opcional: true, max: 1000 }), moneda, tasa, financiadoM, financiadoM);
  const creditoId = Number(r.lastInsertRowid);
  const insCuota = db.prepare('INSERT INTO credito_cuotas(credito_id, numero, fecha_vencimiento, valor, valor_moneda) VALUES (?,?,?,?,?)');
  let acumM = 0, acumCop = 0;
  for (let i = 1; i <= n; i++) {
    const vM = i === n ? (moneda === 'COP' ? financiadoM - acumM : dec2(financiadoM - acumM)) : valorCuotaM;
    const vCop = moneda === 'COP' ? vM : (i === n ? financiadoCop - acumCop : aCop(vM, tasa));
    acumM = moneda === 'COP' ? acumM + vM : dec2(acumM + vM);
    acumCop += vCop;
    insCuota.run(creditoId, i, i === 1 ? primera : sumarFrecuencia(primera, frecuencia, i - 1), vCop, vM);
  }
  recalcularEstado(db, creditoId);
  auditoria.registrar(db, usuario, 'crear_credito', 'credito', creditoId, { numero, venta: venta.numero, moneda, tasa_cambio: tasa, saldo_financiado: financiadoCop, saldo_financiado_moneda: financiadoM, cuotas: n });
  return creditoId;
}

function recalcularEstado(db, creditoId) {
  const c = db.prepare('SELECT * FROM creditos WHERE id = ?').get(creditoId);
  if (!c || c.estado === 'anulado') return c;
  const dias = getConfig(db, 'dias_alerta_vencimiento') || 7;
  const h = hoy();
  let estado;
  if (c.saldo_actual <= 0 || (c.moneda !== 'COP' && (c.saldo_moneda || 0) < 0.01)) estado = 'pagado';
  else {
    const pendientes = db.prepare("SELECT * FROM credito_cuotas WHERE credito_id = ? AND estado <> 'pagada' ORDER BY numero").all(creditoId);
    const vencida = pendientes.find((q) => q.fecha_vencimiento < h);
    const proxima = pendientes.find((q) => q.fecha_vencimiento >= h && diasEntre(h, q.fecha_vencimiento) <= dias);
    const abonos = db.prepare("SELECT COUNT(*) n FROM pagos WHERE credito_id = ? AND tipo = 'abono' AND anulado = 0").get(creditoId).n;
    if (vencida) estado = 'vencido';
    else if (proxima) estado = 'proximo';
    else if (abonos > 0) estado = 'parcial';
    else estado = 'al_dia';
  }
  if (estado !== c.estado) {
    db.prepare("UPDATE creditos SET estado = ?, pagado_en = CASE WHEN ? = 'pagado' THEN COALESCE(pagado_en, ?) ELSE pagado_en END, saldo_actual = CASE WHEN ? = 'pagado' THEN 0 ELSE saldo_actual END, saldo_moneda = CASE WHEN ? = 'pagado' THEN 0 ELSE saldo_moneda END WHERE id = ?").run(estado, estado, ahora(), estado, estado, creditoId);
  }
  return { ...c, estado };
}

function recalcularTodos(db) {
  for (const { id } of db.prepare("SELECT id FROM creditos WHERE estado NOT IN ('pagado','anulado')").all()) recalcularEstado(db, id);
}

function abonar(db, creditoId, datos, usuario) {
  if (!tiene(usuario, 'creditos.abonar')) throw err.prohibido('No tienes permiso para registrar abonos');
  const c = db.prepare('SELECT * FROM creditos WHERE id = ?').get(creditoId);
  if (!c) throw err.noEncontrado('Crédito no existe');
  if (c.estado === 'anulado') throw err.conflicto('El crédito está anulado');
  if (c.saldo_actual <= 0) throw err.conflicto('El crédito ya está pagado');
  const metodos = getConfig(db, 'metodos_pago');
  const metodo = metodos.includes(datos.metodo_pago) ? datos.metodo_pago : 'efectivo';
  const fecha = datos.fecha ? vFecha(datos.fecha, 'Fecha') + (String(datos.fecha).length === 10 ? ' ' + ahora().slice(11) : '') : ahora();
  return transaccion(db, () => {
    let pagoId, valorCop, detalle;
    if (c.moneda !== 'COP') {
      const valorM = montoMoneda(datos.valor_moneda ?? datos.valor, `Valor del abono en ${c.moneda}`, c.moneda, { min: 0.01, max: (c.saldo_moneda || 0) + 0.005 });
      if (datos.tasa_cambio === undefined || datos.tasa_cambio === null || datos.tasa_cambio === '') throw err.datos('Indica la tasa de cambio del abono');
      const tasaPago = tasaValida(datos.tasa_cambio, 'Tasa del abono');
      const origen = ['trm', 'mercado', 'manual'].includes(datos.tasa_origen) ? datos.tasa_origen : 'manual';
      valorCop = aCop(valorM, tasaPago);
      const r = db.prepare("INSERT INTO pagos(fecha, tipo, venta_id, credito_id, cliente_id, valor, metodo_pago, referencia, comprobante_ruta, nota, usuario_id, caja_sesion_id, moneda, valor_moneda, tasa_cambio) VALUES (?,'abono',?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(fecha, c.venta_id, creditoId, c.cliente_id, valorCop, metodo, datos.referencia || null, datos.comprobante_ruta || null, texto(datos.nota, 'Nota', { opcional: true, max: 300 }), usuario.id, caja.sesionAbiertaId(db), c.moneda, valorM, tasaPago);
      pagoId = Number(r.lastInsertRowid);
      aplicarACuotasMoneda(db, creditoId, valorM, c.tasa_cambio);
      const nuevoSaldoM = dec2((c.saldo_moneda || 0) - valorM) < 0.01 ? 0 : dec2((c.saldo_moneda || 0) - valorM);
      db.prepare('UPDATE creditos SET saldo_moneda = ?, saldo_actual = ? WHERE id = ?').run(nuevoSaldoM, aCop(nuevoSaldoM, c.tasa_cambio), creditoId);
      // Diferencia cambiaria realizada: cobrar a una tasa mayor que la de la venta trae más pesos (ganancia) y viceversa.
      const diferencia = copR(valorM * (tasaPago - c.tasa_cambio));
      if (diferencia !== 0) {
        db.prepare("INSERT INTO diferencias_cambiarias(fecha, tipo, venta_id, credito_id, pago_id, moneda, valor_moneda, tasa_operacion, tasa_pago, diferencia, nota, usuario_id) VALUES (?,'abono_venta',?,?,?,?,?,?,?,?,?,?)")
          .run(fecha, c.venta_id, creditoId, pagoId, c.moneda, valorM, c.tasa_cambio, tasaPago, diferencia, `Abono de ${valorM} ${c.moneda} al crédito ${c.numero}`, usuario.id);
      }
      detalle = { valor_moneda: valorM, moneda: c.moneda, tasa_pago: tasaPago, tasa_origen: origen, valor_cop: valorCop, diferencia_cambiaria: diferencia, metodo, pago_id: pagoId };
    } else {
      valorCop = entero(datos.valor, 'Valor del abono', { min: 1, max: c.saldo_actual });
      const r = db.prepare("INSERT INTO pagos(fecha, tipo, venta_id, credito_id, cliente_id, valor, metodo_pago, referencia, comprobante_ruta, nota, usuario_id, caja_sesion_id, moneda, valor_moneda, tasa_cambio) VALUES (?,'abono',?,?,?,?,?,?,?,?,?,?,'COP',?,1)")
        .run(fecha, c.venta_id, creditoId, c.cliente_id, valorCop, metodo, datos.referencia || null, datos.comprobante_ruta || null, texto(datos.nota, 'Nota', { opcional: true, max: 300 }), usuario.id, caja.sesionAbiertaId(db), valorCop);
      pagoId = Number(r.lastInsertRowid);
      aplicarACuotas(db, creditoId, valorCop);
      db.prepare('UPDATE creditos SET saldo_actual = saldo_actual - ?, saldo_moneda = saldo_actual - ? WHERE id = ?').run(valorCop, valorCop, creditoId);
      detalle = { valor: valorCop, metodo, pago_id: pagoId };
    }
    recalcularEstado(db, creditoId);
    auditoria.registrar(db, usuario, 'abono', 'credito', creditoId, detalle);
    return { pago_id: pagoId, credito: obtener(db, creditoId) };
  });
}

function aplicarACuotas(db, creditoId, valor) {
  let restante = valor;
  for (const q of db.prepare("SELECT * FROM credito_cuotas WHERE credito_id = ? AND estado <> 'pagada' ORDER BY numero").all(creditoId)) {
    if (restante <= 0) break;
    const aplica = Math.min(q.valor - q.pagado, restante);
    const pagado = q.pagado + aplica;
    db.prepare('UPDATE credito_cuotas SET pagado = ?, pagado_moneda = ?, estado = ? WHERE id = ?').run(pagado, pagado, pagado >= q.valor ? 'pagada' : 'parcial', q.id);
    restante -= aplica;
  }
}
function aplicarACuotasMoneda(db, creditoId, valorM, tasaCredito) {
  let restante = valorM;
  for (const q of db.prepare("SELECT * FROM credito_cuotas WHERE credito_id = ? AND estado <> 'pagada' ORDER BY numero").all(creditoId)) {
    if (restante < 0.01) break;
    const falta = dec2((q.valor_moneda || 0) - (q.pagado_moneda || 0));
    const aplica = Math.min(falta, restante);
    const pagadoM = dec2((q.pagado_moneda || 0) + aplica);
    const completa = pagadoM >= (q.valor_moneda || 0) - 0.005;
    db.prepare('UPDATE credito_cuotas SET pagado_moneda = ?, pagado = ?, estado = ? WHERE id = ?').run(pagadoM, completa ? q.valor : aCop(pagadoM, tasaCredito), completa ? 'pagada' : 'parcial', q.id);
    restante = dec2(restante - aplica);
  }
}

// Reduce el saldo por una devolución (valor en COP): descuenta de las últimas cuotas pendientes.
function reducirSaldo(db, creditoId, valor, motivo, usuario) {
  const c = db.prepare('SELECT * FROM creditos WHERE id = ?').get(creditoId);
  if (!c || c.saldo_actual <= 0) return 0;
  const aplicado = Math.min(valor, c.saldo_actual);
  const enMoneda = c.moneda === 'COP';
  let restanteM = enMoneda ? aplicado : Math.min(dec2(aplicado / c.tasa_cambio), c.saldo_moneda || 0);
  const aplicadoM = restanteM;
  for (const q of db.prepare("SELECT * FROM credito_cuotas WHERE credito_id = ? AND estado <> 'pagada' ORDER BY numero DESC").all(creditoId)) {
    if (restanteM <= 0) break;
    const faltaM = enMoneda ? q.valor - q.pagado : dec2((q.valor_moneda || 0) - (q.pagado_moneda || 0));
    const quitaM = Math.min(faltaM, restanteM);
    const nuevoValorM = enMoneda ? q.valor - quitaM : dec2((q.valor_moneda || 0) - quitaM);
    const nuevoValorCop = enMoneda ? nuevoValorM : aCop(nuevoValorM, c.tasa_cambio);
    db.prepare("UPDATE credito_cuotas SET valor = ?, valor_moneda = ?, estado = CASE WHEN pagado >= ? THEN 'pagada' ELSE estado END WHERE id = ?").run(nuevoValorCop, nuevoValorM, nuevoValorCop, q.id);
    restanteM = enMoneda ? restanteM - quitaM : dec2(restanteM - quitaM);
  }
  const nuevoSaldoM = enMoneda ? c.saldo_actual - aplicado : dec2((c.saldo_moneda || 0) - aplicadoM);
  const nuevoSaldoCop = enMoneda ? c.saldo_actual - aplicado : aCop(nuevoSaldoM, c.tasa_cambio);
  db.prepare("UPDATE creditos SET saldo_actual = ?, saldo_moneda = ?, saldo_financiado = saldo_financiado - ?, saldo_financiado_moneda = COALESCE(saldo_financiado_moneda,0) - ?, condiciones = COALESCE(condiciones,'') || ? WHERE id = ?")
    .run(nuevoSaldoCop, nuevoSaldoM, c.saldo_actual - nuevoSaldoCop, enMoneda ? aplicado : aplicadoM, `\n[${hoy()}] Saldo reducido en ${c.saldo_actual - nuevoSaldoCop} por ${motivo}`, creditoId);
  recalcularEstado(db, creditoId);
  auditoria.registrar(db, usuario, 'reducir_saldo_credito', 'credito', creditoId, { valor: c.saldo_actual - nuevoSaldoCop, motivo });
  return c.saldo_actual - nuevoSaldoCop;
}

function anular(db, creditoId, motivo, usuario) {
  db.prepare("UPDATE creditos SET estado = 'anulado', saldo_actual = 0, saldo_moneda = 0, condiciones = COALESCE(condiciones,'') || ? WHERE id = ?").run(`\n[${hoy()}] Anulado: ${motivo}`, creditoId);
  auditoria.registrar(db, usuario, 'anular_credito', 'credito', creditoId, { motivo });
}

function modificar(db, creditoId, datos, usuario) {
  if (!tiene(usuario, 'creditos.modificar')) throw err.prohibido('No tienes permiso para modificar créditos');
  const c = db.prepare('SELECT * FROM creditos WHERE id = ?').get(creditoId);
  if (!c) throw err.noEncontrado('Crédito no existe');
  if (['pagado', 'anulado'].includes(c.estado)) throw err.conflicto('El crédito ya está cerrado');
  return transaccion(db, () => {
    const antes = { numero_cuotas: c.numero_cuotas, frecuencia: c.frecuencia, primera_fecha: c.primera_fecha, condiciones: c.condiciones, responsable_id: c.responsable_id };
    const condiciones = datos.condiciones === undefined ? c.condiciones : texto(datos.condiciones, 'Condiciones', { opcional: true, max: 1000 });
    const responsable = datos.responsable_id ? entero(datos.responsable_id, 'Responsable') : c.responsable_id;
    if (datos.reprogramar) {
      const n = entero(datos.numero_cuotas, 'Número de cuotas', { min: 1, max: 120 });
      const frecuencia = FRECUENCIAS.includes(datos.frecuencia) ? datos.frecuencia : c.frecuencia;
      const primera = vFecha(datos.primera_fecha, 'Primera fecha');
      db.prepare("DELETE FROM credito_cuotas WHERE credito_id = ? AND estado <> 'pagada'").run(creditoId);
      const pagadas = db.prepare('SELECT COUNT(*) n FROM credito_cuotas WHERE credito_id = ?').get(creditoId).n;
      const enMoneda = c.moneda === 'COP';
      const saldoM = enMoneda ? c.saldo_actual : c.saldo_moneda;
      const cuotaM = enMoneda ? Math.ceil(saldoM / n) : dec2(Math.ceil((saldoM / n) * 100) / 100);
      const ins = db.prepare('INSERT INTO credito_cuotas(credito_id, numero, fecha_vencimiento, valor, valor_moneda) VALUES (?,?,?,?,?)');
      let acumM = 0, acumCop = 0;
      for (let i = 1; i <= n; i++) {
        const vM = i === n ? (enMoneda ? saldoM - acumM : dec2(saldoM - acumM)) : cuotaM;
        const vCop = enMoneda ? vM : (i === n ? c.saldo_actual - acumCop : aCop(vM, c.tasa_cambio));
        acumM = enMoneda ? acumM + vM : dec2(acumM + vM); acumCop += vCop;
        ins.run(creditoId, pagadas + i, i === 1 ? primera : sumarFrecuencia(primera, frecuencia, i - 1), vCop, vM);
      }
      db.prepare('UPDATE creditos SET numero_cuotas = ?, valor_cuota = ?, frecuencia = ?, primera_fecha = CASE WHEN ? = 0 THEN ? ELSE primera_fecha END, condiciones = ?, responsable_id = ? WHERE id = ?')
        .run(pagadas + n, enMoneda ? cuotaM : aCop(cuotaM, c.tasa_cambio), frecuencia, pagadas, primera, condiciones, responsable, creditoId);
    } else {
      db.prepare('UPDATE creditos SET condiciones = ?, responsable_id = ? WHERE id = ?').run(condiciones, responsable, creditoId);
    }
    recalcularEstado(db, creditoId);
    auditoria.registrar(db, usuario, 'modificar_credito', 'credito', creditoId, { antes, despues: datos });
    return obtener(db, creditoId);
  });
}

function obtener(db, id) {
  recalcularEstado(db, id);
  const c = db.prepare(`SELECT c.*, cl.nombre AS cliente_nombre, cl.telefono AS cliente_telefono, cl.identificacion AS cliente_identificacion, v.numero AS venta_numero, u.nombre AS responsable_nombre
                        FROM creditos c JOIN clientes cl ON cl.id = c.cliente_id LEFT JOIN ventas v ON v.id = c.venta_id LEFT JOIN usuarios u ON u.id = c.responsable_id WHERE c.id = ?`).get(id);
  if (!c) throw err.noEncontrado('Crédito no existe');
  c.cuotas = db.prepare('SELECT * FROM credito_cuotas WHERE credito_id = ? ORDER BY numero').all(id);
  c.abonos = db.prepare("SELECT p.*, u.nombre AS usuario_nombre FROM pagos p LEFT JOIN usuarios u ON u.id = p.usuario_id WHERE p.credito_id = ? AND p.tipo = 'abono' ORDER BY p.fecha, p.id").all(id);
  c.total_abonado = c.abonos.filter((a) => !a.anulado).reduce((s, a) => s + a.valor, 0);
  c.total_abonado_moneda = c.moneda === 'COP' ? c.total_abonado : dec2(c.abonos.filter((a) => !a.anulado).reduce((s, a) => s + (a.valor_moneda || 0), 0));
  c.diferencias_cambiarias = db.prepare('SELECT * FROM diferencias_cambiarias WHERE credito_id = ? ORDER BY id').all(id);
  c.items = c.venta_id ? db.prepare('SELECT nombre_producto, cantidad, precio_unitario, total FROM venta_items WHERE venta_id = ?').all(c.venta_id) : [];
  c.proxima_cuota = c.cuotas.find((q) => q.estado !== 'pagada') || null;
  return c;
}

function listar(db, { estado, cliente_id, q, limite = 200 } = {}) {
  recalcularTodos(db);
  const cond = [];
  const params = [];
  if (estado === 'vigentes') cond.push("c.estado NOT IN ('pagado','anulado')");
  else if (estado) { cond.push('c.estado = ?'); params.push(estado); }
  if (cliente_id) { cond.push('c.cliente_id = ?'); params.push(cliente_id); }
  if (q) { cond.push('(cl.nombre LIKE ? OR c.numero LIKE ? OR cl.telefono LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  return db.prepare(`SELECT c.*, cl.nombre AS cliente_nombre, cl.telefono AS cliente_telefono, v.numero AS venta_numero,
                       (SELECT MIN(fecha_vencimiento) FROM credito_cuotas q WHERE q.credito_id = c.id AND q.estado <> 'pagada') AS proximo_vencimiento,
                       (SELECT COALESCE(SUM(valor),0) FROM pagos p WHERE p.credito_id = c.id AND p.tipo = 'abono' AND p.anulado = 0) AS total_abonado
                     FROM creditos c JOIN clientes cl ON cl.id = c.cliente_id LEFT JOIN ventas v ON v.id = c.venta_id ${where}
                     ORDER BY CASE c.estado WHEN 'vencido' THEN 0 WHEN 'proximo' THEN 1 WHEN 'parcial' THEN 2 WHEN 'al_dia' THEN 3 ELSE 4 END, proximo_vencimiento LIMIT ?`).all(...params, limite);
}

function estadoCuenta(db, clienteId) {
  const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(clienteId);
  if (!cliente) throw err.noEncontrado('Cliente no existe');
  const creditos = listar(db, { cliente_id: clienteId, limite: 500 }).map((c) => ({ ...c, cuotas: db.prepare('SELECT * FROM credito_cuotas WHERE credito_id = ? ORDER BY numero').all(c.id) }));
  const abonos = db.prepare("SELECT p.*, c.numero AS credito_numero FROM pagos p JOIN creditos c ON c.id = p.credito_id WHERE p.cliente_id = ? AND p.tipo = 'abono' AND p.anulado = 0 ORDER BY p.fecha DESC").all(clienteId);
  const saldoTotal = creditos.filter((c) => !['pagado', 'anulado'].includes(c.estado)).reduce((s, c) => s + c.saldo_actual, 0);
  return { cliente, creditos, abonos, saldo_total: saldoTotal, generado: ahora() };
}

module.exports = { FRECUENCIAS, crearDesdeVenta, recalcularEstado, recalcularTodos, abonar, reducirSaldo, anular, modificar, obtener, listar, estadoCuenta };
