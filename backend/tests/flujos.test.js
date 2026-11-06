'use strict';
// Flujos completos del negocio a través de la API (como los haría la interfaz): catálogo, compra, venta de contado y a
// crédito, abonos, devolución, anulación, caja, gastos, marketing, precio mayorista y domicilios con la flota propia.
const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar, detener, Cliente, CLAVES } = require('./ayuda');

test.before(iniciar);
test.after(detener);

const ok = (r, msg) => assert.ok(r.status >= 200 && r.status < 300, `${msg}: ${r.status} ${JSON.stringify(r.datos).slice(0, 300)}`);

test('flujo completo de operación diaria', async () => {
  const a = new Cliente();
  await a.entrar('admin', CLAVES.admin);

  // Caja
  const cajaActual = (await a.get('/api/caja')).datos;
  if (!cajaActual.abierta) ok(await a.post('/api/caja/abrir', { base_inicial: 100000 }), 'abrir caja');

  // Catálogo
  const p = await a.post('/api/productos', { nombre: 'Ron prueba flujo 750 ml', capacidad: '750 ml', precio_venta: 30000, precio_compra: 10000, stock_minimo: 2 });
  ok(p, 'crear producto');
  const pid = p.datos.id;
  ok(await a.put(`/api/productos/${pid}`, { precio_venta: 32000, motivo_precio: 'Ajuste' }), 'editar producto');

  // Compra en pesos con pago parcial
  const prov = await a.post('/api/proveedores', { nombre: 'Proveedor flujo', telefono: '3000000000' });
  ok(prov, 'crear proveedor');
  const compra = await a.post('/api/compras', { proveedor_id: prov.datos.id, numero_factura: 'F-FLUJO-1', items: [{ producto_id: pid, cantidad: 10, costo_unitario: 11000 }], valor_pagado: 50000, metodo_pago: 'efectivo' });
  ok(compra, 'crear compra');
  ok(await a.post(`/api/compras/${compra.datos.id}/pagos`, { valor: 10000, metodo_pago: 'transferencia' }), 'pagar compra');

  // Compra en dólares
  const usd = await a.post('/api/compras', { moneda: 'USD', tasa_cambio: 4000, tasa_origen: 'manual', tasa_nota: 'Prueba', items: [{ producto_id: pid, cantidad: 2, costo_unitario: 3.5 }], numero_factura: 'F-USD-1' });
  ok(usd, 'compra en USD');
  assert.equal(usd.datos.moneda, 'USD');

  // Ajuste de inventario
  ok(await a.post(`/api/productos/${pid}/ajuste`, { cantidad: -1, motivo: 'Pérdida de prueba', tipo: 'perdida' }), 'ajuste');

  // Cliente y venta de contado
  const cli = await a.post('/api/clientes', { nombre: 'Cliente flujo', telefono: '3115551234' });
  ok(cli, 'crear cliente');
  const v1 = await a.post('/api/ventas', { cliente_id: cli.datos.id, items: [{ producto_id: pid, cantidad: 2 }], pagos: [{ metodo_pago: 'efectivo', valor: 64000 }] });
  ok(v1, 'venta de contado');
  assert.equal(v1.datos.costo_total > 0, true, 'la venta tiene costo FIFO');
  ok(await a.get(`/api/ventas/${v1.datos.id}/pdf`), 'PDF de venta');
  const comp = await a.get(`/comprobante/${v1.datos.token_publico}`);
  assert.equal(comp.status, 200);
  assert.equal((await a.get('/comprobante/no-valido')).status, 404);

  // Devolución parcial
  const item = v1.datos.items[0];
  ok(await a.post(`/api/ventas/${v1.datos.id}/devolucion`, { tipo: 'devolucion', motivo: 'Defecto', items: [{ venta_item_id: item.id, cantidad: 1, reingresa: true }], reintegro_metodo: 'efectivo' }), 'devolución');

  // Venta a crédito y abono
  const v2 = await a.post('/api/ventas', { cliente_id: cli.datos.id, items: [{ producto_id: pid, cantidad: 2 }], pagos: [{ metodo_pago: 'efectivo', valor: 10000 }], credito: { numero_cuotas: 3, frecuencia: 'mensual' } });
  ok(v2, 'venta a crédito');
  const v2d = (await a.get(`/api/ventas/${v2.datos.id}`)).datos;
  if (v2d.credito) {
    ok(await a.post(`/api/creditos/${v2d.credito.id}/abonos`, { valor: 5000, metodo_pago: 'nequi' }), 'abono');
    ok(await a.get(`/api/clientes/${cli.datos.id}/estado-cuenta/pdf`), 'estado de cuenta PDF');
  }

  // Anulación
  const v3 = await a.post('/api/ventas', { items: [{ producto_id: pid, cantidad: 1 }], pagos: [{ metodo_pago: 'efectivo', valor: 32000 }] });
  ok(v3, 'venta para anular');
  ok(await a.post(`/api/ventas/${v3.datos.id}/anular`, { motivo: 'Error de digitación' }), 'anular venta');

  // Gastos y movimientos de caja
  const g = await a.post('/api/gastos', { categoria: 'Transporte', valor: 15000, metodo_pago: 'efectivo', descripcion: 'Domicilio' });
  ok(g, 'gasto');
  ok(await a.del(`/api/gastos/${g.datos.id}`), 'anular gasto');
  ok(await a.post('/api/caja/movimientos', { tipo: 'entrada', valor: 20000, concepto: 'Base extra' }), 'movimiento caja');
  ok(await a.post('/api/caja/cerrar', { efectivo_contado: 500000, notas: 'Cierre de prueba' }), 'cerrar caja');

  // Marketing
  const camp = await a.post('/api/marketing/campanas', { nombre: 'Campaña flujo', plataforma: 'meta', presupuesto: 200000 });
  ok(camp, 'crear campaña');
  ok(await a.post(`/api/marketing/campanas/${camp.datos.id}/metricas`, { fecha: '2026-10-01', gasto: 10000, clics: 30, impresiones: 1000 }), 'métricas');
  const lead = await a.post('/api/marketing/leads', { nombre: 'Interesado', telefono: '3120000000', canal: 'whatsapp', campana_id: camp.datos.id });
  ok(lead, 'crear lead');


  // Configuración y respaldo
  ok(await a.put('/api/configuracion', { negocio_ciudad: 'Palmira' }), 'configuración');
  const resp = await a.post('/api/respaldos');
  ok(resp, 'respaldo');

  // Auditoría registra las acciones
  const aud = (await a.get('/api/auditoria')).datos;
  assert.ok((Array.isArray(aud) ? aud : aud.filas || aud.registros || []).length > 0 || JSON.stringify(aud).includes('crear_producto'));
});

test('precio mayorista: desde N unidades y para clientes mayoristas', async () => {
  const a = new Cliente();
  await a.entrar('admin', CLAVES.admin);
  if (!(await a.get('/api/caja')).datos.abierta) ok(await a.post('/api/caja/abrir', { base_inicial: 100000 }), 'abrir caja');
  const p = await a.post('/api/productos', { nombre: 'Aguardiente prueba mayor 750 ml', precio_venta: 50000, precio_mayor: 45000, precio_compra: 38000, stock_inicial: 60 });
  ok(p, 'crear producto con precio mayor');
  assert.equal(p.datos.precio_mayor, 45000);
  const malo = await a.post('/api/productos', { nombre: 'Precio mayor invertido', precio_venta: 10000, precio_mayor: 12000 });
  assert.equal(malo.status, 400, 'el mayor no puede superar el detal');

  // Menos de 10 unidades: detal. 10 o más de la misma referencia: mayor, aunque vengan en dos líneas.
  const detal = await a.post('/api/ventas', { items: [{ producto_id: p.datos.id, cantidad: 9 }], pagos: [{ metodo_pago: 'efectivo', valor: 450000 }] });
  ok(detal, 'venta al detal');
  assert.equal(detal.datos.items[0].tarifa, 'detal');
  assert.equal(detal.datos.total, 450000);
  const mayor = await a.post('/api/ventas', { items: [{ producto_id: p.datos.id, cantidad: 6 }, { producto_id: p.datos.id, cantidad: 4 }], pagos: [{ metodo_pago: 'efectivo', valor: 450000 }] });
  ok(mayor, 'venta al por mayor');
  assert.ok(mayor.datos.items.every((it) => it.tarifa === 'mayor' && it.precio_unitario === 45000));
  assert.equal(mayor.datos.total, 450000);

  // Cliente mayorista: precio mayor desde la primera unidad.
  const tienda = await a.post('/api/clientes', { nombre: 'Tienda prueba', telefono: '3119998877', tipo_cliente: 'mayorista', barrio: 'Zamorano' });
  ok(tienda, 'crear cliente mayorista');
  assert.equal(tienda.datos.tipo_cliente, 'mayorista');
  const v = await a.post('/api/ventas', { cliente_id: tienda.datos.id, items: [{ producto_id: p.datos.id, cantidad: 2 }], pagos: [{ metodo_pago: 'efectivo', valor: 90000 }] });
  ok(v, 'venta a mayorista');
  assert.equal(v.datos.items[0].tarifa, 'mayor');

  // El vendedor no puede cobrar un precio distinto al de la tarifa sin permiso.
  const ven = new Cliente(); await ven.entrar('carlos', CLAVES.carlos);
  const r = await ven.post('/api/ventas', { items: [{ producto_id: p.datos.id, cantidad: 1, precio_unitario: 45000 }], pagos: [{ metodo_pago: 'efectivo', valor: 45000 }] });
  assert.equal(r.status, 403);
});

test('domicilios: pedido, despacho, entrega que crea la venta, cancelación y permisos', async () => {
  const a = new Cliente();
  await a.entrar('admin', CLAVES.admin);
  if (!(await a.get('/api/caja')).datos.abierta) ok(await a.post('/api/caja/abrir', { base_inicial: 100000 }), 'abrir caja');
  const p = await a.post('/api/productos', { nombre: 'Cerveza prueba domicilio lata', precio_venta: 4000, precio_mayor: 3000, precio_compra: 2500, stock_inicial: 100 });
  ok(p, 'producto');
  const rep = await a.post('/api/repartidores', { nombre: 'Repartidor prueba', vehiculo: 'Moto', placa: 'abc12d' });
  ok(rep, 'crear repartidor');
  assert.equal(rep.datos.placa, 'ABC12D');

  // Cotización: 12 latas pasan a precio mayor.
  const cot = await a.post('/api/domicilios/cotizar', { items: [{ producto_id: p.datos.id, cantidad: 12 }] });
  ok(cot, 'cotizar');
  assert.equal(cot.datos.items[0].tarifa, 'mayor');
  assert.equal(cot.datos.subtotal, 36000);

  // Pedido de un cliente nuevo: se crea el cliente con su dirección.
  const d = await a.post('/api/domicilios', { cliente_nombre: 'Cliente domicilio', telefono: '3001112233', direccion: 'Cra 1 # 2-3', barrio: 'Centro', canal: 'whatsapp',
    items: [{ producto_id: p.datos.id, cantidad: 12 }], cargo_envio: 5000, metodo_pago: 'efectivo', paga_con: 50000 });
  ok(d, 'crear domicilio');
  assert.equal(d.datos.estado, 'recibido');
  assert.equal(d.datos.total, 41000);
  assert.equal(d.datos.cambio, 9000);
  assert.ok(d.datos.cliente_id, 'el cliente nuevo queda guardado');
  ok(await a.put(`/api/domicilios/${d.datos.id}`, { indicaciones: 'Portería del conjunto' }), 'editar antes de despachar');
  ok(await a.post(`/api/domicilios/${d.datos.id}/preparar`), 'preparar');
  const desp = await a.post(`/api/domicilios/${d.datos.id}/despachar`, { repartidor_id: rep.datos.id });
  ok(desp, 'despachar');
  assert.equal(desp.datos.estado, 'en_camino');
  assert.equal((await a.put(`/api/domicilios/${d.datos.id}`, { notas: 'x' })).status, 409, 'en camino ya no se edita');
  const stockAntes = (await a.get(`/api/productos/${p.datos.id}`)).datos.stock;
  const ent = await a.post(`/api/domicilios/${d.datos.id}/entregar`, {});
  ok(ent, 'entregar');
  assert.equal(ent.datos.estado, 'entregado');
  assert.ok(ent.datos.venta_id, 'la entrega crea la venta');
  const venta = (await a.get(`/api/ventas/${ent.datos.venta_id}`)).datos;
  assert.equal(venta.total, 41000);
  assert.equal(venta.cargo_domicilio, 5000);
  assert.equal(venta.domicilio_numero, d.datos.numero);
  assert.equal((await a.get(`/api/productos/${p.datos.id}`)).datos.stock, stockAntes - 12, 'descuenta inventario al entregar');
  const comp = await a.get(`/comprobante/${venta.token_publico}`);
  assert.match(comp.datos, /Domicilio/);

  // Cancelación con motivo y resumen.
  const d2 = await a.post('/api/domicilios', { cliente_id: d.datos.cliente_id, items: [{ producto_id: p.datos.id, cantidad: 2 }] });
  ok(d2, 'segundo domicilio (cliente existente, envío sugerido)');
  assert.equal(d2.datos.direccion, 'Cra 1 # 2-3');
  assert.equal((await a.post(`/api/domicilios/${d2.datos.id}/cancelar`, {})).status, 400, 'cancelar pide motivo');
  ok(await a.post(`/api/domicilios/${d2.datos.id}/cancelar`, { motivo: 'El cliente canceló' }), 'cancelar');
  const res = await a.get('/api/domicilios/resumen');
  ok(res, 'resumen');
  assert.ok(res.datos.hoy.entregados >= 1);

  // Permisos: el bodeguero solo consulta; el vendedor toma pedidos pero no despacha.
  const bod = new Cliente(); await bod.entrar('pedro', CLAVES.pedro);
  ok(await bod.get('/api/domicilios'), 'bodega ve domicilios');
  assert.equal((await bod.post('/api/domicilios', { cliente_id: d.datos.cliente_id, items: [{ producto_id: p.datos.id, cantidad: 1 }] })).status, 403);
  const ven = new Cliente(); await ven.entrar('carlos', CLAVES.carlos);
  const d3 = await ven.post('/api/domicilios', { cliente_id: d.datos.cliente_id, items: [{ producto_id: p.datos.id, cantidad: 1 }] });
  ok(d3, 'el vendedor toma un pedido');
  assert.equal((await ven.post(`/api/domicilios/${d3.datos.id}/despachar`, { repartidor_id: rep.datos.id })).status, 403);
});
