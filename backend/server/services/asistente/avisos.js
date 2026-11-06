'use strict';
// Avisos de Tino: lo que el usuario debería atender hoy, calculado en el servidor con los datos reales y filtrado por
// sus permisos. Alimenta tres cosas: el contador de la mascota (notificaciones), el resumen que Tino muestra al abrirlo
// y la respuesta a "¿qué tengo pendiente?".
//
// Además de los productos agotados o en el mínimo, calcula cuáles SE VAN A ACABAR pronto: con las unidades vendidas en
// los últimos días se estima el ritmo diario y cuántos días alcanza el stock actual. Es una estimación (supuesto: el
// ritmo reciente se mantiene) y así se le dice al usuario.
//
// Cada aviso lleva `claves` (una por entidad: producto, cuota, factura…). La interfaz las compara con las que ya conocía
// para notificar solo lo nuevo, en lugar de repetir el mismo aviso en cada consulta.
const { createHash } = require('node:crypto');
const { getConfig } = require('../../db');
const { hoy, sumarDias, diasEntre } = require('../../util');
const { tiene } = require('../../permisos');
const dashboard = require('../dashboard');
const creditos = require('../creditos');
const caja = require('../caja');
const L = require('./lenguaje');

const ORDEN = { alta: 0, media: 1, info: 2 };
const lista = (nombres, max = 2) => `${nombres.slice(0, max).join(', ')}${nombres.length > max ? ` y ${nombres.length - max} más` : ''}`;

// Ventana de días para medir el ritmo de ventas: 30 días, o menos si el negocio lleva menos tiempo vendiendo (mín. 7).
function ventanaRitmo(db) {
  const f = db.prepare("SELECT MIN(fecha) f FROM ventas WHERE estado <> 'anulada'").get();
  if (!f || !f.f) return 30;
  const dias = diasEntre(String(f.f).slice(0, 10), hoy()) + 1;
  return Math.max(7, Math.min(30, dias));
}

// Ritmo de venta y días de cobertura por producto activo. Devuelve también los que no se han vendido (ritmo 0).
function coberturaProductos(db, { ids } = {}) {
  const ventana = ventanaRitmo(db);
  const desde = sumarDias(hoy(), -(ventana - 1)) + ' 00:00:00';
  const filtroIds = Array.isArray(ids) && ids.length ? `AND p.id IN (${ids.map(() => '?').join(',')})` : '';
  const filas = db.prepare(`SELECT p.id, p.nombre, p.referencia, p.stock_minimo, p.precio_venta, s.stock,
      (SELECT COALESCE(SUM(vi.cantidad - vi.cantidad_devuelta), 0) FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id
        WHERE vi.producto_id = p.id AND v.estado <> 'anulada' AND v.fecha >= ?) AS vendidas
    FROM productos p JOIN v_stock s ON s.producto_id = p.id
    WHERE p.estado IN ('activo','agotado') ${filtroIds}`).all(desde, ...(filtroIds ? ids : []));
  return filas.map((p) => {
    const ritmo = p.vendidas > 0 ? p.vendidas / ventana : 0;
    const dias = ritmo > 0 && p.stock > 0 ? p.stock / ritmo : null;
    return { ...p, ventana, ritmo_dia: Math.round(ritmo * 100) / 100, dias_cobertura: dias === null ? null : Math.round(dias * 10) / 10 };
  });
}

// Estado del inventario para avisos: agotados, en o bajo el mínimo y los que se acabarán pronto al ritmo actual.
function estadoInventario(db, diasCobertura = 7) {
  const cob = coberturaProductos(db);
  const agotados = cob.filter((p) => p.stock <= 0).sort((a, b) => b.vendidas - a.vendidas || a.nombre.localeCompare(b.nombre));
  const minimo = cob.filter((p) => p.stock > 0 && p.stock <= p.stock_minimo).sort((a, b) => (a.dias_cobertura ?? 9999) - (b.dias_cobertura ?? 9999) || a.stock - b.stock);
  const pronto = cob.filter((p) => p.stock > p.stock_minimo && p.dias_cobertura !== null && p.dias_cobertura <= diasCobertura).sort((a, b) => a.dias_cobertura - b.dias_cobertura);
  return { agotados, minimo, pronto, ventana: cob.length ? cob[0].ventana : ventanaRitmo(db), dias_cobertura: diasCobertura };
}

// Texto corto de cobertura: "alcanza para ~3 días" (o null si no hay ritmo de venta).
function textoCobertura(p) {
  if (p.dias_cobertura === null || p.dias_cobertura === undefined) return null;
  const d = p.dias_cobertura;
  if (d < 1) return 'se acabaría hoy al ritmo actual';
  if (d > 90) return 'alcanza para más de 3 meses';
  return `alcanza para unos ${L.num(Math.max(1, Math.round(d)))} ${Math.round(d) === 1 ? 'día' : 'días'}`;
}

function diasCoberturaConfig(db) {
  const a = getConfig(db, 'asistente');
  const n = a && Number(a.dias_cobertura);
  return Number.isFinite(n) && n >= 1 && n <= 60 ? Math.round(n) : 7;
}

// ---------- Lista de avisos según permisos ----------
function avisos(db, usuario) {
  const h = hoy();
  const salida = [];
  const empujar = (a) => salida.push({ items: [], claves: [], ...a });

  if (tiene(usuario, 'inventario.ver') || tiene(usuario, 'ventas.crear')) {
    const inv = estadoInventario(db, diasCoberturaConfig(db));
    if (inv.agotados.length) {
      empujar({
        id: 'inventario_agotados', nivel: 'alta', icono: 'box', modulo: 'inventario',
        titulo: inv.agotados.length === 1 ? `Se agotó: ${inv.agotados[0].nombre}` : `${L.num(inv.agotados.length)} productos agotados`,
        detalle: inv.agotados.length === 1 ? 'No quedan unidades para vender' : lista(inv.agotados.map((p) => p.nombre)),
        href: '#/inventario?filtro=agotados',
        items: inv.agotados.slice(0, 6).map((p) => ({ nombre: p.nombre, detalle: `0 unidades${p.vendidas ? ` · vendiste ${L.num(p.vendidas)} en ${inv.ventana} días` : ''}` })),
        claves: inv.agotados.map((p) => `agotado:${p.id}`),
      });
    }
    if (inv.minimo.length) {
      empujar({
        id: 'inventario_minimo', nivel: 'media', icono: 'alert', modulo: 'inventario',
        titulo: inv.minimo.length === 1 ? `Se está acabando: ${inv.minimo[0].nombre}` : `${L.num(inv.minimo.length)} productos en el mínimo o por debajo`,
        detalle: inv.minimo.length === 1 ? `Quedan ${L.unidades(inv.minimo[0].stock)} (mínimo ${L.num(inv.minimo[0].stock_minimo)})` : lista(inv.minimo.map((p) => `${p.nombre}: ${L.num(p.stock)}`)),
        href: '#/inventario?filtro=stock_bajo',
        items: inv.minimo.slice(0, 6).map((p) => ({ nombre: p.nombre, detalle: [`quedan ${L.num(p.stock)} · mínimo ${L.num(p.stock_minimo)}`, textoCobertura(p)].filter(Boolean).join(' · ') })),
        claves: inv.minimo.map((p) => `minimo:${p.id}`),
      });
    }
    if (inv.pronto.length) {
      empujar({
        id: 'inventario_pronto', nivel: 'media', icono: 'clock', modulo: 'inventario',
        titulo: inv.pronto.length === 1 ? `Pronto se acaba: ${inv.pronto[0].nombre}` : `${L.num(inv.pronto.length)} productos se acabarán en menos de ${inv.dias_cobertura} días`,
        detalle: inv.pronto.length === 1 ? `Quedan ${L.unidades(inv.pronto[0].stock)}; ${textoCobertura(inv.pronto[0])}` : lista(inv.pronto.map((p) => p.nombre)),
        href: '#/inventario',
        items: inv.pronto.slice(0, 6).map((p) => ({ nombre: p.nombre, detalle: `quedan ${L.num(p.stock)} · ${textoCobertura(p)}` })),
        claves: inv.pronto.map((p) => `pronto:${p.id}`),
        nota: `Estimado con el ritmo de ventas de los últimos ${inv.ventana} días.`,
      });
    }
  }

  if (tiene(usuario, 'creditos.ver')) {
    creditos.recalcularTodos(db);
    const al = dashboard.alertas(db);
    const vencidas = al.cuotas_proximas.filter((q) => q.fecha_vencimiento < h);
    const porVencer = al.cuotas_proximas.filter((q) => q.fecha_vencimiento >= h);
    if (vencidas.length) {
      const total = vencidas.reduce((s, q) => s + (Number(q.pendiente) || 0), 0);
      empujar({
        id: 'cuotas_vencidas', nivel: 'alta', icono: 'alert', modulo: 'creditos',
        titulo: vencidas.length === 1 ? '1 cuota vencida' : `${L.num(vencidas.length)} cuotas vencidas`,
        detalle: `${L.cop(total)} · ${lista([...new Set(vencidas.map((q) => q.cliente))])}`,
        href: '#/creditos?estado=vencido',
        items: vencidas.slice(0, 6).map((q) => ({ nombre: q.cliente, detalle: `${L.cop(q.pendiente)} · venció el ${L.diaMes(q.fecha_vencimiento)}${q.telefono ? ` · ${q.telefono}` : ''}` })),
        claves: vencidas.map((q) => `cuota_vencida:${q.credito_id}:${q.fecha_vencimiento}`),
      });
    }
    if (porVencer.length) {
      const total = porVencer.reduce((s, q) => s + (Number(q.pendiente) || 0), 0);
      empujar({
        id: 'cuotas_por_vencer', nivel: 'media', icono: 'calendar', modulo: 'creditos',
        titulo: porVencer.length === 1 ? '1 cuota por vencer' : `${L.num(porVencer.length)} cuotas por vencer`,
        detalle: `${L.cop(total)} en los próximos ${al.dias_alerta} días · desde el ${L.diaMes(porVencer[0].fecha_vencimiento)}`,
        href: '#/creditos?estado=proximo',
        items: porVencer.slice(0, 6).map((q) => ({ nombre: q.cliente, detalle: `${L.cop(q.pendiente)} · vence ${q.fecha_vencimiento === h ? 'hoy' : `el ${L.diaMes(q.fecha_vencimiento)}`}` })),
        claves: porVencer.map((q) => `cuota_proxima:${q.credito_id}:${q.fecha_vencimiento}`),
      });
    }
  }

  if (tiene(usuario, 'compras.ver') || tiene(usuario, 'compras.pagar')) {
    const facturas = db.prepare(`SELECT c.id, c.numero, c.numero_factura, c.fecha_vencimiento, c.saldo_pendiente, p.nombre AS proveedor
      FROM compras c LEFT JOIN proveedores p ON p.id = c.proveedor_id WHERE c.estado = 'confirmada' AND c.saldo_pendiente > 0
      ORDER BY c.fecha_vencimiento IS NULL, c.fecha_vencimiento, c.fecha`).all();
    if (facturas.length) {
      const total = facturas.reduce((s, f) => s + (Number(f.saldo_pendiente) || 0), 0);
      const vencidas = facturas.filter((f) => f.fecha_vencimiento && f.fecha_vencimiento < h);
      empujar({
        id: 'facturas_por_pagar', nivel: vencidas.length ? 'alta' : 'media', icono: 'truck', modulo: 'compras',
        titulo: `${facturas.length === 1 ? '1 factura' : `${L.num(facturas.length)} facturas`} por pagar a proveedores`,
        detalle: `${L.cop(total)}${vencidas.length ? ` · ${vencidas.length === 1 ? '1 vencida' : `${L.num(vencidas.length)} vencidas`}` : ''}`,
        href: '#/compras?con_saldo=1',
        items: facturas.slice(0, 6).map((f) => ({ nombre: f.proveedor || 'Proveedor sin nombre', detalle: `${L.cop(f.saldo_pendiente)}${f.numero_factura ? ` · factura ${f.numero_factura}` : ''}${f.fecha_vencimiento ? ` · ${f.fecha_vencimiento < h ? 'venció' : 'vence'} el ${L.diaMes(f.fecha_vencimiento)}` : ''}` })),
        claves: vencidas.map((f) => `factura_vencida:${f.id}`).concat(facturas.filter((f) => !vencidas.includes(f)).map((f) => `factura:${f.id}`)),
      });
    }
  }

  if (tiene(usuario, 'documentos.ver')) {
    const n = db.prepare("SELECT COUNT(*) n FROM documentos WHERE estado = 'pendiente'").get().n;
    if (n) {
      const ids = db.prepare("SELECT id FROM documentos WHERE estado = 'pendiente' ORDER BY id DESC LIMIT 30").all().map((d) => d.id);
      empujar({ id: 'documentos', nivel: 'info', icono: 'inbox', modulo: 'documentos', titulo: n === 1 ? '1 documento por revisar' : `${L.num(n)} documentos por revisar`, detalle: 'Facturas recibidas que aún no son compras', href: '#/documentos', claves: ids.map((i) => `documento:${i}`) });
    }
  }

  if (tiene(usuario, 'domicilios.ver')) {
    const r = require('../domicilios').resumen(db);
    if (r.atrasados.length) {
      empujar({
        id: 'domicilios_atrasados', nivel: 'alta', icono: 'moto', modulo: 'domicilios',
        titulo: r.atrasados.length === 1 ? '1 domicilio atrasado' : `${L.num(r.atrasados.length)} domicilios atrasados`,
        detalle: lista(r.atrasados.map((d) => `${d.numero} · ${d.cliente_nombre} (${L.num(d.minutos)} min ${d.estado === 'en_camino' ? 'en camino' : 'en bodega'})`)),
        href: '#/domicilios',
        items: r.atrasados.slice(0, 6).map((d) => ({ nombre: `${d.numero} · ${d.cliente_nombre}`, detalle: `${L.num(d.minutos)} min ${d.estado === 'en_camino' ? 'en camino' : 'sin salir de la bodega'}${d.barrio ? ` · ${d.barrio}` : ''}` })),
        claves: r.atrasados.map((d) => `domicilio_atrasado:${d.id}:${d.estado}`),
      });
    }
    const sinSalir = r.por_despachar - r.atrasados.filter((d) => d.estado !== 'en_camino').length;
    if (sinSalir > 0 && tiene(usuario, 'domicilios.despachar')) {
      const ids = db.prepare("SELECT id FROM domicilios WHERE estado IN ('recibido','en_preparacion') ORDER BY id DESC LIMIT 30").all().map((d) => d.id);
      empujar({
        id: 'domicilios_por_despachar', nivel: 'media', icono: 'moto', modulo: 'domicilios',
        titulo: sinSalir === 1 ? '1 domicilio por despachar' : `${L.num(sinSalir)} domicilios por despachar`,
        detalle: 'Pedidos recibidos que aún no salen con un repartidor', href: '#/domicilios',
        claves: ids.map((x) => `domicilio:${x}`),
      });
    }
  }

  if (tiene(usuario, 'caja.operar')) {
    const s = caja.sesionAbierta(db);
    if (!s) empujar({ id: 'caja_cerrada', nivel: 'info', icono: 'cash', modulo: 'caja', titulo: 'La caja no se ha abierto hoy', detalle: 'Ábrela para cuadrar el efectivo al final del día', href: '#/caja', claves: [`caja_cerrada:${h}`] });
    else if (String(s.abierta_en).slice(0, 10) < h) empujar({ id: 'caja_sin_cerrar', nivel: 'media', icono: 'cash', modulo: 'caja', titulo: 'La caja sigue abierta desde un día anterior', detalle: `Se abrió el ${L.diaMes(s.abierta_en)} a las ${L.horaDe(s.abierta_en)}. Ciérrala para cuadrar ese día`, href: '#/caja', claves: [`caja_abierta:${s.id}`] });
  }

  return salida.sort((a, b) => ORDEN[a.nivel] - ORDEN[b.nivel]);
}

function conteo(lista) {
  const c = { alta: 0, media: 0, info: 0, total: lista.length };
  for (const a of lista) c[a.nivel] += 1;
  return c;
}

// Huella del conjunto de avisos: cambia solo cuando aparece o desaparece algo.
function firma(lista) {
  const claves = lista.flatMap((a) => a.claves).sort();
  return createHash('sha256').update(claves.join('|')).digest('hex').slice(0, 16);
}

// ---------- Resumen del día (lo que Tino dice al abrirlo) ----------
function lineasDelDia(db, usuario) {
  const h = hoy();
  const lineas = [];
  // Misma regla que la herramienta consultar_ventas: quien solo ve sus comisiones ve solo sus propias ventas.
  const soloPropias = tiene(usuario, 'comisiones.ver_propias') && !tiene(usuario, 'comisiones.ver') && !tiene(usuario, 'comisiones.administrar');
  if (tiene(usuario, 'ventas.ver') && !soloPropias) {
    const r = dashboard.resumenPeriodo(db, h, h);
    const ayer = dashboard.resumenPeriodo(db, sumarDias(h, -1), sumarDias(h, -1));
    if (r.ventas.cantidad) {
      let comp = '';
      if (ayer.ventas.netas > 0) {
        const p = Math.round(((r.ventas.netas - ayer.ventas.netas) * 1000) / ayer.ventas.netas) / 10;
        comp = p >= 0 ? ` (${L.pct(p)} más que ayer)` : ` (${L.pct(-p)} menos que ayer)`;
      } else comp = ' (ayer no hubo ventas)';
      lineas.push(`Hoy van **${L.plural(r.ventas.cantidad, 'venta', 'ventas')}** por **${L.cop(r.ventas.netas)}**${comp}.`);
      const top = db.prepare(`SELECT p.nombre, SUM(vi.cantidad - vi.cantidad_devuelta) u FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id JOIN productos p ON p.id = vi.producto_id
        WHERE v.estado <> 'anulada' AND v.fecha BETWEEN ? AND ? GROUP BY p.id HAVING u > 0 ORDER BY u DESC, SUM(vi.total) DESC LIMIT 1`).get(h + ' 00:00:00', h + ' 23:59:59');
      if (top) lineas.push(`Lo más vendido hoy: **${top.nombre}** (${L.unidades(top.u)}).`);
    } else {
      lineas.push(`Hoy todavía no hay ventas registradas${ayer.ventas.cantidad ? `; ayer se vendieron ${L.cop(ayer.ventas.netas)} en ${L.plural(ayer.ventas.cantidad, 'venta', 'ventas')}` : ''}.`);
    }
  } else if (tiene(usuario, 'comisiones.ver_propias')) {
    const r = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total),0) t FROM ventas WHERE estado <> 'anulada' AND vendedor_id = ? AND fecha BETWEEN ? AND ?").get(usuario.id, h + ' 00:00:00', h + ' 23:59:59');
    lineas.push(r.n ? `Hoy llevas **${L.plural(r.n, 'venta', 'ventas')}** por **${L.cop(r.t)}**.` : 'Hoy todavía no tienes ventas registradas.');
  }
  if (tiene(usuario, 'caja.ver')) {
    const s = caja.sesionAbierta(db);
    if (s) lineas.push(`La caja está abierta desde ${String(s.abierta_en).slice(0, 10) === h ? 'hoy' : `el ${L.diaMes(s.abierta_en)}`} a las ${L.horaDe(s.abierta_en)}, con base de ${L.cop(s.base_inicial)}.`);
    else lineas.push('La caja está cerrada.');
  }
  return lineas;
}

function textoAvisos(lista, { encabezado = true } = {}) {
  if (!lista.length) return '¡Todo al día! No tienes pendientes importantes en este momento.';
  const c = conteo(lista);
  const partes = [];
  if (encabezado) partes.push(`Tienes **${L.plural(c.total, 'pendiente', 'pendientes')}**${c.alta ? ` (${L.plural(c.alta, 'urgente', 'urgentes')})` : ''}:`);
  for (const a of lista) partes.push(`- **${a.titulo}**: ${a.detalle}`);
  return partes.join('\n');
}

function resumen(db, usuario) {
  const lista = avisos(db, usuario);
  const lineas = lineasDelDia(db, usuario);
  const nombre = String(usuario.nombre || usuario.usuario || '').trim().split(/\s+/)[0];
  const saludo = `${L.saludoHora()}${nombre ? `, ${nombre}` : ''}`;
  const fecha = L.capitalizar(L.fechaLarga(hoy()));
  const texto = [`${saludo}. ${fecha}.`, ...lineas, '', textoAvisos(lista)].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { generado: new Date().toISOString(), saludo, fecha, lineas, avisos: lista, conteo: conteo(lista), firma: firma(lista), texto };
}

module.exports = { avisos, resumen, conteo, firma, textoAvisos, lineasDelDia, estadoInventario, coberturaProductos, textoCobertura, ventanaRitmo, diasCoberturaConfig };
