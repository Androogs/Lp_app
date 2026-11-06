'use strict';
// Acceso a la base de datos SQLite (módulo integrado node:sqlite: sin dependencias nativas que compilar en el hosting).
// Al abrir: aplica el esquema (idempotente), agrega columnas nuevas a bases antiguas y recrea vistas e índices.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const { DATA_DIR, UPLOADS_DIR, BACKUPS_DIR, DB_PATH } = config;
const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

const CONFIG_DEFAULT = {
  negocio_nombre: 'Licores Palmira',
  negocio_nit: '',
  negocio_direccion: '',
  negocio_telefono: '',
  negocio_ciudad: '',
  mensaje_comprobante: 'Gracias por tu compra. El exceso de alcohol es perjudicial para la salud. Prohíbese el expendio de bebidas embriagantes a menores de edad.',
  metodo_valoracion: 'FIFO',
  permitir_stock_negativo: false,
  descuento_maximo_pct: 10,
  dias_alerta_vencimiento: 7,
  metodos_pago: ['efectivo', 'transferencia', 'nequi', 'daviplata', 'tarjeta', 'qr', 'otro'],
  categorias_gasto: ['Arriendo', 'Servicios públicos', 'Nómina', 'Combustible y flota', 'Mantenimiento de vehículos', 'Hielo y desechables', 'Transporte', 'Comisiones', 'Publicidad', 'Impuestos y licencias', 'Reparaciones', 'Otros gastos'],
  dias_sin_movimiento: 30,
  ocr_modelo: 'claude-opus-5-5',
  api_token_hash: '',
  permisos_roles: null,
  // Contabilidad y tasa de cambio
  trm_frecuencia_minutos: 60,
  mercado_frecuencia_minutos: 30,
  moneda_presentacion: 'COP',
  politica_diferencia_cambiaria: 'realizada', // la diferencia se reconoce al pagar/cobrar en USD a una tasa distinta a la de la operación
  // Precio mayorista: la tarifa mayor se aplica sola desde estas unidades de una misma referencia (o al cliente mayorista).
  unidades_mayor: 10,
  // Domicilios con la flota propia (todo editable en Configuración › Domicilios y comisiones).
  domicilios: {
    cargo_envio_defecto: 5000,       // valor sugerido del envío al crear un domicilio (0 = sin cargo)
    envio_gratis_desde: 150000,      // pedidos desde este valor no pagan envío (0 = nunca gratis)
    minutos_alerta_preparacion: 20,  // aviso si un pedido lleva más de N minutos sin salir de la bodega
    minutos_alerta_camino: 60,       // aviso si un pedido lleva más de N minutos en camino
  },
  // Marketing y atribución de ventas a campañas (ver docs/MARKETING.md)
  marketing: {
    ventana_atribucion_dias: 30,     // una venta se atribuye como "estimada" si el cliente contactó por una campaña dentro de esta ventana
    token_seguimiento: '',           // token público del script de seguimiento web (vacío = no se aceptan eventos externos)
    canales: ['whatsapp', 'web', 'instagram', 'facebook', 'tiktok', 'google', 'referido', 'presencial', 'otro'],
  },
  // Asistente Tino (ver docs/ASISTENTE.md). La clave del proveedor va en variables de entorno, nunca aquí.
  asistente: {
    activo: true,
    motor: 'auto',                   // 'auto' (local + IA si hay clave) | 'local' (sin IA, sin costo) | 'ia' (todo con IA)
    proveedor: 'anthropic',          // 'anthropic' (SDK oficial) | 'openrouter'
    modelo: 'claude-opus-5-5',
    limite_mensajes_hora: 40,        // por usuario
    voz: true,                       // permite dictar por voz (reconocimiento del navegador) y leer respuestas
    nombre: 'Tino',
    avisos: true,                    // contador, burbuja y notificaciones de pendientes en la mascota
    dias_cobertura: 7,               // avisar cuando el stock de un producto alcance para menos de N días al ritmo de ventas actual
  },
  // Remuneración: salario y comisión por defecto para vendedores (cada usuario puede tener sus propios valores)
  comisiones: {
    salario_defecto: 1800000,
    comision_pct_defecto: 10,
    devengo: 'confirmacion',           // 'confirmacion' = al confirmar la venta · 'cobro' = solo ventas cobradas por completo
    empleador_comisiona: false,
  },
};


function asegurarCarpetas() {
  for (const dir of [DATA_DIR, UPLOADS_DIR, BACKUPS_DIR]) fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
}

// Divide el esquema en sentencias (no contiene triggers ni ';' dentro de literales).
function sentencias(sql) {
  return sql.replace(/^\s*--.*$/gm, '').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean);
}
const SENTENCIAS = sentencias(SCHEMA);
const TABLAS_SQL = SENTENCIAS.filter((s) => /^CREATE TABLE/i.test(s));
const OTRAS_SQL = SENTENCIAS.filter((s) => !/^CREATE TABLE/i.test(s));

// Columnas esperadas por tabla, leídas de una base en memoria construida con el esquema oficial.
let esperadas = null;
function columnasEsperadas() {
  if (esperadas) return esperadas;
  const mem = new DatabaseSync(':memory:');
  for (const s of TABLAS_SQL) mem.exec(s);
  esperadas = {};
  for (const { name } of mem.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
    esperadas[name] = mem.prepare(`PRAGMA table_info("${name}")`).all();
  }
  mem.close();
  return esperadas;
}

function abrir(ruta = DB_PATH) {
  if (ruta !== ':memory:') fs.mkdirSync(path.dirname(ruta), { recursive: true });
  const db = new DatabaseSync(ruta);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  if (ruta !== ':memory:') { db.exec('PRAGMA journal_mode = WAL;'); db.exec('PRAGMA synchronous = NORMAL;'); }
  migrarSeguridad(db);
  for (const s of TABLAS_SQL) db.exec(s);
  const agregadas = completarColumnas(db);
  db.exec('DROP VIEW IF EXISTS v_stock');
  for (const s of OTRAS_SQL) db.exec(s);
  migrarDatos(db, agregadas);
  return db;
}

// Agrega a las tablas existentes toda columna del esquema que falte. SQLite no permite agregar columnas NOT NULL sin
// valor constante ni con DEFAULT de expresión: en esos casos se agregan como opcionales.
function completarColumnas(db) {
  const agregadas = new Set();
  for (const [tabla, cols] of Object.entries(columnasEsperadas())) {
    const actuales = new Set(db.prepare(`PRAGMA table_info("${tabla}")`).all().map((c) => c.name));
    for (const c of cols) {
      if (actuales.has(c.name) || c.pk) continue;
      const def = c.dflt_value;
      const constante = def !== null && !/\(/.test(def);
      let ddl = `ALTER TABLE "${tabla}" ADD COLUMN "${c.name}" ${c.type || ''}`;
      if (constante) ddl += `${c.notnull ? ' NOT NULL' : ''} DEFAULT ${def}`;
      db.exec(ddl);
      agregadas.add(`${tabla}.${c.name}`);
    }
  }
  return agregadas;
}

// Cambios de seguridad sobre bases de versiones anteriores (antes de aplicar el esquema).
function migrarSeguridad(db) {
  const existe = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const cols = (t) => db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
  // Sesiones antiguas guardaban el token en claro: se descartan (todos vuelven a iniciar sesión una vez).
  if (existe('sesiones') && cols('sesiones').includes('token')) db.exec('DROP TABLE sesiones');
  // Códigos de recuperación antiguos en texto plano: se invalidan.
  if (existe('recuperacion_clave') && !cols('recuperacion_clave').includes('codigo_hash')) {
    db.exec('UPDATE recuperacion_clave SET usado = 1, codigo = NULL');
  }
}

// Rellenos de datos para columnas recién agregadas (bases de versiones anteriores).
function migrarDatos(db, agregadas) {
  if (agregadas.has('compras.total_moneda')) {
    db.exec(`
      UPDATE compras SET tasa_cambio = 1, subtotal_moneda = subtotal, descuento_moneda = descuento, total_moneda = total, valor_pagado_moneda = valor_pagado, saldo_pendiente_moneda = saldo_pendiente WHERE moneda = 'COP' AND total_moneda IS NULL;
      UPDATE compra_items SET costo_unitario_moneda = costo_unitario, descuento_moneda = descuento WHERE costo_unitario_moneda IS NULL;
      UPDATE lotes SET tasa_cambio = 1, costo_unitario_moneda = costo_unitario WHERE moneda = 'COP' AND costo_unitario_moneda IS NULL;
      UPDATE ventas SET tasa_cambio = 1, subtotal_moneda = subtotal, total_moneda = total, ganancia_neta = ganancia - comision - gastos_venta WHERE moneda = 'COP' AND total_moneda IS NULL;
      UPDATE venta_items SET precio_unitario_moneda = precio_unitario, descuento_moneda = descuento WHERE precio_unitario_moneda IS NULL;
      UPDATE venta_item_lotes SET tasa_compra = 1, costo_unitario_moneda = costo_unitario WHERE tasa_compra IS NULL;
      UPDATE pagos SET valor_moneda = valor, tasa_cambio = 1 WHERE moneda = 'COP' AND valor_moneda IS NULL;
      UPDATE creditos SET tasa_cambio = 1, saldo_financiado_moneda = saldo_financiado, saldo_moneda = saldo_actual WHERE moneda = 'COP' AND saldo_moneda IS NULL;
      UPDATE credito_cuotas SET valor_moneda = valor, pagado_moneda = pagado WHERE valor_moneda IS NULL;`);
  }
  if (agregadas.has('ventas.responsable_tipo')) {
    db.exec(`UPDATE ventas SET responsable_tipo = (SELECT CASE WHEN u.rol = 'admin' THEN 'empleador' WHEN u.rol IN ('vendedor','cajero') THEN 'vendedor' ELSE 'otro' END FROM usuarios u WHERE u.id = ventas.vendedor_id) WHERE responsable_tipo IS NULL AND vendedor_id IS NOT NULL;
             UPDATE ventas SET registrado_por = vendedor_id WHERE registrado_por IS NULL;`);
  }
  // Token de API: antes se guardaba en claro; ahora solo su huella SHA-256.
  const fila = db.prepare("SELECT valor FROM configuracion WHERE clave = 'api_token'").get();
  if (fila) {
    let token = '';
    try { token = JSON.parse(fila.valor) || ''; } catch { token = fila.valor || ''; }
    if (token) setConfig(db, 'api_token_hash', require('node:crypto').createHash('sha256').update(String(token)).digest('hex'));
    db.prepare("DELETE FROM configuracion WHERE clave = 'api_token'").run();
  }
}

let instancia = null;
function getDb() {
  if (!instancia) {
    if (DB_PATH !== ':memory:') asegurarCarpetas();
    instancia = abrir(DB_PATH);
  }
  return instancia;
}
function cerrarDb() {
  if (instancia) { try { instancia.close(); } catch { /* ya cerrada */ } instancia = null; }
}

// Transacciones anidables (SAVEPOINT). Todo lo que falle dentro revierte el conjunto.
const profundidad = new WeakMap();
function transaccion(db, fn) {
  const d = profundidad.get(db) || 0;
  if (d === 0) db.exec('BEGIN IMMEDIATE');
  else db.exec(`SAVEPOINT sp${d}`);
  profundidad.set(db, d + 1);
  try {
    const r = fn();
    if (d === 0) db.exec('COMMIT');
    else db.exec(`RELEASE sp${d}`);
    return r;
  } catch (e) {
    try {
      if (d === 0) db.exec('ROLLBACK');
      else db.exec(`ROLLBACK TO sp${d}; RELEASE sp${d}`);
    } catch { /* ya revertida */ }
    throw e;
  } finally {
    profundidad.set(db, d);
  }
}

function siguienteNumero(db, nombre, prefijo) {
  db.prepare('INSERT INTO contadores(nombre, valor) VALUES (?, 0) ON CONFLICT(nombre) DO NOTHING').run(nombre);
  db.prepare('UPDATE contadores SET valor = valor + 1 WHERE nombre = ?').run(nombre);
  const { valor } = db.prepare('SELECT valor FROM contadores WHERE nombre = ?').get(nombre);
  return `${prefijo}-${String(valor).padStart(6, '0')}`;
}

function getConfig(db, clave) {
  const fila = db.prepare('SELECT valor FROM configuracion WHERE clave = ?').get(clave);
  if (!fila) return CONFIG_DEFAULT[clave];
  try { return JSON.parse(fila.valor); } catch { return fila.valor; }
}

function getConfigTodo(db) {
  const salida = { ...CONFIG_DEFAULT };
  for (const f of db.prepare('SELECT clave, valor FROM configuracion').all()) {
    try { salida[f.clave] = JSON.parse(f.valor); } catch { salida[f.clave] = f.valor; }
  }
  return salida;
}

function setConfig(db, clave, valor) {
  db.prepare('INSERT INTO configuracion(clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor')
    .run(clave, JSON.stringify(valor));
}

module.exports = {
  DATA_DIR, UPLOADS_DIR, BACKUPS_DIR, DB_PATH, CONFIG_DEFAULT,
  abrir, getDb, cerrarDb, transaccion, siguienteNumero, getConfig, getConfigTodo, setConfig, asegurarCarpetas,
};
