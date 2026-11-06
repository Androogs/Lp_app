// Reportes: cada reporte se filtra por fecha (y por categoría donde aplica), se muestra con una gráfica resumen
// construida con las mismas filas del reporte, y se exporta a Excel (CSV) o PDF con los formatos que ya soporta la API.
import { api } from '../../lib/api';
import { $, $$, html, raw, render as renderizar, fmt, icono, mostrarError, cargando, esc, tabla } from '../ui.js';
import { lineas, barras, barrasH, leyenda } from '../charts.js';
import { tablaViz, SERIE_INGRESO, SERIE_COSTO, SERIE_GANANCIA } from '../paneles.js';
import { rangoDe } from './ventas.js';

const DESCRIPCIONES = {
  inventario: 'Existencias, valor al costo y valor potencial de venta.', kardex: 'Historial de entradas y salidas por producto.', compras_proveedor: 'Total comprado, pagado y saldo por proveedor.', compras: 'Listado de compras del periodo.',
  ventas_cliente: 'Ventas y ganancia por cliente.', ventas: 'Listado de ventas con costo y ganancia.', ventas_producto: 'Unidades, ventas, costo y margen por producto.', costos_lote: 'Cada lote con su costo real y ganancia estimada.',
  creditos_pendientes: 'Cartera vigente con saldos y vencimientos.', abonos: 'Abonos recibidos por fecha y método.', cuentas_pagar: 'Facturas de proveedores pendientes.', gastos: 'Gastos del periodo por categoría.',
  cierres_caja: 'Cierres de caja con diferencias.', baja_rotacion: 'Productos con stock y sin ventas recientes.', precios_proveedores: 'Compara el costo del mismo producto entre proveedores.',
  rentabilidad_operaciones: 'Una fila por producto vendido con su costo por lote, tasas y resultado.', productos_rentabilidad: 'Ganancia bruta y neta acumulada por producto.', tasas_aplicadas: 'Moneda y tasa registrada en cada compra y venta.',
  diferencias_cambiarias: 'Pagos y abonos en USD liquidados a otra tasa.', comparacion_mensual: 'Compras, ventas, costo, ganancia y utilidad por mes.',
};
const SIN_FECHA = ['inventario', 'creditos_pendientes', 'cuentas_pagar', 'baja_rotacion', 'precios_proveedores'];
const CON_CATEGORIA = ['inventario', 'ventas_producto', 'costos_lote', 'rentabilidad_operaciones', 'productos_rentabilidad'];
// Cómo se resume cada reporte en una gráfica: 'tiempo' (suma por día o mes), 'top' (ranking por etiqueta) o 'series' (varias columnas por periodo).
const GRAFICA = {
  ventas: { tipo: 'tiempo', fecha: 'fecha', valor: 'total', nombre: 'Total vendido' },
  compras: { tipo: 'tiempo', fecha: 'fecha', valor: 'total', nombre: 'Total comprado' },
  abonos: { tipo: 'tiempo', fecha: 'fecha', valor: 'valor', nombre: 'Abonos recibidos' },
  gastos: { tipo: 'tiempo', fecha: 'fecha', valor: 'valor', nombre: 'Gastos' },
  cierres_caja: { tipo: 'tiempo', fecha: 'cerrada_en', valor: 'recaudado', nombre: 'Recaudado' },
  diferencias_cambiarias: { tipo: 'tiempo', fecha: 'fecha', valor: 'diferencia', nombre: 'Diferencia cambiaria' },
  comparacion_mensual: { tipo: 'series', etiqueta: 'mes', series: [['ventas_netas', 'Ventas netas', SERIE_INGRESO], ['costo', 'Costo vendido', SERIE_COSTO], ['ganancia_bruta', 'Ganancia bruta', SERIE_GANANCIA]] },
  ventas_producto: { tipo: 'top', etiqueta: 'producto', valor: 'total', nombre: 'Vendido' },
  productos_rentabilidad: { tipo: 'top', etiqueta: 'nombre', valor: 'ganancia_bruta', nombre: 'Ganancia bruta' },
  rentabilidad_operaciones: { tipo: 'top', etiqueta: 'nombre_producto', valor: 'ganancia_bruta', nombre: 'Ganancia bruta', agrupar: true },
  ventas_cliente: { tipo: 'top', etiqueta: 'cliente', valor: 'total', nombre: 'Total vendido' },
  compras_proveedor: { tipo: 'top', etiqueta: 'proveedor', valor: 'total', nombre: 'Total comprado' },
  inventario: { tipo: 'top', etiqueta: 'categoria', valor: 'valor_costo', nombre: 'Valor al costo', agrupar: true },
  creditos_pendientes: { tipo: 'top', etiqueta: 'cliente_nombre', valor: 'saldo_actual', nombre: 'Saldo pendiente', agrupar: true },
  cuentas_pagar: { tipo: 'top', etiqueta: 'proveedor', valor: 'saldo_pendiente', nombre: 'Saldo pendiente', agrupar: true },
  baja_rotacion: { tipo: 'top', etiqueta: 'nombre', valor: 'valor_costo', nombre: 'Valor al costo' },
  kardex: { tipo: 'top', etiqueta: 'producto', valor: 'cantidad', nombre: 'Unidades movidas', agrupar: true, abs: true, formato: 'num' },
};
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export async function render(root, { partes, setTopbar }) {
  const [clave] = partes;
  if (!clave) {
    setTopbar({ titulo: 'Reportes' });
    const lista = await api.get('/api/reportes');
    renderizar(root, html`<p class="muted small mb">Todos los reportes se filtran por fecha, se resumen en una gráfica y se descargan en Excel (CSV) o PDF.</p><div class="lista">${lista.map((r) => html`<a class="item" href="#/reportes/${r.clave}">${raw(icono('chart'))}<div class="cuerpo"><div class="titulo">${r.titulo}</div><div class="sub">${DESCRIPCIONES[r.clave] || ''}</div></div>${raw(icono('chevron', 18))}</a>`)}</div>`);
    return;
  }
  setTopbar({ titulo: 'Reporte', atras: '#/reportes' });
  const f = { periodo: 'mes', ...rangoDe('mes'), dias: 30, solo_disponibles: true, categoria_id: '' };
  const conFecha = !SIN_FECHA.includes(clave);
  const conCategoria = CON_CATEGORIA.includes(clave);
  const cats = conCategoria ? await api.get('/api/categorias').catch(() => []) : [];
  renderizar(root, html`<div id="rp-filtros" class="card compacta">
      ${conFecha ? html`<div class="pills">${[['hoy', 'Hoy'], ['7d', '7 días'], ['30d', '30 días'], ['mes', 'Mes'], ['anio', 'Año'], ['rango', 'Rango']].map(([v, t]) => html`<button class="pill ${f.periodo === v ? 'activo' : ''}" data-p="${v}">${t}</button>`)}</div><div class="row mt" id="rp-rango" hidden><input type="date" id="rp-desde" value="${f.desde}"><input type="date" id="rp-hasta" value="${f.hasta}"><button class="btn primario" id="rp-ok">Ver</button></div>` : ''}
      <div class="row wrap gap mt">
      ${conCategoria ? html`<select id="rp-cat" style="width:auto;min-width:180px"><option value="">Todas las categorías</option>${cats.filter((c) => !c.padre_id).map((c) => html`<option value="${c.id}">${c.nombre}</option>`)}</select>` : ''}
      ${clave === 'baja_rotacion' ? html`<label class="et-campo">Días sin ventas</label><input type="number" id="rp-dias" value="30" style="width:90px"><button class="btn chico primario" id="rp-ok2">Ver</button>` : ''}
      ${clave === 'costos_lote' ? html`<label class="check" style="min-height:0"><input type="checkbox" id="rp-disp" checked> Solo lotes con unidades disponibles</label>` : ''}
      ${clave === 'kardex' ? html`<div class="campo grow" style="margin:0"><input type="search" id="rp-prod" placeholder="Filtrar por producto (opcional)…"><div id="rp-prod-res"></div></div>` : ''}
      </div>
    </div>
    <div class="row between wrap mt"><h2 id="rp-titulo"></h2><div class="row gap"><a class="btn chico suave" id="rp-csv" href="#">${raw(icono('download', 16))} Excel (CSV)</a><a class="btn chico suave" id="rp-pdf" href="#" target="_blank">${raw(icono('file', 16))} PDF</a></div></div>
    <div id="rp-grafica" class="mt"></div>
    <div id="rp-tabla" class="mt"></div>`);
  const cargar = async () => {
    $('#rp-tabla', root).innerHTML = String(cargando(5));
    const params = {};
    if (conFecha) { if (f.periodo === 'rango') { params.desde = f.desde; params.hasta = f.hasta; } else Object.assign(params, rangoDe(f.periodo)); }
    if (clave === 'baja_rotacion') params.dias = f.dias;
    if (clave === 'costos_lote') params.solo_disponibles = f.solo_disponibles ? 1 : '';
    if (f.producto_id) params.producto_id = f.producto_id;
    if (f.categoria_id) params.categoria_id = f.categoria_id;
    try {
      const r = await api.get(`/api/reportes/${clave}` + api.qs(params));
      $('#rp-titulo', root).textContent = `${r.titulo} (${r.filas.length})`;
      $('#rp-csv', root).href = `/api/reportes/${clave}` + api.qs({ ...params, formato: 'csv' });
      $('#rp-pdf', root).href = `/api/reportes/${clave}` + api.qs({ ...params, formato: 'pdf' });
      pintarGrafica($('#rp-grafica', root), clave, r);
      const cols = r.columnas.map((c) => ({ titulo: c.titulo, clave: c.clave, dinero: /precio|costo|valor|total|saldo|pagado|ganancia|financiado|abonado|subtotal|descuento|impuestos|base|recaudado|egresos|esperado|contado|diferencia|credito|ventas_facturadas|adicionales|unit|ingreso|comision|gastos|compras$|ventas$|devoluciones|utilidad/.test(c.clave) && !/pct|unidades|stock|cantidad|_dias|^dias$|tasa|moneda|numero/.test(c.clave) && typeof (r.filas[0] || {})[c.clave] === 'number', num: /stock|cantidad|unidades|numero$|lotes|^n$|dias|pct|minimo|inicial|restante|tasa/.test(c.clave) }));
      $('#rp-tabla', root).innerHTML = String(tabla(cols, r.filas.map((fila) => { const o = { ...fila }; for (const c of r.columnas) if (/fecha|vence|_en$|ultima/.test(c.clave) && typeof o[c.clave] === 'string' && /^\d{4}-\d{2}-\d{2}/.test(o[c.clave])) o[c.clave] = fmt.fechaHora(o[c.clave]); return o; }), { totales: r.totales }));
    } catch (e) { mostrarError(e); }
  };
  $$('[data-p]', root).forEach((b) => b.addEventListener('click', () => { f.periodo = b.dataset.p; $$('[data-p]', root).forEach((x) => x.classList.toggle('activo', x === b)); $('#rp-rango', root).hidden = f.periodo !== 'rango'; if (f.periodo !== 'rango') cargar(); }));
  const ok = $('#rp-ok', root); if (ok) ok.addEventListener('click', () => { f.desde = $('#rp-desde', root).value; f.hasta = $('#rp-hasta', root).value; cargar(); });
  const ok2 = $('#rp-ok2', root); if (ok2) ok2.addEventListener('click', () => { f.dias = Number($('#rp-dias', root).value) || 30; cargar(); });
  const disp = $('#rp-disp', root); if (disp) disp.addEventListener('change', () => { f.solo_disponibles = disp.checked; cargar(); });
  const cat = $('#rp-cat', root); if (cat) cat.addEventListener('change', () => { f.categoria_id = cat.value; cargar(); });
  const prod = $('#rp-prod', root);
  if (prod) prod.addEventListener('input', async () => { const q = prod.value.trim(); const res = $('#rp-prod-res', root); if (!q) { f.producto_id = null; res.innerHTML = ''; cargar(); return; } const r = await api.get('/api/productos' + api.qs({ q, limite: 8 })); res.innerHTML = r.productos.map((p) => `<button class="pill" data-pid="${p.id}" style="margin:4px 4px 0 0">${esc(p.nombre)}</button>`).join(''); $$('[data-pid]', res).forEach((b) => b.addEventListener('click', () => { f.producto_id = b.dataset.pid; prod.value = b.textContent; res.innerHTML = ''; cargar(); })); });
  cargar();
}

// Gráfica resumen del reporte, calculada con las mismas filas que se muestran en la tabla.
function pintarGrafica(cont, clave, r) {
  const cfg = GRAFICA[clave];
  if (!cfg || !r.filas.length) { cont.innerHTML = ''; return; }
  const fmtValor = cfg.formato === 'num' ? fmt.num : fmt.cop;
  if (cfg.tipo === 'tiempo') {
    const porDia = new Map();
    for (const fila of r.filas) { const fecha = String(fila[cfg.fecha] || '').slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) continue; porDia.set(fecha, (porDia.get(fecha) || 0) + (Number(fila[cfg.valor]) || 0)); }
    let puntos = [...porDia.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => ({ clave: k, etiqueta: `${k.slice(8, 10)}/${k.slice(5, 7)}`, valor: v }));
    let sub = 'Suma por día';
    if (puntos.length > 62) {
      const porMes = new Map();
      for (const p of puntos) { const k = p.clave.slice(0, 7); porMes.set(k, (porMes.get(k) || 0) + p.valor); }
      puntos = [...porMes.entries()].map(([k, v]) => ({ clave: k, etiqueta: `${MESES[Number(k.slice(5, 7)) - 1]} ${k.slice(2, 4)}`, valor: v }));
      sub = 'Suma por mes';
    }
    cont.innerHTML = `<section class="panel"><div class="panel-cab"><div><h2>${esc(cfg.nombre)} en el tiempo</h2><div class="panel-sub">${sub} · ${puntos.length} periodo(s)</div></div></div><div id="rp-viz"></div><div class="panel-pie">${tablaViz([{ titulo: 'Periodo', clave: 'etiqueta' }, { titulo: cfg.nombre, clave: 'valor', dinero: true }], puntos)}</div></section>`;
    barras($('#rp-viz', cont), { etiquetas: puntos.map((p) => p.etiqueta), series: [{ nombre: cfg.nombre, valores: puntos.map((p) => p.valor) }], formato: fmtValor, tituloTip: (i) => (puntos[i].clave.length === 10 ? fmt.fechaLarga(puntos[i].clave) : puntos[i].etiqueta) });
    return;
  }
  if (cfg.tipo === 'series') {
    const puntos = r.filas.map((fila) => ({ etiqueta: `${MESES[Number(String(fila[cfg.etiqueta]).slice(5, 7)) - 1] || ''} ${String(fila[cfg.etiqueta]).slice(2, 4)}`, ...fila }));
    const series = cfg.series.map(([k, nombre, color]) => ({ nombre, color, valores: puntos.map((p) => Number(p[k]) || 0) }));
    cont.innerHTML = `<section class="panel"><div class="panel-cab"><div><h2>Resultados por mes</h2><div class="panel-sub">Ventas netas, costo de lo vendido y ganancia bruta</div></div></div><div id="rp-viz"></div><div class="panel-pie">${leyenda(series)}</div></section>`;
    barras($('#rp-viz', cont), { etiquetas: puntos.map((p) => p.etiqueta), series, formato: fmtValor });
    return;
  }
  // top: ranking por etiqueta
  let items;
  if (cfg.agrupar) {
    const m = new Map();
    for (const fila of r.filas) { const k = String(fila[cfg.etiqueta] || 'Sin dato'); const v = Number(fila[cfg.valor]) || 0; m.set(k, (m.get(k) || 0) + (cfg.abs ? Math.abs(v) : v)); }
    items = [...m.entries()].map(([etiqueta, valor]) => ({ etiqueta, valor }));
  } else items = r.filas.map((fila) => ({ etiqueta: String(fila[cfg.etiqueta] || 'Sin dato'), valor: Number(fila[cfg.valor]) || 0 }));
  items = items.filter((it) => it.valor !== 0).sort((a, b) => Math.abs(b.valor) - Math.abs(a.valor)).slice(0, 10).map((it) => ({ ...it, nombreValor: cfg.nombre }));
  if (!items.length) { cont.innerHTML = ''; return; }
  cont.innerHTML = `<section class="panel"><div class="panel-cab"><div><h2>${esc(cfg.nombre)}: los 10 mayores</h2><div class="panel-sub">Resumen visual del reporte; la tabla de abajo tiene el detalle completo</div></div></div><div id="rp-viz"></div></section>`;
  barrasH($('#rp-viz', cont), { items, formato: fmtValor });
}
