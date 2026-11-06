// Domicilios de Licores Palmira: pedidos por WhatsApp, teléfono o la web que se entregan con la flota propia.
// Tablero por estado (recibido → en preparación → en camino → entregado), toma de pedidos con la misma tarifa del punto de
// venta (detal o mayor), ficha con línea de tiempo y acciones, y administración de repartidores.
import { api } from '../../lib/api';
import { estado, navegar } from '../../lib/estado';
import { $, $$, html, raw, render as renderizar, fmt, icono, badge, toast, modal, confirmar, pedirTexto, mostrarError, debounce, activarDinero, leerDinero, vacio, cargando, esc, selectorBusqueda, miniatura, tarifaBadge, nombreMetodo, ESTADOS_DOMICILIO, CANALES_DOMICILIO, TIPOS_CLIENTE } from '../ui.js';

const COLUMNAS = [
  ['recibido', 'Recibidos', 'inbox'],
  ['en_preparacion', 'En preparación', 'box'],
  ['en_camino', 'En camino', 'moto'],
  ['entregado', 'Entregados hoy', 'check'],
];
const SIGUIENTE = { recibido: ['preparar', 'Preparar'], en_preparacion: ['despachar', 'Despachar'], en_camino: ['entregar', 'Entregar'] };
const hora = (t) => (t ? String(t).slice(11, 16) : '');
const minutosTexto = (m) => (m === null || m === undefined ? '' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);
const soloDigitos = (t) => String(t || '').replace(/\D/g, '');
const telWa = (t) => { const d = soloDigitos(t); return d.length === 10 ? '57' + d : d; };

export async function render(root, { partes, query, setTopbar }) {
  const [id] = partes;
  if (!id) return tablero(root, query, setTopbar);
  if (id === 'nuevo') return formulario(root, null, setTopbar);
  if (id === 'repartidores') return repartidores(root, setTopbar);
  if (partes[1] === 'editar') return formulario(root, Number(id), setTopbar);
  return ficha(root, Number(id), setTopbar);
}

// ---------- Tablero ----------
async function tablero(root, query, setTopbar) {
  const puedeCrear = estado.tiene('domicilios.crear');
  setTopbar({ titulo: 'Domicilios', acciones: [
    ...(estado.tiene('domicilios.despachar') ? [{ icono: 'users', titulo: 'Repartidores', href: '#/domicilios/repartidores' }] : []),
    ...(puedeCrear ? [{ icono: 'plus', texto: 'Nuevo', titulo: 'Nuevo domicilio', clase: 'primario', href: '#/domicilios/nuevo' }] : []),
  ] });
  let vista = query.vista === 'historial' ? 'historial' : 'tablero';
  renderizar(root, html`<div id="dm-kpis"></div>
    <div class="tabs mt"><button data-vista="tablero" class="${vista === 'tablero' ? 'activo' : ''}">Tablero de hoy</button><button data-vista="historial" class="${vista === 'historial' ? 'activo' : ''}">Historial</button></div>
    <div id="dm-cuerpo"></div>`);

  const pintarKpis = (r) => {
    $('#dm-kpis', root).innerHTML = `<div class="dm-franja">
      <div class="dm-dato ${r.por_despachar ? 'activo' : ''}"><span>${icono('inbox', 18)} Por despachar</span><b>${fmt.num(r.por_despachar)}</b></div>
      <div class="dm-dato"><span>${icono('moto', 18)} En camino</span><b>${fmt.num(r.en_camino)}</b></div>
      <div class="dm-dato ${r.atrasados.length ? 'alerta-dato' : ''}"><span>${icono('clock', 18)} Atrasados</span><b>${fmt.num(r.atrasados.length)}</b></div>
      <div class="dm-dato"><span>${icono('check', 18)} Entregados hoy</span><b>${fmt.num(r.hoy.entregados)}</b><small>${r.hoy.minutos_promedio ? `${minutosTexto(r.hoy.minutos_promedio)} en promedio` : 'sin entregas aún'}</small></div>
      <div class="dm-dato"><span>${icono('cash', 18)} Vendido a domicilio hoy</span><b>${fmt.cop(r.hoy.total)}</b><small>envíos ${fmt.cop(r.hoy.envios)}</small></div>
    </div>`;
  };

  const tarjeta = (d) => {
    const sig = SIGUIENTE[d.estado];
    const puede = sig && estado.tiene('domicilios.despachar');
    return `<article class="dm-card ${d.atrasado ? 'atrasado' : ''}" data-id="${d.id}" tabindex="0" role="button" aria-label="Domicilio ${esc(d.numero)} de ${esc(d.cliente_nombre)}">
      <header><b class="mono">${esc(d.numero)}</b><span class="dm-tiempo ${d.atrasado ? 'tarde' : ''}">${d.estado === 'entregado' ? `entregado ${hora(d.entregado_en)}` : `${icono('clock', 13)} ${minutosTexto(d.minutos)}`}</span></header>
      <div class="dm-cliente">${esc(d.cliente_nombre)}${d.tipo_cliente === 'mayorista' ? ' <span class="badge mayor">Mayorista</span>' : ''}</div>
      <div class="dm-dir">${icono('pin', 14)} ${esc([d.barrio, d.direccion].filter(Boolean).join(' · '))}</div>
      <div class="dm-items">${esc(d.resumen || '')}</div>
      <footer><span class="dm-total num">${fmt.cop(d.total)}</span><span class="dm-pago">${esc(nombreMetodo(d.metodo_pago))}${d.cambio ? ` · cambio ${fmt.cop(d.cambio)}` : ''}</span></footer>
      ${d.repartidor_nombre ? `<div class="dm-rep">${icono('moto', 14)} ${esc(d.repartidor_nombre)}${d.repartidor_placa ? ` · ${esc(d.repartidor_placa)}` : ''}</div>` : ''}
      ${d.hora_compromiso && d.estado !== 'entregado' ? `<div class="dm-rep">${icono('calendar', 14)} Entregar a las ${esc(d.hora_compromiso)}</div>` : ''}
      ${puede ? `<button type="button" class="btn chico ${d.estado === 'en_camino' ? 'primario' : 'suave'} dm-accion" data-accion="${sig[0]}" data-id="${d.id}">${sig[1]}</button>` : ''}
    </article>`;
  };

  const cargarTablero = async () => {
    const cuerpo = $('#dm-cuerpo', root);
    try {
      const hoy = new Date(); const iso = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-${String(hoy.getDate()).padStart(2, '0')}`;
      const [r, abiertos, entregados] = await Promise.all([api.get('/api/domicilios/resumen'), api.get('/api/domicilios?estado=abiertos'), api.get(`/api/domicilios?estado=entregado&desde=${iso}&hasta=${iso}`)]);
      pintarKpis(r);
      const lista = [...abiertos, ...entregados];
      if (vista !== 'tablero') return;
      cuerpo.innerHTML = `<div class="dm-tablero">${COLUMNAS.map(([e, titulo, ico]) => { const items = lista.filter((d) => d.estado === e); return `<section class="dm-col dm-${e}" aria-label="${titulo}"><h3>${icono(ico, 16)} ${titulo} <span class="dm-n">${items.length}</span></h3><div class="dm-lista">${items.length ? items.map(tarjeta).join('') : `<p class="dm-vacio">${e === 'recibido' ? 'Sin pedidos nuevos' : e === 'entregado' ? 'Aún no hay entregas hoy' : 'Nada aquí'}</p>`}</div></section>`; }).join('')}</div>
        ${r.repartidores.length ? `<div class="card mt-l"><div class="row between"><h2 style="margin:0">Flota</h2>${estado.tiene('domicilios.despachar') ? '<a class="small" href="#/domicilios/repartidores">Administrar</a>' : ''}</div><div class="dm-flota mt">${r.repartidores.map((x) => `<div class="dm-repartidor ${x.en_camino ? 'en-ruta' : ''}"><span class="dm-punto"></span><div><b>${esc(x.nombre)}</b><small>${esc([x.vehiculo, x.placa].filter(Boolean).join(' · '))}</small></div><span class="dm-carga">${x.en_camino ? `${x.en_camino} en ruta` : 'disponible'} · ${x.entregados_hoy} hoy</span></div>`).join('')}</div></div>` : ''}`;
      $$('.dm-card', cuerpo).forEach((c) => { const ir = (e) => { if (e.target.closest('[data-accion]')) return; navegar(`#/domicilios/${c.dataset.id}`); }; c.addEventListener('click', ir); c.addEventListener('keydown', (e) => { if (e.key === 'Enter') ir(e); }); });
      $$('[data-accion]', cuerpo).forEach((b) => b.addEventListener('click', async (e) => { e.stopPropagation(); const d = lista.find((x) => x.id === Number(b.dataset.id)); if (await accion(d, b.dataset.accion)) cargarTablero(); }));
    } catch (e) { mostrarError(e); }
  };

  const filtrosHist = { q: '', estado: '' };
  const cargarHistorial = async () => {
    const cuerpo = $('#dm-cuerpo', root);
    if (!$('#dm-hq', cuerpo)) {
      cuerpo.innerHTML = `<div class="mk-toolbar"><div class="buscador">${icono('search')}<input type="search" id="dm-hq" placeholder="Número, cliente, teléfono, dirección o barrio"></div><select id="dm-he"><option value="">Todos los estados</option>${Object.entries(ESTADOS_DOMICILIO).map(([v, [t]]) => `<option value="${v}">${t}</option>`).join('')}</select></div><div id="dm-hl" class="lista"></div>`;
      $('#dm-hq', cuerpo).addEventListener('input', debounce((e) => { filtrosHist.q = e.target.value.trim(); cargarHistorial(); }, 250));
      $('#dm-he', cuerpo).addEventListener('change', (e) => { filtrosHist.estado = e.target.value; cargarHistorial(); });
    }
    try {
      const [r, l] = await Promise.all([api.get('/api/domicilios/resumen'), api.get('/api/domicilios' + api.qs({ ...filtrosHist, limite: 200 }))]);
      pintarKpis(r);
      $('#dm-hl', cuerpo).innerHTML = l.length ? l.map((d) => `<a class="item" href="#/domicilios/${d.id}"><div class="thumb">${icono('moto', 20)}</div><div class="cuerpo"><div class="titulo">${esc(d.numero)} · ${esc(d.cliente_nombre)}</div><div class="sub">${fmt.fechaHora(d.fecha)} · ${esc(d.barrio || d.direccion)} · ${esc(d.resumen || '')}</div></div><div class="fin"><div class="valor">${fmt.cop(d.total)}</div><div class="xs">${badge(ESTADOS_DOMICILIO, d.estado)}</div></div></a>`).join('') : String(vacio('No hay domicilios con ese filtro'));
    } catch (e) { mostrarError(e); }
  };

  const cargar = () => (vista === 'tablero' ? cargarTablero() : cargarHistorial());
  $$('[data-vista]', root).forEach((b) => b.addEventListener('click', () => { vista = b.dataset.vista; $$('[data-vista]', root).forEach((x) => x.classList.toggle('activo', x === b)); $('#dm-cuerpo', root).innerHTML = String(cargando(3)); cargar(); }));
  $('#dm-cuerpo', root).innerHTML = String(cargando(3));
  cargar();
  // El tablero se actualiza solo cada minuto (tiempos, atrasos y pedidos nuevos).
  const reloj = setInterval(() => { if (vista === 'tablero' && document.body.contains(root)) cargarTablero(); }, 60000);
  return { destruir: () => clearInterval(reloj) };
}

// ---------- Acciones de estado (tablero y ficha) ----------
async function accion(d, que) {
  try {
    if (que === 'preparar') { await api.post(`/api/domicilios/${d.id}/preparar`); toast(`${d.numero} en preparación`, 'ok'); return true; }
    if (que === 'despachar') return await despachar(d);
    if (que === 'entregar') return await entregar(d);
    if (que === 'reabrir') { if (!await confirmar('El pedido vuelve a la bodega (por ejemplo, el cliente no estaba). ¿Continuar?', { textoOk: 'Volver a bodega' })) return false; await api.post(`/api/domicilios/${d.id}/reabrir`); toast('El pedido volvió a preparación', 'ok'); return true; }
    if (que === 'cancelar') { const motivo = await pedirTexto(`Cancelar ${d.numero}`, { etiqueta: 'Motivo de la cancelación', textoOk: 'Cancelar pedido', placeholder: 'Ej. el cliente ya no lo quiere' }); if (!motivo) return false; await api.post(`/api/domicilios/${d.id}/cancelar`, { motivo }); toast('Domicilio cancelado', 'ok'); return true; }
  } catch (e) { mostrarError(e); }
  return false;
}

function despachar(d) {
  return new Promise((resolve) => {
    api.get('/api/repartidores').then((reps) => {
      if (!reps.length) { toast('Primero registra un repartidor en Domicilios › Repartidores', 'error'); resolve(false); return; }
      modal({
        titulo: `Despachar ${d.numero}`,
        cuerpo: `<p class="muted small">${esc(d.cliente_nombre)} · ${esc([d.barrio, d.direccion].filter(Boolean).join(' · '))}</p><div class="et-campo mt mb">¿Quién lo lleva?</div>
          <div class="dm-elegir">${reps.map((r, i) => `<label class="dm-opcion"><input type="radio" name="rep" value="${r.id}" ${i === 0 ? 'checked' : ''}><span class="dm-punto ${r.en_camino ? 'ocupado' : ''}"></span><span class="grow"><b>${esc(r.nombre)}</b><small>${esc([r.vehiculo, r.placa].filter(Boolean).join(' · '))}</small></span><span class="xs muted">${r.en_camino ? `${r.en_camino} en ruta` : 'disponible'}</span></label>`).join('')}</div>`,
        acciones: [{ texto: 'Cancelar', clase: 'suave', alHacerClic: () => resolve(false) }, { texto: `${icono('moto', 18)} Sale a entregar`, clase: 'primario', alHacerClic: async ({ modal: m }) => {
          const sel = $('input[name="rep"]:checked', m);
          await api.post(`/api/domicilios/${d.id}/despachar`, { repartidor_id: Number(sel.value) });
          toast(`${d.numero} va en camino`, 'ok'); resolve(true);
        } }],
      }).el.addEventListener('click', (e) => { if (e.target.classList.contains('modal-fondo')) resolve(false); });
    }).catch((e) => { mostrarError(e); resolve(false); });
  });
}

function entregar(d) {
  const metodos = estado.config.metodos_pago || ['efectivo'];
  return new Promise((resolve) => {
    modal({
      titulo: `Entregar ${d.numero}`,
      cuerpo: `<div class="center"><div class="muted xs">Cobrar al cliente</div><div class="hero-num">${fmt.cop(d.total)}</div>${d.cambio ? `<div class="small muted">Pagó con ${fmt.cop(d.paga_con)} · cambio ${fmt.cop(d.cambio)}</div>` : ''}</div>
        <div class="grid2 mt-l"><div class="campo"><label>Método de pago</label><select id="en-metodo">${metodos.map((m) => `<option value="${esc(m)}" ${m === d.metodo_pago ? 'selected' : ''}>${esc(nombreMetodo(m))}</option>`).join('')}</select></div>
        <div class="campo"><label>Valor recibido</label><input id="en-valor" data-money value="${d.total}"><div class="ayuda">${d.cliente_id ? 'Si recibe menos, el saldo queda a crédito del cliente.' : 'Debe cobrarse completo (cliente sin registrar).'}</div></div></div>
        <div class="campo"><label>Referencia (transferencia)</label><input id="en-ref" placeholder="Opcional"></div>
        <p class="xs muted">Al entregar se registra la venta: descuenta el inventario y el pago entra a la caja abierta.</p>`,
      acciones: [{ texto: 'Cancelar', clase: 'suave', alHacerClic: () => resolve(false) }, { texto: `${icono('check', 18)} Entregado y cobrado`, clase: 'primario', alHacerClic: async ({ modal: m }) => {
        const r = await api.post(`/api/domicilios/${d.id}/entregar`, { metodo_pago: $('#en-metodo', m).value, valor_cobrado: leerDinero($('#en-valor', m)), referencia: $('#en-ref', m).value.trim() || undefined });
        toast(`${d.numero} entregado · venta ${r.venta_numero || ''}`, 'ok'); resolve(true);
      } }],
    });
  });
}

// ---------- Ficha del domicilio ----------
async function ficha(root, id, setTopbar) {
  let d;
  try { d = await api.get(`/api/domicilios/${id}`); } catch (e) { mostrarError(e); return navegar('#/domicilios', true); }
  const editable = ['recibido', 'en_preparacion'].includes(d.estado) && estado.tieneAlguno('domicilios.crear', 'domicilios.despachar');
  setTopbar({ titulo: `Domicilio ${d.numero}`, atras: '#/domicilios', acciones: editable ? [{ icono: 'edit', titulo: 'Corregir pedido', href: `#/domicilios/${id}/editar` }] : [] });
  const pasos = [['recibido', 'Recibido', d.fecha], ['en_preparacion', 'En preparación', d.preparado_en], ['en_camino', 'En camino', d.despachado_en], ['entregado', 'Entregado', d.entregado_en]];
  const orden = ['recibido', 'en_preparacion', 'en_camino', 'entregado'];
  const idx = orden.indexOf(d.estado);
  const negocio = estado.config.negocio_nombre || 'Licores Palmira';
  const mensaje = `Hola ${d.cliente_nombre.split(' ')[0]}, te saluda ${negocio}. Tu pedido ${d.numero}:\n${d.items.map((it) => `• ${it.cantidad} × ${it.nombre_producto}`).join('\n')}\nTotal: ${fmt.cop(d.total)}${d.cargo_envio ? ` (incluye envío ${fmt.cop(d.cargo_envio)})` : ''}\nEntrega en: ${d.direccion}${d.barrio ? ', ' + d.barrio : ''}.${d.estado === 'en_camino' && d.repartidor_nombre ? `\nYa va en camino con ${d.repartidor_nombre}.` : ''}`;
  const mapa = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${d.direccion}, ${d.barrio || ''}, Palmira, Valle del Cauca`)}`;
  const sig = SIGUIENTE[d.estado];
  const despacha = estado.tiene('domicilios.despachar');
  renderizar(root, html`<div class="dm-ficha">
    <div class="card">
      <div class="row between wrap"><div><div class="row gap wrap">${badge(ESTADOS_DOMICILIO, d.estado)}${d.atrasado ? html`<span class="badge peligro">Atrasado · ${minutosTexto(d.minutos)}</span>` : ''}<span class="badge neutro">${CANALES_DOMICILIO[d.canal] || d.canal || 'WhatsApp'}</span></div>
        <h2 style="margin:10px 0 2px">${d.cliente_nombre} ${d.tipo_cliente === 'mayorista' ? raw(badge(TIPOS_CLIENTE, 'mayorista')) : ''}</h2>
        <div class="muted small">Tomado por ${d.creado_por_nombre || '—'} · ${fmt.fechaHora(d.fecha)}</div></div>
        <div class="right"><div class="muted xs">Total</div><div class="hero-num">${fmt.cop(d.total)}</div></div></div>
      ${d.estado !== 'cancelado' ? html`<ol class="dm-linea mt-l">${pasos.map(([e, t, f], i) => html`<li class="${i < idx ? 'hecho' : i === idx ? 'actual' : ''}"><span class="dm-paso"></span><b>${t}</b><small>${f ? hora(f) : '—'}</small></li>`)}</ol>`
        : html`<div class="alerta peligro mt">Cancelado ${fmt.fechaHora(d.cancelado_en)} · ${d.motivo_cancelacion || ''}</div>`}
      <div class="row wrap gap mt-l no-print">
        ${sig && despacha ? html`<button class="btn primario" data-accion="${sig[0]}">${raw(icono(sig[0] === 'entregar' ? 'check' : sig[0] === 'despachar' ? 'moto' : 'box', 18))} ${sig[1]}</button>` : ''}
        ${d.estado === 'en_camino' && despacha ? html`<button class="btn suave" data-accion="reabrir">${raw(icono('undo', 18))} Volver a bodega</button>` : ''}
        <a class="btn suave" href="https://wa.me/${telWa(d.telefono)}?text=${encodeURIComponent(mensaje)}" target="_blank" rel="noopener">${raw(icono('whatsapp', 18))} Escribir al cliente</a>
        <a class="btn suave" href="tel:${soloDigitos(d.telefono)}">${raw(icono('phone', 18))} Llamar</a>
        ${['recibido', 'en_preparacion', 'en_camino'].includes(d.estado) && despacha ? html`<button class="btn peligro" data-accion="cancelar">${raw(icono('x', 18))} Cancelar</button>` : ''}
      </div>
    </div>
    <div class="grid2 mt">
      <div class="card"><h2>Entrega</h2>
        <dl class="kv"><dt>Dirección</dt><dd>${d.direccion}</dd>${d.barrio ? html`<dt>Barrio</dt><dd>${d.barrio}</dd>` : ''}<dt>Teléfono</dt><dd>${d.telefono}</dd>${d.hora_compromiso ? html`<dt>Hora acordada</dt><dd>${d.hora_compromiso}</dd>` : ''}${d.repartidor_nombre ? html`<dt>Repartidor</dt><dd>${d.repartidor_nombre}${d.repartidor_placa ? ` · ${d.repartidor_placa}` : ''}</dd>` : ''}${d.minutos_entrega ? html`<dt>Tiempo total</dt><dd>${minutosTexto(d.minutos_entrega)}</dd>` : ''}</dl>
        ${d.indicaciones ? html`<div class="alerta neutra small mt">${raw(icono('pin', 14))} ${d.indicaciones}</div>` : ''}
        ${d.notas ? html`<p class="small muted mt">${d.notas}</p>` : ''}
        <a class="btn chico suave mt" href="${mapa}" target="_blank" rel="noopener">${raw(icono('external', 14))} Ver en el mapa</a>
      </div>
      <div class="card"><h2>Cobro</h2>
        <dl class="kv"><dt>Productos</dt><dd>${fmt.cop(d.subtotal)}</dd><dt>Envío</dt><dd>${d.cargo_envio ? fmt.cop(d.cargo_envio) : 'Gratis'}</dd><dt>Total</dt><dd class="total">${fmt.cop(d.total)}</dd><dt>Método</dt><dd>${nombreMetodo(d.metodo_pago)}</dd>${d.paga_con ? html`<dt>Paga con</dt><dd>${fmt.cop(d.paga_con)}</dd><dt>Llevar de cambio</dt><dd class="bold">${fmt.cop(d.cambio)}</dd>` : ''}</dl>
        ${d.venta_id ? html`<a class="alerta info small row between mt" href="#/ventas/${d.venta_id}"><span>Venta <b>${d.venta_numero}</b> ${d.venta_estado === 'anulada' ? '(anulada)' : 'registrada'}</span>${raw(icono('chevron', 16))}</a>` : ''}
      </div>
    </div>
    <div class="card mt"><h2>Productos (${d.items.length})</h2>
      <div class="lista">${d.items.map((it) => html`<div class="item">${raw(miniatura(it, 'thumb'))}<div class="cuerpo"><div class="titulo">${it.nombre_producto} ${raw(tarifaBadge(it.tarifa))}</div><div class="sub">${it.cantidad} × ${fmt.cop(it.precio_unitario)}${['recibido', 'en_preparacion'].includes(d.estado) && it.stock < it.cantidad ? html` · <b class="neg">solo hay ${it.stock}</b>` : ''}</div></div><div class="fin"><div class="valor">${fmt.cop(it.total)}</div></div></div>`)}</div>
    </div>
  </div>`);
  $$('[data-accion]', root).forEach((b) => b.addEventListener('click', async () => { if (await accion(d, b.dataset.accion)) ficha(root, id, setTopbar); }));
}

// ---------- Nuevo domicilio / corregir ----------
async function formulario(root, id, setTopbar) {
  if (!estado.tieneAlguno('domicilios.crear', 'domicilios.despachar')) return navegar('#/domicilios', true);
  let existente = null;
  if (id) { try { existente = await api.get(`/api/domicilios/${id}`); } catch (e) { mostrarError(e); return navegar('#/domicilios', true); } }
  setTopbar({ titulo: id ? `Corregir ${existente.numero}` : 'Nuevo domicilio', atras: id ? `#/domicilios/${id}` : '#/domicilios' });
  const cfg = estado.config.domicilios || {};
  const metodos = estado.config.metodos_pago || ['efectivo'];
  let cliente = existente && existente.cliente_id ? { id: existente.cliente_id, nombre: existente.cliente_nombre, tipo_cliente: existente.tipo_cliente } : null;
  let items = existente ? existente.items.map((it) => ({ producto_id: it.producto_id, nombre: it.nombre_producto, foto: it.foto, cantidad: it.cantidad, stock: it.stock })) : [];
  let cotizacion = null;
  let cargoManual = !!existente;
  const v = (k, def = '') => (existente && existente[k] != null ? existente[k] : def);

  renderizar(root, html`<form id="dm-form" class="dm-form">
    <div class="dm-form-izq">
      <div class="card"><h2>Cliente</h2>
        <div class="campo"><button type="button" class="btn suave bloque" id="dm-buscar-cli" style="justify-content:space-between"><span id="dm-cli-txt">Buscar cliente registrado</span>${raw(icono('search', 18))}</button><div class="ayuda">O escribe los datos de un cliente nuevo: se guarda para el próximo pedido.</div></div>
        <div class="grid2"><div class="campo"><label>Nombre *</label><input name="cliente_nombre" required value="${v('cliente_nombre')}"></div><div class="campo"><label>Celular / WhatsApp *</label><input name="telefono" type="tel" inputmode="tel" required value="${v('telefono')}"></div></div>
        <div class="grid2"><div class="campo"><label>Dirección de entrega *</label><input name="direccion" required value="${v('direccion')}" placeholder="Ej. Cra 28 # 42-15, apto 301"></div><div class="campo"><label>Barrio</label><input name="barrio" value="${v('barrio')}"></div></div>
        <div class="campo"><label>Indicaciones para el repartidor</label><input name="indicaciones" value="${v('indicaciones')}" placeholder="Ej. casa de rejas negras, timbre dañado"></div>
      </div>
      <div class="card mt"><h2>Productos</h2>
        <div class="buscador">${raw(icono('search'))}<input type="search" id="dm-q" placeholder="Buscar licor, marca o presentación…" autocomplete="off"></div>
        <div id="dm-res" class="pv-grid compacta mt"></div>
      </div>
    </div>
    <div class="dm-form-der">
      <div class="card carrito"><h2>Pedido</h2><div id="dm-items"></div>
        <div class="sep"></div>
        <div class="grid2"><div class="campo"><label>Envío</label><input name="cargo_envio" data-money value="${v('cargo_envio', cfg.cargo_envio_defecto || 0)}"><div class="ayuda" id="dm-envio-ayuda">${cfg.envio_gratis_desde ? `Gratis desde ${fmt.cop(cfg.envio_gratis_desde)}` : ''}</div></div>
        <div class="campo"><label>Canal</label><select name="canal">${Object.entries(CANALES_DOMICILIO).map(([k, t]) => html`<option value="${k}" ${v('canal', 'whatsapp') === k ? 'selected' : ''}>${t}</option>`)}</select></div></div>
        <div class="grid2"><div class="campo"><label>Pago al recibir</label><select name="metodo_pago">${metodos.map((m) => html`<option value="${m}" ${v('metodo_pago', 'efectivo') === m ? 'selected' : ''}>${nombreMetodo(m)}</option>`)}</select></div>
        <div class="campo" id="dm-paga-campo"><label>Paga con (efectivo)</label><input name="paga_con" data-money value="${v('paga_con', '')}" placeholder="Para llevar el cambio"></div></div>
        <div class="grid2"><div class="campo"><label>Hora acordada</label><input name="hora_compromiso" type="time" value="${v('hora_compromiso', '')}"></div><div class="campo"><label>Notas internas</label><input name="notas" value="${v('notas', '')}"></div></div>
        <dl class="kv mt" id="dm-totales"></dl>
        <button class="btn primario grande mt" type="submit" id="dm-guardar">${raw(icono('moto', 20))} ${id ? 'Guardar cambios' : 'Registrar domicilio'}</button>
      </div>
    </div>
  </form>`);
  activarDinero(root);
  const form = $('#dm-form', root);
  const pintarCliente = () => { $('#dm-cli-txt', root).innerHTML = cliente ? `${esc(cliente.nombre)}${cliente.tipo_cliente === 'mayorista' ? ' <span class="badge mayor">Mayorista</span>' : ''}` : 'Buscar cliente registrado'; };
  pintarCliente();

  const pintarTotales = () => {
    const subtotal = cotizacion ? cotizacion.subtotal : 0;
    const envio = leerDinero(form.cargo_envio);
    const total = subtotal + envio;
    const pagaCon = leerDinero(form.paga_con);
    $('#dm-totales', root).innerHTML = `<dt>Productos</dt><dd>${fmt.cop(subtotal)}</dd><dt>Envío</dt><dd>${envio ? fmt.cop(envio) : 'Gratis'}</dd><dt>Total</dt><dd class="total">${fmt.cop(total)}</dd>${pagaCon > total ? `<dt>Cambio</dt><dd class="bold">${fmt.cop(pagaCon - total)}</dd>` : ''}`;
    $('#dm-paga-campo', root).hidden = form.metodo_pago.value !== 'efectivo';
    $('#dm-guardar', root).disabled = !items.length;
  };
  const pintarItems = () => {
    const c = $('#dm-items', root);
    if (!items.length) { c.innerHTML = String(vacio('Agrega los productos del pedido')); pintarTotales(); return; }
    c.innerHTML = items.map((it, i) => { const q = cotizacion && cotizacion.items[i]; return `<div class="linea-carrito">${miniatura(it, 'thumb')}<div class="grow"><div class="bold truncate">${esc(it.nombre)}</div><div class="row small muted wrap" style="gap:6px">${q ? `<span class="num">${fmt.cop(q.precio_unitario)} c/u</span>${tarifaBadge(q.tarifa)}` : ''}${it.stock !== undefined && it.stock < it.cantidad ? `<span class="badge peligro">hay ${it.stock}</span>` : ''}</div><div class="stepper" style="margin-top:6px"><button type="button" data-menos="${i}">−</button><input type="number" min="1" value="${it.cantidad}" data-cant="${i}" aria-label="Cantidad"><button type="button" data-mas="${i}">+</button></div></div><div class="fin"><div class="valor">${q ? fmt.cop(q.total) : ''}</div><button type="button" class="btn chico quitar-linea" data-quitar="${i}" aria-label="Quitar">${icono('trash', 15)}</button></div></div>`; }).join('');
    $$('[data-menos]', c).forEach((b) => b.addEventListener('click', () => { const it = items[Number(b.dataset.menos)]; if (it.cantidad <= 1) items.splice(Number(b.dataset.menos), 1); else it.cantidad -= 1; cotizar(); }));
    $$('[data-mas]', c).forEach((b) => b.addEventListener('click', () => { items[Number(b.dataset.mas)].cantidad += 1; cotizar(); }));
    $$('[data-cant]', c).forEach((inp) => inp.addEventListener('change', () => { items[Number(inp.dataset.cant)].cantidad = Math.max(1, Number(inp.value) || 1); cotizar(); }));
    $$('[data-quitar]', c).forEach((b) => b.addEventListener('click', () => { items.splice(Number(b.dataset.quitar), 1); cotizar(); }));
    pintarTotales();
  };
  // Precios y tarifa calculados por el servidor (misma regla del punto de venta).
  const cotizar = debounce(async () => {
    if (!items.length) { cotizacion = null; pintarItems(); return; }
    try {
      cotizacion = await api.post('/api/domicilios/cotizar', { cliente_id: cliente ? cliente.id : undefined, items: items.map((it) => ({ producto_id: it.producto_id, cantidad: it.cantidad })) });
      if (!cargoManual) { form.cargo_envio.value = cotizacion.cargo_sugerido ? fmt.num(cotizacion.cargo_sugerido) : ''; }
    } catch (e) { mostrarError(e); }
    pintarItems();
  }, 200);

  let resultados = [];
  const buscar = async () => {
    const texto = $('#dm-q', root).value.trim();
    try {
      const r = await api.get('/api/productos' + api.qs({ q: texto, orden: texto ? '' : 'vendidos', limite: texto ? 24 : 12 }));
      resultados = r.productos;
      $('#dm-res', root).innerHTML = resultados.length ? resultados.map((p, i) => `<button type="button" class="pv-tile ${p.stock <= 0 ? 'agotado' : ''}" data-i="${i}"><span class="pv-foto">${p.foto ? `<img src="/api/archivos/${esc(p.foto)}" alt="" loading="lazy">` : icono('bottle', 28)}</span><span class="pv-nombre">${esc(p.nombre)}</span><span class="pv-precios"><b class="num">${fmt.cop(p.precio_venta)}</b>${p.precio_mayor > 0 && p.precio_mayor < p.precio_venta ? `<span class="pv-mayor num">Mayor ${fmt.cop(p.precio_mayor)}</span>` : ''}</span><span class="pv-stock ${p.stock <= 0 ? 'cero' : ''}">${p.stock <= 0 ? 'Agotado' : `${fmt.num(p.stock)} disp.`}</span></button>`).join('') : '<div class="vacio small" style="grid-column:1/-1">Sin resultados</div>';
      $$('.pv-tile', $('#dm-res', root)).forEach((b) => b.addEventListener('click', () => {
        const p = resultados[Number(b.dataset.i)];
        const ya = items.find((x) => x.producto_id === p.id);
        if (ya) ya.cantidad += 1; else items.push({ producto_id: p.id, nombre: p.nombre, foto: p.foto, cantidad: 1, stock: p.stock });
        if (p.stock <= 0) toast(`${p.nombre} está agotado: el pedido no podrá despacharse hasta que entre mercancía`, 'error');
        cotizar();
      }));
    } catch (e) { mostrarError(e); }
  };
  $('#dm-q', root).addEventListener('input', debounce(buscar, 220));
  form.cargo_envio.addEventListener('input', () => { cargoManual = true; });
  form.cargo_envio.addEventListener('blur', pintarTotales);
  form.paga_con.addEventListener('blur', pintarTotales);
  form.metodo_pago.addEventListener('change', pintarTotales);
  $('#dm-buscar-cli', root).addEventListener('click', () => selectorBusqueda({
    titulo: 'Cliente', placeholder: 'Nombre, teléfono o dirección',
    buscar: async (t) => (await api.get('/api/clientes' + api.qs({ q: t }))).map((c) => ({ id: c.id, titulo: c.nombre, sub: [c.tipo_cliente === 'mayorista' ? 'Mayorista' : '', c.telefono, [c.direccion, c.barrio].filter(Boolean).join(', ')].filter(Boolean).join(' · '), datos: c })),
    alElegir: (it) => {
      cliente = it.datos;
      form.cliente_nombre.value = cliente.nombre || '';
      form.telefono.value = cliente.telefono || '';
      form.direccion.value = cliente.direccion || '';
      form.barrio.value = cliente.barrio || '';
      pintarCliente(); cotizar();
    },
  }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!items.length) { toast('Agrega al menos un producto', 'error'); return; }
    const d = {
      cliente_id: cliente ? cliente.id : undefined,
      cliente_nombre: form.cliente_nombre.value.trim(), telefono: form.telefono.value.trim(), direccion: form.direccion.value.trim(), barrio: form.barrio.value.trim(),
      indicaciones: form.indicaciones.value.trim(), canal: form.canal.value, metodo_pago: form.metodo_pago.value,
      paga_con: form.metodo_pago.value === 'efectivo' ? leerDinero(form.paga_con) || null : null, cargo_envio: leerDinero(form.cargo_envio),
      hora_compromiso: form.hora_compromiso.value || null, notas: form.notas.value.trim(),
      items: items.map((it) => ({ producto_id: it.producto_id, cantidad: it.cantidad })),
    };
    const b = $('#dm-guardar', root); b.disabled = true;
    try {
      const r = id ? await api.put(`/api/domicilios/${id}`, d) : await api.post('/api/domicilios', d);
      toast(id ? 'Pedido actualizado' : `Domicilio ${r.numero} registrado`, 'ok');
      navegar(`#/domicilios/${r.id}`, true);
    } catch (err) { b.disabled = false; mostrarError(err); }
  });
  buscar();
  if (items.length) cotizar(); else pintarItems();
}

// ---------- Repartidores ----------
async function repartidores(root, setTopbar) {
  const puede = estado.tiene('domicilios.despachar');
  setTopbar({ titulo: 'Repartidores', atras: '#/domicilios', acciones: puede ? [{ icono: 'plus', texto: 'Agregar', clase: 'primario', alHacerClic: () => editar(null) }] : [] });
  const cargar = async () => {
    try {
      const lista = await api.get('/api/repartidores?todos=1');
      renderizar(root, html`<p class="intro-modulo">La flota propia de domicilios. Al despachar un pedido eliges quién lo lleva; aquí ves cuántos tiene en ruta cada uno.</p>
        <div class="lista">${lista.length ? lista.map((r) => html`<div class="item ${r.activo ? '' : 'muted'}"><div class="thumb">${raw(icono('moto', 20))}</div><div class="cuerpo"><div class="titulo">${r.nombre}${r.activo ? '' : ' (inactivo)'}</div><div class="sub">${[r.vehiculo, r.placa, r.telefono].filter(Boolean).join(' · ')}</div></div><div class="fin"><div class="small">${r.en_camino ? html`<span class="badge camino">${r.en_camino} en ruta</span>` : html`<span class="badge ok">Disponible</span>`}</div>${puede ? html`<button class="btn chico suave mt" data-editar="${r.id}">${raw(icono('edit', 14))} Editar</button>` : ''}</div></div>`) : vacio('Aún no hay repartidores registrados')}</div>`);
      $$('[data-editar]', root).forEach((b) => b.addEventListener('click', () => editar(lista.find((x) => x.id === Number(b.dataset.editar)))));
    } catch (e) { mostrarError(e); }
  };
  const editar = (r) => modal({
    titulo: r ? `Editar · ${r.nombre}` : 'Nuevo repartidor',
    cuerpo: `<div class="campo"><label>Nombre *</label><input id="rp-nombre" value="${esc(r ? r.nombre : '')}"></div><div class="grid2"><div class="campo"><label>Celular</label><input id="rp-tel" type="tel" value="${esc(r ? r.telefono || '' : '')}"></div><div class="campo"><label>Placa</label><input id="rp-placa" value="${esc(r ? r.placa || '' : '')}"></div></div><div class="campo"><label>Vehículo</label><input id="rp-veh" value="${esc(r ? r.vehiculo || '' : '')}" placeholder="Ej. Moto AKT 125, furgón NHR"></div>${r ? `<label class="check"><input type="checkbox" id="rp-activo" ${r.activo ? 'checked' : ''}> Activo (aparece al despachar)</label>` : ''}`,
    acciones: [{ texto: 'Guardar', clase: 'primario', alHacerClic: async ({ modal: m }) => {
      const datos = { nombre: $('#rp-nombre', m).value, telefono: $('#rp-tel', m).value, placa: $('#rp-placa', m).value, vehiculo: $('#rp-veh', m).value, ...(r ? { activo: $('#rp-activo', m).checked } : {}) };
      if (r) await api.put(`/api/repartidores/${r.id}`, datos); else await api.post('/api/repartidores', datos);
      toast('Repartidor guardado', 'ok'); cargar();
    } }],
  });
  cargar();
}
