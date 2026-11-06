import { api } from '../../lib/api';
import { estado, navegar } from '../../lib/estado';
import { $, $$, html, raw, render as renderizar, fmt, icono, nombreMetodo, toast, modal, confirmar, mostrarError, debounce, vacio, cargando, esc, tabla } from '../ui.js';
import { pagarCompra } from './compras.js';
import { filtroInicial, guardarFiltro, filtroPeriodo, panelCompras } from '../paneles.js';

export async function render(root, { partes, setTopbar }) {
  const [id] = partes;
  if (!id) return lista(root, setTopbar);
  return detalle(root, Number(id), setTopbar);
}

function formulario(p, alTerminar) {
  modal({
    titulo: p ? 'Editar proveedor' : 'Nuevo proveedor',
    cuerpo: `<div class="campo"><label>Nombre o razón social *</label><input id="fp-nombre" value="${esc(p?.nombre || '')}"></div><div class="grid2"><div class="campo"><label>NIT / identificación</label><input id="fp-id" value="${esc(p?.identificacion || '')}"></div><div class="campo"><label>Teléfono</label><input id="fp-tel" type="tel" value="${esc(p?.telefono || '')}"></div><div class="campo"><label>Correo</label><input id="fp-email" type="email" value="${esc(p?.email || '')}"></div><div class="campo"><label>Contacto</label><input id="fp-contacto" value="${esc(p?.contacto || '')}"></div></div><div class="campo"><label>Dirección</label><input id="fp-dir" value="${esc(p?.direccion || '')}"></div><div class="campo"><label>Observaciones</label><textarea id="fp-notas">${esc(p?.notas || '')}</textarea></div>`,
    acciones: [{ texto: 'Guardar', clase: 'primario', alHacerClic: async ({ modal: m }) => { const d = { nombre: $('#fp-nombre', m).value, identificacion: $('#fp-id', m).value, telefono: $('#fp-tel', m).value, email: $('#fp-email', m).value, contacto: $('#fp-contacto', m).value, direccion: $('#fp-dir', m).value, notas: $('#fp-notas', m).value }; const r = p ? await api.put(`/api/proveedores/${p.id}`, d) : await api.post('/api/proveedores', d); toast('Proveedor guardado', 'ok'); alTerminar(r); } }],
  });
}

async function lista(root, setTopbar) {
  setTopbar({ titulo: 'Proveedores', acciones: estado.tiene('proveedores.editar') ? [{ icono: 'plus', titulo: 'Nuevo proveedor', alHacerClic: () => formulario(null, (p) => navegar(`#/proveedores/${p.id}`)) }] : [] });
  const f = filtroInicial('compras', '30d');
  let verResumen = sessionStorage.getItem('proveedores.resumen') !== '0';
  renderizar(root, html`<div id="pv-filtros"></div>
    <div class="row between mb"><h2 style="margin:0">Compras y abastecimiento</h2><button class="btn chico suave" id="pv-toggle">${verResumen ? 'Ocultar resumen' : 'Ver resumen'}</button></div>
    <div id="pv-panel" class="mb" ${verResumen ? '' : 'hidden'}></div>
    <h2 class="mb">Directorio</h2>
    <div class="buscador">${raw(icono('search'))}<input type="search" id="pv-q" placeholder="Nombre, NIT o teléfono"></div><div id="pv-resumen" class="muted small mt"></div><div id="pv-lista" class="lista mt"></div>`);
  const cargarPanel = () => { if (verResumen) panelCompras($('#pv-panel', root), f).catch((e) => { if (e.status !== 403) mostrarError(e); }); };
  filtroPeriodo($('#pv-filtros', root), f, () => { guardarFiltro('compras', f); cargarPanel(); });
  $('#pv-toggle', root).addEventListener('click', () => { verResumen = !verResumen; sessionStorage.setItem('proveedores.resumen', verResumen ? '1' : '0'); $('#pv-panel', root).hidden = !verResumen; $('#pv-toggle', root).textContent = verResumen ? 'Ocultar resumen' : 'Ver resumen'; if (verResumen && !$('#pv-panel', root).innerHTML.trim()) cargarPanel(); });
  cargarPanel();
  const cargar = async (q = '') => {
    $('#pv-lista', root).innerHTML = String(cargando(3));
    try {
      const ps = await api.get('/api/proveedores' + api.qs({ q }));
      $('#pv-resumen', root).textContent = `${ps.length} proveedor(es) · por pagar ${fmt.cop(ps.reduce((s, p) => s + p.saldo_pendiente, 0))}`;
      $('#pv-lista', root).innerHTML = ps.length ? ps.map((p) => `<a class="item" href="#/proveedores/${p.id}"><div class="thumb">${icono('bag', 20)}</div><div class="cuerpo"><div class="titulo">${esc(p.nombre)}</div><div class="sub">${esc([p.telefono, p.contacto].filter(Boolean).join(' · '))} · ${p.n_compras} compra(s)${p.ultima_compra ? ' · última ' + fmt.fecha(p.ultima_compra) : ''}</div></div><div class="fin">${p.saldo_pendiente > 0 ? `<div class="valor neg">${fmt.cop(p.saldo_pendiente)}</div><div class="xs muted">por pagar</div>` : '<span class="badge ok">Al día</span>'}</div></a>`).join('') : String(vacio('No hay proveedores'));
    } catch (e) { mostrarError(e); }
  };
  $('#pv-q', root).addEventListener('input', debounce((e) => cargar(e.target.value.trim())));
  cargar();
}

async function detalle(root, id, setTopbar) {
  let p;
  try { p = await api.get(`/api/proveedores/${id}`); } catch (e) { mostrarError(e); return navegar('#/proveedores', true); }
  const acciones = [];
  if (estado.tiene('proveedores.editar')) acciones.push({ icono: 'edit', titulo: 'Editar', alHacerClic: () => formulario(p, () => detalle(root, id, setTopbar)) });
  setTopbar({ titulo: p.nombre, atras: '#/proveedores', acciones });
  const pendientes = p.compras.filter((c) => c.estado === 'confirmada' && c.saldo_pendiente > 0);
  renderizar(root, html`<div class="card">
      <div class="muted small">${[p.identificacion && 'NIT ' + p.identificacion, p.telefono, p.contacto && 'Contacto: ' + p.contacto, p.email, p.direccion].filter(Boolean).join(' · ') || 'Sin datos de contacto'}</div>
      ${p.notas ? html`<p class="small mt">${p.notas}</p>` : ''}
      <div class="grid3 mt"><div><div class="muted xs">Saldo por pagar</div><div class="bold num ${p.saldo_pendiente ? 'neg' : ''}" style="font-size:18px">${fmt.cop(p.saldo_pendiente)}</div></div><div><div class="muted xs">Total comprado</div><div class="bold num" style="font-size:18px">${fmt.cop(p.total_comprado)}</div></div><div><div class="muted xs">Compras</div><div class="bold num" style="font-size:18px">${p.compras.length}</div></div></div>
      <div class="row wrap mt gap">${estado.tiene('compras.crear') ? html`<a class="btn negro" href="#/compras/nueva">${raw(icono('truck'))} Nueva compra</a>` : ''}${p.telefono ? html`<a class="btn suave" href="https://wa.me/${p.telefono.replace(/\D/g, '').length === 10 ? '57' + p.telefono.replace(/\D/g, '') : p.telefono.replace(/\D/g, '')}" target="_blank">${raw(icono('whatsapp'))} WhatsApp</a>` : ''}</div></div>
    ${pendientes.length ? html`<div class="card"><h2>Facturas pendientes de pago</h2><div class="lista">${pendientes.map((c) => html`<div class="item"><div class="cuerpo"><div class="titulo">${c.numero}${c.numero_factura ? ' · Fact. ' + c.numero_factura : ''}</div><div class="sub">${fmt.fecha(c.fecha)}${c.fecha_vencimiento ? ' · vence ' + fmt.fecha(c.fecha_vencimiento) : ''} · total ${fmt.cop(c.total)}</div></div><div class="fin"><div class="valor neg">${fmt.cop(c.saldo_pendiente)}</div>${estado.tiene('compras.pagar') ? html`<button class="btn chico primario" data-pagar="${c.id}">Pagar</button>` : ''}</div></div>`)}</div></div>` : ''}
    <div class="card"><h2>Productos suministrados y precios</h2>${p.productos.length ? tabla([{ titulo: 'Producto', valor: (x) => x.nombre + (x.referencia ? ` (${x.referencia})` : '') }, { titulo: 'Último costo', clave: 'ultimo_costo', dinero: true }, { titulo: 'Mín.', clave: 'costo_min', dinero: true }, { titulo: 'Máx.', clave: 'costo_max', dinero: true }, { titulo: 'Unidades', clave: 'unidades', num: true }, { titulo: 'Última compra', valor: (x) => fmt.fecha(x.ultima_fecha) }], p.productos) : html`<p class="muted">Sin compras registradas.</p>`}</div>
    <div class="card"><h2>Compras por mes</h2>${p.por_periodo.length ? html`<div class="col">${p.por_periodo.map((m) => html`<div class="row between small"><span>${m.mes} · ${m.n} compra(s)</span><b class="num">${fmt.cop(m.total)}</b></div>`)}</div>` : html`<p class="muted">Sin compras.</p>`}</div>
    <div class="card"><h2>Historial de compras</h2>${p.compras.length ? html`<div class="lista">${p.compras.map((c) => html`<a class="item" href="#/compras/${c.id}"><div class="cuerpo"><div class="titulo">${c.numero} · ${fmt.fecha(c.fecha)}</div><div class="sub">${c.numero_factura ? 'Fact. ' + c.numero_factura + ' · ' : ''}${c.n_items} ítem(s)</div></div><div class="fin"><div class="valor">${fmt.cop(c.total)}</div>${c.estado === 'anulada' ? html`<span class="badge peligro">Anulada</span>` : c.saldo_pendiente ? html`<span class="badge aviso">debe ${fmt.cop(c.saldo_pendiente)}</span>` : html`<span class="badge ok">Pagada</span>`}</div></a>`)}</div>` : html`<p class="muted">Sin compras.</p>`}</div>
    <div class="card"><h2>Pagos realizados</h2>${p.pagos.length ? html`<div class="col">${p.pagos.map((pg) => html`<div class="row between small"><span>${fmt.fechaHora(pg.fecha)} · ${pg.compra_numero || ''} · ${nombreMetodo(pg.metodo_pago)}${pg.referencia ? ' · ' + pg.referencia : ''}</span><b class="num">${fmt.cop(pg.valor)}</b></div>`)}</div>` : html`<p class="muted">Sin pagos.</p>`}</div>
    ${p.documentos.length ? html`<div class="card"><h2>Facturas adjuntas</h2><div class="col">${p.documentos.map((d) => html`<a class="small" href="/api/archivos/${d.ruta}" target="_blank">${raw(icono('file', 16))} ${d.nombre || 'documento'} · ${d.compra_numero}</a>`)}</div></div>` : ''}
    ${estado.tiene('eliminar') ? html`<button class="btn peligro mt-l" id="pv-del">Desactivar proveedor</button>` : ''}`);
  $$('[data-pagar]', root).forEach((b) => b.addEventListener('click', () => { const c = p.compras.find((x) => x.id === Number(b.dataset.pagar)); pagarCompra({ ...c, proveedor_nombre: p.nombre }, () => detalle(root, id, setTopbar)); }));
  const del = $('#pv-del', root);
  if (del) del.addEventListener('click', async () => { if (await confirmar('¿Desactivar este proveedor?', { peligro: true, textoOk: 'Desactivar' })) { await api.del(`/api/proveedores/${id}`); navegar('#/proveedores', true); } });
}
