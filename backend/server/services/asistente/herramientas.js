'use strict';
// Herramientas del asistente Tino. SOLO LECTURA en esta versión: cada una reutiliza los servicios existentes (nunca SQL
// generado por el modelo), valida sus parámetros contra su propio esquema, comprueba el permiso del usuario con tiene()
// y devuelve resultados acotados (máx. ~40 filas / ~6 KB) para no inflar el contexto del modelo.
// Estructura pensada para añadir después herramientas de ESCRITURA con `requiere_confirmacion: true` (ver docs/ASISTENTE.md,
// "Pendientes"): el servicio deberá pedir confirmación explícita al usuario antes de ejecutarlas. Hoy ninguna la requiere.
const { tiene } = require('../../permisos');
const { hoy } = require('../../util');
const analitica = require('../analitica');
const compras = require('../compras');
const ventas = require('../ventas');
const productos = require('../productos');
const dashboard = require('../dashboard');
const caja = require('../caja');
const creditos = require('../creditos');
const comisiones = require('../comisiones');
const trm = require('../trm');
const domicilios = require('../domicilios');
const guia = require('./guia');
// avisos.js se carga al usarse: local.js importa este módulo y avisos.js, y así se evita un ciclo de carga.
const avisos = () => require('./avisos');

const MAX_FILAS = 40;
const MAX_BYTES = 6000;
const PERIODOS = ['hoy', '7d', '30d', 'semana', 'mes', 'anio', 'todo'];

// Rutas de la interfaz a las que el asistente puede ofrecer llevar al usuario (el cliente ejecuta la acción; aquí solo se valida).
const RUTAS = {
  '#/inicio': 'Inicio', '#/graficas': 'Gráficas del local', '#/vender': 'Vender', '#/ventas': 'Historial de ventas',
  '#/compras': 'Compras', '#/compras/nueva': 'Nueva compra', '#/documentos': 'Documentos recibidos',
  '#/inventario': 'Inventario', '#/inventario/nuevo': 'Nuevo producto', '#/clientes': 'Clientes', '#/creditos': 'Créditos y cartera',
  '#/caja': 'Caja y gastos', '#/domicilios': 'Domicilios', '#/domicilios/nuevo': 'Nuevo domicilio', '#/domicilios/repartidores': 'Repartidores', '#/proveedores': 'Proveedores',
  '#/comisiones': 'Rentabilidad y comisiones', '#/contabilidad': 'Contabilidad', '#/contabilidad/trm': 'TRM y dólar',
  '#/marketing': 'Marketing', '#/reportes': 'Reportes', '#/configuracion': 'Configuración', '#/configuracion/usuarios': 'Usuarios',
  '#/configuracion/permisos': 'Permisos', '#/configuracion/asistente': 'Configuración del asistente', '#/configuracion/cuenta': 'Mi cuenta',
};

// ---------- Validación de parámetros contra el esquema (sin dependencias) ----------
class ErrorHerramienta extends Error {}
function validarArgs(schema, args) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const props = schema.properties || {};
  for (const k of Object.keys(a)) if (!props[k]) throw new ErrorHerramienta(`Parámetro desconocido: ${k}`);
  for (const k of schema.required || []) if (a[k] === undefined || a[k] === null || a[k] === '') throw new ErrorHerramienta(`Falta el parámetro obligatorio: ${k}`);
  const limpio = {};
  for (const [k, def] of Object.entries(props)) {
    let v = a[k];
    if (v === undefined || v === null || v === '') continue;
    const tipos = Array.isArray(def.type) ? def.type : [def.type];
    if (tipos.includes('integer') || tipos.includes('number')) {
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) v = Number(v);
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new ErrorHerramienta(`${k} debe ser un número`);
      if (tipos.includes('integer') && !tipos.includes('number')) v = Math.round(v);
      if (def.minimum !== undefined && v < def.minimum) v = def.minimum;
      if (def.maximum !== undefined && v > def.maximum) v = def.maximum;
    } else if (tipos.includes('boolean')) {
      if (typeof v === 'string') v = ['1', 'true', 'si', 'sí'].includes(v.toLowerCase());
      if (typeof v !== 'boolean') throw new ErrorHerramienta(`${k} debe ser verdadero o falso`);
    } else if (tipos.includes('string')) {
      if (typeof v !== 'string') v = String(v);
      v = v.trim();
      if (def.maxLength && v.length > def.maxLength) v = v.slice(0, def.maxLength);
      if (def.enum && !def.enum.includes(v)) throw new ErrorHerramienta(`${k} debe ser uno de: ${def.enum.join(', ')}`);
      if (def.pattern && !new RegExp(def.pattern).test(v)) throw new ErrorHerramienta(`${k} no tiene el formato esperado`);
    } else if (tipos.includes('object')) {
      if (typeof v !== 'object' || Array.isArray(v)) throw new ErrorHerramienta(`${k} debe ser un objeto`);
    }
    limpio[k] = v;
  }
  return limpio;
}

// ---------- Acotar resultados ----------
function recortarFilas(valor, max) {
  if (Array.isArray(valor)) return valor.slice(0, max).map((x) => recortarFilas(x, max));
  if (valor && typeof valor === 'object') { const o = {}; for (const [k, v] of Object.entries(valor)) o[k] = recortarFilas(v, max); return o; }
  return valor;
}
function acotar(datos, { filas = MAX_FILAS, bytes = MAX_BYTES } = {}) {
  let max = filas;
  let salida = recortarFilas(datos, max);
  let texto = JSON.stringify(salida);
  while (texto.length > bytes && max > 5) { max = Math.max(5, Math.floor(max / 2)); salida = recortarFilas(datos, max); texto = JSON.stringify(salida); }
  if (texto.length > bytes) return { ...(typeof salida === 'object' && !Array.isArray(salida) ? {} : { datos: salida }), recortado: true, nota: `Resultado recortado a ${bytes} caracteres`, texto: texto.slice(0, bytes) };
  return salida;
}

// ---------- Utilidades comunes ----------
const PROPS_PERIODO = {
  periodo: { type: 'string', enum: PERIODOS, description: 'Periodo predefinido: hoy, 7d, 30d, semana (desde el lunes), mes (mes actual), anio (año actual) o todo. Si se dan desde/hasta, se ignora.' },
  desde: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Fecha inicial AAAA-MM-DD (rango personalizado).' },
  hasta: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Fecha final AAAA-MM-DD (rango personalizado).' },
};
function filtrosPeriodo(a) {
  if (a.desde && a.hasta) return { periodo: 'rango', desde: a.desde, hasta: a.hasta };
  if (a.desde && !a.hasta) return { periodo: 'rango', desde: a.desde, hasta: hoy() };
  return { periodo: a.periodo || 'mes' };
}
const n0 = (v) => (v === null || v === undefined ? null : Number(v));
const fila = (obj, claves) => { const o = {}; for (const k of claves) if (obj[k] !== undefined) o[k] = obj[k]; return o; };
const esGlobalComisiones = (u) => tiene(u, 'comisiones.ver') || tiene(u, 'comisiones.administrar');
const sinPermiso = (q) => new ErrorHerramienta(`Sin permiso: el usuario no puede ${q}. Díselo con claridad y no inventes datos.`);

// ---------- Definición de herramientas ----------
const HERRAMIENTAS = [
  {
    nombre: 'consultar_ventas',
    descripcion: 'Ventas del negocio en un periodo: total vendido, cantidad, unidades, ticket promedio, devoluciones, comparación con el periodo anterior, métodos de pago, productos más vendidos, ventas por vendedor y la serie (por hora si el periodo es un solo día). Con filtros devuelve las ventas que cumplen: texto libre (número, cliente o producto), un cliente, un vendedor, un producto o una categoría concreta (aunque no esté en lo más vendido), tipo de pago, estado o monto mínimo; con `numero` devuelve el detalle completo de esa venta. Un vendedor solo ve sus propias ventas.',
    parametros: { type: 'object', properties: {
      ...PROPS_PERIODO,
      q: { type: 'string', maxLength: 80, description: 'Busca ventas por número, nombre de cliente o de producto.' },
      numero: { type: 'string', maxLength: 40, description: 'Número exacto de una venta: devuelve su detalle completo (ítems, pagos, crédito, devoluciones).' },
      cliente: { type: 'string', maxLength: 80, description: 'Nombre del cliente: qué le vendieron a él.' },
      vendedor: { type: 'string', maxLength: 80, description: 'Nombre del vendedor: solo lo vendido por él.' },
      producto: { type: 'string', maxLength: 80, description: 'Texto del producto (nombre, marca, referencia): unidades y total vendido de los que coincidan.' },
      categoria: { type: 'string', maxLength: 80, description: 'Nombre de la categoría (p. ej. "whisky", "aguardiente", "cervezas"): unidades y total por producto de esa categoría.' },
      tipo_pago: { type: 'string', maxLength: 30, description: 'Tipo de pago: contado, credito (fiado) o parcial.' },
      estado: { type: 'string', maxLength: 30, description: 'Estado de la venta; "anulada" para ver las reversadas.' },
      monto_minimo: { type: 'number', minimum: 0, description: 'Solo ventas con total mayor o igual a este valor en pesos ("más de un palo" = 1000000).' },
      limite: { type: 'integer', minimum: 1, maximum: MAX_FILAS, description: 'Cuántas ventas listar como máximo (por defecto 15).' },
    }, required: [], additionalProperties: false },
    permitido: (u) => tiene(u, 'ventas.ver') || tiene(u, 'comisiones.ver_propias'),
    requiere_confirmacion: false,
    ejecutar: (db, u, a) => {
      const f = filtrosPeriodo(a);
      const propio = !esGlobalComisiones(u) && tiene(u, 'comisiones.ver_propias');
      const r = analitica.rango(f);
      const d0 = (d) => d + ' 00:00:00';
      const d1 = (d) => d + ' 23:59:59';
      const filaVenta = (v) => fila(v, ['numero', 'fecha', 'total', 'tipo_pago', 'estado', 'cliente_nombre', 'vendedor_nombre', 'resumen', 'moneda']);

      // Detalle de una venta concreta por su número.
      if (a.numero) {
        const n = String(a.numero).trim();
        const filaN = db.prepare('SELECT id FROM ventas WHERE numero = ?').get(n) || db.prepare('SELECT id FROM ventas WHERE numero LIKE ? ORDER BY id DESC LIMIT 1').get(`%${n}%`);
        if (!filaN) return { encontrada: false, nota: `Ninguna venta tiene el número "${n}". Revisa que esté bien escrito.` };
        const v = ventas.obtener(db, filaN.id);
        if (propio && v.vendedor_id !== u.id) return { encontrada: false, nota: 'Esa venta no está a tu nombre; solo puedes ver las tuyas.' };
        return {
          venta: {
            numero: v.numero, fecha: v.fecha, total: v.total, moneda: v.moneda, estado: v.estado, tipo_pago: v.tipo_pago,
            cliente: v.cliente_nombre, vendedor: v.vendedor_nombre, registrado_por: v.registrado_por_nombre,
            items: v.items.map((it) => fila(it, ['nombre_producto', 'cantidad', 'cantidad_devuelta', 'tarifa', 'precio_unitario', 'total', 'seriales'])),
            pagado: v.pagado, dinero_recibido: v.dinero_recibido,
            pagos: v.pagos.filter((p) => !p.anulado).map((p) => fila(p, ['fecha', 'tipo', 'metodo_pago', 'valor'])),
            credito: v.credito ? fila(v.credito, ['estado', 'saldo_financiado', 'saldo_actual', 'total_abonado', 'proximo_vencimiento']) : null,
            domicilio: v.domicilio_numero ? { numero: v.domicilio_numero, direccion: v.domicilio_direccion, cargo: v.cargo_domicilio } : null,
            total_devuelto: v.total_devuelto, devoluciones: v.devoluciones.length, resultado: v.resultado,
          },
        };
      }

      // Unidades y valor vendido de un producto o una categoría concreta (esté o no en lo más vendido).
      if (a.producto || a.categoria) {
        const like = `%${a.producto || ''}%`;
        const scope = propio ? [u.id] : [];
        const filas = db.prepare(`SELECT p.nombre, cat.nombre AS categoria, s.stock,
            COALESCE((SELECT SUM(vi.cantidad - vi.cantidad_devuelta) FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id WHERE vi.producto_id = p.id AND v.estado <> 'anulada' AND v.fecha BETWEEN ? AND ? ${propio ? 'AND v.vendedor_id = ?' : ''}), 0) AS unidades,
            COALESCE((SELECT SUM(vi.total) FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id WHERE vi.producto_id = p.id AND v.estado <> 'anulada' AND v.fecha BETWEEN ? AND ? ${propio ? 'AND v.vendedor_id = ?' : ''}), 0) AS total
          FROM productos p JOIN v_stock s ON s.producto_id = p.id LEFT JOIN categorias cat ON cat.id = p.categoria_id
          WHERE p.estado <> 'inactivo'
            ${a.producto ? 'AND (p.nombre LIKE ? OR p.marca LIKE ? OR p.referencia LIKE ? OR p.modelo_compatible LIKE ?)' : ''}
            ${a.categoria ? 'AND cat.nombre LIKE ?' : ''}
          GROUP BY p.id ${a.producto ? '' : 'HAVING unidades > 0'}
          ORDER BY unidades DESC, p.nombre LIMIT 25`)
          .all(...[d0(r.desde), d1(r.hasta), ...scope], ...[d0(r.desde), d1(r.hasta), ...scope], ...(a.producto ? [like, like, like, like] : []), ...(a.categoria ? [`%${a.categoria}%`] : []));
        const tot = db.prepare(`SELECT COALESCE(SUM(vi.cantidad - vi.cantidad_devuelta), 0) unidades, COALESCE(SUM(vi.total), 0) total, COUNT(DISTINCT v.id) ventas
          FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id JOIN productos p ON p.id = vi.producto_id LEFT JOIN categorias cat ON cat.id = p.categoria_id
          WHERE v.estado <> 'anulada' AND v.fecha BETWEEN ? AND ? ${propio ? 'AND v.vendedor_id = ?' : ''}
            ${a.producto ? 'AND (p.nombre LIKE ? OR p.marca LIKE ? OR p.referencia LIKE ? OR p.modelo_compatible LIKE ?)' : ''}
            ${a.categoria ? 'AND cat.nombre LIKE ?' : ''}`)
          .get(d0(r.desde), d1(r.hasta), ...scope, ...(a.producto ? [like, like, like, like] : []), ...(a.categoria ? [`%${a.categoria}%`] : []));
        return {
          alcance: propio ? 'propio' : 'todos', periodo: r,
          filtro: { producto: a.producto || null, categoria: a.categoria || null },
          total_unidades: tot.unidades, total_vendido: tot.total, ventas: tot.ventas, productos: filas,
          nota: !filas.length ? 'No hay ventas con ese filtro en el periodo (o ningún producto coincide).' : undefined,
        };
      }

      // Ventas que cumplen filtros de detalle (texto, cliente, vendedor, tipo de pago, estado, monto).
      if (a.q || a.cliente || a.vendedor || a.tipo_pago || a.estado || a.monto_minimo !== undefined) {
        let vendedorId = propio ? u.id : undefined;
        if (a.vendedor) {
          if (propio) return { nota: 'Solo puedes consultar tus propias ventas; no las de otro vendedor.' };
          const us = db.prepare('SELECT id, nombre FROM usuarios WHERE nombre LIKE ? LIMIT 5').all(`%${a.vendedor}%`);
          if (!us.length) return { nota: `Ningún usuario se llama "${a.vendedor}".` };
          if (us.length > 1) return { candidatos_vendedor: us.map((x) => x.nombre), nota: 'Hay varios con ese nombre; pregunta de nuevo con el nombre completo.' };
          vendedorId = us[0].id;
        }
        let clienteId;
        if (a.cliente) {
          const cl = db.prepare('SELECT id, nombre FROM clientes WHERE activo = 1 AND nombre LIKE ? LIMIT 6').all(`%${a.cliente}%`);
          if (!cl.length) return { nota: `Ningún cliente se llama "${a.cliente}".` };
          if (cl.length > 1) return { candidatos_cliente: cl.map((x) => x.nombre), nota: 'Hay varios clientes con ese nombre; pregunta de nuevo con el nombre completo.' };
          clienteId = cl[0].id;
        }
        const { ventas: lista, total } = ventas.listar(db, {
          desde: r.desde, hasta: r.hasta, q: a.q, cliente_id: clienteId, vendedor_id: vendedorId,
          tipo_pago: a.tipo_pago, estado: a.estado, limite: MAX_FILAS,
        });
        const filtradas = a.monto_minimo !== undefined ? lista.filter((v) => (v.total || 0) >= a.monto_minimo) : lista;
        return {
          alcance: propio ? 'propio' : 'todos', periodo: r,
          filtro: { q: a.q || null, cliente: a.cliente || null, vendedor: a.vendedor || null, tipo_pago: a.tipo_pago || null, estado: a.estado || null, monto_minimo: a.monto_minimo ?? null },
          total_encontradas: total, mostradas: filtradas.length, total_valor: filtradas.reduce((s, v) => s + (v.total || 0), 0),
          ventas: filtradas.slice(0, a.limite || 15).map(filaVenta),
          nota: !filtradas.length ? 'No hay ventas con esos filtros en el periodo.' : total > filtradas.length ? `Hay ${total} en total; mostré las primeras.` : undefined,
        };
      }

      if (propio) {
        const propias = comisiones.resumen(db, f, { alcance: 'propio', usuarioId: u.id });
        const { ventas: lista, total } = ventas.listar(db, { desde: r.desde, hasta: r.hasta, vendedor_id: u.id, limite: MAX_FILAS });
        return {
          alcance: 'propio', periodo: r, aviso: 'Solo se muestran las ventas de las que este usuario es responsable.',
          resumen: { ventas: total, ingreso_neto: propias.vendedor.ingreso_neto, ganancia_generada: propias.vendedor.ganancia, comision_estimada: propias.vendedor.comision, pendientes_cobro: propias.vendedor.pendientes_cobro },
          ventas: lista.map(filaVenta),
        };
      }
      const d = analitica.ventas(db, f, { verCostos: tiene(u, 'inventario.ver') });
      return {
        alcance: 'todos', periodo: d.periodo, periodo_anterior: d.anterior, resumen: d.resumen,
        por_tipo_pago: d.por_tipo_pago, por_vendedor: d.por_vendedor, metodos_pago: d.metodos_pago,
        mas_vendidos: (d.mas_vendidos || []).slice(0, 10),
        serie: d.serie && Array.isArray(d.serie.puntos) && d.serie.puntos.length <= MAX_FILAS ? d.serie : undefined,
      };
    },
  },
  {
    nombre: 'consultar_compras',
    descripcion: 'Compras a proveedores (las más recientes primero): número, fecha, proveedor, moneda, total, tasa de cambio aplicada y la TRM oficial registrada el día de la compra (trm_valor, trm_fecha). Úsala para preguntas como "¿cuál fue la TRM registrada en la última compra?" o "¿cuánto le debemos a un proveedor?".',
    parametros: { type: 'object', properties: { ...PROPS_PERIODO, proveedor: { type: 'string', maxLength: 80, description: 'Filtrar por nombre del proveedor o número de factura.' }, moneda: { type: 'string', enum: ['COP', 'USD'], description: 'Solo compras en esta moneda.' }, solo_con_saldo: { type: 'boolean', description: 'Solo compras con saldo pendiente al proveedor.' }, limite: { type: 'integer', minimum: 1, maximum: MAX_FILAS, description: 'Cantidad de compras a devolver (por defecto 10).' } }, required: [], additionalProperties: false },
    permitido: (u) => tiene(u, 'compras.ver'),
    requiere_confirmacion: false,
    ejecutar: (db, u, a) => {
      const filtros = { q: a.proveedor, moneda: a.moneda, con_saldo: a.solo_con_saldo, limite: a.limite || 10 };
      let rango = null;
      if (a.periodo || a.desde || a.hasta) { rango = analitica.rango(filtrosPeriodo(a)); filtros.desde = rango.desde; filtros.hasta = rango.hasta; }
      const { compras: lista, total } = compras.listar(db, filtros);
      const mapear = (c) => {
        const o = fila(c, ['id', 'numero', 'fecha', 'proveedor_nombre', 'numero_factura', 'estado', 'moneda', 'total', 'total_moneda', 'tasa_cambio', 'tasa_origen', 'valor_pagado', 'saldo_pendiente', 'saldo_pendiente_moneda', 'n_items']);
        // Columnas de TRM de referencia (las agrega el módulo de compras; se incluyen solo si existen en la fila).
        for (const k of ['trm_valor', 'trm_fecha', 'trm_vigencia_hasta', 'trm_fuente', 'trm_obtenida_en', 'trm_captura']) if (c[k] !== undefined && c[k] !== null) o[k] = c[k];
        if (c.moneda && c.moneda !== 'COP' && o.trm_valor === undefined) o.trm_nota = 'Esta compra no tiene TRM de referencia registrada; la tasa aplicada está en tasa_cambio.';
        return o;
      };
      return {
        periodo: rango, total_compras_encontradas: total, mostradas: lista.length,
        ultima_compra: lista.length ? mapear(lista[0]) : null,
        total_cop_mostradas: lista.reduce((s, c) => s + (c.total || 0), 0),
        compras: lista.map(mapear),
      };
    },
  },
  {
    nombre: 'consultar_trm',
    descripcion: 'TRM oficial del dólar vigente hoy (Superintendencia Financiera) y cotización de mercado, con fecha, variación frente al día anterior y estado de la conexión. Con `fecha` busca la TRM oficial, manual o de mercado registrada ese día (histórico). No sirve para la TRM de una compra específica: para eso usa consultar_compras.',
    parametros: { type: 'object', properties: { fecha: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Día concreto AAAA-MM-DD para la TRM o el mercado de esa fecha.' } }, required: [], additionalProperties: false },
    permitido: () => true,
    requiere_confirmacion: false,
    ejecutar: async (db, u, a) => {
      if (a && a.fecha) {
        const t = await trm.trmParaFecha(db, a.fecha);
        const manual = db.prepare("SELECT valor, fuente, nota FROM tasas_cambio WHERE tipo = 'manual' AND moneda = 'USD' AND fecha = ?").get(a.fecha) || null;
        const mercado = db.prepare("SELECT valor, vigencia_desde AS actualizado FROM tasas_cambio WHERE tipo = 'mercado' AND moneda = 'USD' AND fecha = ?").get(a.fecha) || null;
        return {
          fecha: a.fecha,
          trm: t ? fila(t, ['valor', 'fecha', 'vigencia_desde', 'vigencia_hasta', 'fuente', 'origen']) : null,
          manual, mercado,
          nota: !t && !manual && !mercado ? 'No hay tasa registrada para esa fecha.' : !t ? 'No hay TRM oficial para esa fecha; si hay tasa manual o de mercado va aparte.' : undefined,
        };
      }
      const r = await trm.resumen(db);
      return {
        hoy: r.hoy,
        trm: r.trm ? fila(r.trm, ['valor', 'fecha', 'vigencia_desde', 'vigencia_hasta', 'vigente_hoy', 'desactualizada', 'variacion', 'fuente']) : null,
        mercado: r.mercado ? fila(r.mercado, ['valor', 'fecha', 'actualizado', 'desactualizado', 'variacion', 'fuente']) : null,
        estado: { trm_conectado: r.estado.trm.conectado, trm_error: r.estado.trm.error, mercado_conectado: r.estado.mercado.conectado, mercado_error: r.estado.mercado.error, red_desactivada: r.estado.red_desactivada },
        nota: !r.trm && !r.mercado ? 'No hay ninguna tasa registrada todavía.' : undefined,
      };
    },
  },
  {
    nombre: 'consultar_inventario',
    descripcion: 'Productos y existencias: busca por nombre, referencia, marca o código, o lista los productos agotados y con pocas unidades. Incluye precio de venta; los costos solo si el usuario puede verlos.',
    parametros: { type: 'object', properties: { q: { type: 'string', maxLength: 80, description: 'Texto a buscar (nombre, referencia, marca, código de barras).' }, solo_bajo_stock: { type: 'boolean', description: 'Solo productos agotados o por debajo del stock mínimo.' }, limite: { type: 'integer', minimum: 1, maximum: MAX_FILAS, description: 'Cantidad máxima de productos (por defecto 20).' } }, required: [], additionalProperties: false },
    permitido: (u) => tiene(u, 'inventario.ver') || tiene(u, 'ventas.crear'),
    requiere_confirmacion: false,
    ejecutar: (db, u, a) => {
      const verCostos = tiene(u, 'inventario.ver');
      const lim = a.limite || 20;
      let lista; let total;
      if (a.solo_bajo_stock) {
        const ag = productos.listar(db, { q: a.q, agotados: true, limite: lim });
        const bj = productos.listar(db, { q: a.q, stock_bajo: true, limite: lim });
        lista = [...ag.productos, ...bj.productos].slice(0, lim); total = ag.total + bj.total;
      } else { const r = productos.listar(db, { q: a.q, limite: lim }); lista = r.productos; total = r.total; }
      const inv = dashboard.inventarioResumen(db);
      const claves = ['id', 'nombre', 'referencia', 'marca', 'categoria_nombre', 'stock', 'stock_minimo', 'precio_venta', 'estado', 'requiere_serial', ...(verCostos ? ['precio_compra', 'margen_pct'] : [])];
      return {
        resumen: { productos: inv.productos, unidades: inv.unidades, pocas_unidades: inv.pocas, agotados: inv.agotados, valor_venta: inv.valor_venta, valor_costo: verCostos ? inv.valor_costo : undefined },
        total_encontrados: total, mostrados: lista.length,
        productos: lista.map((p) => fila(p, claves)),
        nota: !lista.length ? 'Sin productos para ese criterio.' : undefined,
      };
    },
  },
  {
    nombre: 'consultar_caja',
    descripcion: 'Estado de la caja: si está abierta, desde cuándo y quién la abrió, base inicial, ingresos por método, gastos, efectivo esperado y ventas del turno. Si está cerrada, el último cierre y su diferencia. Con `fecha` devuelve las sesiones (aperturas y cierres) de ese día, p. ej. "¿cómo cerró la caja ayer?".',
    parametros: { type: 'object', properties: { fecha: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Día concreto AAAA-MM-DD: las aperturas y cierres de esa fecha.' } }, required: [], additionalProperties: false },
    permitido: (u) => tiene(u, 'caja.ver'),
    requiere_confirmacion: false,
    ejecutar: (db, u, a) => {
      if (a && a.fecha) {
        const sesiones = caja.historial(db, { limite: 200 }).filter((x) => String(x.abierta_en || '').slice(0, 10) === a.fecha || String(x.cerrada_en || '').slice(0, 10) === a.fecha);
        if (!sesiones.length) return { fecha: a.fecha, sesiones: [], nota: 'Ese día no hubo aperturas ni cierres de caja (o es muy antiguo).' };
        return {
          fecha: a.fecha,
          sesiones: sesiones.slice(0, 3).map((x) => {
            const d = caja.obtener(db, x.id);
            const r = d.resumen || {};
            return {
              estado: d.estado, abierta_en: d.abierta_en, cerrada_en: d.cerrada_en,
              usuario_apertura: d.usuario_apertura, usuario_cierre: d.usuario_cierre, base_inicial: d.base_inicial,
              efectivo_esperado: d.efectivo_esperado, efectivo_contado: d.efectivo_contado, diferencia: d.diferencia,
              resumen: fila(r, ['ingresos', 'total_ingresos', 'total_egresos', 'gastos', 'ventas_cobradas', 'abonos']),
            };
          }),
        };
      }
      const s = caja.sesionAbierta(db);
      if (!s) {
        const ult = caja.historial(db, { limite: 1 })[0] || null;
        return { abierta: false, ultimo_cierre: ult ? fila(ult, ['abierta_en', 'cerrada_en', 'base_inicial', 'efectivo_esperado', 'efectivo_contado', 'diferencia', 'usuario_apertura', 'usuario_cierre']) : null, nota: ult ? undefined : 'Nunca se ha abierto la caja.' };
      }
      const d = caja.obtener(db, s.id);
      const r = d.resumen || {};
      return {
        abierta: true, abierta_en: d.abierta_en, usuario_apertura: d.usuario_apertura, base_inicial: d.base_inicial,
        resumen: fila(r, ['ingresos', 'ventas_cobradas', 'abonos', 'pagos_proveedor', 'reintegros', 'gastos', 'domicilios', 'entradas', 'salidas', 'total_ingresos', 'total_egresos', 'ventas_facturadas', 'ventas_cantidad', 'ventas_a_credito', 'credito_otorgado', 'efectivo_esperado']),
        movimientos: (d.movimientos || []).slice(0, 10).map((m) => fila(m, ['fecha', 'tipo', 'valor', 'motivo', 'usuario_nombre'])),
        gastos: (d.gastos || []).slice(0, 10).map((g) => fila(g, ['fecha', 'categoria', 'descripcion', 'valor', 'metodo_pago'])),
      };
    },
  },
  {
    nombre: 'consultar_clientes',
    descripcion: 'Busca clientes por nombre, teléfono o cédula y devuelve su saldo pendiente, número de compras y última compra.',
    parametros: { type: 'object', properties: { q: { type: 'string', maxLength: 80, description: 'Nombre, teléfono o identificación (parcial).' }, limite: { type: 'integer', minimum: 1, maximum: MAX_FILAS, description: 'Cantidad máxima (por defecto 15).' } }, required: [], additionalProperties: false },
    permitido: (u) => tiene(u, 'clientes.ver'),
    requiere_confirmacion: false,
    ejecutar: (db, u, a) => {
      const q = a.q ? `%${a.q}%` : null;
      const lim = a.limite || 15;
      const filas = db.prepare(`SELECT c.id, c.nombre, c.telefono, c.identificacion, c.creado_en,
          (SELECT COALESCE(SUM(saldo_actual),0) FROM creditos cr WHERE cr.cliente_id = c.id AND cr.estado NOT IN ('pagado','anulado')) AS saldo_pendiente,
          (SELECT COUNT(*) FROM ventas v WHERE v.cliente_id = c.id AND v.estado <> 'anulada') AS n_ventas,
          (SELECT MAX(fecha) FROM ventas v WHERE v.cliente_id = c.id) AS ultima_compra
        FROM clientes c WHERE c.activo = 1 ${q ? 'AND (c.nombre LIKE ? OR c.telefono LIKE ? OR c.identificacion LIKE ?)' : ''} ORDER BY c.nombre LIMIT ?`).all(...(q ? [q, q, q] : []), lim);
      const total = db.prepare(`SELECT COUNT(*) n FROM clientes c WHERE c.activo = 1 ${q ? 'AND (c.nombre LIKE ? OR c.telefono LIKE ? OR c.identificacion LIKE ?)' : ''}`).get(...(q ? [q, q, q] : [])).n;
      return { total_encontrados: total, mostrados: filas.length, clientes: filas, nota: !filas.length ? 'Sin clientes para ese criterio.' : undefined };
    },
  },
  {
    nombre: 'consultar_creditos',
    descripcion: 'Créditos y cartera: créditos vigentes, vencidos, próximos a vencer o pagados, con cliente, saldo, próximo vencimiento y total abonado; además el resumen de cartera (pendiente por cobrar, vencido, clientes con deuda). Con `cliente` devuelve los créditos y los últimos abonos de esa persona.',
    parametros: { type: 'object', properties: { estado: { type: 'string', enum: ['vigentes', 'vencido', 'proximo', 'al_dia', 'parcial', 'pagado', 'todos'], description: 'Filtro de estado (por defecto vigentes).' }, cliente: { type: 'string', maxLength: 80, description: 'Nombre del cliente: sus créditos con cuotas y sus últimos abonos.' }, limite: { type: 'integer', minimum: 1, maximum: MAX_FILAS, description: 'Cantidad máxima (por defecto 20).' } }, required: [], additionalProperties: false },
    permitido: (u) => tiene(u, 'creditos.ver'),
    requiere_confirmacion: false,
    ejecutar: (db, u, a) => {
      if (a.cliente) {
        const cl = db.prepare('SELECT id, nombre, telefono FROM clientes WHERE activo = 1 AND nombre LIKE ? LIMIT 6').all(`%${a.cliente}%`);
        if (!cl.length) return { nota: `Ningún cliente coincide con "${a.cliente}".` };
        if (cl.length > 1) return { candidatos: cl.map((x) => fila(x, ['nombre', 'telefono'])), nota: 'Hay varios clientes con ese nombre; pregunta de nuevo con el nombre completo.' };
        const ec = creditos.estadoCuenta(db, cl[0].id);
        const est = a.estado && a.estado !== 'todos' ? a.estado : null;
        const lista = est ? ec.creditos.filter((c) => (est === 'vigentes' ? !['pagado', 'anulado'].includes(c.estado) : c.estado === est)) : ec.creditos;
        return {
          cliente: fila(cl[0], ['id', 'nombre', 'telefono']), saldo_total: ec.saldo_total, total_creditos: ec.creditos.length,
          creditos: lista.slice(0, 10).map((c) => ({
            ...fila(c, ['numero', 'estado', 'saldo_actual', 'saldo_financiado', 'total_abonado', 'proximo_vencimiento', 'venta_numero', 'moneda']),
            cuotas: (c.cuotas || []).slice(0, 8).map((q) => fila(q, ['numero', 'valor', 'fecha_vencimiento', 'estado'])),
          })),
          abonos: (ec.abonos || []).slice(0, 10).map((x) => fila(x, ['fecha', 'valor', 'metodo_pago', 'credito_numero'])),
          nota: !lista.length ? 'Este cliente no tiene créditos con ese estado.' : undefined,
        };
      }
      const estado = a.estado && a.estado !== 'todos' ? a.estado : (a.estado === 'todos' ? undefined : 'vigentes');
      const lista = creditos.listar(db, { estado, limite: a.limite || 20 });
      return {
        cartera: analitica.cartera(db),
        filtro: estado || 'todos', mostrados: lista.length,
        creditos: lista.map((c) => fila(c, ['numero', 'cliente_nombre', 'cliente_telefono', 'estado', 'saldo_actual', 'saldo_financiado', 'total_abonado', 'proximo_vencimiento', 'venta_numero', 'moneda', 'saldo_moneda'])),
        nota: !lista.length ? 'Sin créditos con ese filtro.' : undefined,
      };
    },
  },
  {
    nombre: 'consultar_rentabilidad',
    descripcion: 'Rentabilidad y comisiones del periodo: ganancia operativa por responsable (vendedor/empleador), comisiones, salarios, resultado del negocio y, si el usuario puede ver contabilidad, ingresos, costos, gastos y utilidad. Un vendedor solo puede consultar lo propio (alcance "propio").',
    parametros: { type: 'object', properties: { ...PROPS_PERIODO, alcance: { type: 'string', enum: ['todos', 'propio'], description: '"todos" = todo el negocio (requiere permiso); "propio" = solo las ventas y comisiones del usuario.' } }, required: [], additionalProperties: false },
    permitido: (u) => esGlobalComisiones(u) || tiene(u, 'contabilidad.ver') || tiene(u, 'comisiones.ver_propias'),
    requiere_confirmacion: false,
    ejecutar: (db, u, a) => {
      const f = filtrosPeriodo(a);
      const global = esGlobalComisiones(u) || tiene(u, 'contabilidad.ver');
      if (a.alcance === 'todos' && !global) throw sinPermiso('ver la rentabilidad global del negocio; solo puede consultar sus propias ventas y comisiones (alcance "propio")');
      if (!global || a.alcance === 'propio') {
        if (!tiene(u, 'comisiones.ver_propias') && !global) throw sinPermiso('ver rentabilidad ni comisiones');
        const r = comisiones.resumen(db, f, { alcance: 'propio', usuarioId: u.id });
        return {
          alcance: 'propio', periodo: r.periodo, salario_general: r.salario_general, salarios_en_resultado: r.salarios_en_resultado,
          resumen: r.vendedor, responsables: r.responsables.map((x) => fila(x, ['nombre', 'tipo', 'ventas', 'ingreso_neto', 'ganancia', 'ganancia_comisionable', 'comision', 'comision_pct', 'salario_base', 'salario_periodo', 'total_remuneracion', 'pendientes_cobro'])),
          ventas: r.ventas.slice(0, 20).map((v) => fila(v, ['numero', 'fecha', 'cliente', 'resumen', 'ingreso_neto', 'ganancia_operativa', 'comision', 'estado_pago'])),
          avisos: r.avisos,
        };
      }
      const r = esGlobalComisiones(u) ? comisiones.resumen(db, f, { alcance: 'todos' }) : null;
      const fin = tiene(u, 'contabilidad.ver') ? analitica.finanzas(db, f) : null;
      return {
        alcance: 'todos', periodo: r ? r.periodo : fin.periodo,
        comisiones: r ? { vendedor: r.vendedor, empleador: r.empleador, sin_asignar: r.sin_asignar, negocio: r.negocio, salarios_en_resultado: r.salarios_en_resultado, responsables: r.responsables.slice(0, 15).map((x) => fila(x, ['nombre', 'tipo', 'ventas', 'ingreso_neto', 'ganancia', 'comision', 'comision_pct', 'salario_periodo', 'total_remuneracion', 'pendientes_cobro'])), avisos: r.avisos, criterios: r.criterios } : undefined,
        finanzas: fin ? { resumen: fila(fin.resumen, ['ingresos', 'facturado', 'devoluciones', 'costo_vendido', 'ganancia_bruta', 'margen_pct', 'gastos', 'utilidad', 'recibido', 'compras', 'pagos_proveedor', 'variacion']), cartera: fin.cartera, gastos_por_categoria: (fin.gastos_por_categoria || []).slice(0, 10) } : undefined,
      };
    },
  },
  {
    nombre: 'consultar_marketing',
    descripcion: 'Marketing: panel del periodo (inversión, clientes potenciales, ventas atribuidas, resultado), lista de campañas, rentabilidad por campaña o resumen de clientes potenciales (leads). Quien solo atiende leads puede pedir únicamente "leads".',
    parametros: { type: 'object', properties: { ...PROPS_PERIODO, que: { type: 'string', enum: ['panel', 'campanas', 'rentabilidad', 'leads'], description: 'Qué consultar (por defecto panel).' } }, required: [], additionalProperties: false },
    permitido: (u) => tiene(u, 'marketing.ver') || tiene(u, 'marketing.leads'),
    requiere_confirmacion: false,
    ejecutar: (db, u, a) => {
      const que = a.que || (tiene(u, 'marketing.ver') ? 'panel' : 'leads');
      if (que !== 'leads' && !tiene(u, 'marketing.ver')) throw sinPermiso('ver campañas ni resultados de marketing; solo puede consultar los clientes potenciales (que = "leads")');
      const f = filtrosPeriodo(a);
      let mk;
      try { mk = require('../marketing'); } catch { return { disponible: false, mensaje: 'Módulo de marketing no disponible' }; }
      const fn = { panel: 'panel', campanas: 'listarCampanas', rentabilidad: 'rentabilidad', leads: 'resumenLeads' }[que];
      if (!mk || typeof mk[fn] !== 'function') return { disponible: false, mensaje: 'Módulo de marketing no disponible (función ' + fn + ' no implementada todavía)' };
      try {
        // Las campañas también llevan el periodo pedido: sin él, listarCampanas calcula inversión/ventas/ROAS sobre todo el historial.
        const datos = que === 'campanas' ? mk.listarCampanas(db, { estado: 'todas', periodo: f.periodo, desde: f.desde, hasta: f.hasta }) : que === 'panel' ? mk.panel(db, f) : que === 'rentabilidad' ? mk.rentabilidad(db, f) : mk.resumenLeads(db, f);
        return { disponible: true, que, periodo: f, datos: datos === undefined ? null : datos };
      } catch (e) {
        // Igual que ejecutar(): los errores con texto para el usuario (4xx) se transmiten; los internos van al registro del servidor.
        if (e && e.status && e.status < 500) return { disponible: false, mensaje: 'Módulo de marketing: ' + e.message };
        console.error('[asistente herramienta] consultar_marketing', e);
        return { disponible: false, mensaje: 'Módulo de marketing no disponible por ahora; indícale al usuario que lo intente más tarde.' };
      }
    },
  },
  {
    nombre: 'consultar_pendientes',
    descripcion: 'Pendientes y alertas del usuario ordenados por urgencia: productos agotados, en el mínimo o que se acabarán pronto al ritmo de ventas actual, cuotas vencidas y por vencer, facturas por pagar a proveedores, documentos por revisar, domicilios por despachar o atrasados y estado de la caja. Incluye el resumen de ventas del día. Úsala para "¿qué tengo pendiente?", "¿qué se va a acabar?", "resumen del día".',
    parametros: { type: 'object', properties: {}, required: [], additionalProperties: false },
    permitido: () => true,
    requiere_confirmacion: false,
    ejecutar: (db, u) => {
      const r = avisos().resumen(db, u);
      return { resumen_del_dia: r.lineas, conteo: r.conteo, avisos: r.avisos.map((a) => ({ nivel: a.nivel, titulo: a.titulo, detalle: a.detalle, pantalla: a.href, items: a.items, nota: a.nota })) };
    },
  },
  {
    nombre: 'consultar_ventas_producto',
    descripcion: 'Unidades vendidas de productos específicos en un periodo (por nombre, marca o referencia), con el valor vendido y el stock que queda. Úsala para "¿cuántas botellas de Old Parr se vendieron este mes?" o "¿cuántas Águila vendimos en diciembre?". Un vendedor sin permiso de ventas globales solo ve las suyas.',
    parametros: { type: 'object', properties: { ...PROPS_PERIODO, q: { type: 'string', maxLength: 80, description: 'Producto a buscar (nombre, marca, referencia).' } }, required: ['q'], additionalProperties: false },
    permitido: (u) => tiene(u, 'ventas.ver') || tiene(u, 'comisiones.ver_propias'),
    requiere_confirmacion: false,
    ejecutar: (db, u, a) => {
      const r = analitica.rango(filtrosPeriodo(a));
      const global = tiene(u, 'ventas.ver');
      const like = `%${a.q}%`;
      const filas = db.prepare(`SELECT p.id, p.nombre, s.stock,
          COALESCE((SELECT SUM(vi.cantidad - vi.cantidad_devuelta) FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id WHERE vi.producto_id = p.id AND v.estado <> 'anulada' AND v.fecha BETWEEN ? AND ? ${global ? '' : 'AND v.vendedor_id = ?'}), 0) AS unidades,
          COALESCE((SELECT SUM(vi.total) FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id WHERE vi.producto_id = p.id AND v.estado <> 'anulada' AND v.fecha BETWEEN ? AND ? ${global ? '' : 'AND v.vendedor_id = ?'}), 0) AS total
        FROM productos p JOIN v_stock s ON s.producto_id = p.id
        WHERE p.estado <> 'inactivo' AND (p.nombre LIKE ? OR p.marca LIKE ? OR p.referencia LIKE ? OR p.modelo_compatible LIKE ?)
        ORDER BY unidades DESC, p.nombre LIMIT ?`).all(...[r.desde + ' 00:00:00', r.hasta + ' 23:59:59', ...(global ? [] : [u.id])], ...[r.desde + ' 00:00:00', r.hasta + ' 23:59:59', ...(global ? [] : [u.id])], like, like, like, like, MAX_FILAS);
      return { periodo: r, alcance: global ? 'todos' : 'propio', productos: filas, total_unidades: filas.reduce((x, f) => x + f.unidades, 0), total_vendido: filas.reduce((x, f) => x + f.total, 0), nota: filas.length ? undefined : 'Ningún producto coincide con ese texto.' };
    },
  },
  {
    nombre: 'consultar_domicilios',
    descripcion: 'Domicilios de la flota propia: resumen del día (por despachar, en camino, entregados, atrasados, tiempo promedio de entrega, envíos cobrados) y del mes, carga por repartidor, y la lista filtrada por estado o por texto (número, cliente, teléfono, dirección o barrio).',
    parametros: { type: 'object', properties: {
      ...PROPS_PERIODO,
      estado: { type: 'string', enum: ['abiertos', 'recibido', 'en_preparacion', 'en_camino', 'entregado', 'cancelado', 'todos'], description: '"abiertos" = los que no se han entregado ni cancelado (por defecto).' },
      q: { type: 'string', maxLength: 80, description: 'Busca por número de domicilio, cliente, teléfono, dirección o barrio.' },
      limite: { type: 'integer', minimum: 1, maximum: MAX_FILAS, description: 'Cantidad máxima (por defecto 15).' },
    }, required: [], additionalProperties: false },
    permitido: (u) => tiene(u, 'domicilios.ver'),
    requiere_confirmacion: false,
    ejecutar: (db, u, a) => {
      const filtros = { limite: a.limite || 15, estado: a.estado === 'todos' ? undefined : (a.estado || 'abiertos'), q: a.q };
      let periodo = null;
      if (a.periodo || a.desde || a.hasta) { periodo = analitica.rango(filtrosPeriodo(a)); filtros.desde = periodo.desde; filtros.hasta = periodo.hasta; }
      const lista = domicilios.listar(db, filtros);
      const r = domicilios.resumen(db);
      return {
        periodo,
        resumen: { por_despachar: r.por_despachar, en_camino: r.en_camino, atrasados: r.atrasados.length, hoy: r.hoy, mes: r.mes },
        repartidores: r.repartidores.map((x) => fila(x, ['nombre', 'vehiculo', 'placa', 'en_camino', 'entregados_hoy'])),
        domicilios: lista.map((d) => fila(d, ['numero', 'estado', 'fecha', 'cliente_nombre', 'barrio', 'direccion', 'resumen', 'total', 'cargo_envio', 'metodo_pago', 'repartidor_nombre', 'minutos', 'atrasado', 'minutos_entrega', 'venta_numero'])),
        nota: !lista.length ? 'No hay domicilios con ese filtro.' : undefined,
      };
    },
  },
  {
    nombre: 'guia_de_uso',
    descripcion: 'Pasos para hacer un proceso en la aplicación (registrar una compra, hacer una venta, precio mayorista, tomar y despachar un domicilio, cobrar un crédito, abrir o cerrar caja, rentabilidad de una campaña, crear una campaña, registrar un cliente potencial, exportar reportes, configurar usuarios, crear productos, devoluciones). Devuelve el texto de la guía y la pantalla a la que se puede llevar al usuario.',
    parametros: { type: 'object', properties: { tema: { type: 'string', maxLength: 120, description: 'Tema o proceso en palabras del usuario, p. ej. "registrar compra", "cerrar caja", "tomar domicilio".' } }, required: ['tema'], additionalProperties: false },
    permitido: () => true,
    requiere_confirmacion: false,
    ejecutar: (db, u, a) => guia.guia(a.tema),
  },
  {
    nombre: 'navegar',
    descripcion: 'Prepara un botón para llevar al usuario a una pantalla de la aplicación (no cambia nada en el servidor). Úsala cuando el usuario pida ir a algún lugar ("llévame a compras") o cuando convenga ofrecer el acceso directo tras una guía. Rutas válidas: ' + Object.keys(RUTAS).join(', ') + '.',
    parametros: { type: 'object', properties: { ruta: { type: 'string', maxLength: 60, description: 'Ruta de la pantalla, p. ej. "#/compras/nueva".' }, filtros: { type: 'object', description: 'Filtros opcionales para la pantalla como pares clave/valor cortos (p. ej. { "estado": "vencido" }).', additionalProperties: { type: ['string', 'number', 'boolean'] } } }, required: ['ruta'], additionalProperties: false },
    permitido: () => true,
    requiere_confirmacion: false,
    ejecutar: (db, u, a) => {
      let ruta = String(a.ruta || '').trim();
      if (!ruta.startsWith('#')) ruta = '#' + (ruta.startsWith('/') ? '' : '/') + ruta;
      ruta = ruta.split('?')[0].replace(/\/+$/, '');
      if (!RUTAS[ruta]) throw new ErrorHerramienta(`Ruta desconocida: ${ruta}. Rutas válidas: ${Object.keys(RUTAS).join(', ')}`);
      const params = new URLSearchParams();
      if (a.filtros && typeof a.filtros === 'object') {
        for (const [k, v] of Object.entries(a.filtros).slice(0, 6)) {
          if (!/^[a-z_][a-z0-9_]{0,29}$/.test(k)) continue;
          if (!['string', 'number', 'boolean'].includes(typeof v)) continue;
          params.set(k, String(v).slice(0, 60));
        }
      }
      const qs = params.toString();
      const hash = ruta + (qs ? '?' + qs : '');
      const etiqueta = RUTAS[ruta];
      return { __accion: { tipo: 'navegar', hash, etiqueta }, mensaje: `Botón listo para ir a ${etiqueta} (${hash}). El usuario debe tocarlo; no asumas que ya navegó.` };
    },
  },
];

// Definiciones en formato neutro para el proveedor (solo las que el usuario puede usar).
function definiciones(usuario) {
  return HERRAMIENTAS.filter((h) => h.permitido(usuario)).map((h) => ({ nombre: h.nombre, descripcion: h.descripcion, parametros: h.parametros }));
}
function obtener(nombre) { return HERRAMIENTAS.find((h) => h.nombre === nombre) || null; }

// Ejecuta una herramienta con validación y permisos. Nunca lanza: devuelve { ok, datos | error, accion? }.
async function ejecutar(db, usuario, nombre, argumentos) {
  const h = obtener(nombre);
  if (!h) return { ok: false, error: `La herramienta ${nombre} no existe` };
  if (!h.permitido(usuario)) return { ok: false, error: `Sin permiso: el usuario no puede usar ${nombre}. Díselo con claridad y no inventes datos.` };
  if (h.requiere_confirmacion) return { ok: false, error: `${nombre} requiere confirmación del usuario y aún no está habilitada.` };
  let args;
  try { args = validarArgs(h.parametros, argumentos); } catch (e) { return { ok: false, error: e.message }; }
  try {
    const r = await h.ejecutar(db, usuario, args);
    let accion = null;
    let datos = r;
    if (r && typeof r === 'object' && r.__accion) { accion = r.__accion; datos = { ...r }; delete datos.__accion; }
    return { ok: true, datos: acotar(datos), accion };
  } catch (e) {
    if (e instanceof ErrorHerramienta) return { ok: false, error: e.message };
    if (e && e.status && e.status < 500) return { ok: false, error: e.message };
    console.error('[asistente herramienta]', nombre, e);
    return { ok: false, error: 'La consulta falló en el servidor; indícale al usuario que lo intente de nuevo más tarde.' };
  }
}

module.exports = { HERRAMIENTAS, RUTAS, definiciones, obtener, ejecutar, validarArgs, acotar, ErrorHerramienta, MAX_FILAS, MAX_BYTES };
