import { api } from '../../lib/api';
import { estado, navegar } from '../../lib/estado';
import { $, $$, html, raw, render as renderizar, fmt, icono, badge, ESTADOS_VENTA, TIPOS_PAGO, ORIGEN_TASA, RESULTADO, TIPOS_CLIENTE, nombreMetodo, toast, modal, confirmar, pedirTexto, mostrarError, debounce, activarDinero, leerDinero, leerDecimal, vacio, cargando, esc, selectorBusqueda, hoyISO, sumarDias, miniatura, tarifaBadge } from '../ui.js';
import { escanear } from '../scanner.js';
import { capturar } from '../camera.js';
import { crearProductoRapido } from './inventario.js';
import { campoTasa } from './compras.js';
import { barraCaja } from './caja.js';
import { PRESETS, filtroInicial, guardarFiltro, filtroPeriodo, panelVentas } from '../paneles.js';
import { campanasAbiertas, selectCanal, selectCampana, atribucionBadge, nombreCanal, nombrePlataforma } from './marketing.js';

export async function render(root, { seccion, partes, query, setTopbar }) {
  if (seccion === 'vender') return pos(root, query, setTopbar);
  const [id] = partes;
  if (id) return detalle(root, Number(id), setTopbar);
  return historial(root, query, setTopbar);
}

// ---------- Punto de venta ----------
const CLAVE_CARRITO = 'pos.carrito';
function leerCarrito() { try { return (JSON.parse(sessionStorage.getItem(CLAVE_CARRITO)) || []).filter((it) => it && it.producto_id); } catch { return []; } }
function guardarCarrito(c) { sessionStorage.setItem(CLAVE_CARRITO, JSON.stringify(c)); }

// Tarifa de cada línea con la misma regla del servidor: precio mayor si el cliente es mayorista o si la venta lleva al menos
// `unidades_mayor` unidades de esa referencia (sumando todas sus líneas) y el producto tiene precio mayor.
// Una línea con precio cambiado a mano conserva ese precio.
export function aplicarTarifas(carrito, mayorista = false) {
  const minimo = Number(estado.config.unidades_mayor) || 10;
  const unidades = new Map();
  for (const it of carrito) unidades.set(it.producto_id, (unidades.get(it.producto_id) || 0) + it.cantidad);
  for (const it of carrito) {
    const detal = it.precio_detal ?? it.precio_lista;
    const tieneMayor = it.precio_mayor > 0 && it.precio_mayor < detal;
    it.tarifa = tieneMayor && (mayorista || unidades.get(it.producto_id) >= minimo) ? 'mayor' : 'detal';
    it.precio_lista = it.tarifa === 'mayor' ? it.precio_mayor : detal;
    if (!it.manual) it.precio_unitario = it.precio_lista;
  }
  return carrito;
}
const lineaDe = (p, extra = {}) => ({ producto_id: p.id, nombre: p.nombre, foto: p.foto || null, presentacion: p.capacidad || '', precio_detal: p.precio_venta, precio_mayor: p.precio_mayor || 0, precio_lista: p.precio_venta, precio_unitario: p.precio_venta, cantidad: 1, descuento: 0, requiere_serial: !!p.requiere_serial, stock: p.stock, ...extra });

// Tarjeta de la vitrina: botella sobre fondo cálido, nombre, presentación, precio al detal y al por mayor.
function tarjetaProducto(p, i, enCarrito) {
  const agotado = p.stock <= 0;
  return `<button type="button" class="pv-tile ${agotado ? 'agotado' : ''} ${enCarrito ? 'en-carrito' : ''}" data-i="${i}" aria-label="Agregar ${esc(p.nombre)}">
    <span class="pv-foto">${p.foto ? `<img src="/api/archivos/${esc(p.foto)}" alt="" loading="lazy">` : icono('bottle', 34)}${enCarrito ? `<span class="pv-cant">${enCarrito}</span>` : ''}</span>
    <span class="pv-nombre">${esc(p.nombre)}</span>
    <span class="pv-precios"><b class="num">${fmt.cop(p.precio_venta)}</b>${p.precio_mayor > 0 && p.precio_mayor < p.precio_venta ? `<span class="pv-mayor num">Mayor ${fmt.cop(p.precio_mayor)}</span>` : ''}</span>
    <span class="pv-stock ${agotado ? 'cero' : p.stock <= p.stock_minimo ? 'bajo' : ''}">${agotado ? 'Agotado' : `${fmt.num(p.stock)} disp.`}</span>
  </button>`;
}

async function pos(root, query, setTopbar) {
  if (!estado.tiene('ventas.crear')) { setTopbar({ titulo: 'Ventas' }); return historial(root, query, setTopbar); }
  setTopbar({ titulo: 'Vender', acciones: [{ icono: 'list', titulo: 'Historial de ventas', href: '#/ventas' }] });
  let carrito = aplicarTarifas(leerCarrito());
  const puedeCambiarPrecio = estado.tiene('ventas.cambiar_precio');
  const puedeDescuento = estado.tiene('ventas.descuento');
  const minimoMayor = Number(estado.config.unidades_mayor) || 10;
  let categorias = [];
  let categoriaSel = '';
  let vitrina = [];

  renderizar(root, html`<div id="pos-caja" class="mb"></div><div class="pos-venta">
    <div class="pos-catalogo">
      <div class="buscador">${raw(icono('search'))}<input type="search" id="pos-q" placeholder="Buscar licor, marca o código de barras…" autocomplete="off"><button class="btn icono" id="pos-scan" title="Escanear código de barras">${raw(icono('scan'))}</button></div>
      <div class="pills mt" id="pos-cats" role="tablist" aria-label="Categorías"></div>
      <div id="pos-res" class="pv-grid mt"></div>
    </div>
    <div class="carrito-col">
      <div class="card compacta carrito"><div class="row between"><h2 style="margin:0">Carrito</h2><button class="btn chico fantasma" id="pos-vaciar">Vaciar</button></div>
        <p class="xs muted mt" style="margin-top:6px">Desde ${minimoMayor} unidades de una referencia se aplica el precio mayorista.</p>
        <div id="pos-carrito" class="mt"></div></div>
      <div class="barra-cobro mt"><div class="total"><div class="et">Total <span id="pos-ahorro" class="xs"></span></div><div class="va" id="pos-total">$ 0</div></div><button class="btn primario" id="pos-cobrar" style="min-width:150px">${raw(icono('cash', 20))} Cobrar</button></div>
    </div>
  </div>`);

  const res = $('#pos-res', root);
  const q = $('#pos-q', root);
  const total = () => carrito.reduce((s, it) => s + it.cantidad * it.precio_unitario - (it.descuento || 0), 0);
  const unidadesDe = (pid) => carrito.filter((it) => it.producto_id === pid).reduce((s, it) => s + it.cantidad, 0);

  const pintarCarrito = () => {
    aplicarTarifas(carrito);
    guardarCarrito(carrito);
    const c = $('#pos-carrito', root);
    if (!carrito.length) { c.innerHTML = String(vacio('Toca una botella de la vitrina o escanea su código para empezar')); }
    else c.innerHTML = carrito.map((it, i) => `<div class="linea-carrito">
        ${miniatura(it, 'thumb')}
        <div class="grow"><div class="bold truncate">${esc(it.nombre)}</div>
          <div class="row small muted wrap" style="gap:6px"><span class="num">${fmt.cop(it.precio_unitario)} c/u</span>${tarifaBadge(it.tarifa)}${it.manual ? '<span class="badge aviso">precio cambiado</span>' : ''}${it.descuento ? `<span class="badge neutro">desc. ${fmt.cop(it.descuento)}</span>` : ''}${it.requiere_serial ? `<span class="badge neutro mono">${(it.seriales || []).join(', ') || 'sin serial'}</span>` : ''}</div>
          ${it.tarifa !== 'mayor' && it.precio_mayor > 0 && it.precio_mayor < it.precio_detal && unidadesDe(it.producto_id) >= minimoMayor - 3 ? `<div class="xs pista-mayor">Con ${minimoMayor - unidadesDe(it.producto_id)} más pasa a ${fmt.cop(it.precio_mayor)} c/u</div>` : ''}
          <div class="row wrap" style="margin-top:6px;gap:6px"><div class="stepper"><button type="button" data-menos="${i}" aria-label="Uno menos">−</button><input type="number" value="${it.cantidad}" data-cant="${i}" min="1" aria-label="Cantidad"><button type="button" data-mas="${i}" aria-label="Uno más">+</button></div>
          ${puedeCambiarPrecio || puedeDescuento ? `<button class="btn chico suave" data-editar="${i}">${icono('edit', 14)} Precio</button>` : ''}${it.requiere_serial ? `<button class="btn chico suave" data-serial="${i}">Serial</button>` : ''}</div></div>
        <div class="fin"><div class="valor">${fmt.cop(it.cantidad * it.precio_unitario - (it.descuento || 0))}</div><button class="btn chico quitar-linea" data-quitar="${i}" aria-label="Quitar ${esc(it.nombre)} del carrito">${icono('trash', 15)}</button></div></div>`).join('');
    const ahorro = carrito.reduce((s, it) => s + (it.tarifa === 'mayor' && !it.manual ? (it.precio_detal - it.precio_mayor) * it.cantidad : 0), 0);
    $('#pos-total', root).textContent = fmt.cop(total());
    $('#pos-ahorro', root).textContent = ahorro ? `· ahorro mayorista ${fmt.cop(ahorro)}` : '';
    $('#pos-cobrar', root).disabled = !carrito.length;
    $$('[data-menos]', c).forEach((b) => b.addEventListener('click', () => cambiarCantidad(Number(b.dataset.menos), -1)));
    $$('[data-mas]', c).forEach((b) => b.addEventListener('click', () => cambiarCantidad(Number(b.dataset.mas), 1)));
    $$('[data-cant]', c).forEach((inp) => inp.addEventListener('change', () => { const i = Number(inp.dataset.cant); carrito[i].cantidad = Math.max(1, Number(inp.value) || 1); ajustarSeriales(i); pintarCarrito(); }));
    $$('[data-quitar]', c).forEach((b) => b.addEventListener('click', () => { carrito.splice(Number(b.dataset.quitar), 1); pintarCarrito(); }));
    $$('[data-editar]', c).forEach((b) => b.addEventListener('click', () => editarPrecio(Number(b.dataset.editar))));
    $$('[data-serial]', c).forEach((b) => b.addEventListener('click', () => elegirSeriales(Number(b.dataset.serial))));
    pintarVitrina();
  };
  const cambiarCantidad = (i, delta) => { const it = carrito[i]; if (delta < 0 && it.cantidad <= 1) { carrito.splice(i, 1); pintarCarrito(); return; } if (it.requiere_serial && delta > 0) return elegirSeriales(i); it.cantidad = Math.max(1, it.cantidad + delta); if (it.cantidad > it.stock && it.stock >= 0) toast(`Solo hay ${it.stock} en inventario`, 'error'); ajustarSeriales(i); pintarCarrito(); };
  const ajustarSeriales = (i) => { const it = carrito[i]; if (it.requiere_serial && it.seriales) it.seriales = it.seriales.slice(0, it.cantidad); };

  const agregar = async (p, serial) => {
    if (p.stock <= 0 && !estado.config.permitir_stock_negativo) { toast(`${p.nombre} está agotado`, 'error'); return; }
    if (p.requiere_serial) {
      const existente = carrito.find((it) => it.producto_id === p.id);
      if (serial) {
        if (existente) { if (!existente.seriales.includes(serial)) { existente.seriales.push(serial); existente.cantidad = existente.seriales.length; } }
        else carrito.push(lineaDe(p, { requiere_serial: true, seriales: [serial] }));
        pintarCarrito();
        return;
      }
      if (!existente) carrito.push(lineaDe(p, { requiere_serial: true, seriales: [] }));
      pintarCarrito();
      return elegirSeriales(carrito.findIndex((it) => it.producto_id === p.id));
    }
    const existente = carrito.find((it) => it.producto_id === p.id);
    if (existente) existente.cantidad += 1;
    else carrito.push(lineaDe(p));
    if (navigator.vibrate) navigator.vibrate(25);
    pintarCarrito();
  };

  const elegirSeriales = async (i) => {
    const it = carrito[i];
    const p = await api.get(`/api/productos/${it.producto_id}`);
    const enOtrasLineas = new Set(carrito.filter((x, j) => j !== i).flatMap((x) => x.seriales || []));
    const disponibles = (p.lotes || []).filter((l) => l.serial && l.cantidad_restante > 0 && l.estado !== 'anulado' && !enOtrasLineas.has(l.serial));
    if (!disponibles.length) { toast('No hay unidades con serial disponibles', 'error'); return; }
    const sel = new Set(it.seriales || []);
    const m = modal({
      titulo: `Serial / estampilla · ${p.nombre}`,
      cuerpo: `<p class="muted small">Toca las unidades que se venden. El costo se toma del lote de cada una.</p><div class="lista mt">${disponibles.map((l) => `<label class="item" style="cursor:pointer"><input type="checkbox" value="${esc(l.serial)}" ${sel.has(l.serial) ? 'checked' : ''} style="width:20px;height:20px;accent-color:var(--accent)"><div class="cuerpo"><div class="titulo mono">${esc(l.serial)}</div><div class="sub">Ingresó ${fmt.fecha(l.fecha)}${l.proveedor_nombre ? ' · ' + esc(l.proveedor_nombre) : ''}${estado.tiene('inventario.ver') ? ' · costo ' + fmt.cop(l.costo_unitario) : ''}</div></div></label>`).join('')}</div>`,
      acciones: [{ texto: 'Listo', clase: 'primario', alHacerClic: ({ modal: mm }) => { const elegidos = $$('input:checked', mm).map((x) => x.value); if (!elegidos.length) { carrito.splice(i, 1); } else { it.seriales = elegidos; it.cantidad = elegidos.length; } pintarCarrito(); } }],
    });
    m.el.addEventListener('click', (e) => { if (e.target === m.el && !(it.seriales || []).length) { carrito.splice(i, 1); pintarCarrito(); } });
  };

  const editarPrecio = (i) => {
    const it = carrito[i];
    modal({
      titulo: it.nombre,
      cuerpo: `<div class="grid2">${puedeCambiarPrecio ? `<div class="campo"><label>Precio unitario</label><input id="ep-precio" data-money value="${it.precio_unitario}"><div class="ayuda">Detal ${fmt.cop(it.precio_detal)}${it.precio_mayor ? ` · mayor ${fmt.cop(it.precio_mayor)}` : ''}</div></div>` : ''}${puedeDescuento ? `<div class="campo"><label>Descuento en esta línea</label><input id="ep-desc" data-money value="${it.descuento || ''}"><div class="ayuda">Máximo autorizado: ${estado.config.descuento_maximo_pct}% del total</div></div>` : ''}</div>${it.manual ? '<button type="button" class="btn chico suave" id="ep-tarifa">Volver al precio de la tarifa</button>' : ''}`,
      acciones: [{ texto: 'Aplicar', clase: 'primario', alHacerClic: ({ modal: m }) => { const pr = $('#ep-precio', m); const de = $('#ep-desc', m); if (pr) { const v = leerDinero(pr); it.manual = v !== it.precio_lista; it.precio_unitario = v; } if (de) it.descuento = leerDinero(de); pintarCarrito(); } }],
      alMontar: (m) => { const b = $('#ep-tarifa', m); if (b) b.addEventListener('click', () => { it.manual = false; pintarCarrito(); $$('#modales .modal-fondo').forEach((x) => x.remove()); document.body.style.overflow = ''; }); },
    });
  };

  // Vitrina: lo que más rota primero (o el resultado de la búsqueda), con filtro por categoría.
  function pintarVitrina() {
    if (!vitrina.length) { res.innerHTML = q.value.trim() ? `<div class="vacio small" style="grid-column:1/-1">Sin resultados para “${esc(q.value.trim())}”${estado.tiene('inventario.editar') ? ' · <a href="#" id="pos-crear">crear producto</a>' : ''}</div>` : String(vacio('No hay productos en esta categoría')); enlazarCrear(); return; }
    res.innerHTML = vitrina.map((p, i) => tarjetaProducto(p, i, unidadesDe(p.id))).join('');
    $$('.pv-tile', res).forEach((el) => el.addEventListener('click', () => agregar(vitrina[Number(el.dataset.i)])));
  }
  function enlazarCrear() {
    const cr = $('#pos-crear', res);
    if (cr) cr.addEventListener('click', async (e) => { e.preventDefault(); const p = await crearProductoRapido({ nombre: q.value.trim() }); if (p) { q.value = ''; cargarVitrina(); toast('Producto creado sin stock: registra una compra para venderlo'); } });
  }
  const cargarVitrina = async () => {
    const texto = q.value.trim();
    res.innerHTML = '<div class="cargando" style="grid-column:1/-1">Cargando vitrina…</div>';
    try {
      const r = await api.get('/api/productos' + api.qs({ q: texto, categoria_id: texto ? '' : categoriaSel, orden: texto ? '' : 'vendidos', limite: texto ? 40 : 48 }));
      vitrina = r.productos;
      pintarVitrina();
    } catch (e) { mostrarError(e); }
  };
  const pintarCategorias = () => {
    const cont = $('#pos-cats', root);
    const padres = categorias.filter((c) => !c.padre_id);
    cont.innerHTML = `<button type="button" class="pill ${!categoriaSel ? 'activo' : ''}" data-cat="">Lo más vendido</button>${padres.map((c) => `<button type="button" class="pill ${String(categoriaSel) === String(c.id) ? 'activo' : ''}" data-cat="${c.id}">${esc(c.nombre)}</button>`).join('')}`;
    $$('[data-cat]', cont).forEach((b) => b.addEventListener('click', () => { categoriaSel = b.dataset.cat; q.value = ''; pintarCategorias(); cargarVitrina(); }));
  };
  q.addEventListener('input', debounce(() => { $('#pos-cats', root).hidden = !!q.value.trim(); cargarVitrina(); }, 220));
  q.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const codigo = q.value.trim();
    if (!codigo) return;
    try { const p = await api.get(`/api/productos/codigo/${encodeURIComponent(codigo)}`); agregar(p, p.serial_encontrado); q.value = ''; $('#pos-cats', root).hidden = false; cargarVitrina(); } catch { cargarVitrina(); }
  });
  const porCodigo = async (codigo) => {
    try { const p = await api.get(`/api/productos/codigo/${encodeURIComponent(codigo)}`); agregar(p, p.serial_encontrado); toast(`${p.nombre} agregado`, 'ok'); }
    catch (e) { if (e.status === 404) toast(`Código ${codigo} no registrado`, 'error'); else mostrarError(e); }
  };
  $('#pos-scan', root).addEventListener('click', async () => { const c = await escanear(); if (c) porCodigo(c); });
  $('#pos-vaciar', root).addEventListener('click', async () => { if (!carrito.length || await confirmar('¿Vaciar el carrito?')) { carrito = []; pintarCarrito(); } });
  $('#pos-cobrar', root).addEventListener('click', () => cobrar(carrito, (venta) => { carrito = []; pintarCarrito(); cargarVitrina(); barraCaja($('#pos-caja', root)); mostrarResultado(venta); }));
  pintarCarrito();
  barraCaja($('#pos-caja', root));
  api.get('/api/categorias').then((c) => { categorias = c; pintarCategorias(); }).catch(() => {});
  cargarVitrina();
  if (query.producto) { try { const p = await api.get(`/api/productos/${query.producto}`); agregar(p); } catch { /* nada */ } }
  setTimeout(() => q.focus(), 100);
}

function cobrar(carrito, alConfirmar) {
  const metodos = estado.config.metodos_pago || ['efectivo'];
  const totalCarrito = () => carrito.reduce((s, it) => s + it.cantidad * it.precio_unitario - (it.descuento || 0), 0);
  let totalBase = totalCarrito();
  const pagos = [{ metodo: 'efectivo', valor: totalBase }];
  let cliente = null;
  let descuento = 0;
  let moneda = 'COP';
  let tasa = null; // control de tasa (campoTasa) cuando la venta es en USD
  // Origen comercial (marketing): canal por el que llegó el cliente y campaña; se precargan desde la ficha del cliente.
  let canalOrigen = ''; let campanaId = ''; let campanas = [];
  const veMarketing = estado.tieneAlguno('marketing.ver', 'marketing.editar', 'marketing.leads');
  const precargarOrigen = (c) => { if (!c) return; if (c.origen_canal && !canalOrigen) canalOrigen = c.origen_canal; if (c.origen_campana_id && !campanaId) campanaId = String(c.origen_campana_id); };
  const asignaResponsable = estado.tieneAlguno('usuarios.administrar', 'comisiones.administrar');
  const tasaValor = () => (moneda === 'USD' && tasa ? tasa.valor() : 1);
  const r2 = (n) => Math.round(n * 100) / 100;
  const totalFinal = () => Math.max(0, totalBase - descuento);           // COP
  const totalM = () => (moneda === 'USD' ? r2(totalFinal() / (tasaValor() || 1)) : totalFinal()); // en la moneda de la venta
  const pagado = () => pagos.reduce((s, p) => s + (p.valor || 0), 0);
  // Al elegir un cliente mayorista (o quitarlo) se recalcula la tarifa de todo el carrito.
  const recalcularTarifas = () => {
    const antes = totalBase;
    aplicarTarifas(carrito, !!(cliente && cliente.tipo_cliente === 'mayorista'));
    totalBase = totalCarrito();
    if (totalBase !== antes && pagos.length === 1 && pagos[0].metodo === 'efectivo') pagos[0].valor = totalM();
  };
  const costos = { comision: 0, gastos_venta: 0, impuestos: 0 };
  const cuerpo = document.createElement('div');
  const m = modal({ titulo: 'Cobrar', cuerpo, ancho: true, acciones: [{ texto: 'Confirmar venta', clase: 'negro', id: 'cb-confirmar', alHacerClic: async ({ boton }) => {
    const saldo = r2(totalM() - pagado());
    if (saldo < -0.005) { toast('Los pagos superan el total', 'error'); return false; }
    if (saldo > 0.005 && !cliente) { toast('Para dejar saldo a crédito selecciona el cliente', 'error'); return false; }
    if (moneda === 'USD' && !(tasa && tasa.valor() > 0)) { toast('Indica la tasa de cambio de la venta', 'error'); return false; }
    const t = tasaValor();
    const datos = {
      cliente_id: cliente ? cliente.id : null,
      moneda, ...(moneda === 'USD' ? tasa.datos() : {}),
      // Sin precio manual el servidor aplica su tarifa (detal o mayor); solo se envía el precio que se cambió a mano.
      items: carrito.map((it) => ({ producto_id: it.producto_id, cantidad: it.cantidad, precio_unitario: it.manual ? (moneda === 'USD' ? r2(it.precio_unitario / t) : it.precio_unitario) : undefined, descuento: moneda === 'USD' ? r2((it.descuento || 0) / t) : (it.descuento || 0), seriales: it.seriales || [] })),
      descuento: moneda === 'USD' ? r2(descuento / t) : descuento,
      comision: costos.comision, gastos_venta: costos.gastos_venta, impuestos: costos.impuestos,
      pagos: pagos.filter((p) => p.valor > 0).map((p) => ({ metodo_pago: p.metodo, valor: p.valor, referencia: p.referencia || null, comprobante: p.comprobante || null })),
      observaciones: $('#cb-obs', cuerpo).value.trim(),
      vendedor_id: $('#cb-vendedor', cuerpo) ? $('#cb-vendedor', cuerpo).value : undefined,
      campana_id: veMarketing && campanaId ? Number(campanaId) : undefined,
      canal_origen: veMarketing && canalOrigen ? canalOrigen : undefined,
      autorizar_stock_negativo: $('#cb-neg', cuerpo) ? $('#cb-neg', cuerpo).checked : false,
    };
    if (saldo > 0.005) datos.credito = { numero_cuotas: Number($('#cr-cuotas', cuerpo).value) || 1, frecuencia: $('#cr-frec', cuerpo).value, primera_fecha: $('#cr-fecha', cuerpo).value, interes_pct: Number($('#cr-interes', cuerpo).value) || 0, condiciones: $('#cr-cond', cuerpo).value.trim() };
    boton.textContent = 'Guardando…';
    try {
      const venta = await api.post('/api/ventas', datos);
      toast(`Venta ${venta.numero} registrada`, 'ok');
      alConfirmar(venta);
    } catch (e) {
      boton.textContent = 'Confirmar venta';
      if (e.codigo === 'stock_insuficiente' || (e.datos && e.datos.codigo === 'stock_insuficiente')) {
        const d = e.datos;
        if (d.puede_autorizar && await confirmar(`${e.message}. ¿Autorizar la venta sin stock? Quedará un faltante en inventario.`, { textoOk: 'Autorizar', peligro: true })) { $('#cb-neg', cuerpo).checked = true; return false; }
      }
      throw e;
    }
  } }] });

  const pintarBase = () => {
    const usd = moneda === 'USD';
    const t = tasaValor();
    const saldo = r2(totalM() - pagado());
    const dinero = (v) => (usd ? fmt.usd(v) : fmt.cop(v));
    const tasaHtml = $('#cb-tasa', cuerpo) ? $('#cb-tasa', cuerpo).innerHTML : '';
    cuerpo.innerHTML = `
      <div class="row between"><div><div class="muted xs">Total a cobrar</div><div class="hero-num">${fmt.cop(totalFinal())}</div>${usd ? `<div class="small"><b>${fmt.usd(totalM())}</b> <span class="muted">a ${fmt.tasa(t)}</span></div>` : ''}${descuento ? `<div class="small muted">Subtotal ${fmt.cop(totalBase)} − descuento ${fmt.cop(descuento)}</div>` : ''}</div>
        <div class="col" style="align-items:flex-end"><select id="cb-moneda" class="btn chico suave" style="min-height:34px"><option value="COP" ${!usd ? 'selected' : ''}>Cobrar en COP</option><option value="USD" ${usd ? 'selected' : ''}>Cobrar en USD</option></select>${estado.tiene('ventas.descuento') ? `<button class="btn chico suave" id="cb-desc">${icono('tag', 14)} Descuento</button>` : ''}</div></div>
      <div id="cb-tasa" ${usd ? '' : 'hidden'} class="mt">${tasaHtml}</div>
      <div class="sep"></div>
      <div class="campo"><label>Cliente ${saldo > 0 ? '*' : '(opcional)'}</label><div class="row"><button type="button" class="btn suave grow" id="cb-cliente" style="justify-content:space-between"><span>${cliente ? esc(cliente.nombre) + (cliente.telefono ? ' · ' + esc(cliente.telefono) : '') : 'Consumidor final'}${cliente && cliente.tipo_cliente === 'mayorista' ? ' <span class="badge mayor">Mayorista</span>' : ''}</span>${icono('chevron', 18)}</button>${cliente ? `<button type="button" class="btn icono" id="cb-cliente-x">${icono('x')}</button>` : ''}</div></div>
      ${veMarketing ? `<div class="grid2"><div class="campo"><label>¿Cómo llegó el cliente?</label>${selectCanal('cb-canal', canalOrigen)}</div><div class="campo"><label>Campaña</label>${selectCampana('cb-camp', campanas, campanaId, { vacio: campanas.length ? 'Sin campaña' : 'Sin campañas activas' })}<div class="ayuda">Opcional: así la venta queda atribuida a esa publicidad.</div></div></div>` : ''}
      ${asignaResponsable ? `<div class="campo"><label>Responsable comercial</label><select id="cb-vendedor"><option value="${estado.usuario.id}">${esc(estado.usuario.nombre)} (yo)</option><option value="pendiente">Pendiente de asignación</option></select><div class="ayuda">Quien hizo la venta: define a quién se le reconoce la ganancia y la comisión.</div></div>` : ''}
      ${cliente && cliente.tipo_cliente === 'mayorista' ? `<div class="alerta mayor small mb">${icono('store', 16)} Cliente mayorista: todo el carrito va con precio al por mayor.</div>` : ''}
      <div class="et-campo mb">Pagos recibidos</div>
      <div id="cb-pagos">${pagos.map((p, i) => `<div class="linea-pago"><select data-pm="${i}">${metodos.map((mt) => `<option value="${mt}" ${p.metodo === mt ? 'selected' : ''}>${esc(nombreMetodo(mt))}</option>`).join('')}</select>${usd ? `<input data-pv="${i}" type="number" step="0.01" min="0" inputmode="decimal" value="${p.valor || ''}" placeholder="USD">` : `<input data-pv="${i}" data-money value="${p.valor || ''}" placeholder="Valor">`}<button type="button" class="btn icono chico" data-px="${i}" aria-label="Quitar">${icono('x', 16)}</button>${p.metodo !== 'efectivo' ? `<div style="grid-column:1/-1" class="row"><input data-pr="${i}" placeholder="Referencia / n° de transacción" value="${esc(p.referencia || '')}" class="grow"><button type="button" class="btn icono" data-pc="${i}" title="Adjuntar comprobante">${p.comprobante ? icono('check') : icono('camera')}</button></div>` : ''}</div>`).join('')}</div>
      <div class="row wrap gap"><button type="button" class="btn chico suave" id="cb-add">${icono('plus', 14)} Otro pago</button><button type="button" class="btn chico suave" id="cb-todo">Todo en efectivo</button><button type="button" class="btn chico suave" id="cb-cero">Todo a crédito</button></div>
      <div class="mt ${saldo > 0.005 ? 'alerta aviso' : saldo < -0.005 ? 'alerta peligro' : 'alerta ok'}">${saldo > 0.005 ? `Saldo a crédito: <b>${dinero(saldo)}</b>${usd ? ` <span class="muted xs">(≈ ${fmt.cop(saldo * t)} a la tasa de hoy; el crédito se lleva en USD)</span>` : ''}` : saldo < -0.005 ? `Los pagos superan el total por ${dinero(-saldo)}` : 'Pago completo'}</div>
      <div id="cb-credito" ${saldo > 0.005 ? '' : 'hidden'} class="mt">
        <div class="et-campo mb">Condiciones del crédito</div>
        <div class="grid3"><div class="campo"><label>Cuotas</label><input id="cr-cuotas" type="number" min="1" max="60" value="${cuotasPrev || 1}" inputmode="numeric"></div>
        <div class="campo"><label>Frecuencia</label><select id="cr-frec">${['semanal', 'quincenal', 'mensual'].map((f) => `<option value="${f}" ${(frecPrev || 'mensual') === f ? 'selected' : ''}>${f[0].toUpperCase() + f.slice(1)}</option>`).join('')}</select></div>
        <div class="campo"><label>Primera cuota</label><input id="cr-fecha" type="date" value="${fechaPrev || sumarDias(hoyISO(), 30)}"></div></div>
        <div class="grid2"><div class="campo"><label>Interés total (%)</label><input id="cr-interes" type="number" min="0" step="0.1" value="${interesPrev || 0}" inputmode="decimal"></div><div class="campo"><label>Cuota aprox.</label><input readonly value="${usd ? fmt.usd(r2((saldo * (1 + (interesPrev || 0) / 100)) / (cuotasPrev || 1))) : fmt.cop(Math.ceil((saldo * (1 + (interesPrev || 0) / 100)) / (cuotasPrev || 1)))}"></div></div>
        <div class="campo"><label>Condiciones pactadas</label><textarea id="cr-cond" placeholder="Ej. garantía, día de pago acordado…">${esc(condPrev || '')}</textarea></div>
      </div>
      <details class="mt"><summary class="et-campo" style="cursor:pointer">Costos de esta venta (opcional)</summary><div class="grid3 mt"><div class="campo"><label>Comisión (COP)</label><input id="cv-com" data-money value="${costos.comision || ''}"></div><div class="campo"><label>Gastos de venta (COP)</label><input id="cv-gas" data-money value="${costos.gastos_venta || ''}"></div><div class="campo"><label>Impuestos (COP, informativo)</label><input id="cv-imp" data-money value="${costos.impuestos || ''}"></div></div><div class="xs muted">Comisiones y gastos se restan en la ganancia neta; los impuestos se muestran aparte.</div></details>
      <div class="campo mt"><label>Observaciones</label><textarea id="cb-obs" placeholder="Opcional">${esc(obsPrev || '')}</textarea></div>
      <label class="check" id="cb-neg-wrap" hidden><input type="checkbox" id="cb-neg"> Autorizar venta sin stock suficiente</label>`;
    activarDinero(cuerpo);
    const sc = $('#cb-canal', cuerpo); if (sc) sc.addEventListener('change', () => { canalOrigen = sc.value; });
    const scp = $('#cb-camp', cuerpo); if (scp) scp.addEventListener('change', () => { campanaId = scp.value; });
    $('#cb-moneda', cuerpo).addEventListener('change', (e) => {
      recordar();
      moneda = e.target.value;
      const cont = $('#cb-tasa', cuerpo);
      if (moneda === 'USD') { cont.hidden = false; cont.innerHTML = ''; tasa = campoTasa(cont, { fecha: hoyISO(), alCambiar: () => { const tv = tasaValor() || 1; pagos.length = 0; pagos.push({ metodo: 'efectivo', valor: r2(totalFinal() / tv) }); pintar(); } }); }
      else { tasa = null; pagos.length = 0; pagos.push({ metodo: 'efectivo', valor: totalFinal() }); pintar(); }
    });
    ['#cv-com', '#cv-gas', '#cv-imp'].forEach((id, i) => $(id, cuerpo).addEventListener('blur', (e) => { costos[['comision', 'gastos_venta', 'impuestos'][i]] = leerDinero(e.target); }));
    $$('[data-pm]', cuerpo).forEach((s) => s.addEventListener('change', () => { pagos[Number(s.dataset.pm)].metodo = s.value; recordar(); pintar(); }));
    $$('[data-pv]', cuerpo).forEach((inp) => inp.addEventListener('blur', () => { pagos[Number(inp.dataset.pv)].valor = usd ? leerDecimal(inp) : leerDinero(inp); recordar(); pintar(); }));
    $$('[data-pr]', cuerpo).forEach((inp) => inp.addEventListener('input', () => { pagos[Number(inp.dataset.pr)].referencia = inp.value; }));
    $$('[data-pc]', cuerpo).forEach((b) => b.addEventListener('click', async () => { const f = await capturar({ camara: true }); if (f) { pagos[Number(b.dataset.pc)].comprobante = f.dataUrl; toast('Comprobante adjunto', 'ok'); pintar(); } }));
    $$('[data-px]', cuerpo).forEach((b) => b.addEventListener('click', () => { pagos.splice(Number(b.dataset.px), 1); recordar(); pintar(); }));
    $('#cb-add', cuerpo).addEventListener('click', () => { recordar(); pagos.push({ metodo: metodos.find((x) => x !== 'efectivo') || 'efectivo', valor: Math.max(0, r2(totalM() - pagado())) }); pintar(); });
    $('#cb-todo', cuerpo).addEventListener('click', () => { recordar(); pagos.length = 0; pagos.push({ metodo: 'efectivo', valor: Math.max(0, totalM()) }); pintar(); });
    $('#cb-cero', cuerpo).addEventListener('click', () => { recordar(); pagos.length = 0; pintar(); });
    $('#cb-cliente', cuerpo).addEventListener('click', () => { recordar(); selectorBusqueda({ titulo: 'Cliente', placeholder: 'Nombre, teléfono o cédula', buscar: async (t) => (await api.get('/api/clientes' + api.qs({ q: t }))).map((c) => ({ id: c.id, titulo: c.nombre, sub: [c.tipo_cliente === 'mayorista' ? 'Mayorista' : '', c.telefono, c.saldo_pendiente ? 'debe ' + fmt.cop(c.saldo_pendiente) : '', c.origen_canal ? 'llegó por ' + nombreCanal(c.origen_canal) : ''].filter(Boolean).join(' · '), datos: c })), alElegir: (it) => { cliente = it.datos; precargarOrigen(cliente); recalcularTarifas(); pintar(); }, crearNuevo: { texto: 'Crear cliente nuevo', accion: (texto) => nuevoCliente(texto, (c) => { cliente = c; precargarOrigen(c); recalcularTarifas(); pintar(); }) } }); });
    const cx = $('#cb-cliente-x', cuerpo); if (cx) cx.addEventListener('click', () => { recordar(); cliente = null; recalcularTarifas(); pintar(); });
    const bd = $('#cb-desc', cuerpo); if (bd) bd.addEventListener('click', () => { recordar(); modal({ titulo: 'Descuento general', cuerpo: `<div class="grid2"><div class="campo"><label>Valor en pesos</label><input id="d-valor" data-money value="${descuento || ''}"></div><div class="campo"><label>o porcentaje</label><input id="d-pct" type="number" min="0" max="100" inputmode="decimal"></div></div><p class="muted small">Máximo autorizado para tu rol: ${estado.config.descuento_maximo_pct}%</p>`, acciones: [{ texto: 'Aplicar', clase: 'primario', alHacerClic: ({ modal: mm }) => { const pct = Number($('#d-pct', mm).value); descuento = pct > 0 ? Math.round(totalBase * pct / 100) : leerDinero($('#d-valor', mm)); if (pagos.length === 1 && pagos[0].metodo === 'efectivo') pagos[0].valor = totalM(); pintar(); } }] }); });
    const nw = $('#cb-neg-wrap', cuerpo); if (estado.config.permitir_stock_negativo && estado.tiene('inventario.stock_negativo')) nw.hidden = false;
    if (asignaResponsable) api.get('/api/usuarios').then((us) => { const s = $('#cb-vendedor', cuerpo); if (!s) return; const previo = s.value; s.innerHTML = us.filter((u) => u.activo !== 0 && u.tipo_comercial !== 'otro').map((u) => `<option value="${u.id}">${esc(u.nombre)}${u.id === estado.usuario.id ? ' (yo)' : ''} · ${u.tipo_comercial === 'empleador' ? 'empleador' : 'vendedor'}</option>`).join('') + '<option value="pendiente">Pendiente de asignación</option>'; s.value = previo; if (!s.value) s.value = String(estado.usuario.id); }).catch(() => {});
    $('#cr-cuotas', cuerpo).addEventListener('change', () => { recordar(); pintar(); });
    $('#cr-interes', cuerpo).addEventListener('change', () => { recordar(); pintar(); });
  };
  let cuotasPrev = 1, frecPrev = 'mensual', fechaPrev = null, interesPrev = 0, condPrev = '', obsPrev = '';
  const recordar = () => { const g = (id) => $(id, cuerpo); if (g('#cr-cuotas')) { cuotasPrev = Number(g('#cr-cuotas').value) || 1; frecPrev = g('#cr-frec').value; fechaPrev = g('#cr-fecha').value; interesPrev = Number(g('#cr-interes').value) || 0; condPrev = g('#cr-cond').value; } if (g('#cb-obs')) obsPrev = g('#cb-obs').value; if (g('#cb-canal')) canalOrigen = g('#cb-canal').value; if (g('#cb-camp')) campanaId = g('#cb-camp').value; ['#cv-com', '#cv-gas', '#cv-imp'].forEach((id, i) => { if (g(id)) costos[['comision', 'gastos_venta', 'impuestos'][i]] = leerDinero(g(id)); }); $$('[data-pv]', cuerpo).forEach((inp) => { pagos[Number(inp.dataset.pv)].valor = moneda === 'USD' ? leerDecimal(inp) : leerDinero(inp); }); };
  // Repinta la hoja conservando el control de tasa (vive en #cb-tasa con sus propios listeners).
  const pintar = () => { const cont = $('#cb-tasa', cuerpo); const nodo = cont ? cont.firstElementChild : null; pintarBase(); const nuevo = $('#cb-tasa', cuerpo); if (nodo && nuevo) { nuevo.innerHTML = ''; nuevo.appendChild(nodo); } };
  pintar();
  // Campañas activas o pausadas para el selector (no bloquea la hoja de cobro si falla).
  if (veMarketing) campanasAbiertas().then((l) => { campanas = l; if (document.body.contains(cuerpo)) { recordar(); pintar(); } }).catch(() => {});
}

export function nuevoCliente(nombreInicial, alCrear) {
  const veMarketing = estado.tieneAlguno('marketing.ver', 'marketing.editar', 'marketing.leads');
  modal({
    titulo: 'Nuevo cliente',
    cuerpo: `<div class="campo"><label>Nombre completo *</label><input id="nc-nombre" value="${esc(nombreInicial || '')}"></div><div class="grid2"><div class="campo"><label>Teléfono / WhatsApp</label><input id="nc-tel" type="tel" inputmode="tel"></div><div class="campo"><label>Identificación</label><input id="nc-id"></div></div><div class="grid2"><div class="campo"><label>Dirección</label><input id="nc-dir"></div><div class="campo"><label>Barrio</label><input id="nc-barrio"></div></div>
      <div class="campo"><label>Tipo de cliente</label><select id="nc-tipo"><option value="detal">Detal (consumidor)</option><option value="mayorista">Mayorista (tienda, bar, eventos): siempre precio mayor</option></select></div>
      ${veMarketing ? `<div class="grid2"><div class="campo"><label>¿Cómo nos conoció?</label>${selectCanal('nc-canal', '')}</div><div class="campo"><label>Campaña de origen</label><select id="nc-camp"><option value="">Sin campaña</option></select></div></div>` : ''}`,
    acciones: [{ texto: 'Crear cliente', clase: 'primario', alHacerClic: async ({ modal: m }) => { const sc = $('#nc-canal', m); const scp = $('#nc-camp', m); const c = await api.post('/api/clientes', { nombre: $('#nc-nombre', m).value, telefono: $('#nc-tel', m).value, identificacion: $('#nc-id', m).value, direccion: $('#nc-dir', m).value, barrio: $('#nc-barrio', m).value, tipo_cliente: $('#nc-tipo', m).value, origen_canal: sc && sc.value ? sc.value : null, origen_campana_id: scp && scp.value ? Number(scp.value) : null }); toast('Cliente creado', 'ok'); alCrear(c); } }],
    alMontar: (m) => {
      setTimeout(() => $('#nc-nombre', m).focus(), 60);
      if (veMarketing) campanasAbiertas().then((l) => { const s = $('#nc-camp', m); if (s) s.innerHTML = `<option value="">${l.length ? 'Sin campaña' : 'Sin campañas activas'}</option>` + l.map((c) => `<option value="${c.id}">${esc(c.nombre)} · ${esc(nombrePlataforma(c.plataforma))}</option>`).join(''); }).catch(() => {});
    },
  });
}

// Origen de la venta en el detalle: la ficha de campaña exige marketing.ver o marketing.editar, así que a quien no los
// tiene (vendedor, cajero) se le muestra el nombre de la campaña como texto y no como un enlace que termina en 403
// (mismo criterio que la ficha de cliente).
export function atribucionVenta(a) {
  if (!a || !a.campana_nombre || estado.tieneAlguno('marketing.ver', 'marketing.editar')) return atribucionBadge(a);
  return `${atribucionBadge({ ...a, campana_nombre: null, canal: null })} <span class="small">${esc(a.campana_nombre)}</span>${a.canal ? ` <span class="muted xs">· ${esc(nombreCanal(a.canal))}</span>` : ''}`;
}

// Cambiar a mano la atribución de una venta (permiso marketing.editar; queda en auditoría).
function cambiarAtribucion(v, alTerminar) {
  campanasAbiertas().then((lista) => {
    const actual = v.atribucion && v.atribucion.campana_id;
    const opciones = [...lista];
    if (actual && !opciones.some((c) => c.id === actual)) opciones.unshift({ id: actual, nombre: v.atribucion.campana_nombre || `Campaña ${actual}`, plataforma: v.atribucion.campana_plataforma || '' });
    modal({
      titulo: `Origen de la venta ${v.numero}`,
      cuerpo: `<p class="small muted">Hoy: ${atribucionBadge(v.atribucion) || 'sin atribución'}${v.atribucion && v.atribucion.regla_texto ? ` · ${esc(v.atribucion.regla_texto)}` : ''}.</p><div class="campo mt"><label>Campaña</label>${selectCampana('at-camp', opciones, actual || '', { vacio: 'Sin campaña (queda sin atribución)' })}</div><div class="campo"><label>Canal</label>${selectCanal('at-canal', (v.atribucion && v.atribucion.canal) || v.canal_origen || '')}</div><div class="campo"><label>Motivo</label><input id="at-motivo" placeholder="Ej. el cliente dijo que vio el anuncio"></div>`,
      acciones: [{ texto: 'Guardar', clase: 'primario', alHacerClic: async ({ modal: m }) => { await api.post(`/api/marketing/ventas/${v.id}/atribucion`, { campana_id: $('#at-camp', m).value || null, canal: $('#at-canal', m).value || null, motivo: $('#at-motivo', m).value.trim() || null }); toast('Atribución actualizada', 'ok'); alTerminar(); } }],
    });
  }).catch(mostrarError);
}

function mostrarResultado(v) {
  modal({
    titulo: `Venta ${v.numero} registrada`,
    cuerpo: `<div class="center"><div class="muted">Total</div><div class="hero-num">${fmt.cop(v.total)}</div><div class="muted small mt">${esc(v.cliente_nombre || 'Consumidor final')} · ${TIPOS_PAGO[v.tipo_pago]}${v.credito ? ` · saldo ${fmt.cop(v.credito.saldo_actual)}` : ''}</div></div>
      <div class="grid2 mt-l"><button class="btn primario" id="rs-wa">${icono('whatsapp')} WhatsApp</button><a class="btn suave" href="/api/ventas/${v.id}/pdf" target="_blank">${icono('download')} PDF</a><a class="btn suave" href="#/ventas/${v.id}">${icono('eye')} Ver venta</a><button class="btn suave" id="rs-imprimir">${icono('print')} Imprimir</button></div>`,
    acciones: [{ texto: 'Nueva venta', clase: 'negro' }],
    alMontar: (m) => {
      $('#rs-wa', m).addEventListener('click', async () => { const s = await api.get(`/api/ventas/${v.id}/compartir`); window.open(s.whatsapp, '_blank'); });
      $('#rs-imprimir', m).addEventListener('click', () => window.open(`/comprobante/${v.token_publico}`, '_blank'));
    },
  });
}

// ---------- Historial ----------
async function historial(root, query, setTopbar) {
  setTopbar({ titulo: 'Ventas', atras: estado.tiene('ventas.crear') ? '#/vender' : null, acciones: estado.tiene('ventas.crear') ? [{ icono: 'plus', titulo: 'Nueva venta', href: '#/vender' }] : [] });
  const f = { ...filtroInicial('ventas', 'hoy'), q: '', estado: query.estado || '' };
  if (query.periodo) f.periodo = query.periodo;
  if (query.desde && query.hasta) { f.periodo = 'rango'; f.desde = query.desde; f.hasta = query.hasta; }
  let verResumen = sessionStorage.getItem('ventas.resumen') !== '0';
  renderizar(root, html`<div id="v-caja" class="mb"></div><div id="v-filtros"></div>
    <div class="row between mb"><h2 style="margin:0">Resumen del periodo</h2><button class="btn chico suave" id="v-toggle">${verResumen ? 'Ocultar resumen' : 'Ver resumen'}</button></div>
    <div id="v-panel" class="mb" ${verResumen ? '' : 'hidden'}></div>
    <h2 class="mb">Historial de transacciones</h2>
    <div class="buscador">${raw(icono('search'))}<input type="search" id="v-q" placeholder="Número, cliente o producto"></div>
    <div id="v-resumen" class="muted small mt"></div><div id="v-lista" class="lista mt"></div>`);
  const cargarLista = async () => {
    $('#v-lista', root).innerHTML = String(cargando(3));
    const rango = f.periodo === 'todo' ? {} : f.periodo === 'rango' ? { desde: f.desde, hasta: f.hasta } : rangoDe(f.periodo);
    try {
      const r = await api.get('/api/ventas' + api.qs({ ...rango, q: f.q, estado: f.estado, limite: 200 }));
      const total = r.ventas.filter((v) => v.estado !== 'anulada').reduce((s, v) => s + v.total, 0);
      $('#v-resumen', root).textContent = `${r.total} venta(s) · ${fmt.cop(total)}`;
      $('#v-lista', root).innerHTML = r.ventas.length ? r.ventas.map((v) => `<a class="item" href="#/ventas/${v.id}"><div class="cuerpo"><div class="titulo">${esc(v.numero)} · ${esc(v.cliente_nombre || 'Consumidor final')}</div><div class="sub">${fmt.fechaHora(v.fecha)} · ${v.vendedor_nombre ? esc(v.vendedor_nombre) : '<span class="neg bold">sin responsable</span>'} · ${esc(v.resumen || '')}</div></div><div class="fin"><div class="valor">${fmt.cop(v.total)}</div><div class="xs">${v.estado === 'confirmada' ? esc(TIPOS_PAGO[v.tipo_pago]) : badge(ESTADOS_VENTA, v.estado)}</div></div></a>`).join('') : String(vacio('No hay ventas en este periodo'));
    } catch (e) { mostrarError(e); }
  };
  const cargarPanel = () => { if (!verResumen) return; panelVentas($('#v-panel', root), f).catch((e) => { if (e.status !== 403) mostrarError(e); }); };
  const cargar = () => { guardarFiltro('ventas', f); cargarPanel(); cargarLista(); };
  filtroPeriodo($('#v-filtros', root), f, cargar, { presets: [...PRESETS, ['todo', 'Todo']] });
  $('#v-toggle', root).addEventListener('click', () => { verResumen = !verResumen; sessionStorage.setItem('ventas.resumen', verResumen ? '1' : '0'); $('#v-panel', root).hidden = !verResumen; $('#v-toggle', root).textContent = verResumen ? 'Ocultar resumen' : 'Ver resumen'; if (verResumen && !$('#v-panel', root).innerHTML.trim()) cargarPanel(); });
  $('#v-q', root).addEventListener('input', debounce((e) => { f.q = e.target.value.trim(); cargarLista(); }));
  barraCaja($('#v-caja', root), { alCambiar: cargar });
  cargar();
}
// Rango de fechas de un preset (compartido con caja y reportes): hoy, 7d, 30d, semana, mes, anio; otro valor = sin límite.
export function rangoDe(p) {
  const h = hoyISO();
  if (p === 'hoy') return { desde: h, hasta: h };
  if (p === '7d') return { desde: sumarDias(h, -6), hasta: h };
  if (p === '30d') return { desde: sumarDias(h, -29), hasta: h };
  if (p === 'semana') { const d = new Date(); const dow = (d.getDay() + 6) % 7; return { desde: sumarDias(h, -dow), hasta: h }; }
  if (p === 'mes') return { desde: h.slice(0, 8) + '01', hasta: h };
  if (p === 'anio') return { desde: h.slice(0, 5) + '01-01', hasta: h };
  return {};
}

// ---------- Detalle ----------
async function detalle(root, id, setTopbar) {
  let v;
  try { v = await api.get(`/api/ventas/${id}`); } catch (e) { mostrarError(e); return navegar('#/ventas', true); }
  setTopbar({ titulo: `Venta ${v.numero}`, atras: '#/ventas', acciones: [{ icono: 'whatsapp', titulo: 'Compartir por WhatsApp', alHacerClic: async () => { const s = await api.get(`/api/ventas/${id}/compartir`); window.open(s.whatsapp, '_blank'); } }, { icono: 'download', titulo: 'PDF', href: `/api/ventas/${id}/pdf` }] });
  const veCostos = estado.tiene('inventario.ver');
  const pendientes = v.items.some((it) => it.cantidad - it.cantidad_devuelta > 0);
  const usd = v.moneda === 'USD';
  renderizar(root, html`<div class="card">
      <div class="row between"><div><div class="muted small">${fmt.fechaHora(v.fecha)} · ${v.pendiente_asignacion ? html`<span class="badge peligro">Pendiente de asignación</span>` : html`${v.vendedor_nombre || ''} <span class="badge ${v.responsable_tipo === 'empleador' ? 'empleador' : 'vendedor'}">${v.responsable_tipo === 'empleador' ? 'Empleador' : 'Vendedor'}</span>`}${v.registrado_por_nombre && v.registrado_por_nombre !== v.vendedor_nombre ? ` · registró ${v.registrado_por_nombre}` : ''}</div><h2 style="margin:4px 0">${v.cliente_nombre || 'Consumidor final'} ${v.cliente_tipo === 'mayorista' ? raw(badge(TIPOS_CLIENTE, 'mayorista')) : ''}</h2><div class="muted small">${v.cliente_telefono || ''}</div></div><div class="right">${badge(ESTADOS_VENTA, v.estado)}<div class="muted xs mt">${TIPOS_PAGO[v.tipo_pago]}</div>${usd ? html`<div class="mt" style="margin-top:4px"><span class="badge negro">USD</span> ${badge(ORIGEN_TASA, v.tasa_origen)}</div>` : ''}</div></div>
      ${v.atribucion && (v.atribucion.tipo !== 'desconocida' || v.canal_origen || estado.tiene('marketing.editar')) ? html`<div class="row wrap gap mt small"><span class="muted">Origen:</span>${raw(atribucionVenta(v.atribucion))}${v.atribucion.tipo === 'desconocida' && !v.atribucion.canal ? html`<span class="muted xs">sin información de origen</span>` : ''}${v.atribucion.regla_texto && v.atribucion.tipo !== 'desconocida' ? html`<span class="muted xs" title="Regla de atribución">· ${v.atribucion.regla_texto}</span>` : ''}${estado.tiene('marketing.editar') ? html`<button type="button" class="btn chico fantasma" id="v-atrib" aria-label="Cambiar el origen de la venta">${raw(icono('edit', 14))} Cambiar</button>` : ''}</div>` : ''}
      ${v.domicilio_id ? html`<a class="alerta info small row between mt" href="#/domicilios/${v.domicilio_id}"><span>${raw(icono('moto', 16))} Domicilio <b>${v.domicilio_numero}</b> · ${v.domicilio_direccion || ''} · envío ${fmt.cop(v.cargo_domicilio)}</span>${raw(icono('chevron', 16))}</a>` : ''}
      ${v.estado === 'anulada' ? html`<div class="alerta peligro mt">Anulada ${fmt.fechaHora(v.anulada_en)} · ${v.motivo_anulacion}</div>` : ''}
      ${usd ? html`<div class="alerta info mt small">Venta en dólares: <b>${fmt.usd(v.total_moneda)}</b> a tasa <b>${fmt.tasa(v.tasa_cambio)}</b>${v.tasa_nota ? ' (' + v.tasa_nota + ')' : ''} = ${fmt.cop(v.total)}. El ingreso en pesos se calcula con esta tasa.</div>` : ''}
      <div class="lista mt">${v.items.map((it) => html`<div class="item"><div class="cuerpo"><div class="titulo">${it.nombre_producto} ${raw(tarifaBadge(it.tarifa))}</div><div class="sub">${it.cantidad} × ${usd ? `${fmt.usd(it.precio_unitario_moneda)} (${fmt.cop(it.precio_unitario)})` : fmt.cop(it.precio_unitario)}${it.precio_unitario !== it.precio_lista ? ` (lista ${fmt.cop(it.precio_lista)})` : ''}${it.descuento ? ` − desc. ${fmt.cop(it.descuento)}` : ''}${it.cantidad_devuelta ? ` · devueltos ${it.cantidad_devuelta}` : ''}</div>${it.seriales.length ? html`<div class="sub mono">${it.seriales.join(', ')}</div>` : ''}${veCostos ? html`<div class="sub">Costo ${fmt.cop(it.costo_total)} · ganancia <b class="${it.ganancia >= 0 ? 'pos' : 'neg'}">${fmt.cop(it.ganancia)}</b>${it.lotes.length ? ` · lote(s): ${it.lotes.map((l) => `${fmt.fecha(l.lote_fecha)}${l.proveedor_nombre ? ' ' + l.proveedor_nombre : ''} ${fmt.cop(l.costo_unitario)}${l.moneda_compra === 'USD' ? ` (${fmt.usd(l.costo_unitario_moneda)} a ${fmt.tasa(l.tasa_compra)})` : ''}`).join('; ')}` : ''}</div>` : ''}</div><div class="fin"><div class="valor">${fmt.cop(it.total)}</div></div></div>`)}</div>
      <dl class="kv mt">${v.descuento || v.cargo_domicilio ? html`<dt>Subtotal</dt><dd>${fmt.cop(v.subtotal)}</dd>` : ''}${v.descuento ? html`<dt>Descuento</dt><dd>−${fmt.cop(v.descuento)}</dd>` : ''}${v.cargo_domicilio ? html`<dt>Domicilio</dt><dd>${fmt.cop(v.cargo_domicilio)}</dd>` : ''}<dt>Total</dt><dd class="total">${fmt.cop(v.total)}${usd ? html` <span class="muted xs">(${fmt.usd(v.total_moneda)})</span>` : ''}</dd>${veCostos ? html`<dt>Costo real de adquisición</dt><dd>${fmt.cop(v.costo_total)}</dd><dt>Ganancia bruta</dt><dd class="${v.ganancia >= 0 ? 'pos' : 'neg'}">${fmt.cop(v.ganancia)} (${fmt.pct(v.total ? (v.ganancia * 100) / v.total : 0)})</dd>${v.comision || v.gastos_venta ? html`<dt>Comisión y gastos de venta</dt><dd>−${fmt.cop(v.comision + v.gastos_venta)}</dd>` : ''}<dt>Ganancia neta ${v.resultado === 'estimado' ? 'estimada' : 'definitiva'}</dt><dd class="${v.ganancia_neta >= 0 ? 'pos' : 'neg'}">${fmt.cop(v.ganancia_neta)} ${badge(RESULTADO, v.resultado)}</dd>${v.impuestos ? html`<dt>Impuestos (informativo)</dt><dd>${fmt.cop(v.impuestos)}</dd>` : ''}${v.diferencia_cambiaria_total ? html`<dt>Diferencia cambiaria (abonos)</dt><dd class="${v.diferencia_cambiaria_total < 0 ? 'neg' : 'pos'}">${fmt.signo(v.diferencia_cambiaria_total)}</dd>` : ''}` : ''}${v.total_devuelto ? html`<dt>Devuelto</dt><dd class="neg">−${fmt.cop(v.total_devuelto)}</dd>` : ''}</dl>
      ${v.observaciones ? html`<p class="small muted mt">${v.observaciones}</p>` : ''}
      ${veCostos && estado.tiene('contabilidad.ver') ? html`<div class="row wrap gap mt"><a class="btn chico suave" href="#/contabilidad/operaciones?desde=${v.fecha.slice(0, 10)}&hasta=${v.fecha.slice(0, 10)}&periodo=rango">${raw(icono('book', 14))} Ver cómo se calculó</a>${usd && v.estado === 'confirmada' && !v.devoluciones.length && estado.tiene('contabilidad.editar') ? html`<button class="btn chico suave" id="v-tasa">${raw(icono('edit', 14))} Corregir tasa</button>` : ''}</div>` : ''}
    </div>
    <div class="card"><h2>Pagos</h2>${v.pagos.length ? html`<div class="col">${v.pagos.map((p) => html`<div class="row between small ${p.anulado ? 'muted' : ''}"><span>${fmt.fechaHora(p.fecha)} · ${p.tipo === 'reintegro' ? 'Reintegro' : p.tipo === 'abono' ? 'Abono' : 'Pago'} · ${nombreMetodo(p.metodo_pago)}${p.moneda === 'USD' ? ` · ${fmt.usd(p.valor_moneda)} a ${fmt.tasa(p.tasa_cambio)}` : ''}${p.referencia ? ' · ' + p.referencia : ''}${p.anulado ? ' (anulado)' : ''}${p.comprobante_ruta ? raw(` · <a href="/api/archivos/${esc(p.comprobante_ruta)}" target="_blank">comprobante</a>`) : ''}</span><b class="num ${p.tipo === 'reintegro' ? 'neg' : ''}">${p.tipo === 'reintegro' ? '−' : ''}${fmt.cop(p.valor)}</b></div>`)}</div>` : html`<p class="muted">Sin pagos registrados.</p>`}
      ${v.credito ? html`<a class="alerta info row between mt" href="#/creditos/${v.credito.id}"><span>Crédito ${v.credito.numero} · saldo <b>${v.credito.moneda === 'USD' ? fmt.usd(v.credito.saldo_moneda) + ' (' + fmt.cop(v.credito.saldo_actual) + ')' : fmt.cop(v.credito.saldo_actual)}</b> · ${v.credito.numero_cuotas} cuota(s)</span>${raw(icono('chevron', 18))}</a>` : ''}</div>
    ${v.devoluciones.length ? html`<div class="card"><h2>Devoluciones y anulaciones</h2><div class="col">${v.devoluciones.map((d) => html`<div class="small"><b>${d.numero}</b> · ${fmt.fechaHora(d.fecha)} · ${{ devolucion: 'Devolución', cambio: 'Cambio', anulacion: 'Anulación' }[d.tipo]} · ${d.motivo || ''} · <b>${fmt.cop(d.total)}</b><div class="muted">${d.items.map((i) => `${i.cantidad} × ${i.nombre_producto}${i.reingresa ? '' : ' (no reingresa)'}`).join(', ')}</div></div>`)}</div></div>` : ''}
    <div class="row wrap gap mt-l no-print">
      ${v.estado !== 'anulada' && pendientes && estado.tiene('ventas.devolver') ? html`<button class="btn suave" id="v-dev">${raw(icono('undo'))} Devolución / cambio</button>` : ''}
      ${v.estado !== 'anulada' && estado.tiene('ventas.anular') ? html`<button class="btn peligro" id="v-anular">${raw(icono('x'))} Anular venta</button>` : ''}
      <a class="btn suave" href="/comprobante/${v.token_publico}" target="_blank">${raw(icono('print'))} Comprobante</a>
    </div>`);
  const bd = $('#v-dev', root);
  if (bd) bd.addEventListener('click', () => devolucion(v, () => detalle(root, id, setTopbar)));
  const bat = $('#v-atrib', root);
  if (bat) bat.addEventListener('click', () => cambiarAtribucion(v, () => detalle(root, id, setTopbar)));
  const bt = $('#v-tasa', root);
  if (bt) bt.addEventListener('click', () => modal({ titulo: `Corregir tasa de ${v.numero}`, cuerpo: `<p class="muted small">Tasa actual: <b>${fmt.tasa(v.tasa_cambio)}</b>. Se recalculan el ingreso en pesos, la ganancia, los pagos y el crédito (solo si no tiene abonos). Queda en auditoría con tu usuario, valor anterior, nuevo y motivo.</p><div class="campo mt"><label>Tasa correcta</label><input id="vtz-tasa" type="number" step="0.01" min="100" inputmode="decimal" value="${v.tasa_cambio}"></div><div class="campo"><label>Motivo *</label><input id="vtz-motivo"></div>`, acciones: [{ texto: 'Corregir', clase: 'primario', alHacerClic: async ({ modal: m }) => { await api.put(`/api/ventas/${id}/tasa`, { tasa_cambio: $('#vtz-tasa', m).value, motivo: $('#vtz-motivo', m).value }); toast('Tasa corregida', 'ok'); detalle(root, id, setTopbar); } }] }));
  const ba = $('#v-anular', root);
  if (ba) ba.addEventListener('click', async () => {
    const motivo = await pedirTexto('Anular venta', { etiqueta: 'Motivo de la anulación', textoOk: 'Anular' });
    if (!motivo) return;
    if (!await confirmar('Se devolverán todas las unidades al inventario y los pagos recibidos quedarán como reintegro. ¿Continuar?', { peligro: true, textoOk: 'Anular venta' })) return;
    try { await api.post(`/api/ventas/${id}/anular`, { motivo }); toast('Venta anulada', 'ok'); detalle(root, id, setTopbar); } catch (e) { mostrarError(e); }
  });
}

function devolucion(v, alTerminar) {
  const items = v.items.filter((it) => it.cantidad - it.cantidad_devuelta > 0);
  const metodos = estado.config.metodos_pago || ['efectivo'];
  modal({
    titulo: 'Devolución o cambio',
    cuerpo: `<div class="campo"><label>Tipo</label><select id="dv-tipo"><option value="devolucion">Devolución (se reintegra dinero o se reduce el crédito)</option><option value="cambio">Cambio (luego registras la nueva venta)</option></select></div>
      <div class="et-campo mb">Productos que regresan</div>
      ${items.map((it) => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--line)"><div class="grow"><div class="bold small truncate">${esc(it.nombre_producto)}</div><div class="xs muted">vendidos ${it.cantidad - it.cantidad_devuelta} · ${fmt.cop(Math.round(it.total / it.cantidad))} c/u</div></div><input type="number" min="0" max="${it.cantidad - it.cantidad_devuelta}" value="0" data-dv="${it.id}" style="width:70px"><label class="check xs" style="min-height:0"><input type="checkbox" data-re="${it.id}" checked> reingresa</label></div>`).join('')}
      <div class="campo mt"><label>Motivo *</label><textarea id="dv-motivo"></textarea></div>
      <div class="campo"><label>Método del reintegro (si aplica)</label><select id="dv-metodo">${metodos.map((m) => `<option value="${esc(m)}">${esc(nombreMetodo(m))}</option>`).join('')}</select></div>`,
    acciones: [{ texto: 'Registrar', clase: 'primario', alHacerClic: async ({ modal: m }) => {
      const lista = $$('[data-dv]', m).map((inp) => ({ venta_item_id: Number(inp.dataset.dv), cantidad: Number(inp.value) || 0, reingresa: $(`[data-re="${inp.dataset.dv}"]`, m).checked })).filter((x) => x.cantidad > 0);
      if (!lista.length) { toast('Indica al menos una unidad', 'error'); return false; }
      const motivo = $('#dv-motivo', m).value.trim(); if (!motivo) { toast('Escribe el motivo', 'error'); return false; }
      const r = await api.post(`/api/ventas/${v.id}/devolucion`, { tipo: $('#dv-tipo', m).value, items: lista, motivo, reintegro_metodo: $('#dv-metodo', m).value });
      toast(`${r.devolucion.numero}: ${fmt.cop(r.devolucion.total)}${r.devolucion.aplicado_credito ? ` (${fmt.cop(r.devolucion.aplicado_credito)} aplicados al crédito)` : ''}`, 'ok');
      alTerminar();
    } }],
  });
}
