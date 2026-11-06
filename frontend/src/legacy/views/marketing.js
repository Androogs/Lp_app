// Marketing: panel de resultados, embudo, rentabilidad por campaña, campañas (ficha con métricas por día), clientes
// potenciales, integraciones con plataformas y seguimiento web. Consume /api/marketing/* (datos reales; cuando no hay
// datos se muestra "Sin datos", nunca cifras inventadas). Quien solo tiene marketing.leads ve únicamente Clientes potenciales.
import { api } from '../../lib/api';
import { estado, navegar } from '../../lib/estado';
import { $, $$, fmt, icono, esc, badge, toast, modal, confirmar, mostrarError, debounce, activarDinero, leerDinero, vacio, cargando, selectorBusqueda, hoyISO } from '../ui.js';
import { lineas, barras, barrasH, anillo, leyenda } from '../charts.js';
import { PRESETS, filtroInicial, guardarFiltro, paramsFiltro, filtroPeriodo, textoPeriodo, kpi, panel, tablaViz, tituloPunto, NOMBRE_GRAN } from '../paneles.js';

// ---------- Catálogos compartidos (también los usan Vender y Clientes) ----------
export const PLATAFORMAS = { meta: 'Meta (Facebook / Instagram)', google: 'Google Ads', tiktok: 'TikTok Ads', whatsapp: 'WhatsApp', organico: 'Orgánico (sin pauta)', otra: 'Otra' };
export const OBJETIVOS = { ventas: 'Ventas', mensajes: 'Mensajes / contactos', trafico: 'Tráfico a la web', reconocimiento: 'Reconocimiento de marca', otro: 'Otro' };
export const ESTADOS_CAMPANA = { borrador: ['Borrador', 'neutro'], activa: ['Activa', 'ok'], pausada: ['Pausada', 'aviso'], finalizada: ['Finalizada', 'neutro'] };
export const ESTADOS_LEAD = { nuevo: ['Nuevo', 'aviso'], contactado: ['Contactado', 'neutro'], interesado: ['Interesado', 'ok'], convertido: ['Convertido', 'ok'], perdido: ['Perdido', 'peligro'] };
export const TIPOS_ATRIBUCION = { confirmada: ['Confirmada', 'ok'], estimada: ['Estimada', 'aviso'], desconocida: ['Sin atribución', 'neutro'] };
export const CANALES = { whatsapp: 'WhatsApp', web: 'Página web', instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', google: 'Google', referido: 'Referido', presencial: 'En el local', otro: 'Otro' };
export const nombreCanal = (c) => (c ? CANALES[c] || c : '');
export const nombrePlataforma = (p) => PLATAFORMAS[p] || p || '';
export const canalesConfig = () => (estado.config.marketing && Array.isArray(estado.config.marketing.canales) && estado.config.marketing.canales.length ? estado.config.marketing.canales : Object.keys(CANALES));
export const selectCanal = (id, valor = '', { vacio: textoVacio = 'Sin indicar' } = {}) => `<select id="${esc(id)}"><option value="">${esc(textoVacio)}</option>${canalesConfig().map((c) => `<option value="${esc(c)}" ${c === valor ? 'selected' : ''}>${esc(nombreCanal(c))}</option>`).join('')}</select>`;
export const atribucionBadge = (a) => (a ? `${String(badge(TIPOS_ATRIBUCION, a.tipo))}${a.campana_nombre ? ` <a href="#/marketing/campanas/${a.campana_id}" class="small">${esc(a.campana_nombre)}</a>` : ''}${a.canal ? ` <span class="muted xs">· ${esc(nombreCanal(a.canal))}</span>` : ''}` : '');
const puedeVer = () => estado.tieneAlguno('marketing.ver', 'marketing.editar');
const puedeEditar = () => estado.tiene('marketing.editar');
const puedeLeads = () => estado.tieneAlguno('marketing.leads', 'marketing.editar', 'marketing.ver');
const puedeAtenderLeads = () => estado.tieneAlguno('marketing.leads', 'marketing.editar');
const puedeConfigurar = () => estado.tiene('marketing.configurar');
const sinDato = (v, f = fmt.num) => (v === null || v === undefined ? 'Sin dato' : f(v));
const nulo = (v) => v === null || v === undefined;

// Campañas abiertas (activas o pausadas) para los selectores de Vender, Clientes y clientes potenciales. Caché breve.
let cacheCampanas = { t: 0, lista: [] };
export async function campanasAbiertas({ forzar = false } = {}) {
  if (!puedeLeads()) return [];
  if (!forzar && Date.now() - cacheCampanas.t < 60000) return cacheCampanas.lista;
  try { const r = await api.get('/api/marketing/campanas?estado=abiertas&limite=200'); cacheCampanas = { t: Date.now(), lista: r.campanas || [] }; } catch { cacheCampanas = { t: Date.now(), lista: [] }; }
  return cacheCampanas.lista;
}
export const selectCampana = (id, lista, valor = '', { vacio: textoVacio = 'Sin campaña' } = {}) => `<select id="${esc(id)}"><option value="">${esc(textoVacio)}</option>${lista.map((c) => `<option value="${c.id}" ${Number(valor) === c.id ? 'selected' : ''}>${esc(c.nombre)} · ${esc(nombrePlataforma(c.plataforma))}</option>`).join('')}</select>`;

export async function copiar(texto, mensaje = 'Copiado') {
  try { await navigator.clipboard.writeText(texto); toast(mensaje, 'ok'); return true; } catch { /* sin permiso o sin https */ }
  try { const ta = document.createElement('textarea'); ta.value = texto; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast(mensaje, 'ok'); return true; } catch { toast('No se pudo copiar. Selecciona el texto y cópialo a mano.', 'error'); return false; }
}
const telWa = (t) => { const d = String(t || '').replace(/\D/g, ''); return d ? (d.length === 10 ? '57' + d : d) : ''; };

// ---------- Enrutado del módulo ----------
export async function render(root, { partes, query, setTopbar }) {
  const [p1, p2] = partes;
  if (p1 === 'campanas' && p2 === 'nueva') {
    // El formulario es un diálogo sobre la lista: la dirección vuelve a la lista para que "atrás" o recargar no lo reabran.
    history.replaceState(null, '', '#/marketing/campanas');
    if (puedeEditar()) formularioCampana(null, (c) => navegar(`#/marketing/campanas/${c.id}`, true));
    return principal(root, 'campanas', query, setTopbar);
  }
  if (p1 === 'campanas' && p2) return fichaCampana(root, Number(p2), setTopbar);
  if (p1 === 'leads' && p2) { const r = await principal(root, 'leads', query, setTopbar); detalleLead(Number(p2), () => principal(root, 'leads', query, setTopbar)); return r; }
  return principal(root, p1, query, setTopbar);
}

async function principal(root, tabPedida, query, setTopbar) {
  const tabs = [];
  if (puedeVer()) tabs.push(['panel', 'Panel'], ['embudo', 'Embudo'], ['rentabilidad', 'Rentabilidad'], ['campanas', 'Campañas']);
  if (puedeLeads()) tabs.push(['leads', 'Clientes potenciales']);
  if (puedeConfigurar()) tabs.push(['integraciones', 'Integraciones']);
  if (!tabs.length) { setTopbar({ titulo: 'Marketing' }); root.innerHTML = String(vacio('No tienes acceso a este módulo. Pide el permiso al administrador.')); return; }
  let tab = tabs.some(([v]) => v === tabPedida) ? tabPedida : tabs[0][0];
  const acciones = [];
  if (puedeEditar()) acciones.push({ icono: 'plus', titulo: 'Nueva campaña', alHacerClic: () => formularioCampana(null, (c) => navegar(`#/marketing/campanas/${c.id}`)) });
  setTopbar({ titulo: 'Marketing', acciones });
  const f = filtroInicial('marketing', '30d');
  root.innerHTML = `<p class="intro-modulo">Qué trae cada campaña: inversión, visitas, consultas, clientes potenciales y ventas atribuidas. Solo se muestran datos registrados; lo que no se mide aparece como "Sin dato".</p>
    <div class="tabs">${tabs.map(([v, t]) => `<button type="button" class="${tab === v ? 'activo' : ''}" data-tab="${v}">${esc(t)}</button>`).join('')}</div>
    <div id="mk-filtros"></div><div id="mk-cont"></div>`;
  const cont = $('#mk-cont', root);
  const filtros = $('#mk-filtros', root);
  let filtro = null;
  const conPeriodo = (t) => ['panel', 'embudo', 'rentabilidad'].includes(t);
  const pintar = () => {
    $$('[data-tab]', root).forEach((b) => b.classList.toggle('activo', b.dataset.tab === tab));
    if (conPeriodo(tab)) { filtros.hidden = false; if (!filtro) filtro = filtroPeriodo(filtros, f, () => { guardarFiltro('marketing', f); pintar(); }, { presets: [...PRESETS, ['todo', 'Todo']] }); } else filtros.hidden = true;
    const vistas = { panel: vistaPanel, embudo: vistaEmbudo, rentabilidad: vistaRentabilidad, campanas: vistaCampanas, leads: vistaLeads, integraciones: vistaIntegraciones };
    vistas[tab](cont, f, filtro, query).catch((e) => { cont.innerHTML = `<div class="alerta peligro">${esc(e.message)}</div>`; });
  };
  $$('[data-tab]', root).forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; history.replaceState(null, '', `#/marketing/${tab}`); pintar(); }));
  pintar();
}

// ============================================================================================
// Panel
// ============================================================================================
async function vistaPanel(cont, f, filtro) {
  cont.innerHTML = String(cargando(5));
  const d = await api.get('/api/marketing/panel' + api.qs(paramsFiltro(f)));
  if (filtro) filtro.setTexto(textoPeriodo(f, d.periodo));
  const g = d.granularidad; const s = d.series;
  const va = d.ventas_atribuidas; const ing = d.ingresos_atribuidos;
  const inicio = !d.hay_datos ? `<div class="alerta info mb"><b>Aún no hay datos de marketing.</b> Para empezar: crea una campaña y registra su inversión (pestaña Campañas), instala el seguimiento web (Integraciones) o anota los clientes que preguntan por WhatsApp o en el local (Clientes potenciales).</div>` : '';
  cont.innerHTML = `${inicio}
    <div class="kpis">
      ${kpi({ icono: 'dollar', titulo: 'Inversión total', valor: fmt.cop(d.inversion_total), descripcion: `${d.campanas.con_inversion} campaña(s) con gasto en el periodo`, clase: 'acento' })}
      ${kpi({ icono: 'megaphone', titulo: 'Campañas', valor: `${fmt.num(d.campanas.activas)} activas`, descripcion: `${d.campanas.pausadas} pausadas · ${d.campanas.finalizadas} finalizadas · ${d.campanas.total} en total`, href: '#/marketing/campanas' })}
      ${kpi({ icono: 'eye', titulo: 'Impresiones', valor: sinDato(d.impresiones), descripcion: nulo(d.impresiones) ? 'registra métricas en las campañas' : `alcance ${sinDato(d.alcance)}`, clase: nulo(d.impresiones) ? 'sin-dato' : '' })}
      ${kpi({ icono: 'click', titulo: 'Clics en anuncios', valor: sinDato(d.clics), descripcion: nulo(d.clics) ? 'sin métricas de clics' : d.impresiones ? `CTR ${fmt.pct((d.clics * 100) / d.impresiones)}` : 'reportados por las plataformas', clase: nulo(d.clics) ? 'sin-dato' : '' })}
      ${kpi({ icono: 'globe', titulo: 'Visitas a la web', valor: sinDato(d.visitas), descripcion: d.seguimiento_web_activo ? `${fmt.num(d.visitantes)} visitante(s) distinto(s)` : 'instala el seguimiento web', clase: nulo(d.visitas) ? 'sin-dato' : '', href: puedeConfigurar() && !d.seguimiento_web_activo ? '#/marketing/integraciones' : null })}
      ${kpi({ icono: 'message', titulo: 'Consultas', valor: sinDato(d.consultas), descripcion: nulo(d.consultas) ? 'contactos web y conversaciones de la plataforma' : `web ${sinDato(d.consultas_detalle.web)} · plataforma ${sinDato(d.consultas_detalle.plataforma)}`, clase: nulo(d.consultas) ? 'sin-dato' : '' })}
      ${kpi({ icono: 'users', titulo: 'Clientes potenciales', valor: fmt.num(d.leads), descripcion: `${d.leads_convertidos} convertido(s) · ${d.leads_nuevos} sin atender`, href: '#/marketing/leads' })}
      ${kpi({ icono: 'user', titulo: 'Clientes que compraron', valor: fmt.num(d.clientes_compraron), descripcion: 'con compra atribuida a una campaña' })}
      ${kpi({ icono: 'cart', titulo: 'Ventas atribuidas', valor: fmt.num(va.total), descripcion: `${va.confirmadas} confirmada(s) · ${va.estimadas} estimada(s) · ${d.ventas_totales_periodo.pct_atribuidas === null ? 'sin ventas' : fmt.pct(d.ventas_totales_periodo.pct_atribuidas) + ' de las ventas del periodo'}` })}
      ${kpi({ icono: 'trend_up', titulo: 'Ingresos atribuidos', valor: fmt.cop(ing.total), descripcion: `confirmados ${fmt.cop(ing.confirmados)} · estimados ${fmt.cop(ing.estimados)}` })}
      ${kpi({ icono: 'target', titulo: 'Costo por cliente potencial', valor: nulo(d.costo_por_lead) ? 'Sin dato' : fmt.cop(d.costo_por_lead), descripcion: 'inversión ÷ clientes potenciales', clase: nulo(d.costo_por_lead) ? 'sin-dato' : '' })}
      ${kpi({ icono: 'tag', titulo: 'CAC', valor: nulo(d.cac) ? 'Sin dato' : fmt.cop(d.cac), descripcion: 'costo de adquisición: inversión ÷ clientes que compraron', clase: nulo(d.cac) ? 'sin-dato' : '' })}
      ${kpi({ icono: 'zap', titulo: 'ROAS', valor: nulo(d.roas) ? 'Sin dato' : `${d.roas.toLocaleString('es-CO')} ×`, descripcion: 'ingresos atribuidos ÷ inversión (no es utilidad)', clase: nulo(d.roas) ? 'sin-dato' : '', href: '#/marketing/rentabilidad' })}
      ${kpi({ icono: 'funnel', titulo: 'Conversión visitas → clientes', valor: nulo(d.tasa_conversion_visitas_clientes) ? 'Sin dato' : fmt.pct(d.tasa_conversion_visitas_clientes), descripcion: 'clientes que compraron ÷ visitas a la web', clase: nulo(d.tasa_conversion_visitas_clientes) ? 'sin-dato' : '', href: '#/marketing/embudo' })}
    </div>
    <div class="grid-viz mt-l">
      ${panel({ id: 'mk-serie', titulo: 'Inversión frente a ingresos atribuidos', sub: `Por ${NOMBRE_GRAN[g]} · ${textoPeriodo(f, d.periodo)}`, clase: 'span-4', pie: leyenda([{ nombre: 'Inversión', color: 'var(--viz-3)' }, { nombre: 'Ingresos atribuidos', color: 'var(--viz-1)' }]) + tablaViz([{ titulo: 'Periodo', clave: 'etiqueta' }, { titulo: 'Inversión', clave: 'inversion', dinero: true }, { titulo: 'Ingresos', clave: 'ingresos', dinero: true }, { titulo: 'Leads', clave: 'leads', num: true }, { titulo: 'Ventas', clave: 'ventas', num: true }, { titulo: 'Visitas', clave: 'visitas', num: true }], s) })}
      ${panel({ id: 'mk-canal', titulo: 'Clientes potenciales por canal', sub: 'Por dónde llegan las consultas', clase: 'span-2', pie: d.por_canal.length ? `Ventas atribuidas por canal: ${d.por_canal.filter((c) => c.ventas).map((c) => `<b>${esc(nombreCanal(c.canal))}</b> ${c.ventas} (${fmt.cop(c.ingresos)})`).join(' · ') || 'ninguna todavía'}` : 'Registra el canal al crear clientes potenciales y al vender.' })}
      ${panel({ id: 'mk-camp', titulo: 'Clientes potenciales y ventas por campaña', sub: 'Conteos del periodo', clase: 'span-3', pie: leyenda([{ nombre: 'Clientes potenciales', color: 'var(--viz-3)' }, { nombre: 'Ventas atribuidas', color: 'var(--viz-1)' }]) })}
      ${panel({ id: 'mk-prod', titulo: 'Productos con más interés', sub: 'Consultas en la web y clientes potenciales que preguntaron por ellos', clase: 'span-3' })}
      <section class="panel span-6"><div class="panel-cab"><div><h2>Resultados por campaña</h2><div class="panel-sub">Inversión, clientes potenciales, ventas atribuidas e indicadores del periodo</div></div><div class="panel-acciones"><a class="btn chico suave" href="#/marketing/campanas">Ver campañas</a></div></div>
        ${d.por_campana.length ? `<div class="tabla-wrap"><table class="tabla compacta"><thead><tr><th>Campaña</th><th class="n">Inversión</th><th class="n">Impresiones</th><th class="n">Clics</th><th class="n">Leads</th><th class="n">Ventas</th><th class="n">Ingresos</th><th class="n">ROAS</th><th class="n">CAC</th><th class="n">Costo/lead</th></tr></thead><tbody>
          ${d.por_campana.map((c) => `<tr><td class="celda-resp"><a href="#/marketing/campanas/${c.id}" class="bold">${esc(c.nombre)}</a><div class="xs muted">${esc(nombrePlataforma(c.plataforma))} · ${esc((ESTADOS_CAMPANA[c.estado] || [c.estado])[0])}</div></td><td class="n">${fmt.cop(c.inversion)}</td><td class="n">${sinDato(c.impresiones)}</td><td class="n">${sinDato(c.clics)}</td><td class="n">${c.leads}</td><td class="n">${c.ventas}${c.ventas ? `<div class="xs muted">${c.ventas_confirmadas} conf. · ${c.ventas_estimadas} est.</div>` : ''}</td><td class="n">${fmt.cop(c.ingresos)}</td><td class="n">${nulo(c.roas) ? '—' : c.roas.toLocaleString('es-CO') + ' ×'}</td><td class="n">${nulo(c.cac) ? '—' : fmt.cop(c.cac)}</td><td class="n">${nulo(c.costo_por_lead) ? '—' : fmt.cop(c.costo_por_lead)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted small">Sin campañas con actividad en el periodo.</p>'}
      </section>
    </div>`;
  lineas($('#mk-serie', cont), { etiquetas: s.map((p) => p.etiqueta), series: [{ nombre: 'Inversión', valores: s.map((p) => p.inversion), color: 'var(--viz-3)' }, { nombre: 'Ingresos atribuidos', valores: s.map((p) => p.ingresos), color: 'var(--viz-1)' }], tituloTip: (i) => tituloPunto(s[i], g), aria: 'Inversión frente a ingresos' });
  anillo($('#mk-canal', cont), { items: d.por_canal.map((c) => ({ etiqueta: nombreCanal(c.canal), valor: c.leads })), formato: fmt.num, centro: { valor: fmt.num(d.leads), etiqueta: 'clientes potenciales' }, vacio: 'Sin clientes potenciales en el periodo' });
  const pc = d.por_campana.filter((c) => c.leads || c.ventas).slice(0, 8);
  barras($('#mk-camp', cont), { etiquetas: pc.map((c) => c.nombre.length > 14 ? c.nombre.slice(0, 13) + '…' : c.nombre), series: [{ nombre: 'Clientes potenciales', valores: pc.map((c) => c.leads), color: 'var(--viz-3)' }, { nombre: 'Ventas atribuidas', valores: pc.map((c) => c.ventas), color: 'var(--viz-1)' }], formato: fmt.num, tituloTip: (i) => pc[i].nombre, aria: 'Clientes potenciales y ventas por campaña' });
  barrasH($('#mk-prod', cont), { items: d.productos_interes.map((p) => ({ etiqueta: p.nombre, valor: p.interacciones, nombreValor: 'Interacciones', sub: `${p.eventos} consulta(s) web · ${p.leads} cliente(s) potencial(es)`, href: p.producto_id ? `#/inventario/${p.producto_id}` : null })), formato: fmt.num, vacio: 'Sin consultas de productos en el periodo' });
}

// ============================================================================================
// Embudo
// ============================================================================================
async function vistaEmbudo(cont, f, filtro) {
  cont.innerHTML = String(cargando(4));
  const d = await api.get('/api/marketing/embudo' + api.qs(paramsFiltro(f)));
  if (filtro) filtro.setTexto(textoPeriodo(f, d.periodo));
  const max = Math.max(1, ...d.etapas.filter((e) => !e.sin_dato).map((e) => e.valor));
  cont.innerHTML = `<section class="panel"><div class="panel-cab"><div><h2>Del anuncio a la compra</h2><div class="panel-sub">Cuánta gente avanza en cada paso · ${esc(textoPeriodo(f, d.periodo))}</div></div></div>
      <div class="embudo">${d.etapas.map((e, i) => `<div class="embudo-etapa ${e.sin_dato ? 'sin' : ''}"><div><span class="embudo-nombre">${i + 1}. ${esc(e.nombre)}</span><span class="embudo-fuente">${esc(e.fuente)}</span></div>
        <div class="embudo-barra ${e.sin_dato ? 'sin' : ''}" aria-hidden="true"><i style="width:${e.sin_dato ? 100 : Math.max(1.5, (e.valor / max) * 100)}%"></i></div>
        <div class="embudo-valor">${e.sin_dato ? '<b class="muted">Sin dato</b><span class="paso">fuente no conectada</span>' : `<b>${fmt.num(e.valor)}</b><span class="paso">${e.pct_paso === null ? (i === 0 || e.valor === 0 ? '' : 'sin paso anterior con dato') : `${e.pct_paso.toLocaleString('es-CO')} % del paso anterior`}</span>`}</div></div>`).join('')}</div>
      <div class="panel-pie">${esc(d.nota)} Compras: ${d.ventas.confirmadas} confirmada(s) y ${d.ventas.estimadas} estimada(s).</div></section>
    <div class="grid2 mt">
      <div class="card"><h2>Cómo se alimenta cada paso</h2><ul class="ayuda-lista small"><li>${icono('check', 16)}<span><b>Impresiones y clics</b>: métricas por día de cada campaña (captura manual o sincronización con la plataforma).</span></li><li>${icono('check', 16)}<span><b>Visitas, producto consultado y contacto</b>: script de seguimiento web instalado en la página (los enlaces de los anuncios deben llevar los UTM de la campaña).</span></li><li>${icono('check', 16)}<span><b>Clientes potenciales</b>: formularios de la web y los que registra el equipo (WhatsApp, redes, en el local).</span></li><li>${icono('check', 16)}<span><b>Compras</b>: ventas atribuidas a una campaña por la campaña elegida al vender, el cliente potencial o el origen del cliente.</span></li></ul></div>
      <div class="card"><h2>Qué mirar</h2><p class="small muted">Si muchas personas llegan a "contacto" pero pocas a "cliente potencial", el equipo no está registrando las consultas. Si hay clics pero no visitas, la página no tiene el script o el enlace del anuncio no lleva los UTM. Si hay clientes potenciales y pocas compras, revisa el seguimiento comercial (estado de cada cliente potencial).</p>${puedeConfigurar() ? '<a class="btn chico suave mt" href="#/marketing/integraciones">Configurar seguimiento web</a>' : ''}</div>
    </div>`;
}

// ============================================================================================
// Rentabilidad
// ============================================================================================
async function vistaRentabilidad(cont, f, filtro) {
  cont.innerHTML = String(cargando(4));
  const d = await api.get('/api/marketing/rentabilidad' + api.qs(paramsFiltro(f)));
  if (filtro) filtro.setTexto(textoPeriodo(f, d.periodo));
  const t = d.totales;
  const num = (v, fn = fmt.cop) => (nulo(v) ? '—' : fn(v));
  const roasTxt = (v) => (nulo(v) ? '—' : `${v.toLocaleString('es-CO')} ×`);
  cont.innerHTML = `<div class="kpis">
      ${kpi({ icono: 'dollar', titulo: 'Inversión', valor: fmt.cop(t.inversion), descripcion: `${d.campanas.length} campaña(s) con actividad`, clase: 'acento' })}
      ${kpi({ icono: 'cart', titulo: 'Ingresos atribuidos', valor: fmt.cop(t.ingresos), descripcion: `${t.ventas} venta(s) · confirmados ${fmt.cop(t.ingresos_confirmados)} · estimados ${fmt.cop(t.ingresos_estimados)}` })}
      ${kpi({ icono: 'box', titulo: 'Costo de los productos', valor: fmt.cop(t.costo_productos), descripcion: 'costo real por lote de lo vendido' })}
      ${kpi({ icono: 'trend_up', titulo: 'Margen de contribución', valor: fmt.cop(t.margen_contribucion), descripcion: `ingresos − costo de productos − costos variables (${fmt.cop(t.costos_variables)})` })}
      ${kpi({ icono: 'zap', titulo: 'ROAS', valor: roasTxt(t.roas), descripcion: 'ingresos ÷ inversión' })}
      ${kpi({ icono: 'check', titulo: 'Utilidad estimada', valor: fmt.cop(t.utilidad_estimada), descripcion: 'margen de contribución − inversión', alerta: t.utilidad_estimada < 0 })}
    </div>
    <div class="alerta aviso small mt"><b>Un ROAS positivo no significa que la campaña sea rentable.</b> ${esc(d.nota)}</div>
    <section class="panel mt"><div class="panel-cab"><div><h2>Rentabilidad por campaña</h2><div class="panel-sub">${esc(textoPeriodo(f, d.periodo))} · ordenadas por utilidad estimada</div></div></div>
      ${d.campanas.length ? `<div class="tabla-wrap"><table class="tabla compacta"><thead><tr><th>Campaña</th><th class="n">Inversión</th><th class="n">Ventas</th><th class="n">Ingresos</th><th class="n">Costo productos</th><th class="n">Costos variables</th><th class="n">Margen</th><th class="n">ROAS</th><th class="n">CAC</th><th class="n">Utilidad estimada</th></tr></thead><tbody>
        ${d.campanas.map((c) => `<tr><td class="celda-resp"><a href="#/marketing/campanas/${c.id}" class="bold">${esc(c.nombre)}</a><div class="xs muted">${esc(nombrePlataforma(c.plataforma))}${c.rentable === null ? '' : c.rentable ? ' · <span class="pos">rentable</span>' : ' · <span class="neg">no rentable</span>'}</div></td><td class="n">${fmt.cop(c.inversion)}</td><td class="n">${c.ventas}<div class="xs muted">${c.ventas_confirmadas} conf. · ${c.ventas_estimadas} est.</div></td><td class="n">${fmt.cop(c.ingresos)}</td><td class="n">${fmt.cop(c.costo_productos)}</td><td class="n">${fmt.cop(c.costos_variables)}</td><td class="n ${c.margen_contribucion < 0 ? 'neg' : ''}">${fmt.cop(c.margen_contribucion)}${nulo(c.margen_pct) ? '' : `<div class="xs muted">${fmt.pct(c.margen_pct)}</div>`}</td><td class="n">${roasTxt(c.roas)}</td><td class="n">${num(c.cac)}</td><td class="n bold ${c.utilidad_estimada < 0 ? 'neg' : 'pos'}">${fmt.cop(c.utilidad_estimada)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td>Total</td><td class="n">${fmt.cop(t.inversion)}</td><td class="n">${t.ventas}</td><td class="n">${fmt.cop(t.ingresos)}</td><td class="n">${fmt.cop(t.costo_productos)}</td><td class="n">${fmt.cop(t.costos_variables)}</td><td class="n">${fmt.cop(t.margen_contribucion)}</td><td class="n">${roasTxt(t.roas)}</td><td class="n">${num(t.cac)}</td><td class="n ${t.utilidad_estimada < 0 ? 'neg' : 'pos'}">${fmt.cop(t.utilidad_estimada)}</td></tr></tfoot></table></div>` : String(vacio('Sin campañas con inversión o ventas atribuidas en el periodo'))}
    </section>
    <details class="mas mt"><summary>Cómo se calcula</summary><p class="small muted">Inversión = suma del gasto por día de la campaña (si un día tiene dato sincronizado de la plataforma se usa ese; si no, el manual) o el gasto manual total cuando no hay días registrados. Ingresos = total de las ventas atribuidas menos devoluciones. Costo de productos = costo real de los lotes vendidos. Costos variables = gastos de venta, comisión e impuestos anotados en cada venta. Margen de contribución = ingresos − costo de productos − costos variables. Utilidad estimada = margen − inversión. CAC = inversión ÷ clientes distintos que compraron. Las ventas anuladas no cuentan.</p></details>`;
}

// ============================================================================================
// Campañas
// ============================================================================================
async function vistaCampanas(cont, f, filtro, query = {}) {
  const fl = { estado: query.estado || 'todas', plataforma: '', q: '' };
  cont.innerHTML = `<div class="mk-toolbar"><div class="buscador">${icono('search')}<input type="search" id="mc-q" placeholder="Nombre, utm o id externo" autocomplete="off"></div>
      <select id="mc-estado" aria-label="Estado"><option value="todas">Todas</option><option value="abiertas">Activas y pausadas</option>${Object.entries(ESTADOS_CAMPANA).map(([v, [t]]) => `<option value="${v}">${t}</option>`).join('')}</select>
      <select id="mc-plat" aria-label="Plataforma"><option value="">Todas las plataformas</option>${Object.entries(PLATAFORMAS).map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('')}</select>
      ${puedeEditar() ? `<button type="button" class="btn primario chico" id="mc-nueva">${icono('plus', 16)} Nueva campaña</button>` : ''}
      <a class="btn chico suave" href="/api/marketing/campanas?formato=csv" title="Descargar en Excel">${icono('download', 16)} Excel</a></div>
    <div id="mc-resumen" class="muted small mb"></div><div id="mc-lista" class="lista"></div>`;
  $('#mc-estado', cont).value = fl.estado;
  const cargar = async () => {
    $('#mc-lista', cont).innerHTML = String(cargando(3));
    try {
      const r = await api.get('/api/marketing/campanas' + api.qs({ estado: fl.estado, plataforma: fl.plataforma, q: fl.q }));
      $('#mc-resumen', cont).textContent = `${r.total} campaña(s) · inversión total ${fmt.cop(r.campanas.reduce((s, c) => s + (c.inversion || 0), 0))} · ingresos atribuidos ${fmt.cop(r.campanas.reduce((s, c) => s + (c.ingresos || 0), 0))} (todo el historial)`;
      $('#mc-lista', cont).innerHTML = r.campanas.length ? r.campanas.map((c) => `<a class="item" href="#/marketing/campanas/${c.id}"><div class="thumb">${icono('megaphone', 20)}</div><div class="cuerpo"><div class="titulo">${esc(c.nombre)} ${String(badge(ESTADOS_CAMPANA, c.estado))}</div><div class="sub">${esc(nombrePlataforma(c.plataforma))}${c.objetivo ? ' · ' + esc(OBJETIVOS[c.objetivo] || c.objetivo) : ''}${c.fecha_inicio ? ' · ' + fmt.fecha(c.fecha_inicio) + (c.fecha_fin ? ' – ' + fmt.fecha(c.fecha_fin) : '') : ''} · ${c.leads || 0} lead(s) · ${c.ventas || 0} venta(s)${c.id_externo ? ' · sincronizada' : ''}</div></div><div class="fin"><div class="valor">${fmt.cop(c.inversion || 0)}</div><div class="xs muted">${c.ingresos ? 'ingresos ' + fmt.cop(c.ingresos) : 'sin ventas atribuidas'}${nulo(c.roas) ? '' : ' · ROAS ' + c.roas.toLocaleString('es-CO') + ' ×'}</div></div></a>`).join('') : String(vacio('No hay campañas con este filtro', puedeEditar() ? '<button type="button" class="btn primario mt" id="mc-nueva2">Crear la primera campaña</button>' : ''));
      const b2 = $('#mc-nueva2', cont); if (b2) b2.addEventListener('click', () => formularioCampana(null, (c) => navegar(`#/marketing/campanas/${c.id}`)));
    } catch (e) { mostrarError(e); }
  };
  $('#mc-q', cont).addEventListener('input', debounce((e) => { fl.q = e.target.value.trim(); cargar(); }));
  $('#mc-estado', cont).addEventListener('change', (e) => { fl.estado = e.target.value; cargar(); });
  $('#mc-plat', cont).addEventListener('change', (e) => { fl.plataforma = e.target.value; cargar(); });
  const bn = $('#mc-nueva', cont); if (bn) bn.addEventListener('click', () => formularioCampana(null, (c) => navegar(`#/marketing/campanas/${c.id}`)));
  await cargar();
}

// Formulario de campaña (crear o editar). Los productos promocionados se editan aparte en la ficha.
export function formularioCampana(c, alGuardar) {
  const v = (k, d = '') => esc(c && c[k] != null ? c[k] : d);
  modal({
    titulo: c ? `Editar · ${c.nombre}` : 'Nueva campaña', ancho: true,
    cuerpo: `<div class="campo"><label>Nombre *</label><input id="fc-nombre" value="${v('nombre')}" placeholder="Ej. Promo Old Parr · temporada navideña"></div>
      <div class="grid3">
        <div class="campo"><label>Plataforma</label><select id="fc-plat">${Object.entries(PLATAFORMAS).map(([k, t]) => `<option value="${k}" ${(c ? c.plataforma : 'meta') === k ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
        <div class="campo"><label>Objetivo</label><select id="fc-obj"><option value="">Sin indicar</option>${Object.entries(OBJETIVOS).map(([k, t]) => `<option value="${k}" ${c && c.objetivo === k ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
        <div class="campo"><label>Estado</label><select id="fc-estado">${Object.entries(ESTADOS_CAMPANA).map(([k, [t]]) => `<option value="${k}" ${(c ? c.estado : 'activa') === k ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="campo"><label>Inicio</label><input id="fc-ini" type="date" value="${v('fecha_inicio')}"></div>
        <div class="campo"><label>Fin</label><input id="fc-fin" type="date" value="${v('fecha_fin')}"></div>
        <div class="campo"><label>Presupuesto (COP)</label><input id="fc-pres" data-money value="${c ? c.presupuesto || '' : ''}"></div>
        <div class="campo"><label>Gasto total (COP)</label><input id="fc-gasto" data-money value="${c ? c.gasto_manual || '' : ''}"><div class="ayuda">Solo si no vas a registrar el gasto por día.</div></div>
        <div class="campo" style="grid-column:span 2"><label>Enlace de destino</label><input id="fc-enlace" type="url" value="${v('enlace_destino')}" placeholder="https://tu-pagina.com/producto"></div>
      </div>
      <details class="mas"><summary>Parámetros UTM e id externo</summary><div class="grid3"><div class="campo"><label>utm_source</label><input id="fc-src" value="${v('utm_source')}" placeholder="meta, google, whatsapp…"></div><div class="campo"><label>utm_medium</label><input id="fc-med" value="${v('utm_medium')}" placeholder="cpc, social…"></div><div class="campo"><label>utm_campaign</label><input id="fc-utm" value="${v('utm_campaign')}" placeholder="se genera del nombre"></div><div class="campo" style="grid-column:span 3"><label>Id en la plataforma (Meta, Google, TikTok)</label><input id="fc-ext" value="${v('id_externo')}"></div></div><p class="xs muted">Los enlaces de tus anuncios deben llevar estos parámetros para que las visitas y los clientes potenciales se asocien a la campaña. La ficha genera el enlace listo para copiar.</p></details>
      <div class="campo mt"><label>Observaciones</label><textarea id="fc-obs" placeholder="Público, piezas, promesa del anuncio…">${v('observaciones')}</textarea></div>`,
    acciones: [{ texto: c ? 'Guardar' : 'Crear campaña', clase: 'primario', alHacerClic: async ({ modal: m }) => {
      const g = (id) => $(id, m);
      const datos = { nombre: g('#fc-nombre').value, plataforma: g('#fc-plat').value, objetivo: g('#fc-obj').value || null, estado: g('#fc-estado').value, fecha_inicio: g('#fc-ini').value || null, fecha_fin: g('#fc-fin').value || null, presupuesto: leerDinero(g('#fc-pres')), gasto_manual: leerDinero(g('#fc-gasto')), enlace_destino: g('#fc-enlace').value.trim() || null, utm_source: g('#fc-src').value.trim() || null, utm_medium: g('#fc-med').value.trim() || null, utm_campaign: g('#fc-utm').value.trim() || (c ? c.utm_campaign : null), id_externo: g('#fc-ext').value.trim() || null, observaciones: g('#fc-obs').value.trim() || null };
      const r = c ? await api.put(`/api/marketing/campanas/${c.id}`, datos) : await api.post('/api/marketing/campanas', datos);
      cacheCampanas.t = 0;
      toast(c ? 'Campaña actualizada' : 'Campaña creada', 'ok');
      alGuardar(r);
    } }],
    alMontar: (m) => setTimeout(() => $('#fc-nombre', m).focus(), 60),
  });
}

async function fichaCampana(root, id, setTopbar) {
  let c;
  try { c = await api.get(`/api/marketing/campanas/${id}`); } catch (e) { mostrarError(e); return navegar('#/marketing/campanas', true); }
  const acciones = [];
  if (puedeEditar()) acciones.push({ icono: 'edit', titulo: 'Editar campaña', alHacerClic: () => formularioCampana(c, () => fichaCampana(root, id, setTopbar)) });
  setTopbar({ titulo: c.nombre, atras: '#/marketing/campanas', acciones });
  const r = c.resumen_total; const pres = c.presupuesto || 0;
  const pct = pres > 0 ? Math.min(100, Math.round((r.inversion * 100) / pres)) : 0;
  const transiciones = { borrador: [['activa', 'Activar']], activa: [['pausada', 'Pausar'], ['finalizada', 'Finalizar']], pausada: [['activa', 'Reanudar'], ['finalizada', 'Finalizar']], finalizada: [['activa', 'Reabrir']] }[c.estado] || [];
  const regla = (v) => `<span class="muted xs" title="${esc(v.regla_texto || '')}">${esc(v.regla_texto || v.regla || '')}</span>`;
  root.innerHTML = `<div class="card mk-ficha">
      <div class="ficha-cab"><div class="ico">${icono('megaphone')}</div><div class="grow"><div class="row wrap gap">${String(badge(ESTADOS_CAMPANA, c.estado))}<span class="badge neutro">${esc(nombrePlataforma(c.plataforma))}</span>${c.objetivo ? `<span class="badge neutro">${esc(OBJETIVOS[c.objetivo] || c.objetivo)}</span>` : ''}${c.id_externo ? `<span class="badge neutro" title="Id en la plataforma">id ${esc(c.id_externo)}</span>` : ''}</div>
        <div class="muted small mt">${c.fecha_inicio ? `Del ${fmt.fecha(c.fecha_inicio)}${c.fecha_fin ? ' al ' + fmt.fecha(c.fecha_fin) : ' (sin fecha de fin)'}` : 'Sin fechas definidas'} · creada por ${esc(c.usuario_nombre || 'sincronización')}${c.ultima_sincronizacion ? ` · última sincronización ${fmt.fechaHora(c.ultima_sincronizacion.inicio)} (${esc(c.ultima_sincronizacion.estado)})` : ''}</div>
        ${c.observaciones ? `<p class="small mt">${esc(c.observaciones)}</p>` : ''}</div>
        ${puedeEditar() && transiciones.length ? `<div class="row wrap gap">${transiciones.map(([v, t]) => `<button type="button" class="btn chico ${v === 'activa' ? 'primario' : 'suave'}" data-estado="${v}">${t}</button>`).join('')}</div>` : ''}</div>
      ${pres ? `<div class="mt"><div class="row between small"><span class="muted">Presupuesto ${fmt.cop(pres)}</span><span class="num">${fmt.cop(r.inversion)} invertidos (${pct} %)</span></div><div class="presupuesto-barra mt" style="margin-top:4px"><i style="width:${pct}%"></i></div></div>` : ''}
    </div>
    <div class="kpis mt">
      ${kpi({ icono: 'dollar', titulo: 'Inversión', valor: fmt.cop(r.inversion), descripcion: r.con_metricas ? `${r.dias} día(s) con métricas` : (r.gasto_manual_aplicado ? 'gasto total registrado a mano' : 'sin gasto registrado'), clase: 'acento' })}
      ${kpi({ icono: 'eye', titulo: 'Impresiones', valor: sinDato(r.impresiones), descripcion: `alcance ${sinDato(r.alcance)}`, clase: nulo(r.impresiones) ? 'sin-dato' : '' })}
      ${kpi({ icono: 'click', titulo: 'Clics', valor: sinDato(r.clics), descripcion: nulo(r.conversaciones) ? 'conversaciones: sin dato' : `${fmt.num(r.conversaciones)} conversación(es) reportada(s)`, clase: nulo(r.clics) ? 'sin-dato' : '' })}
      ${kpi({ icono: 'users', titulo: 'Clientes potenciales', valor: fmt.num(r.leads), descripcion: `${r.leads_convertidos} convertido(s)${nulo(r.costo_por_lead) ? '' : ' · ' + fmt.cop(r.costo_por_lead) + ' por lead'}` })}
      ${kpi({ icono: 'cart', titulo: 'Ventas atribuidas', valor: fmt.num(r.ventas), descripcion: `${r.ventas_confirmadas} confirmada(s) · ${r.ventas_estimadas} estimada(s) · ${r.clientes} cliente(s)` })}
      ${kpi({ icono: 'trend_up', titulo: 'Ingresos atribuidos', valor: fmt.cop(r.ingresos), descripcion: nulo(r.roas) ? 'ROAS: sin inversión' : `ROAS ${r.roas.toLocaleString('es-CO')} × · CAC ${nulo(r.cac) ? '—' : fmt.cop(r.cac)}` })}
    </div>
    <div class="grid2 mt">
      <div class="card"><h2>Enlaces para los anuncios</h2>
        ${c.enlaces.utm ? `<div class="et-campo">Enlace con UTM</div><div class="copiar-fila mt" style="margin-top:4px"><div class="codigo">${esc(c.enlaces.utm)}</div><button type="button" class="btn icono" data-copiar="${esc(c.enlaces.utm)}" aria-label="Copiar enlace con UTM" title="Copiar">${icono('copy')}</button></div>` : `<p class="small muted">Agrega el enlace de destino en "Editar campaña" para generar el enlace con UTM (${esc(c.utm_campaign || '')}).</p>`}
        <div class="et-campo mt">WhatsApp</div>
        ${c.enlaces.whatsapp ? `<div class="copiar-fila mt" style="margin-top:4px"><div class="codigo">${esc(c.enlaces.whatsapp)}</div><button type="button" class="btn icono" data-copiar="${esc(c.enlaces.whatsapp)}" aria-label="Copiar enlace de WhatsApp" title="Copiar">${icono('copy')}</button></div><p class="xs muted mt">Al abrirlo, el cliente escribe "Hola, vengo de ${esc(c.nombre)}": así el equipo sabe de qué campaña viene y lo registra como cliente potencial.</p>` : '<p class="small muted">Configura el teléfono del negocio (Configuración › Negocio) para generar el enlace de WhatsApp.</p>'}
        <div class="row wrap gap mt small"><span class="badge neutro mono">utm_source=${esc(c.utm_source || '—')}</span><span class="badge neutro mono">utm_medium=${esc(c.utm_medium || '—')}</span><span class="badge neutro mono">utm_campaign=${esc(c.utm_campaign || '—')}</span></div>
      </div>
      <div class="card"><div class="row between"><h2 style="margin:0">Productos promocionados</h2>${puedeEditar() ? `<button type="button" class="btn chico suave" id="fc-prod">${icono('edit', 14)} Editar</button>` : ''}</div>
        ${c.productos.length ? `<div class="chips mt">${c.productos.map((p) => `<a class="chip" href="#/inventario/${p.id}">${esc(p.nombre)} · ${fmt.cop(p.precio_venta)}${p.stock != null ? ` · stock ${p.stock}` : ''}</a>`).join('')}</div>` : '<p class="small muted mt">Sin productos asociados. Sirve para saber qué se anuncia y comparar con lo que preguntan.</p>'}
        ${Object.keys(c.eventos).length ? `<div class="et-campo mt">Actividad web atribuida</div><div class="row wrap gap mt small" style="margin-top:4px">${Object.entries(c.eventos).map(([t, n]) => `<span class="badge neutro">${esc({ visita: 'visitas', producto: 'producto consultado', clic_contacto: 'clics en contacto', formulario: 'formularios', conversacion: 'conversaciones', compra: 'compras' }[t] || t)}: ${n}</span>`).join('')}</div>` : ''}
      </div>
    </div>
    <div class="card mt"><div class="row between wrap"><div><h2 style="margin:0">Métricas por día</h2><div class="muted xs">Inversión, impresiones, alcance, clics y conversaciones. Si un día tiene dato sincronizado de la plataforma, prevalece sobre el manual.</div></div></div>
      ${puedeEditar() ? `<form id="fm-form" class="mt"><div class="metricas-form"><div class="campo"><label>Fecha</label><input name="fecha" type="date" value="${hoyISO()}" max="${hoyISO()}" required></div><div class="campo"><label>Gasto (COP)</label><input name="gasto" data-money></div><div class="campo"><label>Impresiones</label><input name="impresiones" type="number" min="0" inputmode="numeric"></div><div class="campo"><label>Alcance</label><input name="alcance" type="number" min="0" inputmode="numeric"></div><div class="campo"><label>Clics</label><input name="clics" type="number" min="0" inputmode="numeric"></div><div class="campo"><label>Conversaciones</label><input name="conversaciones" type="number" min="0" inputmode="numeric"></div><div class="campo"><label>Resultados</label><input name="resultados" type="number" min="0" inputmode="numeric"></div><div class="campo"><label>&nbsp;</label><button class="btn primario" type="submit">${icono('check', 16)} Guardar día</button></div></div></form>` : ''}
      <div id="fm-tabla" class="mt"></div>
    </div>
    <div class="grid2 mt">
      <div class="card"><div class="row between"><h2 style="margin:0">Clientes potenciales</h2>${puedeAtenderLeads() ? `<button type="button" class="btn chico suave" id="fc-lead">${icono('plus', 14)} Nuevo</button>` : ''}</div>
        ${c.leads.length ? `<div class="lista mt">${c.leads.map((l) => `<a class="item" href="#/marketing/leads/${l.id}"><div class="cuerpo"><div class="titulo">${esc(l.nombre || l.telefono || 'Sin nombre')}</div><div class="sub">${fmt.fechaHora(l.fecha)} · ${esc(nombreCanal(l.canal))}${l.producto_nombre || l.producto_texto ? ' · ' + esc(l.producto_nombre || l.producto_texto) : ''}</div></div><div class="fin">${String(badge(ESTADOS_LEAD, l.estado))}</div></a>`).join('')}</div>` : '<p class="small muted mt">Nadie ha preguntado por esta campaña todavía.</p>'}
        ${r.leads > c.leads.length ? `<a class="small" href="#/marketing/leads?campana_id=${c.id}">Ver los ${r.leads} clientes potenciales</a>` : ''}</div>
      <div class="card"><h2>Ventas atribuidas</h2>
        ${c.ventas.length ? `<div class="lista">${c.ventas.map((v) => `<a class="item" href="#/ventas/${v.id}"><div class="cuerpo"><div class="titulo">${esc(v.numero)} · ${esc(v.cliente || 'Consumidor final')}</div><div class="sub">${fmt.fechaHora(v.fecha)} · ${regla(v)}</div></div><div class="fin"><div class="valor">${fmt.cop(v.ingreso_neto)}</div>${String(badge(TIPOS_ATRIBUCION, v.tipo))}</div></a>`).join('')}</div>` : '<p class="small muted">Ninguna venta atribuida. Al cobrar, elige la campaña en "¿Cómo llegó el cliente?" o convierte los clientes potenciales en clientes.</p>'}</div>
    </div>`;
  $$('[data-copiar]', root).forEach((b) => b.addEventListener('click', () => copiar(b.dataset.copiar, 'Enlace copiado')));
  $$('[data-estado]', root).forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.estado === 'finalizada' && !await confirmar('¿Finalizar la campaña? Dejará de aparecer al vender; sus datos se conservan.', { textoOk: 'Finalizar' })) return;
    try { await api.post(`/api/marketing/campanas/${id}/estado`, { estado: b.dataset.estado }); cacheCampanas.t = 0; toast('Estado actualizado', 'ok'); fichaCampana(root, id, setTopbar); } catch (e) { mostrarError(e); }
  }));
  const bp = $('#fc-prod', root); if (bp) bp.addEventListener('click', () => editarProductos(c, () => fichaCampana(root, id, setTopbar)));
  const bl = $('#fc-lead', root); if (bl) bl.addEventListener('click', () => formularioLead(null, { campana_id: c.id }, () => fichaCampana(root, id, setTopbar)));
  const pintarMetricas = (filas) => {
    const el = $('#fm-tabla', root);
    if (!filas.length) { el.innerHTML = '<p class="small muted">Sin métricas por día. Registra el gasto diario arriba o conecta la plataforma en Integraciones.</p>'; return; }
    el.innerHTML = `<div class="tabla-wrap"><table class="tabla compacta"><thead><tr><th>Fecha</th><th>Origen</th><th class="n">Gasto</th><th class="n">Impresiones</th><th class="n">Alcance</th><th class="n">Clics</th><th class="n">Conversaciones</th><th class="n">Resultados</th>${puedeEditar() ? '<th></th>' : ''}</tr></thead><tbody>
      ${filas.map((m) => `<tr class="${m.prevalece ? '' : 'muted'}" title="${m.prevalece ? '' : 'No se cuenta: ese día prevalece el dato sincronizado'}"><td>${fmt.fecha(m.fecha)}</td><td>${m.origen === 'sincronizacion' ? '<span class="badge ok">Plataforma</span>' : `<span class="badge neutro">Manual</span>${m.usuario_nombre ? `<div class="xs muted">${esc(m.usuario_nombre)}</div>` : ''}`}${m.prevalece ? '' : '<div class="xs">ignorado</div>'}</td><td class="n">${fmt.cop(m.gasto)}</td><td class="n">${sinDato(m.impresiones)}</td><td class="n">${sinDato(m.alcance)}</td><td class="n">${sinDato(m.clics)}</td><td class="n">${sinDato(m.conversaciones)}</td><td class="n">${sinDato(m.resultados)}</td>${puedeEditar() ? `<td class="n">${m.origen === 'manual' ? `<button type="button" class="btn chico fantasma" data-edm="${esc(m.fecha)}" aria-label="Cargar en el formulario">${icono('edit', 14)}</button><button type="button" class="btn chico fantasma" data-delm="${esc(m.fecha)}" aria-label="Borrar métrica manual">${icono('trash', 14)}</button>` : ''}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
    $$('[data-edm]', el).forEach((b) => b.addEventListener('click', () => { const m = filas.find((x) => x.fecha === b.dataset.edm && x.origen === 'manual'); const fo = $('#fm-form', root); if (!m || !fo) return; for (const k of ['fecha', 'impresiones', 'alcance', 'clics', 'conversaciones', 'resultados']) fo.elements[k].value = m[k] ?? ''; fo.elements.gasto.value = m.gasto || ''; activarDinero(fo); fo.elements.gasto.dispatchEvent(new Event('blur')); fo.scrollIntoView({ behavior: 'smooth', block: 'center' }); }));
    $$('[data-delm]', el).forEach((b) => b.addEventListener('click', async () => { if (!await confirmar(`¿Borrar la métrica manual del ${fmt.fecha(b.dataset.delm)}?`, { peligro: true, textoOk: 'Borrar' })) return; try { await api.del(`/api/marketing/campanas/${id}/metricas/${b.dataset.delm}`); toast('Métrica borrada'); fichaCampana(root, id, setTopbar); } catch (e) { mostrarError(e); } }));
  };
  pintarMetricas(c.metricas);
  const fo = $('#fm-form', root);
  if (fo) {
    activarDinero(fo);
    fo.addEventListener('submit', async (e) => {
      e.preventDefault();
      const el = fo.elements; const n = (k) => (el[k].value === '' ? null : Number(el[k].value));
      try {
        const r2 = await api.post(`/api/marketing/campanas/${id}/metricas`, { fecha: el.fecha.value, gasto: leerDinero(el.gasto), impresiones: n('impresiones'), alcance: n('alcance'), clics: n('clics'), conversaciones: n('conversaciones'), resultados: n('resultados') });
        toast('Métricas guardadas', 'ok'); pintarMetricas(r2.metricas);
        fichaCampana(root, id, setTopbar);
      } catch (e2) { mostrarError(e2); }
    });
  }
}

function editarProductos(c, alGuardar) {
  const sel = c.productos.map((p) => ({ id: p.id, nombre: p.nombre, precio_venta: p.precio_venta }));
  const cuerpo = document.createElement('div');
  const pintar = () => {
    cuerpo.innerHTML = `<p class="small muted">Productos que anuncia esta campaña.</p><div id="ep-lista" class="lista mt">${sel.length ? sel.map((p, i) => `<div class="item"><div class="cuerpo"><div class="titulo">${esc(p.nombre)}</div><div class="sub">${fmt.cop(p.precio_venta)}</div></div><button type="button" class="btn icono chico" data-q="${i}" aria-label="Quitar ${esc(p.nombre)}">${icono('x', 16)}</button></div>`).join('') : '<div class="vacio small">Sin productos</div>'}</div><button type="button" class="btn suave bloque mt" id="ep-add">${icono('plus')} Agregar producto</button>`;
    $$('[data-q]', cuerpo).forEach((b) => b.addEventListener('click', () => { sel.splice(Number(b.dataset.q), 1); pintar(); }));
    $('#ep-add', cuerpo).addEventListener('click', () => selectorBusqueda({ titulo: 'Producto', placeholder: 'Nombre, referencia o código', buscar: async (t) => (await api.get('/api/productos' + api.qs({ q: t, limite: 20 }))).productos.map((p) => ({ id: p.id, titulo: p.nombre, sub: `${fmt.cop(p.precio_venta)} · stock ${p.stock}`, datos: p })), alElegir: (it) => { if (!sel.some((p) => p.id === it.id)) sel.push({ id: it.id, nombre: it.titulo, precio_venta: it.datos.precio_venta }); pintar(); } }));
  };
  pintar();
  modal({ titulo: 'Productos promocionados', cuerpo, acciones: [{ texto: 'Guardar', clase: 'primario', alHacerClic: async () => { await api.put(`/api/marketing/campanas/${c.id}/productos`, { productos: sel.map((p) => p.id) }); toast('Productos guardados', 'ok'); alGuardar(); } }] });
}

// ============================================================================================
// Clientes potenciales
// ============================================================================================
async function vistaLeads(cont, f, filtro, query = {}) {
  const fl = { estado: query.estado || 'abiertos', canal: '', campana_id: query.campana_id || '', q: '' };
  const campanas = await campanasAbiertas();
  cont.innerHTML = `<div id="ml-kpis" class="kpis mb"></div>
    <div class="mk-toolbar"><div class="buscador">${icono('search')}<input type="search" id="ml-q" placeholder="Nombre, teléfono, correo o producto" autocomplete="off"></div>
      <select id="ml-estado" aria-label="Estado"><option value="abiertos">Por atender (nuevos, contactados, interesados)</option>${Object.entries(ESTADOS_LEAD).map(([v, [t]]) => `<option value="${v}">${t}</option>`).join('')}<option value="todos">Todos</option></select>
      ${selectCanal('ml-canal', '', { vacio: 'Todos los canales' })}
      ${selectCampana('ml-camp', campanas, fl.campana_id, { vacio: 'Todas las campañas' })}
      ${puedeAtenderLeads() ? `<button type="button" class="btn primario chico" id="ml-nuevo">${icono('plus', 16)} Nuevo</button>` : ''}
      <a class="btn chico suave" href="/api/marketing/leads?formato=csv" title="Descargar en Excel">${icono('download', 16)} Excel</a></div>
    <div id="ml-resumen" class="muted small mb"></div><div id="ml-lista" class="lista"></div>`;
  $('#ml-estado', cont).value = fl.estado;
  api.get('/api/marketing/leads/resumen?periodo=30d').then((r) => {
    $('#ml-kpis', cont).innerHTML = kpi({ icono: 'alert', titulo: 'Sin atender', valor: fmt.num(r.sin_atender_total), descripcion: 'clientes potenciales nuevos (todo el historial)', alerta: r.sin_atender_total > 0, clase: 'acento' }) +
      kpi({ icono: 'users', titulo: 'Últimos 30 días', valor: fmt.num(r.total), descripcion: `${r.por_estado.contactado} contactado(s) · ${r.por_estado.interesado} interesado(s) · ${r.por_estado.perdido} perdido(s)` }) +
      kpi({ icono: 'check', titulo: 'Convertidos en clientes', valor: fmt.num(r.convertidos), descripcion: r.tasa_conversion === null ? 'sin clientes potenciales en 30 días' : `${fmt.pct(r.tasa_conversion)} de conversión en 30 días` }) +
      kpi({ icono: 'message', titulo: 'Canal principal', valor: r.por_canal.length ? nombreCanal(r.por_canal[0].canal) : 'Sin dato', descripcion: r.por_canal.length ? `${r.por_canal[0].n} en 30 días` : 'registra el canal de cada consulta' });
  }).catch(() => {});
  const cargar = async () => {
    $('#ml-lista', cont).innerHTML = String(cargando(3));
    try {
      const r = await api.get('/api/marketing/leads' + api.qs({ estado: fl.estado, canal: fl.canal, campana_id: fl.campana_id, q: fl.q }));
      $('#ml-resumen', cont).textContent = `${r.total} cliente(s) potencial(es) · nuevos ${r.conteo.nuevo || 0} · contactados ${r.conteo.contactado || 0} · interesados ${r.conteo.interesado || 0} · convertidos ${r.conteo.convertido || 0} · perdidos ${r.conteo.perdido || 0}`;
      $('#ml-lista', cont).innerHTML = r.leads.length ? r.leads.map((l) => `<a class="item" href="#" data-lead="${l.id}"><div class="thumb">${icono('user', 20)}</div><div class="cuerpo"><div class="titulo">${esc(l.nombre || l.telefono || l.email || 'Sin nombre')}${l.nombre && l.telefono ? ` <span class="muted small">· ${esc(l.telefono)}</span>` : ''}</div><div class="sub">${fmt.fechaHora(l.fecha)} · ${esc(nombreCanal(l.canal))}${l.campana_nombre ? ' · ' + esc(l.campana_nombre) : ''}${l.producto_nombre || l.producto_texto ? ' · ' + esc(l.producto_nombre || l.producto_texto) : ''}${l.mensaje ? ' · “' + esc(l.mensaje) + '”' : ''}</div></div><div class="fin">${String(badge(ESTADOS_LEAD, l.estado))}${l.cliente_nombre ? `<div class="xs muted">${esc(l.cliente_nombre)}</div>` : ''}</div></a>`).join('') : String(vacio('No hay clientes potenciales con este filtro', puedeAtenderLeads() ? '<button type="button" class="btn primario mt" id="ml-nuevo2">Registrar el primero</button>' : ''));
      $$('[data-lead]', cont).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); detalleLead(Number(a.dataset.lead), cargar); }));
      const b2 = $('#ml-nuevo2', cont); if (b2) b2.addEventListener('click', () => formularioLead(null, {}, cargar));
    } catch (e) { mostrarError(e); }
  };
  $('#ml-q', cont).addEventListener('input', debounce((e) => { fl.q = e.target.value.trim(); cargar(); }));
  $('#ml-estado', cont).addEventListener('change', (e) => { fl.estado = e.target.value; cargar(); });
  $('#ml-canal', cont).addEventListener('change', (e) => { fl.canal = e.target.value; cargar(); });
  $('#ml-camp', cont).addEventListener('change', (e) => { fl.campana_id = e.target.value; cargar(); });
  const bn = $('#ml-nuevo', cont); if (bn) bn.addEventListener('click', () => formularioLead(null, {}, cargar));
  await cargar();
}

export async function formularioLead(l, { campana_id = '' } = {}, alGuardar) {
  const campanas = await campanasAbiertas();
  let producto = l && l.producto_id ? { id: l.producto_id, nombre: l.producto_nombre } : null;
  const v = (k) => esc(l && l[k] != null ? l[k] : '');
  modal({
    titulo: l ? 'Editar cliente potencial' : 'Nuevo cliente potencial',
    cuerpo: `<div class="grid2"><div class="campo"><label>Nombre</label><input id="fl-nombre" value="${v('nombre')}"></div><div class="campo"><label>Teléfono / WhatsApp</label><input id="fl-tel" type="tel" inputmode="tel" value="${v('telefono')}"></div>
      <div class="campo"><label>Correo</label><input id="fl-email" type="email" value="${v('email')}"></div><div class="campo"><label>¿Por dónde llegó?</label>${selectCanal('fl-canal', l ? l.canal : 'whatsapp', { vacio: 'Elegir canal' })}</div>
      <div class="campo"><label>Campaña</label>${selectCampana('fl-camp', campanas, l ? l.campana_id : campana_id)}</div>
      <div class="campo"><label>Producto que le interesa</label><div class="row"><input id="fl-prod" class="grow" value="${producto ? esc(producto.nombre) : v('producto_texto')}" placeholder="Escríbelo o búscalo"><button type="button" class="btn icono" id="fl-buscar" aria-label="Buscar producto">${icono('search')}</button></div></div></div>
      <div class="campo"><label>Qué preguntó</label><textarea id="fl-msj" placeholder="Ej. precio de la caja de Águila, si hay Buchanan’s 18…">${v('mensaje')}</textarea></div>
      <div class="campo"><label>Notas internas</label><textarea id="fl-notas">${v('notas')}</textarea></div>
      <p class="xs muted">Basta con el nombre, el teléfono o el mensaje. El canal y la campaña permiten saber qué publicidad trae clientes.</p>`,
    acciones: [{ texto: l ? 'Guardar' : 'Registrar', clase: 'primario', alHacerClic: async ({ modal: m }) => {
      const g = (id) => $(id, m);
      const textoProd = g('#fl-prod').value.trim();
      const datos = { nombre: g('#fl-nombre').value.trim() || null, telefono: g('#fl-tel').value.trim() || null, email: g('#fl-email').value.trim() || null, canal: g('#fl-canal').value || 'otro', campana_id: g('#fl-camp').value || null, producto_id: producto && textoProd === producto.nombre ? producto.id : null, producto_texto: textoProd || null, mensaje: g('#fl-msj').value.trim() || null, notas: g('#fl-notas').value.trim() || null };
      const r = l ? await api.put(`/api/marketing/leads/${l.id}`, datos) : await api.post('/api/marketing/leads', datos);
      toast(l ? 'Cliente potencial actualizado' : 'Cliente potencial registrado', 'ok');
      if (alGuardar) alGuardar(r);
    } }],
    alMontar: (m) => {
      $('#fl-buscar', m).addEventListener('click', () => selectorBusqueda({ titulo: 'Producto', placeholder: 'Nombre, referencia o código', buscar: async (t) => (await api.get('/api/productos' + api.qs({ q: t, limite: 20 }))).productos.map((p) => ({ id: p.id, titulo: p.nombre, sub: fmt.cop(p.precio_venta) })), alElegir: (it) => { producto = { id: it.id, nombre: it.titulo }; $('#fl-prod', m).value = it.titulo; } }));
      setTimeout(() => $('#fl-nombre', m).focus(), 60);
    },
  });
}

async function detalleLead(id, alCambiar) {
  let l;
  try { l = await api.get(`/api/marketing/leads/${id}`); } catch (e) { return mostrarError(e); }
  const atender = puedeAtenderLeads();
  const wa = telWa(l.telefono);
  const cuerpo = `<div class="row between wrap gap"><div><div class="bold" style="font-size:17px">${esc(l.nombre || 'Sin nombre')}</div><div class="muted small">${[l.telefono, l.email].filter(Boolean).map(esc).join(' · ') || 'Sin datos de contacto'}</div></div>${String(badge(ESTADOS_LEAD, l.estado))}</div>
    <dl class="kv mt"><dt>Registrado</dt><dd>${fmt.fechaHora(l.fecha)}${l.usuario_nombre ? ' · ' + esc(l.usuario_nombre) : ' · desde la web'}</dd><dt>Canal</dt><dd>${esc(nombreCanal(l.canal))}</dd><dt>Campaña</dt><dd>${l.campana_nombre ? `<a href="#/marketing/campanas/${l.campana_id}">${esc(l.campana_nombre)}</a>` : '—'}</dd><dt>Producto</dt><dd>${esc(l.producto_nombre || l.producto_texto || '—')}</dd>${l.utm_campaign ? `<dt>UTM</dt><dd class="mono xs">${esc([l.utm_source, l.utm_medium, l.utm_campaign].filter(Boolean).join(' / '))}</dd>` : ''}${l.cliente_id ? `<dt>Cliente</dt><dd><a href="#/clientes/${l.cliente_id}">${esc(l.cliente_nombre || 'Ver cliente')}</a></dd>` : ''}${l.venta_id ? `<dt>Venta</dt><dd><a href="#/ventas/${l.venta_id}">${esc(l.venta_numero || 'Ver venta')}</a></dd>` : ''}</dl>
    ${l.mensaje ? `<div class="alerta neutra small mt">“${esc(l.mensaje)}”</div>` : ''}
    ${l.notas ? `<div class="et-campo mt">Notas</div><p class="small" style="white-space:pre-wrap">${esc(l.notas)}</p>` : ''}
    ${l.eventos.length ? `<details class="mas mt"><summary>Recorrido en la web (${l.eventos.length})</summary><div class="col small">${l.eventos.map((e) => `<div class="row between"><span>${fmt.fechaHora(e.fecha)} · ${esc({ visita: 'Visita', producto: 'Producto', clic_contacto: 'Clic en contacto', formulario: 'Formulario', conversacion: 'Conversación', compra: 'Compra' }[e.tipo] || e.tipo)}${e.producto_texto ? ' · ' + esc(e.producto_texto) : ''}</span><span class="muted xs truncate" style="max-width:50%">${esc(e.pagina || '')}</span></div>`).join('')}</div></details>` : ''}
    ${atender && l.estado !== 'convertido' ? `<div class="et-campo mt">Cambiar estado</div><div class="lead-estado-btns mt" style="margin-top:4px">${['nuevo', 'contactado', 'interesado', 'perdido'].filter((e) => e !== l.estado).map((e) => `<button type="button" class="btn chico ${e === 'perdido' ? 'peligro' : 'suave'}" data-le="${e}">${ESTADOS_LEAD[e][0]}</button>`).join('')}</div>` : ''}
    <div class="row wrap gap mt">${wa ? `<a class="btn suave chico" href="https://wa.me/${wa}" target="_blank" rel="noopener">${icono('whatsapp', 16)} WhatsApp</a>` : ''}${atender ? `<button type="button" class="btn suave chico" id="dl-editar">${icono('edit', 16)} Editar</button>` : ''}${atender && !l.cliente_id ? `<button type="button" class="btn primario chico" id="dl-conv">${icono('user', 16)} Convertir en cliente</button><button type="button" class="btn suave chico" id="dl-vinc">${icono('link', 16)} Vincular a un cliente</button>` : ''}${l.cliente_id && estado.tiene('ventas.crear') ? `<a class="btn negro chico" href="#/vender">${icono('cart', 16)} Vender</a>` : ''}</div>`;
  const md = modal({ titulo: 'Cliente potencial', cuerpo, ancho: true, acciones: [{ texto: 'Cerrar', clase: 'suave' }] });
  const recargar = () => { md.cerrar(); if (alCambiar) alCambiar(); detalleLead(id, alCambiar); };
  $$('[data-le]', md.el).forEach((b) => b.addEventListener('click', async () => {
    const nota = b.dataset.le === 'perdido' ? await pedirNota('¿Por qué se perdió?') : await pedirNota('Nota (opcional)', false);
    if (nota === null) return;
    try { await api.post(`/api/marketing/leads/${id}/estado`, { estado: b.dataset.le, nota: nota || undefined }); toast('Estado actualizado', 'ok'); recargar(); } catch (e) { mostrarError(e); }
  }));
  const be = $('#dl-editar', md.el); if (be) be.addEventListener('click', () => { md.cerrar(); formularioLead(l, {}, () => { if (alCambiar) alCambiar(); detalleLead(id, alCambiar); }); });
  const bc = $('#dl-conv', md.el); if (bc) bc.addEventListener('click', () => modal({ titulo: 'Convertir en cliente', cuerpo: `<p class="small muted">Se crea el cliente con su origen (${esc(nombreCanal(l.canal))}${l.campana_nombre ? ', campaña ' + esc(l.campana_nombre) : ''}); sus próximas compras quedarán atribuidas.</p><div class="campo mt"><label>Nombre *</label><input id="cv-nombre" value="${esc(l.nombre || '')}"></div><div class="grid2"><div class="campo"><label>Teléfono</label><input id="cv-tel" type="tel" value="${esc(l.telefono || '')}"></div><div class="campo"><label>Identificación</label><input id="cv-id"></div><div class="campo"><label>Correo</label><input id="cv-email" type="email" value="${esc(l.email || '')}"></div><div class="campo"><label>Dirección</label><input id="cv-dir"></div></div>`, acciones: [{ texto: 'Crear cliente', clase: 'primario', alHacerClic: async ({ modal: m }) => { const r = await api.post(`/api/marketing/leads/${id}/convertir`, { nombre: $('#cv-nombre', m).value, telefono: $('#cv-tel', m).value, identificacion: $('#cv-id', m).value, email: $('#cv-email', m).value, direccion: $('#cv-dir', m).value }); toast(`Cliente ${r.cliente.nombre} creado`, 'ok'); md.cerrar(); if (alCambiar) alCambiar(); navegar(`#/clientes/${r.cliente.id}`); } }], alMontar: (m) => setTimeout(() => $('#cv-nombre', m).focus(), 60) }));
  const bv = $('#dl-vinc', md.el); if (bv) bv.addEventListener('click', () => selectorBusqueda({ titulo: 'Vincular a un cliente existente', placeholder: 'Nombre, teléfono o cédula', buscar: async (t) => (await api.get('/api/clientes' + api.qs({ q: t || l.telefono || '' }))).map((c) => ({ id: c.id, titulo: c.nombre, sub: [c.telefono, c.identificacion].filter(Boolean).join(' · ') })), alElegir: async (it) => { try { await api.post(`/api/marketing/leads/${id}/vincular`, { cliente_id: it.id }); toast(`Vinculado a ${it.titulo}`, 'ok'); recargar(); } catch (e) { mostrarError(e); } } }));
}
function pedirNota(titulo, obligatoria = true) {
  return new Promise((resolve) => {
    modal({ titulo, cuerpo: `<div class="campo"><label>${obligatoria ? 'Motivo' : 'Nota'}</label><textarea id="pn-t" placeholder="${obligatoria ? 'Ej. compró en otro lado, muy caro…' : 'Qué se habló, cuándo volver a escribir…'}"></textarea></div>`, acciones: [{ texto: 'Cancelar', clase: 'suave', alHacerClic: () => { resolve(null); } }, { texto: 'Guardar', clase: 'primario', alHacerClic: ({ modal: m }) => { const t = $('#pn-t', m).value.trim(); if (obligatoria && !t) { toast('Escribe el motivo', 'error'); return false; } resolve(t); } }], alMontar: (m) => setTimeout(() => $('#pn-t', m).focus(), 50) });
  });
}

// ============================================================================================
// Integraciones y seguimiento web
// ============================================================================================
async function vistaIntegraciones(cont) {
  cont.innerHTML = String(cargando(4));
  const [integ, seg, ev] = await Promise.all([api.get('/api/marketing/integraciones'), api.get('/api/marketing/seguimiento'), api.get('/api/marketing/eventos?limite=15').catch(() => ({ eventos: [] }))]);
  const estadoSinc = { ok: ['Correcta', 'ok'], error: ['Con error', 'peligro'], sin_credenciales: ['Sin credenciales', 'aviso'], en_curso: ['En curso', 'neutro'] };
  const st = seg.estadisticas;
  cont.innerHTML = `<h2 class="mb">Plataformas publicitarias</h2>
    <p class="muted small mb">${integ.programada ? `Sincronización automática activa: al arrancar y cada ${integ.frecuencia_horas} horas.` : 'Ninguna plataforma tiene credenciales: la inversión y las métricas se registran a mano en cada campaña. Las credenciales se configuran como variables de entorno en el servidor (nunca en la aplicación).'}</p>
    <div class="grid3">${integ.plataformas.map((p) => { const u = p.ultima; const cls = !p.configurado ? 'sin' : u && u.estado === 'error' ? 'error' : u && u.estado === 'ok' ? 'ok' : 'sin'; return `<div class="card integracion ${cls}"><div class="row between"><h2 style="margin:0">${esc(p.nombre)}</h2>${p.configurado ? '<span class="badge ok">Configurada</span>' : '<span class="badge aviso">Sin credenciales</span>'}</div>
        <div class="small muted mt">${u ? `Última sincronización ${fmt.fechaHora(u.inicio)} · ${String(badge(estadoSinc, u.estado))}${u.estado === 'ok' ? `<div>${u.campanas_actualizadas} campaña(s) · ${u.metricas_insertadas} día(s) de métricas${u.detalle && u.detalle.moneda ? ' · cuenta en ' + esc(u.detalle.moneda) : ''}</div>` : ''}${u.detalle && u.detalle.mensaje ? `<div class="xs mt" style="margin-top:4px">${esc(u.detalle.mensaje)}</div>` : ''}${u.detalle && u.detalle.sin_tasa ? `<div class="xs neg">Días sin TRM (no convertidos): ${esc(u.detalle.sin_tasa.join(', '))}</div>` : ''}` : 'Nunca se ha sincronizado.'}${p.campanas_sincronizadas ? `<div class="xs mt" style="margin-top:4px">${p.campanas_sincronizadas} campaña(s) traídas de la plataforma</div>` : ''}${!p.implementado && p.configurado ? '<div class="xs neg">Lectura de campañas pendiente de implementar.</div>' : ''}</div>
        <div class="row wrap gap mt"><button type="button" class="btn chico ${p.configurado ? 'primario' : 'suave'}" data-sinc="${p.clave}" ${p.en_curso ? 'disabled' : ''}>${icono('refresh', 14)} ${p.en_curso ? 'Sincronizando…' : 'Sincronizar ahora'}</button></div>
        <details class="mas mt"><summary>Cómo conectarla</summary><ol class="small" style="padding-left:18px;margin:0">${p.instrucciones.map((i) => `<li>${esc(i)}</li>`).join('')}</ol><div class="row wrap gap mt">${p.variables.map((v) => `<span class="badge neutro mono">${esc(v)}</span>`).join('')}</div></details></div>`; }).join('')}</div>
    ${integ.historial.length ? `<details class="mas mt"><summary>Historial de sincronizaciones (${integ.historial.length})</summary><div class="tabla-wrap"><table class="tabla compacta"><thead><tr><th>Fecha</th><th>Plataforma</th><th>Estado</th><th class="n">Campañas</th><th class="n">Días</th><th>Detalle</th></tr></thead><tbody>${integ.historial.map((h) => `<tr><td>${fmt.fechaHora(h.inicio)}</td><td>${esc(h.plataforma)}</td><td>${String(badge(estadoSinc, h.estado))}</td><td class="n">${h.campanas_actualizadas}</td><td class="n">${h.metricas_insertadas}</td><td style="white-space:normal;max-width:360px" class="xs muted">${esc(h.detalle && h.detalle.mensaje ? h.detalle.mensaje : h.detalle && h.detalle.rango ? `${h.detalle.rango.desde} – ${h.detalle.rango.hasta}` : '')}</td></tr>`).join('')}</tbody></table></div></details>` : ''}
    <h2 class="mb mt-l">Seguimiento de la página web</h2>
    <div class="grid2">
      <div class="card integracion ${seg.activo ? 'ok' : 'sin'}"><div class="row between"><h2 style="margin:0">Estado</h2>${seg.activo ? '<span class="badge ok">Activo</span>' : '<span class="badge aviso">Sin configurar</span>'}</div>
        <p class="small muted mt">${seg.activo ? `${fmt.num(st.eventos_total)} evento(s) recibidos en total · ${fmt.num(st.eventos_7d)} en 7 días de ${fmt.num(st.visitantes_7d)} visitante(s)${st.ultimo_evento ? ' · último ' + fmt.fechaHora(st.ultimo_evento) : ''}.` : 'Genera el token y pega el fragmento en tu página para medir visitas, productos consultados, clics en WhatsApp y formularios.'}</p>
        ${seg.activo ? `<div class="row wrap gap mt small">${Object.entries(st.por_tipo_7d || {}).map(([t, n]) => `<span class="badge neutro">${esc({ visita: 'visitas', producto: 'producto', clic_contacto: 'clics contacto', formulario: 'formularios', conversacion: 'conversaciones' }[t] || t)} (7 d): ${n}</span>`).join('') || '<span class="muted xs">Sin eventos en los últimos 7 días.</span>'}</div>` : ''}
        <div class="row wrap gap mt"><button type="button" class="btn chico ${seg.activo ? 'suave' : 'primario'}" id="sg-token">${icono('key', 14)} ${seg.activo ? 'Rotar token' : 'Generar token'}</button>${seg.activo ? `<button type="button" class="btn chico suave" id="sg-ver">${icono('eye', 14)} Ver token</button>` : ''}</div>
        <div id="sg-tok" class="codigo mt" hidden>${esc(seg.token || '')}</div>
      </div>
      <div class="card"><h2>Instalación</h2>
        ${seg.activo ? `<div class="et-campo">Pega esto antes de &lt;/body&gt; en todas las páginas</div><div class="copiar-fila mt" style="margin-top:4px"><div class="codigo">${esc(seg.fragmento)}</div><button type="button" class="btn icono" data-copiar="${esc(seg.fragmento)}" aria-label="Copiar fragmento" title="Copiar">${icono('copy')}</button></div>
        <details class="mas mt"><summary>Alternativa con el archivo estático</summary><div class="copiar-fila"><div class="codigo">${esc(seg.fragmento_alterno || '')}</div><button type="button" class="btn icono" data-copiar="${esc(seg.fragmento_alterno || '')}" aria-label="Copiar fragmento alterno" title="Copiar">${icono('copy')}</button></div></details>` : '<p class="small muted">El fragmento aparece aquí cuando generes el token.</p>'}
        <details class="mas mt"><summary>Qué puede medir y cómo marcarlo</summary><dl class="ayuda-problemas small mt"><dt>Visita</dt><dd>Automática al cargar cualquier página con el script.</dd><dt>Producto consultado</dt><dd><code>${esc(seg.ejemplos.producto)}</code></dd><dt>Clic en contacto</dt><dd>${esc(seg.ejemplos.contacto)}</dd><dt>Formulario → cliente potencial</dt><dd><code>${esc(seg.ejemplos.formulario)}</code></dd><dt>Enlaces de anuncios</dt><dd>${esc(seg.ejemplos.enlace)}</dd></dl></details>
        <details class="mas mt"><summary>Instrucciones</summary><ol class="small" style="padding-left:18px;margin:0">${seg.instrucciones.map((i) => `<li>${esc(i)}</li>`).join('')}</ol></details>
      </div>
    </div>
    <section class="panel mt"><div class="panel-cab"><div><h2>Últimos eventos recibidos</h2><div class="panel-sub">Lo que la página web ha enviado (sin datos personales salvo los formularios)</div></div></div>
      ${ev.eventos.length ? `<div class="tabla-wrap"><table class="tabla compacta"><thead><tr><th>Fecha</th><th>Tipo</th><th>Campaña / UTM</th><th>Producto</th><th>Página</th></tr></thead><tbody>${ev.eventos.map((e) => `<tr><td>${fmt.fechaHora(e.fecha)}</td><td>${esc({ visita: 'Visita', producto: 'Producto', clic_contacto: 'Clic en contacto', formulario: 'Formulario', conversacion: 'Conversación', compra: 'Compra' }[e.tipo] || e.tipo)}${e.lead_id ? ` <a class="xs" href="#/marketing/leads/${e.lead_id}">lead</a>` : ''}</td><td>${e.campana_nombre ? `<a href="#/marketing/campanas/${e.campana_id}">${esc(e.campana_nombre)}</a>` : `<span class="muted xs">${esc([e.utm_source, e.utm_medium, e.utm_campaign].filter(Boolean).join(' / ') || 'sin UTM')}</span>`}</td><td>${esc(e.producto_nombre || e.producto_texto || '')}</td><td class="xs muted truncate" style="max-width:260px">${esc(e.pagina || '')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted small">Aún no llegan eventos. Comprueba que el fragmento esté instalado y abre tu página.</p>'}
    </section>`;
  $$('[data-copiar]', cont).forEach((b) => b.addEventListener('click', () => copiar(b.dataset.copiar, 'Fragmento copiado')));
  $$('[data-sinc]', cont).forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true; b.innerHTML = `${icono('refresh', 14)} Sincronizando…`;
    try { const r = await api.post(`/api/marketing/sincronizar/${b.dataset.sinc}`, {}); toast(r.estado === 'ok' ? `Sincronización correcta: ${r.campanas_actualizadas} campaña(s), ${r.metricas_insertadas} día(s)` : (r.detalle && r.detalle.mensaje) || 'Sincronización terminada', r.estado === 'ok' ? 'ok' : 'error'); cacheCampanas.t = 0; } catch (e) { mostrarError(e); }
    vistaIntegraciones(cont);
  }));
  $('#sg-token', cont).addEventListener('click', async () => {
    if (seg.activo && !await confirmar('Al rotar el token, el fragmento instalado en la página dejará de enviar eventos hasta que lo actualices. ¿Continuar?', { textoOk: 'Rotar token', peligro: true })) return;
    try { await api.post('/api/marketing/seguimiento/token', {}); toast(seg.activo ? 'Token rotado: actualiza el fragmento en la página' : 'Token generado', 'ok'); vistaIntegraciones(cont); } catch (e) { mostrarError(e); }
  });
  const bv = $('#sg-ver', cont); if (bv) bv.addEventListener('click', () => { const t = $('#sg-tok', cont); t.hidden = !t.hidden; bv.innerHTML = `${icono('eye', 14)} ${t.hidden ? 'Ver token' : 'Ocultar token'}`; });
}
