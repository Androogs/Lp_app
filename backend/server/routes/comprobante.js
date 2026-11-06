'use strict';
// Comprobante público de venta (enlace compartido por WhatsApp). Solo accesible con el token aleatorio de la venta;
// no se indexa en buscadores y tiene límite de consultas por IP.
const express = require('express');
const { getDb, getConfigTodo } = require('../db');
const { cop, fechaCO } = require('../util');
const ventas = require('../services/ventas');
const pdf = require('../services/pdf');
const limites = require('../limites');

const router = express.Router();
const TOKEN = /^[a-f0-9]{24,64}$/;
router.use(limites.comprobante, (req, res, next) => { res.setHeader('X-Robots-Tag', 'noindex, nofollow'); res.setHeader('Cache-Control', 'private, no-store'); next(); });

// Logo de la marca incrustado como data URI (la política de contenido permite imágenes data:, y así el comprobante
// funciona igual en desarrollo, donde la interfaz la sirve Vite, y en producción).
const fs = require('node:fs');
const path = require('node:path');
let logoDataUri = null;
function logo() {
  if (logoDataUri !== null) return logoDataUri;
  try { logoDataUri = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'logo-palmira.png')).toString('base64'); } catch { logoDataUri = ''; }
  return logoDataUri;
}

const ESTILO = `:root{--tinta:#1a1410;--suave:#6b5f55;--linea:#ece5db;--ambar:#feb140;--rojo:#ef1c25}
*{box-sizing:border-box}body{font-family:-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;padding:20px 14px 32px;color:var(--tinta);background:#f6f1ea}
.c{max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 18px 40px -24px rgba(40,24,8,.45)}
.esp{height:6px;background:linear-gradient(90deg,#ef1c25 0 20%,#f2592a 20% 40%,#feb140 40% 60%,#89c93c 60% 80%,#399933 80%)}
.in{padding:20px 20px 22px}.cab{display:flex;gap:14px;align-items:center}.cab img{height:58px;width:auto}
h1{font-size:18px;margin:0;letter-spacing:-.01em}p{margin:3px 0;color:var(--suave);font-size:13.5px}
.num{display:flex;justify-content:space-between;gap:8px;margin-top:16px;padding:10px 12px;border-radius:10px;background:#faf6f0;font-size:13.5px}
.num b{color:var(--tinta)}table{width:100%;border-collapse:collapse;margin-top:14px;font-size:14px}
td,th{padding:9px 4px;border-bottom:1px solid var(--linea);text-align:left;vertical-align:top}th{font-size:12px;color:var(--suave);font-weight:600}
.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}small{color:var(--suave)}.may{display:inline-block;margin-top:3px;padding:1px 7px;border-radius:999px;background:#fff1d6;color:#8a5600;font-size:11px;font-weight:700}
.tot{margin-top:10px;font-size:14px}.tot div{display:flex;justify-content:space-between;padding:3px 4px;color:var(--suave)}
.tot .t{font-size:21px;font-weight:800;color:var(--tinta);border-top:2px solid var(--tinta);margin-top:6px;padding-top:9px}
.a{background:var(--rojo);color:#fff;padding:9px;border-radius:8px;text-align:center;font-weight:700;margin-top:14px}
a.b{display:block;margin-top:18px;background:var(--tinta);color:#fff;text-decoration:none;text-align:center;padding:13px;border-radius:999px;font-weight:700}
.leg{text-align:center;margin-top:16px;font-size:12px;line-height:1.45}`;

router.get('/:token', (req, res) => {
  const db = getDb();
  const v = TOKEN.test(req.params.token) ? ventas.obtenerPorToken(db, req.params.token) : null;
  if (!v) return res.status(404).send('<!doctype html><meta charset="utf-8"><p>Comprobante no encontrado.</p>');
  const cfg = getConfigTodo(db);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const filas = v.items.map((it) => `<tr><td>${esc(it.nombre_producto)}${it.tarifa === 'mayor' ? '<br><span class="may">Precio mayorista</span>' : ''}${it.seriales.length ? `<br><small>Serial: ${esc(it.seriales.join(', '))}</small>` : ''}</td><td class="n">${it.cantidad}</td><td class="n">${cop(it.precio_unitario)}</td><td class="n">${cop(it.total)}</td></tr>`).join('');
  const lineas = [
    (v.descuento || v.cargo_domicilio) ? `<div><span>Subtotal</span><span class="n">${cop(v.subtotal)}</span></div>` : '',
    v.descuento ? `<div><span>Descuento</span><span class="n">-${cop(v.descuento)}</span></div>` : '',
    v.cargo_domicilio ? `<div><span>Domicilio${v.domicilio_numero ? ' ' + esc(v.domicilio_numero) : ''}</span><span class="n">${cop(v.cargo_domicilio)}</span></div>` : '',
  ].join('');
  const img = logo();
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#120f0c"><title>Comprobante ${esc(v.numero)} · ${esc(cfg.negocio_nombre)}</title><style>${ESTILO}</style></head>
<body><div class="c"><div class="esp"></div><div class="in">
<div class="cab">${img ? `<img src="${img}" alt="${esc(cfg.negocio_nombre)}">` : ''}<div><h1>${esc(cfg.negocio_nombre)}</h1><p>${esc([cfg.negocio_nit && 'NIT ' + cfg.negocio_nit, cfg.negocio_direccion, cfg.negocio_ciudad, cfg.negocio_telefono].filter(Boolean).join(' · '))}</p></div></div>
<div class="num"><span><b>Comprobante ${esc(v.numero)}</b></span><span>${fechaCO(v.fecha, true)}</span></div>
<p style="margin-top:10px">Cliente: <b style="color:var(--tinta)">${esc(v.cliente_nombre || 'Consumidor final')}</b>${v.domicilio_direccion ? ` · Entregado en ${esc(v.domicilio_direccion)}` : ''}</p>
<table><thead><tr><th>Producto</th><th class="n">Cant.</th><th class="n">Precio</th><th class="n">Total</th></tr></thead><tbody>${filas}</tbody></table>
<div class="tot">${lineas}<div class="t"><span>Total</span><span class="n">${cop(v.total)}</span></div></div>
${v.credito ? `<p class="n" style="margin-top:6px">Saldo a crédito: ${cop(v.credito.saldo_actual)}</p>` : ''}${v.estado === 'anulada' ? '<div class="a">VENTA ANULADA</div>' : ''}
<a class="b" href="/comprobante/${esc(v.token_publico)}/pdf">Descargar PDF</a><p class="leg">${esc(cfg.mensaje_comprobante)}</p></div></div></body></html>`);
});

router.get('/:token/pdf', async (req, res) => {
  const db = getDb();
  const v = TOKEN.test(req.params.token) ? ventas.obtenerPorToken(db, req.params.token) : null;
  if (!v) return res.status(404).send('No encontrado');
  const buffer = await pdf.comprobanteVenta(db, v);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="comprobante-${v.numero}.pdf"`);
  res.send(buffer);
});


module.exports = router;
