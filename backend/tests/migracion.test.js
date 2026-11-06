'use strict';
// Una base creada por la versión anterior se actualiza sola al abrirla, sin perder datos.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
process.env.NODE_ENV = 'test';
const { abrir } = require('../server/db');

test('migración de una base de la versión anterior', () => {
  const ruta = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'palmira-mig-')), 'vieja.db');
  const vieja = new DatabaseSync(ruta);
  vieja.exec(`
    CREATE TABLE usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, usuario TEXT NOT NULL UNIQUE, email TEXT, password_hash TEXT NOT NULL, rol TEXT NOT NULL, activo INTEGER NOT NULL DEFAULT 1, debe_cambiar_clave INTEGER NOT NULL DEFAULT 0, creado_en TEXT, ultimo_acceso TEXT);
    CREATE TABLE sesiones (token TEXT PRIMARY KEY, usuario_id INTEGER, expira_en TEXT, user_agent TEXT, ip TEXT);
    CREATE TABLE recuperacion_clave (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER, codigo TEXT, expira_en TEXT, usado INTEGER DEFAULT 0);
    CREATE TABLE configuracion (clave TEXT PRIMARY KEY, valor TEXT);
    CREATE TABLE ventas (id INTEGER PRIMARY KEY AUTOINCREMENT, numero TEXT NOT NULL UNIQUE, fecha TEXT NOT NULL, cliente_id INTEGER, vendedor_id INTEGER, subtotal INTEGER DEFAULT 0, descuento INTEGER DEFAULT 0, total INTEGER DEFAULT 0, costo_total INTEGER DEFAULT 0, ganancia INTEGER DEFAULT 0, tipo_pago TEXT, estado TEXT DEFAULT 'confirmada');
    INSERT INTO usuarios(nombre, usuario, password_hash, rol) VALUES ('Admin', 'admin', 'scrypt$aa$bb', 'admin');
    INSERT INTO sesiones VALUES ('tokenplano', 1, '2099-01-01', '', '');
    INSERT INTO recuperacion_clave(usuario_id, codigo, expira_en) VALUES (1, '123456', '2099-01-01');
    INSERT INTO configuracion VALUES ('api_token', '"tokenenclaro1234567890"');
    INSERT INTO ventas(numero, fecha, vendedor_id, total, ganancia) VALUES ('V-000001', '2026-01-01 10:00:00', 1, 50000, 20000);`);
  vieja.close();

  const db = abrir(ruta);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ventas').get().n, 1, 'conserva las ventas');
  assert.equal(db.prepare('SELECT responsable_tipo FROM ventas').get().responsable_tipo, 'empleador');
  assert.equal(db.prepare('SELECT moneda FROM ventas').get().moneda, 'COP');
  assert.ok(db.prepare('PRAGMA table_info(sesiones)').all().some((c) => c.name === 'token_hash'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sesiones').get().n, 0, 'sesiones en claro descartadas');
  assert.equal(db.prepare('SELECT usado FROM recuperacion_clave').get().usado, 1, 'códigos en claro invalidados');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM configuracion WHERE clave = 'api_token'").get().n, 0);
  assert.match(JSON.parse(db.prepare("SELECT valor FROM configuracion WHERE clave = 'api_token_hash'").get().valor), /^[a-f0-9]{64}$/);
  assert.ok(db.prepare('SELECT stock FROM v_stock LIMIT 1') !== null);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  db.close();
  // Abrir de nuevo no cambia nada (idempotente).
  abrir(ruta).close();
});
