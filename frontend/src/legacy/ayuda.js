// Ayuda de la aplicación: guía de primer uso (una vez por usuario, se puede volver a abrir) y ayuda contextual de cada
// módulo (botón "?" en la barra superior). Los textos describen solo funciones que existen; las acciones con `permiso`
// se ocultan a quien no lo tiene. El estado "guía vista" se guarda por usuario en localStorage (sin tocar la base).
import { estado } from '../lib/estado';
import { $, $$, esc, icono, modal } from './ui.js';
import { MODULOS, moduloDe, moduloVisible } from '../lib/modulos';

// ---------- Ayuda contextual por módulo ----------
// proposito: para qué sirve. acciones: qué puede hacer (con permiso opcional y enlace). consejos: cómo trabajar mejor.
// problemas: [problema, cómo resolverlo].
export const AYUDA = {
  graficas: {
    proposito: 'Muestra cómo va el negocio: ventas, ganancias, inventario, cartera y clientes, con gráficas y comparación frente al periodo anterior.',
    acciones: [
      { texto: 'Cambiar el periodo con las pastillas Hoy, 7 días, 30 días, Este mes, Este año o Rango (fechas a tu gusto).' },
      { texto: 'Tocar una tarjeta de indicador para abrir el módulo relacionado (ventas, inventario, créditos…).' },
      { texto: 'Abrir "Ver como tabla" bajo cada gráfica para leer los valores exactos.' },
      { texto: 'Usar el botón de actualizar (arriba a la derecha) para recargar los datos.' },
    ],
    consejos: [
      'La flecha verde o roja de cada tarjeta compara con el periodo anterior; "sin datos previos" significa que no hay con qué comparar todavía.',
      'Las ganancias y los costos solo se muestran a quien tiene permiso de inventario. Los vendedores ven su propio resumen de ventas y comisiones.',
      'Las alertas (productos agotados, cuotas vencidas, facturas por pagar) llevan directo a lo que hay que atender.',
    ],
    problemas: [['Las cifras no cuadran con lo que esperaba', 'Revisa el periodo seleccionado y la fecha que aparece a la derecha de los filtros.'], ['No veo ganancias ni costos', 'Tu usuario no tiene permiso de inventario; pídelo al administrador si lo necesitas.']],
  },
  vender: {
    proposito: 'Punto de venta: toca las botellas de la vitrina (lo más vendido primero), busca o escanea el código de barras, arma el carrito y cobra con uno o varios métodos de pago. La tarifa al por mayor se aplica sola.',
    acciones: [
      { texto: 'Tocar una botella de la vitrina (filtra por categoría con las pastillas), buscar por nombre o escanear el código de barras; cada toque suma una unidad.', permiso: 'ventas.crear' },
      { texto: 'Precio mayorista: desde las unidades configuradas (10 por defecto) de una misma referencia la línea pasa sola al precio al por mayor; a un cliente mayorista se le aplica en todo el carrito al elegirlo en Cobrar.', permiso: 'ventas.crear' },
      { texto: 'Quitar un producto del carrito con el botón "Quitar" de su línea, o vaciar todo el carrito.', permiso: 'ventas.crear' },
      { texto: 'Cobrar: elegir contado, crédito o pago parcial, y uno o varios métodos (efectivo, transferencia, Nequi…).', permiso: 'ventas.crear' },
      { texto: 'Origen del cliente / campaña: al cobrar, indicar "¿Cómo llegó el cliente?" (WhatsApp, Instagram, en el local…) y la campaña publicitaria. Así la venta queda atribuida a esa publicidad en Marketing. Si el cliente ya tiene origen registrado, se precarga; el detalle de la venta muestra la atribución (Confirmada, Estimada o Sin atribución).', permiso: 'marketing.leads' },
      { texto: 'Aplicar descuentos o cambiar el precio (solo con permiso).', permiso: 'ventas.descuento' },
      { texto: 'Ver el historial de ventas, abrir una venta y descargar o enviar el comprobante por WhatsApp.', href: '#/ventas' },
      { texto: 'Registrar devoluciones o anular una venta indicando el motivo; el historial nunca se borra.', permiso: 'ventas.anular' },
    ],
    consejos: [
      'Abre la caja antes de vender en efectivo: así el cierre del día cuadra. Arriba de Vender y del historial ves si la caja está abierta, desde cuándo, el efectivo esperado y la fecha y hora actuales; desde ahí la abres o la cierras.',
      'Si el producto no aparece, revisa que tenga unidades en Inventario o créalo desde el mismo buscador.',
      'Los pedidos para entregar en casa se toman en Domicilios: la venta se crea sola cuando el repartidor entrega.',
      'El carrito se guarda solo: si cierras la pantalla por accidente, lo encontrarás como lo dejaste.',
    ],
    problemas: [['"Sin stock" al agregar un producto', 'Registra primero la compra que ingresa las unidades, o ajusta el stock desde Inventario con el motivo.'], ['No me deja aplicar un descuento', 'Tu usuario no tiene ese permiso o el descuento supera el máximo configurado; pídelo al administrador.']],
  },
  inventario: {
    proposito: 'Consulta las existencias de cada licor, su costo por lote, el historial de movimientos (kardex) y sus precios al detal y al por mayor. Aquí se crean y editan los productos.',
    acciones: [
      { texto: 'Buscar un producto y abrirlo para ver lotes, finanzas, kardex, precios y proveedores.' },
      { texto: 'Filtrar por agotados o con pocas unidades para saber qué reponer.', href: '#/inventario?filtro=stock_bajo' },
      { texto: 'Agregar un producto nuevo: nombre y precio al detal son obligatorios; agrega el precio al por mayor, la presentación (750 ml, 1000 ml…) y el tipo (12 años, reposado…).', permiso: 'inventario.editar', href: '#/inventario/nuevo' },
      { texto: 'Ajustar el stock (entrada, salida, rotura o pérdida) indicando siempre el motivo.', permiso: 'inventario.ajustar' },
      { texto: 'Cambiar el precio al detal o al por mayor dejando constancia del motivo.', permiso: 'inventario.cambiar_precio' },
    ],
    consejos: [
      'Las unidades entran normalmente por Compras: cada compra crea un lote con su costo real.',
      'El "stock mínimo" de cada producto activa la alerta de pocas unidades en las gráficas.',
      'Para ediciones especiales o licores de alto valor puedes marcar "Controlar por serial o estampilla": cada botella queda identificada.',
    ],
    problemas: [['No encuentro un producto', 'Quita los filtros y revisa que no esté descontinuado o inactivo.'], ['No puedo editar el costo', 'El costo de los lotes ya ingresados no cambia; solo el costo de referencia, y requiere permiso.']],
  },
  compras: {
    proposito: 'Registra lo que compras a proveedores: productos, costos, fletes e impuestos, pagos y la foto o PDF de la factura. Cada compra ingresa unidades al inventario con su costo.',
    acciones: [
      { texto: 'Registrar una compra: proveedor, productos con cantidad y costo, fletes/impuestos y cómo se pagó.', permiso: 'compras.crear', href: '#/compras/nueva' },
      { texto: 'Adjuntar la factura (foto o PDF). Con la clave de Anthropic configurada, el OCR lee los datos solo.', permiso: 'compras.crear' },
      { texto: 'Ver compras con saldo pendiente y registrar pagos al proveedor.', href: '#/compras?con_saldo=1' },
      { texto: 'Revisar los documentos pendientes que llegaron por correo o webhook.', href: '#/documentos' },
      { texto: 'Ver la TRM del dólar que regía el día de cada compra: activa "Mostrar TRM" en el historial o abre el detalle de la compra.', href: '#/compras' },
      { texto: 'Filtrar el historial por proveedor, moneda (pesos / dólares) y periodo; el mismo filtro aplica al resumen de arriba.', href: '#/compras' },
    ],
    consejos: [
      'Si compras en dólares, elige USD: la app guarda la tasa del día y calcula el costo en pesos.',
      'Al registrar una compra, la app guarda la TRM oficial de ese día como referencia histórica, aparte de la tasa que apliques. Si no hay dato, puedes escribir una TRM de referencia manual o dejarla vacía: quedará "No disponible".',
      'En compras en dólares verás la diferencia entre la tasa aplicada y la TRM oficial. Es informativa: el costo de los lotes siempre usa la tasa aplicada.',
      'Los fletes e impuestos se prorratean entre los productos para que el costo por unidad sea el real.',
      'La app avisa si una factura parece duplicada (mismo proveedor y número).',
    ],
    problemas: [['El OCR no funciona', 'Falta la clave ANTHROPIC_API_KEY en el servidor; mientras tanto, captura los datos a mano.'], ['Me equivoqué en una compra', 'Anúlala con el motivo (solo si no se han vendido unidades) y regístrala de nuevo.'], ['La compra dice "TRM no disponible"', 'No hubo TRM oficial cuando se registró (sin internet o fecha sin dato) y nadie escribió una de referencia. No se cambia después: la referencia histórica es inmutable. Las compras anteriores a esta función se completan solas al arrancar el servidor (captura "Histórica").']],
  },
  clientes: {
    proposito: 'Directorio de clientes con su historial de compras, créditos, abonos y estado de cuenta.',
    acciones: [
      { texto: 'Buscar por nombre, teléfono o cédula y abrir la ficha del cliente.' },
      { texto: 'Crear o editar un cliente (solo el nombre es obligatorio).', permiso: 'clientes.editar' },
      { texto: 'Descargar o enviar por WhatsApp el estado de cuenta en PDF.', permiso: 'creditos.ver' },
      { texto: 'Desactivar un cliente conservando su historial.', permiso: 'eliminar' },
    ],
    consejos: ['Registra el teléfono con 10 dígitos para que el botón de WhatsApp funcione directo.', 'El resumen de arriba muestra clientes nuevos, recurrentes y los que más compran en el periodo.'],
    problemas: [['El cliente tiene saldo pendiente', 'Ábrelo y mira la sección Créditos; el abono se registra desde Créditos y cartera.']],
  },
  creditos: {
    proposito: 'Cartera: créditos vigentes, cuotas vencidas o por vencer, y registro de abonos.',
    acciones: [
      { texto: 'Filtrar por Vigentes, Vencidos, Por vencer, Parciales, Al día o Pagados.' },
      { texto: 'Registrar un abono: elige el crédito, el valor, el método de pago y, si quieres, el comprobante.', permiso: 'creditos.abonar', href: '#/creditos?abonar=1' },
      { texto: 'Abrir un crédito para ver sus cuotas, abonos y el estado de cuenta.' },
    ],
    consejos: ['Los créditos nacen al cobrar una venta a crédito o con pago parcial en Ventas.', 'Un abono en dólares guarda su tasa; la diferencia cambiaria se calcula sola en Contabilidad.'],
    problemas: [['No aparece el crédito que busco', 'Cambia el filtro a "Pagados" o "Todos"; por defecto se muestran los vigentes.']],
  },
  caja: {
    proposito: 'Control del efectivo del turno: abrir la caja con una base, registrar gastos y movimientos, pagar facturas y cerrar contando el dinero.',
    acciones: [
      { texto: 'Abrir caja con la base inicial en efectivo.', permiso: 'caja.operar' },
      { texto: 'Registrar gastos con categoría, valor y comprobante.', permiso: 'caja.operar' },
      { texto: 'Pagar facturas de proveedores pendientes desde la pestaña "Por pagar".' },
      { texto: 'Cerrar caja: la app muestra el efectivo esperado y tú anotas el contado; la diferencia queda registrada.', permiso: 'caja.operar' },
    ],
    consejos: ['Abre la caja al empezar el día: las ventas en efectivo se suman solas.', 'Los cierres anteriores quedan en la pestaña "Cierres" con sus diferencias.'],
    problemas: [['La diferencia del cierre no es cero', 'Revisa gastos sin registrar o ventas cobradas por otro método; la diferencia queda en el historial para conciliar.']],
  },
  domicilios: {
    proposito: 'Pedidos que llegan por WhatsApp, teléfono o la web y se entregan con la flota propia. El tablero muestra cada pedido según su estado: recibido, en preparación, en camino y entregado.',
    acciones: [
      { texto: 'Tomar un pedido: cliente (registrado o nuevo), dirección, productos con su tarifa automática, valor del envío y con cuánto paga.', permiso: 'domicilios.crear', href: '#/domicilios/nuevo' },
      { texto: 'Avanzar el pedido: Preparar → Despachar (eliges el repartidor; se revisa que haya existencias) → Entregar (confirmas el cobro y se crea la venta).', permiso: 'domicilios.despachar' },
      { texto: 'Escribirle al cliente por WhatsApp con el resumen del pedido, llamarlo o abrir la dirección en el mapa desde la ficha.' },
      { texto: 'Administrar los repartidores y vehículos de la flota.', permiso: 'domicilios.despachar', href: '#/domicilios/repartidores' },
    ],
    consejos: ['El inventario se descuenta al entregar: hasta entonces el pedido no mueve existencias.', 'Un pedido que pasa del tiempo configurado sin salir de la bodega o en camino se marca como atrasado y Tino avisa.', 'El valor del envío por defecto y el monto para envío gratis se cambian en Configuración › Domicilios y comisiones.'],
    problemas: [['No me deja despachar', 'Falta alguna referencia en inventario: la ficha muestra cuál. Registra la compra o corrige el pedido.'], ['El cliente no estaba', 'Usa "Volver a bodega" y vuelve a despacharlo después, o cancélalo con el motivo.']],
  },
  proveedores: {
    proposito: 'Directorio de proveedores con sus compras, pagos y saldo pendiente.',
    acciones: [
      { texto: 'Buscar por nombre, NIT o teléfono y abrir la ficha.' },
      { texto: 'Crear o editar un proveedor (solo el nombre es obligatorio).', permiso: 'proveedores.editar' },
      { texto: 'Pagar una compra pendiente desde la ficha del proveedor.' },
    ],
    consejos: ['El resumen de arriba compara cuánto le compras a cada proveedor y qué productos conviene reponer.'],
    problemas: [],
  },
  comisiones: {
    proposito: 'Rentabilidad de cada venta y comisiones del vendedor: ganancia operativa, salario base, comisión y resultado del negocio.',
    acciones: [
      { texto: 'Ver el resumen del periodo y la comparación vendedor frente a empleador.' },
      { texto: 'Asignar o cambiar el responsable de una venta (queda auditado).', permiso: 'comisiones.administrar' },
      { texto: 'Como vendedor: consultar tus ventas, tu ganancia generada y tu comisión estimada.', permiso: 'comisiones.ver_propias' },
    ],
    consejos: ['La comisión es un porcentaje de la ganancia comisionable, no del precio de venta.', 'El salario base es mensual e igual para todos (Configuración › Domicilios y comisiones). No se reparte por días: con «Hoy» o «7 días» se muestra el mes completo y no se descuenta del resultado; con «Este mes» sí.', 'Las ventas sin responsable quedan fuera de las comisiones hasta asignarlas.'],
    problemas: [['Una venta no aparece en mis comisiones', 'Pide al administrador que te la asigne como responsable en "Ventas por responsable".']],
  },
  contabilidad: {
    proposito: 'Panel financiero por periodo, rentabilidad de cada operación con su costo por lote y tasa, TRM oficial y dólar de mercado, y diferencias cambiarias.',
    acciones: [
      { texto: 'Filtrar el panel por periodo, producto, categoría, proveedor y moneda.' },
      { texto: 'Abrir una operación para ver la ficha: ingreso, costo por lote, tasa y resultado.' },
      { texto: 'Consultar la TRM del día, su historial y la gráfica.', href: '#/contabilidad/trm' },
      { texto: 'Corregir la tasa de una compra o venta dejando el motivo (solo administrador).', permiso: 'contabilidad.editar' },
    ],
    consejos: ['La diferencia cambiaria solo se registra cuando un pago o abono en USD se liquida a otra tasa.', 'El método de costeo (FIFO o promedio) se elige en Configuración › Ventas y caja.'],
    problemas: [['La TRM dice "dato no actualizado"', 'El servidor no pudo consultar datos.gov.co; se muestra la última vigente y se reintenta solo.']],
  },
  reportes: {
    proposito: 'Informes listos para descargar en Excel (CSV) o PDF: inventario, ventas, compras, cartera, gastos, cierres, rentabilidad y más.',
    acciones: [
      { texto: 'Elegir un reporte de la lista; cada uno explica qué contiene.' },
      { texto: 'Filtrar por fechas y, donde aplica, por categoría, producto o días sin ventas.' },
      { texto: 'Descargar en Excel o PDF con los botones de arriba.' },
    ],
    consejos: ['Cada reporte se resume en una gráfica antes de descargarlo, para confirmar que es el que necesitas.'],
    problemas: [['El archivo sale vacío', 'Amplía el periodo o quita el filtro de categoría.']],
  },
  marketing: {
    proposito: 'Mide qué trae cada campaña publicitaria: cuánto se invirtió, cuántas personas vieron el anuncio, visitaron la página, preguntaron, se registraron como clientes potenciales y terminaron comprando. Solo muestra datos registrados; lo que no se mide aparece como "Sin dato".',
    acciones: [
      { texto: 'Panel: inversión, impresiones, clics, visitas, consultas, clientes potenciales, ventas atribuidas, costo por cliente potencial, CAC y ROAS del periodo, con gráficas por campaña, canal y producto.', permiso: 'marketing.ver', href: '#/marketing/panel' },
      { texto: 'Embudo: del anuncio a la compra, paso por paso, con el porcentaje que avanza en cada etapa.', permiso: 'marketing.ver', href: '#/marketing/embudo' },
      { texto: 'Rentabilidad: por campaña, ingresos atribuidos menos costo real de los productos, costos variables e inversión = utilidad estimada.', permiso: 'marketing.ver', href: '#/marketing/rentabilidad' },
      { texto: 'Crear campañas (plataforma, presupuesto, enlace, productos) y registrar su inversión y métricas por día; la ficha genera el enlace con UTM y el enlace de WhatsApp listos para copiar.', permiso: 'marketing.editar', href: '#/marketing/campanas' },
      { texto: 'Registrar y atender clientes potenciales: quién preguntó, por dónde, por qué producto y en qué estado va (nuevo, contactado, interesado, convertido, perdido). "Convertir en cliente" crea el cliente con su origen.', permiso: 'marketing.leads', href: '#/marketing/leads' },
      { texto: 'Cambiar a mano el origen de una venta desde su detalle (queda auditado).', permiso: 'marketing.editar' },
      { texto: 'Integraciones: conectar Meta Ads (Google y TikTok pendientes de credenciales), sincronizar y configurar el seguimiento de la página web.', permiso: 'marketing.configurar', href: '#/marketing/integraciones' },
    ],
    consejos: [
      'Usa siempre los enlaces con UTM que genera cada campaña en tus anuncios: así las visitas, los formularios y las ventas se asocian a esa campaña.',
      'Al cobrar, llena "¿Cómo llegó el cliente?" y la campaña. Es la forma más confiable de atribuir una venta (atribución confirmada).',
      'Una venta queda "estimada" cuando el cliente había preguntado por una campaña (mismo teléfono) dentro de la ventana de atribución (30 días por defecto) pero nadie lo registró al vender.',
      'Un ROAS alto no significa ganancia: mira la utilidad estimada en Rentabilidad, que descuenta el costo real de los productos y la inversión.',
      'Si una métrica dice "Sin dato" no es cero: falta registrar la información o conectar la fuente (métricas de la campaña, seguimiento web).',
    ],
    problemas: [['El panel está vacío', 'Crea una campaña y registra su gasto por día, o anota los clientes potenciales que llegan por WhatsApp y en el local; las ventas se atribuyen al elegir la campaña al cobrar.'], ['No llegan visitas de la web', 'Comprueba en Integraciones que el token esté generado, que el fragmento esté pegado en todas las páginas y que los enlaces de los anuncios lleven los UTM.'], ['Meta no sincroniza', 'Faltan META_ADS_TOKEN y META_ADS_CUENTA en el servidor, o el token no tiene el permiso ads_read. El historial de sincronizaciones muestra el error exacto.']],
  },
  configuracion: {
    proposito: 'Datos del negocio, usuarios y permisos, reglas de ventas y caja (incluido el precio mayorista), domicilios y comisiones, categorías, integraciones y respaldos.',
    acciones: [
      { texto: 'Cambiar tu contraseña en "Mi cuenta".', href: '#/configuracion/cuenta' },
      { texto: 'Crear usuarios y asignarles rol, salario y porcentaje de comisión.', permiso: 'usuarios.administrar', href: '#/configuracion/usuarios' },
      { texto: 'Ajustar qué puede hacer cada rol en "Permisos".', permiso: 'usuarios.administrar', href: '#/configuracion/permisos' },
      { texto: 'Descargar o crear respaldos de la base de datos.', permiso: 'config.editar', href: '#/configuracion/respaldos' },
      { texto: 'Revisar la auditoría: quién hizo qué y cuándo.', permiso: 'auditoria.ver', href: '#/configuracion/auditoria' },
      { texto: 'Activar o ajustar el asistente Tino (proveedor de IA, modelo, límite de mensajes por hora y voz) en "Asistente Tino".', permiso: 'config.editar', href: '#/configuracion/asistente' },
    ],
    consejos: ['Si un usuario olvida su contraseña, el administrador genera un código en "Usuarios" y el usuario lo usa en la pantalla de entrada.', 'El asistente Tino necesita la clave del proveedor de IA en el servidor (ANTHROPIC_API_KEY en las variables de entorno del servidor). La aplicación solo indica si existe; nunca la muestra.'],
    problemas: [],
  },
};

const accionVisible = (a) => !a.permiso || estado.tiene(a.permiso);
export const tieneAyuda = (seccion) => !!AYUDA[moduloDe(seccion)];

export function abrirAyuda(seccion) {
  const ruta = moduloDe(seccion);
  const a = AYUDA[ruta]; const m = MODULOS.find((x) => x.ruta === ruta);
  if (!a || !m) return;
  const acciones = a.acciones.filter(accionVisible);
  const cuerpo = `<div class="ayuda">
    <div class="ayuda-cab"><span class="app-ico">${icono(m.icono)}</span><div><div class="bold">${esc(m.nombre)}</div><div class="muted small">${esc(a.proposito)}</div></div></div>
    ${acciones.length ? `<h3>Qué puedes hacer aquí</h3><ul class="ayuda-lista">${acciones.map((x) => `<li>${icono('check', 16)}<span>${esc(x.texto)}${x.href ? ` <a href="${esc(x.href)}" data-ir>Ir</a>` : ''}</span></li>`).join('')}</ul>` : ''}
    ${a.consejos.length ? `<h3>Consejos</h3><ul class="ayuda-lista consejos">${a.consejos.map((x) => `<li>${icono('sparkle', 16)}<span>${esc(x)}</span></li>`).join('')}</ul>` : ''}
    ${a.problemas.length ? `<h3>Si algo no sale</h3><dl class="ayuda-problemas">${a.problemas.map(([p, s]) => `<dt>${esc(p)}</dt><dd>${esc(s)}</dd>`).join('')}</dl>` : ''}
  </div>`;
  const md = modal({ titulo: 'Ayuda', cuerpo, acciones: [{ texto: 'Glosario', clase: 'suave', alHacerClic: () => { setTimeout(() => abrirGlosario(seccion), 50); } }, { texto: 'Ver la guía de uso', clase: 'suave', alHacerClic: () => { setTimeout(() => guiaBienvenida({ forzar: true }), 50); } }, { texto: 'Entendido', clase: 'primario' }] });
  $$('[data-ir]', md.el).forEach((l) => l.addEventListener('click', () => md.cerrar()));
}

// ---------- Glosario ----------
// Qué significa cada término que aparece en pantalla, agrupado por módulo. Se abre desde Inicio, desde la ayuda "?" y desde
// la ayuda de cada módulo. `abrirGlosario(seccion)` pone primero el grupo del módulo donde está el usuario.
export const GLOSARIO = [
  { ruta: 'domicilios', grupo: 'Domicilios', terminos: [
    ['Recibido', 'El pedido está tomado y nadie ha empezado a alistarlo.'],
    ['En preparación', 'Se están alistando los productos en la bodega.'],
    ['En camino', 'Salió con un repartidor. Desde aquí se cuentan los minutos hasta la entrega.'],
    ['Entregado', 'El cliente recibió y pagó: la venta quedó registrada y el inventario se descontó.'],
    ['Atrasado', 'Lleva más minutos de los configurados sin salir de la bodega o en camino.'],
    ['Paga con / cambio', 'Billete con el que el cliente dice que pagará en efectivo; la app calcula el cambio que debe llevar el repartidor.'],
    ['Envío gratis desde', 'Valor de productos desde el cual el pedido no paga domicilio.'],
  ] },
  { ruta: 'vender', grupo: 'Vender', terminos: [
    ['Carrito', 'Productos que se van a cobrar. Cada línea se puede quitar con el botón "Quitar".'],
    ['Precio de lista', 'Precio de la tarifa que aplica a la línea (detal o mayor). Cambiarlo en una venta requiere permiso.'],
    ['Precio al detal', 'Precio por unidad para el consumidor final.'],
    ['Precio al por mayor', 'Precio por unidad para tiendas, bares y eventos. Se aplica solo desde las unidades configuradas de una misma referencia o a clientes mayoristas.'],
    ['Cliente mayorista', 'Cliente marcado como mayorista en su ficha: recibe el precio al por mayor desde la primera unidad.'],
    ['Serial / estampilla', 'Número único de una botella controlada una por una. Al venderla, el costo se toma del lote de esa unidad.'],
    ['Venta a crédito', 'El cliente paga una parte o nada y el saldo queda en cuotas en Créditos y cartera.'],
    ['Vitrina', 'Botellas con foto en la pantalla de Vender. Sin búsqueda muestra lo que más se vendió en los últimos 30 días.'],
  ] },
  { ruta: 'inventario', grupo: 'Inventario', terminos: [
    ['Lote', 'Cada compra crea un lote con su costo. Así se sabe cuánto costó cada unidad vendida.'],
    ['FIFO', 'Lo primero que entra es lo primero que sale: las ventas descuentan del lote más antiguo.'],
    ['Stock mínimo', 'Cantidad por debajo de la cual el producto aparece como "por reponer".'],
    ['Presentación', 'Tamaño del envase: 375 ml (media), 750 ml (botella), 1000 ml (litro), 1750 ml (garrafa), lata 330 ml…'],
    ['Licores y complementos', 'Licores: whisky, aguardiente, ron, tequila, vinos, cervezas… Complementos: bebidas, snacks, hielo, desechables, cigarrillos y anchetas.'],
  ] },
  { ruta: 'comisiones', grupo: 'Rentabilidad y comisiones', terminos: [
    ['Ganancia operativa', 'Precio de venta − costo del producto − gastos de la venta.'],
    ['Ganancia comisionable', 'Parte de la ganancia sobre la que se calcula la comisión del vendedor.'],
    ['Comisión', 'Porcentaje de la ganancia comisionable (no del precio de venta) que gana el vendedor.'],
    ['Salario base', 'Pago fijo mensual, igual para todos. No se reparte por días.'],
    ['Responsable comercial', 'Persona a quien se le cuenta la venta para las comisiones. Puede quedar "pendiente de asignación".'],
    ['Resultado del negocio', 'Ganancia que queda para el negocio después de comisiones y salarios del periodo.'],
  ] },
  { ruta: 'contabilidad', grupo: 'Contabilidad', terminos: [
    ['TRM', 'Tasa Representativa del Mercado: valor oficial del dólar en Colombia para el día.'],
    ['Dólar de mercado', 'Precio del dólar en el mercado, que puede diferir de la TRM.'],
    ['Diferencia cambiaria', 'Ganancia o pérdida porque el dólar cambió entre la compra o venta y el pago en dólares.'],
    ['Ganancia bruta', 'Ingreso neto − costo de lo vendido.'],
    ['Ganancia neta', 'Ganancia bruta − comisiones, gastos de venta e impuestos.'],
  ] },
  { ruta: 'creditos', grupo: 'Créditos y cartera', terminos: [
    ['Abono', 'Pago parcial de un crédito o de una cuota.'],
    ['Saldo', 'Lo que el cliente todavía debe.'],
    ['Cuota vencida', 'Cuota cuya fecha de pago ya pasó sin pagarse completa.'],
  ] },
  { ruta: 'compras', grupo: 'Compras y TRM', terminos: [
    ['TRM de referencia', 'TRM oficial del dólar (Superintendencia Financiera) vigente el día de la compra. Se guarda como foto de ese momento y no cambia después; sirve para comparar y auditar, no para calcular el costo.'],
    ['Tasa aplicada', 'La tasa de cambio con la que realmente se convirtió la factura a pesos. Es la que define el costo de los lotes. En compras en pesos es 1.'],
    ['Captura automática', 'La TRM de referencia se tomó sola de la fuente oficial (caché o API de datos.gov.co) al registrar la compra.'],
    ['Captura manual', 'No había TRM oficial para esa fecha y el usuario escribió una TRM de referencia con su motivo o fuente.'],
    ['Captura histórica', 'La compra se registró antes de que la app guardara la TRM; se completó después desde el histórico oficial, sin tocar costos.'],
    ['TRM no disponible', 'No hubo TRM oficial al registrar la compra y nadie escribió una de referencia. Se muestra así, sin inventar valores.'],
    ['Diferencia frente a la TRM', 'Tasa aplicada menos TRM de referencia, en pesos por dólar y en %. Positiva: se pagó el dólar por encima de la TRM; negativa: por debajo. No es diferencia cambiaria realizada ni cambia la rentabilidad.'],
  ] },
  { ruta: 'inicio', grupo: 'Asistente Tino', terminos: [
    ['Tino', 'Asistente de Licores Palmira (funciona sin IA y, si se configura, también con inteligencia artificial). Responde preguntas sobre el negocio usando solo los datos que tu usuario puede ver y explica cómo hacer los procesos de la aplicación.'],
    ['Herramienta (del asistente)', 'Consulta controlada que Tino ejecuta en el servidor para responder (ventas, compras, inventario, domicilios, caja, créditos, rentabilidad, marketing). Tino nunca inventa cifras: si no hay datos, lo dice.'],
    ['Límite de mensajes por hora', 'Cantidad máxima de preguntas que cada usuario puede hacerle a Tino en una hora. Protege el costo del servicio; lo fija el administrador en Configuración › Asistente Tino.'],
    ['Dictado por voz', 'Botón del micrófono en el panel de Tino: convierte lo que dices en texto usando el reconocimiento del navegador (no se envía audio al servidor). Revisa el texto antes de enviarlo.'],
    ['Leer respuestas', 'Opción del panel de Tino para escuchar la respuesta con la voz del navegador en español.'],
    ['Proveedor de IA', 'Servicio externo que genera las respuestas de Tino (Anthropic por defecto). Requiere una clave configurada en el servidor.'],
    ['Costo estimado (tokens)', 'Cada respuesta de Tino guarda cuántos tokens usó y su costo aproximado en dólares; se consulta en la auditoría con la acción "asistente_consulta".'],
  ] },
  { ruta: 'marketing', grupo: 'Marketing', terminos: [
    ['Campaña', 'Una acción publicitaria concreta (anuncio en Meta, Google, TikTok, difusión por WhatsApp…) con su inversión, fechas y productos.'],
    ['Inversión', 'Lo gastado en la campaña: suma del gasto por día (si un día tiene dato de la plataforma, se usa ese; si no, el manual) o el gasto total anotado a mano.'],
    ['Impresiones y alcance', 'Veces que se mostró el anuncio y personas distintas que lo vieron, según la plataforma.'],
    ['Clics', 'Veces que alguien tocó el anuncio.'],
    ['Visitas', 'Entradas a la página web medidas por el script de seguimiento.'],
    ['Consultas', 'Contactos generados: clics en WhatsApp, teléfono o correo y formularios de la web, más las conversaciones que reporta la plataforma.'],
    ['Cliente potencial (lead)', 'Persona que preguntó por un producto (web, WhatsApp, redes o en el local) y aún no es cliente. Tiene canal, campaña y estado.'],
    ['Convertir en cliente', 'Crear la ficha de cliente a partir de un cliente potencial; el cliente queda con su canal y campaña de origen.'],
    ['Canal', 'Por dónde llegó la persona: WhatsApp, página web, Instagram, Facebook, TikTok, Google, referido, en el local…'],
    ['UTM', 'Parámetros que se agregan al enlace del anuncio (utm_source, utm_medium, utm_campaign) para saber de qué campaña viene cada visita.'],
    ['Atribución confirmada', 'Hay evidencia directa: se eligió la campaña al vender, el cliente nació de un cliente potencial de esa campaña o tiene la campaña como origen.'],
    ['Atribución estimada', 'No se registró al vender, pero el cliente había preguntado por la campaña (mismo teléfono) dentro de la ventana de atribución.'],
    ['Sin atribución', 'La venta no tiene información de origen (o solo el canal, sin campaña).'],
    ['Ventana de atribución', 'Días hacia atrás (30 por defecto) en los que una consulta previa cuenta para atribuir una venta.'],
    ['Costo por cliente potencial', 'Inversión ÷ clientes potenciales del periodo.'],
    ['CAC', 'Costo de adquisición de cliente: inversión ÷ clientes distintos que compraron por la campaña.'],
    ['ROAS', 'Retorno de la inversión publicitaria: ingresos atribuidos ÷ inversión. No descuenta costos: un ROAS alto no garantiza ganancia.'],
    ['Margen de contribución', 'Ingresos atribuidos − costo real de los productos vendidos − costos variables de cada venta (gastos de venta, comisión, impuestos).'],
    ['Utilidad estimada', 'Margen de contribución − inversión de la campaña. Es lo que realmente dejó la campaña.'],
    ['Embudo', 'Secuencia impresiones → clics → visitas → producto consultado → contacto → cliente potencial → compra, con el porcentaje que pasa de una etapa a la siguiente.'],
    ['Sin dato', 'La fuente de esa cifra no está conectada o no se registró; no significa cero.'],
    ['Sincronización', 'Lectura automática de campañas e inversión desde la plataforma publicitaria (Meta Ads) con credenciales configuradas en el servidor.'],
  ] },
];

export function abrirGlosario(seccion) {
  const ruta = seccion ? moduloDe(seccion) : null;
  const grupos = [...GLOSARIO].sort((a, b) => (b.ruta === ruta) - (a.ruta === ruta));
  const cuerpo = `<div class="glosario"><div class="buscador">${icono('search')}<input type="search" id="gl-q" placeholder="Buscar un término…" autocomplete="off"></div>
    ${grupos.map((g) => `<section class="glosario-grupo" data-grupo><h3>${esc(g.grupo)}</h3><dl>${g.terminos.map(([t, d]) => `<div class="glosario-item" data-texto="${esc((t + ' ' + d).toLowerCase())}"><dt>${esc(t)}</dt><dd>${esc(d)}</dd></div>`).join('')}</dl></section>`).join('')}
    <p class="muted small" id="gl-vacio" hidden>No hay términos con esa palabra.</p></div>`;
  const md = modal({ titulo: 'Glosario', cuerpo, ancho: true, acciones: [{ texto: 'Entendido', clase: 'primario' }] });
  const q = $('#gl-q', md.el);
  q.addEventListener('input', () => filtrarGlosario(md.el, q.value));
}

// Filtra el glosario ya pintado en `raiz`: oculta los términos (y los grupos) que no contienen el texto y muestra el aviso
// "sin términos" cuando no queda ninguno. Devuelve cuántos términos quedan visibles. Recorre listas, así que usa $$ (no $).
export function filtrarGlosario(raiz, texto) {
  const t = String(texto || '').trim().toLowerCase();
  let visibles = 0;
  $$('[data-grupo]', raiz).forEach((g) => { let n = 0; $$('.glosario-item', g).forEach((it) => { const ok = !t || it.dataset.texto.includes(t); it.hidden = !ok; if (ok) n++; }); g.hidden = !n; visibles += n; });
  const aviso = $('#gl-vacio', raiz);
  if (aviso) aviso.hidden = visibles > 0;
  return visibles;
}

// ---------- Guía de primer uso ----------
const claveGuia = () => `guia.vista.${estado.usuario ? estado.usuario.id : 'anonimo'}`;
export function guiaPendiente() { try { return !localStorage.getItem(claveGuia()); } catch { return false; } }
function marcarGuiaVista() { try { localStorage.setItem(claveGuia(), new Date().toISOString()); } catch { /* sin almacenamiento */ } }

function pasosGuia() {
  const negocio = estado.config.negocio_nombre || 'Licores Palmira';
  const modulos = MODULOS.filter((m) => m.ruta !== 'inicio' && moduloVisible(m));
  const ejemplo = modulos.slice(0, 6);
  return [
    {
      titulo: `Bienvenido a ${negocio}`,
      texto: 'Este sistema administra Licores Palmira: ventas al detal y al por mayor, domicilios, inventario por lotes, compras, clientes, créditos, caja y contabilidad. En un minuto sabrás cómo moverte.',
      visual: `<div class="guia-visual"><img src="/icons/logo-palmira.webp" alt="" style="width:170px"></div>`,
    },
    {
      titulo: 'Inicio es el resumen de tu día',
      texto: 'Al entrar ves cómo va el negocio hoy: ventas del día y del mes, cartera e inventario, los pendientes ordenados por urgencia y las últimas ventas. Arriba están las acciones más frecuentes, como Nueva venta. Toca cualquier bloque para ir al detalle.',
      visual: `<div class="guia-visual"><div class="apps mini">${[['cash', 'Ventas de hoy'], ['alert', 'Pendientes'], ['clock', 'Últimas ventas']].map(([ic, t]) => `<span class="app-tile"><span class="app-ico">${icono(ic)}</span><span class="app-nombre">${esc(t)}</span></span>`).join('')}</div></div>`,
    },
    {
      titulo: 'El menú lleva a todos los módulos',
      texto: 'En computador, el menú izquierdo lista los módulos en tres bloques: los del día a día (Inicio, Gráficas, Ventas, Domicilios, Inventario…), "Finanzas" y "Gestión". En el celular usa la barra de abajo y el botón "Más", que muestra los mismos bloques. Toca "Inicio" cuando quieras volver.',
      visual: `<div class="guia-visual"><div class="guia-menu plano"><div class="guia-menu-item activo">${icono('home', 16)}<span>Inicio</span></div>${ejemplo.slice(0, 2).map((m) => `<div class="guia-menu-item">${icono(m.icono, 16)}<span>${esc(m.nombre)}</span></div>`).join('')}<div class="nav-seccion">Finanzas</div><div class="guia-menu-item">${icono('cash', 16)}<span>Caja y gastos</span></div><div class="nav-seccion">Gestión</div><div class="guia-menu-item">${icono('settings', 16)}<span>Configuración</span></div></div></div>`,
    },
    {
      titulo: 'Las gráficas tienen su propio lugar',
      texto: 'Para ver cómo va el negocio abre "Gráficas del negocio": ventas, ganancias, inventario, cartera y comparación con el periodo anterior. Elige el periodo con las pastillas de arriba.',
      visual: `<div class="guia-visual"><div class="app-tile" style="max-width:180px;margin:0 auto"><span class="app-ico">${icono('analytics')}</span><span class="app-nombre">Gráficas del negocio</span><span class="app-desc" style="display:block">Analizar el rendimiento del negocio</span></div></div>`,
    },
    {
      titulo: 'Ayuda donde la necesites',
      texto: 'En cada módulo, el botón "?" de la barra superior explica qué puedes hacer ahí, consejos y qué hacer si algo no sale. Esta guía siempre está disponible desde Inicio › "Guía de uso".',
      visual: `<div class="guia-visual"><div class="guia-topbar"><span class="bold">Inventario</span><span class="btn icono chico" aria-hidden="true">${icono('help', 18)}</span></div></div>`,
    },
    ...(estado.tiene('asistente.usar') ? [{
      titulo: 'Tino responde tus dudas',
      texto: 'Abajo a la derecha está Tino, el asistente de Licores Palmira. Pregúntale por texto o por voz cuánto has vendido, cómo van los domicilios, qué licores están por agotarse o cómo hacer un proceso; solo responde con datos que tú puedes ver y puede llevarte a la pantalla indicada.',
      visual: `<div class="guia-visual"><img src="/icons/tino.svg" alt="" style="height:120px"></div>`,
    }] : []),
  ];
}

export function guiaBienvenida({ forzar = false } = {}) {
  if (!forzar && !guiaPendiente()) return;
  if (!estado.usuario) return;
  const pasos = pasosGuia();
  let i = 0;
  const cuerpo = document.createElement('div');
  cuerpo.className = 'guia';
  // Los botones van en el pie fijo del modal (siempre visibles); el contenido del paso es lo único que se desplaza.
  const pintar = () => {
    const p = pasos[i]; const ultimo = i === pasos.length - 1;
    cuerpo.innerHTML = `${p.visual}<h2 class="guia-titulo">${esc(p.titulo)}</h2><p class="guia-texto">${esc(p.texto)}</p>
      <div class="guia-puntos" aria-label="Paso ${i + 1} de ${pasos.length}">${pasos.map((_, k) => `<span class="${k === i ? 'activo' : ''}"></span>`).join('')}</div>`;
    const omitir = $('#g-omitir', md.el), atras = $('#g-atras', md.el), sig = $('#g-sig', md.el);
    omitir.textContent = ultimo ? 'Cerrar' : 'Omitir'; atras.hidden = i === 0; sig.textContent = ultimo ? 'Empezar a trabajar' : 'Siguiente';
    $('.cuerpo', md.el).scrollTop = 0;
  };
  const md = modal({
    titulo: 'Guía de uso', cuerpo, cerrable: true,
    acciones: [
      { id: 'g-omitir', texto: 'Omitir', clase: 'suave', alHacerClic: () => { marcarGuiaVista(); } },
      { id: 'g-atras', texto: 'Atrás', clase: 'suave', alHacerClic: () => { i--; pintar(); return false; } },
      { id: 'g-sig', texto: 'Siguiente', clase: 'primario', alHacerClic: () => { if (i < pasos.length - 1) { i++; pintar(); return false; } marcarGuiaVista(); } },
    ],
  });
  // Cerrar con la X o el fondo también cuenta como vista: no debe reaparecer en cada entrada.
  md.el.addEventListener('click', (e) => { if (e.target === md.el || e.target.closest('[data-cerrar]')) marcarGuiaVista(); });
  pintar();
}
