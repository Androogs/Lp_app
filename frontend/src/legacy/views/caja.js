import { api } from '../../lib/api';
import { estado } from '../../lib/estado';
import { $, $$, html, raw, render as renderizar, fmt, icono, nombreMetodo, toast, modal, confirmar, mostrarError, activarDinero, leerDinero, vacio, cargando, esc, hoyISO, tabla } from '../ui.js';
import { capturar } from '../camera.js';
import { pagarCompra } from './compras.js';
import { rangoDe } from './ventas.js';
import { barrasH } from '../charts.js';

export async function render(root, { partes, setTopbar }) {
  setTopbar({ titulo: 'Caja y gastos' });
  let tab = partes[0] || 'caja';
  const tabs = [['caja', 'Caja'], ['gastos', 'Gastos'], ['pagar', 'Por pagar'], ['historial', 'Cierres']];
  renderizar(root, html`<div class="tabs">${tabs.map(([v, t]) => html`<button class="${tab === v ? 'activo' : ''}" data-tab="${v}">${t}</button>`)}</div><div id="caja-cont"></div>`);
  const cont = $('#caja-cont', root);
  const pintar = () => { $$('[data-tab]', root).forEach((b) => b.classList.toggle('activo', b.dataset.tab === tab)); ({ caja: vistaCaja, gastos: vistaGastos, pagar: vistaPorPagar, historial: vistaHistorial })[tab](cont); };
  $$('[data-tab]', root).forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; pintar(); }));
  pintar();
}

// ---------- Fecha y hora (se muestran en vivo al abrir, durante el turno y al cerrar) ----------
const ahoraTexto = () => new Date().toLocaleString('es-CO', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
// Pinta la fecha y hora actuales en cada [data-reloj] de `raiz` y las actualiza cada segundo mientras sigan en pantalla.
export function reloj(raiz) {
  const els = [...raiz.querySelectorAll('[data-reloj]')];
  if (!els.length) return;
  const pintar = () => { const vivos = els.filter((e) => e.isConnected); if (!vivos.length) { clearInterval(t); return; } const txt = ahoraTexto(); vivos.forEach((e) => { e.textContent = txt.charAt(0).toUpperCase() + txt.slice(1); }); };
  els.forEach((e) => { const txt = ahoraTexto(); e.textContent = txt.charAt(0).toUpperCase() + txt.slice(1); });
  const t = setInterval(pintar, 1000);
}
// Tiempo transcurrido desde una fecha local "YYYY-MM-DD HH:MM:SS".
export function duracion(desde) {
  const min = Math.max(0, Math.floor((Date.now() - new Date(String(desde).replace(' ', 'T')).getTime()) / 60000));
  const h = Math.floor(min / 60);
  return h ? `${h} h ${min % 60} min` : `${min} min`;
}

// Abrir caja: la fecha y hora de apertura la pone el sistema al confirmar; aquí se muestra la actual en vivo.
export function abrirCaja(alListo) {
  modal({
    titulo: 'Abrir caja',
    cuerpo: `<div class="reloj-caja"><span class="muted xs">Fecha y hora de apertura</span><div class="bold" data-reloj></div></div><div class="campo"><label>Base inicial en efectivo</label><input id="ab-base" data-money placeholder="0"></div><div class="campo"><label>Notas</label><input id="ab-notas"></div>`,
    acciones: [{ texto: 'Abrir', clase: 'primario', alHacerClic: async ({ modal: m }) => { const s = await api.post('/api/caja/abrir', { base_inicial: leerDinero($('#ab-base', m)), notas: $('#ab-notas', m).value }); estado.caja = s || estado.caja; toast(`Caja abierta · ${new Date().toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' })}`, 'ok'); if (alListo) alListo(); } }],
    alMontar: (m) => { activarDinero(m); reloj(m); },
  });
}

// Cerrar caja: `r` = resumen del turno (efectivo esperado). Muestra la fecha y hora de cierre en vivo.
export function cerrarCaja(r, alListo) {
  modal({
    titulo: 'Cerrar caja',
    cuerpo: `<div class="reloj-caja"><span class="muted xs">Fecha y hora de cierre</span><div class="bold" data-reloj></div></div><dl class="kv"><dt>Efectivo esperado</dt><dd class="total">${fmt.cop(r.efectivo_esperado)}</dd></dl><div class="campo mt"><label>Efectivo contado *</label><input id="cc-contado" data-money></div><div id="cc-dif" class="alerta neutra">Ingresa el efectivo contado para ver la diferencia.</div><div class="campo mt"><label>Notas</label><textarea id="cc-notas"></textarea></div>`,
    acciones: [{ texto: 'Cerrar caja', clase: 'negro', alHacerClic: async ({ modal: m }) => { const contado = leerDinero($('#cc-contado', m)); const dif = contado - r.efectivo_esperado; if (dif !== 0 && !await confirmar(`La diferencia es de ${fmt.cop(dif)}. ¿Cerrar de todas formas?`, { peligro: true, textoOk: 'Cerrar' })) return false; await api.post('/api/caja/cerrar', { efectivo_contado: contado, notas: $('#cc-notas', m).value }); toast('Caja cerrada', 'ok'); estado.caja = null; if (alListo) alListo(); } }],
    alMontar: (m) => { activarDinero(m); reloj(m); $('#cc-contado', m).addEventListener('blur', () => { const dif = leerDinero($('#cc-contado', m)) - r.efectivo_esperado; const el = $('#cc-dif', m); el.className = `alerta ${dif === 0 ? 'info' : dif > 0 ? 'aviso' : 'peligro'}`; el.textContent = dif === 0 ? 'Caja cuadrada' : dif > 0 ? `Sobrante de ${fmt.cop(dif)}` : `Faltante de ${fmt.cop(-dif)}`; }); },
  });
}

// Estado de la caja en una franja compacta (se usa en Ventas): abierta/cerrada, desde cuándo, efectivo esperado y acciones.
export async function barraCaja(cont, { alCambiar } = {}) {
  if (!cont || !estado.tiene('caja.ver')) return;
  let d;
  try { d = await api.get('/api/caja'); } catch { cont.innerHTML = ''; return; }
  const s = d.abierta;
  estado.caja = s;
  const opera = estado.tiene('caja.operar');
  const recargar = () => { barraCaja(cont, { alCambiar }); if (alCambiar) alCambiar(); };
  cont.innerHTML = s
    ? `<div class="card compacta caja-barra"><div class="row between wrap gap"><div class="grow"><div class="row wrap" style="gap:6px"><span class="badge ok">Caja abierta</span><span class="muted small">desde ${esc(fmt.fechaHora(s.abierta_en))} · ${esc(s.usuario_apertura || '')} · lleva ${esc(duracion(s.abierta_en))}</span></div>
        <div class="row wrap small mt" style="gap:12px;margin-top:6px"><span>Efectivo esperado <b class="num">${fmt.cop(s.resumen.efectivo_esperado)}</b></span><span class="muted">${s.resumen.ventas_cantidad} venta(s) · ${fmt.cop(s.resumen.ventas_facturadas)}</span><span class="muted">${icono('clock', 14)} <span data-reloj></span></span></div></div>
        <div class="row gap"><a class="btn chico suave" href="#/caja">${icono('cash', 16)} Ver caja</a>${opera ? '<button type="button" class="btn chico negro" data-cerrar-caja>Cerrar caja</button>' : ''}</div></div></div>`
    : `<div class="card compacta caja-barra cerrada"><div class="row between wrap gap"><div class="grow"><div class="row wrap" style="gap:6px"><span class="badge peligro">Caja cerrada</span><span class="muted small">Ábrela para registrar el efectivo del turno.</span></div>
        <div class="small muted mt" style="margin-top:6px">${icono('clock', 14)} <span data-reloj></span>${d.historial && d.historial.length ? ` · último cierre ${esc(fmt.fechaHora(d.historial[0].cerrada_en))}` : ''}</div></div>
        <div class="row gap">${opera ? `<button type="button" class="btn chico primario" data-abrir-caja>${icono('cash', 16)} Abrir caja</button>` : ''}<a class="btn chico suave" href="#/caja">Ver caja</a></div></div></div>`;
  reloj(cont);
  const ba = cont.querySelector('[data-abrir-caja]'); if (ba) ba.addEventListener('click', () => abrirCaja(recargar));
  const bc = cont.querySelector('[data-cerrar-caja]'); if (bc) bc.addEventListener('click', () => cerrarCaja(s.resumen, recargar));
}

async function vistaCaja(cont) {
  cont.innerHTML = String(cargando(4));
  let d;
  try { d = await api.get('/api/caja'); } catch (e) { return mostrarError(e); }
  const s = d.abierta;
  estado.caja = s;
  if (!s) {
    renderizar(cont, html`<div class="card center"><div class="muted">La caja está cerrada</div><div class="bold mt" data-reloj></div><p class="small muted mt">Ábrela con la base inicial en efectivo para registrar las ventas y gastos del turno.</p>${estado.tiene('caja.operar') ? html`<button class="btn primario mt-l" id="cj-abrir">${raw(icono('cash'))} Abrir caja</button>` : ''}</div>
      ${d.historial.length ? html`<div class="card"><h2>Último cierre</h2><dl class="kv"><dt>Fecha</dt><dd>${fmt.fechaHora(d.historial[0].cerrada_en)}</dd><dt>Efectivo esperado</dt><dd>${fmt.cop(d.historial[0].efectivo_esperado)}</dd><dt>Contado</dt><dd>${fmt.cop(d.historial[0].efectivo_contado)}</dd><dt>Diferencia</dt><dd class="${d.historial[0].diferencia ? 'neg' : ''}">${fmt.cop(d.historial[0].diferencia)}</dd></dl></div>` : ''}`);
    reloj(cont);
    const b = $('#cj-abrir', cont);
    if (b) b.addEventListener('click', () => abrirCaja(() => vistaCaja(cont)));
    return;
  }
  const r = s.resumen;
  const filaMetodos = (obj) => Object.entries(obj || {}).map(([m, v]) => html`<dt>&nbsp;&nbsp;${nombreMetodo(m)}</dt><dd>${fmt.cop(v)}</dd>`);
  renderizar(cont, html`<div class="card">
      <div class="row between"><div><h2 style="margin:0">Caja abierta</h2><div class="muted small">Abierta el ${fmt.fechaHora(s.abierta_en)} · ${s.usuario_apertura || ''} · lleva ${duracion(s.abierta_en)}</div><div class="small mt">${raw(icono('clock', 14))} <span data-reloj></span></div></div><span class="badge ok">Abierta</span></div>
      <div class="center mt"><div class="muted xs">Efectivo esperado en caja</div><div class="hero-num">${fmt.cop(r.efectivo_esperado)}</div></div>
      <dl class="kv mt"><dt>Base inicial</dt><dd>${fmt.cop(r.base_inicial)}</dd>
        <dt class="bold">Ventas facturadas</dt><dd>${fmt.cop(r.ventas_facturadas)} <span class="muted xs">(${r.ventas_cantidad})</span></dd>
        <dt>&nbsp;&nbsp;a crédito (no es dinero recibido)</dt><dd>${fmt.cop(r.credito_otorgado)}</dd>
        <dt class="bold">Dinero recibido</dt><dd class="pos">${fmt.cop(r.total_ingresos)}</dd>${filaMetodos(r.ingresos)}
        ${r.domicilios && r.domicilios.n ? html`<dt>&nbsp;&nbsp;de ${r.domicilios.n} domicilio(s) entregado(s) (envíos ${fmt.cop(r.domicilios.envios)})</dt><dd>${fmt.cop(r.domicilios.total)}</dd>` : ''}
        ${r.entradas ? html`<dt>Entradas manuales</dt><dd>${fmt.cop(r.entradas)}</dd>` : ''}
        <dt class="bold">Salidas</dt><dd class="neg">${fmt.cop(r.total_egresos + r.salidas)}</dd>
        ${Object.keys(r.gastos || {}).length ? html`<dt>&nbsp;&nbsp;Gastos</dt><dd>${fmt.cop(Object.values(r.gastos).reduce((a, b) => a + b, 0))}</dd>` : ''}
        ${Object.keys(r.pagos_proveedor || {}).length ? html`<dt>&nbsp;&nbsp;Pagos a proveedores</dt><dd>${fmt.cop(Object.values(r.pagos_proveedor).reduce((a, b) => a + b, 0))}</dd>` : ''}
        ${Object.keys(r.reintegros || {}).length ? html`<dt>&nbsp;&nbsp;Reintegros a clientes</dt><dd>${fmt.cop(Object.values(r.reintegros).reduce((a, b) => a + b, 0))}</dd>` : ''}
        ${r.salidas ? html`<dt>&nbsp;&nbsp;Salidas manuales</dt><dd>${fmt.cop(r.salidas)}</dd>` : ''}</dl>
      ${estado.tiene('caja.operar') ? html`<div class="grid3 mt-l"><button class="btn suave" id="cj-entrada">${raw(icono('plus'))} Entrada</button><button class="btn suave" id="cj-salida">${raw(icono('minus'))} Salida</button><button class="btn negro" id="cj-cerrar">Cerrar caja</button></div>` : ''}
    </div>
    <div class="card"><h2>Movimientos del turno</h2>${s.pagos.length || s.movimientos.length || s.gastos.length ? html`<div class="col">
      ${[...s.pagos.map((p) => ({ fecha: p.fecha, texto: `${{ venta: 'Venta', abono: 'Abono', pago_proveedor: 'Pago proveedor', reintegro: 'Reintegro', otro: 'Otro' }[p.tipo]} ${p.venta_numero || p.credito_numero || p.compra_numero || ''} · ${nombreMetodo(p.metodo_pago)} · ${p.usuario_nombre || ''}${p.anulado ? ' (anulado)' : ''}`, valor: ['pago_proveedor', 'reintegro'].includes(p.tipo) ? -p.valor : p.valor, anulado: p.anulado })),
        ...s.movimientos.map((m) => ({ fecha: m.fecha, texto: `${m.tipo === 'entrada' ? 'Entrada' : 'Salida'} · ${m.concepto} · ${m.usuario_nombre || ''}`, valor: m.tipo === 'entrada' ? m.valor : -m.valor })),
        ...s.gastos.map((g) => ({ fecha: g.fecha, texto: `Gasto · ${g.categoria}${g.descripcion ? ' · ' + g.descripcion : ''} · ${nombreMetodo(g.metodo_pago)}`, valor: -g.valor }))].sort((a, b) => (a.fecha < b.fecha ? 1 : -1)).map((x) => html`<div class="row between small ${x.anulado ? 'muted' : ''}"><span>${fmt.fechaHora(x.fecha)} · ${x.texto}</span><b class="num ${x.valor < 0 ? 'neg' : ''}">${fmt.cop(x.valor)}</b></div>`)}</div>` : html`<p class="muted">Sin movimientos todavía.</p>`}</div>`);
  reloj(cont);
  const mov = (tipo) => modal({ titulo: tipo === 'entrada' ? 'Entrada de efectivo' : 'Salida de efectivo', cuerpo: `<div class="campo"><label>Valor</label><input id="mv-valor" data-money></div><div class="campo"><label>Concepto</label><input id="mv-concepto" placeholder="${tipo === 'entrada' ? 'Ej. cambio / base adicional' : 'Ej. domicilio, préstamo'}"></div>`, acciones: [{ texto: 'Registrar', clase: 'primario', alHacerClic: async ({ modal: m }) => { await api.post('/api/caja/movimientos', { tipo, valor: leerDinero($('#mv-valor', m)), concepto: $('#mv-concepto', m).value }); toast('Movimiento registrado', 'ok'); vistaCaja(cont); } }] });
  const be = $('#cj-entrada', cont); if (be) be.addEventListener('click', () => mov('entrada'));
  const bs = $('#cj-salida', cont); if (bs) bs.addEventListener('click', () => mov('salida'));
  const bc = $('#cj-cerrar', cont);
  if (bc) bc.addEventListener('click', () => cerrarCaja(r, () => vistaCaja(cont)));
}

async function vistaGastos(cont) {
  let periodo = 'mes';
  renderizar(cont, html`<div class="row between"><div class="pills">${[['hoy', 'Hoy'], ['semana', 'Semana'], ['mes', 'Mes'], ['anio', 'Año'], ['todo', 'Todo']].map(([v, t]) => html`<button class="pill ${periodo === v ? 'activo' : ''}" data-p="${v}">${t}</button>`)}</div>${estado.tiene('caja.gastos') ? html`<button class="btn chico primario" id="g-nuevo">${raw(icono('plus', 16))} Gasto</button>` : ''}</div>
    <section class="panel mt"><div class="panel-cab"><div><h2>Gastos por categoría</h2><div class="panel-sub" id="g-resumen">—</div></div></div><div id="g-grafica"></div></section><div id="g-lista" class="lista mt"></div>`);
  const cargar = async () => {
    $('#g-lista', cont).innerHTML = String(cargando(2));
    try {
      const gs = await api.get('/api/gastos' + api.qs(periodo === 'todo' ? {} : rangoDe(periodo)));
      const porCat = {};
      gs.forEach((g) => { porCat[g.categoria] = (porCat[g.categoria] || 0) + g.valor; });
      $('#g-resumen', cont).textContent = `Total ${fmt.cop(gs.reduce((s, g) => s + g.valor, 0))} en ${gs.length} gasto(s)`;
      barrasH($('#g-grafica', cont), { items: Object.entries(porCat).sort((a, b) => b[1] - a[1]).map(([c, v]) => ({ etiqueta: c, valor: v, nombreValor: 'Gastado', sub: `${gs.filter((g) => g.categoria === c).length} registro(s)` })), formato: fmt.cop, vacio: 'Sin gastos en el periodo' });
      $('#g-lista', cont).innerHTML = gs.length ? gs.map((g) => `<div class="item"><div class="cuerpo"><div class="titulo">${esc(g.categoria)}</div><div class="sub">${fmt.fechaHora(g.fecha)} · ${esc(g.descripcion || '')} · ${esc(nombreMetodo(g.metodo_pago))} · ${esc(g.usuario_nombre || '')}${g.comprobante_ruta ? ` · <a href="/api/archivos/${esc(g.comprobante_ruta)}" target="_blank">comprobante</a>` : ''}</div></div><div class="fin"><div class="valor">${fmt.cop(g.valor)}</div>${estado.tiene('caja.operar') ? `<button class="btn chico fantasma" data-del="${g.id}">${icono('trash', 16)}</button>` : ''}</div></div>`).join('') : String(vacio('Sin gastos en el periodo'));
      $$('[data-del]', cont).forEach((b) => b.addEventListener('click', async () => { if (await confirmar('¿Anular este gasto?', { peligro: true, textoOk: 'Anular' })) { await api.del(`/api/gastos/${b.dataset.del}`); cargar(); } }));
    } catch (e) { mostrarError(e); }
  };
  $$('[data-p]', cont).forEach((b) => b.addEventListener('click', () => { periodo = b.dataset.p; $$('[data-p]', cont).forEach((x) => x.classList.toggle('activo', x === b)); cargar(); }));
  const bn = $('#g-nuevo', cont);
  if (bn) bn.addEventListener('click', () => {
    let comprobante = null;
    const cats = estado.config.categorias_gasto || ['Otros gastos'];
    const metodos = estado.config.metodos_pago || ['efectivo'];
    modal({ titulo: 'Registrar gasto', cuerpo: `<div class="grid2"><div class="campo"><label>Categoría</label><select id="ng-cat">${cats.map((c) => `<option>${esc(c)}</option>`).join('')}</select></div><div class="campo"><label>Valor *</label><input id="ng-valor" data-money></div><div class="campo"><label>Método</label><select id="ng-metodo">${metodos.map((m) => `<option value="${esc(m)}">${esc(nombreMetodo(m))}</option>`).join('')}</select></div><div class="campo"><label>Fecha</label><input id="ng-fecha" type="date" value="${hoyISO()}"></div></div><div class="campo"><label>Descripción</label><input id="ng-desc"></div><button type="button" class="btn suave bloque" id="ng-foto">${icono('camera')} Adjuntar soporte</button>`,
      acciones: [{ texto: 'Guardar gasto', clase: 'primario', alHacerClic: async ({ modal: m }) => { await api.post('/api/gastos', { categoria: $('#ng-cat', m).value, valor: leerDinero($('#ng-valor', m)), metodo_pago: $('#ng-metodo', m).value, fecha: $('#ng-fecha', m).value, descripcion: $('#ng-desc', m).value, comprobante }); toast('Gasto registrado', 'ok'); cargar(); } }],
      alMontar: (m) => $('#ng-foto', m).addEventListener('click', async () => { const f = await capturar({ camara: true }); if (f) { comprobante = f.dataUrl; $('#ng-foto', m).innerHTML = `${icono('check')} Soporte adjunto`; } }) });
  });
  cargar();
}

async function vistaPorPagar(cont) {
  cont.innerHTML = String(cargando(2));
  try {
    const r = await api.get('/api/compras?con_saldo=1&limite=300');
    const total = r.compras.reduce((s, c) => s + c.saldo_pendiente, 0);
    renderizar(cont, html`<div class="kpis mb"><div class="kpi"><div class="et">Total por pagar</div><div class="va neg">${fmt.cop(total)}</div></div><div class="kpi"><div class="et">Facturas</div><div class="va">${r.compras.length}</div><div class="de">${r.compras.filter((c) => c.fecha_vencimiento && c.fecha_vencimiento < hoyISO()).length} vencida(s)</div></div></div>
      ${r.compras.length ? html`<div class="lista">${r.compras.map((c) => html`<div class="item"><div class="cuerpo"><a class="titulo" href="#/compras/${c.id}">${c.proveedor_nombre || 'Sin proveedor'}</a><div class="sub">${c.numero}${c.numero_factura ? ' · Fact. ' + c.numero_factura : ''} · ${fmt.fecha(c.fecha)}${c.fecha_vencimiento ? html` · <span class="${c.fecha_vencimiento < hoyISO() ? 'neg bold' : ''}">vence ${fmt.fecha(c.fecha_vencimiento)}</span>` : ''}</div></div><div class="fin"><div class="valor neg">${fmt.cop(c.saldo_pendiente)}</div>${estado.tiene('compras.pagar') ? html`<button class="btn chico primario" data-pagar="${c.id}">Pagar</button>` : ''}</div></div>`)}</div>` : vacio('No hay facturas pendientes')}`);
    $$('[data-pagar]', cont).forEach((b) => b.addEventListener('click', () => pagarCompra(r.compras.find((c) => c.id === Number(b.dataset.pagar)), () => vistaPorPagar(cont))));
  } catch (e) { mostrarError(e); }
}

async function vistaHistorial(cont) {
  cont.innerHTML = String(cargando(2));
  try {
    const d = await api.get('/api/caja');
    const cerradas = d.historial.filter((s) => s.estado === 'cerrada');
    renderizar(cont, html`${cerradas.length ? html`<div class="lista">${cerradas.map((s) => html`<a class="item" href="#" data-s="${s.id}"><div class="cuerpo"><div class="titulo">${fmt.fechaHora(s.abierta_en)} → ${fmt.fechaHora(s.cerrada_en)}</div><div class="sub">abrió ${s.usuario_apertura || ''} · cerró ${s.usuario_cierre || ''} · esperado ${fmt.cop(s.efectivo_esperado)} · contado ${fmt.cop(s.efectivo_contado)}</div></div><div class="fin"><div class="valor ${s.diferencia ? 'neg' : 'pos'}">${s.diferencia ? fmt.cop(s.diferencia) : 'Cuadrada'}</div></div></a>`)}</div>` : vacio('Aún no hay cierres de caja')}`);
    $$('[data-s]', cont).forEach((a) => a.addEventListener('click', async (e) => {
      e.preventDefault();
      const s = await api.get(`/api/caja/${a.dataset.s}`);
      const r = s.resumen;
      modal({ titulo: `Cierre de caja #${s.id}`, cuerpo: `<dl class="kv"><dt>Apertura</dt><dd>${fmt.fechaHora(s.abierta_en)}</dd><dt>Cierre</dt><dd>${fmt.fechaHora(s.cerrada_en)}</dd><dt>Base</dt><dd>${fmt.cop(r.base_inicial)}</dd><dt>Ventas facturadas</dt><dd>${fmt.cop(r.ventas_facturadas)}</dd><dt>Crédito otorgado</dt><dd>${fmt.cop(r.credito_otorgado)}</dd><dt>Recibido</dt><dd>${fmt.cop(r.total_ingresos)}</dd>${Object.entries(r.ingresos || {}).map(([m, v]) => `<dt>&nbsp;&nbsp;${esc(nombreMetodo(m))}</dt><dd>${fmt.cop(v)}</dd>`).join('')}<dt>Egresos</dt><dd>${fmt.cop(r.total_egresos + r.salidas)}</dd><dt>Efectivo esperado</dt><dd>${fmt.cop(s.efectivo_esperado)}</dd><dt>Efectivo contado</dt><dd>${fmt.cop(s.efectivo_contado)}</dd><dt>Diferencia</dt><dd class="${s.diferencia ? 'neg' : ''}">${fmt.cop(s.diferencia)}</dd></dl>${s.notas ? `<p class="small muted mt">${esc(s.notas)}</p>` : ''}` });
    }));
  } catch (e) { mostrarError(e); }
}
