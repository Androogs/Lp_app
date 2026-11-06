'use strict';
// Proveedor OpenRouter para el asistente Tino (segunda opción, formato compatible con OpenAI vía fetch).
// Misma interfaz que proveedores/anthropic.js. Usa OPENROUTER_API_KEY. NO PROBADO CON CREDENCIALES REALES: se escribió
// siguiendo la documentación pública de https://openrouter.ai/docs (chat/completions con `tools` tipo function y `tool_calls`).
const NOMBRE = 'openrouter';
const URL_API = process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1/chat/completions';
const EFFORTS = ['low', 'medium', 'high'];

// Modelos de Anthropic en OpenRouter se nombran con "/" y puntos; si el modelo configurado ya trae "/" se usa tal cual.
const ALIAS = { 'claude-opus-5-5': 'anthropic/claude-opus-5.5', 'claude-sonnet-5-5': 'anthropic/claude-sonnet-5.5', 'claude-haiku-5-5': 'anthropic/claude-haiku-5.5' };

function disponible() { return !!process.env.OPENROUTER_API_KEY; }
function modeloRemoto(m) { const x = String(m || 'claude-opus-5-5'); return x.includes('/') ? x : (ALIAS[x] || x); }

function traducirMensajes(system, mensajes) {
  const salida = [];
  const textoSystem = typeof system === 'string' ? system : (system || []).map((b) => b.texto).join('\n\n');
  if (textoSystem) salida.push({ role: 'system', content: textoSystem });
  for (const m of mensajes) {
    if (m.rol === 'usuario') salida.push({ role: 'user', content: String(m.contenido || '') });
    else if (m.rol === 'asistente') {
      const msg = { role: 'assistant', content: m.contenido ? String(m.contenido) : null };
      if (m.llamadas && m.llamadas.length) msg.tool_calls = m.llamadas.map((l) => ({ id: l.id, type: 'function', function: { name: l.nombre, arguments: JSON.stringify(l.argumentos || {}) } }));
      salida.push(msg);
    } else if (m.rol === 'herramienta') {
      for (const r of m.resultados || []) salida.push({ role: 'tool', tool_call_id: r.id, content: String(r.contenido ?? '') });
    }
  }
  return salida;
}

function traducirHerramientas(herramientas) {
  return (herramientas || []).map((h) => ({ type: 'function', function: { name: h.nombre, description: h.descripcion, parameters: h.parametros } }));
}

function errorLegible(status, detalle) {
  const e = new Error(status === 401 || status === 403 ? 'La clave de OpenRouter no es válida' : status === 429 ? 'El servicio está saturado, intenta en un momento' : `El servicio de IA respondió con un error (${status})`);
  e.status = status === 429 ? 503 : 502;
  e.codigo = status === 401 || status === 403 ? 'ia_clave_invalida' : status === 429 ? 'ia_saturado' : 'ia_error';
  e.proveedor = NOMBRE;
  if (detalle) e.detalle = String(detalle).slice(0, 300);
  return e;
}

async function completar({ system, mensajes, herramientas, modelo, effort = 'low', max_tokens = 2048, soloTexto = false }) {
  if (!disponible()) { const e = new Error('Falta OPENROUTER_API_KEY'); e.status = 503; e.codigo = 'asistente_no_configurado'; throw e; }
  const cuerpo = { model: modeloRemoto(modelo), messages: traducirMensajes(system, mensajes), max_tokens };
  const tools = traducirHerramientas(herramientas);
  if (tools.length) { cuerpo.tools = tools; cuerpo.tool_choice = soloTexto ? 'none' : 'auto'; }
  // Esfuerzo de razonamiento (OpenRouter lo acepta en `reasoning`; los modelos que no lo soportan lo ignoran).
  if (EFFORTS.includes(effort)) cuerpo.reasoning = { effort };
  let r;
  try {
    r = await fetch(URL_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': require('../../../config').APP_URL || 'https://localhost', 'X-Title': 'Licores Palmira Tino' },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    const err = new Error('No hay conexión con el servicio de IA'); err.status = 503; err.codigo = 'ia_sin_conexion'; err.proveedor = NOMBRE; throw err;
  }
  const texto = await r.text();
  let j = null; try { j = texto ? JSON.parse(texto) : null; } catch { j = null; }
  if (!r.ok) throw errorLegible(r.status, j && j.error ? j.error.message : '');
  if (!j || !Array.isArray(j.choices) || !j.choices.length) throw errorLegible(502, 'respuesta sin choices');
  const eleccion = j.choices[0];
  const msg = eleccion.message || {};
  const llamadas = (msg.tool_calls || []).map((t) => {
    let args = {};
    try { args = t.function && t.function.arguments ? JSON.parse(t.function.arguments) : {}; } catch { args = {}; }
    return { id: t.id, nombre: t.function ? t.function.name : '', argumentos: args && typeof args === 'object' ? args : {} };
  });
  const u = j.usage || {};
  const uso = { entrada: u.prompt_tokens || 0, salida: u.completion_tokens || 0, cache_lectura: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0, cache_escritura: 0 };
  const detencion = eleccion.finish_reason === 'tool_calls' || llamadas.length ? 'tool_use' : eleccion.finish_reason === 'length' ? 'max_tokens' : eleccion.finish_reason === 'content_filter' ? 'refusal' : 'end_turn';
  // OpenRouter informa el costo real en usage.cost cuando está disponible; si no, queda null (no se estima para no inventar).
  const costo = typeof u.cost === 'number' ? u.cost : null;
  return { texto: String(msg.content || '').trim(), llamadas, uso, detencion, modelo: j.model || cuerpo.model, costo_usd: costo, bruto: null };
}

module.exports = { nombre: NOMBRE, disponible, completar, traducirMensajes, traducirHerramientas, modeloRemoto };
