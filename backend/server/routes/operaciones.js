'use strict';
// Compras, ventas, créditos, caja, gastos y documentos.
const express = require('express');
const { getDb, getConfig } = require('../db');
const { err, texto, booleano, cop, fechaCO, hoy } = require('../util');
const { requierePermiso } = require('../auth');
const compras = require('../services/compras');
const trm = require('../services/trm');
const ventas = require('../services/ventas');
const creditos = require('../services/creditos');
const caja = require('../services/caja');
const gastos = require('../services/gastos');
const archivos = require('../services/archivos');
const ocr = require('../services/ocr');
const pdf = require('../services/pdf');
const auditoria = require('../services/auditoria');

const { urlBase } = require('../util');

const router = express.Router();

// ---------- Compras ----------
const DIA = /^\d{4}-\d{2}-\d{2}$/;
router.get('/compras', requierePermiso('compras.ver'), (req, res) => {
  const q = req.query;
  const moneda = q.moneda ? String(q.moneda).toUpperCase() : '';
  res.json(compras.listar(getDb(), {
    desde: DIA.test(q.desde || '') ? q.desde : null, hasta: DIA.test(q.hasta || '') ? q.hasta : null,
    proveedor_id: Number(q.proveedor_id) > 0 ? Number(q.proveedor_id) : null,
    moneda: ['COP', 'USD'].includes(moneda) ? moneda : null,
    q: q.q, estado: q.estado, con_saldo: booleano(q.con_saldo), limite: q.limite, pagina: q.pagina,
  }));
});
router.get('/compras/:id', requierePermiso('compras.ver'), (req, res) => res.json(compras.obtener(getDb(), Number(req.params.id))));
router.post('/compras', requierePermiso('compras.crear'), async (req, res) => {
  const db = getDb();
  // compras.crear es síncrona y solo mira el histórico local: antes se intenta traer la TRM oficial de la fecha (caché o API)
  // para que la compra guarde su TRM de referencia. Si no hay red o la fecha es inválida, crear() decide (manual / no disponible).
  try {
    const dia = String((req.body && req.body.fecha) || hoy()).slice(0, 10);
    if (DIA.test(dia) && dia <= hoy()) await trm.trmParaFecha(db, dia);
  } catch { /* sin red o sin dato: la compra queda con TRM manual o 'no_disponible' */ }
  res.status(201).json(compras.crear(db, req.body, req.usuario));
});
router.post('/compras/:id/pagos', requierePermiso('compras.pagar'), (req, res) => {
  const b = { ...req.body };
  if (b.comprobante) b.comprobante_ruta = archivos.guardarDesdeBase64(b.comprobante, b.comprobante_mime, 'comprobante').ruta;
  res.status(201).json(compras.pagar(getDb(), Number(req.params.id), b, req.usuario));
});
router.post('/compras/:id/anular', requierePermiso('compras.anular'), (req, res) => res.json(compras.anular(getDb(), Number(req.params.id), req.body.motivo, req.usuario)));

// ---------- Ventas ----------
router.get('/ventas', requierePermiso('ventas.ver'), (req, res) => {
  const q = req.query;
  res.json(ventas.listar(getDb(), { desde: q.desde, hasta: q.hasta, cliente_id: q.cliente_id, vendedor_id: q.vendedor_id, estado: q.estado, tipo_pago: q.tipo_pago, q: q.q, limite: q.limite, pagina: q.pagina }));
});
router.get('/ventas/:id', requierePermiso('ventas.ver'), (req, res) => res.json(ventas.obtener(getDb(), Number(req.params.id))));
router.post('/ventas', requierePermiso('ventas.crear'), (req, res) => {
  const b = { ...req.body };
  if (Array.isArray(b.pagos)) {
    b.pagos = b.pagos.map((p) => (p.comprobante ? { ...p, comprobante_ruta: archivos.guardarDesdeBase64(p.comprobante, p.comprobante_mime, 'comprobante').ruta, comprobante: undefined } : p));
  }
  res.status(201).json(ventas.crear(getDb(), b, req.usuario));
});
router.post('/ventas/:id/devolucion', requierePermiso('ventas.devolver'), (req, res) => res.json(ventas.devolver(getDb(), Number(req.params.id), req.body, req.usuario)));
router.post('/ventas/:id/anular', requierePermiso('ventas.anular'), (req, res) => res.json(ventas.anular(getDb(), Number(req.params.id), req.body.motivo, req.usuario)));
router.get('/ventas/:id/pdf', requierePermiso('ventas.ver'), async (req, res) => {
  const db = getDb();
  const v = ventas.obtener(db, Number(req.params.id));
  const buffer = await pdf.comprobanteVenta(db, v);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.descargar ? 'attachment' : 'inline'}; filename="comprobante-${v.numero}.pdf"`);
  res.send(buffer);
});
router.get('/ventas/:id/compartir', requierePermiso('ventas.ver'), (req, res) => {
  const db = getDb();
  const v = ventas.obtener(db, Number(req.params.id));
  const base = urlBase(req);
  const url = `${base}/comprobante/${v.token_publico}`;
  const negocio = getConfig(db, 'negocio_nombre');
  const lineas = v.items.map((it) => `• ${it.cantidad} x ${it.nombre_producto} – ${cop(it.total)}`).join('\n');
  const texto = `*${negocio}*\nComprobante ${v.numero} · ${fechaCO(v.fecha, true)}\n${v.cliente_nombre ? 'Cliente: ' + v.cliente_nombre + '\n' : ''}${lineas}\n*Total: ${cop(v.total)}*${v.credito ? `\nSaldo a crédito: ${cop(v.credito.saldo_actual)}` : ''}\n${url}`;
  const tel = (v.cliente_telefono || '').replace(/\D/g, '');
  const whatsapp = `https://wa.me/${tel ? (tel.length === 10 ? '57' + tel : tel) : ''}?text=${encodeURIComponent(texto)}`;
  res.json({ url, texto, whatsapp });
});

// ---------- Créditos ----------
router.get('/creditos', requierePermiso('creditos.ver'), (req, res) => res.json(creditos.listar(getDb(), { estado: req.query.estado, cliente_id: req.query.cliente_id, q: req.query.q })));
router.get('/creditos/:id', requierePermiso('creditos.ver'), (req, res) => res.json(creditos.obtener(getDb(), Number(req.params.id))));
router.post('/creditos/:id/abonos', requierePermiso('creditos.abonar'), (req, res) => {
  const b = { ...req.body };
  if (b.comprobante) b.comprobante_ruta = archivos.guardarDesdeBase64(b.comprobante, b.comprobante_mime, 'comprobante').ruta;
  res.status(201).json(creditos.abonar(getDb(), Number(req.params.id), b, req.usuario));
});
router.put('/creditos/:id', requierePermiso('creditos.modificar'), (req, res) => res.json(creditos.modificar(getDb(), Number(req.params.id), req.body, req.usuario)));
router.get('/clientes/:id/estado-cuenta/pdf', requierePermiso('clientes.ver', 'creditos.ver'), async (req, res) => {
  const db = getDb();
  const ec = creditos.estadoCuenta(db, Number(req.params.id));
  const buffer = await pdf.estadoCuenta(db, ec);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.descargar ? 'attachment' : 'inline'}; filename="estado-cuenta-${ec.cliente.id}.pdf"`);
  res.send(buffer);
});
router.get('/clientes/:id/estado-cuenta/compartir', requierePermiso('clientes.ver', 'creditos.ver'), (req, res) => {
  const db = getDb();
  const ec = creditos.estadoCuenta(db, Number(req.params.id));
  const negocio = getConfig(db, 'negocio_nombre');
  const vigentes = ec.creditos.filter((c) => !['pagado', 'anulado'].includes(c.estado));
  const lineas = vigentes.map((c) => `• ${c.numero}: saldo ${cop(c.saldo_actual)}${c.proximo_vencimiento ? ' (próx. ' + fechaCO(c.proximo_vencimiento) + ')' : ''}`).join('\n');
  const texto = `*${negocio}* · Estado de cuenta\nCliente: ${ec.cliente.nombre}\n${lineas || 'Sin créditos vigentes'}\n*Saldo total: ${cop(ec.saldo_total)}*`;
  const tel = (ec.cliente.telefono || '').replace(/\D/g, '');
  res.json({ texto, whatsapp: `https://wa.me/${tel ? (tel.length === 10 ? '57' + tel : tel) : ''}?text=${encodeURIComponent(texto)}` });
});

// ---------- Caja ----------
router.get('/caja', requierePermiso('caja.ver'), (req, res) => {
  const db = getDb();
  const s = caja.sesionAbierta(db);
  res.json({ abierta: s ? caja.obtener(db, s.id) : null, historial: caja.historial(db, { limite: 30 }) });
});
router.get('/caja/:id', requierePermiso('caja.ver'), (req, res) => res.json(caja.obtener(getDb(), Number(req.params.id))));
router.post('/caja/abrir', requierePermiso('caja.operar'), (req, res) => res.status(201).json(caja.abrir(getDb(), req.body, req.usuario)));
router.post('/caja/cerrar', requierePermiso('caja.operar'), (req, res) => res.json(caja.cerrar(getDb(), req.body, req.usuario)));
router.post('/caja/movimientos', requierePermiso('caja.operar'), (req, res) => res.status(201).json(caja.movimiento(getDb(), req.body, req.usuario)));

// ---------- Gastos ----------
router.get('/gastos', requierePermiso('caja.ver'), (req, res) => res.json(gastos.listar(getDb(), { desde: req.query.desde, hasta: req.query.hasta, categoria: req.query.categoria })));
router.post('/gastos', requierePermiso('caja.gastos'), (req, res) => {
  const b = { ...req.body };
  if (b.comprobante) b.comprobante_ruta = archivos.guardarDesdeBase64(b.comprobante, b.comprobante_mime, 'comprobante').ruta;
  res.status(201).json(gastos.crear(getDb(), b, req.usuario));
});
router.delete('/gastos/:id', requierePermiso('caja.operar', 'eliminar'), (req, res) => res.json(gastos.anular(getDb(), Number(req.params.id), req.usuario)));

// ---------- Documentos (bandeja) ----------
router.get('/documentos', requierePermiso('documentos.ver'), (req, res) => {
  const db = getDb();
  const estado = ['pendiente', 'procesado', 'descartado', 'todos'].includes(req.query.estado) ? req.query.estado : 'pendiente';
  const filas = db.prepare(`SELECT d.*, u.nombre AS usuario_nombre, c.numero AS compra_numero FROM documentos d LEFT JOIN usuarios u ON u.id = d.usuario_id LEFT JOIN compras c ON c.id = d.compra_id
                            ${estado === 'todos' ? '' : 'WHERE d.estado = ?'} ORDER BY d.id DESC LIMIT 200`).all(...(estado === 'todos' ? [] : [estado]));
  for (const f of filas) { try { f.datos_ocr = f.datos_ocr ? JSON.parse(f.datos_ocr) : null; } catch { f.datos_ocr = null; } }
  res.json(filas);
});
function crearDocumento(db, b, usuario, origen) {
  const archivo = archivos.guardarDesdeBase64(b.archivo || b.imagen, b.mime, b.nombre);
  const tipo = ['factura_compra', 'comprobante', 'foto_producto', 'otro'].includes(b.tipo) ? b.tipo : 'factura_compra';
  const r = db.prepare('INSERT INTO documentos(tipo, origen, ruta, mime, nombre, tamano, nota, remitente, usuario_id) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(tipo, origen || b.origen || 'camara', archivo.ruta, archivo.mime, archivo.nombre, archivo.tamano, texto(b.nota, 'Nota', { opcional: true, max: 500 }), texto(b.remitente, 'Remitente', { opcional: true, max: 200 }), usuario.id);
  const id = Number(r.lastInsertRowid);
  auditoria.registrar(db, usuario, 'subir_documento', 'documento', id, { tipo, origen: origen || b.origen, nombre: archivo.nombre });
  return db.prepare('SELECT * FROM documentos WHERE id = ?').get(id);
}
async function procesarOcr(db, doc, usuario) {
  try {
    const datos = await ocr.extraerFactura(db, doc.ruta, doc.mime);
    const sugerido = ocr.sugerirProductos(db, datos);
    db.prepare("UPDATE documentos SET datos_ocr = ?, ocr_estado = 'ok' WHERE id = ?").run(JSON.stringify(sugerido), doc.id);
    auditoria.registrar(db, usuario, 'ocr_documento', 'documento', doc.id, { proveedor: datos.proveedor, total: datos.total, items: datos.items.length, confianza: datos.confianza });
    return sugerido;
  } catch (e) {
    db.prepare("UPDATE documentos SET ocr_estado = ? WHERE id = ?").run(`error: ${e.message}`.slice(0, 300), doc.id);
    throw e;
  }
}
router.post('/documentos', requierePermiso('documentos.ver', 'compras.crear'), (req, res) => {
  res.status(201).json(crearDocumento(getDb(), req.body, req.usuario, req.body.origen));
});
router.get('/documentos/:id', requierePermiso('documentos.ver'), (req, res) => {
  const db = getDb();
  const d = db.prepare('SELECT * FROM documentos WHERE id = ?').get(Number(req.params.id));
  if (!d) throw err.noEncontrado('Documento no existe');
  try { d.datos_ocr = d.datos_ocr ? JSON.parse(d.datos_ocr) : null; } catch { d.datos_ocr = null; }
  res.json(d);
});
router.post('/documentos/:id/ocr', requierePermiso('documentos.procesar', 'compras.crear'), async (req, res) => {
  const db = getDb();
  const d = db.prepare('SELECT * FROM documentos WHERE id = ?').get(Number(req.params.id));
  if (!d) throw err.noEncontrado('Documento no existe');
  res.json({ documento_id: d.id, datos: await procesarOcr(db, d, req.usuario) });
});
router.post('/documentos/:id/descartar', requierePermiso('documentos.procesar'), (req, res) => {
  const db = getDb();
  const motivo = texto(req.body.motivo, 'Motivo', { opcional: true, max: 300 });
  const d = db.prepare('SELECT id FROM documentos WHERE id = ?').get(Number(req.params.id));
  if (!d) throw err.noEncontrado('Documento no existe');
  db.prepare("UPDATE documentos SET estado = 'descartado', nota = COALESCE(?, nota) WHERE id = ?").run(motivo, d.id);
  auditoria.registrar(db, req.usuario, 'descartar_documento', 'documento', d.id, { motivo });
  res.json({ ok: true });
});
router.get('/archivos/:anio/:mes/:nombre', requierePermiso('documentos.ver', 'inventario.ver', 'ventas.ver', 'caja.ver'), (req, res) => {
  const ruta = `${req.params.anio}/${req.params.mes}/${req.params.nombre}`;
  const abs = archivos.rutaAbsoluta(ruta);
  // Los archivos subidos se sirven aislados: sin ejecutar scripts y con su tipo real.
  res.sendFile(abs, { headers: { 'Cache-Control': 'private, max-age=86400', 'Content-Type': archivos.mimeDe(abs), 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox", 'X-Content-Type-Options': 'nosniff' } }, (e) => { if (e && !res.headersSent) res.status(404).json({ error: 'Archivo no encontrado', codigo: 'no_encontrado' }); });
});

// ---------- Webhooks (n8n / correo) ----------
// POST /api/webhooks/documentos con cabecera X-Api-Token. Cuerpo: { archivo: "data:...;base64,...", nombre, remitente, nota, ocr: true }
router.post('/webhooks/documentos', requierePermiso('documentos.procesar'), async (req, res) => {
  const db = getDb();
  const doc = crearDocumento(db, req.body, req.usuario, 'email');
  let propuesta = null;
  let errorOcr = null;
  if (booleano(req.body.ocr, true) && ocr.disponible()) {
    try { propuesta = await procesarOcr(db, doc, req.usuario); } catch (e) { errorOcr = e.message; }
  }
  res.status(201).json({ documento_id: doc.id, estado: 'pendiente', propuesta, error_ocr: errorOcr, mensaje: 'Documento guardado en la bandeja. La compra NO se registra hasta que un usuario la confirme en la aplicación.' });
});
router.get('/webhooks/ping', requierePermiso('documentos.procesar'), (req, res) => res.json({ ok: true, usuario: req.usuario.nombre, ocr: ocr.disponible() }));

module.exports = router;
