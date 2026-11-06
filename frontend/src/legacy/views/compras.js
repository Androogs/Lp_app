import { api } from '../../lib/api';
import { estado, navegar } from '../../lib/estado';
import { $, $$, html, raw, render as renderizar, fmt, icono, nombreMetodo, toast, modal, confirmar, pedirTexto, mostrarError, debounce, activarDinero, leerDinero, leerDecimal, vacio, cargando, esc, selectorBusqueda, hoyISO, sumarDias, tabla, badge, ORIGEN_TASA } from '../ui.js';

// Cómo se obtuvo la TRM oficial de referencia guardada en cada compra (aparte de la tasa aplicada). Ver docs/CONTABILIDAD-TRM.md.
export const CAPTURA_TRM = { automatica: ['Automática', 'ok'], manual: ['Manual', 'neutro'], historica: ['Histórica', 'aviso'], no_disponible: ['No disponible', 'peligro'] };
const TEXTO_CAPTURA = {
  automatica: 'Tomada automáticamente de la TRM oficial (Superintendencia Financiera) al registrar la compra.',
  manual: 'La escribió el usuario al registrar la compra porque no había TRM oficial disponible.',
  historica: 'Completada después desde el histórico oficial: la compra se registró antes de que la app guardara la TRM.',
  no_disponible: 'No había TRM oficial disponible cuando se registró la compra y nadie escribió una de referencia.',
};
// Diferencia en pesos por dólar con signo (+ se aplicó una tasa mayor que la TRM, − menor).
const signoTasa = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt.tasa(Math.abs(Number(n) || 0));
// Rango de fechas de un filtro de periodo (mismas reglas que /api/analitica). 'todo' = sin límite de fechas.
function rangoDe(f) {
  const h = hoyISO();
  switch (f.periodo) {
    case 'hoy': return { desde: h, hasta: h };
    case '7d': return { desde: sumarDias(h, -6), hasta: h };
    case '30d': return { desde: sumarDias(h, -29), hasta: h };
    case 'semana': { const dow = (new Date().getDay() + 6) % 7; return { desde: sumarDias(h, -dow), hasta: h }; }
    case 'mes': return { desde: h.slice(0, 8) + '01', hasta: h };
    case 'anio': return { desde: h.slice(0, 5) + '01-01', hasta: h };
    case 'rango': return { desde: f.desde, hasta: f.hasta };
    default: return {};
  }
}

// Campo de tasa de cambio reutilizable: consulta la TRM de la fecha y deja constancia del origen (trm / mercado / manual).
// `etiqueta` permite nombrarlo según el contexto (en compras: "Tasa aplicada", distinta de la TRM oficial de referencia).
export function campoTasa(cont, { fecha = hoyISO(), alCambiar, etiqueta = 'Tasa de cambio (pesos por dólar) *' }) {
  const st = { valor: null, origen: null, nota: '', info: null };
  cont.innerHTML = `<div class="grid2"><div class="campo" style="margin:0"><label>${esc(etiqueta)}</label><input id="ct-tasa" type="number" step="0.01" min="100" inputmode="decimal"></div>
    <div class="campo" style="margin:0"><label>Origen</label><div class="row wrap gap" id="ct-origen"></div></div></div>
    <div id="ct-info" class="xs muted mt"></div>
    <div class="campo mt" id="ct-nota-wrap" hidden><label>Origen o motivo de la tasa manual *</label><input id="ct-nota" placeholder="Ej. tasa pactada con el proveedor, extracto del banco"></div>`;
  const inp = $('#ct-tasa', cont);
  const pintar = () => {
    const i = st.info;
    $('#ct-origen', cont).innerHTML = `${st.origen ? String(badge(ORIGEN_TASA, st.origen)) : ''}<button type="button" class="btn chico suave" data-u="trm" ${i && i.trm ? '' : 'disabled'}>TRM ${i && i.trm ? fmt.tasa(i.trm.valor) : ''}</button><button type="button" class="btn chico suave" data-u="mercado" ${i && i.mercado ? '' : 'disabled'}>Mercado ${i && i.mercado ? fmt.tasa(i.mercado.valor) : ''}</button>`;
    $$('[data-u]', cont).forEach((b) => b.addEventListener('click', () => { const v = b.dataset.u === 'trm' ? st.info.trm.valor : st.info.mercado.valor; st.valor = v; st.origen = b.dataset.u; inp.value = v; pintar(); if (alCambiar) alCambiar(st); }));
    $('#ct-nota-wrap', cont).hidden = st.origen !== 'manual';
    $('#ct-info', cont).textContent = i ? (i.trm ? `TRM oficial vigente para el ${fmt.fecha(i.fecha)}: ${fmt.tasa(i.trm.valor)} (desde ${fmt.fecha(i.trm.fecha)}).` : i.manual ? `Sin TRM para esa fecha; hay una tasa manual registrada (${i.manual.nota || ''}).` : `No hay TRM verificable para el ${fmt.fecha(i.fecha)}${i.error ? ' (' + i.error + ')' : ''}: indica una tasa manual y su origen.`) : 'Consultando la tasa…';
  };
  const consultar = async (f) => {
    st.info = null; pintar();
    try {
      const i = await api.get('/api/trm/tasa' + api.qs({ fecha: f || hoyISO() }));
      st.info = i;
      if (i.sugerida) { st.valor = i.sugerida.valor; st.origen = i.sugerida.origen; inp.value = i.sugerida.valor; } else { st.origen = 'manual'; }
    } catch (e) { st.info = { fecha: f, error: e.message }; st.origen = st.valor ? st.origen : 'manual'; }
    pintar(); if (alCambiar) alCambiar(st);
  };
  inp.addEventListener('input', () => { st.valor = leerDecimal(inp); const sug = st.info && st.info.sugerida; if (!sug || Math.abs(st.valor - sug.valor) > 0.009) { if (!(st.info && st.info.mercado && Math.abs(st.valor - st.info.mercado.valor) < 0.009)) st.origen = 'manual'; } else st.origen = sug.origen; pintar(); if (alCambiar) alCambiar(st); });
  $('#ct-nota', cont).addEventListener('input', (e) => { st.nota = e.target.value; });
  consultar(fecha);
  return { estado: st, consultar, valor: () => leerDecimal(inp), datos: () => ({ tasa_cambio: leerDecimal(inp), tasa_origen: st.origen || 'manual', tasa_nota: st.nota }) };
}
import { escanear } from '../scanner.js';
import { capturar } from '../camera.js';
import { crearProductoRapido } from './inventario.js';
import { filtroInicial, guardarFiltro, filtroPeriodo, panelCompras, PRESETS, seg, activarSeg } from '../paneles.js';

export async function render(root, { seccion, partes, query, setTopbar }) {
  if (seccion === 'documentos') return bandeja(root, setTopbar);
  const [id] = partes;
  if (!id) return lista(root, query, setTopbar);
  if (id === 'nueva') return nueva(root, query, setTopbar);
  return detalle(root, Number(id), setTopbar);
}

// ---------- Lista ----------
async function lista(root, query, setTopbar) {
  const acciones = [];
  if (estado.tiene('documentos.ver')) acciones.push({ icono: 'inbox', titulo: 'Bandeja de documentos', href: '#/documentos' });
  if (estado.tiene('compras.crear')) acciones.push({ icono: 'plus', titulo: 'Nueva compra', href: '#/compras/nueva' });
  setTopbar({ titulo: 'Compras', acciones });
  const f = { con_saldo: !!query.con_saldo, q: '', proveedor_id: '', moneda: '' };
  // El mismo filtro de periodo manda sobre el resumen y sobre el historial. "Por pagar" muestra todo el historial con saldo.
  const fp = filtroInicial('compras', '30d');
  if (f.con_saldo) fp.periodo = 'todo';
  let verResumen = estado.tiene('compras.ver') && sessionStorage.getItem('compras.resumen') !== '0' && !f.con_saldo;
  let verTrm = false;
  try { verTrm = sessionStorage.getItem('compras.trm') === '1'; } catch { /* sin almacenamiento */ }
  const puedeProveedores = estado.tieneAlguno('proveedores.ver', 'compras.crear');
  renderizar(root, html`<div id="c-filtros"></div>
    ${estado.tiene('compras.ver') ? html`<div class="row between mb"><h2 style="margin:0">Resumen de compras</h2><button class="btn chico suave" id="c-toggle">${verResumen ? 'Ocultar resumen' : 'Ver resumen'}</button></div>
    <div id="c-panel" class="mb" ${verResumen ? '' : 'hidden'}></div>` : ''}
    <h2 class="mb">Historial de compras</h2>
    <div class="pills"><button class="pill ${!f.con_saldo ? 'activo' : ''}" data-f="todas">Todas</button><button class="pill ${f.con_saldo ? 'activo' : ''}" data-f="saldo">Con saldo pendiente</button></div>
    <div class="row wrap gap mt">
      ${puedeProveedores ? html`<select id="c-prov" aria-label="Filtrar por proveedor" style="width:auto;max-width:100%"><option value="">Todos los proveedores</option></select>` : ''}
      <span role="group" aria-label="Filtrar por moneda">${raw(seg([['', 'Todas'], ['COP', 'Pesos'], ['USD', 'Dólares']], '', 'mon'))}</span>
      <label class="check small" style="min-height:36px;margin-left:auto"><input type="checkbox" id="c-trm" ${verTrm ? 'checked' : ''}> Mostrar TRM</label>
    </div>
    <div class="buscador mt">${raw(icono('search'))}<input type="search" id="c-q" placeholder="Número, factura o proveedor" aria-label="Buscar compras"></div>
    ${estado.tiene('compras.crear') ? html`<div class="grid2 mt"><a class="btn negro" href="#/compras/nueva">${raw(icono('plus'))} Registrar compra</a><a class="btn suave" href="#/compras/nueva?ocr=1">${raw(icono('camera'))} Escanear factura</a></div>` : ''}
    <div id="c-resumen" class="muted small mt"></div><div id="c-lista" class="lista mt"></div>`);
  // Dato extra por fila cuando está activo "Mostrar TRM": la TRM oficial de referencia del día y, en USD, la tasa aplicada.
  const lineaTrm = (c) => {
    const partes = [];
    if (c.trm_valor !== null && c.trm_valor !== undefined) partes.push(`TRM ${fmt.tasa(c.trm_valor)}${c.trm_fecha ? ` <span class="muted">(${fmt.fecha(c.trm_fecha)})</span>` : ''}${c.trm_captura && c.trm_captura !== 'automatica' ? ' · ' + (CAPTURA_TRM[c.trm_captura] || [c.trm_captura])[0].toLowerCase() : ''}`);
    else partes.push('TRM no disponible al registrar');
    if (c.moneda === 'USD') partes.push(`tasa aplicada ${fmt.tasa(c.tasa_cambio)}`);
    return `<div class="sub num">${partes.join(' · ')}</div>`;
  };
  let ultimo = null;
  const pintarLista = (r) => {
    const rango = rangoDe(fp);
    const confirmadas = r.compras.filter((c) => c.estado === 'confirmada');
    const periodoTxt = !rango.desde ? 'todo el historial' : rango.desde === rango.hasta ? fmt.fecha(rango.desde) : `${fmt.fecha(rango.desde)} – ${fmt.fecha(rango.hasta)}`;
    $('#c-resumen', root).textContent = `${r.total} compra(s) · ${periodoTxt} · ${fmt.cop(confirmadas.reduce((s, c) => s + c.total, 0))}${f.con_saldo ? ' · saldo ' + fmt.cop(r.compras.reduce((s, c) => s + c.saldo_pendiente, 0)) : ''}${r.total > r.compras.length ? ` · se muestran las ${r.compras.length} más recientes` : ''}`;
    const conFiltros = f.q || f.proveedor_id || f.moneda || !!rango.desde;
    $('#c-lista', root).innerHTML = r.compras.length ? r.compras.map((c) => `<a class="item" href="#/compras/${c.id}"><div class="cuerpo"><div class="titulo">${esc(c.proveedor_nombre || 'Sin proveedor')}</div><div class="sub">${esc(c.numero)} · ${fmt.fecha(c.fecha)}${c.numero_factura ? ' · Fact. ' + esc(c.numero_factura) : ''} · ${c.n_items} ítem(s)${c.moneda === 'USD' ? ` · <b>USD</b> ${fmt.usd(c.total_moneda)}` : ''}</div>${verTrm ? lineaTrm(c) : ''}</div><div class="fin"><div class="valor">${fmt.cop(c.total)}</div>${c.estado === 'anulada' ? '<span class="badge peligro">Anulada</span>' : c.saldo_pendiente > 0 ? `<span class="badge aviso">debe ${fmt.cop(c.saldo_pendiente)}</span>` : '<span class="badge ok">Pagada</span>'}</div></a>`).join('') : String(vacio(conFiltros ? 'No hay compras con esos filtros' : 'No hay compras registradas'));
  };
  const cargar = async () => {
    $('#c-lista', root).innerHTML = String(cargando(3));
    try {
      const rango = rangoDe(fp);
      ultimo = await api.get('/api/compras' + api.qs({ con_saldo: f.con_saldo ? 1 : '', q: f.q, proveedor_id: f.proveedor_id, moneda: f.moneda, desde: rango.desde, hasta: rango.hasta, limite: 200 }));
      pintarLista(ultimo);
    } catch (e) { mostrarError(e); }
  };
  const cargarPanel = () => { if (verResumen && estado.tiene('compras.ver')) panelCompras($('#c-panel', root), fp).catch((e) => { if (e.status !== 403) mostrarError(e); }); };
  filtroPeriodo($('#c-filtros', root), fp, () => { guardarFiltro('compras', fp); cargarPanel(); cargar(); }, { presets: [...PRESETS, ['todo', 'Todo']] });
  if (estado.tiene('compras.ver')) {
    $('#c-toggle', root).addEventListener('click', () => { verResumen = !verResumen; sessionStorage.setItem('compras.resumen', verResumen ? '1' : '0'); $('#c-panel', root).hidden = !verResumen; $('#c-toggle', root).textContent = verResumen ? 'Ocultar resumen' : 'Ver resumen'; if (verResumen && !$('#c-panel', root).innerHTML.trim()) cargarPanel(); });
    cargarPanel();
  }
  $$('[data-f]', root).forEach((b) => b.addEventListener('click', () => { f.con_saldo = b.dataset.f === 'saldo'; $$('[data-f]', root).forEach((x) => x.classList.toggle('activo', x === b)); cargar(); }));
  $('#c-q', root).addEventListener('input', debounce((e) => { f.q = e.target.value.trim(); cargar(); }));
  activarSeg(root, 'mon', (v) => { f.moneda = v; cargar(); });
  $('#c-trm', root).addEventListener('change', (e) => { verTrm = e.target.checked; try { sessionStorage.setItem('compras.trm', verTrm ? '1' : '0'); } catch { /* sin almacenamiento */ } if (ultimo) pintarLista(ultimo); });
  const selProv = $('#c-prov', root);
  if (selProv) {
    selProv.addEventListener('change', () => { f.proveedor_id = selProv.value; cargar(); });
    api.get('/api/proveedores').then((ps) => { selProv.innerHTML = '<option value="">Todos los proveedores</option>' + ps.map((p) => `<option value="${p.id}">${esc(p.nombre)}</option>`).join(''); }).catch(() => { selProv.hidden = true; });
  }
  cargar();
}

// ---------- Detalle ----------
async function detalle(root, id, setTopbar) {
  let c;
  try { c = await api.get(`/api/compras/${id}`); } catch (e) { mostrarError(e); return navegar('#/compras', true); }
  setTopbar({ titulo: `Compra ${c.numero}`, atras: '#/compras' });
  const usd = c.moneda === 'USD';
  renderizar(root, html`<div class="card">
      <div class="row between"><div><h2 style="margin:0">${c.proveedor_nombre || 'Sin proveedor'}</h2><div class="muted small">${fmt.fechaHora(c.fecha)}${c.numero_factura ? ' · Factura ' + c.numero_factura : ''}${c.contacto ? ' · ' + c.contacto : ''} · registró ${c.usuario_nombre || ''}</div></div>
        <div class="right">${c.estado === 'anulada' ? html`<span class="badge peligro">Anulada</span>` : c.saldo_pendiente > 0 ? html`<span class="badge aviso">Saldo ${usd ? fmt.usd(c.saldo_pendiente_moneda) : fmt.cop(c.saldo_pendiente)}</span>` : html`<span class="badge ok">Pagada</span>`}${usd ? html`<div class="mt" style="margin-top:4px"><span class="badge negro">USD</span> ${badge(ORIGEN_TASA, c.tasa_origen)}</div>` : ''}</div></div>
      ${c.estado === 'anulada' ? html`<div class="alerta peligro mt">Anulada ${fmt.fechaHora(c.anulada_en)} · ${c.motivo_anulacion}</div>` : ''}
      ${usd ? html`<div class="alerta info mt small">Compra en dólares: <b>${fmt.usd(c.total_moneda)}</b> a tasa aplicada <b>${fmt.tasa(c.tasa_cambio)}</b>${c.tasa_nota ? ' (' + c.tasa_nota + ')' : ''}. Esta tasa queda fija para el costo de los lotes aunque el dólar cambie después; la TRM oficial del día se guarda aparte como referencia (más abajo).</div>` : ''}
      <div class="tabla-wrap mt"><table class="tabla"><thead><tr><th>Producto</th><th class="n">Cant.</th>${usd ? html`<th class="n">Costo USD</th>` : ''}<th class="n">Costo unit. COP</th><th class="n">Desc.</th><th class="n">Costo final</th><th class="n">Total</th></tr></thead><tbody>
        ${c.items.map((it) => html`<tr><td>${it.producto_nombre}${it.seriales.length ? html`<br><span class="mono xs muted">${it.seriales.join(', ')}</span>` : ''}</td><td class="n">${it.cantidad}</td>${usd ? html`<td class="n">${fmt.usd(it.costo_unitario_moneda)}</td>` : ''}<td class="n">${fmt.cop(it.costo_unitario)}</td><td class="n">${it.descuento ? fmt.cop(it.descuento) : ''}</td><td class="n" title="Incluye prorrateo de fletes, impuestos y descuento general">${fmt.cop(it.costo_unitario_final)}</td><td class="n">${fmt.cop(it.total)}</td></tr>`)}</tbody></table></div>
      <dl class="kv mt"><dt>Subtotal</dt><dd>${usd ? html`<span class="muted xs">${fmt.usd(c.subtotal_moneda)} · </span>` : ''}${fmt.cop(c.subtotal)}</dd>${c.descuento ? html`<dt>Descuento</dt><dd>−${fmt.cop(c.descuento)}</dd>` : ''}${c.costos_adicionales ? html`<dt>Transporte / otros (COP)</dt><dd>${fmt.cop(c.costos_adicionales)}</dd>` : ''}${c.impuestos ? html`<dt>Impuestos (COP)</dt><dd>${fmt.cop(c.impuestos)}</dd>` : ''}<dt>Total al costo</dt><dd class="total">${fmt.cop(c.total)}</dd>${usd ? html`<dt>Deuda con el proveedor</dt><dd>${fmt.usd(c.total_moneda)}</dd>` : ''}<dt>Pagado</dt><dd>${usd ? html`${fmt.usd(c.valor_pagado_moneda || 0)} <span class="muted xs">(${fmt.cop(c.valor_pagado)})</span>` : fmt.cop(c.valor_pagado)}</dd><dt>Saldo pendiente</dt><dd class="${c.saldo_pendiente ? 'neg' : ''}">${usd ? html`${fmt.usd(c.saldo_pendiente_moneda || 0)} <span class="muted xs">≈ ${fmt.cop(c.saldo_pendiente)} a la tasa de compra${c.saldo_estimado_hoy ? ` · ${fmt.cop(c.saldo_estimado_hoy.valor)} a TRM de hoy (${fmt.tasa(c.saldo_estimado_hoy.tasa)})` : ''}</span>` : fmt.cop(c.saldo_pendiente)}${c.fecha_vencimiento ? html` <span class="muted xs">vence ${fmt.fecha(c.fecha_vencimiento)}</span>` : ''}</dd></dl>
      ${c.diferencias_cambiarias && c.diferencias_cambiarias.length ? html`<div class="alerta neutra mt small">Diferencia cambiaria realizada en pagos: <b class="${c.diferencias_cambiarias.reduce((s, d) => s + d.diferencia, 0) < 0 ? 'neg' : 'pos'}">${fmt.signo(c.diferencias_cambiarias.reduce((s, d) => s + d.diferencia, 0))}</b> (${c.diferencias_cambiarias.map((d) => `${fmt.usd(d.valor_moneda)} a ${fmt.tasa(d.tasa_pago)}`).join(', ')})</div>` : ''}
      ${usd && c.estado === 'confirmada' && c.puede_vender_unidades && estado.tiene('contabilidad.editar') ? html`<button class="btn chico suave mt" id="c-tasa">${raw(icono('edit', 14))} Corregir tasa de cambio</button>` : ''}
      ${c.notas ? html`<p class="small muted mt">${c.notas}</p>` : ''}
      ${c.documento ? html`<a class="row mt small" href="/api/archivos/${c.documento.ruta}" target="_blank">${raw(icono('file', 18))} Ver factura adjunta</a>` : ''}
    </div>
    ${tarjetaTrm(c)}
    <div class="card"><h2>Pagos al proveedor</h2>${c.pagos.length ? html`<div class="col">${c.pagos.map((p) => html`<div class="row between small ${p.anulado ? 'muted' : ''}"><span>${fmt.fechaHora(p.fecha)} · ${nombreMetodo(p.metodo_pago)}${p.moneda === 'USD' ? ` · ${fmt.usd(p.valor_moneda)} a ${fmt.tasa(p.tasa_cambio)}` : ''}${p.referencia ? ' · ' + p.referencia : ''}${p.anulado ? ' (anulado)' : ''}${p.comprobante_ruta ? raw(` · <a href="/api/archivos/${esc(p.comprobante_ruta)}" target="_blank">comprobante</a>`) : ''}</span><b class="num">${fmt.cop(p.valor)}</b></div>`)}</div>` : html`<p class="muted">Sin pagos.</p>`}
      ${c.estado === 'confirmada' && (usd ? c.saldo_pendiente_moneda > 0 : c.saldo_pendiente > 0) && estado.tiene('compras.pagar') ? html`<button class="btn primario mt" id="c-pagar">${raw(icono('cash'))} Registrar pago</button>` : ''}</div>
    <div class="card"><h2>Lotes creados</h2>${tabla([{ titulo: 'Producto', clave: 'producto_nombre' }, { titulo: 'Serial', valor: (l) => l.serial || '' }, { titulo: 'Inicial', clave: 'cantidad_inicial', num: true }, { titulo: 'Restantes', clave: 'cantidad_restante', num: true }, ...(usd ? [{ titulo: 'Costo USD', valor: (l) => fmt.usd(l.costo_unitario_moneda), num: true }, { titulo: 'Tasa', valor: (l) => fmt.tasa(l.tasa_cambio), num: true }] : []), { titulo: 'Costo COP', clave: 'costo_unitario', dinero: true }, { titulo: 'Estado', clave: 'estado' }], c.lotes)}</div>
    ${c.estado === 'confirmada' && estado.tiene('compras.anular') ? html`<div class="mt-l"><button class="btn peligro" id="c-anular">Anular compra</button><p class="muted xs mt">Solo es posible si no se ha vendido ninguna unidad de esta compra.</p></div>` : ''}`);
  const bp = $('#c-pagar', root);
  if (bp) bp.addEventListener('click', () => pagarCompra(c, () => detalle(root, id, setTopbar)));
  const bt = $('#c-tasa', root);
  if (bt) bt.addEventListener('click', () => modal({ titulo: `Corregir tasa de ${c.numero}`, cuerpo: `<p class="muted small">Tasa actual: <b>${fmt.tasa(c.tasa_cambio)}</b>. Se recalculan los costos en pesos de los lotes y el saldo. Queda registrado en auditoría con tu usuario, el valor anterior, el nuevo y el motivo.</p><div class="campo mt"><label>Tasa correcta (pesos por dólar)</label><input id="ctz-tasa" type="number" step="0.01" min="100" inputmode="decimal" value="${c.tasa_cambio}"></div><div class="campo"><label>Motivo *</label><input id="ctz-motivo"></div>`, acciones: [{ texto: 'Corregir', clase: 'primario', alHacerClic: async ({ modal: m }) => { await api.put(`/api/compras/${id}/tasa`, { tasa_cambio: $('#ctz-tasa', m).value, motivo: $('#ctz-motivo', m).value }); toast('Tasa corregida', 'ok'); detalle(root, id, setTopbar); } }] }));
  const ba = $('#c-anular', root);
  if (ba) ba.addEventListener('click', async () => { const motivo = await pedirTexto('Anular compra', { etiqueta: 'Motivo', textoOk: 'Anular' }); if (!motivo) return; try { await api.post(`/api/compras/${id}/anular`, { motivo }); toast('Compra anulada', 'ok'); detalle(root, id, setTopbar); } catch (e) { mostrarError(e); } });
}

// Tarjeta "TRM del dólar al momento de la compra" del detalle: la referencia oficial guardada con la compra y, en USD,
// la comparación con la tasa realmente aplicada (la que define el costo de los lotes).
function tarjetaTrm(c) {
  const usd = c.moneda === 'USD';
  const captura = c.trm_captura || 'no_disponible';
  const hayTrm = c.trm_valor !== null && c.trm_valor !== undefined;
  const cmp = c.comparacion_trm;
  return html`<div class="card">
    <div class="row between wrap gap"><h2 style="margin:0">TRM del dólar al momento de la compra</h2>${badge(CAPTURA_TRM, captura)}</div>
    ${hayTrm ? html`<dl class="kv mt">
        <dt>TRM oficial de referencia</dt><dd class="total">${fmt.tasa(c.trm_valor)}</dd>
        <dt>Fecha de referencia</dt><dd>${c.trm_fecha ? `vigente desde ${fmt.fecha(c.trm_fecha)}` : '—'}${c.trm_vigencia_hasta && c.trm_vigencia_hasta !== c.trm_fecha ? ` hasta ${fmt.fecha(c.trm_vigencia_hasta)}` : ''}</dd>
        <dt>Hora de registro</dt><dd>${fmt.fechaHora(c.trm_obtenida_en) || '—'}</dd>
        <dt>Fuente</dt><dd class="small" style="white-space:normal">${c.trm_fuente || '—'}</dd>
      </dl>
      <p class="muted xs mt">${TEXTO_CAPTURA[captura] || ''} ${usd ? 'El costo de los lotes usa la tasa aplicada, no esta referencia.' : 'La compra se registró en pesos: la TRM queda solo como referencia histórica.'}</p>
      ${usd && cmp ? html`<div class="tabla-wrap mt"><table class="tabla"><thead><tr><th>Concepto</th><th class="n">Pesos por dólar</th><th>Detalle</th></tr></thead><tbody>
        <tr><td>TRM oficial de referencia</td><td class="n">${fmt.tasa(cmp.trm_valor)}</td><td class="small muted">${c.trm_fecha ? `vigente desde ${fmt.fecha(c.trm_fecha)}` : ''}</td></tr>
        <tr><td>Tasa aplicada a la compra</td><td class="n">${fmt.tasa(cmp.tasa_cambio)}</td><td>${badge(ORIGEN_TASA, cmp.tasa_origen)}${cmp.tasa_nota ? html` <span class="small muted">${cmp.tasa_nota}</span>` : ''}</td></tr>
        <tr><td><b>Diferencia (aplicada − TRM)</b></td><td class="n"><b class="${cmp.diferencia_tasa > 0 ? 'neg' : cmp.diferencia_tasa < 0 ? 'pos' : ''}">${signoTasa(cmp.diferencia_tasa)}</b></td><td class="small">${cmp.diferencia_pct === null || cmp.diferencia_pct === undefined ? '' : `${cmp.diferencia_pct > 0 ? '+' : ''}${fmt.pct(cmp.diferencia_pct)} · `}${cmp.diferencia_tasa > 0 ? 'se pagó el dólar por encima de la TRM oficial' : cmp.diferencia_tasa < 0 ? 'se pagó el dólar por debajo de la TRM oficial' : 'igual a la TRM oficial'}</td></tr>
      </tbody></table></div>` : ''}`
    : html`<div class="alerta neutra mt small">No había TRM oficial disponible cuando se registró esta compra${c.trm_obtenida_en ? ` (${fmt.fechaHora(c.trm_obtenida_en)})` : ''} y nadie escribió una de referencia. ${usd ? html`La tasa aplicada fue <b>${fmt.tasa(c.tasa_cambio)}</b> (${(ORIGEN_TASA[c.tasa_origen] || [c.tasa_origen || ''])[0].toLowerCase()}); sin TRM no se puede calcular la diferencia.` : 'La compra se registró en pesos.'}</div>`}
  </div>`;
}

export function pagarCompra(c, alTerminar) {
  const metodos = estado.config.metodos_pago || ['efectivo'];
  let comprobante = null;
  if (c.moneda === 'USD') {
    let tasa = null;
    const saldoM = c.saldo_pendiente_moneda || 0;
    const m = modal({
      titulo: `Pago en USD a ${c.proveedor_nombre || 'proveedor'}`,
      cuerpo: `<p class="muted small">Saldo pendiente: <b>${fmt.usd(saldoM)}</b> (registrado a ${fmt.tasa(c.tasa_cambio)}). Si pagas a otra tasa, la diferencia en pesos se registra como diferencia cambiaria, separada del costo.</p>
        <div class="grid2 mt"><div class="campo"><label>Valor en USD *</label><input id="pg-usd" type="number" step="0.01" min="0.01" max="${saldoM}" inputmode="decimal" value="${saldoM}"></div><div class="campo"><label>Método</label><select id="pg-metodo">${metodos.map((x) => `<option value="${esc(x)}">${esc(nombreMetodo(x))}</option>`).join('')}</select></div></div>
        <div id="pg-tasa"></div>
        <div class="alerta neutra mt small" id="pg-preview">—</div>
        <div class="grid2 mt"><div class="campo"><label>Fecha</label><input id="pg-fecha" type="date" value="${hoyISO()}"></div><div class="campo"><label>Referencia</label><input id="pg-ref"></div></div>
        <div class="campo"><label>Nota</label><input id="pg-nota"></div><button type="button" class="btn suave bloque" id="pg-foto">${icono('camera')} Adjuntar comprobante</button>`,
      acciones: [{ texto: 'Registrar pago', clase: 'primario', alHacerClic: async ({ modal: mm }) => { await api.post(`/api/compras/${c.id}/pagos`, { valor_moneda: leerDecimal($('#pg-usd', mm)), ...tasa.datos(), metodo_pago: $('#pg-metodo', mm).value, fecha: $('#pg-fecha', mm).value, referencia: $('#pg-ref', mm).value, nota: $('#pg-nota', mm).value, comprobante }); toast('Pago registrado', 'ok'); alTerminar(); } }],
      alMontar: (mm) => {
        const preview = () => { const u = leerDecimal($('#pg-usd', mm)); const t = tasa ? tasa.valor() : 0; const dif = Math.round(u * (c.tasa_cambio - t)); $('#pg-preview', mm).innerHTML = t ? `Pagas <b>${fmt.usd(u)}</b> × ${fmt.tasa(t)} = <b>${fmt.cop(u * t)}</b>. Diferencia cambiaria: <b class="${dif < 0 ? 'neg' : 'pos'}">${fmt.signo(dif)}</b> ${dif > 0 ? '(ganancia: el dólar bajó)' : dif < 0 ? '(pérdida: el dólar subió)' : ''}` : 'Indica la tasa del pago.'; };
        tasa = campoTasa($('#pg-tasa', mm), { fecha: hoyISO(), alCambiar: preview });
        $('#pg-usd', mm).addEventListener('input', preview);
        $('#pg-fecha', mm).addEventListener('change', (e) => tasa.consultar(e.target.value));
        $('#pg-foto', mm).addEventListener('click', async () => { const f = await capturar({ camara: true }); if (f) { comprobante = f.dataUrl; $('#pg-foto', mm).innerHTML = `${icono('check')} Comprobante adjunto`; } });
      },
    });
    return m;
  }
  modal({
    titulo: `Pago a ${c.proveedor_nombre || 'proveedor'}`,
    cuerpo: `<p class="muted small">Saldo pendiente: <b>${fmt.cop(c.saldo_pendiente)}</b></p>
      <div class="grid2 mt"><div class="campo"><label>Valor *</label><input id="pg-valor" data-money value="${c.saldo_pendiente}"></div><div class="campo"><label>Método</label><select id="pg-metodo">${metodos.map((m) => `<option value="${esc(m)}">${esc(nombreMetodo(m))}</option>`).join('')}</select></div>
      <div class="campo"><label>Fecha</label><input id="pg-fecha" type="date" value="${hoyISO()}"></div><div class="campo"><label>Referencia</label><input id="pg-ref"></div></div>
      <div class="campo"><label>Nota</label><input id="pg-nota"></div><button type="button" class="btn suave bloque" id="pg-foto">${icono('camera')} Adjuntar comprobante</button>`,
    acciones: [{ texto: 'Registrar pago', clase: 'primario', alHacerClic: async ({ modal: m }) => { await api.post(`/api/compras/${c.id}/pagos`, { valor: leerDinero($('#pg-valor', m)), metodo_pago: $('#pg-metodo', m).value, fecha: $('#pg-fecha', m).value, referencia: $('#pg-ref', m).value, nota: $('#pg-nota', m).value, comprobante }); toast('Pago registrado', 'ok'); alTerminar(); } }],
    alMontar: (m) => { $('#pg-foto', m).addEventListener('click', async () => { const f = await capturar({ camara: true }); if (f) { comprobante = f.dataUrl; $('#pg-foto', m).innerHTML = `${icono('check')} Comprobante adjunto`; } }); },
  });
}

// ---------- Nueva compra ----------
async function nueva(root, query, setTopbar) {
  setTopbar({ titulo: 'Registrar compra', atras: '#/compras' });
  const metodos = estado.config.metodos_pago || ['efectivo'];
  const st = { proveedor: null, proveedor_nuevo: null, items: [], documento_id: query.documento ? Number(query.documento) : null, ocr: null, moneda: 'COP', tasa: null, trmRef: null };
  if (query.producto) { try { const p = await api.get(`/api/productos/${query.producto}`); st.items.push(itemDesde(p)); } catch { /* nada */ } }

  renderizar(root, html`<form id="f-compra">
    ${estado.config.ocr_disponible || st.documento_id ? html`<div class="alerta info row between mb"><span>${raw(icono('sparkle', 18))} Toma una foto de la factura y la lectura automática llena el formulario. Revisa todo antes de guardar.</span><button type="button" class="btn chico suave" id="fc-ocr">${raw(icono('camera', 16))} Escanear factura</button></div>` : html`<div class="alerta neutra row between mb"><span>Puedes adjuntar la foto de la factura. La lectura automática (OCR) requiere configurar la clave de IA en el servidor.</span><button type="button" class="btn chico suave" id="fc-ocr">${raw(icono('camera', 16))} Adjuntar</button></div>`}
    <div id="fc-ocr-aviso"></div>
    <div class="card">
      <div class="campo"><label>Proveedor</label><div class="row"><button type="button" class="btn suave grow" id="fc-prov" style="justify-content:space-between">Seleccionar proveedor ${raw(icono('chevron', 18))}</button></div></div>
      <div class="grid2"><div class="campo"><label>Fecha *</label><input name="fecha" type="date" value="${hoyISO()}" max="${hoyISO()}" required></div><div class="campo"><label>N° de factura / comprobante</label><input name="numero_factura"></div><div class="campo"><label>Nombre del contacto</label><input name="contacto"></div>
        <div class="campo"><label>Moneda de la factura</label><select name="moneda"><option value="COP">Pesos colombianos (COP)</option><option value="USD">Dólares (USD)</option></select></div></div>
      <div id="fc-tasa" hidden class="mt"></div>
    </div>
    <div class="card" id="fc-trm-ref" aria-live="polite"></div>
    <div class="card"><div class="row between"><h2 style="margin:0">Productos</h2><div class="row"><button type="button" class="btn icono" id="fc-scan" title="Escanear">${raw(icono('scan'))}</button><button type="button" class="btn chico primario" id="fc-add">${raw(icono('plus', 16))} Agregar</button></div></div><div id="fc-items" class="mt"></div></div>
    <div class="card"><h2>Totales y pago</h2>
      <div class="grid3"><div class="campo"><label>Descuento general <span id="fc-mon-1" class="muted">(COP)</span></label><input name="descuento" data-money><input name="descuento_usd" type="number" step="0.01" min="0" inputmode="decimal" hidden></div><div class="campo"><label>Transporte / otros costos (COP)</label><input name="costos_adicionales" data-money></div><div class="campo"><label>Impuestos (COP)</label><input name="impuestos" data-money></div></div>
      <dl class="kv"><dt>Subtotal</dt><dd id="fc-subtotal">$ 0</dd><dt id="fc-deuda-et" hidden>Deuda con el proveedor (USD)</dt><dd id="fc-deuda" hidden></dd><dt>Total de la compra al costo (COP)</dt><dd class="total" id="fc-total">$ 0</dd></dl>
      <div class="sep"></div>
      <div class="grid3"><div class="campo"><label>Valor pagado ahora <span id="fc-mon-2" class="muted">(COP)</span></label><input name="valor_pagado" data-money><input name="valor_pagado_usd" type="number" step="0.01" min="0" inputmode="decimal" hidden></div><div class="campo"><label>Método de pago</label><select name="metodo_pago">${metodos.map((m) => html`<option value="${esc(m)}">${nombreMetodo(m)}</option>`)}</select></div><div class="campo"><label>Vencimiento del saldo</label><input name="fecha_vencimiento" type="date"></div></div>
      <div class="alerta aviso" id="fc-saldo" hidden></div>
      <div class="campo mt"><label>Notas y observaciones</label><textarea name="notas"></textarea></div>
    </div>
    <div class="form-pie"><a class="btn suave" href="#/compras">Cancelar</a><button class="btn primario" type="submit">Confirmar compra</button></div>
  </form>`);
  activarDinero(root);
  const form = $('#f-compra', root);

  const pintarProveedor = () => { const b = $('#fc-prov', root); b.innerHTML = `${st.proveedor ? esc(st.proveedor.nombre) : st.proveedor_nuevo ? esc(st.proveedor_nuevo.nombre) + ' (nuevo)' : 'Seleccionar proveedor'} ${icono('chevron', 18)}`; };
  const esUsd = () => st.moneda === 'USD';
  const tasaActual = () => (esUsd() && st.tasa ? st.tasa.valor() : 1);
  const totales = () => {
    const usd = esUsd();
    const tasa = tasaActual();
    const sub = st.items.reduce((s, it) => s + it.cantidad * it.costo - (it.descuento || 0), 0);
    const d = usd ? leerDecimal(form.descuento_usd) : leerDinero(form.descuento);
    const ca = leerDinero(form.costos_adicionales), im = leerDinero(form.impuestos);
    const deudaM = sub - d;
    const total = Math.round(deudaM * tasa) + ca + im;
    $('#fc-subtotal', root).innerHTML = usd ? `${fmt.usd(sub)} <span class="muted xs">× ${fmt.tasa(tasa)} = ${fmt.cop(sub * tasa)}</span>` : fmt.cop(sub);
    $('#fc-deuda-et', root).hidden = !usd; $('#fc-deuda', root).hidden = !usd; $('#fc-deuda', root).textContent = fmt.usd(deudaM);
    $('#fc-total', root).textContent = fmt.cop(total);
    const pagado = usd ? leerDecimal(form.valor_pagado_usd) : leerDinero(form.valor_pagado);
    const saldo = (usd ? deudaM : total) - pagado;
    const av = $('#fc-saldo', root);
    av.hidden = saldo <= 0; av.textContent = saldo > 0 ? `Quedará un saldo pendiente con el proveedor de ${usd ? fmt.usd(saldo) + ' (≈ ' + fmt.cop(saldo * tasa) + ')' : fmt.cop(saldo)}` : '';
    return { sub, total };
  };
  const cambiarMoneda = (m) => {
    st.moneda = m;
    const usd = m === 'USD';
    form.descuento.hidden = usd; form.descuento_usd.hidden = !usd; form.valor_pagado.hidden = usd; form.valor_pagado_usd.hidden = !usd;
    $('#fc-mon-1', root).textContent = usd ? '(USD)' : '(COP)'; $('#fc-mon-2', root).textContent = usd ? '(USD)' : '(COP)';
    const cont = $('#fc-tasa', root);
    cont.hidden = !usd;
    if (usd && !st.tasa) st.tasa = campoTasa(cont, { fecha: form.fecha.value, etiqueta: 'Tasa aplicada a la compra (pesos por dólar) *', alCambiar: () => { totales(); if (st.trmRef) st.trmRef.refrescar(); } });
    else if (usd) st.tasa.consultar(form.fecha.value);
    if (st.trmRef) st.trmRef.refrescar();
    pintarItems();
  };
  const pintarItems = () => {
    const c = $('#fc-items', root);
    const usd = esUsd();
    if (!st.items.length) { c.innerHTML = String(vacio('Agrega los productos comprados')); totales(); return; }
    c.innerHTML = st.items.map((it, i) => `<div class="card compacta mb" style="margin-top:0">
      <div class="row between"><div class="bold truncate">${esc(it.nombre)}</div><button type="button" class="btn chico fantasma" data-x="${i}">${icono('x', 16)}</button></div>
      ${it.ocr ? `<div class="xs muted">Leído de la factura: "${esc(it.ocr)}"</div>` : ''}
      <div class="grid3 mt"><div class="campo" style="margin:0"><label>Cantidad</label><input type="number" min="1" value="${it.cantidad}" data-cant="${i}" inputmode="numeric"></div><div class="campo" style="margin:0"><label>Costo unitario ${usd ? 'USD' : ''}</label>${usd ? `<input type="number" step="0.01" min="0" inputmode="decimal" data-costo="${i}" value="${it.costo || ''}">` : `<input data-money data-costo="${i}" value="${it.costo || ''}">`}</div><div class="campo" style="margin:0"><label>Descuento línea ${usd ? 'USD' : ''}</label>${usd ? `<input type="number" step="0.01" min="0" inputmode="decimal" data-desc="${i}" value="${it.descuento || ''}">` : `<input data-money data-desc="${i}" value="${it.descuento || ''}">`}</div></div>
      ${it.requiere_serial ? `<div class="campo mt" style="margin-bottom:0"><label>Seriales o estampillas (uno por línea) · <span data-sc="${i}">${(it.seriales || []).length}/${it.cantidad}</span></label><div class="row"><textarea data-ser="${i}" class="grow mono" rows="2">${esc((it.seriales || []).join('\n'))}</textarea><button type="button" class="btn icono" data-serscan="${i}" title="Escanear IMEI">${icono('scan')}</button></div></div>` : ''}
      <div class="right small mt">Total línea: <b class="num">${usd ? fmt.usd(it.cantidad * it.costo - (it.descuento || 0)) + ' <span class="muted xs">≈ ' + fmt.cop((it.cantidad * it.costo - (it.descuento || 0)) * tasaActual()) + '</span>' : fmt.cop(it.cantidad * it.costo - (it.descuento || 0))}</b>${it.ultimo_costo ? ` <span class="muted xs">· último costo ${fmt.cop(it.ultimo_costo)}</span>` : ''}</div></div>`).join('');
    activarDinero(c);
    $$('[data-x]', c).forEach((b) => b.addEventListener('click', () => { st.items.splice(Number(b.dataset.x), 1); pintarItems(); }));
    $$('[data-cant]', c).forEach((inp) => inp.addEventListener('change', () => { st.items[Number(inp.dataset.cant)].cantidad = Math.max(1, Number(inp.value) || 1); pintarItems(); }));
    $$('[data-costo]', c).forEach((inp) => inp.addEventListener('blur', () => { st.items[Number(inp.dataset.costo)].costo = usd ? leerDecimal(inp) : leerDinero(inp); pintarItems(); }));
    $$('[data-desc]', c).forEach((inp) => inp.addEventListener('blur', () => { st.items[Number(inp.dataset.desc)].descuento = usd ? leerDecimal(inp) : leerDinero(inp); pintarItems(); }));
    $$('[data-ser]', c).forEach((ta) => ta.addEventListener('input', () => { const i = Number(ta.dataset.ser); st.items[i].seriales = ta.value.split(/\n|,/).map((s) => s.trim()).filter(Boolean); $(`[data-sc="${i}"]`, c).textContent = `${st.items[i].seriales.length}/${st.items[i].cantidad}`; }));
    $$('[data-serscan]', c).forEach((b) => b.addEventListener('click', async () => { const s = await escanear({ titulo: 'Escanear serial o estampilla' }); if (!s) return; const i = Number(b.dataset.serscan); st.items[i].seriales = [...(st.items[i].seriales || []), s]; if (st.items[i].seriales.length > st.items[i].cantidad) st.items[i].cantidad = st.items[i].seriales.length; pintarItems(); }));
    totales();
  };
  const agregarProducto = (p, extra = {}) => { const ex = st.items.find((it) => it.producto_id === p.id); if (ex && !extra.ocr) { ex.cantidad += 1; } else st.items.push({ ...itemDesde(p), ...extra }); pintarItems(); };
  const selectorProducto = () => selectorBusqueda({ titulo: 'Agregar producto', placeholder: 'Nombre, referencia o código', buscar: async (t) => (await api.get('/api/productos' + api.qs({ q: t, limite: 20 }))).productos.map((p) => ({ id: p.id, titulo: p.nombre, sub: [p.referencia, p.marca, `stock ${p.stock}`, estado.tiene('inventario.ver') ? `costo ${fmt.cop(p.precio_compra)}` : ''].filter(Boolean).join(' · '), datos: p })), alElegir: (it) => agregarProducto(it.datos), crearNuevo: { texto: 'Crear producto nuevo', accion: async (texto) => { const p = await crearProductoRapido({ nombre: texto }); if (p) agregarProducto(p); } } });
  $('#fc-add', root).addEventListener('click', selectorProducto);
  $('#fc-scan', root).addEventListener('click', async () => { const c = await escanear(); if (!c) return; try { const p = await api.get(`/api/productos/codigo/${encodeURIComponent(c)}`); agregarProducto(p); } catch (e) { if (e.status === 404 && estado.tiene('inventario.editar')) { const p = await crearProductoRapido({ codigo: c }); if (p) agregarProducto(p); } else mostrarError(e); } });
  $('#fc-prov', root).addEventListener('click', () => selectorBusqueda({ titulo: 'Proveedor', placeholder: 'Nombre, NIT o teléfono', buscar: async (t) => (await api.get('/api/proveedores' + api.qs({ q: t }))).map((p) => ({ id: p.id, titulo: p.nombre, sub: [p.telefono, p.saldo_pendiente ? 'saldo ' + fmt.cop(p.saldo_pendiente) : ''].filter(Boolean).join(' · '), datos: p })), alElegir: (it) => { st.proveedor = it.datos; st.proveedor_nuevo = null; pintarProveedor(); }, crearNuevo: { texto: 'Proveedor nuevo', accion: (texto) => nuevoProveedorInline(texto, (np) => { st.proveedor = null; st.proveedor_nuevo = np; pintarProveedor(); }) } }));
  ['descuento', 'costos_adicionales', 'impuestos', 'valor_pagado', 'descuento_usd', 'valor_pagado_usd'].forEach((n) => { form[n].addEventListener('blur', totales); form[n].addEventListener('input', totales); });
  form.moneda.addEventListener('change', (e) => cambiarMoneda(e.target.value));
  form.fecha.addEventListener('change', () => { if (esUsd() && st.tasa) st.tasa.consultar(form.fecha.value); if (st.trmRef) st.trmRef.consultar(form.fecha.value); });
  // TRM oficial de referencia del día de la compra (en COP y en USD): se guarda con la compra aparte de la tasa aplicada.
  st.trmRef = bloqueTrm($('#fc-trm-ref', root), { fecha: form.fecha.value, tasaAplicada: () => (esUsd() && st.tasa ? st.tasa.valor() || null : null) });

  // OCR / documento
  const aplicarOcr = (datos, documentoId) => {
    st.documento_id = documentoId;
    st.ocr = datos;
    if (datos.fecha && /^\d{4}-\d{2}-\d{2}$/.test(datos.fecha) && datos.fecha <= hoyISO()) { form.fecha.value = datos.fecha; if (st.trmRef) st.trmRef.consultar(datos.fecha); if (esUsd() && st.tasa) st.tasa.consultar(datos.fecha); }
    if (datos.numero_factura) form.numero_factura.value = datos.numero_factura;
    if (datos.descuento) { form.descuento.value = datos.descuento; }
    if (datos.impuestos) form.impuestos.value = datos.impuestos;
    if (datos.costos_adicionales) form.costos_adicionales.value = datos.costos_adicionales;
    if (datos.observaciones) form.notas.value = datos.observaciones;
    if (datos.proveedor_sugerido) { st.proveedor = datos.proveedor_sugerido; st.proveedor_nuevo = null; }
    else if (datos.proveedor) { st.proveedor = null; st.proveedor_nuevo = { nombre: datos.proveedor, identificacion: datos.identificacion_proveedor || '', telefono: datos.telefono_proveedor || '' }; }
    pintarProveedor();
    st.items = [];
    const sinProducto = [];
    for (const it of datos.items || []) {
      if (it.producto_sugerido) st.items.push({ ...itemDesde(it.producto_sugerido), cantidad: Math.max(1, Math.round(it.cantidad || 1)), costo: Math.round(it.costo_unitario || (it.total && it.cantidad ? it.total / it.cantidad : 0)), ocr: it.descripcion });
      else sinProducto.push(it);
    }
    activarDinero(form);
    pintarItems();
    totales();
    const aviso = $('#fc-ocr-aviso', root);
    aviso.innerHTML = `<div class="alerta aviso mb"><b>Revisa los datos detectados</b> (confianza ${Math.round((datos.confianza || 0) * 100)}%). ${datos.total ? 'Total leído: ' + fmt.cop(datos.total) + '.' : ''} ${sinProducto.length ? `<br>${sinProducto.length} línea(s) no coinciden con productos del catálogo:` : ''}${sinProducto.map((it, i) => `<div class="row between small mt"><span>${esc(it.descripcion)} · ${it.cantidad} × ${fmt.cop(it.costo_unitario)}</span><span class="row"><button type="button" class="btn chico suave" data-ocr-buscar="${i}">Elegir</button><button type="button" class="btn chico suave" data-ocr-crear="${i}">Crear</button></span></div>`).join('')}</div>`;
    $$('[data-ocr-buscar]', aviso).forEach((b) => b.addEventListener('click', () => { const it = sinProducto[Number(b.dataset.ocrBuscar)]; selectorBusqueda({ titulo: `Producto para "${it.descripcion}"`, buscar: async (t) => (await api.get('/api/productos' + api.qs({ q: t || it.descripcion.split(' ')[0], limite: 20 }))).productos.map((p) => ({ id: p.id, titulo: p.nombre, sub: p.referencia || '', datos: p })), alElegir: (x) => { agregarProducto(x.datos, { cantidad: Math.max(1, Math.round(it.cantidad || 1)), costo: Math.round(it.costo_unitario || 0), ocr: it.descripcion }); b.closest('.row').remove(); } }); }));
    $$('[data-ocr-crear]', aviso).forEach((b) => b.addEventListener('click', async () => { const it = sinProducto[Number(b.dataset.ocrCrear)]; const p = await crearProductoRapido({ nombre: it.descripcion }); if (p) { agregarProducto(p, { cantidad: Math.max(1, Math.round(it.cantidad || 1)), costo: Math.round(it.costo_unitario || 0), ocr: it.descripcion }); b.closest('.row').remove(); } }));
  };
  $('#fc-ocr', root).addEventListener('click', async () => {
    const f = await capturar({ camara: true });
    if (!f) return;
    const aviso = $('#fc-ocr-aviso', root);
    aviso.innerHTML = '<div class="alerta neutra mb">Subiendo documento…</div>';
    try {
      const doc = await api.post('/api/documentos', { archivo: f.dataUrl, nombre: f.nombre, tipo: 'factura_compra', origen: 'camara' });
      st.documento_id = doc.id;
      if (!estado.config.ocr_disponible) { aviso.innerHTML = '<div class="alerta info mb">Factura adjunta a la compra. Completa los datos manualmente.</div>'; return; }
      aviso.innerHTML = '<div class="alerta neutra mb">Leyendo la factura con IA… esto tarda unos segundos.</div>';
      const r = await api.post(`/api/documentos/${doc.id}/ocr`);
      if (!r.datos.es_factura) { aviso.innerHTML = '<div class="alerta aviso mb">El documento no parece una factura. Quedó adjunto; completa los datos manualmente.</div>'; return; }
      aplicarOcr(r.datos, doc.id);
    } catch (e) { aviso.innerHTML = `<div class="alerta peligro mb">No se pudo leer el documento: ${esc(e.message)}. Completa los datos manualmente.</div>`; }
  });
  if (st.documento_id) {
    try { const d = await api.get(`/api/documentos/${st.documento_id}`); if (d.datos_ocr && d.datos_ocr.es_factura !== false) aplicarOcr(d.datos_ocr, d.id); else $('#fc-ocr-aviso', root).innerHTML = '<div class="alerta info mb">Documento adjunto desde la bandeja.</div>'; } catch (e) { mostrarError(e); }
  }
  pintarProveedor();
  pintarItems();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!st.items.length) return toast('Agrega al menos un producto', 'error');
    for (const it of st.items) if (it.requiere_serial && (it.seriales || []).length !== it.cantidad) return toast(`${it.nombre}: indica ${it.cantidad} serial(es)`, 'error');
    const usd = esUsd();
    if (usd && !(st.tasa && st.tasa.valor() > 0)) return toast('Indica la tasa de cambio de la compra', 'error');
    const datos = {
      proveedor_id: st.proveedor ? st.proveedor.id : null, proveedor_nuevo: st.proveedor_nuevo,
      fecha: form.fecha.value, numero_factura: form.numero_factura.value.trim(), contacto: form.contacto.value.trim(),
      moneda: st.moneda, ...(usd ? st.tasa.datos() : {}),
      items: st.items.map((it) => ({ producto_id: it.producto_id, cantidad: it.cantidad, costo_unitario: it.costo, descuento: it.descuento || 0, seriales: it.seriales || [] })),
      descuento: usd ? leerDecimal(form.descuento_usd) : leerDinero(form.descuento), costos_adicionales: leerDinero(form.costos_adicionales), impuestos: leerDinero(form.impuestos),
      valor_pagado: usd ? leerDecimal(form.valor_pagado_usd) : leerDinero(form.valor_pagado), metodo_pago: form.metodo_pago.value, fecha_vencimiento: form.fecha_vencimiento.value || null, notas: form.notas.value.trim(), documento_id: st.documento_id,
      ...(st.trmRef ? st.trmRef.datos() : {}), // TRM de referencia manual (solo cuando no hubo TRM oficial para la fecha)
    };
    const enviar = async (forzar) => {
      try {
        const c = await api.post('/api/compras', { ...datos, forzar });
        toast(`Compra ${c.numero} registrada: inventario actualizado`, 'ok');
        navegar(`#/compras/${c.id}`, true);
      } catch (err) {
        if (err.datos && err.datos.codigo === 'posible_duplicado' && !forzar) {
          if (await confirmar(`Posible factura duplicada: ${err.message} ¿Registrar de todas formas?`, { peligro: true, textoOk: 'Registrar igual' })) return enviar(true);
          return;
        }
        mostrarError(err);
      }
    };
    enviar(false);
  });
}

// Bloque "TRM del dólar al momento de la compra" del formulario: consulta la TRM oficial de la fecha (GET /api/trm/tasa) y la
// muestra con vigencia, fuente y hora de consulta. Si no hay dato, ofrece escribir una TRM de referencia manual con su motivo.
// `tasaAplicada()` (solo USD) permite mostrar la diferencia frente a la tasa que el usuario está aplicando.
// datos() devuelve lo que viaja con la compra: trm_referencia_manual / trm_referencia_nota, solo cuando no hubo TRM oficial.
function bloqueTrm(cont, { fecha, tasaAplicada }) {
  const st = { fecha: fecha || hoyISO(), info: null, cargando: true, consultada: null, manual: '', nota: '' };
  const pintar = () => {
    const i = st.info;
    const tasa = tasaAplicada ? tasaAplicada() : null;
    let cuerpo;
    if (st.cargando) {
      cuerpo = `<p class="muted small" style="margin:0">Consultando la TRM oficial para el ${fmt.fecha(st.fecha)}…</p>`;
    } else if (i && i.trm) {
      const dif = tasa ? Math.round((tasa - i.trm.valor) * 10000) / 10000 : null;
      const pct = dif !== null && i.trm.valor ? Math.round((dif / i.trm.valor) * 10000) / 100 : null;
      cuerpo = `<div class="row between wrap gap"><div><div class="muted xs">TRM oficial para el ${fmt.fecha(i.fecha || st.fecha)}</div><div class="num" style="font-size:24px;font-weight:700">${fmt.tasa(i.trm.valor)}</div>
          <div class="muted xs">Vigente desde ${fmt.fecha(i.trm.fecha)}${i.trm.vigencia_hasta && i.trm.vigencia_hasta !== i.trm.fecha ? ' hasta ' + fmt.fecha(i.trm.vigencia_hasta) : ''} · consultada a las ${st.consultada}${i.sugerida && i.sugerida.fuente ? '<br>' + esc(i.sugerida.fuente) : ''}</div></div>${badge(CAPTURA_TRM, 'automatica')}</div>
        ${tasa ? `<div class="alerta neutra mt small">Tasa aplicada <b>${fmt.tasa(tasa)}</b> frente a la TRM oficial <b>${fmt.tasa(i.trm.valor)}</b>: diferencia <b class="${dif > 0 ? 'neg' : dif < 0 ? 'pos' : ''}">${signoTasa(dif)}</b>${pct !== null ? ` (${pct > 0 ? '+' : ''}${fmt.pct(pct)})` : ''} por dólar.</div>` : ''}
        <p class="muted xs mt" style="margin-bottom:0">Queda guardada con la compra como referencia histórica${tasa ? '; el costo de los lotes usa la tasa aplicada' : ''}.</p>`;
    } else {
      cuerpo = `<div class="alerta aviso small">No hay TRM oficial verificable para el ${fmt.fecha(st.fecha)}${i && i.error ? ' (' + esc(i.error) + ')' : ''}. Puedes escribir una TRM de referencia y de dónde la tomaste; si la dejas vacía, la compra quedará marcada <b>TRM no disponible</b>.</div>
        <div class="grid2 mt"><div class="campo" style="margin:0"><label for="tr-manual">TRM de referencia (manual)</label><input id="tr-manual" type="number" step="0.01" min="100" inputmode="decimal" placeholder="Ej. 4150,25" value="${esc(st.manual)}"></div><div class="campo" style="margin:0"><label for="tr-nota">Motivo o fuente</label><input id="tr-nota" maxlength="300" placeholder="Ej. consulta en el Banco de la República" value="${esc(st.nota)}"></div></div>
        ${tasa ? `<p class="muted xs mt" style="margin-bottom:0">Tasa aplicada a la compra: <b>${fmt.tasa(tasa)}</b>. Sin TRM oficial no se puede calcular la diferencia.</p>` : ''}`;
    }
    cont.innerHTML = `<div class="row between wrap gap"><h2 style="margin:0">TRM del dólar al momento de la compra</h2><span class="muted xs">Referencia oficial, aparte de la tasa que apliques</span></div><div class="mt">${cuerpo}</div>`;
    const im = $('#tr-manual', cont), inn = $('#tr-nota', cont);
    if (im) im.addEventListener('input', () => { st.manual = im.value; });
    if (inn) inn.addEventListener('input', () => { st.nota = inn.value; });
  };
  let secuencia = 0;
  const consultar = async (f) => {
    const n = ++secuencia; // si la fecha cambia dos veces seguidas, solo cuenta la última respuesta
    st.fecha = f || hoyISO(); st.cargando = true; st.info = null; pintar();
    let info;
    try { info = await api.get('/api/trm/tasa' + api.qs({ fecha: st.fecha })); } catch (e) { info = { fecha: st.fecha, error: e.message }; }
    if (n !== secuencia) return;
    st.info = info;
    // Sin TRM pero con una tasa manual ya registrada en "TRM y dólar": se propone como referencia (el usuario la confirma al guardar).
    if (!info.trm && info.manual && !st.manual) { st.manual = String(info.manual.valor); if (!st.nota) st.nota = `Tasa manual registrada en la app${info.manual.nota ? ': ' + info.manual.nota : ''}`.slice(0, 300); }
    st.consultada = new Date().toTimeString().slice(0, 5);
    st.cargando = false; pintar();
  };
  consultar(st.fecha);
  return {
    consultar, refrescar: pintar, estado: st,
    datos: () => (st.info && st.info.trm ? {} : { trm_referencia_manual: String(st.manual || '').trim() ? leerDecimal({ value: st.manual }) : undefined, trm_referencia_nota: String(st.nota || '').trim() || undefined }),
  };
}

function itemDesde(p) { return { producto_id: p.id, nombre: p.nombre, cantidad: 1, costo: p.precio_compra || 0, descuento: 0, requiere_serial: !!p.requiere_serial, seriales: [], ultimo_costo: p.precio_compra }; }

function nuevoProveedorInline(nombre, alCrear) {
  modal({ titulo: 'Proveedor nuevo', cuerpo: `<div class="campo"><label>Nombre o razón social *</label><input id="np-nombre" value="${esc(nombre || '')}"></div><div class="grid2"><div class="campo"><label>NIT / cédula</label><input id="np-id"></div><div class="campo"><label>Teléfono</label><input id="np-tel" type="tel"></div></div><div class="campo"><label>Contacto</label><input id="np-contacto"></div><p class="muted xs">Se crea al confirmar la compra.</p>`,
    acciones: [{ texto: 'Usar este proveedor', clase: 'primario', alHacerClic: ({ modal: m }) => { const n = $('#np-nombre', m).value.trim(); if (!n) { toast('Escribe el nombre', 'error'); return false; } alCrear({ nombre: n, identificacion: $('#np-id', m).value, telefono: $('#np-tel', m).value, contacto: $('#np-contacto', m).value }); } }] });
}

// ---------- Bandeja de documentos ----------
async function bandeja(root, setTopbar) {
  setTopbar({ titulo: 'Documentos pendientes', atras: '#/compras', acciones: [{ icono: 'camera', titulo: 'Subir documento', alHacerClic: async () => { const f = await capturar({ camara: false }); if (!f) return; try { await api.post('/api/documentos', { archivo: f.dataUrl, nombre: f.nombre, tipo: 'factura_compra', origen: f.mime === 'application/pdf' ? 'pdf' : 'galeria' }); toast('Documento guardado en la bandeja', 'ok'); bandeja(root, setTopbar); } catch (e) { mostrarError(e); } } }] });
  let estadoF = 'pendiente';
  renderizar(root, html`<p class="muted small">Facturas que llegan por foto, galería, PDF o correo (vía n8n). Nada se registra en inventario hasta que confirmes la compra.</p>
    <div class="pills mt">${[['pendiente', 'Pendientes'], ['procesado', 'Procesados'], ['descartado', 'Descartados']].map(([v, t]) => html`<button class="pill ${v === estadoF ? 'activo' : ''}" data-e="${v}">${t}</button>`)}</div><div id="dc-lista" class="lista mt"></div>`);
  const cargar = async () => {
    $('#dc-lista', root).innerHTML = String(cargando(2));
    try {
      const docs = await api.get('/api/documentos' + api.qs({ estado: estadoF }));
      $('#dc-lista', root).innerHTML = docs.length ? docs.map((d) => `<div class="item" style="align-items:flex-start"><a class="thumb" href="/api/archivos/${esc(d.ruta)}" target="_blank">${d.mime === 'application/pdf' ? icono('file', 20) : `<img src="/api/archivos/${esc(d.ruta)}" alt="" loading="lazy">`}</a>
        <div class="cuerpo"><div class="titulo">${esc(d.nombre || 'Documento')}</div><div class="sub">${fmt.fechaHora(d.creado_en)} · ${esc({ camara: 'cámara', galeria: 'galería', pdf: 'PDF', email: 'correo', webhook: 'integración' }[d.origen] || d.origen)}${d.remitente ? ' · ' + esc(d.remitente) : ''}${d.usuario_nombre ? ' · ' + esc(d.usuario_nombre) : ''}</div>
          ${d.datos_ocr ? `<div class="sub">Leído: ${esc(d.datos_ocr.proveedor || '?')} · ${d.datos_ocr.total ? fmt.cop(d.datos_ocr.total) : ''} · ${(d.datos_ocr.items || []).length} línea(s)</div>` : d.ocr_estado ? `<div class="sub neg">${esc(d.ocr_estado)}</div>` : ''}
          ${d.compra_numero ? `<div class="sub">Compra ${esc(d.compra_numero)}</div>` : ''}
          ${d.estado === 'pendiente' ? `<div class="row wrap mt gap">${estado.tiene('compras.crear') ? `<a class="btn chico primario" href="#/compras/nueva?documento=${d.id}">Crear compra</a>` : ''}${estado.config.ocr_disponible && estado.tiene('documentos.procesar') ? `<button class="btn chico suave" data-ocr="${d.id}">${icono('sparkle', 14)} Leer con IA</button>` : ''}${estado.tiene('documentos.procesar') ? `<button class="btn chico suave" data-desc="${d.id}">Descartar</button>` : ''}</div>` : ''}
        </div></div>`).join('') : String(vacio('No hay documentos en esta bandeja'));
      $$('[data-ocr]', root).forEach((b) => b.addEventListener('click', async () => { b.disabled = true; b.textContent = 'Leyendo…'; try { await api.post(`/api/documentos/${b.dataset.ocr}/ocr`); toast('Documento leído', 'ok'); cargar(); } catch (e) { mostrarError(e); cargar(); } }));
      $$('[data-desc]', root).forEach((b) => b.addEventListener('click', async () => { const m = await pedirTexto('Descartar documento', { obligatorio: false, textoOk: 'Descartar' }); if (m === null) return; await api.post(`/api/documentos/${b.dataset.desc}/descartar`, { motivo: m }); cargar(); }));
    } catch (e) { mostrarError(e); }
  };
  $$('[data-e]', root).forEach((b) => b.addEventListener('click', () => { estadoF = b.dataset.e; $$('[data-e]', root).forEach((x) => x.classList.toggle('activo', x === b)); cargar(); }));
  cargar();
}
