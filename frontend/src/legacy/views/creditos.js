import { api } from '../../lib/api';
import { estado, navegar } from '../../lib/estado';
import { $, $$, html, raw, render as renderizar, fmt, icono, badge, ESTADOS_CREDITO, nombreMetodo, toast, modal, confirmar, mostrarError, debounce, activarDinero, leerDinero, leerDecimal, vacio, cargando, esc, selectorBusqueda, hoyISO, tabla } from '../ui.js';
import { capturar } from '../camera.js';
import { campoTasa } from './compras.js';

export async function render(root, { partes, query, setTopbar }) {
  const [id] = partes;
  if (!id) return lista(root, query, setTopbar);
  return detalle(root, Number(id), setTopbar);
}

async function lista(root, query, setTopbar) {
  setTopbar({ titulo: 'Créditos y cartera', acciones: estado.tiene('creditos.abonar') ? [{ icono: 'cash', titulo: 'Registrar abono', alHacerClic: elegirCreditoParaAbono }] : [] });
  const f = { estado: query.estado || 'vigentes', q: '' };
  renderizar(root, html`<div class="pills">${[['vigentes', 'Vigentes'], ['vencido', 'Vencidos'], ['proximo', 'Por vencer'], ['parcial', 'Parciales'], ['al_dia', 'Al día'], ['pagado', 'Pagados']].map(([v, t]) => html`<button class="pill ${f.estado === v ? 'activo' : ''}" data-e="${v}">${t}</button>`)}</div>
    <div class="buscador mt">${raw(icono('search'))}<input type="search" id="cr-q" placeholder="Cliente, teléfono o número de crédito"></div>
    <div class="kpis mt" id="cr-kpis"></div><div id="cr-lista" class="lista mt"></div>`);
  const cargar = async () => {
    $('#cr-lista', root).innerHTML = String(cargando(3));
    try {
      const cs = await api.get('/api/creditos' + api.qs({ estado: f.estado, q: f.q }));
      const saldo = cs.reduce((s, c) => s + c.saldo_actual, 0);
      const vencidos = cs.filter((c) => c.estado === 'vencido');
      $('#cr-kpis', root).innerHTML = `<div class="kpi"><div class="et">Créditos</div><div class="va">${cs.length}</div></div><div class="kpi"><div class="et">Saldo pendiente</div><div class="va ${saldo ? 'neg' : ''}">${fmt.cop(saldo)}</div></div><div class="kpi"><div class="et">Vencidos</div><div class="va">${vencidos.length}</div><div class="de">${fmt.cop(vencidos.reduce((s, c) => s + c.saldo_actual, 0))}</div></div><div class="kpi"><div class="et">Abonado</div><div class="va">${fmt.cop(cs.reduce((s, c) => s + c.total_abonado, 0))}</div></div>`;
      $('#cr-lista', root).innerHTML = cs.length ? cs.map((c) => `<a class="item" href="#/creditos/${c.id}"><div class="cuerpo"><div class="titulo">${esc(c.cliente_nombre)}</div><div class="sub">${esc(c.numero)} · ${c.venta_numero ? esc(c.venta_numero) + ' · ' : ''}${c.numero_cuotas} cuota(s) ${esc(c.frecuencia)}${c.proximo_vencimiento ? ' · próx. ' + fmt.fecha(c.proximo_vencimiento) + ' (' + fmt.relativa(c.proximo_vencimiento) + ')' : ''}</div></div><div class="fin"><div class="valor ${c.saldo_actual ? 'neg' : ''}">${fmt.cop(c.saldo_actual)}</div>${badge(ESTADOS_CREDITO, c.estado)}</div></a>`).join('') : String(vacio('No hay créditos con este filtro'));
    } catch (e) { mostrarError(e); }
  };
  $$('[data-e]', root).forEach((b) => b.addEventListener('click', () => { f.estado = b.dataset.e; $$('[data-e]', root).forEach((x) => x.classList.toggle('activo', x === b)); cargar(); }));
  $('#cr-q', root).addEventListener('input', debounce((e) => { f.q = e.target.value.trim(); cargar(); }));
  cargar();
  if (query.abonar) elegirCreditoParaAbono();
}

function elegirCreditoParaAbono() {
  selectorBusqueda({ titulo: 'Abonar a crédito', placeholder: 'Cliente o número', buscar: async (t) => (await api.get('/api/creditos' + api.qs({ estado: 'vigentes', q: t }))).map((c) => ({ id: c.id, titulo: `${c.cliente_nombre} · ${c.numero}`, sub: `saldo ${fmt.cop(c.saldo_actual)}${c.proximo_vencimiento ? ' · próx. ' + fmt.fecha(c.proximo_vencimiento) : ''}`, datos: c })), alElegir: async (it) => { const c = await api.get(`/api/creditos/${it.id}`); registrarAbono(c, () => navegar(`#/creditos/${c.id}`)); } });
}

export function registrarAbono(c, alTerminar) {
  const metodos = estado.config.metodos_pago || ['efectivo'];
  const prox = c.proxima_cuota ? c.proxima_cuota.valor - c.proxima_cuota.pagado : c.saldo_actual;
  let comprobante = null;
  if (c.moneda === 'USD') {
    const proxM = c.proxima_cuota ? Math.round(((c.proxima_cuota.valor_moneda || 0) - (c.proxima_cuota.pagado_moneda || 0)) * 100) / 100 : c.saldo_moneda;
    let tasa = null;
    return modal({
      titulo: `Abono en USD · ${c.cliente_nombre}`,
      cuerpo: `<div class="row between"><span class="muted small">Saldo</span><b class="num">${fmt.usd(c.saldo_moneda)} <span class="muted xs">(≈ ${fmt.cop(c.saldo_actual)} a la tasa de la venta ${fmt.tasa(c.tasa_cambio)})</span></b></div>
        <div class="row wrap gap mt"><button type="button" class="btn chico suave" data-v="${proxM}">Cuota: ${fmt.usd(proxM)}</button><button type="button" class="btn chico suave" data-v="${c.saldo_moneda}">Todo: ${fmt.usd(c.saldo_moneda)}</button></div>
        <div class="grid2 mt"><div class="campo"><label>Valor del abono en USD *</label><input id="ab-usd" type="number" step="0.01" min="0.01" max="${c.saldo_moneda}" inputmode="decimal" value="${proxM}"></div><div class="campo"><label>Método</label><select id="ab-metodo">${metodos.map((m) => `<option value="${esc(m)}">${esc(nombreMetodo(m))}</option>`).join('')}</select></div></div>
        <div id="ab-tasa"></div><div class="alerta neutra mt small" id="ab-preview">—</div>
        <div class="grid2 mt"><div class="campo"><label>Fecha</label><input id="ab-fecha" type="date" value="${hoyISO()}"></div><div class="campo"><label>Referencia</label><input id="ab-ref" placeholder="N° transacción"></div></div>
        <div class="campo"><label>Nota</label><input id="ab-nota"></div><button type="button" class="btn suave bloque" id="ab-foto">${icono('camera')} Adjuntar comprobante</button>`,
      acciones: [{ texto: 'Registrar abono', clase: 'primario', alHacerClic: async ({ modal: m }) => { const r = await api.post(`/api/creditos/${c.id}/abonos`, { valor_moneda: leerDecimal($('#ab-usd', m)), ...tasa.datos(), metodo_pago: $('#ab-metodo', m).value, fecha: $('#ab-fecha', m).value, referencia: $('#ab-ref', m).value, nota: $('#ab-nota', m).value, comprobante }); toast(`Abono registrado. Saldo: ${fmt.usd(r.credito.saldo_moneda)}`, 'ok'); alTerminar(r.credito); } }],
      alMontar: (m) => {
        const preview = () => { const u = leerDecimal($('#ab-usd', m)); const t = tasa ? tasa.valor() : 0; const dif = Math.round(u * (t - c.tasa_cambio)); $('#ab-preview', m).innerHTML = t ? `Recibes <b>${fmt.usd(u)}</b> × ${fmt.tasa(t)} = <b>${fmt.cop(u * t)}</b>. Diferencia cambiaria frente a la venta: <b class="${dif < 0 ? 'neg' : 'pos'}">${fmt.signo(dif)}</b>${dif > 0 ? ' (el dólar subió)' : dif < 0 ? ' (el dólar bajó)' : ''}` : 'Indica la tasa del abono.'; };
        tasa = campoTasa($('#ab-tasa', m), { fecha: hoyISO(), alCambiar: preview });
        $('#ab-usd', m).addEventListener('input', preview);
        $('#ab-fecha', m).addEventListener('change', (e) => tasa.consultar(e.target.value));
        $$('[data-v]', m).forEach((b) => b.addEventListener('click', () => { $('#ab-usd', m).value = b.dataset.v; preview(); }));
        $('#ab-foto', m).addEventListener('click', async () => { const f = await capturar({ camara: true }); if (f) { comprobante = f.dataUrl; $('#ab-foto', m).innerHTML = `${icono('check')} Comprobante adjunto`; } });
      },
    });
  }
  modal({
    titulo: `Abono · ${c.cliente_nombre}`,
    cuerpo: `<div class="row between"><span class="muted small">Saldo actual</span><b class="num">${fmt.cop(c.saldo_actual)}</b></div>
      <div class="row wrap gap mt"><button type="button" class="btn chico suave" data-v="${prox}">Cuota: ${fmt.cop(prox)}</button><button type="button" class="btn chico suave" data-v="${c.saldo_actual}">Todo: ${fmt.cop(c.saldo_actual)}</button></div>
      <div class="grid2 mt"><div class="campo"><label>Valor del abono *</label><input id="ab-valor" data-money value="${prox}"></div><div class="campo"><label>Método</label><select id="ab-metodo">${metodos.map((m) => `<option value="${esc(m)}">${esc(nombreMetodo(m))}</option>`).join('')}</select></div><div class="campo"><label>Fecha</label><input id="ab-fecha" type="date" value="${hoyISO()}"></div><div class="campo"><label>Referencia</label><input id="ab-ref" placeholder="N° transacción"></div></div>
      <div class="campo"><label>Nota</label><input id="ab-nota"></div><button type="button" class="btn suave bloque" id="ab-foto">${icono('camera')} Adjuntar comprobante</button>`,
    acciones: [{ texto: 'Registrar abono', clase: 'primario', alHacerClic: async ({ modal: m }) => { const r = await api.post(`/api/creditos/${c.id}/abonos`, { valor: leerDinero($('#ab-valor', m)), metodo_pago: $('#ab-metodo', m).value, fecha: $('#ab-fecha', m).value, referencia: $('#ab-ref', m).value, nota: $('#ab-nota', m).value, comprobante }); toast(`Abono registrado. Saldo: ${fmt.cop(r.credito.saldo_actual)}`, 'ok'); alTerminar(r.credito); } }],
    alMontar: (m) => { $$('[data-v]', m).forEach((b) => b.addEventListener('click', () => { $('#ab-valor', m).value = b.dataset.v; $('#ab-valor', m).dispatchEvent(new Event('blur')); })); $('#ab-foto', m).addEventListener('click', async () => { const f = await capturar({ camara: true }); if (f) { comprobante = f.dataUrl; $('#ab-foto', m).innerHTML = `${icono('check')} Comprobante adjunto`; } }); },
  });
}

async function detalle(root, id, setTopbar) {
  let c;
  try { c = await api.get(`/api/creditos/${id}`); } catch (e) { mostrarError(e); return navegar('#/creditos', true); }
  setTopbar({ titulo: `Crédito ${c.numero}`, atras: '#/creditos', acciones: [{ icono: 'download', titulo: 'Estado de cuenta PDF', href: `/api/clientes/${c.cliente_id}/estado-cuenta/pdf` }] });
  const activo = !['pagado', 'anulado'].includes(c.estado);
  renderizar(root, html`<div class="card">
      <div class="row between"><div><a href="#/clientes/${c.cliente_id}"><h2 style="margin:0">${c.cliente_nombre}</h2></a><div class="muted small">${c.cliente_telefono || ''} · ${fmt.fecha(c.fecha)}${c.venta_numero ? ' · venta ' + c.venta_numero : ''} · responsable ${c.responsable_nombre || ''}</div></div>${badge(ESTADOS_CREDITO, c.estado)}</div>
      <div class="center mt"><div class="muted xs">Saldo pendiente</div><div class="hero-num ${c.saldo_actual ? 'neg' : 'pos'}">${c.moneda === 'USD' ? fmt.usd(c.saldo_moneda) : fmt.cop(c.saldo_actual)}</div>${c.moneda === 'USD' ? html`<div class="small muted">≈ ${fmt.cop(c.saldo_actual)} a la tasa de la venta (${fmt.tasa(c.tasa_cambio)}). Cada abono se registra con la tasa del día.</div>` : ''}</div>
      <dl class="kv mt"><dt>Valor de la venta</dt><dd>${fmt.cop(c.valor_total)}</dd><dt>Cuota inicial</dt><dd>${fmt.cop(c.cuota_inicial)}</dd><dt>Saldo financiado${c.interes_pct ? ` (interés ${c.interes_pct}%)` : ''}</dt><dd>${c.moneda === 'USD' ? `${fmt.usd(c.saldo_financiado_moneda)} (${fmt.cop(c.saldo_financiado)})` : fmt.cop(c.saldo_financiado)}</dd><dt>Plan</dt><dd>${c.numero_cuotas} cuota(s) ${c.frecuencia} de ${c.moneda === 'USD' ? fmt.usd(c.cuotas[0] ? c.cuotas[0].valor_moneda : 0) : fmt.cop(c.valor_cuota)}</dd><dt>Abonado</dt><dd class="pos">${c.moneda === 'USD' ? `${fmt.usd(c.total_abonado_moneda)} (${fmt.cop(c.total_abonado)} recibidos)` : fmt.cop(c.total_abonado)}</dd>${c.diferencias_cambiarias && c.diferencias_cambiarias.length ? html`<dt>Diferencia cambiaria realizada</dt><dd class="${c.diferencias_cambiarias.reduce((s, d) => s + d.diferencia, 0) < 0 ? 'neg' : 'pos'}">${fmt.signo(c.diferencias_cambiarias.reduce((s, d) => s + d.diferencia, 0))}</dd>` : ''}</dl>
      ${c.items.length ? html`<div class="muted small mt">${c.items.map((i) => `${i.cantidad} × ${i.nombre_producto}`).join(', ')}</div>` : ''}
      ${c.condiciones ? html`<p class="small mt" style="white-space:pre-line">${c.condiciones}</p>` : ''}
      <div class="row wrap mt gap">${activo && estado.tiene('creditos.abonar') ? html`<button class="btn primario" id="cr-abonar">${raw(icono('cash'))} Registrar abono</button>` : ''}<button class="btn suave" id="cr-wa">${raw(icono('whatsapp'))} Enviar estado de cuenta</button>${activo && estado.tiene('creditos.modificar') ? html`<button class="btn suave" id="cr-mod">${raw(icono('edit'))} Modificar</button>` : ''}</div>
    </div>
    <div class="card"><h2>Cuotas</h2>${c.moneda === 'USD'
      ? tabla([{ titulo: '#', clave: 'numero', num: true }, { titulo: 'Vence', valor: (q) => fmt.fecha(q.fecha_vencimiento) }, { titulo: 'Valor USD', valor: (q) => fmt.usd(q.valor_moneda), num: true }, { titulo: 'Pagado USD', valor: (q) => fmt.usd(q.pagado_moneda), num: true }, { titulo: 'Pendiente USD', valor: (q) => fmt.usd(Math.round(((q.valor_moneda || 0) - (q.pagado_moneda || 0)) * 100) / 100), num: true }, { titulo: 'Ref. COP', clave: 'valor', dinero: true }, { titulo: 'Estado', valor: (q) => (q.estado === 'pagada' ? '✓ Pagada' : q.fecha_vencimiento < hoyISO() ? '⚠ Vencida' : q.estado === 'parcial' ? 'Parcial' : 'Pendiente') }], c.cuotas)
      : tabla([{ titulo: '#', clave: 'numero', num: true }, { titulo: 'Vence', valor: (q) => fmt.fecha(q.fecha_vencimiento) }, { titulo: 'Valor', clave: 'valor', dinero: true }, { titulo: 'Pagado', clave: 'pagado', dinero: true }, { titulo: 'Pendiente', valor: (q) => q.valor - q.pagado, dinero: true }, { titulo: 'Estado', valor: (q) => (q.estado === 'pagada' ? '✓ Pagada' : q.fecha_vencimiento < hoyISO() ? '⚠ Vencida' : q.estado === 'parcial' ? 'Parcial' : 'Pendiente') }], c.cuotas)}</div>
    <div class="card"><h2>Historial de abonos</h2>${c.abonos.length ? html`<div class="col">${c.abonos.map((a) => html`<div class="row between small ${a.anulado ? 'muted' : ''}"><span>${fmt.fechaHora(a.fecha)} · ${nombreMetodo(a.metodo_pago)}${a.moneda === 'USD' ? ` · ${fmt.usd(a.valor_moneda)} a ${fmt.tasa(a.tasa_cambio)}` : ''}${a.referencia ? ' · ' + a.referencia : ''} · ${a.usuario_nombre || ''}${a.anulado ? ' (anulado)' : ''}${a.comprobante_ruta ? raw(` · <a href="/api/archivos/${esc(a.comprobante_ruta)}" target="_blank">comprobante</a>`) : ''}${a.nota ? ' · ' + a.nota : ''}</span><b class="num">${fmt.cop(a.valor)}</b></div>`)}</div>` : html`<p class="muted">Sin abonos todavía.</p>`}</div>`);
  const ba = $('#cr-abonar', root);
  if (ba) ba.addEventListener('click', () => registrarAbono(c, () => detalle(root, id, setTopbar)));
  $('#cr-wa', root).addEventListener('click', async () => { const s = await api.get(`/api/clientes/${c.cliente_id}/estado-cuenta/compartir`); window.open(s.whatsapp, '_blank'); });
  const bm = $('#cr-mod', root);
  if (bm) bm.addEventListener('click', () => modal({
    titulo: 'Modificar crédito',
    cuerpo: `<div class="campo"><label>Condiciones</label><textarea id="md-cond">${esc(c.condiciones || '')}</textarea></div><label class="check"><input type="checkbox" id="md-repro"> Reprogramar las cuotas pendientes (saldo ${fmt.cop(c.saldo_actual)})</label><div id="md-plan" hidden class="grid3 mt"><div class="campo"><label>Cuotas</label><input id="md-n" type="number" min="1" value="${c.cuotas.filter((q) => q.estado !== 'pagada').length || 1}"></div><div class="campo"><label>Frecuencia</label><select id="md-f">${['semanal', 'quincenal', 'mensual'].map((f) => `<option value="${f}" ${c.frecuencia === f ? 'selected' : ''}>${f}</option>`).join('')}</select></div><div class="campo"><label>Primera fecha</label><input id="md-fecha" type="date" value="${hoyISO()}"></div></div><p class="muted xs">Todo cambio queda en el historial de auditoría.</p>`,
    acciones: [{ texto: 'Guardar', clase: 'primario', alHacerClic: async ({ modal: m }) => { await api.put(`/api/creditos/${id}`, { condiciones: $('#md-cond', m).value, reprogramar: $('#md-repro', m).checked, numero_cuotas: Number($('#md-n', m).value), frecuencia: $('#md-f', m).value, primera_fecha: $('#md-fecha', m).value }); toast('Crédito actualizado', 'ok'); detalle(root, id, setTopbar); } }],
    alMontar: (m) => $('#md-repro', m).addEventListener('change', (e) => { $('#md-plan', m).hidden = !e.target.checked; }),
  }));
}
