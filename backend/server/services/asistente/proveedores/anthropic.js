'use strict';
// Proveedor Anthropic para el asistente Tino (SDK oficial @anthropic-ai/sdk, el mismo que usa el OCR).
// Interfaz común de proveedor (ver docs/ASISTENTE.md):
//   completar({ system, mensajes, herramientas, modelo, effort, max_tokens })
//     → { texto, llamadas: [{ id, nombre, argumentos }], uso: { entrada, salida, cache_lectura, cache_escritura }, detencion, modelo, bruto }
// El servicio mantiene el historial en un formato neutro y aquí se traduce al formato de la API de Mensajes.
// Reglas verificadas para Opus 5.5: no se envía `thinking` ni `budget_tokens` (el modelo piensa en modo adaptativo solo); la
// profundidad se controla con output_config.effort; tool_choice siempre `auto` (any/tool devuelven 400); el bucle de
// herramientas lo lleva el servicio (todos los tool_result de un turno van en UN solo mensaje user).
const Anthropic = require('@anthropic-ai/sdk');

const NOMBRE = 'anthropic';
const EFFORTS = ['low', 'medium', 'high'];

// Precio por millón de tokens (USD). Lectura de caché = 10 % de la entrada; escritura = 125 % de la entrada.
const PRECIOS = {
  'claude-opus-5-5': { entrada: 4, salida: 20, cache_lectura: 0.2, cache_escritura: 5 },
  'claude-sonnet-5-5': { entrada: 2, salida: 10, cache_lectura: 0.2, cache_escritura: 2.5 },
  'claude-haiku-5-5': { entrada: 0.1, salida: 0.5, cache_lectura: 0.01, cache_escritura: 0.125 },
};

function disponible() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

let cliente = null;
function getCliente() {
  if (!cliente) cliente = new Anthropic({ timeout: 60000, maxRetries: 1 });
  return cliente;
}

// Costo estimado en USD a partir del uso devuelto por la API. null si el modelo no está en la tabla (no se inventa).
function estimarCosto(modelo, uso) {
  const base = Object.keys(PRECIOS).find((k) => String(modelo || '').startsWith(k));
  if (!base || !uso) return null;
  const p = PRECIOS[base];
  const c = (uso.entrada || 0) * p.entrada + (uso.salida || 0) * p.salida + (uso.cache_lectura || 0) * p.cache_lectura + (uso.cache_escritura || 0) * p.cache_escritura;
  return Math.round((c / 1e6) * 1e6) / 1e6;
}

// --- Traducción del formato neutro al de la API ---
function traducirSystem(system) {
  if (typeof system === 'string') return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  // Lista de bloques { texto, cache }: el bloque estable lleva el punto de caché; lo volátil (fecha, usuario, ruta) va después.
  return system.map((b) => (b.cache ? { type: 'text', text: b.texto, cache_control: { type: 'ephemeral' } } : { type: 'text', text: b.texto }));
}

function traducirHerramientas(herramientas) {
  return (herramientas || []).map((h) => ({ name: h.nombre, description: h.descripcion, input_schema: h.parametros }));
}

function traducirMensajes(mensajes) {
  const salida = [];
  for (const m of mensajes) {
    if (m.rol === 'usuario') salida.push({ role: 'user', content: String(m.contenido || '') });
    else if (m.rol === 'asistente') {
      // Si este mismo proveedor generó el turno, se devuelve el contenido tal cual (conserva bloques de pensamiento y tool_use).
      if (m.bruto && m.bruto.proveedor === NOMBRE && Array.isArray(m.bruto.content)) { salida.push({ role: 'assistant', content: m.bruto.content }); continue; }
      const bloques = [];
      if (m.contenido) bloques.push({ type: 'text', text: String(m.contenido) });
      for (const l of m.llamadas || []) bloques.push({ type: 'tool_use', id: l.id, name: l.nombre, input: l.argumentos || {} });
      if (bloques.length) salida.push({ role: 'assistant', content: bloques });
    } else if (m.rol === 'herramienta') {
      salida.push({ role: 'user', content: (m.resultados || []).map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: String(r.contenido ?? ''), ...(r.error ? { is_error: true } : {}) })) });
    }
  }
  return salida;
}

// Convierte los errores tipados del SDK en mensajes legibles. Nunca incluye la clave ni el prompt.
function errorLegible(e) {
  const salida = (mensaje, status, codigo) => { const err = new Error(mensaje); err.status = status; err.codigo = codigo; err.proveedor = NOMBRE; return err; };
  if (e instanceof Anthropic.AuthenticationError) return salida('La clave de Anthropic no es válida', 502, 'ia_clave_invalida');
  if (e instanceof Anthropic.RateLimitError) return salida('El servicio está saturado, intenta en un momento', 503, 'ia_saturado');
  if (e instanceof Anthropic.APIConnectionTimeoutError || e instanceof Anthropic.APIConnectionError) return salida('No hay conexión con el servicio de IA', 503, 'ia_sin_conexion');
  if (e instanceof Anthropic.NotFoundError) return salida('El modelo configurado no existe o no está disponible para esta cuenta', 502, 'ia_modelo');
  if (e instanceof Anthropic.APIError) return salida(`El servicio de IA respondió con un error (${e.status || 'desconocido'})`, 502, 'ia_error');
  return salida('No se pudo obtener respuesta del servicio de IA', 502, 'ia_error');
}

// soloTexto = true: las herramientas siguen declaradas (la API exige que existan si el historial trae tool_use), pero se pide
// una respuesta de texto (tool_choice none). Lo usa el servicio al agotar el máximo de iteraciones.
async function completar({ system, mensajes, herramientas, modelo, effort = 'low', max_tokens = 2048, soloTexto = false }) {
  const peticion = {
    model: modelo || 'claude-opus-5-5',
    max_tokens,
    system: traducirSystem(system),
    messages: traducirMensajes(mensajes),
    output_config: { effort: EFFORTS.includes(effort) ? effort : 'low' },
    // Reencaminamiento automático ante un rechazo de los clasificadores de seguridad (misma pauta que el OCR).
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  };
  const tools = traducirHerramientas(herramientas);
  if (tools.length) { peticion.tools = tools; peticion.tool_choice = { type: soloTexto ? 'none' : 'auto' }; }
  let r;
  try {
    r = await getCliente().beta.messages.create(peticion);
  } catch (e) {
    throw errorLegible(e);
  }
  const texto = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const llamadas = r.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, nombre: b.name, argumentos: b.input && typeof b.input === 'object' ? b.input : {} }));
  const uso = r.usage ? { entrada: r.usage.input_tokens || 0, salida: r.usage.output_tokens || 0, cache_lectura: r.usage.cache_read_input_tokens || 0, cache_escritura: r.usage.cache_creation_input_tokens || 0 } : { entrada: 0, salida: 0, cache_lectura: 0, cache_escritura: 0 };
  return { texto, llamadas, uso, detencion: r.stop_reason, modelo: r.model, costo_usd: estimarCosto(r.model, uso), bruto: { proveedor: NOMBRE, content: r.content } };
}

module.exports = { nombre: NOMBRE, disponible, completar, estimarCosto, PRECIOS, traducirMensajes, traducirHerramientas, errorLegible };
