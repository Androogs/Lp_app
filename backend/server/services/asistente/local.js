'use strict';
// Motor local de Tino: responde preguntas del negocio SIN servicio de IA, directamente con la base de datos.
// Funciona sin clave, sin internet y sin costo. Sus respuestas salen de consultas reales (nunca se inventan cifras) y
// respetan los permisos del usuario: reutiliza las herramientas del asistente (herramientas.js), que ya validan permisos,
// y para lo que ellas no cubren (stock de un producto, unidades vendidas por producto, pendientes) hace consultas propias
// con la misma comprobación.
//
// Flujo: normalizar el texto → reconocer el periodo ("ayer", "15 de octubre"…) → puntuar intenciones por palabras clave →
// buscar productos o clientes mencionados → elegir la intención → responder en texto con acciones (botón para ir a la
// pantalla), avisos y preguntas sugeridas. Si la pregunta es un seguimiento corto ("¿y ayer?", "¿y de aguardiente?"),
// reutiliza la intención anterior de la conversación.
const { hoy, rangoPeriodo } = require('../../util');
const { tiene } = require('../../permisos');
const { getConfig } = require('../../db');
const L = require('./lenguaje');
const herramientas = require('./herramientas');
const avisosSrv = require('./avisos');
const guia = require('./guia');
const dashboard = require('../dashboard');
const analitica = require('../analitica');
const productosSrv = require('../productos');

const MAX_LISTA = 12;

// ---------- Intenciones: palabras clave con su peso ----------
// Se evalúan sobre el texto normalizado (sin tildes). La intención con más puntaje gana; los productos encontrados suman.
const REGLAS = {
  saludo: [[/^(hola|holi|buenas|buenos dias|buen dia|buenas tardes|buenas noches|hey|que mas|quiubo|ola|saludos)\b/, 2]],
  gracias: [[/^(gracias|muchas gracias|mil gracias|listo|ok|okay|perfecto|vale|genial|excelente|chevere|super|de una|entendido)\b/, 2]],
  ayuda: [[/\b(que (puedes|sabes|podes) hacer|en que (me )?(puedes |podes )?ayudar|para que sirves|que te puedo preguntar|como funcionas|que haces|que sabes|ayuda)\b/, 4]],
  pendientes: [
    [/\bpendiente/, 4], [/\b(alertas?|avisos?|notificacion|notificaciones|novedad|novedades|urgente|urgencias)\b/, 4],
    [/\b(resumen|como vamos|como va el negocio|como va todo|como esta el negocio|que hay de nuevo|que me falta|que debo hacer|que tengo que hacer|tareas|prioridades)\b/, 3.5],
    [/\bque tengo\b/, 2],
  ],
  inventario_bajo: [
    [/\b(agotad\w*|por reponer|reponer|reposicion|se (va|van) a (acabar|agotar)|se esta(n)? (acabando|agotando)|acabando|por acabarse|por agotarse|se acaba\w*|se agota\w*|quedan? pocos?|pocas unidades|poco stock|stock bajo|bajo stock|bajo el minimo|en el minimo|faltantes?|sin stock|no hay stock|sin existencias|surtir|resurtir)\b/, 5],
    [/\b(hay que|toca|debo|tengo que|necesito|deberia) (pedir|comprar|reponer|surtir|encargar)\b/, 5],
    [/\b(que|cuales) (productos )?(pedir|comprar|reponer)\b/, 4.5],
  ],
  stock_producto: [
    [/\bcuant[oa]s?\b.*\b(hay|queda|quedan|tengo|tenemos|tienes|tiene|existen|me quedan|nos quedan|tenes|habra|habran)\b/, 3],
    [/\b(hay|queda|quedan|disponib\w*|existencias?|stock|tienes|tenemos|tengo|tenes|cantidad de|unidades de|inventario de|manejas|manejamos)\b/, 2],
  ],
  inventario_general: [
    [/\binventario\b/, 2.5],
    [/\b(cuantos productos|cuantas referencias|cuantos articulos|valor del inventario|cuanto vale (el|mi|nuestro) inventario|todo lo que hay|lista de productos|listado de productos|todos los productos|todo el inventario|catalogo|mercancia|cuantas unidades hay en total)\b/, 4],
  ],
  precio: [[/\b(precio|precios|cuesta|cuestan|vale|valen|a como|a cuanto (lo |la |los |las )?(esta|estan|sale|salen|vendo|vendemos|damos)|cuanto cobro|cuanto cobramos|en cuanto (lo |la )?(vendo|vendemos|dejo))\b/, 3]],
  ventas_periodo: [
    [/\b(vend(i|io|imos|ieron|ido|idos|ida|idas|emos|e)|venta|ventas|facturad\w*|facturamos|facture|ingresos?|cuanto (se )?hizo|cuanto hicimos|cuanto hice|cuanto entro|recaudad\w*)\b/, 3],
  ],
  mas_vendidos: [[/\b(mas vendid\w*|lo que mas se vende|que se vende mas|mas se vend\w*|productos? estrella|mas sale|lo que mas sale|mejores productos|mas rota|top de ventas|top ventas|ranking)\b/, 5]],
  sin_movimiento: [[/\b(no se vende\w*|sin movimiento|quiet\w*|estancad\w*|no rota\w*|no han salido|no sale\w*|menos vendid\w*|lo que menos|sin rotacion|baja rotacion|parad\w*)\b/, 5]],
  ultimas_ventas: [[/\b(ultima venta|ultimas ventas|ventas recientes|que se vendio de ultimo|lo ultimo que se vendio|ultimo que se vendio)\b/, 5.5]],
  caja: [[/\bcaja\b/, 3.5], [/\b(efectivo|cuadre|arqueo|base inicial|cierre del dia|cuanta plata hay|cuanto dinero hay)\b/, 2.5]],
  creditos: [[/\b(creditos?|cartera|me debe\w*|nos debe\w*|deben|deudor\w*|cuotas?|fiad\w*|por cobrar|cobrar|cobros?|vencid\w*|abonos?|morosos?)\b/, 3.5]],
  cliente: [[/\bclientes?\b/, 2.5]],
  compras: [
    [/\b(proveedor\w*|compras?|compre|compramos|cuentas por pagar|por pagar|le debo|les debo|debemos|le debemos|les debemos|deuda con)\b/, 3.5],
    [/\bfacturas?\b/, 2],
  ],
  ganancia: [[/\b(gane|ganamos|ganado|ganancias?|gananci\w*|utilidad\w*|rentab\w*|margen\w*|cuanto me queda|beneficios?|ganando|rendimiento)\b/, 4]],
  gastos: [[/\b(gastos?|gaste|gastamos|gastado|egresos?)\b/, 4]],
  trm: [[/\b(trm|dolar|dolares|tasa de cambio|tasa representativa|usd|divisa)\b/, 5]],
  domicilios: [[/\b(domicilios?|pedidos? a domicilio|pedidos? de hoy|envios?|repartidor\w*|en camino|entregas?|mandados?|flota)\b/, 4.5]],
  comisiones: [[/\b(comision\w*|mi sueldo|mi salario|cuanto llevo|cuanto me gano|mis ventas|mi mes|liquidacion)\b/, 4]],
  documentos: [[/\b(documentos?|facturas recibidas|bandeja)\b/, 3.5]],
  guia: [[/^(como|de que manera|que pasos|pasos para|explicame|ensename|ayudame a|donde (registro|hago|creo|veo|cambio|agrego)|que hago para|necesito saber como|quiero aprender)\b/, 4]],
  navegar: [[/\b(llevame|llevanos|lleva(me)? a|abre|abreme|abrime|abrir|ir a|vamos a|ve a|muestrame la pantalla|quiero ir|mandame a|pasame a)\b/, 6]],
};
const NO_GUIA = /^como (va|van|vamos|voy|esta|estan|estamos|anda|andan|me fue|nos fue|fue|le fue|quedo|quedamos|cerro|cerramos)\b/;

// Palabras de intención que no deben buscarse como producto.
const VACIAS_INTENCION = new Set(('vend vendi vendio vendimos vendieron vendido vendidos vendida vendidas vendemos vende venta ventas precio precios cuesta cuestan ' +
  'vale valen valor valores cobro cobramos sale salen salido salieron agotado agotados agotada agotadas agota agotan acaba acaban acabar acabando ' +
  'reponer pedir comprar surtir minimo poco pocos pocas bajo baja alto rapido mucho muchos tanto tantos ritmo dias dia semana mes ano fecha ' +
  'tienda bodega local almacen negocio mismo momento ahorita orita alguno alguna algun ningun ninguna hay habra habran quedara quedaran ' +
  'nuevo nuevos registrado registrados guardado guardados cargado cargados esta estan llevo lleva cual cuales que donde ubicacion vendo dejo damos ' +
  'cliente clientes debe deben debo deuda saldo cuantas cuantos').split(/\s+/));

// Destinos para "llévame a…": [patrón, ruta]. El orden importa (lo más específico primero).
const DESTINOS = [
  [/\bnueva compra|registrar (una )?compra|ingresar (una )?compra/, '#/compras/nueva'],
  [/\bnuevo producto|crear (un )?producto|agregar (un )?producto/, '#/inventario/nuevo'],
  [/\bnuevo domicilio|tomar (un )?(pedido|domicilio)|nuevo pedido/, '#/domicilios/nuevo'],
  [/\brepartidores?\b/, '#/domicilios/repartidores'],
  [/\bvender\b|punto de venta|nueva venta|hacer (una )?venta|\bpos\b/, '#/vender'],
  [/\bventas\b|historial de ventas/, '#/ventas'],
  [/\bcompras?\b/, '#/compras'],
  [/\binventario|productos/, '#/inventario'],
  [/\bcaja|gastos/, '#/caja'],
  [/\bcreditos?|cartera|cobros/, '#/creditos'],
  [/\bclientes?\b/, '#/clientes'],
  [/\bdomicilios?|pedidos|envios\b/, '#/domicilios'],
  [/\bproveedores?\b/, '#/proveedores'],
  [/\breportes?\b|informes?/, '#/reportes'],
  [/\bgraficas?|estadisticas|tablero/, '#/graficas'],
  [/\btrm\b|dolar/, '#/contabilidad/trm'],
  [/\bcontabilidad\b/, '#/contabilidad'],
  [/\bcomisiones|rentabilidad/, '#/comisiones'],
  [/\bmarketing|campanas|publicidad/, '#/marketing'],
  [/\bdocumentos|bandeja/, '#/documentos'],
  [/\busuarios\b/, '#/configuracion/usuarios'],
  [/\bpermisos\b/, '#/configuracion/permisos'],
  [/\bmi cuenta|contrasena|clave/, '#/configuracion/cuenta'],
  [/\bconfiguracion|ajustes/, '#/configuracion'],
  [/\binicio|principal|home/, '#/inicio'],
];

const ir = (hash, etiqueta) => ({ tipo: 'navegar', hash, etiqueta: etiqueta || herramientas.RUTAS[hash.split('?')[0]] || hash });
const sinPermiso = (que, extra = '') => ({ texto: `No tienes permiso para ${que}.${extra ? ' ' + extra : ''} Si lo necesitas, pídele al administrador que te lo habilite en Configuración › Permisos.`, acciones: [], sugerencias: [] });
const marca = (p) => (p.stock <= 0 ? ' · **agotado**' : p.stock <= p.stock_minimo ? ` · en el mínimo (${L.num(p.stock_minimo)})` : '');

// ---------- Búsqueda de productos por texto libre ----------
function indiceProductos(db) {
  const filas = db.prepare(`SELECT p.id, p.nombre, p.marca, p.referencia, p.modelo_compatible, p.color, p.capacidad, p.sku, p.codigo_barras,
      p.stock_minimo, p.precio_venta, p.precio_compra, p.estado, p.requiere_serial, p.ubicacion, s.stock, c.nombre AS categoria, sc.nombre AS subcategoria
    FROM productos p JOIN v_stock s ON s.producto_id = p.id LEFT JOIN categorias c ON c.id = p.categoria_id LEFT JOIN categorias sc ON sc.id = p.subcategoria_id
    WHERE p.estado <> 'inactivo'`).all();
  return filas.map((p) => ({
    ...p,
    tNombre: L.tokens(L.normalizar([p.nombre, p.marca, p.referencia, p.modelo_compatible, p.color, p.capacidad].filter(Boolean).join(' '))),
    tCategoria: L.tokens(L.normalizar([p.categoria, p.subcategoria].filter(Boolean).join(' '))),
  }));
}
const tieneDigito = (t) => /\d/.test(t);
function puntajeToken(qt, lista) {
  let mejor = 0;
  for (const pt of lista) {
    if (pt === qt) { mejor = Math.max(mejor, tieneDigito(qt) ? 4 : qt.length >= 4 ? 3 : 2); continue; }
    if (tieneDigito(qt) || tieneDigito(pt)) continue;
    if (qt.length >= 3 && pt.startsWith(qt)) mejor = Math.max(mejor, 2);
    else if (pt.length >= 4 && qt.startsWith(pt)) mejor = Math.max(mejor, 1.5);
    else if (qt.length >= 5 && L.distancia(qt, pt, qt.length >= 8 ? 2 : 1) <= (qt.length >= 8 ? 2 : 1)) mejor = Math.max(mejor, 1.5);
  }
  return mejor;
}
// Devuelve { productos: [...con puntaje], mejor, consulta } con los productos que mejor coinciden con el texto.
// Apodos y jerga de licorera → palabra del catálogo.
const SINONIMOS = [[/\bguaros?\b/g, 'aguardiente'], [/\b(polas?|birras?|chelas?)\b/g, 'cerveza'], [/\b(guisqui|wiski|whiskey|wisky|guiski)\b/g, 'whisky'],
  [/\bcaldas\b/g, 'viejo de caldas'], [/\bantioque(n|ñ)o\b/g, 'antioqueno'], [/\b(redbull|red bul)\b/g, 'red bull'], [/\bchampa(n|ñ)a\b/g, 'champagne'], [/\bhielito\b/g, 'hielo']];
function conSinonimos(n) { let t = String(n || ''); for (const [re, v] of SINONIMOS) t = t.replace(re, v); return t; }

function buscarProductos(db, n, { estricto = false, indice } = {}) {
  n = conSinonimos(n);
  const idx = indice || indiceProductos(db);
  const crudos = String(n).split(/\s+/).filter(Boolean);
  // Código de barras, SKU o serial/estampilla exactos
  const directos = new Set();
  for (const c of crudos) {
    if (c.length < 4) continue;
    for (const p of idx) if ((p.codigo_barras && L.normalizar(p.codigo_barras) === c) || (p.sku && L.normalizar(p.sku) === c)) directos.add(p.id);
    if (/^\d{8,}$/.test(c)) for (const l of db.prepare("SELECT DISTINCT producto_id FROM lotes WHERE serial = ? AND estado <> 'anulado'").all(c)) directos.add(l.producto_id);
  }
  if (directos.size) return { productos: idx.filter((p) => directos.has(p.id)).map((p) => ({ ...p, puntaje: 10 })), mejor: 10, consulta: crudos.join(' ') };
  const q = [...new Set(L.tokens(n, { extraVacias: VACIAS_INTENCION }))];
  if (!q.length) return { productos: [], mejor: 0, consulta: '' };
  const visible = String(n).split(/[^a-z0-9.]+/).filter((t) => t && !L.PALABRAS_VACIAS.has(t) && !VACIAS_INTENCION.has(t) && (t.length >= 2 || /\d/.test(t))).join(' ');
  const puntuados = [];
  for (const p of idx) {
    let puntaje = 0; let coinciden = 0;
    const tienenNumero = p.tNombre.some(tieneDigito);
    for (const qt of q) {
      let s = puntajeToken(qt, p.tNombre);
      if (!s) { const c = puntajeToken(qt, p.tCategoria); s = c ? Math.min(c, 2) : 0; }
      if (s) { puntaje += s; coinciden += 1; } else if (tieneDigito(qt) && tienenNumero) puntaje -= 2.5; // "Old Parr 12" no es "Old Parr 18"
    }
    if (puntaje > 0) puntuados.push({ ...p, puntaje, cobertura: coinciden / q.length });
  }
  if (!puntuados.length) return { productos: [], mejor: 0, consulta: q.join(' ') };
  const mejor = Math.max(...puntuados.map((p) => p.puntaje));
  const minimo = estricto ? 3 : 2;
  const minCobertura = estricto ? 0.6 : 0.3;
  const elegidos = puntuados.filter((p) => p.puntaje >= Math.max(minimo, mejor * 0.75) && p.cobertura >= minCobertura)
    .sort((a, b) => b.puntaje - a.puntaje || b.stock - a.stock || a.nombre.localeCompare(b.nombre));
  return { productos: elegidos, mejor: elegidos.length ? mejor : 0, consulta: visible || q.join(' '), filtro: terminoInventario(q, elegidos[0]), cercanos: elegidos.length ? [] : puntuados.sort((a, b) => b.puntaje - a.puntaje).slice(0, 3) };
}
// Palabras reales del nombre del producto que coincidieron, para abrir Inventario ya filtrado (su buscador usa LIKE).
function terminoInventario(q, p) {
  if (!p) return '';
  const palabras = String(p.nombre).split(/\s+/);
  const usadas = palabras.filter((w) => { const r = L.raiz(L.normalizar(w)); return q.some((t) => t === r || (r.startsWith(t) && t.length >= 3)); });
  const unido = usadas.join(' ');
  if (unido && L.normalizar(p.nombre).includes(L.normalizar(unido))) return unido;
  return usadas[0] || (p.categoria && q.length === 1 ? '' : '');
}

// ---------- Búsqueda de clientes por nombre, teléfono o cédula ----------
function buscarClientes(db, n) {
  const filas = db.prepare('SELECT id, nombre, telefono, identificacion FROM clientes WHERE activo = 1 LIMIT 5000').all();
  const crudos = String(n).split(/\s+/);
  const directos = filas.filter((c) => crudos.some((t) => t.length >= 6 && /^\d+$/.test(t) && (String(c.telefono || '').replace(/\D/g, '') === t || String(c.identificacion || '').replace(/\D/g, '') === t)));
  if (directos.length) return directos;
  const q = [...new Set(L.tokens(n, { extraVacias: VACIAS_INTENCION }))].filter((t) => !tieneDigito(t) && t.length >= 3);
  if (!q.length) return [];
  const puntuados = filas.map((c) => {
    const tc = L.tokens(L.normalizar(c.nombre));
    let s = 0;
    for (const qt of q) s += puntajeToken(qt, tc);
    return { ...c, puntaje: s };
  }).filter((c) => c.puntaje >= 2);
  if (!puntuados.length) return [];
  const mejor = Math.max(...puntuados.map((c) => c.puntaje));
  return puntuados.filter((c) => c.puntaje >= mejor * 0.8).sort((a, b) => b.puntaje - a.puntaje).slice(0, 5);
}

// ---------- Utilidades de respuesta ----------
async function herramienta(ctx, nombre, args) { return herramientas.ejecutar(ctx.db, ctx.usuario, nombre, args); }
const periodoOMes = (ctx) => ctx.periodo || { desde: rangoPeriodo('mes').desde, hasta: hoy(), etiqueta: 'este mes' };
const periodoOHoy = (ctx) => ctx.periodo || { desde: hoy(), hasta: hoy(), etiqueta: 'hoy' };
const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

function variacionTexto(v, etiquetaAnterior) {
  if (!v || v.pct === null || v.pct === undefined) return v && v.diferencia ? `${etiquetaAnterior === 'ayer' ? 'Ayer' : `En ${etiquetaAnterior}`} no hubo ventas para comparar.` : null;
  if (v.pct === 0) return `Igual que ${etiquetaAnterior}.`;
  return `${v.pct > 0 ? '▲' : '▼'} ${L.pct(Math.abs(v.pct))} ${v.pct > 0 ? 'más' : 'menos'} que ${etiquetaAnterior}.`;
}
function etiquetaAnterior(periodo, ant) {
  if (!ant) return 'el periodo anterior';
  if (periodo.desde === periodo.hasta) return periodo.desde === hoy() ? 'ayer' : `el día anterior (${L.diaMes(ant.desde)})`;
  return `el periodo anterior (${L.diaMes(ant.desde)} al ${L.diaMes(ant.hasta)})`;
}

// ---------- Respuestas por intención ----------
const R = {};

R.saludo = (ctx) => {
  const res = avisosSrv.resumen(ctx.db, ctx.usuario);
  return {
    texto: `¡Hola${ctx.nombre ? `, ${ctx.nombre}` : ''}! Soy ${ctx.nombreAsistente}. ${res.lineas.join(' ')}\n\n${avisosSrv.textoAvisos(res.avisos)}`.trim(),
    acciones: res.avisos.length ? [{ tipo: 'avisos', items: res.avisos.slice(0, 8) }] : [],
    sugerencias: sugerenciasBase(ctx).slice(0, 3),
  };
};

R.gracias = (ctx) => ({ texto: `¡Con gusto${ctx.nombre ? `, ${ctx.nombre}` : ''}! Aquí estoy si necesitas algo más.`, acciones: [], sugerencias: [] });

R.ayuda = (ctx) => {
  const u = ctx.usuario;
  const lineas = [`Respondo con los datos reales de ${ctx.negocio}, según lo que tu usuario puede ver. Por ejemplo:`];
  if (tiene(u, 'inventario.ver') || tiene(u, 'ventas.crear')) lineas.push('- **Inventario**: "¿Cuánto Antioqueño tapa azul hay?", "¿A cómo está el Old Parr?", "¿Qué se va a acabar?"');
  if (tiene(u, 'ventas.ver') || tiene(u, 'comisiones.ver_propias')) lineas.push('- **Ventas**: "¿Cuánto se vendió hoy?", "Ventas del 15 de octubre", "¿Cuántas Águila se vendieron este mes?"');
  lineas.push('- **Pendientes**: "¿Qué tengo pendiente?" o toca la campana para ver tus avisos');
  if (tiene(u, 'caja.ver')) lineas.push('- **Caja**: "¿Cómo va la caja?"');
  if (tiene(u, 'domicilios.ver')) lineas.push('- **Domicilios**: "¿Cómo van los domicilios?", "¿Qué pedidos están atrasados?"');
  if (tiene(u, 'creditos.ver')) lineas.push('- **Cartera**: "¿Quién me debe?", "Créditos vencidos", "¿Cuánto debe Ana?"');
  if (tiene(u, 'compras.ver')) lineas.push('- **Proveedores**: "¿Cuánto le debo a los proveedores?", "Última compra"');
  if (tiene(u, 'inventario.ver') || tiene(u, 'contabilidad.ver')) lineas.push('- **Ganancias**: "¿Cuánto gané este mes?", "Gastos de la semana"');
  lineas.push('- **Procesos**: "¿Cómo cierro la caja?", "¿Cómo tomo un domicilio?", "¿Cómo funciona el precio mayorista?"');
  lineas.push('- **Ir a una pantalla**: "Llévame a inventario"');
  return { texto: lineas.join('\n'), acciones: [], sugerencias: sugerenciasBase(ctx).slice(0, 4) };
};

R.pendientes = (ctx) => {
  const res = avisosSrv.resumen(ctx.db, ctx.usuario);
  const cab = res.lineas.length ? res.lineas.join('\n') + '\n\n' : '';
  const notas = res.avisos.filter((a) => a.nota).map((a) => a.nota);
  return {
    texto: `${cab}${avisosSrv.textoAvisos(res.avisos)}${notas.length ? `\n\n${notas[0]}` : ''}`,
    acciones: res.avisos.length ? [{ tipo: 'avisos', items: res.avisos.slice(0, 8) }] : [],
    sugerencias: res.avisos.some((a) => a.modulo === 'inventario') ? ['¿Qué productos debo pedir?', '¿Cuánto se vendió hoy?'] : ['¿Cuánto se vendió hoy?', '¿Cómo va la caja?'],
  };
};

R.stock_producto = (ctx) => {
  const u = ctx.usuario;
  if (!tiene(u, 'inventario.ver') && !tiene(u, 'ventas.crear')) return sinPermiso('consultar el inventario');
  const b = ctx.busqueda();
  if (!b.productos.length) {
    const consulta = b.consulta || ctx.textoOriginal;
    const cercanos = (b.cercanos || []).map((p) => p.nombre);
    return {
      texto: `No encontré productos que coincidan con “${consulta}” en el inventario.${cercanos.length ? `\n\nLo más parecido que tengo:\n${cercanos.map((c) => `- ${c}`).join('\n')}` : ' Prueba con otra palabra (marca, modelo o tipo de producto).'}`,
      acciones: [ir('#/inventario', 'Abrir inventario')],
      sugerencias: cercanos.slice(0, 2).map((c) => `¿Cuántos hay de ${c}?`),
    };
  }
  const lista = b.productos;
  const cob = new Map(avisosSrv.coberturaProductos(ctx.db, { ids: lista.slice(0, MAX_LISTA).map((p) => p.id) }).map((c) => [c.id, c]));
  if (lista.length === 1) {
    const p = lista[0];
    const c = cob.get(p.id);
    const lineas = [p.stock > 0 ? `De **${p.nombre}** hay **${L.unidades(p.stock)}** ${p.stock === 1 ? 'disponible' : 'disponibles'}.` : `**${p.nombre}** está **agotado**: no quedan unidades.`];
    lineas.push(`- Precio de venta: **${L.cop(p.precio_venta)}**`);
    if (p.stock > 0 && p.stock <= p.stock_minimo) lineas.push(`- Está en el mínimo configurado (${L.num(p.stock_minimo)}). Conviene reponerlo.`);
    if (c && c.vendidas) lineas.push(`- En los últimos ${c.ventana} días ${c.vendidas === 1 ? 'se vendió' : 'se vendieron'} ${L.unidades(c.vendidas)}${c.dias_cobertura !== null ? `; al ritmo actual ${avisosSrv.textoCobertura(c)}` : ''}.`);
    else if (c) lineas.push(`- No ha tenido ventas en los últimos ${c.ventana} días.`);
    if (p.categoria) lineas.push(`- Categoría: ${p.categoria}${p.ubicacion ? ` · ubicación: ${p.ubicacion}` : ''}`);
    if (tiene(u, 'inventario.ver') && p.precio_compra) lineas.push(`- Costo de referencia: ${L.cop(p.precio_compra)}`);
    return { texto: lineas.join('\n'), acciones: [ir(`#/inventario/${p.id}`, 'Ver el producto')], sugerencias: ['¿Qué productos se van a acabar?', `¿Cuántas unidades de ${p.nombre} se vendieron este mes?`], productos: [p.id] };
  }
  const total = lista.reduce((s, p) => s + Math.max(0, p.stock), 0);
  const mostrados = lista.slice(0, MAX_LISTA);
  const lineas = [`Encontré **${L.plural(lista.length, 'producto', 'productos')}** para “${b.consulta}”. En total hay **${L.unidades(total)}**:`];
  for (const p of mostrados) lineas.push(`- **${p.nombre}**: ${L.unidades(p.stock)} · ${L.cop(p.precio_venta)}${marca(p)}`);
  if (lista.length > mostrados.length) lineas.push(`- …y ${L.num(lista.length - mostrados.length)} más (ábrelos en Inventario).`);
  const agot = lista.filter((p) => p.stock <= 0).length;
  if (agot) lineas.push(`\n${agot === 1 ? 'Uno está agotado' : `${L.num(agot)} están agotados`}.`);
  return { texto: lineas.join('\n'), acciones: [ir(b.filtro ? `#/inventario?${qs({ q: b.filtro })}` : '#/inventario', 'Ver en inventario')], sugerencias: ['¿Qué productos se van a acabar?', '¿Qué es lo más vendido del mes?'], productos: lista.map((p) => p.id) };
};

R.precio = (ctx) => {
  const u = ctx.usuario;
  if (!tiene(u, 'inventario.ver') && !tiene(u, 'ventas.crear')) return sinPermiso('consultar precios');
  const b = ctx.busqueda();
  if (!b.productos.length) return R.stock_producto(ctx);
  const costos = tiene(u, 'inventario.ver');
  const lineas = b.productos.length === 1 ? [] : [`Precios de **${L.plural(b.productos.length, 'producto', 'productos')}** para “${b.consulta}”:`];
  for (const p of b.productos.slice(0, MAX_LISTA)) {
    const margen = p.precio_venta > 0 && p.precio_compra ? Math.round(((p.precio_venta - p.precio_compra) * 1000) / p.precio_venta) / 10 : null;
    const extra = costos && p.precio_compra ? ` · costo ${L.cop(p.precio_compra)}${margen !== null ? ` (margen ${L.pct(margen)})` : ''}` : '';
    if (b.productos.length === 1) lineas.push(`**${p.nombre}** se vende a **${L.cop(p.precio_venta)}**.${extra ? `\n- ${extra.replace(/^ · /, 'Costo de referencia: ').replace('costo ', '')}` : ''}\n- Disponibles: ${L.unidades(p.stock)}${marca(p)}`);
    else lineas.push(`- **${p.nombre}**: ${L.cop(p.precio_venta)}${extra} · ${L.num(p.stock)} disp.`);
  }
  return { texto: lineas.join('\n'), acciones: [ir(b.filtro ? `#/inventario?${qs({ q: b.filtro })}` : '#/inventario', 'Ver en inventario')], sugerencias: [], productos: b.productos.map((p) => p.id) };
};

R.inventario_bajo = (ctx) => {
  const u = ctx.usuario;
  if (!tiene(u, 'inventario.ver') && !tiene(u, 'ventas.crear')) return sinPermiso('consultar el inventario');
  const inv = avisosSrv.estadoInventario(ctx.db, avisosSrv.diasCoberturaConfig(ctx.db));
  const prov = new Map();
  if (tiene(u, 'compras.ver') || tiene(u, 'inventario.ver')) for (const r of analitica.reposicion(ctx.db, 200)) prov.set(r.id, r);
  const conProv = (p) => { const r = prov.get(p.id); return r && r.proveedor ? ` · último proveedor: ${r.proveedor}${tiene(u, 'inventario.ver') && r.ultimo_costo ? ` (${L.cop(r.ultimo_costo)} c/u)` : ''}` : ''; };
  if (!inv.agotados.length && !inv.minimo.length && !inv.pronto.length) {
    return { texto: `¡Todo bien con el inventario! Ningún producto está agotado, en el mínimo ni a punto de acabarse en los próximos ${inv.dias_cobertura} días.`, acciones: [ir('#/inventario')], sugerencias: ['¿Qué es lo más vendido del mes?', '¿Qué productos no se venden?'] };
  }
  const lineas = ['Esto es lo que conviene reponer:'];
  if (inv.agotados.length) {
    lineas.push(`\n**Agotados (${L.num(inv.agotados.length)})**`);
    for (const p of inv.agotados.slice(0, MAX_LISTA)) lineas.push(`- **${p.nombre}**: 0 unidades${p.vendidas ? ` · se vendieron ${L.num(p.vendidas)} en ${inv.ventana} días` : ''}${conProv(p)}`);
  }
  if (inv.minimo.length) {
    lineas.push(`\n**En el mínimo o por debajo (${L.num(inv.minimo.length)})**`);
    for (const p of inv.minimo.slice(0, MAX_LISTA)) lineas.push(`- **${p.nombre}**: quedan ${L.num(p.stock)} (mínimo ${L.num(p.stock_minimo)})${avisosSrv.textoCobertura(p) ? ` · ${avisosSrv.textoCobertura(p)}` : ''}${conProv(p)}`);
  }
  if (inv.pronto.length) {
    lineas.push(`\n**Se acabarán en menos de ${inv.dias_cobertura} días (${L.num(inv.pronto.length)})**`);
    for (const p of inv.pronto.slice(0, MAX_LISTA)) lineas.push(`- **${p.nombre}**: quedan ${L.num(p.stock)} · se venden ~${L.num(Math.max(1, Math.round(p.ritmo_dia * 7)))} por semana · ${avisosSrv.textoCobertura(p)}`);
    lineas.push(`\nLa proyección usa el ritmo de ventas de los últimos ${inv.ventana} días; es una estimación.`);
  }
  const acciones = [ir(`#/inventario?filtro=${inv.agotados.length ? 'agotados' : 'stock_bajo'}`, 'Ver en inventario')];
  if (tiene(u, 'compras.crear')) acciones.push(ir('#/compras/nueva', 'Registrar una compra'));
  return { texto: lineas.join('\n'), acciones, sugerencias: ['¿Cuánto le debo a los proveedores?', '¿Qué es lo más vendido del mes?'], productos: [...inv.agotados, ...inv.minimo, ...inv.pronto].map((p) => p.id) };
};

R.inventario_general = (ctx) => {
  const u = ctx.usuario;
  if (!tiene(u, 'inventario.ver') && !tiene(u, 'ventas.crear')) return sinPermiso('consultar el inventario');
  const costos = tiene(u, 'inventario.ver');
  const inv = dashboard.inventarioResumen(ctx.db);
  const dist = analitica.distribucionInventario(ctx.db, costos);
  const lineas = [`Inventario actual: **${L.unidades(inv.unidades)}** en **${L.plural(inv.productos, 'producto', 'productos')}**.`];
  lineas.push(`- Valor a precio de venta: **${L.cop(inv.valor_venta)}**`);
  if (costos) lineas.push(`- Valor al costo: ${L.cop(inv.valor_costo)}`);
  if (inv.agotados || inv.pocas) lineas.push(`- Por reponer: ${L.num(inv.agotados)} agotados y ${L.num(inv.pocas)} en el mínimo`);
  const pideLista = /\b(lista|listado|todos los productos|todo el inventario|catalogo|que productos hay|que hay en inventario|cada producto|todo lo que hay)\b/.test(ctx.n);
  if (pideLista) {
    const filas = ctx.indice().sort((a, b) => String(a.categoria || '').localeCompare(String(b.categoria || '')) || a.nombre.localeCompare(b.nombre));
    let cat = null; let n = 0;
    for (const p of filas) {
      if (n >= 40) { lineas.push(`\n…y ${L.num(filas.length - n)} productos más. Ábrelos en Inventario.`); break; }
      if (p.categoria !== cat) { cat = p.categoria; lineas.push(`\n**${cat || 'Sin categoría'}**`); }
      lineas.push(`- ${p.nombre}: ${L.unidades(p.stock)}${marca(p)}`);
      n += 1;
    }
  } else if (dist.categoria.length) {
    lineas.push('\nUnidades por categoría:');
    for (const c of dist.categoria.slice(0, 10)) lineas.push(`- ${c.etiqueta}: ${L.unidades(c.unidades)} (${L.plural(c.productos, 'producto', 'productos')})`);
  }
  return { texto: lineas.join('\n'), acciones: [ir('#/inventario')], sugerencias: pideLista ? ['¿Qué se va a acabar?'] : ['Lista de productos con sus cantidades', '¿Qué se va a acabar?'] };
};

R.ventas_periodo = async (ctx) => {
  const p = periodoOHoy(ctx);
  const r = await herramienta(ctx, 'consultar_ventas', { desde: p.desde, hasta: p.hasta });
  if (!r.ok) return sinPermiso('consultar ventas');
  const d = r.datos;
  const et = L.capitalizar(p.etiqueta);
  if (d.alcance === 'propio') {
    const s = d.resumen || {};
    if (!s.ventas) return { texto: `${et} no tienes ventas registradas.`, acciones: [ir('#/ventas')], sugerencias: ['¿Cuánto llevo en comisiones este mes?'] };
    const lineas = [`${et} llevas **${L.plural(s.ventas, 'venta', 'ventas')}**${s.ingreso_neto !== undefined ? ` por **${L.cop(s.ingreso_neto)}**` : ''}.`];
    if (s.comision_estimada !== undefined) lineas.push(`- Comisión estimada: **${L.cop(s.comision_estimada)}**`);
    for (const v of (d.ventas || []).slice(0, 6)) lineas.push(`- ${v.numero} · ${L.diaMes(v.fecha)} · ${L.cop(v.total)}${v.cliente_nombre ? ` · ${v.cliente_nombre}` : ''}`);
    return { texto: lineas.join('\n'), acciones: [ir('#/comisiones', 'Ver mis comisiones')], sugerencias: [] };
  }
  const s = d.resumen || {};
  if (!s.cantidad) {
    return { texto: `${et} no hubo ventas registradas.${s.devoluciones ? ` Hubo devoluciones por ${L.cop(s.devoluciones)}.` : ''}`, acciones: [ir('#/ventas')], sugerencias: [p.desde === hoy() ? '¿Cuánto se vendió ayer?' : '¿Cuánto se vendió hoy?', '¿Qué tengo pendiente?'] };
  }
  const lineas = [`${et} se vendieron **${L.cop(s.total)}** en **${L.plural(s.cantidad, 'venta', 'ventas')}** (${L.unidades(s.unidades || 0)}).`];
  const varT = variacionTexto(s.variacion_total, etiquetaAnterior(p, d.periodo_anterior));
  if (varT) lineas.push(`- ${varT}`);
  lineas.push(`- Ticket promedio: ${L.cop(s.promedio)}`);
  if (s.ganancia_bruta !== undefined && tiene(ctx.usuario, 'inventario.ver')) lineas.push(`- Ganancia bruta: **${L.cop(s.ganancia_bruta)}** (margen ${L.pct(s.margen_pct)})`);
  if (s.devoluciones) lineas.push(`- Devoluciones: ${L.cop(s.devoluciones)} (ya descontadas)`);
  const mp = d.metodos_pago && d.metodos_pago.items ? d.metodos_pago.items : [];
  if (mp.length) lineas.push(`- Dinero recibido: ${L.cop(s.recibido)} (${mp.slice(0, 4).map((m) => `${m.metodo} ${L.cop(m.total)}`).join(', ')})`);
  if (s.credito_otorgado) lineas.push(`- Quedó a crédito: ${L.cop(s.credito_otorgado)}`);
  const top = (d.mas_vendidos || []).slice(0, 3);
  if (top.length) { lineas.push('\nLo más vendido:'); for (const t of top) lineas.push(`- ${t.nombre}: ${L.unidades(t.unidades)} (${L.cop(t.total)})`); }
  if ((d.por_vendedor || []).length > 1) lineas.push(`\nPor vendedor: ${d.por_vendedor.slice(0, 4).map((v) => `${v.vendedor} ${L.cop(v.total)}`).join(' · ')}`);
  const sug = p.desde === p.hasta && p.desde === hoy() ? ['¿Y ayer?', '¿Cómo va la caja?'] : ['¿Cuánto se vendió hoy?', '¿Qué es lo más vendido del mes?'];
  return { texto: lineas.join('\n'), acciones: [ir('#/ventas', 'Ver historial de ventas')], sugerencias: sug };
};

R.ventas_producto = (ctx) => {
  const u = ctx.usuario;
  const global = tiene(u, 'ventas.ver');
  if (!global && !tiene(u, 'comisiones.ver_propias')) return sinPermiso('consultar ventas');
  const b = ctx.busqueda();
  if (!b.productos.length) return R.ventas_periodo(ctx);
  const p = periodoOMes(ctx);
  const ids = b.productos.map((x) => x.id);
  const filas = ctx.db.prepare(`SELECT vi.producto_id id, COALESCE(SUM(vi.cantidad - vi.cantidad_devuelta),0) unidades, COALESCE(SUM(vi.total),0) total, COUNT(DISTINCT v.id) ventas
      FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id
      WHERE v.estado <> 'anulada' AND v.fecha BETWEEN ? AND ? AND vi.producto_id IN (${ids.map(() => '?').join(',')}) ${global ? '' : 'AND v.vendedor_id = ?'}
      GROUP BY vi.producto_id`).all(p.desde + ' 00:00:00', p.hasta + ' 23:59:59', ...ids, ...(global ? [] : [u.id]));
  const porId = new Map(filas.map((f) => [f.id, f]));
  const quien = (u1) => (global ? (u1 === 1 ? 'se vendió' : 'se vendieron') : 'vendiste');
  const et = p.etiqueta;
  if (b.productos.length === 1) {
    const x = b.productos[0]; const f = porId.get(x.id);
    const texto = f && f.unidades > 0
      ? `De **${x.nombre}** ${quien(f.unidades)} **${L.unidades(f.unidades)}** ${et} (${L.cop(f.total)} en ${L.plural(f.ventas, 'venta', 'ventas')}).\n- Quedan ${L.unidades(x.stock)} en inventario${marca(x)}`
      : `${L.capitalizar(et)} no ${global ? 'se vendió' : 'vendiste'} ninguna unidad de **${x.nombre}**.\n- Quedan ${L.unidades(x.stock)} en inventario${marca(x)}`;
    return { texto, acciones: [ir(`#/inventario/${x.id}`, 'Ver el producto')], sugerencias: [], productos: ids };
  }
  const totalU = filas.reduce((s, f) => s + f.unidades, 0);
  const totalV = filas.reduce((s, f) => s + f.total, 0);
  const lineas = [totalU ? `Para “${b.consulta}” ${quien(totalU)} **${L.unidades(totalU)}** ${et} (${L.cop(totalV)}):` : `${L.capitalizar(et)} no hubo ventas de “${b.consulta}”. Lo que queda en inventario:`];
  const orden = [...b.productos].sort((a, c) => ((porId.get(c.id) || {}).unidades || 0) - ((porId.get(a.id) || {}).unidades || 0));
  for (const x of orden.slice(0, MAX_LISTA)) {
    const f = porId.get(x.id);
    if (!totalU) { lineas.push(`- **${x.nombre}**: quedan ${L.num(x.stock)}${marca(x)}`); continue; }
    if (f && f.unidades) lineas.push(`- **${x.nombre}**: ${L.unidades(f.unidades)} (${L.cop(f.total)}) · quedan ${L.num(x.stock)}`);
  }
  return { texto: lineas.join('\n'), acciones: [ir(b.filtro ? `#/inventario?${qs({ q: b.filtro })}` : '#/inventario', 'Ver en inventario')], sugerencias: [], productos: ids };
};

R.mas_vendidos = (ctx) => {
  if (!tiene(ctx.usuario, 'ventas.ver')) return sinPermiso('consultar ventas');
  const p = periodoOMes(ctx);
  const filas = analitica.masVendidos(ctx.db, p, 10, tiene(ctx.usuario, 'inventario.ver'));
  if (!filas.length) return { texto: `${L.capitalizar(p.etiqueta)} no hay ventas para armar el ranking.`, acciones: [], sugerencias: ['¿Qué es lo más vendido este año?'] };
  const lineas = [`Lo más vendido ${p.etiqueta}:`];
  filas.forEach((f, i) => lineas.push(`${i + 1}. **${f.nombre}**: ${L.unidades(f.unidades)} · ${L.cop(f.total)}${f.ganancia !== undefined ? ` · ganancia ${L.cop(f.ganancia)}` : ''}`));
  return { texto: lineas.join('\n'), acciones: [ir('#/graficas', 'Ver gráficas')], sugerencias: ['¿Qué productos no se venden?', '¿Qué se va a acabar?'] };
};

R.sin_movimiento = (ctx) => {
  if (!tiene(ctx.usuario, 'inventario.ver')) return sinPermiso('consultar la rotación del inventario');
  const dias = getConfig(ctx.db, 'dias_sin_movimiento') || 30;
  const filas = productosSrv.sinMovimiento(ctx.db, dias);
  if (!filas.length) return { texto: `Todos los productos con existencias se han vendido en los últimos ${dias} días.`, acciones: [], sugerencias: [] };
  const lineas = [`**${L.plural(filas.length, 'producto', 'productos')}** con stock no se han vendido en los últimos ${dias} días:`];
  for (const p of filas.slice(0, MAX_LISTA)) lineas.push(`- **${p.nombre}**: ${L.unidades(p.stock)} · ${p.ultima_venta ? `última venta ${L.fechaCorta(p.ultima_venta)}` : 'nunca se ha vendido'} · capital quieto ${L.cop(p.valor_costo)}`);
  const capital = filas.reduce((s, p) => s + (p.valor_costo || 0), 0);
  lineas.push(`\nCapital inmovilizado (al costo): **${L.cop(capital)}**. Una promoción o combo podría ayudar a moverlos.`);
  return { texto: lineas.join('\n'), acciones: [ir('#/graficas')], sugerencias: ['¿Qué es lo más vendido del mes?'] };
};

R.ultimas_ventas = (ctx) => {
  const u = ctx.usuario;
  const global = tiene(u, 'ventas.ver');
  if (!global && !tiene(u, 'comisiones.ver_propias')) return sinPermiso('consultar ventas');
  const filas = ctx.db.prepare(`SELECT v.id, v.numero, v.fecha, v.total, v.tipo_pago, v.estado, c.nombre AS cliente,
      (SELECT GROUP_CONCAT(vi.nombre_producto, ', ') FROM venta_items vi WHERE vi.venta_id = v.id) AS productos
    FROM ventas v LEFT JOIN clientes c ON c.id = v.cliente_id ${global ? '' : 'WHERE v.vendedor_id = ?'} ORDER BY v.id DESC LIMIT 6`).all(...(global ? [] : [u.id]));
  if (!filas.length) return { texto: 'Todavía no hay ventas registradas.', acciones: [ir('#/vender', 'Hacer una venta')], sugerencias: [] };
  const lineas = ['Últimas ventas:'];
  for (const v of filas) lineas.push(`- **${v.numero}** · ${L.cuandoFue(v.fecha)} ${L.horaDe(v.fecha)} · **${L.cop(v.total)}** · ${v.tipo_pago}${v.cliente ? ` · ${v.cliente}` : ''}${v.estado === 'anulada' ? ' · anulada' : ''}${v.productos ? `\n  ${String(v.productos).slice(0, 90)}` : ''}`);
  return { texto: lineas.join('\n'), acciones: [ir('#/ventas', 'Ver historial de ventas')], sugerencias: ['¿Cuánto se vendió hoy?'] };
};

R.caja = async (ctx) => {
  const diaPasado = ctx.periodo && ctx.periodo.desde === ctx.periodo.hasta && ctx.periodo.hasta < hoy() ? ctx.periodo.desde : null;
  const r = await herramienta(ctx, 'consultar_caja', diaPasado ? { fecha: diaPasado } : {});
  if (!r.ok) return sinPermiso('ver la caja');
  const d = r.datos;
  const desglose = (o) => Object.entries(o || {}).filter(([, v]) => v).map(([k, v]) => `${k} ${L.cop(v)}`).join(', ');
  if (diaPasado) {
    const sesiones = d.sesiones || [];
    if (!sesiones.length) return { texto: `${L.capitalizar(ctx.periodo.etiqueta)} no hubo aperturas ni cierres de caja.`, acciones: [ir('#/caja')], sugerencias: ['¿Cómo va la caja de hoy?'] };
    const lineas = [`Caja ${ctx.periodo.etiqueta}:`];
    for (const s of sesiones) {
      lineas.push(`- Abierta ${L.horaDe(s.abierta_en)}${s.usuario_apertura ? ` por ${s.usuario_apertura}` : ''} con base de ${L.cop(s.base_inicial)}${s.cerrada_en ? ` · cerrada ${L.horaDe(s.cerrada_en)}${s.usuario_cierre ? ` por ${s.usuario_cierre}` : ''}` : ' · quedó sin cerrar'}`);
      if (s.cerrada_en) lineas.push(`- Efectivo esperado ${L.cop(s.efectivo_esperado)} · contado ${L.cop(s.efectivo_contado)} · diferencia **${L.cop(s.diferencia)}**${s.diferencia ? (s.diferencia > 0 ? ' (sobrante)' : ' (faltante)') : ' (cuadró exacto)'}`);
      const rr = s.resumen || {};
      if (rr.total_ingresos) lineas.push(`- Ingresos: ${L.cop(rr.total_ingresos)}${desglose(rr.ingresos) ? ` (${desglose(rr.ingresos)})` : ''}${rr.total_egresos ? ` · egresos ${L.cop(rr.total_egresos)}` : ''}`);
    }
    return { texto: lineas.join('\n'), acciones: [ir('#/caja', 'Ver cierres')], sugerencias: ['¿Cómo va la caja de hoy?'] };
  }
  if (!d.abierta) {
    const c = d.ultimo_cierre;
    const texto = c ? `La caja está **cerrada**. El último cierre fue ${L.cuandoFue(c.cerrada_en)} a las ${L.horaDe(c.cerrada_en)}${c.usuario_cierre ? ` (${c.usuario_cierre})` : ''}:\n- Efectivo esperado: ${L.cop(c.efectivo_esperado)}\n- Efectivo contado: ${L.cop(c.efectivo_contado)}\n- Diferencia: **${L.cop(c.diferencia)}**${c.diferencia ? (c.diferencia > 0 ? ' (sobrante)' : ' (faltante)') : ' (cuadró exacto)'}` : 'La caja está **cerrada** y todavía no se ha abierto nunca.';
    return { texto, acciones: [ir('#/caja', tiene(ctx.usuario, 'caja.operar') ? 'Abrir la caja' : 'Ver caja')], sugerencias: ['¿Cómo abro la caja?'] };
  }
  const s = d.resumen || {};
  const lineas = [`La caja está **abierta** desde ${L.cuandoFue(d.abierta_en)} a las ${L.horaDe(d.abierta_en)}${d.usuario_apertura ? ` (la abrió ${d.usuario_apertura})` : ''}, con base de ${L.cop(d.base_inicial)}.`];
  lineas.push(`- **Efectivo que debería haber: ${L.cop(s.efectivo_esperado)}**`);
  lineas.push(`- Ingresos: ${L.cop(s.total_ingresos)}${desglose(s.ingresos) ? ` (${desglose(s.ingresos)})` : ''}`);
  if (s.total_egresos) lineas.push(`- Egresos: ${L.cop(s.total_egresos)}${desglose(s.gastos) ? ` (gastos: ${desglose(s.gastos)})` : ''}`);
  if (s.ventas_cantidad) lineas.push(`- Ventas del turno: ${L.num(s.ventas_cantidad)} por ${L.cop(s.ventas_facturadas)}${s.ventas_a_credito ? ` (${L.num(s.ventas_a_credito)} a crédito)` : ''}`);
  if (String(d.abierta_en).slice(0, 10) < hoy()) lineas.push('\nOjo: la caja se abrió un día anterior y no se ha cerrado.');
  return { texto: lineas.join('\n'), acciones: [ir('#/caja', 'Ir a la caja')], sugerencias: ['¿Cómo cierro la caja?', '¿Cuánto se vendió hoy?'] };
};

R.creditos = async (ctx) => {
  const n = ctx.n;
  const estado = /\bvencid/.test(n) || /\bmoros/.test(n) ? 'vencido' : /\b(por vencer|proxim|esta semana|pronto)\b/.test(n) ? 'proximo' : 'vigentes';
  // Créditos y abonos de una persona concreta ("¿cuánto debe Juan?", "¿qué ha abonado Pedro?").
  const unCliente = ctx.clientes().length === 1 ? ctx.clientes()[0] : null;
  if (unCliente && /\b(abon\w*|debe\w*|deud\w*|saldos?|credito\w*|fiad\w*|cuotas?|pag\w*)\b/.test(n)) {
    const rc = await herramienta(ctx, 'consultar_creditos', { cliente: unCliente.nombre, estado: estado === 'vencido' ? 'vencido' : 'todos' });
    if (rc.ok && rc.datos && !rc.datos.candidatos) {
      const dd = rc.datos;
      const lineas = [`**${dd.cliente.nombre}**${dd.cliente.telefono ? ` · ${dd.cliente.telefono}` : ''}`];
      const abiertos = (dd.creditos || []).filter((c) => !['pagado', 'anulado'].includes(c.estado));
      lineas.push(dd.saldo_total > 0 ? `- Debe en total **${L.cop(dd.saldo_total)}** en ${L.plural(abiertos.length, 'crédito abierto', 'créditos abiertos')}` : '- No debe nada en este momento');
      for (const c of (dd.creditos || []).slice(0, 5)) lineas.push(`- ${c.numero} (${c.estado}): saldo ${L.cop(c.saldo_actual)}${c.proximo_vencimiento ? ` · próxima cuota el ${L.diaMes(c.proximo_vencimiento)}` : ''}${c.total_abonado ? ` · lleva abonado ${L.cop(c.total_abonado)}` : ''}`);
      const ab = (dd.abonos || []).slice(0, 5);
      if (ab.length) { lineas.push('- Últimos abonos:'); for (const a of ab) lineas.push(`  - ${L.diaMes(a.fecha)} · ${L.cop(a.valor)}${a.metodo_pago ? ` por ${a.metodo_pago}` : ''}${a.credito_numero ? ` (${a.credito_numero})` : ''}`); }
      return { texto: lineas.join('\n'), acciones: [ir('#/creditos', 'Ver créditos')], sugerencias: [] };
    }
  }
  const r = await herramienta(ctx, 'consultar_creditos', { estado, limite: 15 });
  if (!r.ok) return sinPermiso('consultar créditos y cartera');
  const { cartera: c, creditos: lista } = r.datos;
  const lineas = [];
  if (estado === 'vigentes') lineas.push(`Cartera por cobrar: **${L.cop(c.pendiente)}** en ${L.plural(c.vigentes, 'crédito', 'créditos')} (${L.plural(c.clientes, 'cliente', 'clientes')}).${c.vencidos ? ` Vencido: **${L.cop(c.saldo_vencido)}** (${L.plural(c.vencidos, 'crédito', 'créditos')}).` : ' Nada vencido.'}`);
  else if (estado === 'vencido') lineas.push(lista.length ? `Hay **${L.plural(lista.length, 'crédito vencido', 'créditos vencidos')}** por **${L.cop(c.saldo_vencido)}**:` : '¡Buenas noticias! No hay créditos vencidos.');
  else lineas.push(lista.length ? `**${L.plural(lista.length, 'crédito tiene', 'créditos tienen')}** cuotas por vencer pronto:` : 'No hay cuotas por vencer en los próximos días.');
  for (const x of (lista || []).slice(0, MAX_LISTA)) lineas.push(`- **${x.cliente_nombre}** (${x.numero}): debe ${L.cop(x.saldo_actual)}${x.proximo_vencimiento ? ` · ${x.estado === 'vencido' ? 'vencido desde' : 'próxima cuota'} el ${L.diaMes(x.proximo_vencimiento)}` : ''}${x.cliente_telefono ? ` · ${x.cliente_telefono}` : ''}`);
  const filtro = estado === 'vigentes' ? '' : `?estado=${estado}`;
  const acciones = [ir(`#/creditos${filtro}`, 'Ver créditos')];
  if (tiene(ctx.usuario, 'creditos.abonar')) acciones.push(ir('#/creditos?abonar=1', 'Registrar un abono'));
  return { texto: lineas.join('\n'), acciones, sugerencias: estado === 'vencido' ? ['¿Qué cuotas vencen esta semana?'] : ['¿Qué créditos están vencidos?'] };
};

R.cliente = (ctx) => {
  if (!tiene(ctx.usuario, 'clientes.ver')) return sinPermiso('consultar clientes');
  const encontrados = ctx.clientes();
  if (!encontrados.length) {
    const total = ctx.db.prepare('SELECT COUNT(*) n FROM clientes WHERE activo = 1').get().n;
    return { texto: `Tienes **${L.plural(total, 'cliente registrado', 'clientes registrados')}**. Dime el nombre, teléfono o cédula de alguno para ver su saldo y sus compras.`, acciones: [ir('#/clientes')], sugerencias: ['¿Quién me debe?'] };
  }
  const lineas = [];
  for (const c of encontrados.slice(0, 3)) {
    const d = ctx.db.prepare(`SELECT (SELECT COALESCE(SUM(saldo_actual),0) FROM creditos cr WHERE cr.cliente_id = ? AND cr.estado NOT IN ('pagado','anulado')) AS saldo,
        (SELECT COUNT(*) FROM ventas v WHERE v.cliente_id = ? AND v.estado <> 'anulada') AS compras,
        (SELECT COALESCE(SUM(total),0) FROM ventas v WHERE v.cliente_id = ? AND v.estado <> 'anulada') AS comprado,
        (SELECT MAX(fecha) FROM ventas v WHERE v.cliente_id = ? AND v.estado <> 'anulada') AS ultima`).get(c.id, c.id, c.id, c.id);
    lineas.push(`**${c.nombre}**${c.telefono ? ` · ${c.telefono}` : ''}`);
    lineas.push(`- ${d.saldo > 0 ? `Debe **${L.cop(d.saldo)}**` : 'No tiene saldo pendiente'}`);
    lineas.push(`- Compras: ${L.num(d.compras)} por ${L.cop(d.comprado)}${d.ultima ? ` · la última ${L.cuandoFue(d.ultima)}` : ''}`);
    if (tiene(ctx.usuario, 'creditos.ver') && d.saldo > 0) {
      const cr = ctx.db.prepare("SELECT numero, saldo_actual, estado, (SELECT MIN(fecha_vencimiento) FROM credito_cuotas q WHERE q.credito_id = creditos.id AND q.estado <> 'pagada') prox FROM creditos WHERE cliente_id = ? AND estado NOT IN ('pagado','anulado') ORDER BY id").all(c.id);
      for (const x of cr.slice(0, 4)) lineas.push(`- Crédito ${x.numero}: ${L.cop(x.saldo_actual)}${x.prox ? (x.prox < hoy() ? ` · **cuota vencida desde el ${L.diaMes(x.prox)}**` : ` · próxima cuota el ${L.diaMes(x.prox)}`) : ''}`);
    }
    lineas.push('');
  }
  return { texto: lineas.join('\n').trim(), acciones: [ir('#/clientes', 'Ver clientes')], sugerencias: [] };
};

R.compras = async (ctx) => {
  const u = ctx.usuario;
  if (!tiene(u, 'compras.ver')) return sinPermiso('consultar compras y proveedores');
  const n = ctx.n;
  if (/\b(debo|debemos|deuda|por pagar|pagar|saldo|pendiente|vencid|cuentas)\b/.test(n) || (!ctx.periodo && !/\bultim/.test(n))) {
    const facturas = ctx.db.prepare(`SELECT c.numero, c.numero_factura, c.fecha, c.fecha_vencimiento, c.saldo_pendiente, c.moneda, c.saldo_pendiente_moneda, p.nombre AS proveedor
      FROM compras c LEFT JOIN proveedores p ON p.id = c.proveedor_id WHERE c.estado = 'confirmada' AND c.saldo_pendiente > 0
      ORDER BY c.fecha_vencimiento IS NULL, c.fecha_vencimiento, c.fecha`).all();
    if (!facturas.length) return { texto: 'No le debes nada a los proveedores: todas las compras están pagadas.', acciones: [ir('#/compras')], sugerencias: ['¿Cuál fue la última compra?'] };
    const total = facturas.reduce((s, f) => s + f.saldo_pendiente, 0);
    const h = hoy();
    const vencidas = facturas.filter((f) => f.fecha_vencimiento && f.fecha_vencimiento < h);
    const porProv = new Map();
    for (const f of facturas) { const k = f.proveedor || 'Sin proveedor'; const x = porProv.get(k) || { total: 0, n: 0 }; x.total += f.saldo_pendiente; x.n += 1; porProv.set(k, x); }
    const lineas = [`Le debes **${L.cop(total)}** a proveedores en ${L.plural(facturas.length, 'factura', 'facturas')}${vencidas.length ? ` (${L.plural(vencidas.length, 'vencida', 'vencidas')})` : ''}.`];
    lineas.push('\nPor proveedor:');
    for (const [k, x] of [...porProv.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 8)) lineas.push(`- **${k}**: ${L.cop(x.total)} (${L.plural(x.n, 'factura', 'facturas')})`);
    if (vencidas.length) { lineas.push('\nVencidas:'); for (const f of vencidas.slice(0, 6)) lineas.push(`- ${f.proveedor || 'Proveedor'} · ${f.numero_factura || f.numero}: ${L.cop(f.saldo_pendiente)} · venció el ${L.diaMes(f.fecha_vencimiento)}`); }
    return { texto: lineas.join('\n'), acciones: [ir('#/compras?con_saldo=1', 'Ver compras con saldo')], sugerencias: ['¿Cuál fue la última compra?'] };
  }
  const args = ctx.periodo ? { desde: ctx.periodo.desde, hasta: ctx.periodo.hasta, limite: 15 } : { limite: 5 };
  const r = await herramienta(ctx, 'consultar_compras', args);
  if (!r.ok) return sinPermiso('consultar compras');
  const d = r.datos;
  if (!d.compras.length) return { texto: ctx.periodo ? `${L.capitalizar(ctx.periodo.etiqueta)} no se registraron compras.` : 'Todavía no hay compras registradas.', acciones: [ir('#/compras')], sugerencias: [] };
  const lineas = [];
  if (ctx.periodo) lineas.push(`${L.capitalizar(ctx.periodo.etiqueta)} se registraron **${L.plural(d.total_compras_encontradas, 'compra', 'compras')}** por **${L.cop(d.compras.reduce((s, c) => s + (c.total || 0), 0))}**:`);
  else { const c = d.ultima_compra; lineas.push(`La última compra fue **${c.numero}** ${L.cuandoFue(c.fecha)} a **${c.proveedor_nombre || 'proveedor sin nombre'}** por **${L.cop(c.total)}**${c.moneda !== 'COP' ? ` (${L.usd(c.total_moneda)} a ${L.tasa(c.tasa_cambio)})` : ''}${c.saldo_pendiente ? ` · saldo pendiente ${L.cop(c.saldo_pendiente)}` : ' · pagada'}.`); if (c.trm_valor) lineas.push(`- TRM registrada ese día: ${L.tasa(c.trm_valor)}`); lineas.push('\nAnteriores:'); }
  for (const c of d.compras.slice(ctx.periodo ? 0 : 1, 10)) lineas.push(`- ${c.numero} · ${L.diaMes(c.fecha)} · ${c.proveedor_nombre || 'Proveedor'} · ${L.cop(c.total)}${c.saldo_pendiente ? ` · debe ${L.cop(c.saldo_pendiente)}` : ''}`);
  return { texto: lineas.join('\n'), acciones: [ir('#/compras', 'Ver compras')], sugerencias: ['¿Cuánto le debo a los proveedores?'] };
};

R.ganancia = (ctx) => {
  const u = ctx.usuario;
  const p = periodoOMes(ctx);
  // Igual que consultar_rentabilidad: la ganancia de todo el negocio es para contabilidad o quien ve comisiones de todos.
  const global = tiene(u, 'contabilidad.ver') || tiene(u, 'comisiones.ver') || tiene(u, 'comisiones.administrar');
  if (!global) {
    if (tiene(u, 'comisiones.ver_propias')) return R.comisiones(ctx);
    return sinPermiso('ver ganancias del negocio');
  }
  const r = dashboard.resumenPeriodo(ctx.db, p.desde, p.hasta);
  if (!r.ventas.cantidad && !r.gastos) return { texto: `${L.capitalizar(p.etiqueta)} no hay ventas ni gastos registrados.`, acciones: [], sugerencias: [] };
  const lineas = [`Resultado ${p.etiqueta}:`];
  lineas.push(`- Ventas netas: ${L.cop(r.ventas.netas)} (${L.plural(r.ventas.cantidad, 'venta', 'ventas')})`);
  lineas.push(`- Costo de lo vendido: ${L.cop(r.ventas.costo)}`);
  lineas.push(`- **Ganancia bruta: ${L.cop(r.ventas.ganancia_bruta)}** (margen ${L.pct(r.ventas.margen_pct)})`);
  lineas.push(`- Gastos registrados: ${L.cop(r.gastos)}`);
  lineas.push(`- **Utilidad estimada: ${L.cop(r.utilidad_estimada)}**`);
  lineas.push('\nUtilidad estimada = ganancia bruta − gastos registrados. Salarios y comisiones cuentan solo si se registraron como gastos.');
  return { texto: lineas.join('\n'), acciones: [ir(tiene(u, 'contabilidad.ver') ? '#/contabilidad' : '#/comisiones', 'Ver el detalle')], sugerencias: ['¿Cuáles fueron los gastos del mes?', '¿Qué es lo más vendido del mes?'] };
};

R.gastos = (ctx) => {
  const u = ctx.usuario;
  if (!tiene(u, 'caja.ver') && !tiene(u, 'contabilidad.ver')) return sinPermiso('consultar gastos');
  const p = periodoOMes(ctx);
  const filas = ctx.db.prepare("SELECT COALESCE(categoria,'Sin categoría') categoria, COUNT(*) n, SUM(valor) total FROM gastos WHERE anulado = 0 AND fecha BETWEEN ? AND ? GROUP BY categoria ORDER BY total DESC").all(p.desde + ' 00:00:00', p.hasta + ' 23:59:59');
  if (!filas.length) return { texto: `${L.capitalizar(p.etiqueta)} no hay gastos registrados.`, acciones: [ir('#/caja')], sugerencias: [] };
  const total = filas.reduce((s, f) => s + f.total, 0);
  const lineas = [`Gastos ${p.etiqueta}: **${L.cop(total)}** en ${L.plural(filas.reduce((s, f) => s + f.n, 0), 'registro', 'registros')}.`];
  for (const f of filas.slice(0, 10)) lineas.push(`- ${f.categoria}: ${L.cop(f.total)}`);
  return { texto: lineas.join('\n'), acciones: [ir('#/caja', 'Ver caja y gastos')], sugerencias: ['¿Cuánto gané este mes?'] };
};

R.trm = async (ctx) => {
  const diaPasado = ctx.periodo && ctx.periodo.desde === ctx.periodo.hasta && ctx.periodo.hasta < hoy() ? ctx.periodo.desde : null;
  const r = await herramienta(ctx, 'consultar_trm', diaPasado ? { fecha: diaPasado } : {});
  if (!r.ok) return { texto: 'No pude consultar la TRM en este momento.', acciones: [], sugerencias: [] };
  const d = r.datos;
  const lineas = [];
  if (diaPasado) {
    if (d.trm) lineas.push(`La TRM del ${L.fechaCorta(diaPasado)} fue **${L.tasa(d.trm.valor)}**${d.trm.fecha !== diaPasado ? ` (ese día regía la publicada el ${L.fechaCorta(d.trm.fecha)})` : ''}.`);
    if (d.manual) lineas.push(`- Tasa manual registrada ese día: ${L.tasa(d.manual.valor)}`);
    if (d.mercado) lineas.push(`- Dólar de mercado ese día: ${L.tasa(d.mercado.valor)}`);
    if (!lineas.length) lineas.push(`No tengo ninguna tasa registrada para el ${L.fechaCorta(diaPasado)}.`);
    return { texto: lineas.join('\n'), acciones: [ir('#/contabilidad/trm', 'Ver TRM y dólar')], sugerencias: ['¿A cuánto está el dólar hoy?'] };
  }
  if (d.trm) lineas.push(`La TRM oficial ${d.trm.vigente_hoy ? 'vigente hoy' : `más reciente (${L.fechaCorta(d.trm.fecha)})`} es **${L.tasa(d.trm.valor)}**${d.trm.variacion && d.trm.variacion.diferencia ? ` (${d.trm.variacion.diferencia > 0 ? 'subió' : 'bajó'} ${L.tasa(Math.abs(d.trm.variacion.diferencia))} frente al día anterior)` : ''}.${d.trm.desactualizada ? ' Ojo: puede estar desactualizada.' : ''}`);
  if (d.mercado) lineas.push(`- Dólar de mercado: ${L.tasa(d.mercado.valor)}${d.mercado.actualizado ? ` (actualizado ${L.horaDe(d.mercado.actualizado)})` : ''}`);
  if (!lineas.length) lineas.push(`No tengo una TRM registrada todavía${d.estado && d.estado.red_desactivada ? ' (las consultas de internet están desactivadas en el servidor)' : ' (no hubo conexión con la fuente oficial)'}. Puedes registrarla a mano en Contabilidad › TRM.`);
  return { texto: lineas.join('\n'), acciones: [ir('#/contabilidad/trm', 'Ver TRM y dólar')], sugerencias: ['¿Cuál fue la TRM de la última compra?'] };
};

R.domicilios = (ctx) => {
  const u = ctx.usuario;
  if (!tiene(u, 'domicilios.ver')) return sinPermiso('consultar los domicilios');
  const r = require('../domicilios').resumen(ctx.db);
  const lineas = ['Domicilios de hoy:'];
  lineas.push(`- Por despachar: **${L.num(r.por_despachar)}** · en camino: **${L.num(r.en_camino)}**`);
  lineas.push(`- Entregados: ${L.num(r.hoy.entregados)}${r.hoy.entregados ? ` por ${L.cop(r.hoy.total)} (envíos ${L.cop(r.hoy.envios)})` : ''}${r.hoy.minutos_promedio ? ` · tiempo promedio ${L.num(r.hoy.minutos_promedio)} min` : ''}`);
  if (r.atrasados.length) lineas.push(`- Atrasados: **${L.num(r.atrasados.length)}** (${r.atrasados.slice(0, 3).map((d) => `${d.numero} · ${d.cliente_nombre}, ${L.num(d.minutos)} min`).join('; ')})`);
  const enRuta = r.repartidores.filter((x) => x.en_camino > 0);
  if (enRuta.length) lineas.push(`- En la calle: ${enRuta.map((x) => `${x.nombre} (${L.num(x.en_camino)})`).join(', ')}`);
  lineas.push(`- Este mes: ${L.num(r.mes.entregados)} entregados por ${L.cop(r.mes.total)}`);
  return { texto: lineas.join('\n'), acciones: [ir('#/domicilios', 'Ver domicilios')], sugerencias: ['¿Cómo tomo un domicilio?', '¿Qué tengo pendiente?'] };
};

R.comisiones = async (ctx) => {
  const p = periodoOMes(ctx);
  const global = tiene(ctx.usuario, 'comisiones.ver') || tiene(ctx.usuario, 'comisiones.administrar');
  const propio = !global || /\b(mi|mis|llevo|me gano)\b/.test(ctx.n);
  const r = await herramienta(ctx, 'consultar_rentabilidad', { desde: p.desde, hasta: p.hasta, alcance: propio ? 'propio' : 'todos' });
  if (!r.ok) return sinPermiso('consultar comisiones');
  const d = r.datos;
  if (d.alcance === 'propio') {
    const s = d.resumen || {};
    return { texto: `Tu resultado ${p.etiqueta}:\n- Ventas: ${L.num(s.ventas || 0)} por ${L.cop(s.ingreso_neto)}\n- Ganancia generada: ${L.cop(s.ganancia)}\n- **Comisión estimada: ${L.cop(s.comision)}**${s.pendientes_cobro ? `\n- Ventas con cobro pendiente: ${L.num(s.pendientes_cobro)}` : ''}`, acciones: [ir('#/comisiones', 'Ver mis comisiones')], sugerencias: [] };
  }
  const resp = (d.comisiones && d.comisiones.responsables) || [];
  if (!resp.length) return { texto: `${L.capitalizar(p.etiqueta)} no hay comisiones calculadas.`, acciones: [ir('#/comisiones')], sugerencias: [] };
  const lineas = [`Comisiones ${p.etiqueta}:`];
  for (const x of resp.slice(0, 10)) lineas.push(`- **${x.nombre}**: ${L.num(x.ventas)} ventas · ganancia ${L.cop(x.ganancia)} · comisión **${L.cop(x.comision)}**`);
  return { texto: lineas.join('\n'), acciones: [ir('#/comisiones', 'Ver rentabilidad y comisiones')], sugerencias: [] };
};

R.documentos = (ctx) => {
  if (!tiene(ctx.usuario, 'documentos.ver')) return sinPermiso('ver la bandeja de documentos');
  const filas = ctx.db.prepare("SELECT nombre, remitente, origen, creado_en FROM documentos WHERE estado = 'pendiente' ORDER BY id DESC LIMIT 8").all();
  if (!filas.length) return { texto: 'No hay documentos pendientes por revisar.', acciones: [ir('#/documentos')], sugerencias: [] };
  const n = ctx.db.prepare("SELECT COUNT(*) n FROM documentos WHERE estado = 'pendiente'").get().n;
  const lineas = [`Hay **${L.plural(n, 'documento', 'documentos')}** por revisar:`];
  for (const f of filas) lineas.push(`- ${f.nombre || 'Documento'}${f.remitente ? ` · de ${f.remitente}` : ''}${f.creado_en ? ` · ${L.cuandoFue(f.creado_en)}` : ''}`);
  return { texto: lineas.join('\n'), acciones: [ir('#/documentos', 'Ver documentos')], sugerencias: [] };
};

R.guia = (ctx) => {
  const t = guia.buscarTema(ctx.textoOriginal);
  if (!t) return R.desconocido(ctx);
  const lineas = [`**${t.titulo}**`, ...t.pasos.map((p, i) => `${i + 1}. ${p}`)];
  if (t.consejos && t.consejos.length) lineas.push('', 'Consejos:', ...t.consejos.map((c) => `- ${c}`));
  return { texto: lineas.join('\n'), acciones: [ir(t.ruta)], sugerencias: [] };
};

R.navegar = (ctx) => {
  const d = DESTINOS.find(([rx]) => rx.test(ctx.n));
  if (!d) return { texto: '¿A qué pantalla quieres ir? Por ejemplo: inventario, ventas, caja, créditos, compras o reportes.', acciones: [], sugerencias: ['Llévame a inventario', 'Llévame a la caja'] };
  const etiqueta = herramientas.RUTAS[d[1]] || d[1];
  return { texto: `Listo, te llevo a **${etiqueta}**.`, acciones: [ir(d[1], etiqueta)], sugerencias: [] };
};

R.desconocido = (ctx) => {
  const cerca = ctx.busqueda().cercanos || [];
  const lineas = [`No estoy seguro de haber entendido “${ctx.textoOriginal.slice(0, 80)}”.`];
  if (cerca.length) lineas.push(`¿Preguntas por alguno de estos productos?\n${cerca.map((p) => `- ${p.nombre}`).join('\n')}`);
  lineas.push('Puedo decirte cuántas unidades hay de un producto, cuánto se vendió un día o un mes, qué se está acabando, tus pendientes, la caja, la cartera y cómo hacer cada proceso.');
  return { texto: lineas.join('\n\n'), acciones: [], sugerencias: cerca.length ? cerca.slice(0, 2).map((p) => `¿Cuántos hay de ${p.nombre}?`) : sugerenciasBase(ctx).slice(0, 4), confianza: 0 };
};

function sugerenciasBase(ctx) {
  const u = ctx.usuario;
  const s = ['¿Qué tengo pendiente?'];
  if (tiene(u, 'ventas.ver') || tiene(u, 'comisiones.ver_propias')) s.push('¿Cuánto se vendió hoy?');
  if (tiene(u, 'inventario.ver') || tiene(u, 'ventas.crear')) s.push('¿Qué productos se van a acabar?');
  if (tiene(u, 'caja.ver')) s.push('¿Cómo va la caja?');
  if (tiene(u, 'creditos.ver')) s.push('¿Quién me debe?');
  return s;
}

// ---------- Elección de la intención ----------
function puntuar(n) {
  const p = {};
  for (const [id, reglas] of Object.entries(REGLAS)) {
    let s = 0;
    for (const [rx, w] of reglas) if (rx.test(n)) s = Math.max(s, w);
    if (s) p[id] = s;
  }
  if (p.guia && NO_GUIA.test(n)) delete p.guia;
  if (p.saludo && n.split(' ').length > 4) p.saludo = 0.5;   // "hola, ¿cuánto aguardiente hay?" → no es solo saludo
  if (p.gracias && n.split(' ').length > 4) p.gracias = 0.5;
  return p;
}
const INTENCIONES_CON_PRODUCTO = new Set(['stock_producto', 'precio', 'ventas_producto']);
const SEGUIMIENTO = /^(y|e|ahora|tambien|ademas|pero|y que tal|que tal)\b/;
// Cuándo una pregunta sin producto se refiere a los productos de la respuesta anterior: "¿y ayer?", "¿cuántos se
// vendieron?", "¿de esos cuántos quedan?". "¿Cuánto se vendió hoy?" (dinero, en singular) es una pregunta general.
const REFIERE_ANTERIOR = /^(y|e|tambien|ademas)\b|\b(de esos|de esas|de ese|de esa|esos|esas|ese producto|esa referencia|cuant[oa]s se|cuant[oa]s quedan|cuant[oa]s hay|cuant[oa]s vendi\w*|cuant[oa]s salieron|y de)\b/;

function elegir(ctx, previo) {
  const p = puntuar(ctx.n);
  const b = ctx.busqueda();
  const hayProducto = b.productos.length > 0;
  if (p.navegar && DESTINOS.some(([rx]) => rx.test(ctx.n))) return { id: 'navegar', confianza: 6 };
  if (p.guia && guia.buscarTema(ctx.textoOriginal) && !p.ayuda) return { id: 'guia', confianza: p.guia + 1 };
  // Combinaciones con producto
  if (hayProducto) {
    if (p.ventas_periodo && !p.mas_vendidos && !p.ultimas_ventas) p.ventas_producto = p.ventas_periodo + 1.5;
    if (p.precio) p.precio += 2;
    if (p.stock_producto) p.stock_producto += 2.5;
    else if (!Object.values(p).some((v) => v >= 2) && b.mejor >= 3) p.stock_producto = 3; // "Old Parr 12" a secas
  } else if (p.stock_producto && !p.inventario_bajo && !p.inventario_general) {
    // "¿cuántos … hay?" sin producto reconocido: o pregunta general o un producto que no existe
    const resto = L.tokens(ctx.nSinPeriodo, { extraVacias: VACIAS_INTENCION });
    if (!resto.length) p.inventario_general = 3;
  }
  if (p.cliente || p.creditos) {
    const cl = ctx.clientes();
    if (cl.length && (p.cliente || /\bdebe\b/.test(ctx.n))) p.cliente = Math.max(p.cliente || 0, (p.creditos || 0) + 1);
  }
  if (p.trm && p.compras && /\bcompra/.test(ctx.n)) p.compras += 2; // "TRM de la última compra"
  if (p.inventario_bajo && p.compras && /\b(pedir|comprar|reponer|surtir)\b/.test(ctx.n)) delete p.compras;
  if (p.ganancia && p.ventas_periodo) p.ventas_periodo -= 1;
  const orden = Object.entries(p).filter(([, v]) => v > 0).sort((a, c) => c[1] - a[1]);
  let [id, conf] = orden[0] || [null, 0];
  if ((id === 'stock_producto' || id === 'precio' || id === 'ventas_producto') && !hayProducto) {
    if (id === 'ventas_producto') id = 'ventas_periodo';
    else if (id === 'precio') id = 'stock_producto';
  }
  // Seguimiento corto: "¿y ayer?", "¿y de aguardiente?", "¿y el lunes?"
  if (previo && previo.intencion && (conf < 3 || SEGUIMIENTO.test(ctx.n))) {
    const soloPeriodo = ctx.periodo && !L.tokens(ctx.nSinPeriodo, { extraVacias: VACIAS_INTENCION }).filter((t) => !/^(y|e)$/.test(t)).length;
    if (soloPeriodo && ['ventas_periodo', 'ventas_producto', 'mas_vendidos', 'ganancia', 'gastos', 'compras', 'comisiones'].includes(previo.intencion)) return { id: previo.intencion, confianza: 4, heredado: true };
    if (hayProducto && INTENCIONES_CON_PRODUCTO.has(previo.intencion) && (!id || conf < 3 || SEGUIMIENTO.test(ctx.n))) return { id: previo.intencion, confianza: 4, heredado: true };
  }
  if (!id || conf < 2) {
    if (hayProducto && b.mejor >= 3) return { id: 'stock_producto', confianza: 3 };
    if (ctx.clientes().length) return { id: 'cliente', confianza: 2.5 };
    if (ctx.periodo) return { id: 'ventas_periodo', confianza: 2 };
    return { id: 'desconocido', confianza: 0 };
  }
  if (id === 'stock_producto' && !hayProducto && p.inventario_general) id = 'inventario_general';
  return { id, confianza: conf };
}

// ---------- Punto de entrada ----------
// previo: { intencion, productos, periodo } de la respuesta local anterior en la conversación (para seguimientos).
async function responder(db, usuario, texto, { previo = null, nombreAsistente = 'Tino' } = {}) {
  const textoOriginal = String(texto || '').trim();
  const n = L.normalizar(textoOriginal);
  const periodo = L.interpretarPeriodo(n);
  const nSinPeriodo = L.sinPeriodo(n, periodo);
  let indice = null; let busqueda = null; let clientes = null;
  const ctx = {
    db, usuario, textoOriginal, n, nSinPeriodo, periodo, nombreAsistente,
    negocio: getConfig(db, 'negocio_nombre') || 'Licores Palmira',
    nombre: String(usuario.nombre || '').trim().split(/\s+/)[0],
    indice: () => (indice = indice || indiceProductos(db)),
    busqueda: () => {
      if (busqueda) return busqueda;
      busqueda = buscarProductos(db, nSinPeriodo, { indice: ctx.indice() });
      // Seguimiento sin producto explícito ("¿y la semana pasada?"): se reutilizan los productos anteriores.
      if (!busqueda.productos.length && previo && Array.isArray(previo.productos) && previo.productos.length && INTENCIONES_CON_PRODUCTO.has(previo.intencion)
        && !L.tokens(nSinPeriodo, { extraVacias: VACIAS_INTENCION }).length && REFIERE_ANTERIOR.test(n) && !/\bventas?\b/.test(n)) {
        const ids = new Set(previo.productos);
        const prods = ctx.indice().filter((p) => ids.has(p.id)).map((p) => ({ ...p, puntaje: 3 }));
        if (prods.length) busqueda = { productos: prods, mejor: 3, consulta: previo.consulta || prods[0].nombre };
      }
      return busqueda;
    },
    clientes: () => (clientes = clientes || buscarClientes(db, nSinPeriodo)),
  };
  if (!n) return { texto: 'Escríbeme tu pregunta.', acciones: [], sugerencias: sugerenciasBase(ctx), intencion: 'vacio', confianza: 0 };
  const eleccion = elegir(ctx, previo);
  const fn = R[eleccion.id] || R.desconocido;
  const r = await fn(ctx);
  const b = busqueda;
  return {
    texto: r.texto,
    acciones: (r.acciones || []).filter(Boolean),
    sugerencias: (r.sugerencias || []).filter(Boolean).slice(0, 4),
    intencion: eleccion.id,
    confianza: r.confianza === 0 ? 0 : eleccion.confianza,
    contexto: { intencion: eleccion.id, productos: r.productos ? r.productos.slice(0, 30) : (b && b.productos.length ? b.productos.slice(0, 30).map((p) => p.id) : []), consulta: b ? b.consulta : undefined, periodo: periodo ? { desde: periodo.desde, hasta: periodo.hasta } : null },
  };
}

module.exports = { responder, puntuar, buscarProductos, buscarClientes, indiceProductos, DESTINOS, REGLAS };
