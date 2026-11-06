'use strict';
// Recorre TODAS las rutas GET de la API (extraídas del código) con el administrador y verifica que ninguna falle con
// error interno. Ejecuta así cada consulta SQL de listados, paneles, reportes, PDF y CSV contra el esquema real.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { iniciar, detener, Cliente, CLAVES, getDb } = require('./ayuda');

test.before(iniciar);
test.after(detener);

function rutasGet() {
  const dir = path.join(__dirname, '..', 'server', 'routes');
  const rutas = new Set();
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/router\.get\('([^']+)'/g)) if (!['auth.js', 'comprobante.js'].includes(f)) rutas.add(m[1]);
  }
  return [...rutas];
}

function concretar(ruta, db) {
  const uno = (sql) => { try { const r = db.prepare(sql).get(); return r ? Object.values(r)[0] : 1; } catch { return 1; } };
  const ids = {
    '/ventas/:id': uno('SELECT id FROM ventas LIMIT 1'), '/compras/:id': uno('SELECT id FROM compras LIMIT 1'), '/creditos/:id': uno('SELECT id FROM creditos LIMIT 1'),
    '/clientes/:id': uno('SELECT id FROM clientes LIMIT 1'), '/productos/:id': uno('SELECT id FROM productos LIMIT 1'), '/proveedores/:id': uno('SELECT id FROM proveedores LIMIT 1'),
    '/caja/:id': uno('SELECT id FROM caja_sesiones LIMIT 1'), '/usuarios/:id': uno('SELECT id FROM usuarios LIMIT 1'),
    '/domicilios/:id': uno('SELECT id FROM domicilios LIMIT 1'),
  };
  let r = ruta;
  for (const [pref, id] of Object.entries(ids)) if (r.startsWith(pref)) r = r.replace(':id', id);
  return r.replace(':clave', 'inventario').replace(':codigo', 'NOEXISTE').replace(':fecha', '2026-01-01').replace(':anio/:mes/:nombre', '2026/01/' + 'a'.repeat(32) + '.png').replace(/:\w+/g, '1');
}

test('todas las rutas GET responden sin error interno', async () => {
  const c = new Cliente();
  await c.entrar('admin', CLAVES.admin);
  const db = getDb();
  const fallos = [];
  const rutas = rutasGet();
  assert.ok(rutas.length > 60, `se esperaban muchas rutas, hay ${rutas.length}`);
  for (const ruta of rutas) {
    const url = '/api' + concretar(ruta, db);
    for (const sufijo of ['', '?periodo=mes', '?desde=2026-01-01&hasta=2026-12-31']) {
      const r = await c.get(url + (url.includes('?') ? sufijo.replace('?', '&') : sufijo));
      if (r.status >= 500) fallos.push(`${url}${sufijo} → ${r.status} ${JSON.stringify(r.datos).slice(0, 200)}`);
    }
  }
  assert.deepEqual(fallos, []);
});

test('todos los reportes se generan en JSON, CSV y PDF', async () => {
  const c = new Cliente();
  await c.entrar('admin', CLAVES.admin);
  const lista = (await c.get('/api/reportes')).datos;
  const claves = (Array.isArray(lista) ? lista : lista.reportes || []).map((r) => r.clave);
  assert.ok(claves.length > 5);
  for (const clave of claves) {
    for (const formato of ['', '&formato=csv', '&formato=pdf']) {
      const r = await c.get(`/api/reportes/${clave}?desde=2026-01-01&hasta=2026-12-31${formato}`);
      assert.ok(r.status < 500, `${clave}${formato}: ${r.status} ${JSON.stringify(r.datos).slice(0, 200)}`);
    }
  }
});

test('cada rol puede abrir lo suyo sin errores internos', async () => {
  for (const u of ['carlos', 'luisa', 'pedro', 'conta']) {
    const c = new Cliente();
    await c.entrar(u, CLAVES[u]);
    for (const ruta of ['/api/auth/yo', '/api/dashboard', '/api/analitica/panel', '/api/productos', '/api/ventas', '/api/caja', '/api/creditos', '/api/domicilios', '/api/domicilios/resumen', '/api/repartidores', '/api/comisiones/resumen']) {
      const r = await c.get(ruta);
      assert.ok(r.status < 500, `${u} ${ruta}: ${r.status}`);
    }
  }
});
