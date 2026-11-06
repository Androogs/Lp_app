'use strict';
// Domicilios y repartidores (flota propia).
const express = require('express');
const { getDb } = require('../db');
const { requierePermiso } = require('../auth');
const domicilios = require('../services/domicilios');

const router = express.Router();
const DIA = /^\d{4}-\d{2}-\d{2}$/;

router.get('/domicilios', requierePermiso('domicilios.ver'), (req, res) => {
  const q = req.query;
  res.json(domicilios.listar(getDb(), {
    estado: q.estado || undefined, q: q.q, repartidor_id: q.repartidor_id,
    desde: DIA.test(q.desde || '') ? q.desde : undefined, hasta: DIA.test(q.hasta || '') ? q.hasta : undefined, limite: q.limite,
  }));
});
router.get('/domicilios/resumen', requierePermiso('domicilios.ver'), (req, res) => res.json(domicilios.resumen(getDb())));
router.get('/domicilios/:id', requierePermiso('domicilios.ver'), (req, res) => res.json(domicilios.obtener(getDb(), Number(req.params.id))));
router.post('/domicilios', requierePermiso('domicilios.crear'), (req, res) => res.status(201).json(domicilios.crear(getDb(), req.body, req.usuario)));
router.put('/domicilios/:id', requierePermiso('domicilios.crear', 'domicilios.despachar'), (req, res) => res.json(domicilios.actualizar(getDb(), Number(req.params.id), req.body, req.usuario)));
for (const accion of ['preparar', 'despachar', 'entregar', 'cancelar', 'reabrir']) {
  router.post(`/domicilios/:id/${accion}`, requierePermiso('domicilios.despachar'), (req, res) => res.json(domicilios.cambiarEstado(getDb(), Number(req.params.id), accion, req.body || {}, req.usuario)));
}
// Cotización: precios y tarifa de los ítems antes de guardar (misma regla del punto de venta).
router.post('/domicilios/cotizar', requierePermiso('domicilios.crear'), (req, res) => {
  const db = getDb();
  const cliente = req.body.cliente_id ? db.prepare('SELECT tipo_cliente FROM clientes WHERE id = ?').get(Number(req.body.cliente_id)) : null;
  const items = domicilios.calcularItems(db, req.body.items, !!(cliente && cliente.tipo_cliente === 'mayorista'));
  const cfg = domicilios.configDomicilios(db);
  const subtotal = items.reduce((s, it) => s + it.total, 0);
  const sugerido = cfg.envio_gratis_desde > 0 && subtotal >= cfg.envio_gratis_desde ? 0 : cfg.cargo_envio_defecto;
  res.json({ items: items.map((it) => ({ producto_id: it.producto.id, cantidad: it.cantidad, tarifa: it.tarifa, precio_unitario: it.precio, total: it.total })), subtotal, cargo_sugerido: sugerido });
});

router.get('/repartidores', requierePermiso('domicilios.ver'), (req, res) => res.json(domicilios.repartidores(getDb(), { todos: req.query.todos === '1' })));
router.post('/repartidores', requierePermiso('domicilios.despachar'), (req, res) => res.status(201).json(domicilios.guardarRepartidor(getDb(), null, req.body, req.usuario)));
router.put('/repartidores/:id', requierePermiso('domicilios.despachar'), (req, res) => res.json(domicilios.guardarRepartidor(getDb(), Number(req.params.id), req.body, req.usuario)));

module.exports = router;
