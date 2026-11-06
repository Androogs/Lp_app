'use strict';
// TRM y dólar, contabilidad, rentabilidad y correcciones de tasa.
const express = require('express');
const { getDb } = require('../db');
const { err, hoy } = require('../util');
const { requierePermiso, requiereAuth } = require('../auth');
const trm = require('../services/trm');
const contabilidad = require('../services/contabilidad');
const compras = require('../services/compras');
const ventas = require('../services/ventas');

const router = express.Router();

// ---------- TRM y dólar ----------
router.get('/trm/actual', requiereAuth, async (req, res) => res.json(await trm.resumen(getDb())));
router.post('/trm/actualizar', requierePermiso('contabilidad.ver', 'compras.crear', 'ventas.crear'), async (req, res) => {
  const db = getDb();
  await Promise.all([trm.actualizarTrm(db, { forzar: true }), trm.actualizarMercado(db, { forzar: true })]);
  res.json(await trm.resumen(db));
});
router.get('/trm/tasa', requiereAuth, async (req, res) => res.json(await trm.sugerirTasa(getDb(), req.query.fecha || hoy())));
router.get('/trm/historial', requierePermiso('contabilidad.ver', 'compras.crear', 'ventas.crear'), async (req, res) => res.json(await trm.historial(getDb(), { desde: req.query.desde, hasta: req.query.hasta, tipo: req.query.tipo })));
router.post('/trm/manual', requierePermiso('contabilidad.editar'), (req, res) => res.status(201).json(trm.registrarManual(getDb(), req.body, req.usuario)));

// ---------- Contabilidad ----------
const filtros = (q) => ({ periodo: q.periodo, desde: q.desde, hasta: q.hasta, granularidad: q.granularidad, producto_id: q.producto_id, categoria_id: q.categoria_id, proveedor_id: q.proveedor_id, moneda: q.moneda ? String(q.moneda).toUpperCase() : undefined, vendedor_id: q.vendedor_id });
router.get('/contabilidad/panel', requierePermiso('contabilidad.ver'), (req, res) => res.json(contabilidad.panel(getDb(), filtros(req.query))));
router.get('/contabilidad/operaciones', requierePermiso('contabilidad.ver'), (req, res) => res.json(contabilidad.operaciones(getDb(), filtros(req.query))));
router.get('/contabilidad/diferencias', requierePermiso('contabilidad.ver'), (req, res) => res.json(contabilidad.diferencias(getDb(), filtros(req.query))));
router.get('/contabilidad/tasas-aplicadas', requierePermiso('contabilidad.ver'), (req, res) => res.json(contabilidad.tasasAplicadas(getDb(), filtros(req.query))));
router.get('/contabilidad/comparacion-mensual', requierePermiso('contabilidad.ver'), (req, res) => res.json(contabilidad.comparacionMensual(getDb(), filtros(req.query))));
router.get('/contabilidad/productos/:id', requierePermiso('contabilidad.ver', 'inventario.ver'), (req, res) => {
  const r = contabilidad.producto(getDb(), Number(req.params.id));
  if (!r) throw err.noEncontrado('Producto no existe');
  res.json(r);
});

// ---------- Correcciones manuales de tasa (auditadas) ----------
router.put('/compras/:id/tasa', requierePermiso('contabilidad.editar'), (req, res) => res.json(compras.corregirTasa(getDb(), Number(req.params.id), req.body, req.usuario)));
router.put('/ventas/:id/tasa', requierePermiso('contabilidad.editar'), (req, res) => res.json(ventas.corregirTasa(getDb(), Number(req.params.id), req.body, req.usuario)));

module.exports = router;
