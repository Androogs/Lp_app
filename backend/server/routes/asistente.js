'use strict';
// Asistente Tino: estado de configuración, conversaciones y mensajes. Montado en server/index.js bajo /api con sesión obligatoria.
// Todas las rutas exigen el permiso asistente.usar; las conversaciones son siempre las del propio usuario.
const express = require('express');
const { getDb } = require('../db');
const { requierePermiso } = require('../auth');
const asistente = require('../services/asistente');

const router = express.Router();
const usar = requierePermiso('asistente.usar');

router.get('/asistente/estado', usar, (req, res) => res.json(asistente.estado(getDb(), req.usuario)));
// Pendientes y alertas del usuario (contador de la mascota, notificaciones y resumen al abrir Tino). Solo lectura.
router.get('/asistente/avisos', usar, (req, res) => res.json(asistente.avisos(getDb(), req.usuario)));
router.get('/asistente/conversaciones', usar, (req, res) => res.json(asistente.conversaciones(getDb(), req.usuario)));
router.post('/asistente/conversaciones', usar, (req, res) => res.status(201).json(asistente.crearConversacion(getDb(), req.usuario, req.body || {})));
router.get('/asistente/conversaciones/:id', usar, (req, res) => res.json(asistente.obtenerConversacion(getDb(), req.usuario, Number(req.params.id))));
router.delete('/asistente/conversaciones/:id', usar, (req, res) => res.json(asistente.eliminarConversacion(getDb(), req.usuario, Number(req.params.id))));
// Express 5 envía al middleware de errores los rechazos de los manejadores async.
router.post('/asistente/mensajes', usar, async (req, res) => {
  const b = req.body || {};
  const contexto = b.contexto && typeof b.contexto === 'object' ? { ruta: String(b.contexto.ruta || '').slice(0, 120), titulo: String(b.contexto.titulo || '').slice(0, 120) } : {};
  res.json(await asistente.enviar(getDb(), req.usuario, { conversacion_id: b.conversacion_id ? Number(b.conversacion_id) : null, mensaje: b.mensaje, contexto }));
});

module.exports = router;
