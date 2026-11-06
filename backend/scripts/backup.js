'use strict';
// Copia de seguridad consistente de la base de datos (VACUUM INTO): `npm run backup` [ruta-destino.db]
const path = require('node:path');
const fs = require('node:fs');
const config = require('../server/config');
const { getDb, cerrarDb } = require('../server/db');

const destino = path.resolve(process.argv[2] || path.join(config.BACKUPS_DIR, `respaldo-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.db`));
if (fs.existsSync(destino)) { console.error('El archivo de destino ya existe:', destino); process.exit(1); }
fs.mkdirSync(path.dirname(destino), { recursive: true });
const db = getDb();
db.prepare('VACUUM INTO ?').run(destino);
cerrarDb();
console.log('Copia creada:', destino, `(${(fs.statSync(destino).size / 1024).toFixed(0)} KB)`);
console.log('Incluye solo la base de datos. Las fotos y facturas están en:', config.UPLOADS_DIR);
