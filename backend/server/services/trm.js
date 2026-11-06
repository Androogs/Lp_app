'use strict';
// Tasa de cambio USD/COP.
//  - TRM oficial: Superintendencia Financiera de Colombia, publicada en datos.gov.co (conjunto 32sa-8pi3). Sin credenciales;
//    opcionalmente DATOS_GOV_APP_TOKEN eleva el límite de consultas.
//  - Mercado: cotización de referencia diaria (open.er-api.com por defecto; configurable con MERCADO_API_URL).
// Todo valor consultado se guarda en `tasas_cambio` (histórico) y se reutiliza como caché según la frecuencia configurada.
// Si la red falla, se entrega el último valor válido marcado como desactualizado: nunca se inventa un valor.
const { getConfig } = require('../db');
const { err, hoy, ahora, aFecha, sumarDias, diasEntre, tasaValida, fecha: vFecha, texto } = require('../util');
const auditoria = require('./auditoria');

const SOCRATA_URL = process.env.TRM_API_URL || 'https://www.datos.gov.co/resource/32sa-8pi3.json';
const MERCADO_URL = process.env.MERCADO_API_URL || 'https://open.er-api.com/v6/latest/USD';
const FUENTE_TRM = 'Superintendencia Financiera de Colombia (datos.gov.co, conjunto 32sa-8pi3)';
const FUENTE_MERCADO = process.env.MERCADO_API_URL ? 'Cotización de mercado (' + new URL(MERCADO_URL).host + ')' : 'Cotización de referencia de mercado (open.er-api.com)';
const SIN_RED = process.env.TRM_DESACTIVAR_RED === '1';

// Estado en memoria del servicio (se expone en la pantalla "TRM y dólar").
const estado = {
  trm: { ultima_consulta: null, ultimo_exito: null, ultimo_error: null },
  mercado: { ultima_consulta: null, ultimo_exito: null, ultimo_error: null },
  historico_cargado_hasta: null,
};

let fetchImpl = (url, opciones) => globalThis.fetch(url, { ...opciones, signal: AbortSignal.timeout(10000) });
function setFetch(fn) { fetchImpl = fn; }

async function pedirJson(url, cabeceras = {}) {
  if (SIN_RED) throw new Error('Consultas de red desactivadas (TRM_DESACTIVAR_RED=1)');
  const r = await fetchImpl(url, { headers: { Accept: 'application/json', ...cabeceras } });
  if (!r.ok) throw new Error(`HTTP ${r.status} al consultar ${new URL(url).host}`);
  return r.json();
}
function cabecerasSocrata() { return process.env.DATOS_GOV_APP_TOKEN ? { 'X-App-Token': process.env.DATOS_GOV_APP_TOKEN } : {}; }

function guardar(db, { fecha, tipo, valor, vigencia_desde = null, vigencia_hasta = null, fuente, usuario = null, nota = null }) {
  db.prepare(`INSERT INTO tasas_cambio(fecha, tipo, moneda, valor, vigencia_desde, vigencia_hasta, fuente, obtenido_en, usuario_id, usuario_nombre, nota)
              VALUES (?,?, 'USD', ?,?,?,?,?,?,?,?)
              ON CONFLICT(fecha, tipo, moneda) DO UPDATE SET valor = excluded.valor, vigencia_desde = excluded.vigencia_desde, vigencia_hasta = excluded.vigencia_hasta, fuente = excluded.fuente, obtenido_en = excluded.obtenido_en, usuario_id = excluded.usuario_id, usuario_nombre = excluded.usuario_nombre, nota = COALESCE(excluded.nota, tasas_cambio.nota)`)
    .run(fecha, tipo, valor, vigencia_desde, vigencia_hasta, fuente, ahora(), usuario ? usuario.id : null, usuario ? usuario.nombre : null, nota);
  return db.prepare('SELECT * FROM tasas_cambio WHERE fecha = ? AND tipo = ? AND moneda = \'USD\'').get(fecha, tipo);
}

function filaSocrata(f) {
  const desde = String(f.vigenciadesde).slice(0, 10);
  const hasta = String(f.vigenciahasta || f.vigenciadesde).slice(0, 10);
  return { fecha: desde, vigencia_desde: desde, vigencia_hasta: hasta, valor: Math.round(Number(f.valor) * 100) / 100 };
}

// --- TRM oficial ---
async function actualizarTrm(db, { forzar = false } = {}) {
  const minutos = Number(getConfig(db, 'trm_frecuencia_minutos')) || 60;
  const vigente = trmVigente(db);
  if (!forzar && estado.trm.ultimo_exito && (Date.now() - estado.trm.ultimo_exito) < minutos * 60000 && vigente) return vigente;
  estado.trm.ultima_consulta = Date.now();
  try {
    const filas = await pedirJson(`${SOCRATA_URL}?$order=vigenciadesde%20DESC&$limit=5`, cabecerasSocrata());
    if (!Array.isArray(filas) || !filas.length) throw new Error('Respuesta vacía de datos.gov.co');
    let ultima = null;
    for (const f of filas.reverse()) { const d = filaSocrata(f); ultima = guardar(db, { ...d, tipo: 'trm', fuente: FUENTE_TRM }); }
    estado.trm.ultimo_exito = Date.now();
    estado.trm.ultimo_error = null;
    return ultima;
  } catch (e) {
    estado.trm.ultimo_error = `${ahora()} · ${e.message}`;
    return vigente;
  }
}

function trmVigente(db, fecha = hoy()) {
  // Vigente: la última TRM cuya vigencia cubre la fecha (los fines de semana y festivos conservan la del viernes).
  return db.prepare("SELECT * FROM tasas_cambio WHERE tipo = 'trm' AND moneda = 'USD' AND fecha <= ? ORDER BY fecha DESC LIMIT 1").get(fecha) || null;
}
function trmAnterior(db, fecha) {
  return db.prepare("SELECT * FROM tasas_cambio WHERE tipo = 'trm' AND moneda = 'USD' AND fecha < ? ORDER BY fecha DESC LIMIT 1").get(fecha) || null;
}

// TRM para una fecha concreta (histórica). Devuelve null si no existe ni se puede consultar.
// Orden: 1) fila local cuya vigencia cubre la fecha (las filas de Socrata ya traen vigencia_hasta que abarca fines de semana y festivos);
// 2) la API oficial; 3) solo si la API falla o no tiene la fecha, el "puente" (puenteTrm): la última TRM publicada hasta 4 días antes,
// con origen 'puente' y constancia en `fuente`. El puente nunca va antes de la API: un día hábil que no se había consultado tiene su
// propia TRM y no debe heredar la del día anterior en caché.
async function trmParaFecha(db, fecha) {
  vFecha(fecha, 'Fecha');
  const local = trmVigente(db, fecha);
  if (local && (local.vigencia_hasta || local.fecha) >= fecha) return { ...local, origen: 'cache' };
  try {
    const w = encodeURIComponent(`vigenciadesde <= '${fecha}T00:00:00.000' AND vigenciahasta >= '${fecha}T00:00:00.000'`);
    const filas = await pedirJson(`${SOCRATA_URL}?$where=${w}&$limit=1`, cabecerasSocrata());
    if (Array.isArray(filas) && filas.length) {
      const fila = guardar(db, { ...filaSocrata(filas[0]), tipo: 'trm', fuente: FUENTE_TRM });
      estado.trm.ultimo_exito = Date.now();
      return { ...fila, origen: 'api' };
    }
  } catch (e) {
    estado.trm.ultimo_error = `${ahora()} · ${e.message}`;
  }
  return puenteTrm(local, fecha);
}

// Puente: sin dato oficial que cubra la fecha (API caída o sin fila), sirve la última TRM publicada hasta 4 días antes (fin de semana o
// festivo sin fila nueva). Solo debe usarse DESPUÉS de intentar la API. Devuelve la fila con `puente: true`, origen 'puente' y la
// fuente con constancia de que es la última TRM publicada antes de esa fecha; null si la fila está a más de 4 días o la fecha es futura.
function puenteTrm(fila, fecha) {
  if (!fila || diasEntre(fila.fecha, fecha) > 4 || fecha > hoy()) return null;
  return { ...fila, origen: 'puente', puente: true, fuente: `Última TRM publicada antes del ${fecha} (vigente desde ${fila.vigencia_desde || fila.fecha}; sin dato oficial para ese día) · ${fila.fuente || FUENTE_TRM}` };
}

// Carga el histórico de TRM desde una fecha (una sola petición, máx. 3000 filas) para gráficos y consultas pasadas.
const historicoEnCurso = new Map();
async function cargarHistorico(db, desde) {
  const clave = desde;
  if (historicoEnCurso.get(clave) && Date.now() - historicoEnCurso.get(clave) < 60 * 60000) return false; // una vez por hora por rango
  historicoEnCurso.set(clave, Date.now());
  try {
    const w = encodeURIComponent(`vigenciadesde >= '${desde}T00:00:00.000'`);
    const filas = await pedirJson(`${SOCRATA_URL}?$where=${w}&$order=vigenciadesde&$limit=3000`, cabecerasSocrata());
    const ins = db.prepare(`INSERT INTO tasas_cambio(fecha, tipo, moneda, valor, vigencia_desde, vigencia_hasta, fuente) VALUES (?, 'trm', 'USD', ?, ?, ?, ?) ON CONFLICT(fecha, tipo, moneda) DO NOTHING`);
    db.exec('BEGIN');
    try { for (const f of filas) { const d = filaSocrata(f); ins.run(d.fecha, d.valor, d.vigencia_desde, d.vigencia_hasta, FUENTE_TRM); } db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    estado.historico_cargado_hasta = desde;
    estado.trm.ultimo_exito = Date.now();
    return true;
  } catch (e) {
    estado.trm.ultimo_error = `${ahora()} · histórico: ${e.message}`;
    return false;
  }
}

// --- Mercado ---
async function actualizarMercado(db, { forzar = false } = {}) {
  const minutos = Number(getConfig(db, 'mercado_frecuencia_minutos')) || 30;
  const ultimo = mercadoUltimo(db);
  if (!forzar && estado.mercado.ultimo_exito && (Date.now() - estado.mercado.ultimo_exito) < minutos * 60000 && ultimo) return ultimo;
  estado.mercado.ultima_consulta = Date.now();
  try {
    const j = await pedirJson(MERCADO_URL);
    const valor = j && j.rates && Number(j.rates.COP);
    if (!valor) throw new Error('La respuesta no trae la tasa COP');
    const actualizado = j.time_last_update_utc ? ahora(new Date(j.time_last_update_utc)) : ahora();
    const fila = guardar(db, { fecha: hoy(), tipo: 'mercado', valor: Math.round(valor * 100) / 100, vigencia_desde: actualizado, fuente: FUENTE_MERCADO });
    estado.mercado.ultimo_exito = Date.now();
    estado.mercado.ultimo_error = null;
    return fila;
  } catch (e) {
    estado.mercado.ultimo_error = `${ahora()} · ${e.message}`;
    return ultimo;
  }
}
function mercadoUltimo(db) {
  return db.prepare("SELECT * FROM tasas_cambio WHERE tipo = 'mercado' AND moneda = 'USD' ORDER BY fecha DESC LIMIT 1").get() || null;
}

// --- Tasas manuales ---
function registrarManual(db, datos, usuario) {
  const fecha = vFecha(datos.fecha, 'Fecha');
  if (fecha > hoy()) throw err.datos('No se puede registrar una tasa para una fecha futura');
  const valor = tasaValida(datos.valor);
  const nota = texto(datos.nota, 'Origen o motivo de la tasa', { max: 300 });
  const anterior = db.prepare("SELECT valor FROM tasas_cambio WHERE fecha = ? AND tipo = 'manual' AND moneda = 'USD'").get(fecha);
  const fila = guardar(db, { fecha, tipo: 'manual', valor, vigencia_desde: fecha, vigencia_hasta: fecha, fuente: `Manual: ${nota}`, usuario, nota });
  auditoria.registrar(db, usuario, anterior ? 'editar_tasa_manual' : 'registrar_tasa_manual', 'tasa_cambio', fila.id, { fecha, valor_anterior: anterior ? anterior.valor : null, valor_nuevo: valor, motivo: nota });
  return fila;
}

// Sugerencia de tasa para registrar una operación en una fecha: TRM oficial > manual > mercado (solo si es hoy).
async function sugerirTasa(db, fecha = hoy()) {
  const trm = await trmParaFecha(db, fecha);
  const manual = db.prepare("SELECT * FROM tasas_cambio WHERE tipo = 'manual' AND fecha = ?").get(fecha) || null;
  const mercado = fecha === hoy() ? (await actualizarMercado(db)) : db.prepare("SELECT * FROM tasas_cambio WHERE tipo = 'mercado' AND fecha = ?").get(fecha) || null;
  const sugerida = trm ? { valor: trm.valor, origen: 'trm', fecha_vigencia: trm.fecha, vigencia_hasta: trm.vigencia_hasta, fuente: trm.fuente }
    : manual ? { valor: manual.valor, origen: 'manual', fecha_vigencia: manual.fecha, fuente: manual.fuente }
      : null;
  return { fecha, sugerida, trm: trm ? { valor: trm.valor, fecha: trm.fecha, vigencia_hasta: trm.vigencia_hasta } : null, manual: manual ? { valor: manual.valor, nota: manual.nota } : null, mercado: mercado ? { valor: mercado.valor, fecha: mercado.fecha, actualizado: mercado.vigencia_desde } : null, requiere_manual: !sugerida, error: !trm && estado.trm.ultimo_error ? estado.trm.ultimo_error : null };
}

// --- Resumen para la pantalla "TRM y dólar en tiempo real" ---
async function resumen(db) {
  const [trm, mercado] = await Promise.all([actualizarTrm(db), actualizarMercado(db)]);
  const h = hoy();
  const minutosTrm = Number(getConfig(db, 'trm_frecuencia_minutos')) || 60;
  const minutosMer = Number(getConfig(db, 'mercado_frecuencia_minutos')) || 30;
  const variacion = (actual, anterior) => (actual && anterior ? { pesos: Math.round((actual.valor - anterior.valor) * 100) / 100, pct: Math.round(((actual.valor - anterior.valor) / anterior.valor) * 10000) / 100, anterior: anterior.valor, anterior_fecha: anterior.fecha } : null);
  const trmAnt = trm ? trmAnterior(db, trm.fecha) : null;
  const merAnt = mercado ? db.prepare("SELECT * FROM tasas_cambio WHERE tipo = 'mercado' AND fecha < ? ORDER BY fecha DESC LIMIT 1").get(mercado.fecha) : null;
  const trmDesactualizada = !trm || ((trm.vigencia_hasta || trm.fecha) < h && diasEntre(trm.vigencia_hasta || trm.fecha, h) > 0 && !!estado.trm.ultimo_error);
  return {
    trm: trm ? { valor: trm.valor, fecha: trm.fecha, vigencia_desde: trm.vigencia_desde, vigencia_hasta: trm.vigencia_hasta, obtenido_en: trm.obtenido_en, fuente: trm.fuente, vigente_hoy: (trm.vigencia_hasta || trm.fecha) >= h, desactualizada: trmDesactualizada, variacion: variacion(trm, trmAnt) } : null,
    mercado: mercado ? { valor: mercado.valor, fecha: mercado.fecha, actualizado: mercado.vigencia_desde, obtenido_en: mercado.obtenido_en, fuente: mercado.fuente, desactualizado: mercado.fecha < h || (estado.mercado.ultimo_error && Date.now() - (estado.mercado.ultimo_exito || 0) > 2 * minutosMer * 60000), variacion: variacion(mercado, merAnt) } : null,
    estado: {
      trm: { conectado: !estado.trm.ultimo_error && !!estado.trm.ultimo_exito, ultima_consulta: estado.trm.ultima_consulta ? ahora(new Date(estado.trm.ultima_consulta)) : null, ultimo_exito: estado.trm.ultimo_exito ? ahora(new Date(estado.trm.ultimo_exito)) : null, error: estado.trm.ultimo_error, frecuencia_minutos: minutosTrm, fuente: FUENTE_TRM, url: SOCRATA_URL },
      mercado: { conectado: !estado.mercado.ultimo_error && !!estado.mercado.ultimo_exito, ultima_consulta: estado.mercado.ultima_consulta ? ahora(new Date(estado.mercado.ultima_consulta)) : null, ultimo_exito: estado.mercado.ultimo_exito ? ahora(new Date(estado.mercado.ultimo_exito)) : null, error: estado.mercado.ultimo_error, frecuencia_minutos: minutosMer, fuente: FUENTE_MERCADO, url: MERCADO_URL },
      red_desactivada: SIN_RED,
    },
    hoy: h,
  };
}

async function historial(db, { desde, hasta = hoy(), tipo } = {}) {
  if (!desde) desde = sumarDias(hasta, -30);
  // Si faltan días de TRM en el rango, intenta completar el histórico una vez.
  const n = db.prepare("SELECT COUNT(*) n FROM tasas_cambio WHERE tipo = 'trm' AND fecha BETWEEN ? AND ?").get(desde, hasta).n;
  const diasHabilesAprox = Math.max(1, Math.floor(diasEntre(desde, hasta) * 5 / 7) - 3);
  if (n < diasHabilesAprox && !SIN_RED) await cargarHistorico(db, desde);
  const cond = ['fecha BETWEEN ? AND ?'];
  const params = [desde, hasta];
  if (tipo) { cond.push('tipo = ?'); params.push(tipo); }
  const filas = db.prepare(`SELECT id, fecha, tipo, valor, vigencia_desde, vigencia_hasta, fuente, obtenido_en, usuario_nombre, nota FROM tasas_cambio WHERE ${cond.join(' AND ')} ORDER BY fecha, tipo`).all(...params);
  return { desde, hasta, filas };
}

// Arranque: refresco periódico según la configuración (respeta los límites del proveedor: una consulta por intervalo).
function programar(db) {
  if (SIN_RED) return null;
  const correr = () => { actualizarTrm(db).catch(() => {}); actualizarMercado(db).catch(() => {}); };
  setTimeout(correr, 3000);
  const t = setInterval(() => correr(), Math.max(5, Number(getConfig(db, 'mercado_frecuencia_minutos')) || 30) * 60000);
  t.unref();
  return t;
}

module.exports = { setFetch, actualizarTrm, actualizarMercado, trmVigente, trmParaFecha, puenteTrm, cargarHistorico, mercadoUltimo, registrarManual, sugerirTasa, resumen, historial, programar, estado, FUENTE_TRM, FUENTE_MERCADO };
