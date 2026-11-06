-- =====================================================================================================================
-- Licores Palmira · Esquema de base de datos (SQLite 3, motor integrado node:sqlite).
-- Idempotente: todas las sentencias usan IF NOT EXISTS, por lo que el servidor lo aplica en cada arranque sin riesgo.
-- Fechas: TEXT en hora local 'YYYY-MM-DD HH:MM:SS' (o 'YYYY-MM-DD' para fechas sin hora).
-- Licorera: cada producto tiene precio al detal (precio_venta) y al por mayor (precio_mayor); la tarifa mayor se aplica
-- sola desde N unidades de una referencia (configuracion.unidades_mayor) o a los clientes marcados como mayoristas.
-- Dinero: INTEGER en pesos colombianos; montos en moneda extranjera (USD) como REAL con 2 decimales en columnas *_moneda.
-- =====================================================================================================================

-- ---------------------------------------------------------------- Seguridad y configuración
CREATE TABLE IF NOT EXISTS usuarios (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre             TEXT    NOT NULL,
  usuario            TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  email              TEXT,
  telefono           TEXT,
  password_hash      TEXT    NOT NULL,
  rol                TEXT    NOT NULL DEFAULT 'vendedor',
  activo             INTEGER NOT NULL DEFAULT 1,
  debe_cambiar_clave INTEGER NOT NULL DEFAULT 0,
  salario_mensual    INTEGER,
  comision_pct       REAL,
  tipo_comercial     TEXT,
  intentos_fallidos  INTEGER NOT NULL DEFAULT 0,
  bloqueado_hasta    TEXT,
  clave_cambiada_en  TEXT,
  ultimo_acceso      TEXT,
  creado_en          TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Sesiones: el token NUNCA se guarda en claro, solo su huella SHA-256. El token CSRF va ligado a la sesión.
CREATE TABLE IF NOT EXISTS sesiones (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT    NOT NULL UNIQUE,
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  csrf_token  TEXT    NOT NULL,
  creado_en   TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  ultimo_uso  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  expira_en   TEXT    NOT NULL,
  user_agent  TEXT,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS ix_sesiones_usuario ON sesiones(usuario_id);
CREATE INDEX IF NOT EXISTS ix_sesiones_expira  ON sesiones(expira_en);

-- Códigos de recuperación: se guarda la huella del código; tienen vencimiento y límite de intentos.
CREATE TABLE IF NOT EXISTS recuperacion_clave (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  codigo      TEXT,
  codigo_hash TEXT,
  expira_en   TEXT    NOT NULL,
  usado       INTEGER NOT NULL DEFAULT 0,
  intentos    INTEGER NOT NULL DEFAULT 0,
  creado_en   TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS ix_recuperacion_usuario ON recuperacion_clave(usuario_id);

CREATE TABLE IF NOT EXISTS configuracion (
  clave TEXT PRIMARY KEY,
  valor TEXT
);

CREATE TABLE IF NOT EXISTS contadores (
  nombre TEXT PRIMARY KEY,
  valor  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS auditoria (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  usuario_id     INTEGER,
  usuario_nombre TEXT,
  accion         TEXT NOT NULL,
  entidad        TEXT,
  entidad_id     TEXT,
  detalle        TEXT,
  ip             TEXT
);
CREATE INDEX IF NOT EXISTS ix_auditoria_fecha   ON auditoria(fecha);
CREATE INDEX IF NOT EXISTS ix_auditoria_entidad ON auditoria(entidad, entidad_id);

-- ---------------------------------------------------------------- Catálogo
CREATE TABLE IF NOT EXISTS categorias (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre    TEXT    NOT NULL,
  padre_id  INTEGER REFERENCES categorias(id),
  orden     INTEGER NOT NULL DEFAULT 0,
  activo    INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS productos (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre            TEXT    NOT NULL,
  categoria_id      INTEGER REFERENCES categorias(id),
  subcategoria_id   INTEGER REFERENCES categorias(id),
  marca             TEXT,
  modelo_compatible TEXT,              -- tipo / variedad: 12 años, reposado, tapa azul, single malt…
  referencia        TEXT,
  color             TEXT,
  capacidad         TEXT,              -- presentación: 750 ml, 1000 ml, lata 330 ml, x 50…
  codigo_barras     TEXT,
  sku               TEXT,
  requiere_serial   INTEGER NOT NULL DEFAULT 0,  -- controla cada unidad por serial o número de estampilla (ediciones especiales)
  descripcion       TEXT,
  ubicacion         TEXT,
  stock_minimo      INTEGER NOT NULL DEFAULT 0,
  precio_compra     INTEGER NOT NULL DEFAULT 0,
  precio_venta      INTEGER NOT NULL DEFAULT 0,  -- precio al detal
  precio_mayor      INTEGER NOT NULL DEFAULT 0,  -- precio al por mayor (0 = sin tarifa mayorista)
  estado            TEXT    NOT NULL DEFAULT 'activo',
  fecha_ingreso     TEXT,
  creado_en         TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  actualizado_en    TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_productos_nombre    ON productos(nombre);
CREATE INDEX IF NOT EXISTS ix_productos_categoria ON productos(categoria_id);
CREATE INDEX IF NOT EXISTS ix_productos_barras    ON productos(codigo_barras);
CREATE INDEX IF NOT EXISTS ix_productos_sku       ON productos(sku);

CREATE TABLE IF NOT EXISTS producto_fotos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  ruta        TEXT    NOT NULL,
  principal   INTEGER NOT NULL DEFAULT 0,
  creado_en   TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS ix_producto_fotos ON producto_fotos(producto_id);

CREATE TABLE IF NOT EXISTS historial_precios (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  producto_id     INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  fecha           TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  tipo            TEXT    NOT NULL,
  precio_anterior INTEGER,
  precio_nuevo    INTEGER,
  usuario_id      INTEGER,
  usuario_nombre  TEXT,
  motivo          TEXT
);
CREATE INDEX IF NOT EXISTS ix_historial_precios ON historial_precios(producto_id);

CREATE TABLE IF NOT EXISTS proveedores (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre         TEXT    NOT NULL,
  identificacion TEXT,
  telefono       TEXT,
  email          TEXT,
  direccion      TEXT,
  contacto       TEXT,
  notas          TEXT,
  activo         INTEGER NOT NULL DEFAULT 1,
  creado_en      TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS clientes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre            TEXT    NOT NULL,
  telefono          TEXT,
  identificacion    TEXT,
  email             TEXT,
  direccion         TEXT,
  notas             TEXT,
  tipo_cliente      TEXT    NOT NULL DEFAULT 'detal',  -- 'detal' | 'mayorista' (tiendas, bares, eventos: siempre precio mayor)
  barrio            TEXT,
  activo            INTEGER NOT NULL DEFAULT 1,
  origen_canal      TEXT,
  origen_campana_id INTEGER,
  origen_lead_id    INTEGER,
  creado_en         TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS ix_clientes_nombre   ON clientes(nombre);
CREATE INDEX IF NOT EXISTS ix_clientes_telefono ON clientes(telefono);

-- ---------------------------------------------------------------- Documentos (bandeja de facturas)
CREATE TABLE IF NOT EXISTS documentos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo       TEXT,
  origen     TEXT,
  ruta       TEXT    NOT NULL,
  mime       TEXT,
  nombre     TEXT,
  tamano     INTEGER,
  nota       TEXT,
  remitente  TEXT,
  usuario_id INTEGER,
  estado     TEXT    NOT NULL DEFAULT 'pendiente',
  datos_ocr  TEXT,
  ocr_estado TEXT,
  compra_id  INTEGER,
  creado_en  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS ix_documentos_estado ON documentos(estado);

-- ---------------------------------------------------------------- Compras e inventario por lotes
CREATE TABLE IF NOT EXISTS compras (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  numero                 TEXT    NOT NULL UNIQUE,
  proveedor_id           INTEGER REFERENCES proveedores(id),
  contacto               TEXT,
  fecha                  TEXT    NOT NULL,
  numero_factura         TEXT,
  subtotal               INTEGER NOT NULL DEFAULT 0,
  descuento              INTEGER NOT NULL DEFAULT 0,
  costos_adicionales     INTEGER NOT NULL DEFAULT 0,
  impuestos              INTEGER NOT NULL DEFAULT 0,
  total                  INTEGER NOT NULL DEFAULT 0,
  metodo_pago            TEXT,
  valor_pagado           INTEGER NOT NULL DEFAULT 0,
  saldo_pendiente        INTEGER NOT NULL DEFAULT 0,
  fecha_vencimiento      TEXT,
  notas                  TEXT,
  usuario_id             INTEGER,
  documento_id           INTEGER,
  estado                 TEXT    NOT NULL DEFAULT 'confirmada',
  anulada_en             TEXT,
  motivo_anulacion       TEXT,
  moneda                 TEXT    NOT NULL DEFAULT 'COP',
  tasa_cambio            REAL,
  tasa_origen            TEXT,
  tasa_nota              TEXT,
  subtotal_moneda        REAL,
  descuento_moneda       REAL,
  total_moneda           REAL,
  valor_pagado_moneda    REAL,
  saldo_pendiente_moneda REAL,
  trm_valor              REAL,
  trm_fecha              TEXT,
  trm_vigencia_hasta     TEXT,
  trm_fuente             TEXT,
  trm_obtenida_en        TEXT,
  trm_captura            TEXT,
  creado_en              TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS ix_compras_fecha     ON compras(fecha);
CREATE INDEX IF NOT EXISTS ix_compras_proveedor ON compras(proveedor_id);

CREATE TABLE IF NOT EXISTS compra_items (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  compra_id             INTEGER NOT NULL REFERENCES compras(id) ON DELETE CASCADE,
  producto_id           INTEGER NOT NULL REFERENCES productos(id),
  cantidad              INTEGER NOT NULL,
  costo_unitario        INTEGER NOT NULL DEFAULT 0,
  descuento             INTEGER NOT NULL DEFAULT 0,
  costo_unitario_final  INTEGER NOT NULL DEFAULT 0,
  total                 INTEGER NOT NULL DEFAULT 0,
  seriales              TEXT,
  costo_unitario_moneda REAL,
  descuento_moneda      REAL
);
CREATE INDEX IF NOT EXISTS ix_compra_items ON compra_items(compra_id);

CREATE TABLE IF NOT EXISTS lotes (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  producto_id           INTEGER NOT NULL REFERENCES productos(id),
  compra_id             INTEGER,
  compra_item_id        INTEGER,
  proveedor_id          INTEGER,
  fecha                 TEXT    NOT NULL,
  cantidad_inicial      INTEGER NOT NULL DEFAULT 0,
  cantidad_restante     INTEGER NOT NULL DEFAULT 0,
  costo_unitario        INTEGER NOT NULL DEFAULT 0,
  serial                TEXT,
  origen                TEXT    NOT NULL DEFAULT 'compra',
  estado                TEXT    NOT NULL DEFAULT 'disponible',
  moneda                TEXT    NOT NULL DEFAULT 'COP',
  tasa_cambio           REAL,
  costo_unitario_moneda REAL,
  creado_en             TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS ix_lotes_producto ON lotes(producto_id, cantidad_restante);
CREATE INDEX IF NOT EXISTS ix_lotes_serial   ON lotes(serial);
CREATE INDEX IF NOT EXISTS ix_lotes_compra   ON lotes(compra_id);

CREATE TABLE IF NOT EXISTS movimientos (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha            TEXT    NOT NULL,
  producto_id      INTEGER NOT NULL REFERENCES productos(id),
  lote_id          INTEGER,
  tipo             TEXT    NOT NULL,
  cantidad         INTEGER NOT NULL,
  costo_unitario   INTEGER NOT NULL DEFAULT 0,
  stock_resultante INTEGER,
  referencia_tipo  TEXT,
  referencia_id    INTEGER,
  usuario_id       INTEGER,
  usuario_nombre   TEXT,
  nota             TEXT
);
CREATE INDEX IF NOT EXISTS ix_movimientos_producto ON movimientos(producto_id, fecha);

-- Existencias por producto (incluye productos sin lotes con stock 0).
CREATE VIEW IF NOT EXISTS v_stock AS
  SELECT p.id AS producto_id,
         COALESCE(SUM(CASE WHEN l.estado <> 'anulado' THEN l.cantidad_restante END), 0) AS stock,
         COALESCE(SUM(CASE WHEN l.estado <> 'anulado' AND l.cantidad_restante > 0 THEN l.cantidad_restante * l.costo_unitario END), 0) AS valor_costo
  FROM productos p LEFT JOIN lotes l ON l.producto_id = p.id
  GROUP BY p.id;

-- ---------------------------------------------------------------- Caja
CREATE TABLE IF NOT EXISTS caja_sesiones (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  abierta_en          TEXT    NOT NULL,
  usuario_apertura_id INTEGER,
  base_inicial        INTEGER NOT NULL DEFAULT 0,
  cerrada_en          TEXT,
  usuario_cierre_id   INTEGER,
  efectivo_esperado   INTEGER,
  efectivo_contado    INTEGER,
  diferencia          INTEGER,
  resumen             TEXT,
  notas               TEXT,
  estado              TEXT    NOT NULL DEFAULT 'abierta'
);

CREATE TABLE IF NOT EXISTS caja_movimientos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  caja_sesion_id INTEGER NOT NULL REFERENCES caja_sesiones(id),
  fecha          TEXT    NOT NULL,
  tipo           TEXT    NOT NULL,
  concepto       TEXT,
  valor          INTEGER NOT NULL,
  usuario_id     INTEGER
);

CREATE TABLE IF NOT EXISTS gastos (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha            TEXT    NOT NULL,
  categoria        TEXT,
  descripcion      TEXT,
  valor            INTEGER NOT NULL,
  metodo_pago      TEXT,
  proveedor_id     INTEGER,
  comprobante_ruta TEXT,
  usuario_id       INTEGER,
  caja_sesion_id   INTEGER,
  anulado          INTEGER NOT NULL DEFAULT 0,
  creado_en        TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS ix_gastos_fecha ON gastos(fecha);

-- ---------------------------------------------------------------- Ventas, pagos y créditos
CREATE TABLE IF NOT EXISTS ventas (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  numero           TEXT    NOT NULL UNIQUE,
  fecha            TEXT    NOT NULL,
  cliente_id       INTEGER REFERENCES clientes(id),
  vendedor_id      INTEGER,
  registrado_por   INTEGER,
  responsable_tipo TEXT,
  subtotal         INTEGER NOT NULL DEFAULT 0,
  descuento        INTEGER NOT NULL DEFAULT 0,
  total            INTEGER NOT NULL DEFAULT 0,
  costo_total      INTEGER NOT NULL DEFAULT 0,
  ganancia         INTEGER NOT NULL DEFAULT 0,
  comision         INTEGER NOT NULL DEFAULT 0,
  gastos_venta     INTEGER NOT NULL DEFAULT 0,
  impuestos        INTEGER NOT NULL DEFAULT 0,
  ganancia_neta    INTEGER NOT NULL DEFAULT 0,
  tipo_pago        TEXT    NOT NULL DEFAULT 'contado',
  observaciones    TEXT,
  token_publico    TEXT    UNIQUE,
  caja_sesion_id   INTEGER,
  estado           TEXT    NOT NULL DEFAULT 'confirmada',
  anulada_en       TEXT,
  motivo_anulacion TEXT,
  moneda           TEXT    NOT NULL DEFAULT 'COP',
  tasa_cambio      REAL,
  tasa_origen      TEXT,
  tasa_nota        TEXT,
  subtotal_moneda  REAL,
  total_moneda     REAL,
  cargo_domicilio  INTEGER NOT NULL DEFAULT 0,  -- valor del envío cobrado al cliente (forma parte del total)
  domicilio_id     INTEGER,
  campana_id       INTEGER,
  canal_origen     TEXT,
  creado_en        TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS ix_ventas_fecha    ON ventas(fecha);
CREATE INDEX IF NOT EXISTS ix_ventas_cliente  ON ventas(cliente_id);
CREATE INDEX IF NOT EXISTS ix_ventas_vendedor ON ventas(vendedor_id);

CREATE TABLE IF NOT EXISTS venta_items (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  venta_id               INTEGER NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
  producto_id            INTEGER NOT NULL REFERENCES productos(id),
  nombre_producto        TEXT    NOT NULL,
  cantidad               INTEGER NOT NULL,
  cantidad_devuelta      INTEGER NOT NULL DEFAULT 0,
  precio_lista           INTEGER NOT NULL DEFAULT 0,
  precio_unitario        INTEGER NOT NULL DEFAULT 0,
  descuento              INTEGER NOT NULL DEFAULT 0,
  total                  INTEGER NOT NULL DEFAULT 0,
  costo_total            INTEGER NOT NULL DEFAULT 0,
  seriales               TEXT,
  tarifa                 TEXT    NOT NULL DEFAULT 'detal',  -- 'detal' | 'mayor': tarifa aplicada a la línea
  precio_unitario_moneda REAL,
  descuento_moneda       REAL
);
CREATE INDEX IF NOT EXISTS ix_venta_items_venta    ON venta_items(venta_id);
CREATE INDEX IF NOT EXISTS ix_venta_items_producto ON venta_items(producto_id);

CREATE TABLE IF NOT EXISTS venta_item_lotes (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  venta_item_id         INTEGER NOT NULL REFERENCES venta_items(id) ON DELETE CASCADE,
  lote_id               INTEGER NOT NULL REFERENCES lotes(id),
  cantidad              INTEGER NOT NULL,
  cantidad_devuelta     INTEGER NOT NULL DEFAULT 0,
  costo_unitario        INTEGER NOT NULL DEFAULT 0,
  serial                TEXT,
  moneda_compra         TEXT    NOT NULL DEFAULT 'COP',
  tasa_compra           REAL,
  costo_unitario_moneda REAL
);
CREATE INDEX IF NOT EXISTS ix_venta_item_lotes ON venta_item_lotes(venta_item_id);

CREATE TABLE IF NOT EXISTS pagos (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha            TEXT    NOT NULL,
  tipo             TEXT    NOT NULL,
  venta_id         INTEGER,
  credito_id       INTEGER,
  compra_id        INTEGER,
  cliente_id       INTEGER,
  proveedor_id     INTEGER,
  valor            INTEGER NOT NULL,
  metodo_pago      TEXT,
  referencia       TEXT,
  comprobante_ruta TEXT,
  nota             TEXT,
  usuario_id       INTEGER,
  caja_sesion_id   INTEGER,
  anulado          INTEGER NOT NULL DEFAULT 0,
  anulado_en       TEXT,
  moneda           TEXT    NOT NULL DEFAULT 'COP',
  valor_moneda     REAL,
  tasa_cambio      REAL,
  creado_en        TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS ix_pagos_fecha   ON pagos(fecha);
CREATE INDEX IF NOT EXISTS ix_pagos_venta   ON pagos(venta_id);
CREATE INDEX IF NOT EXISTS ix_pagos_credito ON pagos(credito_id);
CREATE INDEX IF NOT EXISTS ix_pagos_compra  ON pagos(compra_id);
CREATE INDEX IF NOT EXISTS ix_pagos_caja    ON pagos(caja_sesion_id);

CREATE TABLE IF NOT EXISTS creditos (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  numero                  TEXT    NOT NULL UNIQUE,
  venta_id                INTEGER REFERENCES ventas(id),
  cliente_id              INTEGER NOT NULL REFERENCES clientes(id),
  fecha                   TEXT    NOT NULL,
  valor_total             INTEGER NOT NULL DEFAULT 0,
  cuota_inicial           INTEGER NOT NULL DEFAULT 0,
  saldo_financiado        INTEGER NOT NULL DEFAULT 0,
  interes_pct             REAL    NOT NULL DEFAULT 0,
  numero_cuotas           INTEGER NOT NULL DEFAULT 1,
  valor_cuota             INTEGER NOT NULL DEFAULT 0,
  frecuencia              TEXT    NOT NULL DEFAULT 'mensual',
  primera_fecha           TEXT,
  saldo_actual            INTEGER NOT NULL DEFAULT 0,
  estado                  TEXT    NOT NULL DEFAULT 'al_dia',
  responsable_id          INTEGER,
  condiciones             TEXT,
  pagado_en               TEXT,
  moneda                  TEXT    NOT NULL DEFAULT 'COP',
  tasa_cambio             REAL,
  saldo_financiado_moneda REAL,
  saldo_moneda            REAL,
  creado_en               TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS ix_creditos_cliente ON creditos(cliente_id);
CREATE INDEX IF NOT EXISTS ix_creditos_estado  ON creditos(estado);

CREATE TABLE IF NOT EXISTS credito_cuotas (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  credito_id        INTEGER NOT NULL REFERENCES creditos(id) ON DELETE CASCADE,
  numero            INTEGER NOT NULL,
  fecha_vencimiento TEXT    NOT NULL,
  valor             INTEGER NOT NULL DEFAULT 0,
  pagado            INTEGER NOT NULL DEFAULT 0,
  estado            TEXT    NOT NULL DEFAULT 'pendiente',
  valor_moneda      REAL,
  pagado_moneda     REAL    NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_credito_cuotas ON credito_cuotas(credito_id, estado);

CREATE TABLE IF NOT EXISTS devoluciones (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  numero           TEXT    NOT NULL,
  venta_id         INTEGER NOT NULL REFERENCES ventas(id),
  fecha            TEXT    NOT NULL,
  tipo             TEXT    NOT NULL,
  motivo           TEXT,
  total            INTEGER NOT NULL DEFAULT 0,
  reintegro_metodo TEXT,
  usuario_id       INTEGER,
  caja_sesion_id   INTEGER
);
CREATE INDEX IF NOT EXISTS ix_devoluciones_venta ON devoluciones(venta_id);

CREATE TABLE IF NOT EXISTS devolucion_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  devolucion_id  INTEGER NOT NULL REFERENCES devoluciones(id) ON DELETE CASCADE,
  venta_item_id  INTEGER NOT NULL REFERENCES venta_items(id),
  producto_id    INTEGER NOT NULL,
  cantidad       INTEGER NOT NULL,
  valor          INTEGER NOT NULL DEFAULT 0,
  costo          INTEGER NOT NULL DEFAULT 0,
  reingresa      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_devolucion_items ON devolucion_items(devolucion_id);

-- ---------------------------------------------------------------- Contabilidad y tasa de cambio
CREATE TABLE IF NOT EXISTS tasas_cambio (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha          TEXT NOT NULL,
  tipo           TEXT NOT NULL,
  moneda         TEXT NOT NULL DEFAULT 'USD',
  valor          REAL NOT NULL,
  vigencia_desde TEXT,
  vigencia_hasta TEXT,
  fuente         TEXT,
  obtenido_en    TEXT,
  usuario_id     INTEGER,
  usuario_nombre TEXT,
  nota           TEXT,
  creado_en      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (fecha, tipo, moneda)
);

CREATE TABLE IF NOT EXISTS diferencias_cambiarias (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha          TEXT    NOT NULL,
  tipo           TEXT    NOT NULL,
  compra_id      INTEGER,
  venta_id       INTEGER,
  credito_id     INTEGER,
  pago_id        INTEGER,
  moneda         TEXT    NOT NULL DEFAULT 'USD',
  valor_moneda   REAL,
  tasa_operacion REAL,
  tasa_pago      REAL,
  diferencia     INTEGER NOT NULL DEFAULT 0,
  nota           TEXT,
  usuario_id     INTEGER,
  creado_en      TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS ix_diferencias_fecha ON diferencias_cambiarias(fecha);

-- ---------------------------------------------------------------- Domicilios (pedidos con entrega de la flota propia)
-- Estados: recibido → en_preparacion → en_camino → entregado | cancelado. Al entregar se crea la venta (descuenta
-- inventario, registra el pago contraentrega y el cargo del envío) y queda enlazada en domicilios.venta_id.
CREATE TABLE IF NOT EXISTS repartidores (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre    TEXT    NOT NULL,
  telefono  TEXT,
  vehiculo  TEXT,
  placa     TEXT,
  activo    INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS domicilios (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  numero             TEXT    NOT NULL UNIQUE,
  estado             TEXT    NOT NULL DEFAULT 'recibido',
  canal              TEXT,
  fecha              TEXT    NOT NULL,
  cliente_id         INTEGER REFERENCES clientes(id),
  cliente_nombre     TEXT    NOT NULL,
  telefono           TEXT    NOT NULL,
  direccion          TEXT    NOT NULL,
  barrio             TEXT,
  indicaciones       TEXT,
  subtotal           INTEGER NOT NULL DEFAULT 0,
  cargo_envio        INTEGER NOT NULL DEFAULT 0,
  total              INTEGER NOT NULL DEFAULT 0,
  metodo_pago        TEXT,
  paga_con           INTEGER,
  hora_compromiso    TEXT,
  notas              TEXT,
  repartidor_id      INTEGER REFERENCES repartidores(id),
  venta_id           INTEGER,
  creado_por         INTEGER,
  preparado_en       TEXT,
  despachado_en      TEXT,
  entregado_en       TEXT,
  cancelado_en       TEXT,
  motivo_cancelacion TEXT,
  actualizado_en     TEXT
);
CREATE INDEX IF NOT EXISTS ix_domicilios_estado ON domicilios(estado, fecha);
CREATE INDEX IF NOT EXISTS ix_domicilios_fecha  ON domicilios(fecha);

CREATE TABLE IF NOT EXISTS domicilio_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  domicilio_id    INTEGER NOT NULL REFERENCES domicilios(id) ON DELETE CASCADE,
  producto_id     INTEGER NOT NULL REFERENCES productos(id),
  nombre_producto TEXT    NOT NULL,
  cantidad        INTEGER NOT NULL,
  precio_unitario INTEGER NOT NULL DEFAULT 0,
  tarifa          TEXT    NOT NULL DEFAULT 'detal',
  total           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_domicilio_items ON domicilio_items(domicilio_id);

-- ---------------------------------------------------------------- Comisiones y liquidaciones
CREATE TABLE IF NOT EXISTS liquidaciones (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  numero                TEXT    NOT NULL UNIQUE,
  vendedor_id           INTEGER NOT NULL REFERENCES usuarios(id),
  desde                 TEXT    NOT NULL,
  hasta                 TEXT    NOT NULL,
  salario               INTEGER NOT NULL DEFAULT 0,
  comision_pct          REAL    NOT NULL DEFAULT 0,
  devengo               TEXT,
  ventas_n              INTEGER NOT NULL DEFAULT 0,
  ingreso_neto          INTEGER NOT NULL DEFAULT 0,
  ganancia_operativa    INTEGER NOT NULL DEFAULT 0,
  ganancia_comisionable INTEGER NOT NULL DEFAULT 0,
  comision              INTEGER NOT NULL DEFAULT 0,
  ajustes_previos       INTEGER NOT NULL DEFAULT 0,
  total                 INTEGER NOT NULL DEFAULT 0,
  pendientes_cobro      INTEGER NOT NULL DEFAULT 0,
  notas                 TEXT,
  estado                TEXT    NOT NULL DEFAULT 'cerrada',
  cerrada_por           INTEGER,
  cerrada_en            TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  anulada_por           INTEGER,
  anulada_en            TEXT,
  anulacion_motivo      TEXT
);

CREATE TABLE IF NOT EXISTS liquidacion_ventas (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  liquidacion_id INTEGER NOT NULL REFERENCES liquidaciones(id) ON DELETE CASCADE,
  venta_id       INTEGER NOT NULL,
  ganancia       INTEGER NOT NULL DEFAULT 0,
  comision       INTEGER NOT NULL DEFAULT 0,
  comision_actual INTEGER NOT NULL DEFAULT 0,
  comisionable   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_liquidacion_ventas ON liquidacion_ventas(venta_id);

CREATE TABLE IF NOT EXISTS liquidacion_ajustes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  liquidacion_id    INTEGER NOT NULL REFERENCES liquidaciones(id) ON DELETE CASCADE,
  venta_id          INTEGER,
  fecha             TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  motivo            TEXT,
  comision_anterior INTEGER NOT NULL DEFAULT 0,
  comision_nueva    INTEGER NOT NULL DEFAULT 0,
  valor             INTEGER NOT NULL DEFAULT 0,
  usuario_id        INTEGER,
  aplicado_en       INTEGER
);

-- ---------------------------------------------------------------- Marketing
CREATE TABLE IF NOT EXISTS campanas (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre         TEXT    NOT NULL,
  plataforma     TEXT    NOT NULL DEFAULT 'otra',
  objetivo       TEXT,
  estado         TEXT    NOT NULL DEFAULT 'borrador',
  fecha_inicio   TEXT,
  fecha_fin      TEXT,
  presupuesto    INTEGER NOT NULL DEFAULT 0,
  gasto_manual   INTEGER NOT NULL DEFAULT 0,
  enlace_destino TEXT,
  utm_source     TEXT,
  utm_medium     TEXT,
  utm_campaign   TEXT,
  id_externo     TEXT,
  observaciones  TEXT,
  usuario_id     INTEGER,
  creado_en      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  actualizado_en TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS ix_campanas_utm ON campanas(utm_campaign);

CREATE TABLE IF NOT EXISTS campana_productos (
  campana_id  INTEGER NOT NULL REFERENCES campanas(id) ON DELETE CASCADE,
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  PRIMARY KEY (campana_id, producto_id)
);

CREATE TABLE IF NOT EXISTS campana_metricas (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  campana_id     INTEGER NOT NULL REFERENCES campanas(id) ON DELETE CASCADE,
  fecha          TEXT    NOT NULL,
  impresiones    INTEGER,
  alcance        INTEGER,
  clics          INTEGER,
  gasto          INTEGER,
  conversaciones INTEGER,
  resultados     INTEGER,
  origen         TEXT    NOT NULL DEFAULT 'manual',
  usuario_id     INTEGER,
  creado_en      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (campana_id, fecha, origen)
);

CREATE TABLE IF NOT EXISTS marketing_eventos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  tipo           TEXT NOT NULL,
  visitante      TEXT,
  utm_source     TEXT,
  utm_medium     TEXT,
  utm_campaign   TEXT,
  utm_content    TEXT,
  utm_term       TEXT,
  campana_id     INTEGER,
  producto_id    INTEGER,
  producto_texto TEXT,
  pagina         TEXT,
  referente      TEXT,
  ip_hash        TEXT,
  user_agent     TEXT,
  datos          TEXT,
  lead_id        INTEGER
);
CREATE INDEX IF NOT EXISTS ix_eventos_fecha     ON marketing_eventos(fecha);
CREATE INDEX IF NOT EXISTS ix_eventos_visitante ON marketing_eventos(visitante);
CREATE INDEX IF NOT EXISTS ix_eventos_campana   ON marketing_eventos(campana_id);

CREATE TABLE IF NOT EXISTS marketing_leads (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha          TEXT NOT NULL,
  nombre         TEXT,
  telefono       TEXT,
  email          TEXT,
  mensaje        TEXT,
  canal          TEXT,
  utm_source     TEXT,
  utm_medium     TEXT,
  utm_campaign   TEXT,
  campana_id     INTEGER,
  visitante      TEXT,
  producto_id    INTEGER,
  producto_texto TEXT,
  estado         TEXT NOT NULL DEFAULT 'nuevo',
  notas          TEXT,
  cliente_id     INTEGER,
  venta_id       INTEGER,
  usuario_id     INTEGER,
  creado_en      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  actualizado_en TEXT
);
CREATE INDEX IF NOT EXISTS ix_leads_fecha   ON marketing_leads(fecha);
CREATE INDEX IF NOT EXISTS ix_leads_campana ON marketing_leads(campana_id);

CREATE TABLE IF NOT EXISTS marketing_atribuciones (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  venta_id   INTEGER NOT NULL UNIQUE,
  campana_id INTEGER,
  lead_id    INTEGER,
  tipo       TEXT,
  regla      TEXT,
  canal      TEXT,
  usuario_id INTEGER,
  creado_en  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS marketing_sincronizaciones (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  plataforma            TEXT NOT NULL,
  inicio                TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  fin                   TEXT,
  estado                TEXT NOT NULL DEFAULT 'en_curso',
  detalle               TEXT,
  campanas_actualizadas INTEGER NOT NULL DEFAULT 0,
  metricas_insertadas   INTEGER NOT NULL DEFAULT 0,
  usuario_id            INTEGER
);

-- ---------------------------------------------------------------- Asistente
CREATE TABLE IF NOT EXISTS asistente_conversaciones (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id     INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  titulo         TEXT,
  cerrada        INTEGER NOT NULL DEFAULT 0,
  creado_en      TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS asistente_mensajes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversacion_id INTEGER NOT NULL REFERENCES asistente_conversaciones(id) ON DELETE CASCADE,
  rol             TEXT NOT NULL,
  contenido       TEXT NOT NULL DEFAULT '',
  herramientas    TEXT,
  acciones        TEXT,
  proveedor       TEXT,
  modelo          TEXT,
  tokens_entrada  INTEGER,
  tokens_salida   INTEGER,
  costo_usd       REAL,
  duracion_ms     INTEGER,
  error           TEXT,
  creado_en       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_asistente_mensajes ON asistente_mensajes(conversacion_id);
