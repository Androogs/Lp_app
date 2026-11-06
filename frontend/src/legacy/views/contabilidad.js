import { api } from '../../lib/api';
import { estado, navegar } from '../../lib/estado';
import { $, $$, html, raw, render as renderizar, fmt, icono, badge, ORIGEN_TASA, RESULTADO, toast, modal, mostrarError, debounce, cargando, vacio, esc, tabla, hoyISO, sumarDias, selectorBusqueda } from '../ui.js';
import { lineas, barras, barrasH, anillo, leyenda } from '../charts.js';
import { kpi, panel as panelHtml, tablaViz, SERIE_INGRESO, SERIE_COSTO, SERIE_GANANCIA } from '../paneles.js';

export async function render(root, { partes, query, setTopbar }) {
  setTopbar({ titulo: 'Contabilidad y TRM' });
  const tabs = [['panel', 'Panel financiero'], ['operaciones', 'Rentabilidad por operación'], ['trm', 'TRM y dólar'], ['diferencias', 'Diferencias cambiarias']];
  let tab = tabs.some(([v]) => v === partes[0]) ? partes[0] : 'panel';
  renderizar(root, html`<div class="tabs">${tabs.map(([v, t]) => html`<button class="${tab === v ? 'activo' : ''}" data-tab="${v}">${t}</button>`)}</div><div id="ct-cont"></div>`);
  const cont = $('#ct-cont', root);
  const pintar = () => { $$('[data-tab]', root).forEach((b) => b.classList.toggle('activo', b.dataset.tab === tab)); ({ panel, operaciones, trm: vistaTrm, diferencias })[tab](cont, query); };
  $$('[data-tab]', root).forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; history.replaceState(null, '', `#/contabilidad/${tab}`); pintar(); }));
  pintar();
}

// ---------- Filtros compartidos ----------
const PERIODOS = [['hoy', 'Hoy'], ['semana', 'Semana'], ['mes', 'Mes'], ['trimestre', 'Trimestre'], ['anio', 'Año'], ['rango', 'Rango']];
const GRANULARIDADES = { hoy: 'dia', semana: 'dia', mes: 'dia', trimestre: 'semana', anio: 'mes', rango: 'mes' };
function filtrosDesde(query) {
  return { periodo: query.periodo || 'mes', desde: query.desde || '', hasta: query.hasta || '', granularidad: '', categoria_id: '', proveedor_id: '', moneda: '', producto_id: query.producto_id || '', producto_nombre: '' };
}
function paramsDe(f) {
  const p = { categoria_id: f.categoria_id, proveedor_id: f.proveedor_id, moneda: f.moneda, producto_id: f.producto_id, granularidad: f.granularidad || GRANULARIDADES[f.periodo] };
  if (f.periodo === 'rango') { p.desde = f.desde || sumarDias(hoyISO(), -30); p.hasta = f.hasta || hoyISO(); } else p.periodo = f.periodo;
  return p;
}
async function barraFiltros(cont, f, alCambiar, { conGranularidad = false } = {}) {
  const [cats, provs] = await Promise.all([api.get('/api/categorias').catch(() => []), api.get('/api/proveedores').catch(() => [])]);
  const el = document.createElement('div');
  el.className = 'card compacta mb';
  el.innerHTML = `<div class="pills">${PERIODOS.map(([v, t]) => `<button class="pill ${f.periodo === v ? 'activo' : ''}" data-p="${v}">${t}</button>`).join('')}</div>
    <div class="row mt" id="fl-rango" ${f.periodo === 'rango' ? '' : 'hidden'}><input type="date" id="fl-desde" value="${esc(f.desde || sumarDias(hoyISO(), -30))}"><input type="date" id="fl-hasta" value="${esc(f.hasta || hoyISO())}"><button class="btn primario" id="fl-ok">Ver</button></div>
    <div class="row wrap mt gap">
      <select id="fl-cat" class="grow" style="min-width:140px"><option value="">Todas las categorías</option>${cats.filter((c) => !c.padre_id).map((c) => `<option value="${c.id}" ${String(c.id) === String(f.categoria_id) ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}</select>
      <select id="fl-prov" class="grow" style="min-width:140px"><option value="">Todos los proveedores</option>${provs.map((p) => `<option value="${p.id}" ${String(p.id) === String(f.proveedor_id) ? 'selected' : ''}>${esc(p.nombre)}</option>`).join('')}</select>
      <select id="fl-mon" style="min-width:120px"><option value="">Toda moneda</option><option value="COP" ${f.moneda === 'COP' ? 'selected' : ''}>Ventas en COP</option><option value="USD" ${f.moneda === 'USD' ? 'selected' : ''}>Ventas en USD</option></select>
      ${conGranularidad ? `<select id="fl-gran" style="min-width:120px">${[['', 'Agrupar: auto'], ['dia', 'Por día'], ['semana', 'Por semana'], ['mes', 'Por mes'], ['trimestre', 'Por trimestre'], ['anio', 'Por año']].map(([v, t]) => `<option value="${v}" ${f.granularidad === v ? 'selected' : ''}>${t}</option>`).join('')}</select>` : ''}
      <button type="button" class="btn chico suave" id="fl-prod">${icono('search', 14)} ${f.producto_nombre ? esc(f.producto_nombre) : 'Producto'}</button>${f.producto_id ? `<button type="button" class="btn chico fantasma" id="fl-prod-x">${icono('x', 14)}</button>` : ''}
    </div>`;
  cont.appendChild(el);
  $$('[data-p]', el).forEach((b) => b.addEventListener('click', () => { f.periodo = b.dataset.p; $$('[data-p]', el).forEach((x) => x.classList.toggle('activo', x === b)); $('#fl-rango', el).hidden = f.periodo !== 'rango'; if (f.periodo !== 'rango') alCambiar(); }));
  $('#fl-ok', el).addEventListener('click', () => { f.desde = $('#fl-desde', el).value; f.hasta = $('#fl-hasta', el).value; alCambiar(); });
  $('#fl-cat', el).addEventListener('change', (e) => { f.categoria_id = e.target.value; alCambiar(); });
  $('#fl-prov', el).addEventListener('change', (e) => { f.proveedor_id = e.target.value; alCambiar(); });
  $('#fl-mon', el).addEventListener('change', (e) => { f.moneda = e.target.value; alCambiar(); });
  const g = $('#fl-gran', el); if (g) g.addEventListener('change', (e) => { f.granularidad = e.target.value; alCambiar(); });
  $('#fl-prod', el).addEventListener('click', () => selectorBusqueda({ titulo: 'Filtrar por producto', buscar: async (t) => (await api.get('/api/productos' + api.qs({ q: t, limite: 20 }))).productos.map((p) => ({ id: p.id, titulo: p.nombre, sub: p.referencia || '', datos: p })), alElegir: (it) => { f.producto_id = it.id; f.producto_nombre = it.titulo; alCambiar(true); } }));
  const px = $('#fl-prod-x', el); if (px) px.addEventListener('click', () => { f.producto_id = ''; f.producto_nombre = ''; alCambiar(true); });
  return el;
}

// ---------- Panel financiero ----------
// Combina /api/contabilidad/panel (rentabilidad por lote, con filtros de producto/categoría/proveedor/moneda) con
// /api/analitica/finanzas (dinero recibido, cartera y gastos por categoría del mismo periodo, sin esos filtros).
async function panel(cont, query) {
  const f = filtrosDesde(query);
  cont.innerHTML = '';
  const cuerpo = document.createElement('div');
  await barraFiltros(cont, f, () => cargar(), { conGranularidad: true });
  cont.appendChild(cuerpo);
  async function cargar() {
    if (!cuerpo.innerHTML.trim()) cuerpo.innerHTML = String(cargando(5)); else cuerpo.style.opacity = '0.55';
    let d, fin = null;
    const p = paramsDe(f);
    try {
      [d, fin] = await Promise.all([api.get('/api/contabilidad/panel' + api.qs(p)), api.get('/api/analitica/finanzas' + api.qs({ periodo: p.periodo, desde: p.desde, hasta: p.hasta })).catch(() => null)]);
    } catch (e) { cuerpo.style.opacity = ''; return mostrarError(e); }
    cuerpo.style.opacity = '';
    const trmV = d.trm.vigente;
    const puntos = d.serie.puntos;
    const fr = fin && fin.resumen; const cart = fin && fin.cartera;
    const g = { dia: 'día', semana: 'semana', mes: 'mes', trimestre: 'trimestre', anio: 'año' }[d.serie.granularidad] || d.serie.granularidad;
    cuerpo.innerHTML = `
      <div class="muted small mb">${esc(fmt.fecha(d.periodo.desde))} – ${esc(fmt.fecha(d.periodo.hasta))}${d.filtros_activos ? ' · con filtros (los gastos operativos no se restan)' : ''}</div>
      <div class="kpis">
        ${kpi({ icono: 'trend_up', titulo: 'Ganancia bruta', valor: fmt.cop(d.ganancia_bruta), descripcion: `margen ${fmt.pct(d.margen_pct)} · ${d.ventas.operaciones} operaciones · costo por lote`, variacion: fr && !d.filtros_activos ? fr.variacion.ganancia_bruta : null, clase: 'acento' })}
        ${kpi({ icono: 'dollar', titulo: 'Ganancia neta estimada', valor: fmt.cop(d.ganancia_neta_estimada), descripcion: `bruta − comisiones − gastos de venta${d.filtros_activos ? '' : ' − gastos operativos'}`, variacion: fr && !d.filtros_activos ? fr.variacion.utilidad : null })}
        ${kpi({ icono: 'cart', titulo: 'Ingresos (ventas netas)', valor: fmt.cop(d.ventas.netas), descripcion: `${d.ventas.unidades} und · devoluciones ${fmt.cop(d.ventas.devoluciones)}${d.ventas.estimadas ? ` · ${d.ventas.estimadas} estimadas` : ''}`, variacion: fr && !d.filtros_activos ? fr.variacion.ingresos : null })}
        ${kpi({ icono: 'box', titulo: 'Costo de lo vendido', valor: fmt.cop(d.costo_vendido), descripcion: 'costo histórico de las unidades vendidas', variacion: fr && !d.filtros_activos ? fr.variacion.costo : null, invertir: true })}
        ${kpi({ icono: 'cash', titulo: 'Gastos registrados', valor: fmt.cop(d.gastos_operativos), descripcion: 'gastos operativos del periodo (caja y gastos)', variacion: fr ? fr.variacion.gastos : null, invertir: true, href: '#/caja/gastos' })}
        ${fr ? kpi({ icono: 'check', titulo: 'Dinero efectivamente recibido', valor: fmt.cop(fr.recibido), descripcion: `pagos de ventas y abonos · a crédito ${fmt.cop(fr.credito_otorgado)}`, variacion: fr.variacion.recibido }) : ''}
        ${cart ? kpi({ icono: 'card', titulo: 'Cuentas por cobrar', valor: fmt.cop(cart.pendiente), descripcion: `${cart.vigentes} crédito(s) · ${cart.vencidos} vencido(s) por ${fmt.cop(cart.saldo_vencido)}`, href: '#/creditos', alerta: cart.vencidos > 0 }) : ''}
        ${cart ? kpi({ icono: 'truck', titulo: 'Por pagar a proveedores', valor: fmt.cop(cart.por_pagar), descripcion: `${cart.facturas_pendientes} factura(s) · ${cart.facturas_vencidas} vencida(s)`, href: '#/compras?con_saldo=1', alerta: cart.facturas_vencidas > 0 }) : ''}
        ${kpi({ icono: 'bag', titulo: 'Compras del periodo', valor: fmt.cop(d.compras.total), descripcion: `${d.compras.cantidad} compra(s)${d.compras.n_usd ? ` · ${fmt.usd(d.compras.total_usd)} en ${d.compras.n_usd} en USD` : ''} · capital invertido histórico ${fmt.cop(d.capital_invertido)}` })}
        ${kpi({ icono: 'layers', titulo: 'Inventario al costo', valor: fmt.cop(d.inventario.valor_costo), descripcion: `${fmt.num(d.inventario.unidades)} und${d.inventario.usd.unidades ? ` · ${fmt.usd(d.inventario.usd.usd)} comprados en USD` : ''} · potencial ${fmt.cop(d.inventario.valor_venta)}`, href: '#/inventario' })}
        ${d.inventario.usd.unidades ? kpi({ icono: 'dollar', titulo: 'Inventario USD a tasa de hoy', valor: d.inventario.usd.valor_hoy === null ? '—' : fmt.cop(d.inventario.usd.valor_hoy), descripcion: `registrado ${fmt.cop(d.inventario.usd.cop)} · solo referencia, no se contabiliza` }) : ''}
        ${kpi({ icono: 'tag', titulo: 'Costos de venta', valor: fmt.cop(d.costos_venta.comisiones + d.costos_venta.gastos_venta), descripcion: `comisiones ${fmt.cop(d.costos_venta.comisiones)} · gastos ${fmt.cop(d.costos_venta.gastos_venta)} · impuestos (inf.) ${fmt.cop(d.costos_venta.impuestos)}` })}
        ${kpi({ icono: 'refresh', titulo: 'Diferencia cambiaria', valor: fmt.signo(d.diferencias_cambiarias.neto), descripcion: `${d.diferencias_cambiarias.n} op. · +${fmt.cop(d.diferencias_cambiarias.ganancia)} / ${fmt.cop(d.diferencias_cambiarias.perdida)}`, href: '#/contabilidad/diferencias' })}
        ${kpi({ icono: 'dollar', titulo: 'TRM vigente', valor: trmV ? fmt.tasa(trmV.valor) : '—', descripcion: `${trmV ? `${fmt.fecha(trmV.fecha)}${d.trm.variacion_periodo !== null ? ` · ${d.trm.variacion_periodo >= 0 ? '+' : ''}${d.trm.variacion_periodo} en el periodo` : ''}` : 'sin dato'}${d.trm.mercado ? ` · mercado ${fmt.tasa(d.trm.mercado.valor)}` : ''}`, href: '#/contabilidad/trm' })}
      </div>
      <div class="grid-viz mt-l">
        ${panelHtml({ id: 'cf-icg', titulo: 'Ingresos, costos y ganancia', sub: `Por ${g} · ventas netas, costo de lo vendido y ganancia bruta`, clase: 'span-4', pie: leyenda([{ nombre: 'Ingresos (ventas netas)', color: SERIE_INGRESO }, { nombre: 'Costo de lo vendido', color: SERIE_COSTO }, { nombre: 'Ganancia bruta', color: SERIE_GANANCIA }]) + tablaViz([{ titulo: 'Periodo', clave: 'etiqueta' }, { titulo: 'Ingresos', clave: 'ventas_netas', dinero: true }, { titulo: 'Costo', clave: 'costo', dinero: true }, { titulo: 'Ganancia bruta', clave: 'ganancia_bruta', dinero: true }, { titulo: 'Neta oper.', clave: 'ganancia_neta', dinero: true }, { titulo: 'Gastos', clave: 'gastos', dinero: true }], puntos) })}
        ${panelHtml({ id: 'cf-gastos', titulo: 'Gastos por categoría', sub: fin ? 'Gastos operativos registrados en el periodo' : 'No disponible con tu permiso', clase: 'span-2' })}
        ${panelHtml({ id: 'cf-evol', titulo: 'Evolución financiera', sub: `Por ${g} · ventas netas, compras y utilidad estimada (neta de operaciones − gastos)`, clase: 'span-3', pie: leyenda([{ nombre: 'Ventas netas', color: SERIE_INGRESO }, { nombre: 'Compras', color: SERIE_COSTO }, { nombre: 'Utilidad estimada', color: SERIE_GANANCIA }], { tipo: 'line' }) })}
        ${panelHtml({ id: 'cf-rent', titulo: 'Productos más rentables', sub: 'Ganancia bruta en el periodo', clase: 'span-3' })}
      </div>
      <div class="grid2 mt-l" style="align-items:start">
        <div class="card"><h2>Más rentables</h2>${d.productos.mas_rentables.length ? String(tabla([{ titulo: 'Producto', valor: (p) => p.nombre }, { titulo: 'Und', clave: 'unidades', num: true }, { titulo: 'Ganancia', clave: 'ganancia_bruta', dinero: true }, { titulo: 'Margen', valor: (p) => fmt.pct(p.margen_pct), num: true }], d.productos.mas_rentables)) : '<p class="muted">Sin ventas en el periodo.</p>'}</div>
        <div class="card"><h2>Menos rentables o con pérdida</h2>${d.productos.menos_rentables.length ? String(tabla([{ titulo: 'Producto', valor: (p) => p.nombre }, { titulo: 'Und', clave: 'unidades', num: true }, { titulo: 'Ganancia', clave: 'ganancia_bruta', dinero: true }, { titulo: 'Margen', valor: (p) => fmt.pct(p.margen_pct), num: true }], d.productos.menos_rentables)) : '<p class="muted">Sin ventas en el periodo.</p>'}</div>
      </div>
      <details class="mas mt"><summary>Cómo se calcula</summary><p class="small muted">${esc(d.criterios)} Ventas registradas, dinero recibido y utilidad calculada son cifras distintas: lo facturado a crédito no es dinero en caja.</p></details>
      <div class="row wrap gap mt"><a class="btn suave chico" href="#/reportes/comparacion_mensual">${icono('chart', 14)} Comparación mensual</a><a class="btn suave chico" href="#/reportes/rentabilidad_operaciones">${icono('download', 14)} Exportar rentabilidad</a><a class="btn suave chico" href="#/reportes/productos_rentabilidad">${icono('download', 14)} Productos rentables</a></div>`;
    barras($('#cf-icg', cuerpo), { etiquetas: puntos.map((x) => x.etiqueta), series: [{ nombre: 'Ingresos (ventas netas)', valores: puntos.map((x) => x.ventas_netas), color: SERIE_INGRESO }, { nombre: 'Costo de lo vendido', valores: puntos.map((x) => x.costo), color: SERIE_COSTO }, { nombre: 'Ganancia bruta', valores: puntos.map((x) => x.ganancia_bruta), color: SERIE_GANANCIA }], aria: 'Ingresos, costos y ganancia' });
    if (fin) barrasH($('#cf-gastos', cuerpo), { items: fin.gastos_por_categoria.map((x) => ({ etiqueta: x.etiqueta, valor: x.total, nombreValor: 'Gastado', sub: `${x.n} registro(s)` })), formato: fmt.cop, vacio: 'Sin gastos en el periodo' });
    else $('#cf-gastos', cuerpo).innerHTML = '<p class="muted small">Requiere permiso de caja.</p>';
    lineas($('#cf-evol', cuerpo), { etiquetas: puntos.map((x) => x.etiqueta), series: [{ nombre: 'Ventas netas', valores: puntos.map((x) => x.ventas_netas), color: SERIE_INGRESO }, { nombre: 'Compras', valores: puntos.map((x) => x.compras), color: SERIE_COSTO }, { nombre: 'Utilidad estimada', valores: puntos.map((x) => x.ganancia_neta - x.gastos), color: SERIE_GANANCIA }], area: false, aria: 'Evolución financiera' });
    barrasH($('#cf-rent', cuerpo), { items: d.productos.mas_rentables.map((x) => ({ etiqueta: x.nombre, valor: x.ganancia_bruta, nombreValor: 'Ganancia bruta', sub: `${x.unidades} und · margen ${fmt.pct(x.margen_pct)}`, href: `#/inventario/${x.producto_id}` })), formato: fmt.cop, vacio: 'Sin ventas en el periodo' });
  }
  cargar();
}

// ---------- Rentabilidad por operación ----------
async function operaciones(cont, query) {
  const f = filtrosDesde(query);
  cont.innerHTML = '';
  const cuerpo = document.createElement('div');
  await barraFiltros(cont, f, () => cargar());
  cont.appendChild(cuerpo);
  let datos = null;
  async function cargar() {
    cuerpo.innerHTML = String(cargando(5));
    try { datos = await api.get('/api/contabilidad/operaciones' + api.qs(paramsDe(f))); } catch (e) { return mostrarError(e); }
    const t = datos.totales;
    renderizar(cuerpo, html`
      <div class="kpis mb"><div class="kpi"><div class="et">Ingreso neto</div><div class="va">${fmt.cop(t.ingreso_neto)}</div></div><div class="kpi"><div class="et">Costo</div><div class="va">${fmt.cop(t.costo)}</div></div><div class="kpi acento"><div class="et">Ganancia bruta</div><div class="va">${fmt.cop(t.ganancia_bruta)}</div><div class="de">margen ${fmt.pct(t.margen_pct)}</div></div><div class="kpi"><div class="et">Ganancia neta</div><div class="va ${t.ganancia_neta < 0 ? 'neg' : ''}">${fmt.cop(t.ganancia_neta)}</div><div class="de">${t.estimados ? `${t.estimados} con cobro pendiente` : 'todas definitivas'}</div></div></div>
      <div class="row between mb"><span class="muted small">${datos.items.length} operación(es). Toca una para ver cómo se calculó.</span><a class="btn chico suave" href="/api/reportes/rentabilidad_operaciones${api.qs({ ...paramsDe(f), formato: 'csv' })}">${raw(icono('download', 14))} Excel</a></div>
      ${datos.items.length ? html`<div class="tabla-wrap"><table class="tabla"><thead><tr><th>Fecha</th><th>Venta</th><th>Producto</th><th class="n">Und</th><th>Moneda / tasa</th><th class="n">Ingreso neto</th><th class="n">Costo</th><th class="n">Ganancia bruta</th><th class="n">Neta</th><th class="n">Margen</th><th>Resultado</th></tr></thead><tbody>
        ${datos.items.map((it, i) => html`<tr data-op="${i}" style="cursor:pointer"><td>${fmt.fecha(it.fecha)}</td><td>${it.numero}</td><td class="truncate" style="max-width:220px">${it.nombre_producto}</td><td class="n">${it.cantidad - it.cantidad_devuelta}</td><td>${it.moneda}${it.moneda !== 'COP' ? ` ${fmt.tasa(it.tasa_cambio)}` : ''}${it.tasa_compra_promedio ? html`<div class="xs muted">compra ${fmt.tasa(it.tasa_compra_promedio)}</div>` : ''}</td><td class="n">${fmt.cop(it.ingreso_neto)}</td><td class="n">${fmt.cop(it.costo_neto)}</td><td class="n ${it.ganancia_bruta < 0 ? 'neg' : ''}">${fmt.cop(it.ganancia_bruta)}</td><td class="n ${it.ganancia_neta < 0 ? 'neg' : ''}">${fmt.cop(it.ganancia_neta)}</td><td class="n">${fmt.pct(it.margen_pct)}</td><td>${badge(RESULTADO, it.resultado)}</td></tr>`)}</tbody></table></div>` : vacio('No hay operaciones con estos filtros')}`);
    $$('[data-op]', cuerpo).forEach((tr) => tr.addEventListener('click', () => fichaOperacion(datos.items[Number(tr.dataset.op)])));
  }
  cargar();
}

export function fichaOperacion(it) {
  const und = it.cantidad - it.cantidad_devuelta;
  const lotes = it.lotes || [];
  modal({
    titulo: `${it.numero} · ${it.nombre_producto}`,
    ancho: true,
    cuerpo: `<div class="row between"><div class="muted small">${fmt.fechaHora(it.fecha)} · ${esc(it.cliente || 'Consumidor final')}</div>${String(badge(RESULTADO, it.resultado))}</div>
      <div class="sep"></div>
      <h3>1. Ingreso de la venta</h3>
      <dl class="kv mt"><dt>Moneda de la venta</dt><dd>${it.moneda}${it.moneda !== 'COP' ? ` · tasa ${fmt.tasa(it.tasa_cambio)} (${(ORIGEN_TASA[it.tasa_origen] || [it.tasa_origen || '—'])[0]})` : ''}</dd>
        <dt>Precio unitario</dt><dd>${it.moneda !== 'COP' ? `${fmt.usd(it.precio_unitario_moneda)} × ${fmt.tasa(it.tasa_cambio)} = ` : ''}${fmt.cop(it.precio_unitario)}</dd>
        <dt>Facturado (${it.cantidad} und${it.descuento ? ' − descuento ' + fmt.cop(it.descuento) : ''})</dt><dd>${fmt.cop(it.total)}</dd>
        ${it.devuelto ? `<dt>Devoluciones (${it.cantidad_devuelta} und)</dt><dd class="neg">−${fmt.cop(it.devuelto)}</dd>` : ''}
        <dt class="bold">Ingreso neto en COP</dt><dd class="total">${fmt.cop(it.ingreso_neto)}</dd></dl>
      <h3 class="mt">2. Costo de adquisición de las unidades vendidas (${it.metodo_costo})</h3>
      <div class="tabla-wrap mt"><table class="tabla"><thead><tr><th>Lote</th><th>Compra</th><th class="n">Und</th><th>Moneda</th><th class="n">Costo moneda</th><th class="n">Tasa compra</th><th class="n">Costo COP/und</th><th class="n">Subtotal</th></tr></thead><tbody>
        ${lotes.map((l) => `<tr><td>${fmt.fecha(l.lote_fecha)}${l.serial ? `<div class="xs mono">${esc(l.serial)}</div>` : ''}</td><td>${esc(l.compra_numero || '—')}${l.proveedor ? `<div class="xs muted">${esc(l.proveedor)}</div>` : ''}</td><td class="n">${l.cantidad}</td><td>${l.moneda_compra}</td><td class="n">${l.moneda_compra === 'USD' ? fmt.usd(l.costo_unitario_moneda) : '—'}</td><td class="n">${l.moneda_compra === 'USD' ? fmt.tasa(l.tasa_compra) : '—'}</td><td class="n">${fmt.cop(l.costo_unitario)}</td><td class="n">${fmt.cop(l.cantidad * l.costo_unitario)}</td></tr>`).join('')}</tbody></table></div>
      <p class="xs muted mt">El costo en COP de cada lote = costo en su moneda × tasa registrada en la compra + fletes/impuestos prorrateados. Esa tasa no cambia aunque el dólar suba o baje después.</p>
      <dl class="kv mt">${it.costo_devuelto ? `<dt>Costo reingresado por devolución</dt><dd>−${fmt.cop(it.costo_devuelto)}</dd>` : ''}<dt class="bold">Costo de lo vendido</dt><dd class="total">${fmt.cop(it.costo_neto)}</dd></dl>
      <h3 class="mt">3. Resultado</h3>
      <dl class="kv mt"><dt>Ganancia bruta = ingreso neto − costo</dt><dd class="total ${it.ganancia_bruta < 0 ? 'neg' : 'pos'}">${fmt.cop(it.ganancia_bruta)} (${fmt.pct(it.margen_pct)})</dd>
        <dt>Comisiones (prorrateadas)</dt><dd>−${fmt.cop(it.comision_item)}</dd><dt>Gastos de venta (prorrateados)</dt><dd>−${fmt.cop(it.gastos_item)}</dd>
        <dt class="bold">Ganancia neta ${it.resultado === 'estimado' ? 'estimada' : 'definitiva'}</dt><dd class="total ${it.ganancia_neta < 0 ? 'neg' : 'pos'}">${fmt.cop(it.ganancia_neta)}</dd>
        <dt>Impuestos (informativo, no se descuentan)</dt><dd>${fmt.cop(it.impuestos_item)}</dd></dl>
      ${it.moneda === 'USD' || it.tasa_compra_promedio ? `<h3 class="mt">4. Efecto de la tasa de cambio</h3><dl class="kv mt">${it.tasa_compra_promedio ? `<dt>Tasa promedio de compra</dt><dd>${fmt.tasa(it.tasa_compra_promedio)}</dd>` : ''}${it.moneda === 'USD' ? `<dt>Tasa de la venta</dt><dd>${fmt.tasa(it.tasa_cambio)}</dd>` : ''}${it.diferencia_tasa !== null && it.diferencia_tasa !== undefined ? `<dt>Diferencia de tasas (venta − compra)</dt><dd class="${it.diferencia_tasa >= 0 ? 'pos' : 'neg'}">${it.diferencia_tasa >= 0 ? '+' : ''}${it.diferencia_tasa}</dd>` : ''}<dt>Diferencia cambiaria realizada (abonos en USD)</dt><dd class="${it.diferencia_cambiaria_item < 0 ? 'neg' : ''}">${fmt.signo(it.diferencia_cambiaria_item)}</dd></dl><p class="xs muted mt">La rentabilidad del producto usa el costo histórico. La variación del dólar entre compra y venta no es ganancia comercial: solo se reconoce como diferencia cambiaria cuando se paga o cobra en USD a otra tasa.</p>` : ''}
      ${it.resultado === 'estimado' ? '<div class="alerta aviso mt small">Resultado estimado: la venta tiene saldo pendiente de cobro. Será definitivo cuando el crédito se pague.</div>' : ''}
      <div class="row mt"><a class="btn suave chico" href="#/ventas/${it.venta_id}">Ver venta</a><a class="btn suave chico" href="#/inventario/${it.producto_id}">Ver producto</a></div>`,
  });
}

// ---------- TRM y dólar ----------
async function vistaTrm(cont) {
  cont.innerHTML = String(cargando(5));
  let d;
  try { d = await api.get('/api/trm/actual'); } catch (e) { return mostrarError(e); }
  let rango = sessionStorage.getItem('trm.rango') || '1m';
  const flecha = (v) => (!v ? '' : v.pesos > 0 ? html`<span class="pos">${raw(icono('trend_up', 18))} +${v.pesos} (${v.pct >= 0 ? '+' : ''}${v.pct}%)</span>` : v.pesos < 0 ? html`<span class="neg">${raw(icono('trend_down', 18))} ${v.pesos} (${v.pct}%)</span>` : html`<span class="muted">sin cambio</span>`);
  const estadoCard = (e) => html`<div class="small ${e.conectado ? 'pos' : 'neg'}">${e.conectado ? '● Conectado' : '● Sin conexión'}</div><div class="xs muted">Última consulta: ${e.ultima_consulta ? fmt.fechaHora(e.ultima_consulta) : 'ninguna'} · última exitosa: ${e.ultimo_exito ? fmt.fechaHora(e.ultimo_exito) : 'ninguna'} · cada ${e.frecuencia_minutos} min</div>${e.error ? html`<div class="xs neg">${e.error}</div>` : ''}`;
  renderizar(cont, html`
    ${d.estado.red_desactivada ? html`<div class="alerta aviso mb">Las consultas a internet están desactivadas en este servidor (TRM_DESACTIVAR_RED).</div>` : ''}
    <div class="grid2" style="align-items:start">
      <div class="card"><div class="row between"><h2 style="margin:0">TRM oficial</h2><span class="badge ok">Superfinanciera</span></div>
        ${d.trm ? html`<div class="hero-num mt">${fmt.tasa(d.trm.valor)}</div><div class="mt">${flecha(d.trm.variacion)}${d.trm.variacion ? html` <span class="muted xs">frente a la TRM del ${fmt.fecha(d.trm.variacion.anterior_fecha)} (${fmt.tasa(d.trm.variacion.anterior)})</span>` : ''}</div>
          <div class="small muted mt">Vigente ${fmt.fecha(d.trm.vigencia_desde || d.trm.fecha)}${d.trm.vigencia_hasta && d.trm.vigencia_hasta !== d.trm.fecha ? ` al ${fmt.fecha(d.trm.vigencia_hasta)}` : ''} · obtenida ${fmt.fechaHora(d.trm.obtenido_en)}</div>
          ${d.trm.desactualizada ? html`<div class="alerta peligro mt small">Dato no actualizado: no se pudo consultar la fuente. Se muestra la última TRM disponible con su fecha.</div>` : !d.trm.vigente_hoy ? html`<div class="alerta aviso mt small">La TRM de hoy aún no está publicada; se muestra la última vigente.</div>` : ''}` : html`<div class="alerta peligro mt">Sin TRM disponible todavía. ${d.estado.trm.error || ''}</div>`}
        <div class="sep"></div>${estadoCard(d.estado.trm)}<div class="xs muted mt">Fuente: ${d.estado.trm.fuente}</div></div>
      <div class="card"><div class="row between"><h2 style="margin:0">Dólar de mercado</h2><span class="badge aviso">Referencia</span></div>
        ${d.mercado ? html`<div class="hero-num mt">${fmt.tasa(d.mercado.valor)}</div><div class="mt">${flecha(d.mercado.variacion)}</div>
          <div class="small muted mt">Cotización del ${fmt.fecha(d.mercado.fecha)}${d.mercado.actualizado ? ` · publicada ${fmt.fechaHora(d.mercado.actualizado)}` : ''} · obtenida ${fmt.fechaHora(d.mercado.obtenido_en)}</div>
          ${d.mercado.desactualizado ? html`<div class="alerta aviso mt small">Dato no actualizado: se muestra la última cotización disponible con su fecha.</div>` : ''}` : html`<div class="alerta aviso mt">Sin cotización de mercado. ${d.estado.mercado.error || ''}</div>`}
        <div class="sep"></div>${estadoCard(d.estado.mercado)}<div class="xs muted mt">Fuente: ${d.estado.mercado.fuente}. No es la TRM oficial: sirve de referencia intradía.</div></div>
    </div>
    <div class="row wrap gap mt"><button class="btn suave chico" id="trm-refrescar">${raw(icono('refresh', 14))} Actualizar ahora</button>${estado.tiene('contabilidad.editar') ? html`<button class="btn suave chico" id="trm-manual">${raw(icono('plus', 14))} Registrar tasa manual</button>` : ''}</div>
    <div class="card mt-l"><div class="row between wrap"><h2 style="margin:0">Evolución de la TRM</h2><div class="pills">${[['1s', 'Semana'], ['1m', 'Mes'], ['3m', 'Trimestre'], ['1a', 'Año']].map(([v, t]) => html`<button class="pill ${rango === v ? 'activo' : ''}" data-r="${v}">${t}</button>`)}</div></div><div id="trm-grafico" class="mt"></div></div>
    <div class="card"><h2>Historial</h2><div id="trm-tabla"></div></div>`);
  const cargarHistorial = async () => {
    const dias = { '1s': 7, '1m': 30, '3m': 91, '1a': 365 }[rango];
    $('#trm-grafico', cont).innerHTML = String(cargando(2));
    try {
      const h = await api.get('/api/trm/historial' + api.qs({ desde: sumarDias(hoyISO(), -dias), hasta: hoyISO() }));
      const trmPuntos = h.filas.filter((f) => f.tipo === 'trm').map((f) => ({ fecha: f.fecha, valor: f.valor }));
      $('#trm-grafico', cont).innerHTML = `<div id="trm-viz"></div>${trmPuntos.length ? `<div class="xs muted mt">Mín. ${fmt.tasa(Math.min(...trmPuntos.map((p) => p.valor)))} · máx. ${fmt.tasa(Math.max(...trmPuntos.map((p) => p.valor)))} · ${trmPuntos.length} días hábiles</div>` : ''}`;
      lineas($('#trm-viz', cont), { etiquetas: trmPuntos.map((p) => `${p.fecha.slice(8, 10)}/${p.fecha.slice(5, 7)}`), series: [{ nombre: 'TRM oficial', valores: trmPuntos.map((p) => p.valor) }], formato: fmt.tasa, minCero: false, tituloTip: (i) => fmt.fechaLarga(trmPuntos[i].fecha), aria: 'Evolución de la TRM' });
      $('#trm-tabla', cont).innerHTML = String(tabla([{ titulo: 'Fecha', valor: (f) => fmt.fecha(f.fecha) }, { titulo: 'Tipo', valor: (f) => ({ trm: 'TRM oficial', mercado: 'Mercado', manual: 'Manual' }[f.tipo]) }, { titulo: 'Valor', valor: (f) => fmt.tasa(f.valor), num: true }, { titulo: 'Vigencia', valor: (f) => (f.vigencia_hasta && f.vigencia_hasta !== f.fecha ? `hasta ${fmt.fecha(f.vigencia_hasta)}` : '') }, { titulo: 'Obtenido', valor: (f) => fmt.fechaHora(f.obtenido_en) }, { titulo: 'Fuente / nota', valor: (f) => (f.tipo === 'manual' ? `${f.usuario_nombre || ''}: ${f.nota || ''}` : (f.fuente || '').split('(')[0]) }], [...h.filas].reverse().slice(0, 120), { vacioTexto: 'Sin registros en el rango' }));
    } catch (e) { mostrarError(e); }
  };
  $$('[data-r]', cont).forEach((b) => b.addEventListener('click', () => { rango = b.dataset.r; sessionStorage.setItem('trm.rango', rango); $$('[data-r]', cont).forEach((x) => x.classList.toggle('activo', x === b)); cargarHistorial(); }));
  $('#trm-refrescar', cont).addEventListener('click', async () => { try { await api.post('/api/trm/actualizar'); toast('Consulta realizada', 'ok'); vistaTrm(cont); } catch (e) { mostrarError(e); } });
  const bm = $('#trm-manual', cont);
  if (bm) bm.addEventListener('click', () => modal({ titulo: 'Registrar tasa manual', cuerpo: `<p class="muted small">Úsala solo cuando la fuente oficial no tenga la fecha (o no haya conexión). Queda registrada con tu usuario, la fecha y el origen. No modifica operaciones ya confirmadas.</p><div class="grid2 mt"><div class="campo"><label>Fecha</label><input id="tm-fecha" type="date" value="${hoyISO()}" max="${hoyISO()}"></div><div class="campo"><label>Pesos por dólar</label><input id="tm-valor" type="number" step="0.01" min="100" inputmode="decimal"></div></div><div class="campo"><label>Origen o motivo *</label><input id="tm-nota" placeholder="Ej. certificado del banco, extracto, factura del proveedor"></div>`, acciones: [{ texto: 'Guardar', clase: 'primario', alHacerClic: async ({ modal: m }) => { await api.post('/api/trm/manual', { fecha: $('#tm-fecha', m).value, valor: $('#tm-valor', m).value, nota: $('#tm-nota', m).value }); toast('Tasa manual registrada', 'ok'); vistaTrm(cont); } }] }));
  cargarHistorial();
}

// ---------- Diferencias cambiarias ----------
async function diferencias(cont, query) {
  const f = filtrosDesde(query);
  cont.innerHTML = '';
  const cuerpo = document.createElement('div');
  await barraFiltros(cont, f, () => cargar());
  cont.appendChild(cuerpo);
  async function cargar() {
    cuerpo.innerHTML = String(cargando(3));
    try {
      const d = await api.get('/api/contabilidad/diferencias' + api.qs(paramsDe(f)));
      renderizar(cuerpo, html`<div class="kpis mb"><div class="kpi acento"><div class="et">Diferencia neta</div><div class="va">${fmt.signo(d.totales.neto)}</div><div class="de">${d.totales.operaciones} operación(es)</div></div><div class="kpi"><div class="et">Ganancia cambiaria</div><div class="va pos">${fmt.cop(d.totales.ganancia)}</div></div><div class="kpi"><div class="et">Pérdida cambiaria</div><div class="va neg">${fmt.cop(d.totales.perdida)}</div></div></div>
        <div class="alerta neutra small mb">Se reconoce al pagar a un proveedor o cobrar a un cliente en USD a una tasa distinta a la registrada en la compra o la venta. Positivo = se pagó con menos pesos o se cobró con más. No se mezcla con la ganancia comercial de los productos.</div>
        ${tabla([{ titulo: 'Fecha', valor: (x) => fmt.fechaHora(x.fecha) }, { titulo: 'Tipo', valor: (x) => (x.tipo === 'pago_compra' ? 'Pago a proveedor' : 'Abono de cliente') }, { titulo: 'Operación', valor: (x) => x.compra_numero || x.venta_numero || '' }, { titulo: 'Tercero', valor: (x) => x.proveedor || x.cliente || '' }, { titulo: 'USD', valor: (x) => fmt.usd(x.valor_moneda), num: true }, { titulo: 'Tasa operación', valor: (x) => fmt.tasa(x.tasa_operacion), num: true }, { titulo: 'Tasa pago', valor: (x) => fmt.tasa(x.tasa_pago), num: true }, { titulo: 'Diferencia', valor: (x) => fmt.signo(x.diferencia), num: true }, { titulo: 'Registró', clave: 'usuario_nombre' }], d.filas, { vacioTexto: 'Sin diferencias cambiarias en el periodo' })}
        <div class="row mt"><a class="btn suave chico" href="/api/reportes/diferencias_cambiarias${api.qs({ ...paramsDe(f), formato: 'csv' })}">${raw(icono('download', 14))} Excel</a><a class="btn suave chico" href="/api/reportes/diferencias_cambiarias${api.qs({ ...paramsDe(f), formato: 'pdf' })}" target="_blank">${raw(icono('file', 14))} PDF</a></div>`);
    } catch (e) { mostrarError(e); }
  }
  cargar();
}
