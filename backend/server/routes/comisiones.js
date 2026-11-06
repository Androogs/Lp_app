'use strict';
// Rentabilidad y comisiones. El vendedor solo ve lo propio (comisiones.ver_propias); el panel completo, salarios de otros,
// reasignaciones y liquidaciones exigen comisiones.ver / comisiones.administrar (validado aquí, no solo en la interfaz).
const express = require('express');
const { getDb } = require('../db');
const { err, hoy } = require('../util');
const { requierePermiso, tiene } = require('../auth');
const comisiones = require('../services/comisiones');
const pdf = require('../services/pdf');

const router = express.Router();
const filtros = (q) => ({ periodo: q.periodo, desde: q.desde, hasta: q.hasta, vendedor_id: q.vendedor_id, estado_pago: q.estado_pago, producto_id: q.producto_id });
const alcance = (req) => (tiene(req.usuario, 'comisiones.ver') || tiene(req.usuario, 'comisiones.administrar') ? 'todos' : 'propio');

router.get('/comisiones/resumen', requierePermiso('comisiones.ver_propias', 'comisiones.ver', 'comisiones.administrar'), (req, res) => {
  const a = alcance(req);
  if (a === 'propio' && req.query.vendedor_id && Number(req.query.vendedor_id) !== req.usuario.id) throw err.prohibido('Solo puedes consultar tus propias ventas y comisiones');
  res.json(comisiones.resumen(getDb(), filtros(req.query), { alcance: a, usuarioId: req.usuario.id }));
});
router.post('/comisiones/ventas/:id/responsable', requierePermiso('comisiones.administrar'), (req, res) => res.json(comisiones.reasignar(getDb(), Number(req.params.id), req.body, req.usuario)));

router.get('/comisiones/liquidaciones', requierePermiso('comisiones.ver_propias', 'comisiones.ver', 'comisiones.administrar'), (req, res) => {
  const a = alcance(req);
  res.json(comisiones.listar(getDb(), { vendedor_id: a === 'propio' ? req.usuario.id : req.query.vendedor_id }));
});
router.post('/comisiones/liquidaciones', requierePermiso('comisiones.administrar'), (req, res) => res.status(201).json(comisiones.cerrar(getDb(), req.body, req.usuario)));
router.get('/comisiones/liquidaciones/:id', requierePermiso('comisiones.ver_propias', 'comisiones.ver', 'comisiones.administrar'), async (req, res) => {
  const db = getDb();
  const l = comisiones.obtener(db, Number(req.params.id));
  if (alcance(req) === 'propio' && l.vendedor_id !== req.usuario.id) throw err.prohibido();
  if (req.query.formato === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${l.numero}.csv"`);
    return res.send(comisiones.reporteCsv(db, l.id));
  }
  if (req.query.formato === 'pdf') {
    const buffer = await pdf.reportePdf(db, comisiones.reporte(db, l.id));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.descargar ? 'attachment' : 'inline'}; filename="${l.numero}.pdf"`);
    return res.send(buffer);
  }
  res.json(l);
});
router.post('/comisiones/liquidaciones/:id/anular', requierePermiso('comisiones.administrar'), (req, res) => res.json(comisiones.anular(getDb(), Number(req.params.id), req.body.motivo, req.usuario)));
router.get('/comisiones/previa', requierePermiso('comisiones.administrar'), (req, res) => {
  // Vista previa de una liquidación antes de cerrarla (mismo cálculo, sin guardar).
  const db = getDb();
  const r = comisiones.resumen(db, { desde: req.query.desde, hasta: req.query.hasta || hoy(), vendedor_id: req.query.vendedor_id }, { alcance: 'todos' });
  res.json(r);
});

module.exports = router;
