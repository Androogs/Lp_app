'use strict';
// Asistente Tino: motor local (sin IA), avisos de pendientes, permisos, seguimientos de conversación, combinación con un
// proveedor de IA (simulado: las pruebas nunca llaman a un servicio real) y lectura de fechas en español.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.OPENROUTER_API_KEY;
const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar, detener, Cliente, CLAVES, getDb } = require('./ayuda');
const asistente = require('../server/services/asistente');
const L = require('../server/services/asistente/lenguaje');
const { hoy } = require('../server/util');
const dashboard = require('../server/services/dashboard');

test.before(iniciar);
test.after(() => { asistente.setProveedor(null); detener(); });

const IA_OK = { nombre: 'falso', disponible: () => true, completar: async () => ({ texto: 'Respuesta de la IA simulada', llamadas: [], uso: { entrada: 10, salida: 5 }, detencion: 'end_turn', modelo: 'modelo-falso' }) };
const IA_CAIDA = { nombre: 'falso', disponible: () => true, completar: async () => { const e = new Error('No hay conexión con el servicio de IA'); e.status = 503; e.codigo = 'ia_sin_conexion'; e.proveedor = 'falso'; throw e; } };

async function admin() { const c = new Cliente(); await c.entrar('admin', CLAVES.admin); return c; }
async function configurar(c, asistenteCfg) { const r = await c.put('/api/configuracion', { asistente: asistenteCfg }); assert.equal(r.status, 200, JSON.stringify(r.datos)); }
const preguntar = (c, mensaje, conversacion_id) => c.post('/api/asistente/mensajes', { mensaje, conversacion_id });

test('sin clave de IA Tino está disponible y responde con el motor local', async () => {
  asistente.setProveedor(null);
  const c = await admin();
  const e = await c.get('/api/asistente/estado');
  assert.equal(e.status, 200);
  assert.equal(e.datos.disponible, true);
  assert.equal(e.datos.motor, 'auto');
  assert.equal(e.datos.motor_efectivo, 'local');
  const r = await preguntar(c, '¿Qué tengo pendiente?');
  assert.equal(r.status, 200, JSON.stringify(r.datos));
  assert.equal(r.datos.motor, 'local');
  assert.equal(r.datos.intencion, 'pendientes');
});

test('stock de un producto: la cifra coincide con la base de datos', async () => {
  const c = await admin();
  const db = getDb();
  const total = db.prepare("SELECT SUM(s.stock) n FROM productos p JOIN v_stock s ON s.producto_id = p.id WHERE p.nombre LIKE 'Aguardiente%' AND p.estado <> 'inactivo'").get().n;
  const r = await preguntar(c, '¿Cuántos aguardientes hay?');
  assert.equal(r.datos.intencion, 'stock_producto');
  assert.match(r.datos.respuesta, new RegExp(`\\*\\*${L.unidades(total)}\\*\\*`));
  const nav = r.datos.acciones.find((a) => a.tipo === 'navegar');
  assert.ok(nav && /^#\/inventario/.test(nav.hash));
  // Una edad con número no se confunde con otra: "Viejo de Caldas 8" no devuelve el de 3 años
  const r2 = await preguntar(c, 'cuantos viejo de caldas 8 quedan');
  assert.match(r2.datos.respuesta, /Caldas 8/);
  assert.doesNotMatch(r2.datos.respuesta, /Caldas 3/);
  // La jerga se entiende: "guaro" es aguardiente
  const r4 = await preguntar(c, '¿cuánto guaro tapa azul hay?');
  assert.match(r4.datos.respuesta, /Tapa Azul/);
  // Producto inexistente: lo dice en vez de inventar
  const r3 = await preguntar(c, '¿Cuántas tablets Huawei hay?');
  assert.match(r3.datos.respuesta, /No encontré productos/);
});

test('ventas del día: el total coincide con el panel', async () => {
  const c = await admin();
  const netas = dashboard.resumenPeriodo(getDb(), hoy(), hoy()).ventas.netas;
  const r = await preguntar(c, '¿Cuánto se vendió hoy?');
  assert.equal(r.datos.intencion, 'ventas_periodo');
  if (netas > 0) assert.ok(r.datos.respuesta.includes(L.cop(netas)), r.datos.respuesta);
  else assert.match(r.datos.respuesta, /no hubo ventas/i);
});

test('seguimientos: "¿y ayer?" conserva la intención y una pregunta general no hereda el producto', async () => {
  const c = await admin();
  const a = await preguntar(c, '¿Cuántos aguardientes hay?');
  const conv = a.datos.conversacion_id;
  const b = await preguntar(c, '¿Cuántos se vendieron este mes?', conv);
  assert.equal(b.datos.intencion, 'ventas_producto');
  assert.match(b.datos.respuesta, /Aguardiente/);
  const g = await preguntar(c, '¿Cuánto se vendió hoy?', conv);
  assert.equal(g.datos.intencion, 'ventas_periodo');
  const y = await preguntar(c, '¿y ayer?', conv);
  assert.equal(y.datos.intencion, 'ventas_periodo');
  assert.match(y.datos.respuesta, /^Ayer/);
  // El historial guarda las acciones (botones y sugerencias) para volver a pintarlas
  const h = await c.get(`/api/asistente/conversaciones/${conv}`);
  assert.equal(h.datos.mensajes.length, 8);
  assert.ok(h.datos.mensajes.filter((m) => m.rol === 'asistente').every((m) => m.proveedor === 'local' && !m.error));
});

test('avisos: un producto agotado aparece como alerta urgente con su clave', async () => {
  const c = await admin();
  const db = getDb();
  const p = db.prepare("SELECT id, nombre FROM productos WHERE nombre LIKE 'Ron Esencial%'").get();
  db.prepare('UPDATE lotes SET cantidad_restante = 0 WHERE producto_id = ?').run(p.id);
  const r = await c.get('/api/asistente/avisos');
  assert.equal(r.status, 200);
  const ag = r.datos.avisos.find((a) => a.id === 'inventario_agotados');
  assert.ok(ag, JSON.stringify(r.datos.avisos.map((a) => a.id)));
  assert.equal(ag.nivel, 'alta');
  assert.ok(ag.claves.includes(`agotado:${p.id}`));
  assert.ok(r.datos.conteo.alta >= 1);
  assert.equal(typeof r.datos.firma, 'string');
  const q = await preguntar(c, '¿Qué productos se van a acabar?');
  assert.equal(q.datos.intencion, 'inventario_bajo');
  assert.match(q.datos.respuesta, new RegExp(p.nombre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('permisos: cada usuario solo ve lo que su rol permite', async () => {
  const inv = new Cliente(); await inv.entrar('pedro', CLAVES.pedro);
  const r = await preguntar(inv, '¿Quién me debe?');
  assert.equal(r.status, 200);
  assert.match(r.datos.respuesta, /No tienes permiso/);
  const a = await inv.get('/api/asistente/avisos');
  assert.ok(!a.datos.avisos.some((x) => x.modulo === 'creditos'), 'inventario no debe ver avisos de cartera');
  const ven = new Cliente(); await ven.entrar('carlos', CLAVES.carlos);
  const v = await preguntar(ven, '¿Cuánto le debo a los proveedores?');
  assert.match(v.datos.respuesta, /No tienes permiso/);
  const g = await preguntar(ven, '¿Cuánto gané este mes?');
  assert.doesNotMatch(g.datos.respuesta, /Utilidad estimada/, 'el vendedor no ve la utilidad del negocio');
});

test('modo automático con IA: lo que el motor local entiende no gasta IA; lo demás va a la IA', async () => {
  const c = await admin();
  asistente.setProveedor(IA_OK);
  try {
    const e = await c.get('/api/asistente/estado');
    assert.equal(e.datos.motor_efectivo, 'mixto');
    const a = await preguntar(c, '¿Cuántos aguardientes hay?');
    assert.equal(a.datos.motor, 'local');
    const b = await preguntar(c, 'Escríbeme una frase motivadora para el equipo');
    assert.equal(b.datos.motor, 'ia');
    assert.equal(b.datos.respuesta, 'Respuesta de la IA simulada');
  } finally { asistente.setProveedor(null); }
});

test('si la IA falla, Tino responde igual con el motor local', async () => {
  const c = await admin();
  asistente.setProveedor(IA_CAIDA);
  try {
    const r = await preguntar(c, 'Escríbeme una frase motivadora para el equipo');
    assert.equal(r.status, 200, JSON.stringify(r.datos));
    assert.equal(r.datos.motor, 'local');
    assert.match(r.datos.respuesta, /El servicio de IA no respondió/);
  } finally { asistente.setProveedor(null); }
});

test('modo "solo IA": sin clave queda sin configurar; con la IA caída devuelve el error', async () => {
  const c = await admin();
  await configurar(c, { motor: 'ia' });
  try {
    asistente.setProveedor(null);
    const e = await c.get('/api/asistente/estado');
    assert.equal(e.datos.disponible, false);
    const r = await preguntar(c, '¿Cuántos cargadores hay?');
    assert.equal(r.status, 503);
    asistente.setProveedor(IA_CAIDA);
    const r2 = await preguntar(c, '¿Cuántos cargadores hay?');
    assert.equal(r2.status, 503);
  } finally { asistente.setProveedor(null); await configurar(c, { motor: 'auto' }); }
});

test('modo automático: al superar el límite por hora responde el motor local en vez de bloquear', async () => {
  const c = await admin();
  await configurar(c, { limite_mensajes_hora: 1 });
  asistente.setProveedor(IA_OK);
  try {
    await preguntar(c, 'Escríbeme una frase motivadora');
    const r = await preguntar(c, 'Escríbeme otra frase motivadora');
    assert.equal(r.status, 200);
    assert.equal(r.datos.motor, 'local');
  } finally { asistente.setProveedor(null); await configurar(c, { limite_mensajes_hora: 40 }); }
});

test('configuración: valida el motor y los días de cobertura', async () => {
  const c = await admin();
  const mal = await c.put('/api/configuracion', { asistente: { motor: 'magia' } });
  assert.equal(mal.status, 400);
  const mal2 = await c.put('/api/configuracion', { asistente: { dias_cobertura: 0 } });
  assert.equal(mal2.status, 400);
  await configurar(c, { motor: 'local', dias_cobertura: 10 });
  const e = await c.get('/api/asistente/estado');
  assert.equal(e.datos.motor, 'local');
  assert.equal(e.datos.dias_cobertura, 10);
  await configurar(c, { motor: 'auto', dias_cobertura: 7 });
});

test('lectura de fechas en español', () => {
  const base = '2026-11-04'; // miércoles
  const p = (t) => L.interpretarPeriodo(L.normalizar(t), base);
  assert.deepEqual([p('ventas de hoy').desde, p('ventas de hoy').hasta], ['2026-11-04', '2026-11-04']);
  assert.equal(p('cuánto se vendió ayer').desde, '2026-11-03');
  assert.equal(p('antier').desde, '2026-11-02');
  assert.equal(p('el lunes').desde, '2026-11-02');
  assert.deepEqual([p('el 15 de octubre').desde, p('el 15 de octubre').hasta], ['2026-10-15', '2026-10-15']);
  assert.equal(p('ventas el 15/10').desde, '2026-10-15');
  assert.deepEqual([p('en octubre').desde, p('en octubre').hasta], ['2026-10-01', '2026-10-31']);
  assert.deepEqual([p('del mes de octubre').desde, p('del mes de octubre').hasta], ['2026-10-01', '2026-10-31']);
  assert.deepEqual([p('la semana pasada').desde, p('la semana pasada').hasta], ['2026-10-26', '2026-11-01']);
  assert.deepEqual([p('del 1 al 15 de octubre').desde, p('del 1 al 15 de octubre').hasta], ['2026-10-01', '2026-10-15']);
  assert.equal(p('últimos 7 días').desde, '2026-10-29');
  assert.equal(p('en diciembre').desde, '2025-12-01', 'un mes futuro se interpreta como el del año anterior');
  assert.equal(p('cuantos galaxy a15 hay'), null, '"A15" no es una fecha');
});

test('herramientas: venta por número, producto fuera del top, monto mínimo, cliente en créditos, domicilios, caja por fecha y TRM histórica', async () => {
  const db = getDb();
  const herramientas = require('../server/services/asistente/herramientas');
  const adm = db.prepare("SELECT * FROM usuarios WHERE rol = 'admin' LIMIT 1").get();
  const u = { ...adm, permisos: new Set(['*']) };

  // Detalle completo de una venta por su número.
  const v = db.prepare('SELECT numero FROM ventas ORDER BY id LIMIT 1').get();
  let r = await herramientas.ejecutar(db, u, 'consultar_ventas', { numero: v.numero });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.datos.venta.numero, v.numero);
  assert.ok(Array.isArray(r.datos.venta.items) && 'pagado' in r.datos.venta);
  r = await herramientas.ejecutar(db, u, 'consultar_ventas', { numero: 'V-999999' });
  assert.equal(r.datos.encontrada, false);

  // Monto mínimo: todas las listadas cumplen.
  r = await herramientas.ejecutar(db, u, 'consultar_ventas', { periodo: 'todo', monto_minimo: 1 });
  assert.ok(r.ok && r.datos.mostradas > 0 && r.datos.ventas.every((x) => x.total >= 1));

  // Producto fuera de lo más vendido: devuelve filas aunque no haya vendido en el periodo.
  const p = db.prepare('SELECT nombre FROM productos LIMIT 1').get();
  r = await herramientas.ejecutar(db, u, 'consultar_ventas', { periodo: 'todo', producto: p.nombre.split(' ')[0] });
  assert.ok(r.ok && Array.isArray(r.datos.productos) && r.datos.productos.length > 0 && 'total_unidades' in r.datos);

  // Créditos y abonos de una persona: usa estadoCuenta.
  const cl = db.prepare('SELECT nombre FROM clientes WHERE activo = 1 LIMIT 1').get();
  if (cl) {
    r = await herramientas.ejecutar(db, u, 'consultar_creditos', { cliente: cl.nombre });
    assert.ok(r.ok && r.datos.cliente && 'saldo_total' in r.datos && Array.isArray(r.datos.abonos));
  }

  // Domicilios: resumen del día, repartidores y lista; solo con permiso de domicilios.
  r = await herramientas.ejecutar(db, u, 'consultar_domicilios', {});
  assert.ok(r.ok && 'por_despachar' in r.datos.resumen && Array.isArray(r.datos.domicilios) && Array.isArray(r.datos.repartidores));
  r = await herramientas.ejecutar(db, u, 'consultar_domicilios', { estado: 'entregado', limite: 5 });
  assert.ok(r.ok && r.datos.domicilios.every((d) => d.estado === 'entregado'));
  const sinPerm = { ...adm, permisos: new Set(['comisiones.ver_propias']) };
  r = await herramientas.ejecutar(db, sinPerm, 'consultar_domicilios', {});
  assert.equal(r.ok, false);

  // Caja por fecha: siempre responde con la lista de sesiones (vacía o no).
  r = await herramientas.ejecutar(db, u, 'consultar_caja', { fecha: '2020-01-01' });
  assert.ok(r.ok && Array.isArray(r.datos.sesiones));

  // TRM histórica: siembra una fila vigente ese día para no depender de internet.
  db.prepare("INSERT INTO tasas_cambio(fecha, tipo, moneda, valor, vigencia_desde, vigencia_hasta, fuente, obtenido_en) VALUES ('2020-06-15','trm','USD',3700,'2020-06-15','2020-06-15','prueba','2020-06-15 00:00:00')").run();
  r = await herramientas.ejecutar(db, u, 'consultar_trm', { fecha: '2020-06-15' });
  assert.ok(r.ok && r.datos.trm && r.datos.trm.valor === 3700);

  // Un vendedor no puede pedir las ventas de otro.
  const vend = { ...adm, permisos: new Set(['comisiones.ver_propias']) };
  r = await herramientas.ejecutar(db, vend, 'consultar_ventas', { vendedor: 'Alguien' });
  assert.ok(r.ok && /propias ventas/.test(r.datos.nota));
});

test('local: abonos de una persona concreta usa consultar_creditos con cliente', async () => {
  const db = getDb();
  const cl = db.prepare("SELECT nombre FROM clientes WHERE activo = 1 LIMIT 1").get();
  if (!cl) return;
  const c = await admin();
  const r = await preguntar(c, `¿Qué abonos ha hecho ${cl.nombre}?`);
  assert.equal(r.status, 200, JSON.stringify(r.datos));
  assert.match(r.datos.respuesta, new RegExp(cl.nombre.split(' ')[0], 'i'));
});
