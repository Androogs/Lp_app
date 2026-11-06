'use strict';
// Utilidades de prueba: arranca la aplicación en un puerto libre con una base temporal y datos de demostración.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'palmira-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = DIR;
process.env.TRM_DESACTIVAR_RED = '1';
process.env.FORCE_HTTPS = 'false';
process.env.COOKIE_SECURE = 'false';
delete process.env.APP_URL;

const { getDb } = require('../server/db');
const { sembrar } = require('../server/seed');
const { crearApp } = require('../server/index');

let servidor = null;
let base = '';
async function iniciar() {
  if (servidor) return base;
  const db = getDb();
  if (!db.prepare('SELECT COUNT(*) n FROM usuarios').get().n) sembrar(db, { silencioso: true });
  servidor = crearApp().listen(0, '127.0.0.1');
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  return base;
}
function detener() { if (servidor) servidor.close(); servidor = null; }

// Cliente con cookie y token CSRF, como el navegador.
class Cliente {
  constructor() { this.cookie = ''; this.csrf = ''; }
  async pedir(metodo, ruta, cuerpo, { cabeceras = {}, sinApp = false, sinCsrf = false } = {}) {
    const h = { ...cabeceras };
    if (!sinApp) h['X-Requested-With'] = 'PalmiraGestion';
    if (!sinCsrf && this.csrf && metodo !== 'GET') h['X-CSRF-Token'] = this.csrf;
    if (this.cookie) h.Cookie = this.cookie;
    if (cuerpo !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(base + ruta, { method: metodo, headers: h, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo), redirect: 'manual' });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    for (const c of sc) { const v = c.split(';')[0]; if (/=$/.test(v)) this.cookie = ''; else this.cookie = v; }
    const tipo = r.headers.get('content-type') || '';
    const datos = tipo.includes('json') ? await r.json() : await r.text();
    if (datos && datos.csrf) this.csrf = datos.csrf;
    return { status: r.status, datos, headers: r.headers, setCookie: sc };
  }
  get(r, o) { return this.pedir('GET', r, undefined, o); }
  post(r, c = {}, o) { return this.pedir('POST', r, c, o); }
  put(r, c = {}, o) { return this.pedir('PUT', r, c, o); }
  del(r, o) { return this.pedir('DELETE', r, undefined, o); }
  async entrar(usuario, clave) { const r = await this.post('/api/auth/login', { usuario, clave }); if (r.status !== 200) throw new Error(`login ${usuario}: ${r.status} ${JSON.stringify(r.datos)}`); return r; }
}

const CLAVES = { admin: 'Demo2026*Palmira', carlos: 'Vendedor2026*', luisa: 'Cajera2026*', pedro: 'Inventario2026*', conta: 'Consulta2026*' };

module.exports = { iniciar, detener, Cliente, CLAVES, DIR, getDb };
