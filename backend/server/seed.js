'use strict';
// Datos de demostración de Licores Palmira: catálogo real (113 referencias con precio al detal y al por mayor y su foto),
// proveedores, clientes detal y mayoristas, compras por lotes, 30 días de ventas, créditos a tiendas, gastos de la flota,
// caja del día y domicilios en todos los estados.
// Uso: `npm run seed` (solo si la base está vacía) · `npm run seed -- --forzar` (borra y vuelve a crear).
const fs = require('node:fs');
const path = require('node:path');
const { getDb, DB_PATH, setConfig, asegurarCarpetas } = require('./db');
const seg = require('./seguridad');
const config = require('./config');
const { permisosDeRol } = require('./permisos');
const { hoy, sumarDias, ahora } = require('./util');
const productos = require('./services/productos');
const compras = require('./services/compras');
const ventas = require('./services/ventas');
const creditos = require('./services/creditos');
const caja = require('./services/caja');
const gastos = require('./services/gastos');
const domicilios = require('./services/domicilios');
const inventario = require('./services/inventario');
const archivos = require('./services/archivos');

const DEMO = path.join(__dirname, '..', 'database');

// Generador pseudoaleatorio con semilla: los datos de demostración salen iguales en cada instalación.
function azar(semilla) {
  let a = semilla >>> 0;
  const r = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  r.entre = (min, max) => min + Math.floor(r() * (max - min + 1));
  r.uno = (lista) => lista[Math.floor(r() * lista.length)];
  return r;
}
const dosDig = (n) => String(n).padStart(2, '0');
const textoFecha = (x) => `${x.getFullYear()}-${dosDig(x.getMonth() + 1)}-${dosDig(x.getDate())} ${dosDig(x.getHours())}:${dosDig(x.getMinutes())}:00`;

function sembrar(db, { silencioso = false, fotos = true } = {}) {
  const log = (...a) => { if (!silencioso) console.log(...a); };
  const usuario = (id, nombre, rol) => ({ id, nombre, rol, permisos: permisosDeRol(rol) });
  const rnd = azar(1994); // año de fundación de Licores Palmira

  // ---------- Usuarios ----------
  const USUARIOS = [
    ['Administrador', 'admin', 'Demo2026*Palmira', 'admin'],
    ['Carlos Ocampo', 'carlos', 'Vendedor2026*', 'vendedor'],
    ['Luisa Fernanda Ríos', 'luisa', 'Cajera2026*', 'cajero'],
    ['Pedro Bodega', 'pedro', 'Inventario2026*', 'inventario'],
    ['Contadora', 'conta', 'Consulta2026*', 'consulta'],
  ];
  const ins = db.prepare('INSERT INTO usuarios(nombre, usuario, password_hash, rol, debe_cambiar_clave, email) VALUES (?,?,?,?,0,?)');
  for (const [nombre, u, clave, rol] of USUARIOS) ins.run(nombre, u, seg.hashClaveSync(clave), rol, `${u}@licorespalmira.demo`);
  db.prepare("UPDATE usuarios SET salario_mensual = 1800000, comision_pct = 10, tipo_comercial = 'vendedor' WHERE usuario IN ('carlos','luisa')").run();
  db.prepare("UPDATE usuarios SET tipo_comercial = 'empleador' WHERE usuario = 'admin'").run();
  const admin = usuario(1, 'Administrador', 'admin');
  const carlos = usuario(2, 'Carlos Ocampo', 'vendedor');
  const luisa = usuario(3, 'Luisa Fernanda Ríos', 'cajero');

  setConfig(db, 'negocio_nombre', 'Licores Palmira');
  setConfig(db, 'negocio_direccion', 'Cl. 31 # 37-56, Centro');
  setConfig(db, 'negocio_ciudad', 'Palmira, Valle del Cauca');
  setConfig(db, 'negocio_telefono', '321 867 7680');

  productos.asegurarCategorias(db);
  const cat = (nombre, padre = null) => {
    const f = padre
      ? db.prepare('SELECT id FROM categorias WHERE nombre = ? AND padre_id = ?').get(nombre, padre)
      : db.prepare('SELECT id FROM categorias WHERE nombre = ? AND padre_id IS NULL').get(nombre);
    return f ? f.id : null;
  };

  // ---------- Proveedores (nombres de demostración) ----------
  const insProv = db.prepare('INSERT INTO proveedores(nombre, identificacion, telefono, email, direccion, contacto, notas) VALUES (?,?,?,?,?,?,?)');
  const prov = (...a) => Number(insProv.run(...a).lastInsertRowid);
  const PROV = {
    nacional: prov('Distribuidora de Licores del Valle', null, '602 555 0101', 'pedidos@licoresdelvalle.demo', 'Cali, Zona Industrial', 'Diana Ruiz', 'Aguardientes y rones nacionales. Crédito a 30 días.'),
    importado: prov('Importadora Premium Spirits', null, '601 555 0202', 'ventas@premiumspirits.demo', 'Bogotá, Fontibón', 'Jorge Mora', 'Whisky, tequila, vodka, ginebra, cognac y vinos.'),
    cerveza: prov('Bebidas y Cervezas del Pacífico', null, '602 555 0303', 'palmira@bebidaspacifico.demo', 'Palmira, vía Cali', 'Mauricio Lenis', 'Cervezas, gaseosas, aguas y energizantes. Entrega martes y viernes.'),
    pasabocas: prov('Mayorista Pasabocas Palmira', null, '315 555 0404', null, 'Palmira, Galería Central', 'Doña Gloria', 'Snacks, cigarrillos, desechables y hielo.'),
  };
  const proveedorDe = (categoria) => {
    if (['Aguardiente', 'Ron', 'Cremas y licores', 'Coctelería y mezcladores'].includes(categoria)) return PROV.nacional;
    if (['Cervezas', 'Bebidas y energizantes'].includes(categoria)) return PROV.cerveza;
    if (['Snacks y pasabocas', 'Cigarrillos', 'Vaporizadores', 'Desechables y hielo'].includes(categoria)) return PROV.pasabocas;
    return PROV.importado;
  };

  // ---------- Clientes detal y mayoristas ----------
  const insCli = db.prepare('INSERT INTO clientes(nombre, telefono, identificacion, direccion, barrio, tipo_cliente, notas) VALUES (?,?,?,?,?,?,?)');
  const cli = (...a) => Number(insCli.run(...a).lastInsertRowid);
  const C = {
    ana: cli('Ana María Torres', '3001234567', '1.112.345.678', 'Cra 28 # 42-15', 'Las Mercedes', 'detal', null),
    jhon: cli('Jhon Jairo Pérez', '3109876543', '94.123.456', 'Cl. 23 # 30-08', 'Zamorano', 'detal', null),
    valentina: cli('Valentina Gómez', '3155550001', null, 'Cra 33 # 19-40, apto 302', 'Versalles', 'detal', 'Pide domicilio los viernes'),
    mateo: cli('Mateo Ramírez', '3205550003', '1.113.000.111', 'Cl. 47 # 25-12', 'Santa Rita', 'detal', null),
    sofia: cli('Sofía Castro', '3015550004', null, 'Cra 24 # 31-09', 'Colombia', 'detal', null),
    andres: cli('Andrés Felipe Ocampo', '3175550005', null, 'Cl. 35 # 40-21', 'Centro', 'detal', null),
    esquina: cli('Tienda La Esquina de Zamorano', '3165550010', null, 'Cra 30 # 24-02', 'Zamorano', 'mayorista', 'Tienda de barrio. Compra cerveza y aguardiente cada semana. Crédito a 15 días.'),
    trapiche: cli('Bar El Trapiche', '3185550011', null, 'Cl. 30 # 29-45', 'Centro', 'mayorista', 'Bar. Pedido grande jueves y viernes.'),
    eventos: cli('Eventos y Banquetes del Valle', '3125550012', null, 'Km 2 vía Candelaria', 'La Emilia', 'mayorista', 'Bodas, grados y eventos de empresa.'),
    estanco: cli('Estanco Las Palmas', '3145550013', null, 'Cra 19 # 47-30', 'Las Palmas', 'mayorista', null),
  };

  // ---------- Productos con su foto ----------
  const catalogo = JSON.parse(fs.readFileSync(path.join(DEMO, 'catalogo-palmira.json'), 'utf8'));
  const P = {};
  const lista = [];
  for (const p of catalogo) {
    const categoriaId = cat(p.categoria);
    const nombre = p.presentacion && p.presentacion !== 'Kit' && !p.nombre.includes(p.presentacion) ? `${p.nombre} ${p.presentacion}` : p.nombre;
    const id = productos.crear(db, {
      nombre, categoria_id: categoriaId, subcategoria_id: p.subcategoria ? cat(p.subcategoria, categoriaId) : null,
      marca: p.marca, capacidad: p.presentacion, modelo_compatible: p.variedad, codigo_barras: p.codigo_barras,
      precio_venta: p.precio_venta, precio_mayor: p.precio_mayor, precio_compra: p.costo, stock_minimo: p.stock_minimo,
      ubicacion: ['Cervezas', 'Bebidas y energizantes'].includes(p.categoria) ? 'Cuarto frío' : ['Whisky', 'Tequila y mezcal', 'Brandy y cognac'].includes(p.categoria) ? 'Vitrina premium' : 'Bodega piso 1',
    }, admin).id;
    P[p.ref] = { id, ...p, nombre };
    lista.push(P[p.ref]);
    const foto = path.join(DEMO, 'demo-fotos', `${p.ref}.webp`);
    if (fotos && fs.existsSync(foto)) {
      const a = archivos.guardarDesdeBase64(fs.readFileSync(foto).toString('base64'), 'image/webp', `${p.ref}.webp`);
      productos.agregarFoto(db, id, a, admin);
    }
  }

  const h = hoy();
  const d = (n) => sumarDias(h, -n);
  const hora = (dias, hh, mm) => `${d(dias)} ${dosDig(hh)}:${dosDig(mm)}:00`;

  // ---------- Compras: surtido inicial (hace 40 días) y reposiciones ----------
  const UNIDADES = { Cervezas: [600, 960], 'Bebidas y energizantes': [120, 240], Aguardiente: [180, 300], Ron: [72, 120], Whisky: [24, 48], 'Tequila y mezcal': [12, 24],
    Vodka: [12, 24], Ginebra: [6, 18], 'Vinos y espumosos': [12, 30], 'Cremas y licores': [12, 24], 'Brandy y cognac': [6, 12], 'Coctelería y mezcladores': [12, 36],
    'Snacks y pasabocas': [24, 60], Cigarrillos: [20, 50], Vaporizadores: [6, 10], 'Desechables y hielo': [30, 80], 'Anchetas y regalos': [4, 8] };
  const porProveedor = new Map();
  for (const p of lista) {
    const pv = proveedorDe(p.categoria);
    if (!porProveedor.has(pv)) porProveedor.set(pv, []);
    const [a, b] = UNIDADES[p.categoria] || [12, 24];
    // Algunas referencias quedan cortas a propósito para que el Inicio muestre qué reponer.
    const cantidad = ['p13', 'p38', 'p52', 'p80'].includes(p.ref) ? rnd.entre(2, 4) : rnd.entre(a, b);
    porProveedor.get(pv).push({ producto_id: p.id, cantidad, costo_unitario: p.costo });
  }
  const FACT = { [PROV.nacional]: 'DLV-', [PROV.importado]: 'IPS-', [PROV.cerveza]: 'BCP-', [PROV.pasabocas]: 'MPP-' };
  for (const [pv, items] of porProveedor) {
    const total = items.reduce((s, it) => s + it.cantidad * it.costo_unitario, 0);
    const pagado = pv === PROV.importado ? Math.round(total * 0.6 / 1000) * 1000 : total;
    compras.crear(db, { proveedor_id: pv, fecha: hora(40, 9, 30), numero_factura: FACT[pv] + rnd.entre(10200, 10900), items,
      costos_adicionales: pv === PROV.importado ? 180000 : 0, valor_pagado: pagado, metodo_pago: 'transferencia',
      fecha_vencimiento: pv === PROV.importado ? d(10) : null, notas: 'Surtido inicial de la temporada' }, admin);
  }
  // Reposición de lo que más rota a un costo distinto: segundo lote para ver el FIFO en acción.
  compras.crear(db, { proveedor_id: PROV.cerveza, fecha: hora(18, 10, 0), numero_factura: 'BCP-' + rnd.entre(11000, 11500), items: [
    { producto_id: P.p63.id, cantidad: 360, costo_unitario: 2650 }, { producto_id: P.p64.id, cantidad: 240, costo_unitario: 2650 },
    { producto_id: P.p65.id, cantidad: 144, costo_unitario: 2700 }, { producto_id: P.p66.id, cantidad: 120, costo_unitario: 3300 },
    { producto_id: P.p89.id, cantidad: 48, costo_unitario: 4750 }, { producto_id: P.p92.id, cantidad: 48, costo_unitario: 5800 },
  ], valor_pagado: 0, metodo_pago: 'transferencia', fecha_vencimiento: d(-12) }, admin);
  compras.crear(db, { proveedor_id: PROV.nacional, fecha: hora(12, 11, 15), numero_factura: 'DLV-' + rnd.entre(11000, 11500), items: [
    { producto_id: P.p27.id, cantidad: 96, costo_unitario: 43000 }, { producto_id: P.p28.id, cantidad: 48, costo_unitario: 40900 },
    { producto_id: P.p30.id, cantidad: 48, costo_unitario: 38800 }, { producto_id: P.p17.id, cantidad: 36, costo_unitario: 43700 },
  ], valor_pagado: 3000000, metodo_pago: 'transferencia', fecha_vencimiento: d(-3), notas: 'Pedido de quincena' }, admin);
  compras.crear(db, { proveedor_id: PROV.nacional, fecha: hora(3, 9, 10), numero_factura: 'DLV-' + rnd.entre(11600, 11900), items: [
    { producto_id: P.p27.id, cantidad: 120, costo_unitario: 43200 }, { producto_id: P.p17.id, cantidad: 48, costo_unitario: 43900 }, { producto_id: P.p28.id, cantidad: 48, costo_unitario: 41000 },
  ], valor_pagado: 0, metodo_pago: 'transferencia', fecha_vencimiento: d(-27), notas: 'Pedido para el puente festivo' }, admin);
  compras.crear(db, { proveedor_id: PROV.cerveza, fecha: hora(2, 10, 30), numero_factura: 'BCP-' + rnd.entre(11600, 11900), items: [
    { producto_id: P.p63.id, cantidad: 480, costo_unitario: 2650 }, { producto_id: P.p66.id, cantidad: 96, costo_unitario: 3300 }, { producto_id: P.p89.id, cantidad: 96, costo_unitario: 4750 },
  ], valor_pagado: 1700000, metodo_pago: 'transferencia', fecha_vencimiento: d(-12) }, admin);
  compras.crear(db, { proveedor_id: PROV.pasabocas, fecha: hora(4, 8, 45), items: [
    { producto_id: P.p108.id, cantidad: 60, costo_unitario: 6800 }, { producto_id: P.p106.id, cantidad: 40, costo_unitario: 5600 }, { producto_id: P.p99.id, cantidad: 30, costo_unitario: 6300 },
  ], valor_pagado: 821000, metodo_pago: 'efectivo' }, admin);

  // ---------- Ventas de los últimos 30 días ----------
  // Canastas típicas de una licorera: [referencia, mínimo, máximo].
  const CANASTAS = [
    [['p27', 1, 2], ['p63', 6, 12], ['p108', 1, 1]],          // aguardiente + cerveza + hielo
    [['p17', 1, 1], ['p89', 1, 2], ['p108', 1, 1]],            // ron + Coca-Cola + hielo
    [['p01', 1, 1]], [['p02', 1, 1]], [['p03', 1, 1], ['p94', 2, 4]],
    [['p63', 6, 24]], [['p64', 6, 12]], [['p66', 6, 12]], [['p65', 6, 12]],
    [['p28', 1, 2], ['p99', 1, 2]], [['p30', 1, 2]], [['p35', 1, 1], ['p86', 2, 4]],
    [['p73', 1, 1]], [['p54', 1, 2]], [['p43', 1, 1], ['p96', 1, 2]], [['p49', 1, 1], ['p91', 2, 4]],
    [['p92', 2, 4]], [['p05', 1, 1]], [['p19', 1, 1], ['p89', 1, 1]], [['p86', 4, 6]], [['p102', 1, 2], ['p63', 6, 6]],
    [['p110', 1, 1]], [['p61', 1, 1]], [['p22', 1, 1]], [['p79', 1, 1]], [['p13', 1, 1]], [['p38', 1, 1]],
  ];
  const METODOS = ['efectivo', 'efectivo', 'efectivo', 'nequi', 'transferencia', 'tarjeta', 'daviplata', 'qr'];
  const DETAL = [C.ana, C.jhon, C.valentina, C.mateo, C.sofia, C.andres];
  const stock = (id) => inventario.stockDe(db, id);
  const armar = (canasta) => canasta.map(([ref, a, b]) => ({ producto_id: P[ref].id, cantidad: rnd.entre(a, b) })).filter((it) => stock(it.producto_id) >= it.cantidad);
  const precioEstimado = (items, mayorista) => items.reduce((s, it) => {
    const p = lista.find((x) => x.id === it.producto_id);
    const mayor = p.precio_mayor > 0 && (mayorista || it.cantidad >= 10);
    return s + it.cantidad * (mayor ? p.precio_mayor : p.precio_venta);
  }, 0);
  const vender = (fecha, u, datos) => { try { return ventas.crear(db, { fecha, ...datos }, u); } catch (e) { if (e.codigo !== 'stock_insuficiente') throw e; return null; } };

  // Venta suelta de cualquier referencia del catálogo (para que todo el inventario tenga movimiento).
  const sueltos = lista.filter((p) => !['Anchetas y regalos', 'Vaporizadores'].includes(p.categoria));
  for (let dias = 38; dias >= 1; dias--) {
    const fecha = new Date(`${d(dias)}T12:00:00`);
    const finDeSemana = [0, 5, 6].includes(fecha.getDay()); // viernes, sábado y domingo se vende más
    const n = finDeSemana ? rnd.entre(9, 14) : rnd.entre(5, 9);
    for (let k = 0; k < n; k++) {
      const items = armar(rnd.uno(CANASTAS));
      if (!items.length) continue;
      const total = precioEstimado(items, false);
      const cliente = rnd() < 0.35 ? rnd.uno(DETAL) : undefined;
      vender(hora(dias, rnd.entre(9, 21), rnd.entre(0, 59)), rnd() < 0.55 ? carlos : luisa, { cliente_id: cliente, items, pagos: [{ metodo_pago: rnd.uno(METODOS), valor: total }], canal_origen: rnd() < 0.2 ? 'whatsapp' : 'presencial' });
    }
    for (let k = rnd.entre(2, 4); k > 0; k--) {
      const p = rnd.uno(sueltos);
      const cantidad = p.categoria === 'Cervezas' ? 6 : 1;
      if (stock(p.id) < cantidad + 2) continue;
      vender(hora(dias, rnd.entre(10, 21), rnd.entre(0, 59)), rnd() < 0.5 ? carlos : luisa, { items: [{ producto_id: p.id, cantidad }], pagos: [{ metodo_pago: rnd.uno(METODOS), valor: cantidad * p.precio_venta }] });
    }
    // Mayoristas: pedidos grandes con tarifa mayor; las tiendas pagan la mitad y el resto a 15 días.
    if (dias % 4 === 0 || (finDeSemana && rnd() < 0.5)) {
      const cliente = rnd.uno([C.esquina, C.trapiche, C.estanco, C.eventos]);
      const items = armar([['p63', 24, 48], ['p27', 12, 24], ['p17', 6, 12], ['p89', 6, 12]].filter(() => rnd() < 0.8));
      if (items.length) {
        const total = precioEstimado(items, true);
        const credito = cliente !== C.trapiche && rnd() < 0.6;
        const pagado = credito ? Math.round(total * 0.5 / 1000) * 1000 : total;
        vender(hora(dias, rnd.entre(9, 12), rnd.entre(0, 59)), carlos, {
          cliente_id: cliente, items, pagos: [{ metodo_pago: 'transferencia', valor: pagado }], canal_origen: 'whatsapp',
          credito: credito ? { numero_cuotas: 1, frecuencia: 'quincenal', primera_fecha: sumarDias(d(dias), 15), condiciones: 'Saldo a 15 días (tienda)' } : undefined,
        });
      }
    }
  }

  // Abonos de las tiendas
  for (const c of [C.esquina, C.estanco, C.eventos]) {
    const cr = db.prepare("SELECT id, saldo_actual FROM creditos WHERE cliente_id = ? AND estado NOT IN ('pagado','anulado') ORDER BY id LIMIT 1").get(c);
    if (cr && cr.saldo_actual > 0) creditos.abonar(db, cr.id, { valor: Math.max(1000, Math.round(cr.saldo_actual * 0.6 / 1000) * 1000), metodo_pago: 'transferencia', fecha: d(3), referencia: 'TR-' + rnd.entre(10000, 99999) }, luisa);
  }

  // Devolución: una botella que llegó con el sello roto (no vuelve al inventario)
  const ventaDev = db.prepare("SELECT v.id FROM ventas v JOIN venta_items vi ON vi.venta_id = v.id WHERE vi.producto_id = ? AND v.estado = 'confirmada' AND v.fecha < ? ORDER BY v.id DESC LIMIT 1").get(P.p28.id, d(2));
  if (ventaDev) {
    const item = db.prepare('SELECT id FROM venta_items WHERE venta_id = ? AND producto_id = ?').get(ventaDev.id, P.p28.id);
    ventas.devolver(db, ventaDev.id, { items: [{ venta_item_id: item.id, cantidad: 1, reingresa: false }], motivo: 'Botella con el sello de seguridad roto', reintegro_metodo: 'efectivo' }, luisa);
  }

  // ---------- Gastos del mes ----------
  gastos.crear(db, { categoria: 'Arriendo', descripcion: 'Arriendo local y bodega', valor: 4800000, metodo_pago: 'transferencia', fecha: d(9) }, admin);
  gastos.crear(db, { categoria: 'Servicios públicos', descripcion: 'Energía (cuarto frío incluido)', valor: 1250000, metodo_pago: 'transferencia', fecha: d(6) }, admin);
  gastos.crear(db, { categoria: 'Combustible y flota', descripcion: 'Gasolina motos de domicilio (semana)', valor: 420000, metodo_pago: 'efectivo', fecha: d(7) }, luisa);
  gastos.crear(db, { categoria: 'Combustible y flota', descripcion: 'Gasolina motos de domicilio (semana)', valor: 395000, metodo_pago: 'efectivo', fecha: d(1) }, luisa);
  gastos.crear(db, { categoria: 'Mantenimiento de vehículos', descripcion: 'Cambio de aceite y pastillas · moto 03', valor: 185000, metodo_pago: 'efectivo', fecha: d(5) }, admin);
  gastos.crear(db, { categoria: 'Publicidad', descripcion: 'Pauta Instagram · fin de semana', valor: 150000, metodo_pago: 'tarjeta', fecha: d(4) }, admin);

  // ---------- Repartidores (flota propia) ----------
  const R = [
    domicilios.guardarRepartidor(db, null, { nombre: 'Jhonatan Mina', telefono: '3125550101', vehiculo: 'Moto AKT 125', placa: 'ABC12F' }, admin),
    domicilios.guardarRepartidor(db, null, { nombre: 'Yeison Caicedo', telefono: '3135550102', vehiculo: 'Moto Honda CB 125', placa: 'JKL45E' }, admin),
    domicilios.guardarRepartidor(db, null, { nombre: 'Wilmar Ortiz', telefono: '3145550103', vehiculo: 'Moto Suzuki GN 125', placa: 'MNO78D' }, admin),
    domicilios.guardarRepartidor(db, null, { nombre: 'Don Hernando', telefono: '3155550104', vehiculo: 'Furgón NHR (pedidos grandes)', placa: 'TPX512' }, admin),
  ];

  const tomar = (clienteId, items, extra = {}) => {
    const c = db.prepare('SELECT * FROM clientes WHERE id = ?').get(clienteId);
    return domicilios.crear(db, { cliente_id: c.id, cliente_nombre: c.nombre, telefono: c.telefono, direccion: c.direccion, barrio: c.barrio, canal: 'whatsapp',
      items: items.map(([ref, cantidad]) => ({ producto_id: P[ref].id, cantidad })), metodo_pago: 'efectivo', ...extra }, luisa);
  };
  // Pone a un domicilio (y a su venta) las horas reales del recorrido: base = hora en que se tomó el pedido.
  const fijarHoras = (dom, base, { prep, salida, entrega } = {}) => {
    const t = (min) => (min === undefined || min === null ? null : textoFecha(new Date(new Date(base.replace(' ', 'T')).getTime() + min * 60000)));
    db.prepare('UPDATE domicilios SET fecha = ?, preparado_en = COALESCE(?, preparado_en), despachado_en = COALESCE(?, despachado_en), entregado_en = COALESCE(?, entregado_en), actualizado_en = ? WHERE id = ?')
      .run(base, t(prep), t(salida), t(entrega), t(entrega ?? salida ?? prep ?? 0), dom.id);
    if (dom.venta_id && entrega !== undefined) {
      db.prepare('UPDATE ventas SET fecha = ? WHERE id = ?').run(t(entrega), dom.venta_id);
      db.prepare('UPDATE pagos SET fecha = ? WHERE venta_id = ?').run(t(entrega), dom.venta_id);
      db.prepare("UPDATE movimientos SET fecha = ? WHERE referencia_tipo = 'venta' AND referencia_id = ?").run(t(entrega), dom.venta_id);
    }
  };

  // Domicilios entregados en días anteriores.
  const PEDIDOS = [
    [C.valentina, [['p27', 1], ['p63', 12], ['p108', 1]]], [C.ana, [['p01', 1], ['p94', 3]]], [C.mateo, [['p17', 2], ['p89', 2]]],
    [C.sofia, [['p73', 1], ['p100', 2]]], [C.andres, [['p63', 24]]], [C.jhon, [['p30', 2], ['p99', 1]]], [C.valentina, [['p35', 1], ['p86', 4]]],
    [C.trapiche, [['p63', 48], ['p27', 12]]], [C.ana, [['p54', 2]]], [C.mateo, [['p02', 1]]], [C.sofia, [['p66', 12], ['p108', 1]]], [C.andres, [['p28', 2], ['p63', 6]]],
  ];
  PEDIDOS.forEach(([clienteId, items], i) => {
    const dias = 1 + Math.floor(i * 2.4);
    let dom;
    try { dom = tomar(clienteId, items, i % 3 === 0 ? { metodo_pago: 'nequi' } : { paga_con: 200000 }); } catch { return; }
    try {
      domicilios.cambiarEstado(db, dom.id, 'despachar', { repartidor_id: R[clienteId === C.trapiche ? 3 : i % 3].id }, luisa);
      dom = domicilios.cambiarEstado(db, dom.id, 'entregar', {}, luisa);
      fijarHoras(dom, hora(dias, rnd.entre(17, 21), rnd.entre(0, 59)), { prep: 6, salida: rnd.entre(10, 18), entrega: rnd.entre(28, 52) });
    } catch { db.prepare('DELETE FROM domicilios WHERE id = ?').run(dom.id); }
  });

  // ---------- Hoy: caja abierta, ventas del día y domicilios en curso ----------
  const ahoraD = new Date();
  const minutosHoy = ahoraD.getHours() * 60 + ahoraD.getMinutes();
  const haceMin = (min) => textoFecha(new Date(ahoraD.getTime() - Math.max(0, Math.min(min, minutosHoy)) * 60000));
  caja.abrir(db, { base_inicial: 300000, notas: 'Apertura del turno' }, luisa);
  const ventasHoy = [
    [carlos, [['p27', 2], ['p63', 12], ['p108', 1]], 'efectivo'], [luisa, [['p01', 1]], 'tarjeta'], [carlos, [['p66', 6], ['p97', 2]], 'nequi'],
    [luisa, [['p17', 1], ['p89', 1]], 'efectivo'], [carlos, [['p63', 30]], 'transferencia', C.esquina], [luisa, [['p92', 4]], 'efectivo'],
  ];
  ventasHoy.forEach(([u, items, metodo, cliente], i) => {
    const its = items.map(([ref, cantidad]) => ({ producto_id: P[ref].id, cantidad })).filter((it) => stock(it.producto_id) >= it.cantidad);
    if (!its.length) return;
    vender(haceMin((ventasHoy.length - i) * 50), u, { cliente_id: cliente, items: its, pagos: [{ metodo_pago: metodo, valor: precioEstimado(its, cliente === C.esquina) }] });
  });
  gastos.crear(db, { categoria: 'Hielo y desechables', descripcion: 'Bolsas de hielo extra para el fin de semana', valor: 54000, metodo_pago: 'efectivo' }, luisa);

  // Domicilios de hoy: uno entregado, uno en camino (atrasado), uno en preparación, dos recibidos y uno cancelado.
  const hoyDom = (clienteId, items, estado, minutos, extra = {}) => {
    let dom;
    try { dom = tomar(clienteId, items, extra); } catch { return null; }
    const base = haceMin(minutos);
    const atras = Math.min(minutos, minutosHoy);
    try {
      if (estado === 'entregado') {
        domicilios.cambiarEstado(db, dom.id, 'despachar', { repartidor_id: R[0].id }, luisa);
        dom = domicilios.cambiarEstado(db, dom.id, 'entregar', {}, luisa);
        fijarHoras(dom, base, { prep: Math.round(atras * 0.1), salida: Math.round(atras * 0.2), entrega: Math.round(atras * 0.45) });
      } else if (estado === 'en_camino') {
        domicilios.cambiarEstado(db, dom.id, 'despachar', { repartidor_id: R[1].id }, luisa);
        fijarHoras(dom, base, { prep: Math.round(atras * 0.05), salida: Math.round(atras * 0.12) });
      } else if (estado === 'en_preparacion') {
        domicilios.cambiarEstado(db, dom.id, 'preparar', {}, luisa);
        fijarHoras(dom, base, { prep: Math.round(atras * 0.3) });
      } else if (estado === 'cancelado') {
        domicilios.cambiarEstado(db, dom.id, 'cancelar', { motivo: 'El cliente no estaba en la dirección y no contestó' }, luisa);
        fijarHoras(dom, base, {});
      } else fijarHoras(dom, base, {});
    } catch { /* demostración: si algo no alcanza, el pedido queda recibido */ }
    return dom;
  };
  hoyDom(C.valentina, [['p27', 1], ['p63', 12], ['p108', 1]], 'entregado', 150, { paga_con: 100000 });
  hoyDom(C.trapiche, [['p63', 48], ['p28', 12], ['p89', 12]], 'en_camino', 95, { metodo_pago: 'transferencia', notas: 'Entregar por la puerta de atrás del bar' });
  hoyDom(C.mateo, [['p02', 1], ['p94', 4], ['p108', 1]], 'en_preparacion', 14, { paga_con: 300000 });
  hoyDom(C.sofia, [['p73', 1], ['p110', 1]], 'recibido', 9, { metodo_pago: 'nequi', indicaciones: 'Es un regalo: no tocar el timbre, llamar al llegar' });
  hoyDom(C.andres, [['p66', 12], ['p99', 2]], 'recibido', 4, { hora_compromiso: '20:30' });
  hoyDom(C.jhon, [['p30', 1]], 'cancelado', 70);

  log('Datos de demostración de Licores Palmira creados.');
  log('Usuarios: admin / Demo2026*Palmira  ·  carlos / Vendedor2026* (vendedor)  ·  luisa / Cajera2026* (cajera)  ·  pedro / Inventario2026* (bodega)  ·  conta / Consulta2026*');
  return { productos: lista.length, generado: ahora() };
}

if (require.main === module) {
  const forzar = process.argv.includes('--forzar');
  if (config.PRODUCCION && !process.argv.includes('--permitir-produccion')) {
    console.error('Los datos de demostración no se cargan en producción (crean usuarios con contraseñas conocidas).\nPara el primer administrador usa INITIAL_ADMIN_USER / INITIAL_ADMIN_PASSWORD o `npm run crear-admin`.');
    process.exit(1);
  }
  asegurarCarpetas();
  if (forzar && fs.existsSync(DB_PATH)) {
    for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suf); } catch { /* no existe */ } }
    console.log('Base de datos anterior eliminada.');
  }
  const db = getDb();
  if (db.prepare('SELECT COUNT(*) n FROM usuarios').get().n > 0) {
    console.log(`La base ${DB_PATH} ya tiene datos. Usa --forzar para recrearla.`);
    process.exit(0);
  }
  sembrar(db);
  console.log('Base de datos:', DB_PATH);
}

module.exports = { sembrar };
