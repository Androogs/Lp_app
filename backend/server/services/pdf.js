'use strict';
// PDFs: comprobante de venta y estado de cuenta (pdfkit, sin dependencias nativas).
const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');
const { getConfigTodo } = require('../db');
const { cop, fechaCO } = require('../util');

const METODOS = { efectivo: 'Efectivo', transferencia: 'Transferencia', nequi: 'Nequi', daviplata: 'Daviplata', tarjeta: 'Tarjeta', qr: 'Código QR', otro: 'Otro' };
// Identidad de Licores Palmira en los documentos: logo a color y franja con las cinco botellas de la marca.
const LOGO = path.join(__dirname, '..', '..', 'assets', 'logo-palmira.png');
const ESPECTRO = ['#ef1c25', '#f2592a', '#feb140', '#89c93c', '#399933'];
const ESTADOS_CREDITO = { al_dia: 'Al día', proximo: 'Próximo a vencer', vencido: 'Vencido', parcial: 'Parcialmente pagado', pagado: 'Pagado', anulado: 'Anulado' };

function aBuffer(doc) {
  return new Promise((resolve, reject) => {
    const partes = [];
    doc.on('data', (c) => partes.push(c));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.on('error', reject);
    doc.end();
  });
}

function franja(doc) {
  const ancho = doc.page.width / ESPECTRO.length;
  ESPECTRO.forEach((c, i) => doc.rect(i * ancho, 0, ancho + 0.5, 6).fill(c));
  doc.fillColor('#000');
}

function encabezado(doc, cfg, titulo, subtitulo) {
  franja(doc);
  const x0 = doc.page.margins.left;
  const y0 = doc.y;
  const conLogo = fs.existsSync(LOGO);
  if (conLogo) doc.image(LOGO, x0, y0, { height: 58 });
  const xt = conLogo ? x0 + 88 : x0;
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#1a1410').text(cfg.negocio_nombre || 'Licores Palmira', xt, y0 + 4, { align: 'left' });
  doc.font('Helvetica').fontSize(9).fillColor('#5b5048');
  const lineas = [cfg.negocio_nit ? `NIT ${cfg.negocio_nit}` : null, cfg.negocio_direccion, [cfg.negocio_ciudad, cfg.negocio_telefono].filter(Boolean).join(' · ')].filter(Boolean);
  for (const l of lineas) doc.text(l, xt);
  doc.x = x0;
  doc.y = Math.max(doc.y, y0 + 62);
  doc.moveDown(0.5);
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(13).text(titulo);
  if (subtitulo) doc.font('Helvetica').fontSize(9).fillColor('#444').text(subtitulo).fillColor('#000');
  doc.moveDown(0.5);
  doc.moveTo(doc.x, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#dddddd').stroke();
  doc.moveDown(0.5);
}

function tabla(doc, columnas, filas, { anchoTotal } = {}) {
  const x0 = doc.page.margins.left;
  const ancho = anchoTotal || doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const pesos = columnas.map((c) => c.peso || 1);
  const sumaPesos = pesos.reduce((a, b) => a + b, 0);
  const anchos = pesos.map((p) => (ancho * p) / sumaPesos);
  const fila = (valores, negrita) => {
    if (doc.y > doc.page.height - 80) doc.addPage();
    const y = doc.y;
    let x = x0;
    doc.font(negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
    let alto = 0;
    valores.forEach((v, i) => {
      const txt = v == null ? '' : String(v);
      const h = doc.heightOfString(txt, { width: anchos[i] - 6 });
      alto = Math.max(alto, h);
      doc.text(txt, x + 3, y, { width: anchos[i] - 6, align: columnas[i].alinear || 'left' });
      x += anchos[i];
    });
    doc.y = y + alto + 4;
    doc.moveTo(x0, doc.y).lineTo(x0 + ancho, doc.y).strokeColor('#eeeeee').stroke();
    doc.y += 2;
  };
  fila(columnas.map((c) => c.titulo), true);
  for (const f of filas) fila(columnas.map((c) => (typeof c.valor === 'function' ? c.valor(f) : f[c.clave])), false);
  doc.x = x0;
}

async function comprobanteVenta(db, venta) {
  const cfg = getConfigTodo(db);
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Comprobante ${venta.numero}` } });
  encabezado(doc, cfg, `Comprobante de venta ${venta.numero}`, `Fecha: ${fechaCO(venta.fecha, true)} · Atendió: ${venta.vendedor_nombre || ''}${venta.domicilio_numero ? ' · Domicilio ' + venta.domicilio_numero : ''}`);
  doc.font('Helvetica').fontSize(10);
  doc.text(`Cliente: ${venta.cliente_nombre || 'Consumidor final'}${venta.cliente_identificacion ? ' · ' + venta.cliente_identificacion : ''}${venta.cliente_telefono ? ' · ' + venta.cliente_telefono : ''}`);
  doc.moveDown(0.5);
  tabla(doc, [
    { titulo: 'Producto', peso: 4, valor: (it) => it.nombre_producto + (it.tarifa === 'mayor' ? ' (precio mayorista)' : '') + (it.seriales && it.seriales.length ? `\nSerial/estampilla: ${it.seriales.join(', ')}` : '') },
    { titulo: 'Cant.', peso: 1, clave: 'cantidad', alinear: 'right' },
    { titulo: 'Precio', peso: 1.6, valor: (it) => cop(it.precio_unitario), alinear: 'right' },
    { titulo: 'Desc.', peso: 1.2, valor: (it) => (it.descuento ? cop(it.descuento) : ''), alinear: 'right' },
    { titulo: 'Total', peso: 1.8, valor: (it) => cop(it.total), alinear: 'right' },
  ], venta.items);
  doc.moveDown(0.5);
  const der = { align: 'right' };
  doc.font('Helvetica').fontSize(10);
  if (venta.descuento || venta.cargo_domicilio) doc.text(`Subtotal: ${cop(venta.subtotal)}`, der);
  if (venta.descuento) doc.text(`Descuento: -${cop(venta.descuento)}`, der);
  if (venta.cargo_domicilio) doc.text(`Domicilio${venta.domicilio_numero ? ' ' + venta.domicilio_numero : ''}: ${cop(venta.cargo_domicilio)}`, der);
  doc.font('Helvetica-Bold').fontSize(13).text(`TOTAL: ${cop(venta.total)}`, der);
  doc.font('Helvetica').fontSize(10);
  const pagos = (venta.pagos || []).filter((p) => !p.anulado && p.tipo === 'venta');
  if (pagos.length) doc.text(`Pagado: ${pagos.map((p) => `${METODOS[p.metodo_pago] || p.metodo_pago} ${cop(p.valor)}`).join(' · ')}`, der);
  if (venta.credito) {
    doc.moveDown(0.3);
    doc.text(`Crédito ${venta.credito.numero}: ${venta.credito.numero_cuotas} cuota(s) de ${cop(venta.credito.valor_cuota)} (${venta.credito.frecuencia}) · Saldo: ${cop(venta.credito.saldo_actual)}`, der);
  }
  if (venta.estado === 'anulada') doc.moveDown().font('Helvetica-Bold').fillColor('#ef1c25').text('VENTA ANULADA', { align: 'center' }).fillColor('#000');
  if (venta.observaciones) doc.moveDown().font('Helvetica').fontSize(9).text(`Observaciones: ${venta.observaciones}`);
  doc.moveDown();
  doc.font('Helvetica').fontSize(9).fillColor('#666').text(cfg.mensaje_comprobante || '', { align: 'center' });
  return aBuffer(doc);
}

async function estadoCuenta(db, ec) {
  const cfg = getConfigTodo(db);
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Estado de cuenta ${ec.cliente.nombre}` } });
  encabezado(doc, cfg, `Estado de cuenta · ${ec.cliente.nombre}`, `Generado: ${fechaCO(ec.generado, true)}${ec.cliente.telefono ? ' · Tel. ' + ec.cliente.telefono : ''}${ec.cliente.identificacion ? ' · ' + ec.cliente.identificacion : ''}`);
  doc.font('Helvetica-Bold').fontSize(12).text(`Saldo total pendiente: ${cop(ec.saldo_total)}`);
  doc.moveDown(0.5);
  for (const c of ec.creditos) {
    if (doc.y > doc.page.height - 160) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(11).text(`Crédito ${c.numero} · ${ESTADOS_CREDITO[c.estado] || c.estado}`);
    doc.font('Helvetica').fontSize(9).fillColor('#444')
      .text(`Fecha: ${fechaCO(c.fecha)} · Venta ${c.venta_numero || ''} · Financiado: ${cop(c.saldo_financiado)} · Abonado: ${cop(c.total_abonado)} · Saldo: ${cop(c.saldo_actual)}`)
      .fillColor('#000');
    doc.moveDown(0.3);
    tabla(doc, [
      { titulo: 'Cuota', peso: 1, clave: 'numero' },
      { titulo: 'Vence', peso: 2, valor: (q) => fechaCO(q.fecha_vencimiento) },
      { titulo: 'Valor', peso: 2, valor: (q) => cop(q.valor), alinear: 'right' },
      { titulo: 'Pagado', peso: 2, valor: (q) => cop(q.pagado), alinear: 'right' },
      { titulo: 'Pendiente', peso: 2, valor: (q) => cop(q.valor - q.pagado), alinear: 'right' },
      { titulo: 'Estado', peso: 1.5, valor: (q) => ({ pendiente: 'Pendiente', parcial: 'Parcial', pagada: 'Pagada' }[q.estado]) },
    ], c.cuotas);
    doc.moveDown(0.6);
  }
  if (ec.abonos.length) {
    if (doc.y > doc.page.height - 160) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(11).text('Abonos registrados');
    doc.moveDown(0.3);
    tabla(doc, [
      { titulo: 'Fecha', peso: 2, valor: (a) => fechaCO(a.fecha, true) },
      { titulo: 'Crédito', peso: 1.5, clave: 'credito_numero' },
      { titulo: 'Método', peso: 1.5, valor: (a) => METODOS[a.metodo_pago] || a.metodo_pago },
      { titulo: 'Referencia', peso: 2, clave: 'referencia' },
      { titulo: 'Valor', peso: 2, valor: (a) => cop(a.valor), alinear: 'right' },
    ], ec.abonos);
  }
  doc.moveDown();
  doc.font('Helvetica').fontSize(9).fillColor('#666').text(cfg.mensaje_comprobante || '', { align: 'center' });
  return aBuffer(doc);
}

// Reporte genérico en PDF (apaisado) con fecha de generación, periodo, moneda y criterios de cálculo.
const ES_DINERO = /precio|costo|valor|total|saldo|pagado|ganancia|financiado|abonado|subtotal|descuento|impuestos|base|recaudado|egresos|esperado|contado|diferencia|ingreso|compras$|^ventas$|devoluciones|gastos|utilidad|comision|credito$|capital/;
const ES_MONEDA = /_moneda$|_usd$/;
const NO_DINERO = /pct|unidades|stock|cantidad|dias|^n$|numero|tasa|lotes|minimo|inicial|restante|^compras$|^ventas$/;
function formatoCelda(clave, v) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'number') return String(v);
  if (/pct/.test(clave)) return `${v.toLocaleString('es-CO', { maximumFractionDigits: 1 })}%`;
  if (/tasa/.test(clave)) return v.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (ES_MONEDA.test(clave)) return v.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (ES_DINERO.test(clave) && !/unidades|stock|cantidad|dias|numero|lotes|minimo|inicial|restante/.test(clave) && !(clave === 'compras' && Number.isInteger(v) && v < 1000) && !(clave === 'ventas' && Number.isInteger(v) && v < 1000)) return cop(v);
  return v.toLocaleString('es-CO');
}
async function reportePdf(db, r) {
  const cfg = getConfigTodo(db);
  const apaisado = r.columnas.length > 6;
  const doc = new PDFDocument({ size: 'A4', layout: apaisado ? 'landscape' : 'portrait', margin: 30, info: { Title: r.titulo } });
  encabezado(doc, cfg, r.titulo, `Generado: ${fechaCO(r.generado, true)} · Periodo: ${r.periodo.desde ? fechaCO(r.periodo.desde) + ' – ' + fechaCO(r.periodo.hasta) : 'todo el historial'} · Moneda de presentación: ${r.moneda}`);
  doc.font('Helvetica').fontSize(8).fillColor('#444').text(`Criterios de cálculo: ${r.criterios}`).fillColor('#000');
  doc.moveDown(0.6);
  const numericas = new Set(r.columnas.filter((c) => r.filas.some((f) => typeof f[c.clave] === 'number')).map((c) => c.clave));
  tabla(doc, r.columnas.map((c) => ({ titulo: c.titulo, peso: /nota|producto|nombre|criterio|tercero|cliente|proveedor/.test(c.clave) ? 2.2 : 1, alinear: numericas.has(c.clave) ? 'right' : 'left', valor: (f) => formatoCelda(c.clave, f[c.clave]) })), r.filas.slice(0, 2000));
  if (r.totales && Object.keys(r.totales).length) {
    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fontSize(9).text('Totales: ' + r.columnas.filter((c) => r.totales[c.clave] !== undefined).map((c) => `${c.titulo} ${formatoCelda(c.clave, r.totales[c.clave])}`).join(' · '));
  }
  if (r.filas.length > 2000) doc.moveDown().font('Helvetica').fontSize(8).text(`Se muestran las primeras 2000 de ${r.filas.length} filas. Usa la exportación a Excel para el detalle completo.`);
  return aBuffer(doc);
}

module.exports = { comprobanteVenta, estadoCuenta, reportePdf, METODOS, ESTADOS_CREDITO };
