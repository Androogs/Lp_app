// Gráficas del negocio: tablero analítico del negocio (antes vivía en Inicio). KPIs con comparación, evolución de
// ventas, ingresos frente a ganancias, productos más vendidos, distribución del inventario, métodos de pago, alertas y
// actividad reciente. Todo sale de /api/analitica/panel (datos reales); el filtro de periodo aplica a todos los paneles.
import { api } from '../../lib/api';
import { estado } from '../../lib/estado';
import { $, $$, fmt, icono, esc, badge, ESTADOS_VENTA, TIPOS_PAGO, nombreMetodo, mostrarError } from '../ui.js';
import { lineas, barras, barrasH, anillo, minigrafica, leyenda, reagrupar } from '../charts.js';
import { filtroInicial, guardarFiltro, paramsFiltro, filtroPeriodo, textoPeriodo, kpi, panel, seg, activarSeg, tablaViz, tituloPunto, alertaItem, NOMBRE_GRAN, seriesIngresosGanancia } from '../paneles.js';

const f = filtroInicial('graficas', '30d');
let agrupar = sessionStorage.getItem('graficas.agrupar') || 'dia';
let vistaInv = sessionStorage.getItem('graficas.inventario') || 'categoria';

export async function render(root, { setTopbar }) {
  setTopbar({ titulo: 'Gráficas del negocio', atras: '#/inicio', acciones: [{ icono: 'refresh', titulo: 'Actualizar los datos', alHacerClic: () => cargar(root) }] });
  root.innerHTML = `<p class="intro-modulo">Cómo va el negocio en el periodo que elijas. Cada tarjeta compara con el periodo anterior y abre el módulo relacionado; bajo cada gráfica puedes ver los datos como tabla.</p>
    <div id="in-filtros"></div><div id="in-cuerpo"><div class="cargando">Cargando panel…</div></div>`;
  root._filtro = filtroPeriodo($('#in-filtros', root), f, (nf) => { guardarFiltro('graficas', nf); cargar(root); });
  await cargar(root);
}

// Nombres legibles de las acciones de auditoría (server/services/*.js → auditoria.registrar).
const ACCIONES = {
  crear_venta: 'registró una venta', anular_venta: 'anuló una venta', devolucion: 'registró una devolución', corregir_tasa_venta: 'corrigió la tasa de una venta',
  crear_compra: 'registró una compra', pago_proveedor: 'pagó a un proveedor', anular_compra: 'anuló una compra', corregir_tasa_compra: 'corrigió la tasa de una compra',
  crear_credito: 'otorgó un crédito', abono: 'registró un abono', modificar_credito: 'modificó un crédito', anular_credito: 'anuló un crédito', reducir_saldo_credito: 'redujo el saldo de un crédito',
  crear_producto: 'creó un producto', editar_producto: 'editó un producto', ajuste_inventario: 'ajustó el inventario', crear_categoria: 'creó una categoría', editar_categoria: 'editó una categoría',
  abrir_caja: 'abrió la caja', cerrar_caja: 'cerró la caja', movimiento_caja: 'registró un movimiento de caja', crear_gasto: 'registró un gasto', anular_gasto: 'anuló un gasto',
  crear_cliente: 'creó un cliente', editar_cliente: 'editó un cliente', desactivar_cliente: 'desactivó un cliente', crear_proveedor: 'creó un proveedor', editar_proveedor: 'editó un proveedor', desactivar_proveedor: 'desactivó un proveedor',
  subir_documento: 'subió un documento', ocr_documento: 'procesó una factura con OCR', descartar_documento: 'descartó un documento',
  login: 'inició sesión', login_fallido: 'intento de inicio de sesión fallido', cambiar_clave: 'cambió su contraseña', restablecer_clave: 'restableció su contraseña', restablecer_clave_admin: 'restableció una contraseña', solicitar_recuperacion: 'solicitó recuperar la contraseña',
  crear_usuario: 'creó un usuario', editar_usuario: 'editó un usuario', editar_configuracion: 'editó la configuración', regenerar_api_token: 'regeneró el token de la API', crear_respaldo: 'creó un respaldo', descargar_respaldo: 'descargó un respaldo',
};
// Panel del vendedor: sus tareas, sus ventas y sus comisiones estimadas. Nada de cifras globales del negocio.
function panelVendedor(cuerpo, d, periodoNombre) {
  const com = d.comisiones; const yo = com.responsables[0] || { ventas: 0, ingreso_neto: 0, ganancia: 0, comision: 0, comision_pct: 0, salario_base: 0, salario_periodo: 0, total_remuneracion: 0, pendientes_cobro: 0, salario_estimado: true, ganancia_comisionable: 0 };
  const dm = d.domicilios;
  cuerpo.innerHTML = `
    <div class="acciones-rapidas mb">
      ${estado.tiene('ventas.crear') ? `<a class="accion-rapida negra" href="#/vender">${icono('cart')}Realizar venta</a>` : ''}
      ${estado.tiene('domicilios.crear') ? `<a class="accion-rapida" href="#/domicilios/nuevo">${icono('moto')}Nuevo domicilio</a>` : ''}
      <a class="accion-rapida" href="#/comisiones/ventas">${icono('list')}Mis ventas</a>
      <a class="accion-rapida" href="#/comisiones">${icono('dollar')}Mis comisiones</a>
    </div>
    <div class="kpis">
      ${kpi({ icono: 'cart', titulo: 'Mis ventas', valor: fmt.num(yo.ventas), descripcion: `${fmt.cop(yo.ingreso_neto)} · ${periodoNombre}`, clase: 'acento', href: '#/comisiones/ventas' })}
      ${kpi({ icono: 'trend_up', titulo: 'Ganancia que generé', valor: fmt.cop(yo.ganancia), descripcion: `${yo.pendientes_cobro} pendiente(s) de cobro` })}
      ${kpi({ icono: 'dollar', titulo: 'Mi comisión estimada', valor: fmt.cop(yo.comision), descripcion: `${yo.comision_pct} % de la ganancia comisionable`, href: '#/comisiones' })}
      ${kpi({ icono: 'calendar', titulo: 'Salario base', valor: fmt.cop(yo.salario_base), descripcion: 'al mes' })}
      ${dm ? kpi({ icono: 'moto', titulo: 'Domicilios por despachar', valor: fmt.num(dm.por_despachar), descripcion: `${dm.en_camino} en camino · ${dm.hoy.entregados} entregados hoy`, href: '#/domicilios', alerta: dm.atrasados.length > 0 }) : ''}
    </div>
    <div class="grid-viz mt-l">
      <section class="panel span-3"><div class="panel-cab"><div><h2>Domicilios de hoy</h2><div class="panel-sub">Pedidos de la flota propia</div></div></div>
        ${dm ? `<div class="alertas-lista">${[
          alertaItem({ clase: dm.por_despachar ? 'aviso' : '', texto: 'Por despachar', n: fmt.num(dm.por_despachar), href: '#/domicilios' }),
          alertaItem({ clase: '', texto: 'En camino', n: fmt.num(dm.en_camino), href: '#/domicilios' }),
          alertaItem({ clase: dm.atrasados.length ? 'peligro' : 'ok', texto: 'Atrasados', n: fmt.num(dm.atrasados.length), href: '#/domicilios' }),
          alertaItem({ clase: 'ok', texto: `Entregados · ${fmt.cop(dm.hoy.total)}`, n: fmt.num(dm.hoy.entregados), href: '#/domicilios?vista=historial' }),
        ].join('')}</div>` : '<p class="muted small">Sin acceso a domicilios.</p>'}
        ${estado.tiene('domicilios.crear') ? `<a class="btn chico suave mt" href="#/domicilios/nuevo">${icono('plus', 16)} Tomar un pedido</a>` : ''}
      </section>
      <section class="panel span-3"><div class="panel-cab"><div><h2>Mis últimas ventas</h2><div class="panel-sub">${periodoNombre}</div></div><div class="panel-acciones"><a class="btn chico suave" href="#/comisiones/ventas">Ver todas</a></div></div>
        ${com.ventas.length ? `<div class="lista">${com.ventas.slice(0, 8).map((v) => `<a class="item" href="#/ventas/${v.id}"><div class="cuerpo"><div class="titulo">${esc(v.numero)} · ${esc(v.cliente || 'Consumidor final')}</div><div class="sub">${esc(fmt.fechaHora(v.fecha))} · ${v.estado_pago === 'cobrada' ? 'cobrada' : 'pendiente de cobro'}</div></div><div class="fin"><div class="valor">${esc(fmt.cop(v.ingreso_neto))}</div><div class="xs muted">comisión ${esc(fmt.cop(v.comision))}</div></div></a>`).join('')}</div>` : '<p class="muted small">Sin ventas en el periodo.</p>'}
      </section>
    </div>
    ${com.avisos.length ? `<div class="alerta neutra small mt">${com.avisos.map(esc).join(' · ')}</div>` : ''}`;
}

const ENTIDADES = { venta: 'venta', compra: 'compra', credito: 'crédito', producto: 'producto', cliente: 'cliente', proveedor: 'proveedor', gasto: 'gasto', caja: 'caja', usuario: 'usuario', documento: 'documento', categoria: 'categoría', configuracion: 'configuración', respaldo: 'respaldo' };
const nombreAccion = (a) => ACCIONES[a] || String(a || '').replace(/_/g, ' ');

async function cargar(root) {
  const cuerpo = $('#in-cuerpo', root);
  if (!cuerpo) return;
  cuerpo.style.opacity = '0.55';
  let d;
  try { d = await api.get('/api/analitica/panel' + api.qs(paramsFiltro(f))); } catch (e) { cuerpo.style.opacity = ''; return mostrarError(e); }
  cuerpo.style.opacity = '';
  if (root._filtro) root._filtro.setTexto(textoPeriodo(f, d.periodo));
  const k = d.kpis; const veCostos = !!k.ganancia; const veCaja = estado.tiene('caja.ver');
  const g = d.granularidad; const puntos = d.serie.puntos;
  const periodoNombre = textoPeriodo(f, d.periodo);
  const com = d.comisiones || null; const dm = d.domicilios || null;
  // Vendedor: panel sencillo centrado en sus tareas (sin cifras globales del negocio).
  if (com && com.alcance === 'propio') return panelVendedor(cuerpo, d, periodoNombre);

  // ---- Alertas ----
  const al = d.alertas; const alertas = [];
  if (al.agotados.length) alertas.push({ clase: 'peligro', texto: 'Productos agotados', n: al.agotados.length, href: '#/inventario?filtro=agotados' });
  const pocas = al.stock_bajo.filter((p) => p.stock > 0);
  if (pocas.length) alertas.push({ clase: 'aviso', texto: 'Productos con pocas unidades', n: pocas.length, href: '#/inventario?filtro=stock_bajo' });
  if (al.cuotas_vencidas.length) alertas.push({ clase: 'peligro', texto: `Cuotas vencidas por cobrar · ${fmt.cop(al.cuotas_vencidas.reduce((s, q) => s + q.pendiente, 0))}`, n: al.cuotas_vencidas.length, href: '#/creditos?estado=vencido' });
  if (al.cuotas_por_vencer.length) alertas.push({ clase: 'aviso', texto: `Cuotas que vencen en los próximos ${al.dias_alerta} días`, n: al.cuotas_por_vencer.length, href: '#/creditos?estado=proximo' });
  if (al.compras_por_pagar.length) alertas.push({ clase: 'aviso', texto: `Facturas de proveedor por pagar · ${fmt.cop(al.compras_por_pagar.reduce((s, c) => s + c.saldo_pendiente, 0))}`, n: al.compras_por_pagar.length, href: '#/compras?con_saldo=1' });
  if (dm && dm.atrasados.length) alertas.push({ clase: 'peligro', texto: 'Domicilios atrasados', n: dm.atrasados.length, href: '#/domicilios' });
  if (dm && dm.por_despachar) alertas.push({ clase: 'aviso', texto: 'Domicilios por despachar', n: dm.por_despachar, href: '#/domicilios' });
  if (d.documentos_pendientes) alertas.push({ clase: 'info', texto: 'Documentos pendientes de revisar', n: d.documentos_pendientes, href: '#/documentos' });
  if (!estado.caja && veCaja) alertas.push({ clase: '', texto: 'La caja está cerrada. Ábrela para registrar el efectivo del día.', href: '#/caja' });

  const puedeAgrupar = g === 'dia' || g === 'semana';
  const opcionesAgrupar = g === 'dia' ? [['dia', 'Día'], ['semana', 'Semana'], ['mes', 'Mes']] : [['semana', 'Semana'], ['mes', 'Mes']];
  // Sin elección previa del usuario, más de dos semanas de puntos diarios se leen mejor agrupados por semana.
  if (!sessionStorage.getItem('graficas.agrupar') && g === 'dia') agrupar = puntos.length > 14 ? 'semana' : 'dia';
  if (puedeAgrupar && !opcionesAgrupar.some(([v]) => v === agrupar)) agrupar = opcionesAgrupar[0][0];
  const mostrarVentasPeriodo = !['hoy', 'mes'].includes(f.periodo);

  cuerpo.innerHTML = `
    <div class="acciones-rapidas mb">
      ${estado.tiene('ventas.crear') ? `<a class="accion-rapida negra" href="#/vender">${icono('cart')}Realizar venta</a>` : ''}
      ${estado.tiene('domicilios.crear') ? `<a class="accion-rapida" href="#/domicilios/nuevo">${icono('moto')}Nuevo domicilio</a>` : ''}
      ${estado.tiene('compras.crear') ? `<a class="accion-rapida" href="#/compras/nueva">${icono('truck')}Registrar compra</a>` : ''}
      ${estado.tiene('inventario.editar') ? `<a class="accion-rapida" href="#/inventario/nuevo">${icono('plus')}Agregar producto</a>` : ''}
      ${estado.tiene('creditos.abonar') ? `<a class="accion-rapida" href="#/creditos?abonar=1">${icono('card')}Registrar abono</a>` : ''}
    </div>
    <div class="kpis">
      ${kpi({ icono: 'cart', titulo: 'Ventas de hoy', valor: fmt.cop(k.ventas_hoy.total), descripcion: `${k.ventas_hoy.cantidad} venta(s) · ayer ${fmt.cop(k.ventas_hoy.anterior)}`, variacion: k.ventas_hoy.variacion, vs: 'ayer', href: '#/ventas?periodo=hoy', clase: 'acento', spark: minigrafica(d.serie_hoy.puntos.map((p) => p.netas)) })}
      ${kpi({ icono: 'calendar', titulo: 'Ventas del mes', valor: fmt.cop(k.ventas_mes.total), descripcion: `${k.ventas_mes.cantidad} venta(s) al ${fmt.fecha(k.ventas_mes.hasta)}`, variacion: k.ventas_mes.variacion, vs: 'mismo tramo del mes anterior', href: '#/ventas?periodo=mes', spark: minigrafica(d.serie_mes.puntos.map((p) => p.netas)) })}
      ${mostrarVentasPeriodo ? kpi({ icono: 'chart', titulo: 'Ventas del periodo', valor: fmt.cop(k.ventas_periodo.total), descripcion: `${k.ventas_periodo.cantidad} venta(s) · ${periodoNombre}`, variacion: k.ventas_periodo.variacion, href: `#/ventas?periodo=${encodeURIComponent(f.periodo)}` }) : ''}
      ${veCostos ? kpi({ icono: 'trend_up', titulo: 'Ganancias estimadas', valor: fmt.cop(k.ganancia.utilidad), descripcion: `bruta ${fmt.cop(k.ganancia.ganancia_bruta)} − gastos ${fmt.cop(k.ganancia.gastos)} · margen ${fmt.pct(k.ganancia.margen_pct)}`, variacion: k.ganancia.variacion, href: estado.tiene('contabilidad.ver') ? '#/contabilidad' : null }) : kpi({ icono: 'cash', titulo: 'Dinero recibido', valor: fmt.cop(k.ventas_periodo.recibido), descripcion: `pagos de ventas y abonos · ${periodoNombre}` })}
      ${kpi({ icono: 'bottle', titulo: 'Licores y complementos', valor: `${fmt.num(k.inventario.unidades)} und`, descripcion: `${fmt.num(k.inventario.licores)} de licores · ${fmt.num(k.inventario.complementos)} de complementos · ${k.inventario.productos} productos`, href: '#/inventario' })}
      ${dm ? kpi({ icono: 'moto', titulo: 'Domicilios de hoy', valor: fmt.num(dm.hoy.entregados), descripcion: `${fmt.cop(dm.hoy.total)} entregados · ${dm.por_despachar} por despachar · ${dm.en_camino} en camino`, href: '#/domicilios', alerta: dm.atrasados.length > 0 }) : ''}
      ${kpi({ icono: 'alert', titulo: 'Inventario bajo', valor: fmt.num(k.stock_bajo.total), descripcion: `${k.stock_bajo.pocas} con pocas unidades · ${k.stock_bajo.agotados} agotado(s)`, href: '#/inventario?filtro=stock_bajo', alerta: k.stock_bajo.total > 0 })}
      ${kpi({ icono: 'card', titulo: 'Cuentas por cobrar', valor: fmt.cop(k.por_cobrar.pendiente), descripcion: `${k.por_cobrar.vigentes} crédito(s) · ${k.por_cobrar.vencidos} vencido(s) por ${fmt.cop(k.por_cobrar.saldo_vencido)}`, href: '#/creditos', alerta: k.por_cobrar.vencidos > 0 })}
      ${kpi({ icono: 'users', titulo: 'Clientes registrados', valor: fmt.num(k.clientes.total), descripcion: `${k.clientes.nuevos} nuevo(s) en el periodo`, variacion: k.clientes.variacion, href: '#/clientes' })}
    </div>
    ${com && com.negocio ? `<div class="row between mt-l mb"><h2 style="margin:0">Rentabilidad y comisiones</h2><a class="btn chico suave" href="#/comisiones">Ver detalle</a></div>
    <div class="kpis">
      ${kpi({ icono: 'chart', titulo: 'Ganancia operativa', valor: fmt.cop(com.negocio.ganancia_total), descripcion: 'todas las ventas · antes de salarios y comisiones', href: '#/comisiones' })}
      ${kpi({ icono: 'trend_up', titulo: 'Ganancia del vendedor', valor: fmt.cop(com.vendedor.ganancia), descripcion: `${com.vendedor.ventas} venta(s)`, href: '#/comisiones' })}
      ${kpi({ icono: 'dollar', titulo: 'Comisión acumulada', valor: fmt.cop(com.vendedor.comision), descripcion: `comisionable ${fmt.cop(com.vendedor.ganancia_comisionable)}`, href: '#/comisiones' })}
      ${kpi({ icono: 'calendar', titulo: 'Salario base por trabajador', valor: fmt.cop(com.salario_general), descripcion: com.salarios_en_resultado ? `al mes · salarios del periodo ${fmt.cop(com.vendedor.salario_periodo)}` : 'al mes (no se reparte por días)', href: '#/comisiones' })}
      ${kpi({ icono: 'user', titulo: 'Ganancia del empleador', valor: fmt.cop(com.empleador.ganancia), descripcion: `${com.empleador.ventas} venta(s) sin comisión`, href: '#/comisiones' })}
      ${kpi({ icono: 'check', titulo: 'Resultado estimado', valor: fmt.cop(com.negocio.resultado), descripcion: com.salarios_en_resultado ? `− salarios ${fmt.cop(com.negocio.salarios)} − comisiones ${fmt.cop(com.negocio.comisiones)} − gastos ${fmt.cop(com.negocio.gastos_generales)}` : `− comisiones ${fmt.cop(com.negocio.comisiones)} − gastos ${fmt.cop(com.negocio.gastos_generales)} · sin salarios (periodo menor a un mes)`, alerta: com.negocio.resultado < 0, href: '#/comisiones' })}
    </div>${com.sin_asignar ? `<div class="alerta aviso small mt">${com.sin_asignar.ventas} venta(s) sin responsable asignado quedan fuera de las comisiones. <a href="#/comisiones/ventas">Asignar</a></div>` : ''}` : ''}
    <div class="grid-viz mt-l">
      ${panel({ id: 'g-ventas', titulo: 'Evolución de ventas', sub: `Ventas netas por ${NOMBRE_GRAN[g]} · ${periodoNombre}`, clase: 'span-4', pie: tablaViz([{ titulo: 'Periodo', clave: 'etiqueta' }, { titulo: 'Ventas', clave: 'n', num: true }, { titulo: 'Facturado', clave: 'ventas', dinero: true }, { titulo: 'Devoluciones', clave: 'devoluciones', dinero: true }, { titulo: 'Netas', clave: 'netas', dinero: true }], puntos) })}
      ${panel({ id: 'g-metodos', titulo: 'Métodos de pago', sub: 'Dinero recibido: pagos de ventas y abonos', clase: 'span-2', pie: d.metodos_pago.credito_otorgado ? `A crédito (pendiente de cobro): <b>${fmt.cop(d.metodos_pago.credito_otorgado)}</b> en ${d.metodos_pago.creditos} venta(s)` : 'Sin ventas a crédito en el periodo' })}
      ${panel({ id: 'g-ingresos', titulo: veCostos ? 'Ingresos frente a ganancias' : 'Ventas frente a dinero recibido', sub: veCostos ? 'Ventas netas, costo de lo vendido (por lote) y ganancia bruta' : 'Lo facturado no es lo mismo que lo cobrado', acciones: puedeAgrupar ? seg(opcionesAgrupar, agrupar, 'agrupar') : '', clase: 'span-3', pie: '<span id="g-ingresos-tabla"></span>' })}
      ${panel({ id: 'g-top', titulo: 'Productos más vendidos', sub: 'Unidades vendidas en el periodo (netas de devoluciones)', clase: 'span-3' })}
      ${panel({ id: 'g-inv', titulo: 'Distribución del inventario', sub: 'Unidades disponibles por grupo', acciones: seg([['categoria', 'Categoría'], ['marca', 'Marca'], ['estado', 'Estado']], vistaInv, 'inv'), clase: 'span-3', pie: '<span id="g-inv-pie"></span>' })}
      <section class="panel span-3"><div class="panel-cab"><div><h2>Alertas</h2><div class="panel-sub">Lo que requiere atención ahora</div></div></div>
        ${alertas.length ? `<div class="alertas-lista">${alertas.map(alertaItem).join('')}</div>` : '<div class="alerta-item ok"><span class="pt"></span><span class="txt">Sin alertas: inventario, cartera y proveedores al día.</span></div>'}
        ${d.actividad.length ? `<div class="mt"><div class="et-campo mb">Actividad reciente</div><div class="actividad">${d.actividad.map((a) => `<div><time>${esc(fmt.fechaHora(a.fecha))}</time><span class="grow truncate"><b>${esc(a.usuario_nombre || 'Sistema')}</b> <span class="q">${esc(nombreAccion(a.accion))}${a.entidad_id && !/^(login|cambiar_clave|restablecer|solicitar)/.test(a.accion) ? ' · ' + esc(ENTIDADES[a.entidad] || a.entidad) + ' ' + esc(a.entidad_id) : ''}</span></span></div>`).join('')}</div>${estado.tiene('auditoria.ver') ? '<a class="small" href="#/configuracion/auditoria">Ver auditoría completa</a>' : ''}</div>` : ''}
      </section>
      ${com && com.negocio ? panel({ id: 'g-resp', titulo: 'Vendedor frente a empleador', sub: 'Ingreso neto, ganancia operativa y comisión por responsable en el periodo', clase: 'span-4' }) : ''}
      ${dm ? `<section class="panel span-2"><div class="panel-cab"><div><h2>Flota de domicilios</h2><div class="panel-sub">Repartidores activos hoy · ${dm.mes.entregados} entregas en el mes${dm.mes.minutos_promedio ? `, ${dm.mes.minutos_promedio} min en promedio` : ''}</div></div></div>${dm.repartidores.length ? `<div class="alertas-lista">${dm.repartidores.map((x) => alertaItem({ clase: x.en_camino ? 'aviso' : 'ok', texto: `${x.nombre}${x.vehiculo ? ' · ' + x.vehiculo : ''}${x.en_camino ? ` · ${x.en_camino} en ruta` : ''}`, n: `${x.entregados_hoy} hoy`, href: '#/domicilios' })).join('')}</div>` : '<p class="muted small">Sin repartidores registrados.</p>'}</section>` : ''}
      <section class="panel span-4"><div class="panel-cab"><div><h2>Últimas ventas</h2><div class="panel-sub">Las 8 más recientes</div></div><div class="panel-acciones"><a class="btn chico suave" href="#/ventas">Ver todas</a></div></div>
        ${d.ultimas_ventas.length ? `<div class="lista">${d.ultimas_ventas.map((v) => `<a class="item" href="#/ventas/${v.id}"><div class="cuerpo"><div class="titulo">${esc(v.numero)} · ${esc(v.cliente || 'Consumidor final')}</div><div class="sub">${esc(fmt.fechaHora(v.fecha))} · ${esc(TIPOS_PAGO[v.tipo_pago] || v.tipo_pago)}</div></div><div class="fin"><div class="valor">${esc(fmt.cop(v.total))}</div>${v.estado !== 'confirmada' ? String(badge(ESTADOS_VENTA, v.estado)) : ''}</div></a>`).join('')}</div>` : '<p class="muted small">Aún no hay ventas.</p>'}
      </section>
      <section class="panel span-2" id="g-trm"><div class="panel-cab"><div><h2>Dólar hoy</h2><div class="panel-sub">TRM oficial (Superfinanciera)</div></div></div><div class="muted small">Consultando…</div></section>
    </div>`;

  // ---- Gráficas ----
  lineas($('#g-ventas', cuerpo), { etiquetas: puntos.map((p) => p.etiqueta), series: [{ nombre: 'Ventas netas', valores: puntos.map((p) => p.netas) }], tituloTip: (i) => tituloPunto(puntos[i], g), aria: 'Evolución de ventas' });
  barrasH($('#g-metodos', cuerpo), { items: d.metodos_pago.items.map((m) => ({ etiqueta: nombreMetodo(m.metodo), valor: m.total, nombreValor: 'Recibido', sub: `${m.pct.toLocaleString('es-CO')} % del total · ${m.pagos_venta} pago(s) de venta, ${m.abonos} abono(s)` })), formato: fmt.cop, vacio: 'Sin pagos en el periodo' });
  const pintarIngresos = () => {
    const pts = puedeAgrupar ? reagrupar(puntos, agrupar) : puntos;
    const gr = puedeAgrupar ? agrupar : g;
    const series = seriesIngresosGanancia(pts, veCostos);
    barras($('#g-ingresos', cuerpo), { etiquetas: pts.map((p) => p.etiqueta), series, tituloTip: (i) => tituloPunto(pts[i], gr), aria: 'Ingresos frente a ganancias' });
    const leg = leyenda(series);
    const cols = veCostos ? [{ titulo: 'Periodo', clave: 'etiqueta' }, { titulo: 'Ingresos', clave: 'netas', dinero: true }, { titulo: 'Costo', clave: 'costo', dinero: true }, { titulo: 'Ganancia', clave: 'ganancia_bruta', dinero: true }] : [{ titulo: 'Periodo', clave: 'etiqueta' }, { titulo: 'Ventas netas', clave: 'netas', dinero: true }, { titulo: 'Recibido', clave: 'recibido', dinero: true }];
    $('#g-ingresos-tabla', cuerpo).innerHTML = leg + tablaViz(cols, pts);
  };
  pintarIngresos();
  activarSeg(cuerpo, 'agrupar', (v) => { agrupar = v; sessionStorage.setItem('graficas.agrupar', v); pintarIngresos(); });
  barrasH($('#g-top', cuerpo), { items: d.mas_vendidos.map((p) => ({ etiqueta: p.nombre, valor: p.unidades, nombreValor: 'Unidades', sub: `${fmt.cop(p.total)} vendidos${p.ganancia !== undefined ? ' · ganancia ' + fmt.cop(p.ganancia) : ''}${p.categoria ? ' · ' + p.categoria : ''}`, href: `#/inventario/${p.id}` })), formato: (v) => `${fmt.num(v)} und`, vacio: 'Sin ventas en el periodo' });
  const pintarInv = () => {
    const lista = d.inventario_distribucion[vistaInv] || [];
    const porProductos = vistaInv === 'estado';
    anillo($('#g-inv', cuerpo), { items: lista.map((x) => ({ etiqueta: x.etiqueta, valor: porProductos ? x.productos : x.unidades })), formato: fmt.num, sufijo: porProductos ? ' prod.' : ' und', centro: { valor: fmt.num(lista.reduce((s, x) => s + (porProductos ? x.productos : x.unidades), 0)), etiqueta: porProductos ? 'productos' : 'unidades' }, vacio: 'Sin unidades en inventario' });
    $('#g-inv-pie', cuerpo).innerHTML = porProductos ? 'Conteo de productos según su nivel de stock.' : tablaViz([{ titulo: vistaInv === 'marca' ? 'Marca' : 'Categoría', clave: 'etiqueta' }, { titulo: 'Unidades', clave: 'unidades', num: true }, { titulo: 'Productos', clave: 'productos', num: true }, { titulo: 'Valor venta', clave: 'valor_venta', dinero: true }], lista);
  };
  pintarInv();
  activarSeg(cuerpo, 'inv', (v) => { vistaInv = v; sessionStorage.setItem('graficas.inventario', v); pintarInv(); });
  if (com && com.negocio && $('#g-resp', cuerpo)) {
    const resp = com.responsables.filter((r) => r.ventas > 0);
    barras($('#g-resp', cuerpo), { etiquetas: resp.map((r) => r.nombre.split(' ')[0]), series: [{ nombre: 'Ingreso neto', valores: resp.map((r) => r.ingreso_neto), color: 'var(--viz-3)' }, { nombre: 'Ganancia operativa', valores: resp.map((r) => r.ganancia), color: 'var(--viz-1)' }, { nombre: 'Comisión', valores: resp.map((r) => r.comision), color: 'var(--viz-2)' }], tituloTip: (i) => `${resp[i].nombre} · ${resp[i].tipo === 'empleador' ? 'empleador' : 'vendedor'}` });
    const pie = document.createElement('div'); pie.className = 'panel-pie'; pie.innerHTML = leyenda([{ nombre: 'Ingreso neto', color: 'var(--viz-3)' }, { nombre: 'Ganancia operativa', color: 'var(--viz-1)' }, { nombre: 'Comisión', color: 'var(--viz-2)' }]);
    $('#g-resp', cuerpo).parentElement.appendChild(pie);
  }

  // ---- TRM (no bloquea el panel) ----
  api.get('/api/trm/actual').then((t) => {
    const el = $('#g-trm', cuerpo); if (!el) return;
    const v = t.trm && t.trm.variacion;
    el.innerHTML = `<div class="panel-cab"><div><h2>Dólar hoy</h2><div class="panel-sub">TRM oficial${t.trm && !t.trm.vigente_hoy ? ' (última vigente)' : ''}</div></div></div>
      <div class="hero-num">${t.trm ? esc(fmt.tasa(t.trm.valor)) : 'sin dato'}</div>
      ${v ? `<div class="${v.pesos > 0 ? 'pos' : v.pesos < 0 ? 'neg' : 'muted'} small">${v.pesos > 0 ? '▲' : v.pesos < 0 ? '▼' : '•'} ${Math.abs(v.pesos)} (${v.pct} %) frente a la TRM anterior</div>` : ''}
      <div class="muted xs">${t.trm ? `vigente ${esc(fmt.fecha(t.trm.fecha))}` : ''}${t.mercado ? ` · mercado ${esc(fmt.tasa(t.mercado.valor))}` : ''}${t.trm && t.trm.desactualizada ? ' · dato no actualizado' : ''}</div>
      ${estado.tiene('contabilidad.ver') ? '<a class="btn chico suave mt" href="#/contabilidad/trm">Ver historial</a>' : ''}`;
  }).catch(() => { const el = $('#g-trm', cuerpo); if (el) el.querySelector('.muted').textContent = 'Sin dato disponible.'; });
}
