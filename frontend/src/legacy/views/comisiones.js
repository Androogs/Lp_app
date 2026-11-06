// Rentabilidad y comisiones: panel del empleador (vendedor frente a empleador, salario, comisión, resultado del negocio),
// y ventas por responsable con reasignación auditada. El vendedor solo ve lo suyo. (Liquidaciones: fuera de la interfaz
// desde 2026-10-12 por pedido del cliente; la API y las liquidaciones ya cerradas se conservan.)
import { api } from '../../lib/api';
import { estado } from '../../lib/estado';
import { $, $$, fmt, icono, esc, badge, TIPOS_RESPONSABLE, TIPOS_PAGO, toast, modal, confirmar, pedirTexto, mostrarError, cargando, vacio, tabla, hoyISO, sumarDias } from '../ui.js';
import { barras } from '../charts.js';
import { PRESETS, filtroInicial, guardarFiltro, paramsFiltro, filtroPeriodo, textoPeriodo, kpi, panel, tablaViz, SERIE_INGRESO, SERIE_COSTO, SERIE_GANANCIA } from '../paneles.js';

const admin = () => estado.tiene('comisiones.administrar');
const veTodo = () => estado.tiene('comisiones.ver') || admin();

export async function render(root, { partes, setTopbar }) {
  setTopbar({ titulo: veTodo() ? 'Rentabilidad y comisiones' : 'Mis ventas y comisiones' });
  const tabs = [['panel', veTodo() ? 'Rentabilidad' : 'Resumen'], ['ventas', veTodo() ? 'Ventas por responsable' : 'Mis ventas']];
  let tab = tabs.some(([v]) => v === partes[0]) ? partes[0] : 'panel';
  const f = { ...filtroInicial('comisiones', 'mes'), vendedor_id: '', estado_pago: '' };
  root.innerHTML = `<div class="tabs">${tabs.map(([v, t]) => `<button class="${tab === v ? 'activo' : ''}" data-tab="${v}">${t}</button>`).join('')}</div><div id="cm-filtros"></div><div id="cm-cont"></div>`;
  const cont = $('#cm-cont', root);
  let usuarios = [];
  if (veTodo()) usuarios = await api.get('/api/usuarios').catch(() => []);
  const extra = veTodo() ? `<select id="cm-vend" style="width:auto;min-height:36px;padding:4px 10px"><option value="">Todos los responsables</option><option value="pendiente">Pendientes de asignación</option>${usuarios.filter((u) => u.activo !== 0).map((u) => `<option value="${u.id}">${esc(u.nombre)} (${esc((TIPOS_RESPONSABLE[u.tipo_comercial] || ['?'])[0])})</option>`).join('')}</select><select id="cm-pago" style="width:auto;min-height:36px;padding:4px 10px"><option value="">Cobradas y pendientes</option><option value="cobrada">Solo cobradas</option><option value="pendiente">Pendientes de cobro</option></select>` : '';
  const filtro = filtroPeriodo($('#cm-filtros', root), f, () => { guardarFiltro('comisiones', f); pintar(); }, { extra });
  const sv = $('#cm-vend', root); if (sv) sv.addEventListener('change', () => { f.vendedor_id = sv.value; pintar(); });
  const sp = $('#cm-pago', root); if (sp) sp.addEventListener('change', () => { f.estado_pago = sp.value; pintar(); });
  const pintar = () => { $$('[data-tab]', root).forEach((b) => b.classList.toggle('activo', b.dataset.tab === tab)); ({ panel: vistaPanel, ventas: vistaVentas })[tab](cont, f, filtro, usuarios); };
  $$('[data-tab]', root).forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; history.replaceState(null, '', `#/comisiones/${tab}`); pintar(); }));
  pintar();
}

async function cargarResumen(f) {
  return api.get('/api/comisiones/resumen' + api.qs({ ...paramsFiltro(f), vendedor_id: f.vendedor_id, estado_pago: f.estado_pago }));
}

// ---------- Panel ----------
async function vistaPanel(cont, f, filtro) {
  cont.innerHTML = String(cargando(5));
  let d;
  try { d = await cargarResumen(f); } catch (e) { cont.innerHTML = ''; return mostrarError(e); }
  filtro.setTexto(textoPeriodo(f, d.periodo));
  const v = d.vendedor, e = d.empleador, n = d.negocio;
  const est = n && n.estimado ? '<span class="estimado">estimado</span>' : '';
  // El salario es mensual: en periodos cortos se muestra el mes completo, nunca una fracción por días.
  const salarioTxt = d.salarios_en_resultado ? `${d.factor_salario} mes(es)` : 'mensual (no se reparte por días)';
  const trabajadores = d.responsables.filter((r) => r.tipo === 'vendedor');
  const salariosDistintos = [...new Set(trabajadores.map((r) => r.salario_base))];
  if (!veTodo()) {
    const yo = d.responsables[0] || { ventas: 0, ganancia: 0, comision: 0, salario_base: 0, salario_periodo: 0, total_remuneracion: 0, pendientes_cobro: 0, salario_estimado: true };
    cont.innerHTML = `<div class="kpis">
        ${kpi({ icono: 'cart', titulo: 'Mis ventas', valor: fmt.num(yo.ventas), descripcion: `${fmt.cop(yo.ingreso_neto || 0)} facturado neto`, clase: 'acento' })}
        ${kpi({ icono: 'trend_up', titulo: 'Ganancia que generé', valor: fmt.cop(yo.ganancia), descripcion: `${yo.pendientes_cobro} venta(s) pendiente(s) de cobro` })}
        ${kpi({ icono: 'dollar', titulo: 'Mi comisión estimada', valor: fmt.cop(yo.comision), descripcion: `${yo.comision_pct} % de la ganancia comisionable (${fmt.cop(yo.ganancia_comisionable || 0)})` })}
        ${kpi({ icono: 'calendar', titulo: 'Salario base', valor: fmt.cop(yo.salario_base), descripcion: d.salarios_en_resultado && d.factor_salario > 1 ? `al mes · ${d.factor_salario} meses: ${fmt.cop(yo.salario_periodo)}` : 'al mes' })}
        ${kpi({ icono: 'check', titulo: 'Remuneración estimada', valor: fmt.cop(yo.total_remuneracion), descripcion: d.salarios_en_resultado ? 'salario + comisión del periodo' : 'salario del mes + comisión del periodo', clase: '' })}
      </div>
      ${d.avisos.length ? `<div class="alerta neutra small mt">${d.avisos.map(esc).join(' · ')}</div>` : ''}
      <div class="card mt"><h2>Mis últimas ventas</h2>${tablaVentas(d.ventas.slice(0, 20), false)}</div>`;
    return;
  }
  cont.innerHTML = `<div class="kpis">
      ${kpi({ icono: 'cart', titulo: 'Ventas del vendedor', valor: fmt.cop(v.ingreso_neto), descripcion: `${v.ventas} venta(s) · ${v.pendientes_cobro} pendiente(s) de cobro`, clase: 'acento' })}
      ${kpi({ icono: 'trend_up', titulo: 'Ganancia del vendedor', valor: fmt.cop(v.ganancia), descripcion: `comisionable ${fmt.cop(v.ganancia_comisionable)}` })}
      ${kpi({ icono: 'dollar', titulo: 'Comisión del vendedor', valor: fmt.cop(v.comision), descripcion: `${d.devengo === 'cobro' ? 'devengo al cobro' : 'devengo al confirmar'}` })}
      ${kpi({ icono: 'calendar', titulo: 'Salario base por trabajador', valor: salariosDistintos.length === 1 ? fmt.cop(salariosDistintos[0]) : 'Varía', descripcion: `al mes · ${trabajadores.length} trabajador(es)${d.salarios_en_resultado ? ` · ${salarioTxt}: ${fmt.cop(v.salario_periodo)}` : ''}` })}
      ${kpi({ icono: 'users', titulo: 'Remuneración vendedores', valor: fmt.cop(v.total_remuneracion), descripcion: d.salarios_en_resultado ? 'salarios + comisiones del periodo' : 'salarios del mes + comisiones del periodo' })}
      ${kpi({ icono: 'user', titulo: 'Ventas del empleador', valor: fmt.cop(e.ingreso_neto), descripcion: `${e.ventas} venta(s) · sin comisión` })}
      ${kpi({ icono: 'trend_up', titulo: 'Ganancia del empleador', valor: fmt.cop(e.ganancia), descripcion: 'ganancia operativa de sus ventas' })}
      ${kpi({ icono: 'chart', titulo: 'Ganancia total del negocio', valor: fmt.cop(n.ganancia_total), descripcion: `antes de salarios y comisiones${d.sin_asignar ? ` · ${d.sin_asignar.ventas} sin responsable` : ''}` })}
      ${kpi({ icono: 'cash', titulo: 'Gastos generales', valor: fmt.cop(n.gastos_generales), descripcion: 'no asignados a ventas', href: '#/caja/gastos' })}
      ${kpi({ icono: 'check', titulo: 'Resultado estimado', valor: fmt.cop(n.resultado), descripcion: d.salarios_en_resultado ? `ganancia − salarios ${fmt.cop(n.salarios)} − comisiones ${fmt.cop(n.comisiones)} − gastos` : `ganancia − comisiones ${fmt.cop(n.comisiones)} − gastos (sin salarios: periodo menor a un mes)`, alerta: n.resultado < 0 })}
    </div>
    ${d.avisos.length ? `<div class="alerta neutra small mt">${est} ${d.avisos.map(esc).join(' · ')}</div>` : ''}
    <div class="grid-viz mt-l">
      ${panel({ id: 'cm-g1', titulo: 'Vendedor frente a empleador', sub: 'Ingreso neto, ganancia operativa y comisión por responsable', clase: 'span-3' })}
      <section class="panel span-3"><div class="panel-cab"><div><h2>Por responsable</h2><div class="panel-sub">Lo que vende cada uno y lo que cuesta</div></div></div>
        <div class="tabla-wrap"><table class="tabla compacta"><thead><tr><th>Responsable</th><th class="n">Ventas</th><th class="n">Ganancia</th><th class="n">%</th><th class="n">Comisión</th><th class="n">${d.salarios_en_resultado ? 'Salario' : 'Salario (mes)'}</th><th class="n">Total</th></tr></thead><tbody>
        ${d.responsables.map((r) => `<tr><td class="celda-resp"><div class="bold">${esc(r.nombre)}</div>${String(badge(TIPOS_RESPONSABLE, r.tipo === 'sin_asignar' ? 'otro' : r.tipo))}</td><td class="n">${r.ventas}</td><td class="n ${r.ganancia < 0 ? 'neg' : ''}">${fmt.cop(r.ganancia)}</td><td class="n">${r.comision_pct || 0} %</td><td class="n">${fmt.cop(r.comision)}</td><td class="n">${r.tipo === 'vendedor' ? fmt.cop(r.salario_periodo) : '—'}</td><td class="n bold">${r.tipo === 'vendedor' ? fmt.cop(r.total_remuneracion) : '—'}</td></tr>`).join('')}</tbody></table></div>
      </section>
    </div>
    <details class="mas mt"><summary>Cómo se calcula</summary><p class="small muted">${esc(d.criterios)}</p></details>`;
  const resp = d.responsables.filter((r) => r.ventas > 0);
  barras($('#cm-g1', cont), { etiquetas: resp.map((r) => r.nombre.split(' ')[0]), series: [{ nombre: 'Ingreso neto', valores: resp.map((r) => r.ingreso_neto), color: SERIE_COSTO }, { nombre: 'Ganancia operativa', valores: resp.map((r) => r.ganancia), color: SERIE_INGRESO }, { nombre: 'Comisión', valores: resp.map((r) => r.comision), color: SERIE_GANANCIA }], tituloTip: (i) => resp[i].nombre });
}

function tablaVentas(ventas, conAcciones) {
  if (!ventas.length) return String(vacio('Sin ventas en el periodo'));
  return `<div class="tabla-wrap"><table class="tabla compacta"><thead><tr><th>Venta</th><th>Responsable</th><th>Cliente / productos</th><th>Pago</th><th class="n">Ingreso neto</th><th class="n">Costo</th><th class="n">Ganancia</th><th class="n">Comisión</th>${conAcciones ? '<th></th>' : ''}</tr></thead><tbody>
    ${ventas.map((v) => `<tr><td><a href="#/ventas/${v.id}">${esc(v.numero)}</a><div class="xs muted">${esc(fmt.fechaHora(v.fecha))}</div></td>
      <td>${v.pendiente_asignacion ? '<span class="badge peligro">Pendiente de asignación</span>' : `${esc(v.responsable || '')} ${String(badge(TIPOS_RESPONSABLE, v.responsable_tipo || 'otro'))}`}${v.registrado_por_nombre && v.registrado_por_nombre !== v.responsable ? `<div class="xs muted">registró ${esc(v.registrado_por_nombre)}</div>` : ''}</td>
      <td style="white-space:normal;max-width:260px">${esc(v.cliente || 'Consumidor final')}<div class="xs muted truncate" style="max-width:260px">${esc(v.resumen || '')}${v.domicilio_id ? ` · domicilio${v.cargo_domicilio ? ' (envío ' + fmt.cop(v.cargo_domicilio) + ')' : ''}` : ''}</div></td>
      <td>${v.estado_pago === 'cobrada' ? '<span class="badge ok">Cobrada</span>' : '<span class="badge aviso">Pendiente</span>'}${v.estado !== 'confirmada' ? `<div class="xs muted">${esc(v.estado)}</div>` : ''}</td>
      <td class="n">${fmt.cop(v.ingreso_neto)}</td><td class="n">${fmt.cop(v.costo_neto + v.costos_directos)}</td><td class="n ${v.ganancia_operativa < 0 ? 'neg' : ''}">${fmt.cop(v.ganancia_operativa)}</td>
      <td class="n">${v.comisiona ? (v.devengada ? fmt.cop(v.comision) : '<span class="muted" title="No devengada aún">—</span>') : '<span class="muted">0</span>'}</td>
      ${conAcciones ? `<td><button class="btn chico suave" data-reasignar="${v.id}">Reasignar</button></td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}

// ---------- Ventas por responsable ----------
async function vistaVentas(cont, f, filtro, usuarios) {
  cont.innerHTML = String(cargando(5));
  let d;
  try { d = await cargarResumen(f); } catch (e) { cont.innerHTML = ''; return mostrarError(e); }
  filtro.setTexto(textoPeriodo(f, d.periodo));
  cont.innerHTML = `<div class="row between wrap mb"><span class="muted small">${d.ventas.length} venta(s)${d.sin_asignar ? ` · <b class="neg">${d.sin_asignar.ventas} sin responsable</b>` : ''}</span></div>${tablaVentas(d.ventas, admin())}`;
  $$('[data-reasignar]', cont).forEach((b) => b.addEventListener('click', () => {
    const v = d.ventas.find((x) => x.id === Number(b.dataset.reasignar));
    modal({ titulo: `Responsable de ${v.numero}`, cuerpo: `<div class="campo"><label>Responsable comercial</label><select id="rs-u"><option value="pendiente">Pendiente de asignación</option>${usuarios.filter((u) => u.activo !== 0).map((u) => `<option value="${u.id}" ${u.id === v.vendedor_id ? 'selected' : ''}>${esc(u.nombre)} (${esc((TIPOS_RESPONSABLE[u.tipo_comercial] || ['?'])[0])})</option>`).join('')}</select></div><div class="campo"><label>Motivo *</label><input id="rs-m" placeholder="Queda en auditoría"></div>`, acciones: [{ texto: 'Guardar', clase: 'primario', alHacerClic: async ({ modal: m }) => { const r = await api.post(`/api/comisiones/ventas/${v.id}/responsable`, { vendedor_id: $('#rs-u', m).value, motivo: $('#rs-m', m).value }); toast(r.ajustes && r.ajustes.length ? 'Responsable cambiado · ajuste de liquidación registrado' : 'Responsable cambiado', 'ok'); vistaVentas(cont, f, filtro, usuarios); } }] });
  }));
}

// ---------- Liquidaciones ----------
// Sin uso en la interfaz desde 2026-10-12 (el cliente pidió quitar el apartado). Se conserva para reactivarlo si lo piden:
// basta con volver a agregar ['liquidaciones', 'Liquidaciones'] a `tabs` y la vista al despachador de `pintar`.
// eslint-disable-next-line no-unused-vars
async function vistaLiquidaciones(cont, f, filtro, usuarios) {
  cont.innerHTML = String(cargando(3));
  let lista;
  try { lista = await api.get('/api/comisiones/liquidaciones'); } catch (e) { cont.innerHTML = ''; return mostrarError(e); }
  cont.innerHTML = `<div class="row between wrap mb"><div><h2 style="margin:0">Liquidaciones</h2><div class="muted xs">Cerradas no se modifican: las correcciones posteriores quedan como ajustes.</div></div>${admin() ? `<button class="btn primario chico" id="lq-nueva">${icono('plus', 16)} Cerrar periodo</button>` : ''}</div>
    ${lista.length ? `<div class="lista">${lista.map((l) => `<a class="item" href="#" data-lq="${l.id}"><div class="cuerpo"><div class="titulo">${esc(l.numero)} · ${esc(l.vendedor)}</div><div class="sub">${esc(fmt.fecha(l.desde))} – ${esc(fmt.fecha(l.hasta))} · ${l.ventas_n} venta(s) · salario ${fmt.cop(l.salario)} + comisión ${fmt.cop(l.comision)}${l.ajustes_previos ? ' + ajustes ' + fmt.cop(l.ajustes_previos) : ''}${l.ajustes_posteriores ? ` · <span class="neg">ajustes posteriores ${fmt.cop(l.ajustes_posteriores)}</span>` : ''}</div></div><div class="fin"><div class="valor">${fmt.cop(l.total)}</div>${l.estado === 'anulada' ? '<span class="badge peligro">Anulada</span>' : '<span class="badge ok">Cerrada</span>'}</div></a>`).join('')}</div>` : String(vacio('Aún no hay liquidaciones cerradas'))}`;
  $$('[data-lq]', cont).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); verLiquidacion(Number(a.dataset.lq), () => vistaLiquidaciones(cont, f, filtro, usuarios)); }));
  const bn = $('#lq-nueva', cont);
  if (bn) bn.addEventListener('click', () => {
    const vendedores = usuarios.filter((u) => u.activo !== 0 && u.tipo_comercial === 'vendedor');
    const h = hoyISO();
    modal({ titulo: 'Cerrar liquidación', cuerpo: `<div class="campo"><label>Vendedor</label><select id="lq-v">${vendedores.map((u) => `<option value="${u.id}">${esc(u.nombre)}${u.salario_mensual == null ? ' (sin salario registrado)' : ''}</option>`).join('')}</select></div><div class="grid2"><div class="campo"><label>Desde</label><input type="date" id="lq-d" value="${h.slice(0, 8)}01"></div><div class="campo"><label>Hasta</label><input type="date" id="lq-h" value="${h}" max="${h}"></div></div><button type="button" class="btn suave chico" id="lq-prev">Ver resumen</button><div id="lq-previa" class="mt"></div><div class="campo mt"><label>Notas</label><input id="lq-n"></div>`, acciones: [{ texto: 'Cerrar liquidación', clase: 'primario', alHacerClic: async ({ modal: m }) => { const r = await api.post('/api/comisiones/liquidaciones', { vendedor_id: $('#lq-v', m).value, desde: $('#lq-d', m).value, hasta: $('#lq-h', m).value, notas: $('#lq-n', m).value }); toast(`Liquidación ${r.numero} cerrada`, 'ok'); if (r.aviso_pendientes_asignar) toast(`${r.aviso_pendientes_asignar} venta(s) del periodo siguen sin responsable`, 'error'); vistaLiquidaciones(cont, f, filtro, usuarios); } }], alMontar: (m) => $('#lq-prev', m).addEventListener('click', async () => {
      const p = $('#lq-previa', m); p.innerHTML = String(cargando(2));
      try { const r = await api.get('/api/comisiones/previa' + api.qs({ vendedor_id: $('#lq-v', m).value, desde: $('#lq-d', m).value, hasta: $('#lq-h', m).value })); const x = r.responsables.find((y) => y.vendedor_id === Number($('#lq-v', m).value)) || r.responsables[0]; p.innerHTML = x ? `<dl class="kv"><dt>Ventas</dt><dd>${x.ventas}</dd><dt>Ganancia comisionable</dt><dd>${fmt.cop(x.ganancia_comisionable)}</dd><dt>Comisión (${x.comision_pct} %)</dt><dd>${fmt.cop(x.comision)}</dd><dt>Salario del periodo</dt><dd>${fmt.cop(x.salario_periodo)}${x.salario_estimado ? ' <span class="estimado">sin registrar</span>' : ''}</dd><dt class="bold">Total</dt><dd class="total">${fmt.cop(x.total_remuneracion)}</dd></dl>${r.avisos.length ? `<p class="xs muted mt">${r.avisos.map(esc).join(' · ')}</p>` : ''}` : 'Sin datos.'; } catch (e) { p.innerHTML = `<div class="alerta peligro small">${esc(e.message)}</div>`; }
    }) });
  });
}

async function verLiquidacion(id, alCambiar) {
  let l;
  try { l = await api.get(`/api/comisiones/liquidaciones/${id}`); } catch (e) { return mostrarError(e); }
  modal({ titulo: `${l.numero} · ${l.vendedor}`, ancho: true, cuerpo: `<div class="row between wrap"><span class="muted small">${esc(fmt.fecha(l.desde))} – ${esc(fmt.fecha(l.hasta))} · cerrada ${esc(fmt.fechaHora(l.cerrada_en))} por ${esc(l.cerrada_por_nombre || '')}</span>${l.estado === 'anulada' ? `<span class="badge peligro">Anulada: ${esc(l.anulacion_motivo || '')}</span>` : '<span class="badge ok">Cerrada</span>'}</div>
    <div class="kpis mt"><div class="kpi"><div class="et">Salario</div><div class="va chico">${fmt.cop(l.salario)}</div></div><div class="kpi"><div class="et">Comisión ${l.comision_pct} %</div><div class="va chico">${fmt.cop(l.comision)}</div><div class="de">sobre ${fmt.cop(l.ganancia_comisionable)}</div></div><div class="kpi"><div class="et">Ajustes previos</div><div class="va chico ${l.ajustes_previos < 0 ? 'neg' : ''}">${fmt.cop(l.ajustes_previos)}</div></div><div class="kpi acento"><div class="et">Total</div><div class="va chico">${fmt.cop(l.total)}</div></div></div>
    ${l.ajustes_posteriores ? `<div class="alerta aviso small mt">Ajustes posteriores por ${fmt.cop(l.ajustes_posteriores)} (se aplican en la siguiente liquidación): ${l.ajustes_recibidos.map((a) => `${esc(a.venta_numero || '')} ${fmt.cop(a.valor)}${a.aplicado_en_numero ? ' → ' + esc(a.aplicado_en_numero) : ''}`).join(' · ')}</div>` : ''}
    ${l.ajustes_aplicados.length ? `<div class="muted xs mt">Incluye ajustes de: ${l.ajustes_aplicados.map((a) => `${esc(a.origen_numero)} ${fmt.cop(a.valor)}`).join(' · ')}</div>` : ''}
    <div class="mt">${String(tabla([{ titulo: 'Venta', clave: 'numero' }, { titulo: 'Fecha', valor: (x) => fmt.fecha(x.fecha) }, { titulo: 'Cliente', valor: (x) => x.cliente || 'Consumidor final' }, { titulo: 'Ganancia', clave: 'ganancia', dinero: true }, { titulo: 'Comisión', clave: 'comision', dinero: true }, { titulo: 'Vigente', clave: 'comision_actual', dinero: true }], l.ventas, { vacioTexto: 'Sin ventas en el periodo' }))}</div>
    <div class="row wrap gap mt"><a class="btn chico suave" href="/api/comisiones/liquidaciones/${l.id}?formato=csv">${icono('download', 14)} Excel</a><a class="btn chico suave" href="/api/comisiones/liquidaciones/${l.id}?formato=pdf" target="_blank">${icono('file', 14)} PDF</a>${admin() && l.estado === 'cerrada' ? `<button class="btn chico peligro" id="lq-anular">Anular</button>` : ''}</div>
    ${l.notas ? `<p class="muted small mt">${esc(l.notas)}</p>` : ''}`, alMontar: (m, cerrar) => { const b = $('#lq-anular', m); if (b) b.addEventListener('click', async () => { const mot = await pedirTexto('Anular liquidación', { etiqueta: 'Motivo', textoOk: 'Anular' }); if (!mot) return; try { await api.post(`/api/comisiones/liquidaciones/${l.id}/anular`, { motivo: mot }); toast('Liquidación anulada'); cerrar(); alCambiar(); } catch (e) { mostrarError(e); } }); } });
}
