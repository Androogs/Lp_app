// Piezas compartidas de los paneles analíticos: fila de filtros de periodo, tarjetas KPI con comparación frente al
// periodo anterior, contenedores de panel, vista de tabla de cada gráfica y los paneles que se incrustan en los
// módulos (ventas, inventario, clientes, compras). Todos consumen /api/analitica/* con datos reales del sistema.
import { api } from '../lib/api';
import { $, $$, fmt, icono, esc, hoyISO, sumarDias, nombreMetodo, TIPOS_PAGO } from './ui.js';
import { lineas, barras, barrasH, anillo, color } from './charts.js';

export const PRESETS = [['hoy', 'Hoy'], ['7d', '7 días'], ['30d', '30 días'], ['mes', 'Este mes'], ['anio', 'Este año'], ['rango', 'Rango']];
export const NOMBRE_PERIODO = { hoy: 'Hoy', '7d': 'Últimos 7 días', '30d': 'Últimos 30 días', semana: 'Esta semana', mes: 'Este mes', anio: 'Este año', rango: 'Rango', todo: 'Todo el historial' };
export const NOMBRE_GRAN = { hora: 'hora', dia: 'día', semana: 'semana', mes: 'mes' };
export const SERIE_INGRESO = 'var(--viz-1)', SERIE_COSTO = 'var(--viz-3)', SERIE_GANANCIA = 'var(--viz-2)';

// ---------- Filtros de periodo (persisten por pantalla durante la sesión) ----------
export function filtroInicial(clave, defecto = 'mes') {
  try { const g = JSON.parse(sessionStorage.getItem('filtro.' + clave)); if (g && g.periodo) return { periodo: g.periodo, desde: g.desde || sumarDias(hoyISO(), -30), hasta: g.hasta || hoyISO() }; } catch { /* sin estado guardado */ }
  return { periodo: defecto, desde: sumarDias(hoyISO(), -30), hasta: hoyISO() };
}
export function guardarFiltro(clave, f) { try { sessionStorage.setItem('filtro.' + clave, JSON.stringify({ periodo: f.periodo, desde: f.desde, hasta: f.hasta })); } catch { /* sin almacenamiento */ } }
export function paramsFiltro(f) { return f.periodo === 'rango' ? { desde: f.desde, hasta: f.hasta } : { periodo: f.periodo }; }
export function textoPeriodo(f, p) {
  if (!p) return '';
  if (f.periodo === 'hoy') return `Hoy · ${fmt.fecha(p.hasta)}`;
  return `${NOMBRE_PERIODO[f.periodo] || ''} · ${fmt.fecha(p.desde)} – ${fmt.fecha(p.hasta)}`;
}
export function filtroPeriodo(cont, f, alCambiar, { presets = PRESETS, extra = '' } = {}) {
  cont.classList.add('filtros');
  cont.innerHTML = `<div class="pills">${presets.map(([v, t]) => `<button type="button" class="pill ${f.periodo === v ? 'activo' : ''}" data-p="${v}">${esc(t)}</button>`).join('')}</div>
    <div class="rango" ${f.periodo === 'rango' ? '' : 'hidden'}><input type="date" data-desde value="${esc(f.desde || '')}" aria-label="Desde"><span class="muted xs">a</span><input type="date" data-hasta value="${esc(f.hasta || '')}" aria-label="Hasta"><button type="button" class="btn chico primario" data-ok>Ver</button></div>${extra}<span class="periodo-txt" data-txt></span>`;
  $$('[data-p]', cont).forEach((b) => b.addEventListener('click', () => {
    f.periodo = b.dataset.p;
    $$('[data-p]', cont).forEach((x) => x.classList.toggle('activo', x === b));
    $('.rango', cont).hidden = f.periodo !== 'rango';
    if (f.periodo !== 'rango') alCambiar(f);
  }));
  $('[data-ok]', cont).addEventListener('click', () => { f.desde = $('[data-desde]', cont).value; f.hasta = $('[data-hasta]', cont).value; if (f.desde && f.hasta && f.desde <= f.hasta) alCambiar(f); });
  return { setTexto: (t) => { const el = $('[data-txt]', cont); if (el) el.textContent = t; } };
}

// ---------- Tarjetas KPI ----------
// variacion: { pct, diferencia } calculada en el servidor; null cuando no hay datos del periodo anterior.
export function delta(v, vs = 'periodo anterior', { invertir = false } = {}) {
  if (!v) return '';
  if (v.pct === null || v.pct === undefined) {
    if (v.diferencia) return `<span class="delta ${(v.diferencia > 0) !== invertir ? 'sube' : 'baja'}" title="El periodo anterior no tiene datos; no se puede calcular el porcentaje">${v.diferencia > 0 ? '▲' : '▼'} sin datos previos</span>`;
    return `<span class="delta" title="Sin datos suficientes para comparar">— sin comparación</span>`;
  }
  const igual = v.pct === 0; const sube = v.pct > 0; const bueno = igual ? null : sube !== invertir;
  return `<span class="delta ${igual ? '' : bueno ? 'sube' : 'baja'}" title="Comparado con ${esc(vs)}">${igual ? '•' : sube ? '▲' : '▼'} ${Math.abs(v.pct).toLocaleString('es-CO', { maximumFractionDigits: 1 })} % <span class="muted">vs ${esc(vs)}</span></span>`;
}
export function kpi({ icono: ico = 'chart', titulo, valor, descripcion = '', variacion = null, vs = 'periodo anterior', invertir = false, href = null, clase = '', spark = '', alerta = false }) {
  const d = variacion ? delta(variacion, vs, { invertir }) : '';
  const inner = `<div class="cab"><span class="et" title="${esc(titulo)}">${esc(titulo)}</span><span class="ico">${icono(ico)}</span></div><div class="va" title="${esc(valor)}">${esc(valor)}</div>${descripcion ? `<div class="de" title="${esc(descripcion)}">${esc(descripcion)}</div>` : ''}${d || spark ? `<div class="pie-kpi">${d || '<span></span>'}${spark || ''}</div>` : ''}`;
  const cls = `kpi ${clase} ${alerta ? 'alerta-kpi' : ''}`.trim();
  return href ? `<a class="${cls}" href="${esc(href)}">${inner}</a>` : `<div class="${cls}">${inner}</div>`;
}

// ---------- Paneles ----------
export function panel({ id, titulo, sub = '', acciones = '', clase = '', pie = '' }) {
  return `<section class="panel ${clase}"><div class="panel-cab"><div><h2>${esc(titulo)}</h2>${sub ? `<div class="panel-sub">${esc(sub)}</div>` : ''}</div>${acciones ? `<div class="panel-acciones">${acciones}</div>` : ''}</div><div id="${esc(id)}"></div>${pie ? `<div class="panel-pie" id="${esc(id)}-pie">${pie}</div>` : ''}</section>`;
}
export function seg(opciones, activo, attr) { return `<div class="seg">${opciones.map(([v, t]) => `<button type="button" data-${attr}="${v}" class="${v === activo ? 'activo' : ''}">${esc(t)}</button>`).join('')}</div>`; }
export function activarSeg(cont, attr, alCambiar) {
  $$(`[data-${attr}]`, cont).forEach((b) => b.addEventListener('click', () => { $$(`[data-${attr}]`, cont).forEach((x) => x.classList.toggle('activo', x === b)); alCambiar(b.dataset[attr]); }));
}
// Vista de tabla de una gráfica (los tooltips nunca son la única forma de leer un valor).
export function tablaViz(columnas, filas, { limite = 60 } = {}) {
  if (!filas.length) return '';
  const celda = (c, f) => { const v = typeof c.valor === 'function' ? c.valor(f) : f[c.clave]; return c.dinero ? fmt.cop(v) : c.num ? fmt.num(v) : (v ?? ''); };
  return `<details class="viz-tabla"><summary>Ver como tabla (${filas.length})</summary><div style="overflow-x:auto"><table><thead><tr>${columnas.map((c) => `<th class="${c.dinero || c.num ? 'n' : ''}">${esc(c.titulo)}</th>`).join('')}</tr></thead><tbody>${filas.slice(0, limite).map((f) => `<tr>${columnas.map((c) => `<td class="${c.dinero || c.num ? 'n' : ''}">${esc(celda(c, f))}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
}
export function tituloPunto(p, g) {
  if (g === 'dia') return fmt.fechaLarga(p.clave);
  if (g === 'semana') return `Semana del ${fmt.fecha(p.clave)}`;
  if (g === 'hora') return `${p.etiqueta} – ${String(Number(p.clave) + 1).padStart(2, '0')}:00`;
  return p.etiqueta;
}
export function alertaItem({ clase = '', texto, n, href = '#' }) {
  return `<a class="alerta-item ${clase}" href="${esc(href)}"><span class="pt"></span><span class="txt">${esc(texto)}</span>${n !== undefined && n !== null ? `<span class="n">${esc(n)}</span>` : ''}${icono('chevron', 16)}</a>`;
}
export function ranking(items, { valor, sub = null, href = null, vacio = 'Sin datos' } = {}) {
  if (!items.length) return `<p class="muted small">${esc(vacio)}</p>`;
  return `<div class="ranking">${items.map((it, i) => { const inner = `<span class="pos-n">${i + 1}</span><span class="grow truncate">${esc(it.nombre || it.etiqueta)}${sub ? `<span class="muted xs"> · ${esc(sub(it))}</span>` : ''}</span><b class="num nowrap">${esc(valor(it))}</b>`; return href ? `<a href="${esc(href(it))}">${inner}</a>` : `<div>${inner}</div>`; }).join('')}</div>`;
}
const cargandoPanel = (cont) => { cont.style.opacity = '0.55'; if (!cont.innerHTML.trim()) cont.innerHTML = '<div class="cargando">Cargando resumen…</div>'; };
const listoPanel = (cont) => { cont.style.opacity = ''; };

// ---------- Panel del módulo de ventas ----------
export async function panelVentas(cont, f) {
  cargandoPanel(cont);
  let d;
  try { d = await api.get('/api/analitica/ventas' + api.qs(paramsFiltro(f))); } catch (e) { cont.innerHTML = ''; listoPanel(cont); throw e; }
  const r = d.resumen; const veCostos = r.ganancia_bruta !== null && r.ganancia_bruta !== undefined;
  const g = d.granularidad; const puntos = d.serie.puntos;
  cont.innerHTML = `
    <div class="kpis">
      ${kpi({ icono: 'cart', titulo: 'Total vendido', valor: fmt.cop(r.total), descripcion: `${r.cantidad} venta(s)${r.devoluciones ? ' · devoluciones ' + fmt.cop(r.devoluciones) : ''}`, variacion: r.variacion_total, clase: 'acento' })}
      ${kpi({ icono: 'list', titulo: 'Número de ventas', valor: fmt.num(r.cantidad), descripcion: `${fmt.num(r.unidades)} unidades vendidas`, variacion: r.variacion_cantidad })}
      ${kpi({ icono: 'tag', titulo: 'Valor promedio por venta', valor: fmt.cop(r.promedio), descripcion: 'ventas netas ÷ número de ventas', variacion: r.variacion_promedio })}
      ${veCostos ? kpi({ icono: 'trend_up', titulo: 'Ganancia bruta', valor: fmt.cop(r.ganancia_bruta), descripcion: `margen ${fmt.pct(r.margen_pct)} · costo por lote`, variacion: r.variacion_ganancia }) : kpi({ icono: 'cash', titulo: 'Dinero recibido', valor: fmt.cop(r.recibido), descripcion: r.credito_otorgado ? `a crédito ${fmt.cop(r.credito_otorgado)}` : 'pagos de ventas y abonos' })}
    </div>
    <div class="grid-viz mt">
      ${panel({ id: 'pv-evolucion', titulo: 'Evolución de ventas', sub: `Ventas netas por ${NOMBRE_GRAN[g]} · ${textoPeriodo(f, d.periodo)}`, clase: 'span-4', pie: tablaViz([{ titulo: 'Periodo', clave: 'etiqueta' }, { titulo: 'Ventas', clave: 'n', num: true }, { titulo: 'Facturado', clave: 'ventas', dinero: true }, { titulo: 'Devoluciones', clave: 'devoluciones', dinero: true }, { titulo: 'Netas', clave: 'netas', dinero: true }], puntos) })}
      ${panel({ id: 'pv-metodos', titulo: 'Métodos de pago', sub: 'Dinero recibido: pagos de ventas y abonos', clase: 'span-2', pie: d.metodos_pago.credito_otorgado ? `A crédito (pendiente de cobro): <b>${fmt.cop(d.metodos_pago.credito_otorgado)}</b> en ${d.metodos_pago.creditos} venta(s)` : 'Sin ventas a crédito en el periodo' })}
      ${panel({ id: 'pv-top', titulo: 'Productos más vendidos', sub: 'Unidades vendidas (netas de devoluciones)', clase: 'span-3' })}
      ${panel({ id: 'pv-vendedor', titulo: 'Ventas por vendedor', sub: 'Total facturado por quien registró la venta', clase: 'span-3', pie: `<div class="row wrap gap">${d.por_tipo_pago.map((t) => `<span class="badge neutro">${esc(TIPOS_PAGO[t.tipo_pago] || t.tipo_pago)}: ${t.n} · ${fmt.cop(t.total)}</span>`).join('') || 'Sin ventas en el periodo'}</div>` })}
    </div>`;
  listoPanel(cont);
  lineas($('#pv-evolucion', cont), { etiquetas: puntos.map((p) => p.etiqueta), series: [{ nombre: 'Ventas netas', valores: puntos.map((p) => p.netas) }], tituloTip: (i) => tituloPunto(puntos[i], g), aria: 'Evolución de ventas' });
  barrasH($('#pv-metodos', cont), { items: d.metodos_pago.items.map((m) => ({ etiqueta: nombreMetodo(m.metodo), valor: m.total, nombreValor: 'Recibido', sub: `${m.pct.toLocaleString('es-CO')} % del total · ${m.pagos_venta} pago(s) de venta, ${m.abonos} abono(s)` })), formato: fmt.cop, vacio: 'Sin pagos en el periodo' });
  barrasH($('#pv-top', cont), { items: d.mas_vendidos.map((p) => ({ etiqueta: p.nombre, valor: p.unidades, nombreValor: 'Unidades', sub: `${fmt.cop(p.total)} vendidos${p.ganancia !== undefined ? ' · ganancia ' + fmt.cop(p.ganancia) : ''}`, href: `#/inventario/${p.id}` })), formato: (v) => `${fmt.num(v)} und`, vacio: 'Sin ventas en el periodo' });
  barrasH($('#pv-vendedor', cont), { items: d.por_vendedor.map((v) => ({ etiqueta: v.vendedor, valor: v.total, nombreValor: 'Vendido', sub: `${v.n} venta(s)` })), formato: fmt.cop, vacio: 'Sin ventas en el periodo' });
  return d;
}

// ---------- Panel del módulo de inventario ----------
export async function panelInventario(cont, { dias = 30 } = {}) {
  cargandoPanel(cont);
  let d;
  try { d = await api.get('/api/analitica/inventario' + api.qs({ dias })); } catch (e) { cont.innerHTML = ''; listoPanel(cont); throw e; }
  const r = d.resumen; const veCostos = r.valor_costo !== null;
  let vista = 'categoria';
  cont.innerHTML = `
    <div class="kpis">
      ${kpi({ icono: 'box', titulo: 'Unidades disponibles', valor: `${fmt.num(r.unidades)} und`, descripcion: `${fmt.num(r.licores)} de licores · ${fmt.num(r.complementos)} de complementos · ${r.productos} productos`, clase: 'acento' })}
      ${veCostos ? kpi({ icono: 'dollar', titulo: 'Valor del inventario al costo', valor: fmt.cop(r.valor_costo), descripcion: 'costo real de los lotes disponibles' }) : ''}
      ${kpi({ icono: 'tag', titulo: 'Valor potencial de venta', valor: fmt.cop(r.valor_venta), descripcion: veCostos ? `ganancia potencial ${fmt.cop(r.ganancia_potencial)}` : 'a precio de venta actual' })}
      ${kpi({ icono: 'alert', titulo: 'Pocas unidades', valor: fmt.num(r.pocas), descripcion: 'en o bajo el stock mínimo', href: '#/inventario?filtro=stock_bajo', alerta: r.pocas > 0 })}
      ${kpi({ icono: 'x', titulo: 'Agotados', valor: fmt.num(r.agotados), descripcion: 'sin unidades disponibles', href: '#/inventario?filtro=agotados', alerta: r.agotados > 0 })}
    </div>
    <div class="grid-viz mt">
      ${panel({ id: 'pi-dist', titulo: 'Distribución del inventario', sub: 'Unidades disponibles por grupo', acciones: seg([['categoria', 'Categoría'], ['marca', 'Marca'], ['estado', 'Estado']], vista, 'dist'), clase: 'span-3', pie: '<span data-dist-pie></span>' })}
      ${panel({ id: 'pi-repo', titulo: 'Alertas de reposición', sub: 'Productos en o bajo el mínimo, con su último proveedor y costo', clase: 'span-3' })}
      ${panel({ id: 'pi-alta', titulo: 'Mayor rotación', sub: `Unidades vendidas en los últimos ${d.rotacion.dias} días`, clase: 'span-3' })}
      ${panel({ id: 'pi-baja', titulo: 'Menor rotación', sub: `Con stock y sin ventas en ${d.rotacion.dias}+ días`, clase: 'span-3' })}
    </div>`;
  listoPanel(cont);
  const pintarDist = () => {
    const lista = d.distribucion[vista] || [];
    const porProductos = vista === 'estado';
    anillo($('#pi-dist', cont), { items: lista.map((x) => ({ etiqueta: x.etiqueta, valor: porProductos ? x.productos : x.unidades })), formato: fmt.num, sufijo: porProductos ? ' prod.' : ' und', centro: { valor: fmt.num(lista.reduce((s, x) => s + (porProductos ? x.productos : x.unidades), 0)), etiqueta: porProductos ? 'productos' : 'unidades' }, vacio: 'Sin unidades en inventario' });
    const pie = $('[data-dist-pie]', cont);
    if (pie) pie.innerHTML = porProductos ? 'Conteo de productos según su nivel de stock.' : tablaViz([{ titulo: vista === 'marca' ? 'Marca' : 'Categoría', clave: 'etiqueta' }, { titulo: 'Unidades', clave: 'unidades', num: true }, { titulo: 'Productos', clave: 'productos', num: true }, ...(veCostos ? [{ titulo: 'Valor al costo', clave: 'valor_costo', dinero: true }] : []), { titulo: 'Valor venta', clave: 'valor_venta', dinero: true }], lista);
  };
  pintarDist();
  activarSeg(cont, 'dist', (v) => { vista = v; pintarDist(); });
  $('#pi-repo', cont).innerHTML = d.reposicion.length ? `<div class="alertas-lista">${d.reposicion.slice(0, 10).map((p) => alertaItem({ clase: p.stock <= 0 ? 'peligro' : 'aviso', texto: `${p.nombre} · stock ${p.stock} / mín. ${p.stock_minimo}${p.proveedor ? ' · ' + p.proveedor : ''}${p.ultimo_costo && veCostos ? ' · ' + fmt.cop(p.ultimo_costo) : ''}`, n: p.stock <= 0 ? 'Agotado' : 'Bajo', href: `#/inventario/${p.id}` })).join('')}${d.reposicion.length > 10 ? `<a class="small" href="#/inventario?filtro=stock_bajo">Ver los ${d.reposicion.length} productos</a>` : ''}</div>` : '<p class="muted small">Todos los productos están por encima de su stock mínimo.</p>';
  barrasH($('#pi-alta', cont), { items: d.rotacion.alta.map((p) => ({ etiqueta: p.nombre, valor: p.unidades, nombreValor: 'Unidades', sub: `${p.ventas} venta(s) · stock ${p.stock}`, href: `#/inventario/${p.id}` })), formato: (v) => `${fmt.num(v)} und`, vacio: `Sin ventas en los últimos ${d.rotacion.dias} días` });
  $('#pi-baja', cont).innerHTML = ranking(d.rotacion.baja, { valor: (p) => `${p.stock} und`, sub: (p) => (p.ultima_venta ? 'última venta ' + fmt.fecha(p.ultima_venta) : 'nunca vendido'), href: (p) => `#/inventario/${p.id}`, vacio: 'Todo el inventario rota.' });
  return d;
}

// ---------- Panel del módulo de clientes ----------
export async function panelClientes(cont, f) {
  cargandoPanel(cont);
  let d;
  try { d = await api.get('/api/analitica/clientes' + api.qs(paramsFiltro(f))); } catch (e) { cont.innerHTML = ''; listoPanel(cont); throw e; }
  const r = d.resumen; const g = d.granularidad; const vc = d.ventas_con_cliente;
  cont.innerHTML = `
    <div class="kpis">
      ${kpi({ icono: 'users', titulo: 'Clientes registrados', valor: fmt.num(r.total), descripcion: `${fmt.num(r.con_compras)} con compras · ${fmt.num(r.con_credito)} con crédito vigente`, clase: 'acento' })}
      ${kpi({ icono: 'plus', titulo: 'Nuevos en el periodo', valor: fmt.num(r.nuevos), descripcion: 'registrados en el periodo', variacion: r.variacion_nuevos })}
      ${kpi({ icono: 'undo', titulo: 'Clientes recurrentes', valor: fmt.num(r.recurrentes_periodo), descripcion: `compraron en el periodo y ya habían comprado antes · ${fmt.num(r.recurrentes)} con 2+ compras en total` })}
      ${kpi({ icono: 'cart', titulo: 'Compradores del periodo', valor: fmt.num(r.compradores_periodo), descripcion: `${vc.con_cliente} venta(s) con cliente · ${vc.sin_cliente} a consumidor final` })}
    </div>
    <div class="grid-viz mt">
      ${panel({ id: 'pc-top', titulo: 'Clientes con mayores compras', sub: 'Total facturado en el periodo', clase: 'span-3' })}
      ${panel({ id: 'pc-reg', titulo: 'Evolución de registros', sub: `Clientes nuevos por ${NOMBRE_GRAN[g]}`, clase: 'span-3', pie: tablaViz([{ titulo: 'Periodo', clave: 'etiqueta' }, { titulo: 'Nuevos', clave: 'nuevos', num: true }], d.registros.puntos) })}
      ${panel({ id: 'pc-acum', titulo: 'Crecimiento de la base de clientes', sub: 'Clientes registrados acumulados, últimos 12 meses', clase: 'span-6', pie: tablaViz([{ titulo: 'Mes', clave: 'etiqueta' }, { titulo: 'Clientes', clave: 'total', num: true }], d.acumulado) })}
    </div>`;
  listoPanel(cont);
  barrasH($('#pc-top', cont), { items: d.top.map((c) => ({ etiqueta: c.nombre, valor: c.total, nombreValor: 'Comprado', sub: `${c.ventas} compra(s) · última ${fmt.fecha(c.ultima)}`, href: `#/clientes/${c.id}` })), formato: fmt.cop, vacio: 'Sin ventas con cliente en el periodo' });
  barras($('#pc-reg', cont), { etiquetas: d.registros.puntos.map((p) => p.etiqueta), series: [{ nombre: 'Clientes nuevos', valores: d.registros.puntos.map((p) => p.nuevos) }], formato: fmt.num, tituloTip: (i) => tituloPunto(d.registros.puntos[i], g), aria: 'Clientes nuevos' });
  lineas($('#pc-acum', cont), { etiquetas: d.acumulado.map((p) => p.etiqueta), series: [{ nombre: 'Clientes registrados', valores: d.acumulado.map((p) => p.total) }], formato: fmt.num, alto: 180, aria: 'Clientes acumulados' });
  return d;
}

// ---------- Panel de proveedores y compras ----------
export async function panelCompras(cont, f) {
  cargandoPanel(cont);
  let d;
  try { d = await api.get('/api/analitica/compras' + api.qs(paramsFiltro(f))); } catch (e) { cont.innerHTML = ''; listoPanel(cont); throw e; }
  const r = d.resumen; const g = d.granularidad; const puntos = d.serie.puntos;
  cont.innerHTML = `
    <div class="kpis">
      ${kpi({ icono: 'truck', titulo: 'Compras del periodo', valor: fmt.cop(r.total), descripcion: `${r.cantidad} compra(s) · ${fmt.num(r.unidades)} unidades`, variacion: r.variacion_total, clase: 'acento' })}
      ${kpi({ icono: 'bag', titulo: 'Proveedores con compras', valor: fmt.num(r.proveedores_activos), descripcion: 'en el periodo seleccionado' })}
      ${kpi({ icono: 'cash', titulo: 'Pagado del periodo', valor: fmt.cop(r.pagado), descripcion: r.saldo ? `saldo de estas compras ${fmt.cop(r.saldo)}` : 'estas compras están al día' })}
      ${kpi({ icono: 'alert', titulo: 'Por pagar a proveedores', valor: fmt.cop(r.por_pagar), descripcion: `${r.facturas_pendientes} factura(s) · ${r.facturas_vencidas} vencida(s)`, href: '#/compras?con_saldo=1', alerta: r.facturas_vencidas > 0 })}
    </div>
    <div class="grid-viz mt">
      ${panel({ id: 'pp-prov', titulo: 'Compras por proveedor', sub: 'Total comprado en el periodo', clase: 'span-3', pie: tablaViz([{ titulo: 'Proveedor', clave: 'proveedor' }, { titulo: 'Compras', clave: 'compras', num: true }, { titulo: 'Total', clave: 'total', dinero: true }, { titulo: 'Pagado', clave: 'pagado', dinero: true }, { titulo: 'Saldo', clave: 'saldo', dinero: true }], d.por_proveedor) })}
      ${panel({ id: 'pp-serie', titulo: 'Valor de las compras por periodo', sub: `Compras confirmadas por ${NOMBRE_GRAN[g]}`, clase: 'span-3', pie: tablaViz([{ titulo: 'Periodo', clave: 'etiqueta' }, { titulo: 'Compras', clave: 'n', num: true }, { titulo: 'Total', clave: 'compras', dinero: true }], puntos) })}
      ${panel({ id: 'pp-dist', titulo: 'Distribución del abastecimiento', sub: 'Participación de cada proveedor en las compras del periodo', clase: 'span-3' })}
      ${panel({ id: 'pp-repo', titulo: 'Productos que requieren reposición', sub: 'En o bajo el stock mínimo, con último proveedor y costo', clase: 'span-3' })}
    </div>`;
  listoPanel(cont);
  barrasH($('#pp-prov', cont), { items: d.por_proveedor.map((p) => ({ etiqueta: p.proveedor, valor: p.total, nombreValor: 'Comprado', sub: `${p.compras} compra(s) · pagado ${fmt.cop(p.pagado)}${p.saldo ? ' · saldo ' + fmt.cop(p.saldo) : ''}`, href: p.id ? `#/proveedores/${p.id}` : null })), formato: fmt.cop, vacio: 'Sin compras en el periodo' });
  barras($('#pp-serie', cont), { etiquetas: puntos.map((p) => p.etiqueta), series: [{ nombre: 'Compras', valores: puntos.map((p) => p.compras) }], tituloTip: (i) => tituloPunto(puntos[i], g), aria: 'Compras por periodo' });
  anillo($('#pp-dist', cont), { items: d.por_proveedor.map((p) => ({ etiqueta: p.proveedor, valor: p.total })), formato: fmt.cop, centro: { valor: fmt.cop(r.total), etiqueta: 'comprado' }, vacio: 'Sin compras en el periodo' });
  $('#pp-repo', cont).innerHTML = d.reposicion.length ? `<div class="alertas-lista">${d.reposicion.slice(0, 10).map((p) => alertaItem({ clase: p.stock <= 0 ? 'peligro' : 'aviso', texto: `${p.nombre} · stock ${p.stock} / mín. ${p.stock_minimo}${p.proveedor ? ' · ' + p.proveedor : ''}${p.ultimo_costo ? ' · último costo ' + fmt.cop(p.ultimo_costo) : ''}`, n: p.stock <= 0 ? 'Agotado' : 'Bajo', href: `#/compras/nueva?producto=${p.id}` })).join('')}</div>` : '<p class="muted small">No hay productos por reponer.</p>';
  return d;
}

// Series estándar para "ingresos frente a ganancias" a partir de los puntos de una serie (dia/semana/mes/hora).
export function seriesIngresosGanancia(puntos, veCostos) {
  if (veCostos) return [{ nombre: 'Ingresos (ventas netas)', valores: puntos.map((p) => p.netas), color: SERIE_INGRESO }, { nombre: 'Costo de lo vendido', valores: puntos.map((p) => p.costo), color: SERIE_COSTO }, { nombre: 'Ganancia bruta', valores: puntos.map((p) => p.ganancia_bruta), color: SERIE_GANANCIA }];
  return [{ nombre: 'Ventas netas', valores: puntos.map((p) => p.netas), color: SERIE_INGRESO }, { nombre: 'Dinero recibido', valores: puntos.map((p) => p.recibido), color: SERIE_GANANCIA }];
}
export { color };
