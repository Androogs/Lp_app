'use strict';
// OCR de facturas con visión de Claude (SDK oficial @anthropic-ai/sdk) y salida estructurada.
// Requiere ANTHROPIC_API_KEY en el entorno. Sin clave, el documento queda en la bandeja para captura manual.
const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { getConfig } = require('../db');
const { leerComoBase64 } = require('./archivos');

const ItemSchema = z.object({
  descripcion: z.string().describe('Nombre o descripción del producto tal como aparece'),
  cantidad: z.number().describe('Cantidad comprada; 1 si no se indica'),
  costo_unitario: z.number().describe('Precio unitario en pesos sin separadores; 0 si no se ve'),
  total: z.number().describe('Total de la línea en pesos; 0 si no se ve'),
  referencia: z.string().nullable().describe('Código, referencia o modelo si aparece'),
});
const FacturaSchema = z.object({
  es_factura: z.boolean().describe('true si el documento es una factura, cuenta de cobro, remisión o comprobante de compra'),
  proveedor: z.string().nullable().describe('Nombre o razón social de quien vende'),
  identificacion_proveedor: z.string().nullable().describe('NIT o cédula del proveedor'),
  telefono_proveedor: z.string().nullable(),
  numero_factura: z.string().nullable().describe('Número de factura, remisión o comprobante'),
  fecha: z.string().nullable().describe('Fecha del documento en formato AAAA-MM-DD'),
  items: z.array(ItemSchema),
  subtotal: z.number().nullable(),
  descuento: z.number().nullable(),
  impuestos: z.number().nullable().describe('IVA u otros impuestos en pesos'),
  costos_adicionales: z.number().nullable().describe('Fletes, transporte u otros cobros'),
  total: z.number().nullable().describe('Total a pagar en pesos'),
  metodo_pago: z.string().nullable(),
  observaciones: z.string().nullable().describe('Notas relevantes, p. ej. condiciones de pago o vencimiento'),
  confianza: z.number().describe('Confianza general de 0 a 1 sobre la lectura'),
});

function disponible() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

let cliente = null;
function getCliente() {
  if (!cliente) cliente = new Anthropic();
  return cliente;
}

const INSTRUCCIONES = `Eres el asistente de captura de compras de una licorera en Colombia (whisky, ron, aguardiente, tequila, vinos, cervezas,
mezcladores, snacks y desechables). Los proveedores son licoreras departamentales, importadores y distribuidores mayoristas.
Lee el documento adjunto (factura, remisión, cuenta de cobro o comprobante) y extrae los datos para registrar la compra.
Reglas:
- Los valores van en pesos colombianos como números enteros sin separadores de miles (ej. 1250000). Si el documento usa punto como separador de miles, interprétalo así.
- Si un dato no aparece, usa null (o 0 en cantidades y valores de ítems).
- La fecha va en formato AAAA-MM-DD. Si solo ves día y mes, asume el año actual.
- Incluye todos los ítems de la factura, uno por línea de producto, con su cantidad, precio unitario y total.
- En el nombre del producto conserva la presentación (750 ml, 1000 ml, lata 330 ml) y la edad o variedad (12 años, reposado, tapa azul).
- Si la factura viene por cajas o pacas, convierte la cantidad a unidades (botellas o latas) cuando el documento indique cuántas trae cada caja.
- El impuesto al consumo de licores va incluido en el costo del producto; el IVA, si aparece aparte, va en impuestos.
- Si el documento no es una factura o comprobante de compra, marca es_factura=false y deja lo demás vacío.`;

async function extraerFactura(db, ruta, mimeArchivo) {
  if (!disponible()) {
    const e = new Error('OCR no configurado: falta ANTHROPIC_API_KEY en el servidor');
    e.status = 503;
    e.codigo = 'ocr_no_configurado';
    throw e;
  }
  const { mime, data } = leerComoBase64(ruta);
  const tipo = mimeArchivo || mime;
  const bloque = tipo === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
    : { type: 'image', source: { type: 'base64', media_type: tipo, data } };
  const modelo = getConfig(db, 'ocr_modelo') || 'claude-opus-5-5';
  const respuesta = await getCliente().beta.messages.parse({
    model: modelo,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: INSTRUCCIONES,
    messages: [{ role: 'user', content: [bloque, { type: 'text', text: 'Extrae los datos de esta factura de compra.' }] }],
    output_config: { format: zodOutputFormat(FacturaSchema) },
  });
  if (respuesta.stop_reason === 'refusal') {
    const e = new Error('El servicio de lectura rechazó el documento');
    e.status = 422;
    throw e;
  }
  const datos = respuesta.parsed_output;
  if (!datos) {
    const e = new Error('No se pudo interpretar la respuesta del OCR');
    e.status = 502;
    throw e;
  }
  return { ...datos, modelo: respuesta.model, uso: respuesta.usage ? { entrada: respuesta.usage.input_tokens, salida: respuesta.usage.output_tokens } : null };
}

// Empareja cada ítem leído con productos del catálogo (por referencia o nombre parecido) para la pantalla de revisión.
function sugerirProductos(db, datos) {
  const items = (datos.items || []).map((it) => {
    const candidatos = [];
    const ref = it.referencia && String(it.referencia).trim();
    if (ref) candidatos.push(...db.prepare('SELECT id, nombre, referencia, precio_compra, requiere_serial FROM productos WHERE (referencia = ? OR sku = ? OR codigo_barras = ?) AND estado <> \'inactivo\' LIMIT 3').all(ref, ref, ref));
    const palabras = String(it.descripcion || '').split(/\s+/).filter((p) => p.length > 2).slice(0, 4);
    if (palabras.length) {
      const cond = palabras.map(() => 'p.nombre LIKE ?').join(' AND ');
      candidatos.push(...db.prepare(`SELECT id, nombre, referencia, precio_compra, requiere_serial FROM productos p WHERE ${cond} AND estado <> 'inactivo' LIMIT 3`).all(...palabras.map((p) => `%${p}%`)));
      if (!candidatos.length && palabras.length > 1) {
        candidatos.push(...db.prepare('SELECT id, nombre, referencia, precio_compra, requiere_serial FROM productos p WHERE p.nombre LIKE ? AND estado <> \'inactivo\' LIMIT 3').all(`%${palabras[0]}%`));
      }
    }
    const vistos = new Set();
    const unicos = candidatos.filter((c) => !vistos.has(c.id) && vistos.add(c.id));
    return { ...it, producto_sugerido: unicos[0] || null, candidatos: unicos };
  });
  let proveedor = null;
  if (datos.proveedor) {
    proveedor = db.prepare('SELECT id, nombre FROM proveedores WHERE activo = 1 AND (nombre LIKE ? OR identificacion = ?) LIMIT 1').get(`%${datos.proveedor.split(' ')[0]}%`, datos.identificacion_proveedor || '')
      || null;
  }
  return { ...datos, items, proveedor_sugerido: proveedor };
}

module.exports = { disponible, extraerFactura, sugerirProductos, FacturaSchema };
