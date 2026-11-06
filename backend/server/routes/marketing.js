'use strict';
// Marketing y analítica comercial: campañas, métricas, eventos web (UTM), clientes potenciales, atribución y sincronizaciones.
// `router` se monta en server/index.js bajo /api con sesión; `publico` bajo /api/publico/marketing SIN sesión (valida su propio
// token, limita por IP, acepta CORS desde cualquier origen y nunca devuelve datos del negocio).
const express = require('express');
const { getDb } = require('../db');
const { requierePermiso, tiene } = require('../auth');
const marketing = require('../services/marketing');

const router = express.Router();
const publico = express.Router();
const id = (req) => Number(req.params.id);
const cuerpo = (req) => (req.body && typeof req.body === 'object' ? req.body : {});
const filtros = (q) => ({ periodo: q.periodo, desde: q.desde, hasta: q.hasta });
const { urlBase: baseDe } = require('../util');
const veCifras = (u) => tiene(u, 'marketing.ver') || tiene(u, 'marketing.editar');
const enviarCsv = (res, nombre, contenido) => { res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${nombre}.csv"`); res.send(contenido); };

// ---------- Panel, embudo y rentabilidad (nunca para quien solo atiende clientes potenciales) ----------
router.get('/marketing/panel', requierePermiso('marketing.ver', 'marketing.editar'), (req, res) => res.json(marketing.panel(getDb(), filtros(req.query))));
router.get('/marketing/embudo', requierePermiso('marketing.ver', 'marketing.editar'), (req, res) => res.json(marketing.embudo(getDb(), filtros(req.query))));
router.get('/marketing/rentabilidad', requierePermiso('marketing.ver', 'marketing.editar'), (req, res) => res.json(marketing.rentabilidad(getDb(), { ...filtros(req.query), campana_id: req.query.campana_id })));
router.get('/marketing/eventos', requierePermiso('marketing.ver', 'marketing.editar'), (req, res) => {
  const q = req.query;
  res.json(marketing.listarEventos(getDb(), { tipo: q.tipo, campana_id: q.campana_id, visitante: q.visitante, desde: q.desde, hasta: q.hasta, limite: q.limite }));
});

// ---------- Campañas ----------
router.get('/marketing/campanas', requierePermiso('marketing.ver', 'marketing.editar', 'marketing.leads'), (req, res) => {
  const q = req.query; const db = getDb();
  const f = { estado: q.estado, plataforma: q.plataforma, q: q.q, periodo: q.periodo, desde: q.desde, hasta: q.hasta, limite: q.limite };
  if (q.formato === 'csv' && veCifras(req.usuario)) return enviarCsv(res, 'campanas', marketing.csvCampanas(db, f));
  // Quien solo atiende clientes potenciales ve la lista sin inversión ni resultados (y el filtro q no toca campos que no ve).
  res.json(marketing.listarCampanas(db, f, { conCifras: veCifras(req.usuario) }));
});
router.post('/marketing/campanas', requierePermiso('marketing.editar'), (req, res) => res.status(201).json(marketing.crearCampana(getDb(), cuerpo(req), req.usuario)));
router.get('/marketing/campanas/:id', requierePermiso('marketing.ver', 'marketing.editar'), (req, res) => res.json(marketing.obtenerCampana(getDb(), id(req), filtros(req.query))));
router.put('/marketing/campanas/:id', requierePermiso('marketing.editar'), (req, res) => res.json(marketing.actualizarCampana(getDb(), id(req), cuerpo(req), req.usuario)));
router.post('/marketing/campanas/:id/estado', requierePermiso('marketing.editar'), (req, res) => res.json(marketing.cambiarEstadoCampana(getDb(), id(req), cuerpo(req).estado, req.usuario)));
router.put('/marketing/campanas/:id/productos', requierePermiso('marketing.editar'), (req, res) => { const b = cuerpo(req); res.json(marketing.fijarProductos(getDb(), id(req), Array.isArray(b) ? b : (b.productos ?? b), req.usuario)); });
router.get('/marketing/campanas/:id/metricas', requierePermiso('marketing.ver', 'marketing.editar'), (req, res) => res.json(marketing.listarMetricas(getDb(), id(req), { desde: req.query.desde, hasta: req.query.hasta, limite: req.query.limite })));
router.post('/marketing/campanas/:id/metricas', requierePermiso('marketing.editar'), (req, res) => res.json(marketing.guardarMetricas(getDb(), id(req), cuerpo(req), req.usuario)));
router.delete('/marketing/campanas/:id/metricas/:fecha', requierePermiso('marketing.editar'), (req, res) => res.json(marketing.eliminarMetrica(getDb(), id(req), req.params.fecha, req.usuario)));

// ---------- Clientes potenciales ----------
const permisoLeads = requierePermiso('marketing.leads', 'marketing.editar', 'marketing.ver');
router.get('/marketing/leads/resumen', permisoLeads, (req, res) => res.json(marketing.resumenLeads(getDb(), filtros(req.query))));
router.get('/marketing/leads', permisoLeads, (req, res) => {
  const q = req.query; const db = getDb();
  const f = { estado: q.estado, canal: q.canal, campana_id: q.campana_id, q: q.q, desde: q.desde, hasta: q.hasta, limite: q.limite, pagina: q.pagina };
  if (q.formato === 'csv') return enviarCsv(res, 'clientes-potenciales', marketing.csvLeads(db, f));
  res.json(marketing.listarLeads(db, f));
});
router.post('/marketing/leads', requierePermiso('marketing.leads', 'marketing.editar'), (req, res) => res.status(201).json(marketing.crearLead(getDb(), cuerpo(req), req.usuario)));
router.get('/marketing/leads/:id', permisoLeads, (req, res) => res.json(marketing.obtenerLead(getDb(), id(req))));
router.put('/marketing/leads/:id', requierePermiso('marketing.leads', 'marketing.editar'), (req, res) => res.json(marketing.actualizarLead(getDb(), id(req), cuerpo(req), req.usuario)));
router.post('/marketing/leads/:id/estado', requierePermiso('marketing.leads', 'marketing.editar'), (req, res) => { const b = cuerpo(req); res.json(marketing.cambiarEstadoLead(getDb(), id(req), b.estado, req.usuario, b.nota)); });
router.post('/marketing/leads/:id/convertir', requierePermiso('marketing.leads', 'marketing.editar'), (req, res) => res.status(201).json(marketing.convertirLead(getDb(), id(req), cuerpo(req), req.usuario)));
// Un lead ya vinculado a otro cliente responde 409; `forzar: true` (solo con marketing.editar) lo re-vincula y queda auditado.
router.post('/marketing/leads/:id/vincular', requierePermiso('marketing.leads', 'marketing.editar'), (req, res) => { const b = cuerpo(req); res.json(marketing.vincularLead(getDb(), id(req), b.cliente_id, req.usuario, { forzar: b.forzar, motivo: b.motivo })); });

// ---------- Atribución manual de una venta ----------
router.get('/marketing/ventas/:id/atribucion', requierePermiso('marketing.ver', 'marketing.editar', 'ventas.ver'), (req, res) => res.json(marketing.atribucionDe(getDb(), id(req)) || { venta_id: id(req), tipo: null }));
router.post('/marketing/ventas/:id/atribucion', requierePermiso('marketing.editar'), (req, res) => res.json(marketing.cambiarAtribucion(getDb(), id(req), cuerpo(req), req.usuario)));

// ---------- Integraciones y seguimiento web ----------
router.get('/marketing/integraciones', requierePermiso('marketing.configurar', 'marketing.ver'), (req, res) => res.json(marketing.integraciones(getDb())));
router.post('/marketing/sincronizar/:plataforma', requierePermiso('marketing.configurar'), async (req, res) => { const b = cuerpo(req); res.json(await marketing.sincronizar(getDb(), req.params.plataforma, req.usuario, { desde: b.desde, hasta: b.hasta })); });
router.get('/marketing/seguimiento', requierePermiso('marketing.configurar', 'marketing.ver'), (req, res) => res.json(marketing.seguimiento(getDb(), baseDe(req), req.usuario)));
router.post('/marketing/seguimiento/token', requierePermiso('marketing.configurar'), (req, res) => res.json(marketing.rotarToken(getDb(), req.usuario)));

// ---------- Público: script y eventos del seguimiento web ----------
// Tamaño máximo del cuerpo de un evento (el script envía ~1 KB). El parser global de server/index.js (25 MB para OCR) NO debe
// aplicarse a estas rutas: index.js debe saltarlo para /api/publico/ y dejar que este router use sus propios parsers de 20 kb.
const LIMITE_CUERPO = '20kb';
const LIMITE_CUERPO_BYTES = 20 * 1024;
publico.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  // Rechazo temprano por tamaño declarado (antes de leer o parsear el cuerpo).
  if (Number(req.headers['content-length']) > LIMITE_CUERPO_BYTES) return res.status(413).json({ error: 'El evento es demasiado grande', codigo: 'muy_grande' });
  next();
});
// Acepta application/json y text/plain (petición "simple" sin preflight y compatible con sendBeacon), ambos con tope de 20 kb.
publico.use(express.json({ limit: LIMITE_CUERPO }));
publico.use(express.text({ type: ['text/plain', 'text/*'], limit: LIMITE_CUERPO }));
publico.get('/seguimiento.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(marketing.scriptSeguimiento(getDb(), baseDe(req)));
});
publico.post('/eventos', (req, res) => {
  const r = marketing.registrarEventoPublico(getDb(), req.body, { ip: req.ip, userAgent: req.headers['user-agent'] });
  res.json({ ok: true, lead: r.lead });
});
publico.get('/eventos', (req, res) => res.json({ ok: true, metodo: 'POST', formato: 'JSON { token, tipo, visitante, utm_source, utm_medium, utm_campaign, utm_content, utm_term, pagina, referente, producto_texto, datos }', limite_cuerpo: LIMITE_CUERPO }));

module.exports = { router, publico, LIMITE_CUERPO_BYTES };
