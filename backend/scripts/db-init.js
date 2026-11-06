'use strict';
// Crea la base de datos (o actualiza una existente) aplicando server/schema.sql y las migraciones. Es seguro ejecutarlo
// varias veces: nunca borra datos.   npm run db:init
const fs = require('node:fs');
const config = require('../server/config');
const { getDb, cerrarDb } = require('../server/db');

const db = getDb();
require('../server/services/productos').asegurarCategorias(db);
require('../server/arranque').crearAdminInicial(db);
const tablas = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get().n;
const usuarios = db.prepare('SELECT COUNT(*) n FROM usuarios').get().n;
const integridad = db.prepare('PRAGMA integrity_check').get();
cerrarDb();
console.log(`Base de datos lista: ${config.DB_PATH}`);
console.log(`  Tablas: ${tablas} · Usuarios: ${usuarios} · Integridad: ${Object.values(integridad)[0]}`);
console.log(`  Tamaño: ${(fs.statSync(config.DB_PATH).size / 1024).toFixed(0)} KB`);
if (!usuarios) console.log('\nNo hay usuarios todavía. Crea el administrador con `npm run crear-admin` o con INITIAL_ADMIN_USER / INITIAL_ADMIN_PASSWORD.');
