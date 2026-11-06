import { api } from '../../lib/api';
import { estado, navegar } from '../../lib/estado';
import { $, $$, html, raw, render as renderizar, fmt, icono, badge, TIPOS_CLIENTE, ESTADOS_CREDITO, ESTADOS_VENTA, TIPOS_PAGO, nombreMetodo, toast, modal, confirmar, mostrarError, debounce, vacio, cargando, esc } from '../ui.js';
import { nuevoCliente } from './ventas.js';
import { campanasAbiertas, selectCanal, selectCampana, nombreCanal } from './marketing.js';
import { filtroInicial, guardarFiltro, filtroPeriodo, panelClientes } from '../paneles.js';

const veMarketing = () => estado.tieneAlguno('marketing.ver', 'marketing.editar', 'marketing.leads');

export async function render(root, { partes, setTopbar }) {
  const [id] = partes;
  if (!id) return lista(root, setTopbar);
  return detalle(root, Number(id), setTopbar);
}

async function lista(root, setTopbar) {
  setTopbar({ titulo: 'Clientes', acciones: estado.tiene('clientes.editar') ? [{ icono: 'plus', titulo: 'Nuevo cliente', alHacerClic: () => nuevoCliente('', (c) => navegar(`#/clientes/${c.id}`)) }] : [] });
  const f = filtroInicial('clientes', '30d');
  let verResumen = sessionStorage.getItem('clientes.resumen') !== '0';
  renderizar(root, html`<div id="cl-filtros"></div>
    <div class="row between mb"><h2 style="margin:0">Comportamiento de la base de clientes</h2><button class="btn chico suave" id="cl-toggle">${verResumen ? 'Ocultar resumen' : 'Ver resumen'}</button></div>
    <div id="cl-panel" class="mb" ${verResumen ? '' : 'hidden'}></div>
    <h2 class="mb">Directorio</h2>
    <div class="buscador">${raw(icono('search'))}<input type="search" id="cl-q" placeholder="Nombre, teléfono, cédula o dirección"></div>
    <div class="pills mt">${[['', 'Todos'], ['mayorista', 'Mayoristas'], ['detal', 'Detal']].map(([v, t]) => html`<button class="pill ${v === '' ? 'activo' : ''}" data-tipo="${v}">${t}</button>`)}</div><div id="cl-resumen" class="muted small mt"></div><div id="cl-lista" class="lista mt"></div>`);
  const cargarPanel = () => { if (verResumen) panelClientes($('#cl-panel', root), f).catch((e) => { if (e.status !== 403) mostrarError(e); }); };
  filtroPeriodo($('#cl-filtros', root), f, () => { guardarFiltro('clientes', f); cargarPanel(); });
  $('#cl-toggle', root).addEventListener('click', () => { verResumen = !verResumen; sessionStorage.setItem('clientes.resumen', verResumen ? '1' : '0'); $('#cl-panel', root).hidden = !verResumen; $('#cl-toggle', root).textContent = verResumen ? 'Ocultar resumen' : 'Ver resumen'; if (verResumen && !$('#cl-panel', root).innerHTML.trim()) cargarPanel(); });
  cargarPanel();
  let tipo = '';
  let ultimaQ = '';
  const cargar = async (q = ultimaQ) => {
    ultimaQ = q;
    $('#cl-lista', root).innerHTML = String(cargando(3));
    try {
      const cs = await api.get('/api/clientes' + api.qs({ q, tipo }));
      $('#cl-resumen', root).textContent = `${cs.length} cliente(s) · por cobrar ${fmt.cop(cs.reduce((s, c) => s + c.saldo_pendiente, 0))}`;
      $('#cl-lista', root).innerHTML = cs.length ? cs.map((c) => `<a class="item" href="#/clientes/${c.id}"><div class="thumb ${c.tipo_cliente === 'mayorista' ? 'mayorista' : ''}">${icono(c.tipo_cliente === 'mayorista' ? 'store' : 'user', 20)}</div><div class="cuerpo"><div class="titulo">${esc(c.nombre)}${c.tipo_cliente === 'mayorista' ? ' <span class="badge mayor">Mayorista</span>' : ''}</div><div class="sub">${esc([c.telefono, c.barrio].filter(Boolean).join(' · '))} · ${c.n_ventas} compra(s)${c.ultima_compra ? ' · última ' + fmt.fecha(c.ultima_compra) : ''}</div></div><div class="fin">${c.saldo_pendiente > 0 ? `<div class="valor neg">${fmt.cop(c.saldo_pendiente)}</div><div class="xs muted">pendiente</div>` : '<span class="badge ok">Al día</span>'}</div></a>`).join('') : String(vacio('No hay clientes'));
    } catch (e) { mostrarError(e); }
  };
  $('#cl-q', root).addEventListener('input', debounce((e) => cargar(e.target.value.trim())));
  $$('[data-tipo]', root).forEach((b) => b.addEventListener('click', () => { tipo = b.dataset.tipo; $$('[data-tipo]', root).forEach((x) => x.classList.toggle('activo', x === b)); cargar(); }));
  cargar();
}

async function detalle(root, id, setTopbar) {
  let c;
  try { c = await api.get(`/api/clientes/${id}`); } catch (e) { mostrarError(e); return navegar('#/clientes', true); }
  const acciones = [];
  if (estado.tiene('clientes.editar')) acciones.push({ icono: 'edit', titulo: 'Editar', alHacerClic: () => editar(c, () => detalle(root, id, setTopbar)) });
  setTopbar({ titulo: c.nombre, atras: '#/clientes', acciones });
  renderizar(root, html`<div class="card">
      <div class="row wrap gap">${raw(badge(TIPOS_CLIENTE, c.tipo_cliente || 'detal'))}${c.tipo_cliente === 'mayorista' ? html`<span class="xs muted">Precio al por mayor en todas sus compras</span>` : ''}</div>
      <div class="muted small mt">${[c.telefono, c.identificacion, c.email, [c.direccion, c.barrio].filter(Boolean).join(', ')].filter(Boolean).join(' · ') || 'Sin datos de contacto'}</div>
      ${c.origen_canal || c.origen_campana_id || c.origen_lead_id ? html`<div class="row wrap gap small mt"><span class="muted">Llegó por:</span>${c.origen_canal ? html`<span class="badge neutro">${nombreCanal(c.origen_canal)}</span>` : ''}${c.origen_campana_nombre ? (estado.tieneAlguno('marketing.ver', 'marketing.editar') ? html`<a class="badge neutro" href="#/marketing/campanas/${c.origen_campana_id}">${raw(icono('megaphone', 12))} ${c.origen_campana_nombre}</a>` : html`<span class="badge neutro">${raw(icono('megaphone', 12))} ${c.origen_campana_nombre}</span>`) : ''}${c.origen_lead_id && veMarketing() ? html`<a class="xs" href="#/marketing/leads/${c.origen_lead_id}">ver consulta inicial${c.origen_lead_fecha ? ' (' + fmt.fecha(c.origen_lead_fecha) + ')' : ''}</a>` : ''}</div>` : ''}
      ${c.notas ? html`<p class="small mt">${c.notas}</p>` : ''}
      <div class="grid3 mt"><div><div class="muted xs">Saldo pendiente</div><div class="bold num ${c.saldo_pendiente ? 'neg' : ''}" style="font-size:18px">${fmt.cop(c.saldo_pendiente)}</div></div><div><div class="muted xs">Total comprado</div><div class="bold num" style="font-size:18px">${fmt.cop(c.total_comprado)}</div></div><div><div class="muted xs">Compras</div><div class="bold num" style="font-size:18px">${c.ventas.length}</div></div></div>
      <div class="row wrap mt gap">
        ${estado.tiene('ventas.crear') ? html`<a class="btn negro" href="#/vender">${raw(icono('cart'))} Vender</a>` : ''}
        ${c.telefono ? html`<a class="btn suave" href="https://wa.me/${c.telefono.replace(/\D/g, '').length === 10 ? '57' + c.telefono.replace(/\D/g, '') : c.telefono.replace(/\D/g, '')}" target="_blank">${raw(icono('whatsapp'))} WhatsApp</a>` : ''}
        ${estado.tiene('creditos.ver') ? html`<a class="btn suave" href="/api/clientes/${id}/estado-cuenta/pdf" target="_blank">${raw(icono('download'))} Estado de cuenta PDF</a><button class="btn suave" id="cl-ec-wa">${raw(icono('whatsapp'))} Enviar estado de cuenta</button>` : ''}
      </div></div>
    ${c.proximos_vencimientos.length ? html`<div class="card"><h2>Próximos vencimientos</h2><div class="col">${c.proximos_vencimientos.map((q) => html`<div class="row between small"><span>${fmt.fecha(q.fecha_vencimiento)} · ${q.numero}</span><b class="num">${fmt.cop(q.pendiente)}</b></div>`)}</div></div>` : ''}
    <div class="card"><h2>Créditos</h2>${c.creditos.length ? html`<div class="lista">${c.creditos.map((cr) => html`<a class="item" href="#/creditos/${cr.id}"><div class="cuerpo"><div class="titulo">${cr.numero} · ${fmt.fecha(cr.fecha)}</div><div class="sub">Financiado ${fmt.cop(cr.saldo_financiado)} · abonado ${fmt.cop(cr.total_abonado)}${cr.proximo_vencimiento ? ' · próx. ' + fmt.fecha(cr.proximo_vencimiento) : ''}</div></div><div class="fin"><div class="valor ${cr.saldo_actual ? 'neg' : ''}">${fmt.cop(cr.saldo_actual)}</div>${badge(ESTADOS_CREDITO, cr.estado)}</div></a>`)}</div>` : html`<p class="muted">Sin créditos.</p>`}</div>
    <div class="card"><h2>Abonos</h2>${c.abonos.length ? html`<div class="col">${c.abonos.map((a) => html`<div class="row between small"><span>${fmt.fechaHora(a.fecha)} · ${a.credito_numero} · ${nombreMetodo(a.metodo_pago)}${a.referencia ? ' · ' + a.referencia : ''}${a.comprobante_ruta ? raw(` · <a href="/api/archivos/${esc(a.comprobante_ruta)}" target="_blank">comprobante</a>`) : ''}</span><b class="num">${fmt.cop(a.valor)}</b></div>`)}</div>` : html`<p class="muted">Sin abonos.</p>`}</div>
    <div class="card"><h2>Historial de compras</h2>${c.ventas.length ? html`<div class="lista">${c.ventas.map((v) => html`<a class="item" href="#/ventas/${v.id}"><div class="cuerpo"><div class="titulo">${v.numero} · ${fmt.fechaHora(v.fecha)}</div><div class="sub">${v.resumen || ''}</div></div><div class="fin"><div class="valor">${fmt.cop(v.total)}</div><div class="xs">${v.estado === 'confirmada' ? TIPOS_PAGO[v.tipo_pago] : badge(ESTADOS_VENTA, v.estado)}</div></div></a>`)}</div>` : html`<p class="muted">Aún no ha comprado.</p>`}</div>
    ${estado.tiene('eliminar') ? html`<button class="btn peligro mt-l" id="cl-del">Desactivar cliente</button>` : ''}`);
  const wa = $('#cl-ec-wa', root);
  if (wa) wa.addEventListener('click', async () => { const s = await api.get(`/api/clientes/${id}/estado-cuenta/compartir`); window.open(s.whatsapp, '_blank'); });
  const del = $('#cl-del', root);
  if (del) del.addEventListener('click', async () => { if (await confirmar('¿Desactivar este cliente? Su historial se conserva.', { peligro: true, textoOk: 'Desactivar' })) { try { await api.del(`/api/clientes/${id}`); toast('Cliente desactivado'); navegar('#/clientes', true); } catch (e) { mostrarError(e); } } });
}

async function editar(c, alTerminar) {
  const marketing = veMarketing();
  let campanas = [];
  if (marketing) {
    campanas = await campanasAbiertas();
    // La campaña actual se conserva en la lista aunque ya esté finalizada.
    if (c.origen_campana_id && !campanas.some((x) => x.id === c.origen_campana_id)) campanas = [{ id: c.origen_campana_id, nombre: c.origen_campana_nombre || `Campaña ${c.origen_campana_id}`, plataforma: '' }, ...campanas];
  }
  modal({
    titulo: 'Editar cliente',
    cuerpo: `<div class="campo"><label>Nombre *</label><input id="ec-nombre" value="${esc(c.nombre)}"></div><div class="grid2"><div class="campo"><label>Teléfono</label><input id="ec-tel" type="tel" value="${esc(c.telefono || '')}"></div><div class="campo"><label>Identificación</label><input id="ec-id" value="${esc(c.identificacion || '')}"></div><div class="campo"><label>Correo</label><input id="ec-email" type="email" value="${esc(c.email || '')}"></div><div class="campo"><label>Dirección</label><input id="ec-dir" value="${esc(c.direccion || '')}"></div><div class="campo"><label>Barrio</label><input id="ec-barrio" value="${esc(c.barrio || '')}"></div><div class="campo"><label>Tipo de cliente</label><select id="ec-tipo"><option value="detal" ${c.tipo_cliente !== 'mayorista' ? 'selected' : ''}>Detal (consumidor)</option><option value="mayorista" ${c.tipo_cliente === 'mayorista' ? 'selected' : ''}>Mayorista (precio mayor siempre)</option></select></div>
      ${marketing ? `<div class="campo"><label>¿Cómo nos conoció?</label>${selectCanal('ec-canal', c.origen_canal || '')}</div><div class="campo"><label>Campaña de origen</label>${selectCampana('ec-camp', campanas, c.origen_campana_id || '')}</div>` : ''}</div><div class="campo"><label>Observaciones</label><textarea id="ec-notas">${esc(c.notas || '')}</textarea></div>`,
    acciones: [{ texto: 'Guardar', clase: 'primario', alHacerClic: async ({ modal: m }) => {
      const datos = { nombre: $('#ec-nombre', m).value, telefono: $('#ec-tel', m).value, identificacion: $('#ec-id', m).value, email: $('#ec-email', m).value, direccion: $('#ec-dir', m).value, barrio: $('#ec-barrio', m).value, tipo_cliente: $('#ec-tipo', m).value, notas: $('#ec-notas', m).value };
      if (marketing) { datos.origen_canal = $('#ec-canal', m).value || null; datos.origen_campana_id = $('#ec-camp', m).value ? Number($('#ec-camp', m).value) : null; }
      await api.put(`/api/clientes/${c.id}`, datos); toast('Cliente actualizado', 'ok'); alTerminar();
    } }],
  });
}
