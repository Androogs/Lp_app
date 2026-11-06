'use strict';
// Catálogo de productos, categorías, fotos e historial de precios.
const { transaccion, siguienteNumero } = require('../db');
const { err, ahora, hoy, entero, texto, booleano, opcion } = require('../util');
const { tiene } = require('../permisos');
const auditoria = require('./auditoria');
const inventario = require('./inventario');

// Categorías y subcategorías de la licorera (mismo orden y nombres del catálogo web de Licores Palmira).
const ARBOL_CATEGORIAS = [
  ['Whisky', ['Escocés', 'Single malt', 'Irlandés', 'Bourbon y Tennessee']],
  ['Aguardiente', ['Sin azúcar', 'Tradicional', 'Garrafas', 'Premium']],
  ['Ron', ['Añejo', 'Blanco', 'Premium']],
  ['Tequila y mezcal', ['Blanco', 'Reposado', 'Añejo', 'Cristalino', 'Mezcal']],
  ['Vodka', ['Clásico', 'Saborizado', 'Premium']],
  ['Ginebra', ['London Dry', 'Premium', 'Pink']],
  ['Vinos y espumosos', ['Tinto', 'Blanco', 'Rosado', 'Espumoso', 'Champagne']],
  ['Cervezas', ['Nacional', 'Importada']],
  ['Cremas y licores', ['Crema de whisky', 'Sabajón', 'Piña colada', 'Licor de café']],
  ['Brandy y cognac', ['Brandy', 'Cognac']],
  ['Coctelería y mezcladores', ['Aperitivos', 'Licores de cóctel', 'Listos para tomar', 'Pisco']],
  ['Bebidas y energizantes', ['Gaseosas', 'Aguas', 'Tónicas y mezcladores', 'Energizantes', 'Hidratantes']],
  ['Snacks y pasabocas', ['Papas', 'Maní', 'Chocolates', 'Mix']],
  ['Cigarrillos', []],
  ['Vaporizadores', []],
  ['Desechables y hielo', ['Vasos', 'Hielo', 'Servilletas y más']],
  ['Anchetas y regalos', ['Con whisky', 'Con cremas', 'Con aguardiente']],
];
const CATEGORIAS_BASE = ARBOL_CATEGORIAS.map(([nombre]) => nombre);
const ESTADOS = ['activo', 'agotado', 'descontinuado', 'inactivo'];

function asegurarCategorias(db) {
  const n = db.prepare('SELECT COUNT(*) n FROM categorias').get().n;
  if (n > 0) return;
  const ins = db.prepare('INSERT INTO categorias(nombre, padre_id, orden) VALUES (?, ?, ?)');
  ARBOL_CATEGORIAS.forEach(([nombre, subs], i) => {
    const padre = Number(ins.run(nombre, null, i).lastInsertRowid);
    subs.forEach((sub, j) => ins.run(sub, padre, j));
  });
}

function categorias(db) {
  return db.prepare('SELECT * FROM categorias WHERE activo = 1 ORDER BY padre_id IS NOT NULL, orden, nombre').all();
}
function crearCategoria(db, datos, usuario) {
  const nombre = texto(datos.nombre, 'Nombre de la categoría', { max: 80 });
  const padre = datos.padre_id ? entero(datos.padre_id, 'Categoría padre') : null;
  const r = db.prepare('INSERT INTO categorias(nombre, padre_id, orden) VALUES (?,?, (SELECT COALESCE(MAX(orden),0)+1 FROM categorias))').run(nombre, padre);
  auditoria.registrar(db, usuario, 'crear_categoria', 'categoria', Number(r.lastInsertRowid), { nombre });
  return db.prepare('SELECT * FROM categorias WHERE id = ?').get(Number(r.lastInsertRowid));
}
function actualizarCategoria(db, id, datos, usuario) {
  const c = db.prepare('SELECT * FROM categorias WHERE id = ?').get(id);
  if (!c) throw err.noEncontrado('Categoría no existe');
  const nombre = texto(datos.nombre ?? c.nombre, 'Nombre', { max: 80 });
  const activo = datos.activo === undefined ? c.activo : (booleano(datos.activo) ? 1 : 0);
  db.prepare('UPDATE categorias SET nombre = ?, activo = ? WHERE id = ?').run(nombre, activo, id);
  auditoria.registrar(db, usuario, 'editar_categoria', 'categoria', id, { nombre, activo });
  return db.prepare('SELECT * FROM categorias WHERE id = ?').get(id);
}

function validarDatos(db, datos, existente) {
  const d = {};
  d.nombre = texto(datos.nombre ?? existente?.nombre, 'Nombre del producto', { max: 160 });
  d.categoria_id = datos.categoria_id === undefined ? (existente?.categoria_id ?? null) : (datos.categoria_id ? entero(datos.categoria_id, 'Categoría') : null);
  d.subcategoria_id = datos.subcategoria_id === undefined ? (existente?.subcategoria_id ?? null) : (datos.subcategoria_id ? entero(datos.subcategoria_id, 'Subcategoría') : null);
  for (const campo of ['marca', 'modelo_compatible', 'referencia', 'color', 'capacidad', 'codigo_barras', 'descripcion', 'ubicacion']) {
    d[campo] = datos[campo] === undefined ? (existente?.[campo] ?? null) : texto(datos[campo], campo, { opcional: true, max: campo === 'descripcion' ? 2000 : 120 });
  }
  d.sku = datos.sku === undefined ? (existente?.sku ?? null) : texto(datos.sku, 'SKU', { opcional: true, max: 60 });
  d.requiere_serial = datos.requiere_serial === undefined ? (existente?.requiere_serial ?? 0) : (booleano(datos.requiere_serial) ? 1 : 0);
  d.stock_minimo = entero(datos.stock_minimo ?? existente?.stock_minimo ?? 0, 'Stock mínimo', { min: 0, opcional: true, defecto: 0 });
  d.precio_venta = entero(datos.precio_venta ?? existente?.precio_venta ?? 0, 'Precio de venta', { min: 0, opcional: true, defecto: 0 });
  d.precio_compra = entero(datos.precio_compra ?? existente?.precio_compra ?? 0, 'Precio de compra', { min: 0, opcional: true, defecto: 0 });
  d.precio_mayor = entero(datos.precio_mayor ?? existente?.precio_mayor ?? 0, 'Precio al por mayor', { min: 0, opcional: true, defecto: 0 });
  if (d.precio_mayor > 0 && d.precio_venta > 0 && d.precio_mayor > d.precio_venta) throw err.datos('El precio al por mayor no puede ser mayor que el precio al detal');
  d.estado = opcion(datos.estado ?? existente?.estado ?? 'activo', 'Estado', ESTADOS);
  d.fecha_ingreso = datos.fecha_ingreso || existente?.fecha_ingreso || hoy();
  if (d.codigo_barras) {
    const otro = db.prepare('SELECT id, nombre FROM productos WHERE codigo_barras = ? AND id <> ?').get(d.codigo_barras, existente?.id || 0);
    if (otro) throw err.conflicto(`El código de barras ya está asignado a "${otro.nombre}"`);
  }
  if (d.sku) {
    const otro = db.prepare('SELECT id, nombre FROM productos WHERE sku = ? AND id <> ?').get(d.sku, existente?.id || 0);
    if (otro) throw err.conflicto(`El SKU ya está asignado a "${otro.nombre}"`);
  }
  return d;
}

function crear(db, datos, usuario) {
  if (!tiene(usuario, 'inventario.editar')) throw err.prohibido('No tienes permiso para crear productos');
  return transaccion(db, () => {
    const d = validarDatos(db, datos, null);
    if (!d.sku) d.sku = siguienteNumero(db, 'sku', 'SKU');
    const r = db.prepare(`INSERT INTO productos(nombre, categoria_id, subcategoria_id, marca, modelo_compatible, referencia, color, capacidad, codigo_barras, sku, requiere_serial, descripcion, ubicacion, stock_minimo, precio_compra, precio_venta, precio_mayor, estado, fecha_ingreso, actualizado_en)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(d.nombre, d.categoria_id, d.subcategoria_id, d.marca, d.modelo_compatible, d.referencia, d.color, d.capacidad, d.codigo_barras, d.sku, d.requiere_serial, d.descripcion, d.ubicacion, d.stock_minimo, d.precio_compra, d.precio_venta, d.precio_mayor, d.estado, d.fecha_ingreso, ahora());
    const id = Number(r.lastInsertRowid);
    db.prepare("INSERT INTO historial_precios(producto_id, tipo, precio_anterior, precio_nuevo, usuario_id, usuario_nombre, motivo) VALUES (?,'venta',NULL,?,?,?,'Creación del producto')").run(id, d.precio_venta, usuario.id, usuario.nombre);
    // Stock inicial opcional (crea un lote con el costo indicado).
    const stockInicial = entero(datos.stock_inicial, 'Stock inicial', { min: 0, opcional: true, defecto: 0 });
    if (stockInicial > 0) {
      inventario.crearLote(db, { producto_id: id, fecha: hoy(), cantidad: stockInicial, costo_unitario: d.precio_compra, origen: 'inicial', tipo_movimiento: 'inicial', referencia_tipo: 'inicial', nota: 'Inventario inicial' }, usuario);
    }
    if (datos.proveedor_id) {
      // vínculo informativo producto-proveedor a través del último costo
    }
    auditoria.registrar(db, usuario, 'crear_producto', 'producto', id, { nombre: d.nombre, precio_venta: d.precio_venta, precio_mayor: d.precio_mayor });
    return obtener(db, id);
  });
}

function actualizar(db, id, datos, usuario) {
  const existente = db.prepare('SELECT * FROM productos WHERE id = ?').get(id);
  if (!existente) throw err.noEncontrado('Producto no existe');
  if (!tiene(usuario, 'inventario.editar') && !tiene(usuario, 'inventario.cambiar_precio')) throw err.prohibido('No tienes permiso para editar productos');
  return transaccion(db, () => {
    const d = validarDatos(db, datos, existente);
    if (d.precio_venta !== existente.precio_venta) {
      if (!tiene(usuario, 'inventario.cambiar_precio')) throw err.prohibido('No tienes permiso para cambiar el precio de venta');
      db.prepare("INSERT INTO historial_precios(producto_id, tipo, precio_anterior, precio_nuevo, usuario_id, usuario_nombre, motivo) VALUES (?,'venta',?,?,?,?,?)")
        .run(id, existente.precio_venta, d.precio_venta, usuario.id, usuario.nombre, datos.motivo_precio || 'Cambio de precio de venta');
    }
    if (d.precio_mayor !== existente.precio_mayor) {
      if (!tiene(usuario, 'inventario.cambiar_precio')) throw err.prohibido('No tienes permiso para cambiar el precio al por mayor');
      db.prepare("INSERT INTO historial_precios(producto_id, tipo, precio_anterior, precio_nuevo, usuario_id, usuario_nombre, motivo) VALUES (?,'mayor',?,?,?,?,?)")
        .run(id, existente.precio_mayor, d.precio_mayor, usuario.id, usuario.nombre, datos.motivo_precio || 'Cambio de precio al por mayor');
    }
    if (d.precio_compra !== existente.precio_compra) {
      if (!tiene(usuario, 'inventario.cambiar_costo')) throw err.prohibido('No tienes permiso para cambiar el costo de referencia');
      db.prepare("INSERT INTO historial_precios(producto_id, tipo, precio_anterior, precio_nuevo, usuario_id, usuario_nombre, motivo) VALUES (?,'compra',?,?,?,?,?)")
        .run(id, existente.precio_compra, d.precio_compra, usuario.id, usuario.nombre, datos.motivo_precio || 'Cambio manual del costo de referencia (no afecta lotes existentes)');
    }
    db.prepare(`UPDATE productos SET nombre=?, categoria_id=?, subcategoria_id=?, marca=?, modelo_compatible=?, referencia=?, color=?, capacidad=?, codigo_barras=?, sku=?, requiere_serial=?, descripcion=?, ubicacion=?, stock_minimo=?, precio_compra=?, precio_venta=?, precio_mayor=?, estado=?, fecha_ingreso=?, actualizado_en=? WHERE id=?`)
      .run(d.nombre, d.categoria_id, d.subcategoria_id, d.marca, d.modelo_compatible, d.referencia, d.color, d.capacidad, d.codigo_barras, d.sku, d.requiere_serial, d.descripcion, d.ubicacion, d.stock_minimo, d.precio_compra, d.precio_venta, d.precio_mayor, d.estado, d.fecha_ingreso, ahora(), id);
    const cambios = {};
    for (const k of Object.keys(d)) if (d[k] !== existente[k]) cambios[k] = { antes: existente[k], despues: d[k] };
    auditoria.registrar(db, usuario, 'editar_producto', 'producto', id, cambios);
    return obtener(db, id);
  });
}

const SELECT_LISTA = `SELECT p.*, s.stock, s.valor_costo, c.nombre AS categoria_nombre, sc.nombre AS subcategoria_nombre,
  (SELECT ruta FROM producto_fotos f WHERE f.producto_id = p.id ORDER BY principal DESC, id LIMIT 1) AS foto,
  CASE WHEN p.precio_venta > 0 THEN ROUND((p.precio_venta - p.precio_compra) * 100.0 / p.precio_venta, 1) ELSE 0 END AS margen_pct
  FROM productos p JOIN v_stock s ON s.producto_id = p.id LEFT JOIN categorias c ON c.id = p.categoria_id LEFT JOIN categorias sc ON sc.id = p.subcategoria_id`;

function listar(db, { q, categoria_id, estado, stock_bajo, agotados, orden, limite = 100, pagina = 1 } = {}) {
  const cond = [];
  const params = [];
  if (q) {
    const like = `%${q.trim()}%`;
    cond.push('(p.nombre LIKE ? OR p.referencia LIKE ? OR p.marca LIKE ? OR p.modelo_compatible LIKE ? OR p.sku LIKE ? OR p.codigo_barras = ? OR p.capacidad LIKE ? OR c.nombre LIKE ?)');
    params.push(like, like, like, like, like, q.trim(), like, like);
  }
  if (categoria_id) { cond.push('(p.categoria_id = ? OR p.subcategoria_id = ?)'); params.push(categoria_id, categoria_id); }
  if (estado) { cond.push('p.estado = ?'); params.push(estado); }
  else cond.push("p.estado <> 'inactivo'");
  if (stock_bajo) cond.push('s.stock <= p.stock_minimo AND s.stock > 0');
  if (agotados) cond.push('s.stock <= 0');
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const lim = Math.min(Number(limite) || 100, 500);
  const off = (Math.max(Number(pagina) || 1, 1) - 1) * lim;
  // 'vendidos': lo que más rota en los últimos 30 días primero (vitrina del punto de venta y de los domicilios).
  const ordenSql = orden === 'vendidos'
    ? `(SELECT COALESCE(SUM(vi.cantidad),0) FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id WHERE vi.producto_id = p.id AND v.estado <> 'anulada' AND v.fecha >= datetime('now','localtime','-30 days')) DESC, s.stock > 0 DESC, p.nombre`
    : 'p.nombre';
  const filas = db.prepare(`${SELECT_LISTA} ${where} ORDER BY ${ordenSql} LIMIT ? OFFSET ?`).all(...params, lim, off);
  const total = db.prepare(`SELECT COUNT(*) n FROM productos p JOIN v_stock s ON s.producto_id = p.id LEFT JOIN categorias c ON c.id = p.categoria_id ${where}`).get(...params).n;
  return { productos: filas, total, pagina: Number(pagina) || 1, limite: lim };
}

function buscarPorCodigo(db, codigo) {
  const c = String(codigo || '').trim();
  if (!c) return null;
  let p = db.prepare(`${SELECT_LISTA} WHERE p.codigo_barras = ? OR p.sku = ?`).get(c, c);
  if (!p) {
    const lote = db.prepare("SELECT producto_id FROM lotes WHERE serial = ? AND cantidad_restante > 0 AND estado <> 'anulado'").get(c);
    if (lote) { p = obtener(db, lote.producto_id); p.serial_encontrado = c; }
  }
  return p || null;
}

function obtener(db, id) {
  const p = db.prepare(`${SELECT_LISTA} WHERE p.id = ?`).get(id);
  if (!p) throw err.noEncontrado('Producto no existe');
  p.fotos = db.prepare('SELECT * FROM producto_fotos WHERE producto_id = ? ORDER BY principal DESC, id').all(id);
  p.lotes = inventario.lotesDe(db, id);
  p.historial_precios = db.prepare('SELECT * FROM historial_precios WHERE producto_id = ? ORDER BY id DESC LIMIT 50').all(id);
  p.proveedores = db.prepare(`SELECT pr.id, pr.nombre, MAX(l.fecha) AS ultima_fecha, COUNT(*) AS compras,
                              (SELECT costo_unitario FROM lotes l2 WHERE l2.producto_id = l.producto_id AND l2.proveedor_id = pr.id ORDER BY l2.fecha DESC, l2.id DESC LIMIT 1) AS ultimo_costo
                              FROM lotes l JOIN proveedores pr ON pr.id = l.proveedor_id WHERE l.producto_id = ? AND l.origen = 'compra' GROUP BY pr.id ORDER BY ultima_fecha DESC`).all(id);
  p.ventas_resumen = db.prepare(`SELECT COALESCE(SUM(vi.cantidad - vi.cantidad_devuelta),0) AS unidades, COALESCE(SUM(vi.total),0) AS total, MAX(v.fecha) AS ultima_venta
                                 FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id WHERE vi.producto_id = ? AND v.estado <> 'anulada'`).get(id);
  return p;
}

function agregarFoto(db, id, archivo, usuario) {
  if (!tiene(usuario, 'inventario.editar')) throw err.prohibido();
  const existe = db.prepare('SELECT COUNT(*) n FROM producto_fotos WHERE producto_id = ?').get(id).n;
  const r = db.prepare('INSERT INTO producto_fotos(producto_id, ruta, principal) VALUES (?,?,?)').run(id, archivo.ruta, existe ? 0 : 1);
  return db.prepare('SELECT * FROM producto_fotos WHERE id = ?').get(Number(r.lastInsertRowid));
}
function eliminarFoto(db, id, fotoId, usuario) {
  if (!tiene(usuario, 'inventario.editar')) throw err.prohibido();
  const f = db.prepare('SELECT * FROM producto_fotos WHERE id = ? AND producto_id = ?').get(fotoId, id);
  if (!f) throw err.noEncontrado('Foto no existe');
  db.prepare('DELETE FROM producto_fotos WHERE id = ?').run(fotoId);
  return f;
}

function sinMovimiento(db, dias) {
  return db.prepare(`SELECT p.id, p.nombre, p.referencia, s.stock, s.valor_costo, p.precio_venta,
                       (SELECT MAX(v.fecha) FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id WHERE vi.producto_id = p.id AND v.estado <> 'anulada') AS ultima_venta
                     FROM productos p JOIN v_stock s ON s.producto_id = p.id
                     WHERE p.estado IN ('activo') AND s.stock > 0
                       AND (ultima_venta IS NULL OR ultima_venta < datetime('now','localtime', ?))
                     ORDER BY s.valor_costo DESC LIMIT 100`).all(`-${dias} days`);
}

module.exports = { CATEGORIAS_BASE, ARBOL_CATEGORIAS, ESTADOS, asegurarCategorias, categorias, crearCategoria, actualizarCategoria, crear, actualizar, listar, buscarPorCodigo, obtener, agregarFoto, eliminarFoto, sinMovimiento };
