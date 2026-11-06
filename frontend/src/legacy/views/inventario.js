import { api } from '../../lib/api';
import { estado, navegar } from '../../lib/estado';
import { $, $$, html, raw, render as renderizar, fmt, icono, badge, ESTADOS_PRODUCTO, stockBadge, miniatura, toast, modal, confirmar, mostrarError, debounce, activarDinero, datosForm, leerDinero, vacio, tabla, cargando, esc } from '../ui.js';
import { escanear } from '../scanner.js';
import { capturar } from '../camera.js';
import { panelInventario } from '../paneles.js';

export async function render(root, { partes, query, setTopbar }) {
  const [id, sub] = partes;
  if (!id) return lista(root, query, setTopbar);
  if (id === 'nuevo') return formulario(root, null, setTopbar, query);
  if (sub === 'editar') return formulario(root, Number(id), setTopbar);
  return detalle(root, Number(id), setTopbar);
}

// ---------- Lista ----------
async function lista(root, query, setTopbar) {
  setTopbar({ titulo: 'Inventario', acciones: estado.tiene('inventario.editar') ? [{ icono: 'plus', titulo: 'Agregar producto', href: '#/inventario/nuevo' }] : [] });
  const cats = await api.get('/api/categorias');
  const filtros = { q: query.q || '', categoria_id: query.categoria_id || '', filtro: query.filtro || '' };
  const veResumen = estado.tiene('inventario.ver');
  let verResumen = veResumen && sessionStorage.getItem('inventario.resumen') !== '0' && !filtros.filtro && !filtros.q;
  renderizar(root, html`
    ${veResumen ? html`<div class="row between mb"><h2 style="margin:0">Estado del inventario</h2><button class="btn chico suave" id="inv-toggle">${verResumen ? 'Ocultar resumen' : 'Ver resumen'}</button></div><div id="inv-panel" class="mb" ${verResumen ? '' : 'hidden'}></div><h2 class="mb">Productos</h2>` : ''}
    <div class="buscador">${raw(icono('search'))}<input type="search" id="inv-q" placeholder="Buscar licor, marca, presentación o código" value="${filtros.q}" autocomplete="off"><button class="btn icono" id="inv-scan" title="Escanear">${raw(icono('scan'))}</button></div>
    <div class="row mt gap">
      <select id="inv-cat" class="grow"><option value="">Todas las categorías</option>${cats.filter((c) => !c.padre_id).map((c) => html`<option value="${c.id}" ${String(c.id) === String(filtros.categoria_id) ? 'selected' : ''}>${c.nombre}</option>`)}</select>
    </div>
    <div class="pills mt">
      ${[['', 'Todos'], ['stock_bajo', 'Pocas unidades'], ['agotados', 'Agotados'], ['descontinuado', 'Descontinuados'], ['inactivo', 'Inactivos']].map(([v, t]) => html`<button class="pill ${filtros.filtro === v ? 'activo' : ''}" data-filtro="${v}">${t}</button>`)}
    </div>
    <div id="inv-resumen" class="muted small mt"></div>
    <div id="inv-lista" class="lista mt"></div>
    <div id="inv-mas" class="mt center"></div>
  `);
  let pagina = 1;
  const cargar = async (anexar = false) => {
    if (!anexar) { pagina = 1; $('#inv-lista', root).innerHTML = String(cargando(3)); }
    const params = { q: filtros.q, categoria_id: filtros.categoria_id, pagina, limite: 60 };
    if (filtros.filtro === 'stock_bajo') params.stock_bajo = 1;
    else if (filtros.filtro === 'agotados') params.agotados = 1;
    else if (filtros.filtro) params.estado = filtros.filtro;
    try {
      const r = await api.get('/api/productos' + api.qs(params));
      const filas = r.productos.map((p) => html`<a class="item" href="#/inventario/${p.id}">
          ${raw(miniatura(p, 'thumb grande'))}
          <div class="cuerpo"><div class="titulo">${p.nombre}</div><div class="sub">${[p.marca, p.categoria_nombre + (p.subcategoria_nombre ? ' › ' + p.subcategoria_nombre : ''), p.modelo_compatible].filter(Boolean).join(' · ')}</div>
            <div class="sub"><b class="precio-detal">${fmt.cop(p.precio_venta)}</b>${p.precio_mayor > 0 ? html` · <span class="precio-mayor">mayor ${fmt.cop(p.precio_mayor)}</span>` : ''}${estado.tiene('inventario.ver') ? ` · costo ${fmt.cop(p.precio_compra)}` : ''}${p.requiere_serial ? ' · serial' : ''}</div></div>
          <div class="fin">${stockBadge(p.stock, p.stock_minimo)}${p.estado !== 'activo' ? html`<div class="mt" style="margin-top:4px">${badge(ESTADOS_PRODUCTO, p.estado)}</div>` : ''}</div></a>`);
      if (anexar) $('#inv-lista', root).insertAdjacentHTML('beforeend', filas.map(String).join(''));
      else $('#inv-lista', root).innerHTML = filas.length ? filas.map(String).join('') : String(vacio('No hay productos con ese filtro', estado.tiene('inventario.editar') ? '<a class="btn primario mt" href="#/inventario/nuevo">Agregar producto</a>' : ''));
      $('#inv-resumen', root).textContent = `${r.total} producto(s)`;
      const mas = $('#inv-mas', root);
      mas.innerHTML = r.total > pagina * 60 ? '<button class="btn suave" id="inv-mas-btn">Cargar más</button>' : '';
      const b = $('#inv-mas-btn', root); if (b) b.addEventListener('click', () => { pagina += 1; cargar(true); });
    } catch (e) { mostrarError(e); }
  };
  if (veResumen) {
    const cargarPanel = () => panelInventario($('#inv-panel', root), { dias: estado.config.dias_sin_movimiento || 30 }).catch((e) => { if (e.status !== 403) mostrarError(e); });
    if (verResumen) cargarPanel();
    $('#inv-toggle', root).addEventListener('click', () => { verResumen = !verResumen; sessionStorage.setItem('inventario.resumen', verResumen ? '1' : '0'); $('#inv-panel', root).hidden = !verResumen; $('#inv-toggle', root).textContent = verResumen ? 'Ocultar resumen' : 'Ver resumen'; if (verResumen && !$('#inv-panel', root).innerHTML.trim()) cargarPanel(); });
  }
  $('#inv-q', root).addEventListener('input', debounce((e) => { filtros.q = e.target.value.trim(); cargar(); }, 250));
  $('#inv-cat', root).addEventListener('change', (e) => { filtros.categoria_id = e.target.value; cargar(); });
  $$('[data-filtro]', root).forEach((b) => b.addEventListener('click', () => { filtros.filtro = b.dataset.filtro; $$('[data-filtro]', root).forEach((x) => x.classList.toggle('activo', x === b)); cargar(); }));
  $('#inv-scan', root).addEventListener('click', async () => {
    const c = await escanear();
    if (!c) return;
    try { const p = await api.get(`/api/productos/codigo/${encodeURIComponent(c)}`); navegar(`#/inventario/${p.id}`); } catch (e) {
      if (e.status === 404 && estado.tiene('inventario.editar')) { if (await confirmar(`No existe un producto con el código ${c}. ¿Quieres crearlo?`, { textoOk: 'Crear producto' })) navegar(`#/inventario/nuevo?codigo=${encodeURIComponent(c)}`); }
      else mostrarError(e);
    }
  });
  cargar();
}

// ---------- Detalle ----------
async function detalle(root, id, setTopbar) {
  let p;
  try { p = await api.get(`/api/productos/${id}`); } catch (e) { mostrarError(e); return navegar('#/inventario', true); }
  const veCostos = estado.tiene('inventario.ver');
  const acciones = [];
  if (estado.tiene('inventario.editar') || estado.tiene('inventario.cambiar_precio')) acciones.push({ icono: 'edit', titulo: 'Editar', href: `#/inventario/${id}/editar` });
  setTopbar({ titulo: p.nombre, atras: '#/inventario', acciones });
  const margenReal = p.precio_venta > 0 && p.stock > 0 ? ((p.precio_venta - p.valor_costo / p.stock) * 100) / p.precio_venta : p.margen_pct;
  const lotesDisp = (p.lotes || []).filter((l) => l.cantidad_restante > 0 && l.estado !== 'anulado');
  renderizar(root, html`
    <div class="card">
      <div class="row" style="align-items:flex-start">
        <div class="thumb ficha-foto">${p.fotos && p.fotos.length ? html`<img src="/api/archivos/${p.fotos[0].ruta}" alt="">` : raw(icono('bottle', 34))}</div>
        <div class="grow">
          <div class="row wrap gap">${badge(ESTADOS_PRODUCTO, p.estado)}${p.requiere_serial ? html`<span class="badge neutro">Control por serial / estampilla</span>` : ''}${p.categoria_nombre ? html`<span class="badge neutro">${p.categoria_nombre}${p.subcategoria_nombre ? ' › ' + p.subcategoria_nombre : ''}</span>` : ''}</div>
          <div class="muted small mt">${[p.marca, p.capacidad, p.modelo_compatible, p.referencia && 'Ref. ' + p.referencia, p.color].filter(Boolean).join(' · ')}</div>
          <div class="muted xs mono">${p.sku}${p.codigo_barras ? ' · ' + p.codigo_barras : ''}${p.ubicacion ? ' · ' + p.ubicacion : ''}</div>
        </div>
      </div>
      <div class="grid3 mt">
        <div><div class="muted xs">Precio al detal</div><div class="bold num" style="font-size:18px">${fmt.cop(p.precio_venta)}</div></div>
        <div><div class="muted xs">Precio al por mayor</div><div class="bold num precio-mayor" style="font-size:18px">${p.precio_mayor > 0 ? fmt.cop(p.precio_mayor) : '—'}</div><div class="muted xs">${p.precio_mayor > 0 ? `desde ${estado.config.unidades_mayor || 10} und o a mayoristas` : 'sin tarifa mayorista'}</div></div>
        ${veCostos ? html`<div><div class="muted xs">Costo de referencia</div><div class="bold num" style="font-size:18px">${fmt.cop(p.precio_compra)}</div></div>
        <div><div class="muted xs">Margen</div><div class="bold num" style="font-size:18px">${fmt.pct(margenReal)}</div></div>` : ''}
        <div><div class="muted xs">Stock actual</div><div class="row">${stockBadge(p.stock, p.stock_minimo)}<span class="muted xs">mín. ${p.stock_minimo}</span></div></div>
        ${veCostos ? html`<div><div class="muted xs">Valor al costo</div><div class="bold num">${fmt.cop(p.valor_costo)}</div></div>` : ''}
        <div><div class="muted xs">Vendidos</div><div class="bold num">${p.ventas_resumen.unidades} und</div><div class="muted xs">${p.ventas_resumen.ultima_venta ? 'última ' + fmt.fecha(p.ventas_resumen.ultima_venta) : 'sin ventas'}</div></div>
      </div>
      ${p.descripcion ? html`<p class="small mt">${p.descripcion}</p>` : ''}
      <div class="row wrap mt gap">
        ${estado.tiene('ventas.crear') && p.stock > 0 ? html`<a class="btn negro" href="#/vender?producto=${p.id}">${raw(icono('cart'))} Vender</a>` : ''}
        ${estado.tiene('inventario.ajustar') ? html`<button class="btn suave" id="p-ajustar">${raw(icono('layers'))} Ajustar stock</button>` : ''}
        ${estado.tiene('inventario.editar') ? html`<button class="btn suave" id="p-foto">${raw(icono('camera'))} Foto</button>` : ''}
        ${estado.tiene('compras.crear') ? html`<a class="btn suave" href="#/compras/nueva?producto=${p.id}">${raw(icono('truck'))} Comprar</a>` : ''}
      </div>
      ${p.fotos && p.fotos.length ? html`<div class="fotos mt">${p.fotos.map((f) => html`<div class="foto"><img src="/api/archivos/${f.ruta}" alt="">${estado.tiene('inventario.editar') ? html`<button data-foto="${f.id}" aria-label="Eliminar foto">×</button>` : ''}</div>`)}</div>` : ''}
    </div>
    ${veCostos ? html`
    <div class="tabs mt-l"><button class="activo" data-tab="lotes">Lotes (${lotesDisp.length})</button><button data-tab="finanzas">Finanzas</button><button data-tab="kardex">Movimientos</button><button data-tab="precios">Precios</button><button data-tab="proveedores">Proveedores</button></div>
    <div id="tab-finanzas" hidden></div>
    <div id="tab-lotes">
      ${p.lotes.length ? tabla([
        { titulo: 'Fecha', valor: (l) => fmt.fecha(l.fecha) }, { titulo: 'Proveedor', valor: (l) => l.proveedor_nombre || (l.origen === 'compra' ? '—' : l.origen) }, { titulo: 'Compra', valor: (l) => l.compra_numero || '' }, { titulo: 'Serial', valor: (l) => l.serial || '' },
        { titulo: 'Inicial', clave: 'cantidad_inicial', num: true }, { titulo: 'Restantes', clave: 'cantidad_restante', num: true }, { titulo: 'Costo unit.', clave: 'costo_unitario', dinero: true },
        { titulo: 'Ganancia unit.', valor: (l) => p.precio_venta - l.costo_unitario, dinero: true }, { titulo: 'Estado', valor: (l) => ({ disponible: 'Disponible', agotado: 'Agotado', anulado: 'Anulado' }[l.estado]) },
      ], [...p.lotes].reverse()) : vacio('Sin lotes. Registra una compra para ingresar unidades.')}
    </div>
    <div id="tab-kardex" hidden></div>
    <div id="tab-precios" hidden>${tabla([{ titulo: 'Fecha', valor: (h) => fmt.fechaHora(h.fecha) }, { titulo: 'Tipo', valor: (h) => ({ venta: 'Precio al detal', mayor: 'Precio al por mayor' }[h.tipo] || 'Costo') }, { titulo: 'Anterior', clave: 'precio_anterior', dinero: true }, { titulo: 'Nuevo', clave: 'precio_nuevo', dinero: true }, { titulo: 'Usuario', clave: 'usuario_nombre' }, { titulo: 'Motivo', clave: 'motivo' }], p.historial_precios, { vacioTexto: 'Sin cambios de precio' })}</div>
    <div id="tab-proveedores" hidden>${p.proveedores.length ? tabla([{ titulo: 'Proveedor', clave: 'nombre' }, { titulo: 'Último costo', clave: 'ultimo_costo', dinero: true }, { titulo: 'Compras', clave: 'compras', num: true }, { titulo: 'Última compra', valor: (x) => fmt.fecha(x.ultima_fecha) }], [...p.proveedores].sort((a, b) => a.ultimo_costo - b.ultimo_costo)) : vacio('Aún no se ha comprado a ningún proveedor')}</div>` : ''}
  `);
  $$('[data-tab]', root).forEach((b) => b.addEventListener('click', async () => {
    $$('[data-tab]', root).forEach((x) => x.classList.toggle('activo', x === b));
    ['lotes', 'finanzas', 'kardex', 'precios', 'proveedores'].forEach((t) => { $(`#tab-${t}`, root).hidden = t !== b.dataset.tab; });
    if (b.dataset.tab === 'finanzas' && !$('#tab-finanzas', root).innerHTML) {
      $('#tab-finanzas', root).innerHTML = String(cargando(4));
      try {
        const f = await api.get(`/api/contabilidad/productos/${id}`);
        const r = f.resumen;
        $('#tab-finanzas', root).innerHTML = String(html`
          <div class="kpis mb">
            <div class="kpi"><div class="et">Ganancia acumulada</div><div class="va ${r.ganancia_acumulada < 0 ? 'neg' : ''}">${fmt.cop(r.ganancia_acumulada)}</div><div class="de">margen ${fmt.pct(r.margen_pct)} · ${r.unidades_vendidas} und vendidas</div></div>
            <div class="kpi"><div class="et">Precio promedio de venta</div><div class="va">${r.precio_promedio_venta === null ? '—' : fmt.cop(r.precio_promedio_venta)}</div><div class="de">ingreso ${fmt.cop(r.ingreso_total)}</div></div>
            <div class="kpi"><div class="et">Costo histórico</div><div class="va">${r.costo_ultimo === null ? '—' : fmt.cop(r.costo_ultimo)}</div><div class="de">${r.costo_minimo !== null ? `mín. ${fmt.cop(r.costo_minimo)} · máx. ${fmt.cop(r.costo_maximo)}` : 'sin compras'}</div></div>
            <div class="kpi"><div class="et">Inventario</div><div class="va">${fmt.cop(r.valor_inventario)}</div><div class="de">${r.stock} und · costo prom. ${r.costo_promedio_actual === null ? '—' : fmt.cop(r.costo_promedio_actual)}${r.inventario_usd ? ` · ${fmt.usd(r.inventario_usd.usd)}${r.inventario_usd.valor_hoy ? ' ≈ ' + fmt.cop(r.inventario_usd.valor_hoy) + ' hoy' : ''}` : ''}</div></div>
            ${r.tasa_compra_promedio || r.tasa_venta_promedio ? html`<div class="kpi"><div class="et">Tasas promedio</div><div class="va" style="font-size:16px">${r.tasa_compra_promedio ? 'compra ' + fmt.tasa(r.tasa_compra_promedio) : ''}${r.tasa_venta_promedio ? ' · venta ' + fmt.tasa(r.tasa_venta_promedio) : ''}</div><div class="de">${r.diferencia_tasas !== null ? `diferencia venta − compra: ${r.diferencia_tasas >= 0 ? '+' : ''}${r.diferencia_tasas}` : 'no comparable'}</div></div>` : ''}
          </div>
          <h3 class="mb">Compras y tasas de cambio</h3>
          ${tabla([{ titulo: 'Fecha', valor: (l) => fmt.fecha(l.fecha) }, { titulo: 'Compra', valor: (l) => l.compra_numero || l.origen }, { titulo: 'Proveedor', valor: (l) => l.proveedor || '' }, { titulo: 'Moneda', clave: 'moneda' }, { titulo: 'Costo moneda', valor: (l) => (l.moneda === 'USD' ? fmt.usd(l.costo_unitario_moneda) : '—'), num: true }, { titulo: 'Tasa', valor: (l) => (l.moneda === 'USD' ? fmt.tasa(l.tasa_cambio) : '—'), num: true }, { titulo: 'Costo COP', clave: 'costo_unitario', dinero: true }, { titulo: 'Inicial', clave: 'cantidad_inicial', num: true }, { titulo: 'Restantes', clave: 'cantidad_restante', num: true }], f.compras, { vacioTexto: 'Sin compras' })}
          <h3 class="mt-l mb">Ventas, costo asignado y lote de origen</h3>
          ${tabla([{ titulo: 'Fecha', valor: (v) => fmt.fecha(v.fecha) }, { titulo: 'Venta', clave: 'numero' }, { titulo: 'Moneda', valor: (v) => (v.moneda === 'USD' ? `USD ${fmt.tasa(v.tasa_cambio)}` : 'COP') }, { titulo: 'Precio', valor: (v) => (v.moneda === 'USD' ? `${fmt.usd(v.precio_unitario_moneda)} (${fmt.cop(v.precio_unitario)})` : fmt.cop(v.precio_unitario)), num: true }, { titulo: 'Und', clave: 'unidades', num: true }, { titulo: 'Costo asignado', clave: 'costo_neto', dinero: true }, { titulo: 'Lote(s) origen', valor: (v) => v.lotes.map((l) => `${l.compra_numero || fmt.fecha(l.lote_fecha)}${l.moneda_compra === 'USD' ? ' @' + fmt.tasa(l.tasa_compra) : ''}`).join(', ') }, { titulo: 'Ganancia', clave: 'ganancia', dinero: true }], f.ventas, { vacioTexto: 'Sin ventas' })}
          <h3 class="mt-l mb">Evolución del costo en COP</h3>
          ${f.evolucion_costo.length ? html`<div class="col">${f.evolucion_costo.map((e) => html`<div class="row between small"><span>${fmt.fecha(e.fecha)} · ${e.compra_numero || ''}${e.moneda === 'USD' ? ` · ${fmt.usd(e.costo_unitario_moneda)} × ${fmt.tasa(e.tasa_cambio)}` : ''}</span><b class="num">${fmt.cop(e.costo_unitario)}</b></div>`)}</div>` : html`<p class="muted">Sin compras registradas.</p>`}`);
      } catch (e) { $('#tab-finanzas', root).innerHTML = `<div class="vacio">${esc(e.message)}</div>`; }
    }
    if (b.dataset.tab === 'kardex' && !$('#tab-kardex', root).innerHTML) {
      const k = await api.get(`/api/productos/${id}/kardex`);
      const TIPOS = { compra: 'Compra', venta: 'Venta', devolucion_venta: 'Devolución', anulacion_venta: 'Anulación venta', anulacion_compra: 'Anulación compra', ajuste_entrada: 'Ajuste +', ajuste_salida: 'Ajuste −', perdida: 'Pérdida', inicial: 'Inicial' };
      $('#tab-kardex', root).innerHTML = String(tabla([{ titulo: 'Fecha', valor: (m) => fmt.fechaHora(m.fecha) }, { titulo: 'Tipo', valor: (m) => TIPOS[m.tipo] || m.tipo }, { titulo: 'Cant.', clave: 'cantidad', num: true }, { titulo: 'Stock', clave: 'stock_resultante', num: true }, { titulo: 'Costo', clave: 'costo_unitario', dinero: true }, { titulo: 'Serial', valor: (m) => m.serial || '' }, { titulo: 'Usuario', clave: 'usuario_nombre' }, { titulo: 'Nota', clave: 'nota' }], k, { vacioTexto: 'Sin movimientos' }));
    }
  }));
  const bAj = $('#p-ajustar', root);
  if (bAj) bAj.addEventListener('click', () => ajustarStock(p, () => detalle(root, id, setTopbar)));
  const bFoto = $('#p-foto', root);
  if (bFoto) bFoto.addEventListener('click', async () => {
    const f = await capturar({ camara: true, soloImagen: true });
    if (!f) return;
    try { await api.post(`/api/productos/${id}/fotos`, { imagen: f.dataUrl, nombre: f.nombre }); toast('Foto agregada', 'ok'); detalle(root, id, setTopbar); } catch (e) { mostrarError(e); }
  });
  $$('[data-foto]', root).forEach((b) => b.addEventListener('click', async () => { if (await confirmar('¿Eliminar esta foto?', { peligro: true, textoOk: 'Eliminar' })) { try { await api.del(`/api/productos/${id}/fotos/${b.dataset.foto}`); detalle(root, id, setTopbar); } catch (e) { mostrarError(e); } } }));
}

function ajustarStock(p, alTerminar) {
  modal({
    titulo: `Ajustar stock · ${p.nombre}`,
    cuerpo: `<p class="muted small">Stock actual: <b>${p.stock}</b>. Los ajustes quedan en el historial con tu usuario y el motivo.</p>
      <div class="campo mt"><label>Tipo</label><select id="aj-tipo"><option value="entrada">Entrada (unidades encontradas / inventario inicial)</option><option value="salida">Salida (corrección)</option><option value="perdida">Rotura, pérdida o robo</option></select></div>
      <div class="campo"><label>Cantidad</label><input id="aj-cant" type="number" min="1" step="1" inputmode="numeric" value="1"></div>
      <div class="campo" id="aj-costo-campo"><label>Costo unitario de las unidades que entran</label><input id="aj-costo" data-money value="${p.precio_compra || ''}"><div class="ayuda">Se crea un lote con este costo.</div></div>
      <div class="campo"><label>Motivo</label><textarea id="aj-motivo" placeholder="Ej. conteo físico, botella rota en bodega…"></textarea></div>`,
    acciones: [{ texto: 'Guardar ajuste', clase: 'primario', alHacerClic: async ({ modal: m }) => {
      const tipo = $('#aj-tipo', m).value; const cant = Number($('#aj-cant', m).value); const motivo = $('#aj-motivo', m).value.trim();
      if (!cant || cant < 1) { toast('Indica la cantidad', 'error'); return false; }
      if (!motivo) { toast('Escribe el motivo', 'error'); return false; }
      const r = await api.post(`/api/productos/${p.id}/ajuste`, { cantidad: tipo === 'entrada' ? cant : -cant, tipo, motivo, costo_unitario: tipo === 'entrada' ? leerDinero($('#aj-costo', m)) : undefined });
      toast(`Stock actualizado: ${r.stock}`, 'ok'); alTerminar();
    } }],
    alMontar: (m) => { $('#aj-tipo', m).addEventListener('change', (e) => { $('#aj-costo-campo', m).hidden = e.target.value !== 'entrada'; }); },
  });
}

// ---------- Formulario ----------
async function formulario(root, id, setTopbar, query = {}) {
  const cats = await api.get('/api/categorias');
  let p = { estado: 'activo', stock_minimo: 1, codigo_barras: query.codigo || '' };
  if (id) { try { p = await api.get(`/api/productos/${id}`); } catch (e) { mostrarError(e); return navegar('#/inventario', true); } }
  setTopbar({ titulo: id ? 'Editar producto' : 'Nuevo producto', atras: id ? `#/inventario/${id}` : '#/inventario' });
  const padres = cats.filter((c) => !c.padre_id);
  const hijas = (padreId) => cats.filter((c) => String(c.padre_id) === String(padreId));
  const soloPrecio = id && !estado.tiene('inventario.editar');
  renderizar(root, html`<form id="f-prod" class="card">
    <div class="campo"><label>Nombre del producto *</label><input name="nombre" required value="${p.nombre || ''}" ${soloPrecio ? 'readonly' : ''} placeholder="Ej. Aguardiente Antioqueño Tapa Azul 750 ml"></div>
    <div class="grid2">
      <div class="campo"><label>Categoría</label><div class="row"><select name="categoria_id" class="grow"><option value="">Sin categoría</option>${padres.map((c) => html`<option value="${c.id}" ${String(c.id) === String(p.categoria_id) ? 'selected' : ''}>${c.nombre}</option>`)}</select>${!soloPrecio ? html`<button type="button" class="btn icono" id="f-nueva-cat" title="Nueva categoría">${raw(icono('plus'))}</button>` : ''}</div></div>
      <div class="campo"><label>Subcategoría</label><select name="subcategoria_id"><option value="">—</option>${hijas(p.categoria_id).map((c) => html`<option value="${c.id}" ${String(c.id) === String(p.subcategoria_id) ? 'selected' : ''}>${c.nombre}</option>`)}</select></div>
      <div class="campo"><label>Marca</label><input name="marca" value="${p.marca || ''}" ${soloPrecio ? 'readonly' : ''}></div>
      <div class="campo"><label>Presentación</label><input name="capacidad" value="${p.capacidad || ''}" placeholder="Ej. 750 ml, 1000 ml, lata 330 ml" ${soloPrecio ? 'readonly' : ''}></div>
      <div class="campo"><label>Tipo o variedad</label><input name="modelo_compatible" value="${p.modelo_compatible || ''}" placeholder="Ej. 12 años, reposado, tapa azul" ${soloPrecio ? 'readonly' : ''}></div>
      <div class="campo"><label>Referencia del proveedor</label><input name="referencia" value="${p.referencia || ''}" ${soloPrecio ? 'readonly' : ''}></div>
      <div class="campo"><label>Ubicación en bodega</label><input name="ubicacion" value="${p.ubicacion || ''}" placeholder="Ej. Cuarto frío, vitrina premium, piso 2" ${soloPrecio ? 'readonly' : ''}></div>
    </div>
    <div class="campo"><label>Código de barras</label><div class="row"><input name="codigo_barras" class="grow" value="${p.codigo_barras || ''}" inputmode="numeric" ${soloPrecio ? 'readonly' : ''}>${!soloPrecio ? html`<button type="button" class="btn icono" id="f-scan">${raw(icono('scan'))}</button>` : ''}</div></div>
    <div class="campo"><label>SKU interno</label><input name="sku" value="${p.sku || ''}" placeholder="Se genera automáticamente si lo dejas vacío" ${soloPrecio ? 'readonly' : ''}></div>
    <label class="check"><input type="checkbox" name="requiere_serial" ${p.requiere_serial ? 'checked' : ''} ${soloPrecio ? 'disabled' : ''}> Controlar cada botella por serial o número de estampilla (ediciones especiales)</label>
    <div class="grid2 mt">
      <div class="campo"><label>Precio al detal *</label><input name="precio_venta" data-money value="${p.precio_venta || ''}" required ${!estado.tiene('inventario.cambiar_precio') && id ? 'readonly' : ''}></div>
      <div class="campo"><label>Precio al por mayor</label><input name="precio_mayor" data-money value="${p.precio_mayor || ''}" ${!estado.tiene('inventario.cambiar_precio') && id ? 'readonly' : ''}><div class="ayuda">Se aplica solo desde ${estado.config.unidades_mayor || 10} unidades o a clientes mayoristas. Vacío = sin tarifa mayorista.</div></div>
      <div class="campo"><label>Costo de referencia</label><input name="precio_compra" data-money value="${p.precio_compra || ''}" ${id && !estado.tiene('inventario.cambiar_costo') ? 'readonly' : ''}><div class="ayuda">Se actualiza solo con cada compra. No cambia el costo de los lotes ya ingresados.</div></div>
      <div class="campo"><label>Stock mínimo (alerta)</label><input name="stock_minimo" type="number" min="0" inputmode="numeric" value="${p.stock_minimo ?? 0}" ${soloPrecio ? 'readonly' : ''}></div>
      <div class="campo"><label>Estado</label><select name="estado" ${soloPrecio ? 'disabled' : ''}>${Object.entries(ESTADOS_PRODUCTO).map(([v, [t]]) => html`<option value="${v}" ${p.estado === v ? 'selected' : ''}>${t}</option>`)}</select></div>
      ${!id ? html`<div class="campo"><label>Stock inicial (opcional)</label><input name="stock_inicial" type="number" min="0" inputmode="numeric" value="0"><div class="ayuda">Crea un lote con el costo de referencia. Lo normal es ingresar las unidades con una compra.</div></div>` : ''}
    </div>
    ${id && estado.tiene('inventario.cambiar_precio') ? html`<div class="campo"><label>Motivo del cambio de precio (si aplica)</label><input name="motivo_precio" placeholder="Ej. nueva lista de precios del distribuidor"></div>` : ''}
    <div class="campo"><label>Descripción</label><textarea name="descripcion" ${soloPrecio ? 'readonly' : ''}>${p.descripcion || ''}</textarea></div>
    <div class="form-pie"><a class="btn suave" href="${id ? `#/inventario/${id}` : '#/inventario'}">Cancelar</a><button class="btn primario" type="submit">${id ? 'Guardar cambios' : 'Crear producto'}</button></div>
  </form>`);
  activarDinero(root);
  const form = $('#f-prod', root);
  form.categoria_id.addEventListener('change', () => { form.subcategoria_id.innerHTML = '<option value="">—</option>' + hijas(form.categoria_id.value).map((c) => `<option value="${c.id}">${esc(c.nombre)}</option>`).join(''); });
  const bScan = $('#f-scan', root);
  if (bScan) bScan.addEventListener('click', async () => { const c = await escanear(); if (c) form.codigo_barras.value = c; });
  const bCat = $('#f-nueva-cat', root);
  if (bCat) bCat.addEventListener('click', () => {
    modal({ titulo: 'Nueva categoría', cuerpo: `<div class="campo"><label>Nombre</label><input id="nc-nombre"></div><div class="campo"><label>Dentro de (opcional)</label><select id="nc-padre"><option value="">Categoría principal</option>${padres.map((c) => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('')}</select></div>`,
      acciones: [{ texto: 'Crear', clase: 'primario', alHacerClic: async ({ modal: m }) => { const c = await api.post('/api/categorias', { nombre: $('#nc-nombre', m).value, padre_id: $('#nc-padre', m).value || null }); cats.push(c); if (c.padre_id) { form.categoria_id.value = c.padre_id; form.categoria_id.dispatchEvent(new Event('change')); form.subcategoria_id.value = c.id; } else { form.categoria_id.insertAdjacentHTML('beforeend', `<option value="${c.id}">${esc(c.nombre)}</option>`); form.categoria_id.value = c.id; } toast('Categoría creada', 'ok'); } }] });
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = datosForm(form);
    try {
      const r = id ? await api.put(`/api/productos/${id}`, d) : await api.post('/api/productos', d);
      toast(id ? 'Producto actualizado' : 'Producto creado', 'ok');
      navegar(`#/inventario/${r.id}`, true);
    } catch (err) { mostrarError(err); }
  });
}

// Reutilizable desde ventas/compras: crear producto rápido en un modal. Devuelve el producto creado.
export function crearProductoRapido({ nombre = '', codigo = '' } = {}) {
  return new Promise((resolve) => {
    api.get('/api/categorias').then((cats) => {
      modal({
        titulo: 'Nuevo producto',
        cuerpo: `<div class="campo"><label>Nombre *</label><input id="pr-nombre" value="${esc(nombre)}"></div>
          <div class="grid2"><div class="campo"><label>Categoría</label><select id="pr-cat"><option value="">Sin categoría</option>${cats.filter((c) => !c.padre_id).map((c) => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('')}</select></div>
          <div class="campo"><label>Código de barras</label><input id="pr-codigo" value="${esc(codigo)}" inputmode="numeric"></div>
          <div class="campo"><label>Precio al detal *</label><input id="pr-venta" data-money></div><div class="campo"><label>Precio al por mayor</label><input id="pr-mayor" data-money></div><div class="campo"><label>Presentación</label><input id="pr-pres" placeholder="750 ml"></div><div class="campo"><label>Costo de referencia</label><input id="pr-compra" data-money></div></div>
          <label class="check"><input type="checkbox" id="pr-serial"> Controlar por serial / estampilla</label>`,
        acciones: [{ texto: 'Cancelar', clase: 'suave', alHacerClic: () => resolve(null) }, { texto: 'Crear', clase: 'primario', alHacerClic: async ({ modal: m }) => {
          const p = await api.post('/api/productos', { nombre: $('#pr-nombre', m).value, categoria_id: $('#pr-cat', m).value || null, codigo_barras: $('#pr-codigo', m).value, precio_venta: leerDinero($('#pr-venta', m)), precio_mayor: leerDinero($('#pr-mayor', m)), capacidad: $('#pr-pres', m).value, precio_compra: leerDinero($('#pr-compra', m)), requiere_serial: $('#pr-serial', m).checked });
          toast('Producto creado', 'ok'); resolve(p);
        } }],
      });
    });
  });
}
