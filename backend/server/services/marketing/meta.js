'use strict';
// Meta Ads (Facebook / Instagram): lectura real de campañas e inversión por día con la Graph API.
// Credenciales: META_ADS_TOKEN (token de sistema o de usuario con permiso ads_read) y META_ADS_CUENTA (id de la cuenta
// publicitaria, con o sin el prefijo act_). Peticiones:
//   GET /v21.0/act_{cuenta}?fields=currency,name
//   GET /v21.0/act_{cuenta}/campaigns?fields=id,name,status,objective,start_time,stop_time&limit=100
//   GET /v21.0/act_{cuenta}/insights?level=campaign&time_increment=1&fields=campaign_id,spend,impressions,reach,clicks,actions&time_range={since,until}
// El gasto llega en la moneda de la cuenta: si es USD se convierte con la TRM oficial que cubre esa fecha (o la de hasta 4 días
// antes: fin de semana/festivo sin fila nueva), nunca con una TRM más antigua. Sin TRM válida para una fecha, esa fila NO se
// guarda (gasto es NOT NULL en campana_metricas y 0 significaría "gastó cero") y la fecha queda listada en detalle.sin_tasa.
// Esta integración NO se ha probado con credenciales reales (ver docs/MARKETING.md); las pruebas usan una red simulada (setFetch).
const trm = require('../trm');
const { diasEntre, hoy } = require('../../util');
const { upsertCampanaExterna, upsertMetricaSincronizada } = require('./comun');

const VERSION = process.env.META_API_VERSION || 'v21.0';
const BASE = `https://graph.facebook.com/${VERSION}`;
const VARIABLES = ['META_ADS_TOKEN', 'META_ADS_CUENTA'];

let fetchImpl = (url, opciones) => globalThis.fetch(url, { ...opciones, signal: AbortSignal.timeout(20000) });
function setFetch(fn) { fetchImpl = fn || ((url, opciones) => globalThis.fetch(url, { ...opciones, signal: AbortSignal.timeout(20000) })); }

const configurado = () => VARIABLES.every((v) => !!(process.env[v] || '').trim());
const cuentaId = () => { const c = String(process.env.META_ADS_CUENTA || '').trim(); return c.startsWith('act_') ? c : `act_${c}`; };

async function pedir(ruta, params = {}) {
  const url = new URL(ruta.startsWith('http') ? ruta : `${BASE}/${ruta}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  if (!url.searchParams.has('access_token')) url.searchParams.set('access_token', String(process.env.META_ADS_TOKEN || '').trim());
  const r = await fetchImpl(url.toString(), { headers: { Accept: 'application/json' } });
  let json = null;
  try { json = await r.json(); } catch { json = null; }
  if (!r.ok || (json && json.error)) {
    const e = json && json.error ? json.error : {};
    throw new Error(`Meta Graph API (${r.status}${e.code ? ', código ' + e.code : ''}): ${e.message || 'respuesta inválida'}`);
  }
  return json;
}
// Recorre las páginas de una colección (paging.next) hasta `maxPaginas`.
async function pedirTodo(ruta, params, maxPaginas = 10) {
  const filas = [];
  let json = await pedir(ruta, params);
  for (let i = 0; i < maxPaginas; i++) {
    filas.push(...(Array.isArray(json.data) ? json.data : []));
    const sig = json.paging && json.paging.next;
    if (!sig) break;
    json = await pedir(sig);
  }
  return filas;
}

const ESTADO = { ACTIVE: 'activa', PAUSED: 'pausada', ARCHIVED: 'finalizada', DELETED: 'finalizada', IN_PROCESS: 'borrador', WITH_ISSUES: 'pausada' };
function objetivoDe(o) {
  const t = String(o || '').toUpperCase();
  if (/SALES|CONVERSIONS|CATALOG/.test(t)) return 'ventas';
  if (/MESSAGE|ENGAGEMENT/.test(t)) return 'mensajes';
  if (/TRAFFIC|LINK_CLICKS/.test(t)) return 'trafico';
  if (/AWARENESS|REACH|VIDEO_VIEWS/.test(t)) return 'reconocimiento';
  if (/LEAD/.test(t)) return 'mensajes';
  return t ? 'otro' : null;
}
// Los action_type de la Insights API se solapan (omni_purchase ⊇ purchase ⊇ offsite_conversion.fb_pixel_purchase, lead ⊇
// lead_grouped/fb_pixel_lead, total_messaging_connection ⊇ messaging_conversation_started_7d), así que NUNCA se suman: se toma
// UN solo tipo por métrica, el primero de la lista de preferencia que venga en la respuesta. Sin ninguno → null (sin dato).
const accion = (acciones, tipos) => {
  if (!Array.isArray(acciones)) return null;
  for (const t of tipos) { const a = acciones.find((x) => x && x.action_type === t); if (a) return Math.round(Number(a.value)) || 0; }
  return null;
};
const TIPOS_CONVERSACION = ['onsite_conversion.messaging_conversation_started_7d', 'messaging_conversation_started_7d', 'onsite_conversion.total_messaging_connection'];
const TIPOS_COMPRA = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'];
const TIPOS_LEAD = ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'];
const TIPOS_CLIC_ENLACE = ['link_click'];
// "Resultados" depende del objetivo de la campaña en Meta (objetivo crudo, p. ej. OUTCOME_SALES). Si el objetivo no define un
// resultado inequívoco (reconocimiento, alcance, interacción, vídeo, desconocido) se deja null en vez de inventar una suma.
function resultadosDe(acciones, objetivoMeta) {
  const o = String(objetivoMeta || '').toUpperCase();
  if (!o) return null;
  if (/SALES|CONVERSIONS|CATALOG/.test(o)) return accion(acciones, TIPOS_COMPRA);
  if (/LEAD/.test(o)) return accion(acciones, TIPOS_LEAD);
  if (/MESSAGE/.test(o)) return accion(acciones, TIPOS_CONVERSACION);
  if (/TRAFFIC|LINK_CLICKS/.test(o)) return accion(acciones, TIPOS_CLIC_ENLACE);
  return null;
}
// TRM aceptable para convertir el gasto de una fecha: la fila que la cubre o una de hasta 4 días antes (misma regla que
// trm.trmParaFecha y compras.referenciaTrm). Una TRM más vieja no sirve: la fecha queda sin tasa.
function trmAceptable(fila, fecha) {
  if (!fila || !fila.valor) return false;
  if ((fila.vigencia_hasta || fila.fecha) >= fecha) return true;
  return diasEntre(fila.fecha, fecha) <= 4 && fecha <= hoy();
}

async function sincronizar(db, { desde, hasta } = {}) {
  if (!configurado()) {
    return { estado: 'sin_credenciales', detalle: { mensaje: `Faltan las variables ${VARIABLES.join(' y ')}. Mientras tanto registra la inversión y las métricas a mano en cada campaña.` }, campanas_actualizadas: 0, metricas_insertadas: 0 };
  }
  const cuenta = cuentaId();
  const info = await pedir(cuenta, { fields: 'currency,name,account_id' });
  const moneda = String(info.currency || 'COP').toUpperCase();
  const campanas = await pedirTodo(`${cuenta}/campaigns`, { fields: 'id,name,status,objective,start_time,stop_time', limit: '100' });
  const insights = (desde && hasta) ? await pedirTodo(`${cuenta}/insights`, { level: 'campaign', time_increment: '1', fields: 'campaign_id,campaign_name,spend,impressions,reach,clicks,actions', time_range: { since: desde, until: hasta }, limit: '500' }) : [];

  const ids = new Map(); const objetivos = new Map(); // id externo → id local · id externo → objetivo crudo de Meta
  let creadas = 0;
  for (const c of campanas) {
    const r = upsertCampanaExterna(db, { plataforma: 'meta', id_externo: c.id, nombre: c.name, estado: ESTADO[c.status] || null, objetivo: objetivoDe(c.objective), fecha_inicio: c.start_time ? String(c.start_time).slice(0, 10) : null, fecha_fin: c.stop_time ? String(c.stop_time).slice(0, 10) : null });
    ids.set(String(c.id), r.id);
    objetivos.set(String(c.id), c.objective || null);
    if (r.creada) creadas++;
  }
  let metricas = 0; const sinTasa = []; const tasas = {};
  for (const f of insights) {
    const fecha = String(f.date_start || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) continue;
    let campanaId = ids.get(String(f.campaign_id));
    if (!campanaId) { const r = upsertCampanaExterna(db, { plataforma: 'meta', id_externo: f.campaign_id, nombre: f.campaign_name }); campanaId = r.id; ids.set(String(f.campaign_id), r.id); if (r.creada) creadas++; }
    const gastoMoneda = Number(f.spend) || 0;
    let gasto = gastoMoneda;
    if (moneda !== 'COP') {
      if (moneda !== 'USD') { sinTasa.push(`${fecha}: moneda ${moneda} no soportada`); continue; }
      let tasa = tasas[fecha];
      if (tasa === undefined) {
        let fila = null;
        try { fila = await trm.trmParaFecha(db, fecha); } catch { fila = null; }
        // Sin red: solo sirve la TRM local que cubra la fecha o esté a ≤ 4 días; una más antigua se descarta.
        if (!fila) { const local = trm.trmVigente(db, fecha); fila = trmAceptable(local, fecha) ? local : null; }
        tasa = fila ? fila.valor : null;
        tasas[fecha] = tasa;
      }
      if (!tasa) { if (!sinTasa.includes(fecha)) sinTasa.push(fecha); continue; }
      gasto = Math.round(gastoMoneda * tasa);
    }
    const num = (v) => (v === undefined || v === null || v === '' ? null : Math.round(Number(v)) || 0);
    upsertMetricaSincronizada(db, campanaId, fecha, {
      impresiones: num(f.impressions), alcance: num(f.reach), clics: num(f.clicks), gasto,
      conversaciones: accion(f.actions, TIPOS_CONVERSACION),
      resultados: resultadosDe(f.actions, objetivos.get(String(f.campaign_id))),
    });
    metricas++;
  }
  const detalle = {
    cuenta: info.name || cuenta, moneda, campanas: campanas.length, campanas_nuevas: creadas, dias: insights.length, rango: desde && hasta ? { desde, hasta } : null,
    conversion: moneda === 'COP' ? 'sin conversión (cuenta en COP)' : `gasto convertido de ${moneda} a COP con la TRM oficial que cubre cada fecha (o la de hasta 4 días antes)`,
    tasas: moneda === 'COP' ? undefined : tasas,
    sin_tasa: sinTasa.length ? sinTasa : undefined,
    sin_tasa_motivo: sinTasa.length ? 'Sin TRM oficial para esas fechas (sin red o sin dato publicado): esos días no se guardaron para no inventar el gasto; vuelve a sincronizar cuando haya TRM.' : undefined,
    metricas: 'Conversaciones = un solo tipo de acción (messaging_conversation_started_7d); resultados según el objetivo de la campaña (compras, leads, conversaciones o clics en el enlace), nunca una suma de tipos solapados.',
  };
  return { estado: 'ok', detalle, campanas_actualizadas: campanas.length, metricas_insertadas: metricas };
}

module.exports = {
  clave: 'meta',
  nombre: 'Meta Ads (Facebook e Instagram)',
  variables: VARIABLES,
  instrucciones: [
    'En Meta Business Suite › Configuración del negocio › Usuarios › Usuarios del sistema, crear un usuario del sistema y generar un token con el permiso ads_read (y la cuenta publicitaria asignada).',
    'Copiar el id de la cuenta publicitaria (Configuración › Cuentas publicitarias; empieza por act_).',
    'Configurar META_ADS_TOKEN y META_ADS_CUENTA en el servidor y reiniciar la aplicación.',
    'La sincronización crea una campaña por cada campaña de Meta (con su id externo) y trae inversión, impresiones, alcance, clics, conversaciones y resultados (según el objetivo) por día. Si la cuenta factura en dólares, el gasto se convierte a pesos con la TRM oficial que cubre cada fecha; los días sin TRM no se guardan y se listan en el detalle.',
  ],
  configurado,
  sincronizar,
  setFetch,
  // Expuestos para pruebas y para quien quiera reutilizar la regla.
  accion, resultadosDe, trmAceptable,
};
