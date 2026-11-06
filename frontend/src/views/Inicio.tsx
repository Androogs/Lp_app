// Inicio · "centro del día". No repite el menú lateral: muestra lo que importa hoy.
//  1. Encabezado: fecha y hora en vivo, saludo con el nombre, resumen en una frase y acciones frecuentes.
//  2. Estado de la caja.  3. Indicadores (según permisos).  4. Pendientes priorizados.
//  5. Últimas ventas y, para el vendedor, su resumen del mes.
// La esquina inferior derecha queda libre para el botón flotante del asistente.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { estado } from '../lib/estado';
import { fmt, hoyISO, plural } from '../lib/formato';
import type { Topbar } from '../lib/tipos';
import { Icono } from '../components/Icono';
import { minigrafica } from '../legacy/charts.js';
import { abrirGlosario, guiaBienvenida } from '../legacy/ayuda.js';

// ---------- Datos del panel (/api/analitica/panel) ----------
interface Variacion { pct: number | null; diferencia: number | null }
interface PuntoSerie { clave: string; netas: number }
interface Cuota { fecha_vencimiento: string; pendiente: number; cliente: string }
interface VentaReciente { id: number; numero: string; fecha: string; total: number; tipo_pago: string; estado: string; cliente: string | null }
interface Panel {
  kpis: {
    ventas_hoy?: { total: number; cantidad: number; variacion: Variacion };
    ventas_mes?: { total: number; cantidad: number; variacion: Variacion };
    por_cobrar?: { pendiente: number; vigentes: number; vencidos: number; saldo_vencido: number; por_pagar: number; facturas_pendientes: number; facturas_vencidas: number };
    inventario?: { unidades: number; productos: number };
    stock_bajo?: { pocas: number; agotados: number; total: number };
  };
  serie_hoy?: { puntos: PuntoSerie[] };
  serie_mes?: { puntos: PuntoSerie[] };
  alertas?: { cuotas_vencidas?: Cuota[]; cuotas_por_vencer?: Cuota[]; stock_bajo?: { nombre: string }[]; dias_alerta?: number };
  ultimas_ventas?: VentaReciente[];
  documentos_pendientes?: number;
  domicilios?: {
    por_despachar: number; en_camino: number;
    atrasados: { id: number; numero: string; estado: string; cliente_nombre: string; minutos: number; barrio?: string }[];
    hoy: { entregados: number; total: number; envios: number; minutos_promedio: number | null };
    repartidores: { id: number; nombre: string; en_camino: number; entregados_hoy: number }[];
  };
  comisiones?: { alcance: string; vendedor?: { ventas: number; ingreso_neto: number; comision: number } };
}

type Nivel = 'alta' | 'media' | 'info';
interface Pendiente { nivel: Nivel; icono: string; titulo: string; detalle: string; href: string }

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const saludo = (d: Date) => { const h = d.getHours(); return h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches'; };
const fechaLarga = (d: Date) => `${DIAS[d.getDay()]} ${d.getDate()} de ${MESES[d.getMonth()]}`;
const horaCorta = (d: Date) => d.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' });
const horaDe = (t?: string | null) => (t ? String(t).slice(11, 16) : '');
function primerNombre(): string {
  const u = estado.usuario;
  const n = String(u?.nombre || '').trim().split(/\s+/)[0];
  return n || String(u?.usuario || '').trim();
}
// Serie acumulada: la minigráfica muestra el avance del día o del mes.
function acumulada(puntos: PuntoSerie[] = [], hasta: string): number[] {
  let s = 0; const r: number[] = [];
  for (const p of puntos) { if (p.clave > hasta) break; s += Number(p.netas) || 0; r.push(s); }
  return r;
}

function acciones() {
  return [
    estado.tiene('ventas.crear') && { href: '#/vender', icono: 'cart', texto: 'Nueva venta' },
    estado.tiene('domicilios.crear') && { href: '#/domicilios/nuevo', icono: 'moto', texto: 'Nuevo domicilio' },
    estado.tiene('compras.crear') && { href: '#/compras/nueva', icono: 'truck', texto: 'Registrar compra' },
    estado.tiene('inventario.editar') && { href: '#/inventario/nuevo', icono: 'plus', texto: 'Agregar producto' },
    estado.tiene('creditos.abonar') && { href: '#/creditos?abonar=1', icono: 'card', texto: 'Registrar abono' },
  ].filter(Boolean).slice(0, 4) as { href: string; icono: string; texto: string }[];
}

function calcularPendientes(d: Panel): Pendiente[] {
  const lista: Pendiente[] = [];
  const al = d.alertas || {};
  const k = d.kpis || {};
  if (estado.tiene('creditos.ver')) {
    const venc = al.cuotas_vencidas || [];
    if (venc.length) {
      const total = venc.reduce((a, q) => a + (Number(q.pendiente) || 0), 0);
      const nombres = [...new Set(venc.map((q) => q.cliente))];
      lista.push({ nivel: 'alta', icono: 'alert', titulo: plural(venc.length, 'cuota vencida', 'cuotas vencidas'), detalle: `${fmt.cop(total)} · ${nombres.slice(0, 2).join(', ')}${nombres.length > 2 ? ` y ${nombres.length - 2} más` : ''}`, href: '#/creditos?estado=vencido' });
    }
    const prox = al.cuotas_por_vencer || [];
    if (prox.length) lista.push({ nivel: 'media', icono: 'calendar', titulo: plural(prox.length, 'cuota por vencer', 'cuotas por vencer'), detalle: `Próximos ${al.dias_alerta || 7} días · desde el ${fmt.fecha(prox[0].fecha_vencimiento)}`, href: '#/creditos?estado=proximo' });
  }
  const pc = k.por_cobrar;
  if (estado.tieneAlguno('compras.ver', 'compras.pagar') && pc && pc.facturas_pendientes) {
    lista.push({ nivel: pc.facturas_vencidas ? 'alta' : 'media', icono: 'truck', titulo: `${plural(pc.facturas_pendientes, 'factura', 'facturas')} por pagar a proveedores`, detalle: `${fmt.cop(pc.por_pagar)}${pc.facturas_vencidas ? ` · ${plural(pc.facturas_vencidas, 'vencida', 'vencidas')}` : ''}`, href: '#/compras?con_saldo=1' });
  }
  const sb = k.stock_bajo;
  if (estado.tiene('inventario.ver') && sb && sb.total) {
    const ejemplos = (al.stock_bajo || []).slice(0, 2).map((p) => p.nombre);
    lista.push({
      nivel: sb.agotados ? 'alta' : 'media', icono: 'box',
      titulo: sb.agotados ? `${plural(sb.agotados, 'producto agotado', 'productos agotados')}${sb.pocas ? ` y ${fmt.num(sb.pocas)} con pocas unidades` : ''}` : plural(sb.pocas, 'producto con pocas unidades', 'productos con pocas unidades'),
      detalle: ejemplos.length ? `${ejemplos.join(', ')}${sb.total > ejemplos.length ? '…' : ''}` : 'Revisa y programa la próxima compra',
      href: `#/inventario?filtro=${sb.agotados ? 'agotados' : 'stock_bajo'}`,
    });
  }
  if (estado.tiene('documentos.ver') && d.documentos_pendientes) lista.push({ nivel: 'info', icono: 'inbox', titulo: plural(d.documentos_pendientes, 'documento por revisar', 'documentos por revisar'), detalle: 'Facturas recibidas que aún no son compras', href: '#/documentos' });
  const dm = d.domicilios;
  if (dm) {
    if (dm.atrasados.length) lista.push({ nivel: 'alta', icono: 'clock', titulo: plural(dm.atrasados.length, 'domicilio atrasado', 'domicilios atrasados'), detalle: dm.atrasados.slice(0, 2).map((x) => `${x.numero} · ${x.cliente_nombre} (${x.minutos} min)`).join(', '), href: '#/domicilios' });
    const sinAtraso = dm.por_despachar - dm.atrasados.filter((x) => x.estado !== 'en_camino').length;
    if (sinAtraso > 0 && estado.tiene('domicilios.despachar')) lista.push({ nivel: 'media', icono: 'moto', titulo: plural(sinAtraso, 'domicilio por despachar', 'domicilios por despachar'), detalle: 'Pedidos recibidos que aún no salen de la bodega', href: '#/domicilios' });
  }
  if (estado.tiene('caja.operar') && !estado.caja) lista.push({ nivel: 'info', icono: 'cash', titulo: 'La caja no se ha abierto', detalle: 'Ábrela para cuadrar el efectivo al final del día', href: '#/caja' });
  const orden: Record<Nivel, number> = { alta: 0, media: 1, info: 2 };
  return lista.sort((a, b) => orden[a.nivel] - orden[b.nivel]);
}

// ---------- Piezas ----------
function Variacion({ v, base, sinDato }: { v?: Variacion; base: string; sinDato: string }) {
  if (!v || v.pct === null || v.pct === undefined) return <span className="ini-var-txt">{sinDato}</span>;
  const sube = v.pct >= 0;
  return <><span className={`ini-var ${sube ? 'sube' : 'baja'}`}><Icono nombre={sube ? 'trend_up' : 'trend_down'} tam={14} />{sube ? '+' : ''}{fmt.pct(v.pct)}</span><span className="ini-var-txt">{base}</span></>;
}

function MiniGrafica({ valores, color }: { valores: number[]; color: string }) {
  const svg = useMemo(() => minigrafica(valores, { ancho: 96, alto: 36, color }), [valores, color]);
  if (!svg) return null;
  return <div className="ini-kpi-spark" dangerouslySetInnerHTML={{ __html: svg }} />;
}

interface Kpi { clave: string; destacado?: boolean; icono: string; titulo: string; valor: React.ReactNode; detalle: string; variacion: React.ReactNode; serie?: number[]; href: string }

function Indicadores({ d }: { d: Panel }) {
  const k = d.kpis || {};
  const ahora = new Date();
  const bloques: Kpi[] = [];
  if (estado.tiene('ventas.ver') && k.ventas_hoy) bloques.push({ clave: 'hoy', destacado: true, icono: 'cash', titulo: 'Ventas de hoy', valor: fmt.cop(k.ventas_hoy.total), detalle: plural(k.ventas_hoy.cantidad, 'venta', 'ventas'), variacion: <Variacion v={k.ventas_hoy.variacion} base="vs. ayer" sinDato="Ayer no hubo ventas para comparar" />, serie: acumulada(d.serie_hoy?.puntos, String(ahora.getHours()).padStart(2, '0')), href: '#/ventas' });
  if (estado.tiene('ventas.ver') && k.ventas_mes) bloques.push({ clave: 'mes', icono: 'chart', titulo: `Ventas de ${MESES[ahora.getMonth()]}`, valor: fmt.cop(k.ventas_mes.total), detalle: plural(k.ventas_mes.cantidad, 'venta', 'ventas'), variacion: <Variacion v={k.ventas_mes.variacion} base="vs. mes anterior" sinDato="Sin ventas el mes anterior para comparar" />, serie: acumulada(d.serie_mes?.puntos, hoyISO()), href: '#/graficas' });
  if (estado.tiene('creditos.ver') && k.por_cobrar) {
    const pc = k.por_cobrar;
    bloques.push({ clave: 'cartera', icono: 'card', titulo: 'Cartera por cobrar', valor: fmt.cop(pc.pendiente), detalle: plural(pc.vigentes, 'crédito vigente', 'créditos vigentes'), variacion: pc.vencidos ? <span className="ini-var baja"><Icono nombre="alert" tam={14} />{fmt.cop(pc.saldo_vencido)} vencido</span> : <span className="ini-var sube">Todo al día</span>, href: '#/creditos' });
  }
  if (estado.tiene('inventario.ver') && k.inventario) {
    const sb = k.stock_bajo || { total: 0, agotados: 0, pocas: 0 };
    bloques.push({ clave: 'inv', icono: 'bottle', titulo: 'Inventario', valor: <>{fmt.num(k.inventario.unidades)} <small>unid.</small></>, detalle: plural(k.inventario.productos, 'producto', 'productos'), variacion: sb.total ? <span className={`ini-var ${sb.agotados ? 'baja' : 'aviso'}`}><Icono nombre="alert" tam={14} />{plural(sb.total, 'por reponer', 'por reponer')}</span> : <span className="ini-var sube">Stock completo</span>, href: sb.total ? '#/inventario?filtro=stock_bajo' : '#/inventario' });
  }
  if (!bloques.length) return null;
  return (
    <section className="ini-kpis" aria-label="Indicadores del negocio" style={{ '--n': bloques.length } as React.CSSProperties}>
      {bloques.map((b) => (
        <a key={b.clave} className={`ini-kpi ${b.destacado ? 'destacado' : ''}`} href={b.href}>
          <div className="ini-kpi-cab"><Icono nombre={b.icono} tam={16} /><span>{b.titulo}</span></div>
          <div className="ini-kpi-valor">{b.valor}</div>
          <div className="ini-kpi-pie">
            <div className="ini-kpi-det"><span className="muted">{b.detalle}</span><div className="ini-var-fila">{b.variacion}</div></div>
            {b.serie && b.serie.length > 1 && <MiniGrafica valores={b.serie} color={b.destacado ? '#1d1305' : 'var(--viz-1)'} />}
          </div>
        </a>
      ))}
    </section>
  );
}

function Pendientes({ lista }: { lista: Pendiente[] }) {
  return (
    <section className="ini-panel" aria-labelledby="ini-pend-t">
      <div className="ini-panel-cab"><h3 id="ini-pend-t">Pendientes</h3>{lista.length > 0 && <span className="ini-contador">{lista.length}</span>}</div>
      {lista.length ? (
        <ul className="ini-pend">
          {lista.map((p) => (
            <li key={p.titulo}><a className={`ini-pend-item ${p.nivel}`} href={p.href}>
              <span className="ini-pend-ico"><Icono nombre={p.icono} tam={18} /></span>
              <span className="ini-pend-txt"><b>{p.titulo}</b><span>{p.detalle}</span></span>
              <Icono nombre="chevron" tam={16} />
            </a></li>
          ))}
        </ul>
      ) : (
        <div className="ini-todo-ok"><Icono nombre="check" tam={22} /><div><b>Todo al día</b><p>No hay cuotas vencidas, domicilios atrasados ni licores por reponer.</p></div></div>
      )}
    </section>
  );
}

function Lateral({ d }: { d: Panel }) {
  const c = d.comisiones;
  const hoy = hoyISO();
  const ventas = (d.ultimas_ventas || []).slice(0, 6);
  const mio = c && c.alcance === 'propio' && c.vendedor;
  const verVentas = estado.tiene('ventas.ver');
  const dm = d.domicilios;
  if (!mio && !verVentas && !dm) return null;
  return (
    <div className="ini-lateral">
      {dm && (
        <a className="ini-panel ini-domicilios" href="#/domicilios" aria-label="Domicilios de hoy">
          <div className="ini-panel-cab"><h3>Domicilios de hoy</h3><span className="ini-link">Ver tablero</span></div>
          <div className="ini-dom-grid">
            <div className={dm.por_despachar ? 'activo' : ''}><span>Por despachar</span><b>{fmt.num(dm.por_despachar)}</b></div>
            <div><span>En camino</span><b>{fmt.num(dm.en_camino)}</b></div>
            <div><span>Entregados</span><b>{fmt.num(dm.hoy.entregados)}</b></div>
          </div>
          <p className="ini-dom-pie">{dm.hoy.entregados ? `${fmt.cop(dm.hoy.total)} vendidos a domicilio${dm.hoy.minutos_promedio ? ` · ${dm.hoy.minutos_promedio} min en promedio` : ''}` : 'Aún no hay entregas hoy'}{dm.atrasados.length ? <b className="neg"> · {plural(dm.atrasados.length, 'atrasado', 'atrasados')}</b> : null}</p>
        </a>
      )}
      {mio && (
        <section className="ini-panel ini-mio" aria-labelledby="ini-mio-t">
          <div className="ini-panel-cab"><h3 id="ini-mio-t">Tu mes</h3><a className="ini-link" href="#/comisiones">Ver detalle</a></div>
          <div className="ini-mio-grid">
            <div><span>Ventas</span><b>{fmt.num(mio.ventas)}</b></div>
            <div><span>Vendido</span><b>{fmt.cop(mio.ingreso_neto)}</b></div>
            <div><span>Comisión</span><b className="acento">{fmt.cop(mio.comision)}</b></div>
          </div>
        </section>
      )}
      {verVentas && (
        <section className="ini-panel" aria-labelledby="ini-act-t">
          <div className="ini-panel-cab"><h3 id="ini-act-t">Últimas ventas</h3><a className="ini-link" href="#/ventas">Ver todas</a></div>
          {ventas.length ? (
            <ol className="ini-linea">
              {ventas.map((v) => (
                <li key={v.id}><a href={`#/ventas/${Number(v.id)}`} className={v.estado === 'anulada' ? 'anulada' : ''}>
                  <span className="ini-linea-hora">{String(v.fecha).slice(0, 10) === hoy ? horaDe(v.fecha) : fmt.fecha(v.fecha).slice(0, 5)}</span>
                  <span className="ini-linea-txt"><b>{v.cliente || 'Consumidor final'}</b><span>{v.numero} · {v.tipo_pago === 'contado' ? 'Contado' : 'Crédito'}{v.estado === 'anulada' ? ' · Anulada' : ''}</span></span>
                  <span className="ini-linea-valor">{fmt.cop(v.total)}</span>
                </a></li>
              ))}
            </ol>
          ) : <p className="muted small ini-vacio">Aún no hay ventas registradas.</p>}
        </section>
      )}
    </div>
  );
}

function Resumen({ d, pendientes }: { d: Panel | null; pendientes: Pendiente[] }) {
  if (!d) return <>Preparando el resumen de tu día…</>;
  const k = d.kpis || {};
  const importantes = pendientes.filter((p) => p.nivel !== 'info').length;
  const pend = importantes ? <>tienes <b>{plural(importantes, 'pendiente importante', 'pendientes importantes')}</b></> : <>no tienes pendientes urgentes</>;
  if (estado.tiene('ventas.ver') && k.ventas_hoy) {
    return k.ventas_hoy.cantidad
      ? <>Hoy van <b>{plural(k.ventas_hoy.cantidad, 'venta', 'ventas')}</b> por <b>{fmt.cop(k.ventas_hoy.total)}</b> y {pend}.</>
      : <>Todavía no hay ventas hoy y {pend}.</>;
  }
  return importantes ? <>Tienes <b>{plural(importantes, 'pendiente importante', 'pendientes importantes')}</b>.</> : <>No tienes pendientes urgentes.</>;
}

function Esqueleto() {
  return (
    <>
      <section className="ini-kpis" style={{ '--n': 4 } as React.CSSProperties} aria-hidden="true">
        {[0, 1, 2, 3].map((i) => <div key={i} className="ini-kpi esqueleto"><div className="skel" style={{ width: '45%' }} /><div className="skel grande" style={{ width: '70%' }} /><div className="skel" style={{ width: '55%' }} /></div>)}
      </section>
      <div className="ini-grid">
        {[0, 1].map((i) => <div key={i} className="ini-panel esqueleto"><div className="skel" style={{ width: '35%' }} /><div className="skel" style={{ width: '90%' }} /><div className="skel" style={{ width: '78%' }} /></div>)}
      </div>
    </>
  );
}

// ---------- Pantalla ----------
export function Inicio({ setTopbar }: { setTopbar: (t: Topbar) => void }) {
  const [ahora, setAhora] = useState(() => new Date());
  const [datos, setDatos] = useState<Panel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nombre = primerNombre();
  const lista = acciones();

  useEffect(() => { setTopbar({ titulo: estado.config.negocio_nombre || 'Inicio' }); }, [setTopbar]);
  // Reloj y saludo en vivo.
  useEffect(() => { const t = setInterval(() => setAhora(new Date()), 30000); return () => clearInterval(t); }, []);

  const cargar = useCallback(async (señal?: { vivo: boolean }) => {
    setError(null); setDatos(null);
    try {
      const d = await api.get<Panel>('/api/analitica/panel?periodo=mes');
      if (!señal || señal.vivo) setDatos(d);
    } catch (e) {
      if (!señal || señal.vivo) setError((e as Error).message || 'Revisa tu conexión.');
    }
  }, []);
  useEffect(() => { const s = { vivo: true }; void cargar(s); return () => { s.vivo = false; }; }, [cargar]);

  const pendientes = useMemo(() => (datos ? calcularPendientes(datos) : []), [datos]);
  const caja = estado.caja;
  const [principal, ...resto] = lista;

  return (
    <div className="ini">
      <header className="ini-cab">
        <div className="ini-cab-texto">
          <p className="ini-fecha"><span className="ini-pulso" aria-hidden="true" /><span>{fechaLarga(ahora)} · {horaCorta(ahora)}</span></p>
          <h2 className="ini-saludo">{saludo(ahora)}{nombre && <>, <strong>{nombre}</strong></>}</h2>
          <p className="ini-resumen" aria-live="polite">{error ? 'Toda la licorera en un solo lugar.' : <Resumen d={datos} pendientes={pendientes} />}</p>
        </div>
        {principal && (
          <nav className="ini-acciones" aria-label="Acciones frecuentes">
            <a className="btn primario ini-accion-principal" href={principal.href}><Icono nombre={principal.icono} tam={18} /><span>{principal.texto}</span></a>
            {resto.map((a) => <a key={a.href} className="ini-accion" href={a.href}><Icono nombre={a.icono} tam={18} /><span>{a.texto}</span></a>)}
          </nav>
        )}
      </header>

      {estado.tiene('caja.ver') && (caja ? (
        <a className="ini-caja abierta" href="#/caja"><span className="ini-caja-punto" aria-hidden="true" />
          <span><b>Caja abierta</b> desde las {horaDe(caja.abierta_en)}{String(caja.abierta_en || '').slice(0, 10) !== hoyISO() ? ` del ${fmt.fecha(caja.abierta_en)}` : ''} · base {fmt.cop(caja.base_inicial)}</span>
          <span className="ini-caja-ir">Ver caja <Icono nombre="chevron" tam={16} /></span></a>
      ) : (
        <a className="ini-caja cerrada" href="#/caja"><span className="ini-caja-punto" aria-hidden="true" />
          <span><b>Caja cerrada.</b> {estado.tiene('caja.operar') ? 'Ábrela para registrar ventas en efectivo del día.' : 'Pide a quien maneja la caja que la abra.'}</span>
          <span className="ini-caja-ir">{estado.tiene('caja.operar') ? 'Abrir caja' : 'Ver caja'} <Icono nombre="chevron" tam={16} /></span></a>
      ))}

      <div className="ini-cuerpo">
        {error ? (
          <div className="ini-panel ini-error"><Icono nombre="alert" tam={20} /><div><b>No se pudo cargar el resumen del día</b><p className="muted small">{error}</p></div>
            <button type="button" className="btn suave chico" onClick={() => void cargar()}><Icono nombre="refresh" tam={15} /> Reintentar</button></div>
        ) : !datos ? <Esqueleto /> : (
          <>
            <Indicadores d={datos} />
            <InicioGrid d={datos} pendientes={pendientes} />
          </>
        )}
      </div>

      <footer className="ini-ayuda">
        <span className="muted small">¿Primera vez aquí?</span>
        <button type="button" className="ini-link" onClick={() => guiaBienvenida({ forzar: true })}><Icono nombre="help" tam={15} /> Guía de uso</button>
        <button type="button" className="ini-link" onClick={() => abrirGlosario()}><Icono nombre="book" tam={15} /> Glosario</button>
      </footer>
    </div>
  );
}

function InicioGrid({ d, pendientes }: { d: Panel; pendientes: Pendiente[] }) {
  const lateral = <Lateral d={d} />;
  const hayLateral = (d.comisiones?.alcance === 'propio' && !!d.comisiones.vendedor) || estado.tiene('ventas.ver') || !!d.domicilios;
  return <div className={`ini-grid ${hayLateral ? '' : 'una'}`}><Pendientes lista={pendientes} />{hayLateral && lateral}</div>;
}
