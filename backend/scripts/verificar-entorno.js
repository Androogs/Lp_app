'use strict';
// Diagnóstico previo al despliegue: `npm run check`. Revisa versión de Node, SQLite integrado, variables de entorno,
// permisos de escritura en la carpeta de datos y que exista el build de la interfaz.
const fs = require('node:fs');
const path = require('node:path');

let errores = 0;
const ok = (m) => console.log(`  ✔ ${m}`);
const mal = (m) => { errores++; console.log(`  ✘ ${m}`); };
const aviso = (m) => console.log(`  ! ${m}`);

console.log('\nLicores Palmira · verificación del entorno\n');
const [ma, mi] = process.versions.node.split('.').map(Number);
if (ma > 22 || (ma === 22 && mi >= 13)) ok(`Node.js ${process.versions.node}`); else mal(`Node.js ${process.versions.node}: se requiere 22.13 o superior (elige Node 22 o 24 en el hosting)`);
try { require('node:sqlite'); ok('SQLite integrado (node:sqlite) disponible'); } catch { mal('node:sqlite no está disponible en esta versión de Node'); }

let config;
try { config = require('../server/config'); ok(`Configuración válida (NODE_ENV=${config.NODE_ENV})`); } catch (e) { mal(`Configuración inválida: ${e.message}`); process.exit(1); }
if (!config.PRODUCCION) aviso('NODE_ENV no es "production" (correcto para pruebas locales, no para el servidor)');
if (config.PRODUCCION && !config.APP_URL) aviso('APP_URL no está definida (recomendado: https://tudominio.com)');
if (config.PRODUCCION && !process.env.APP_SECRET) aviso('APP_SECRET no está definida: se generará y guardará en la carpeta de datos');
for (const a of config.advertenciasProduccion()) aviso(a);

try {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  const prueba = path.join(config.DATA_DIR, '.prueba-escritura');
  fs.writeFileSync(prueba, 'ok'); fs.unlinkSync(prueba);
  ok(`Carpeta de datos con permiso de escritura: ${config.DATA_DIR}`);
} catch (e) { mal(`No se puede escribir en DATA_DIR (${config.DATA_DIR}): ${e.message}`); }

try {
  const { getDb, cerrarDb } = require('../server/db');
  const db = getDb();
  const n = db.prepare('SELECT COUNT(*) n FROM usuarios').get().n;
  ok(`Base de datos: ${config.DB_PATH} (${n} usuario(s))`);
  if (!n && !(config.INITIAL_ADMIN_USER && config.INITIAL_ADMIN_PASSWORD)) aviso('No hay usuarios: define INITIAL_ADMIN_USER e INITIAL_ADMIN_PASSWORD o ejecuta `npm run crear-admin`');
  cerrarDb();
} catch (e) { mal(`Base de datos: ${e.message}`); }

if (fs.existsSync(path.join(config.FRONTEND_DIST, 'index.html'))) ok(`Build del frontend presente (${config.FRONTEND_DIST})`);
else (config.PRODUCCION ? mal : aviso)('Falta el build del frontend: ejecuta `npm run build` en la raíz del proyecto');
for (const m of ['express', 'helmet', 'bcryptjs', 'express-rate-limit', 'pdfkit']) { try { require.resolve(m); } catch { mal(`Falta la dependencia ${m}: ejecuta npm install`); } }
if (process.env.ANTHROPIC_API_KEY) ok('ANTHROPIC_API_KEY definida (OCR de facturas y asistente Tino activos)'); else aviso('ANTHROPIC_API_KEY no definida: el OCR y el asistente quedan desactivados (opcional)');

console.log(errores ? `\n${errores} problema(s) por resolver.\n` : '\nTodo listo.\n');
process.exit(errores ? 1 : 0);
