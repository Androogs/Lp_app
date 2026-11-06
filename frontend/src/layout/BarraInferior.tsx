// Barra inferior (celular) y menú "Más" con el resto de módulos agrupados por sección.
import { estado } from '../lib/estado';
import { MODULOS, cuadriculaApps, esActivo, moduloVisible, modulosPorGrupo, nombreRol } from '../lib/modulos';
import { cerrarSesion } from '../lib/sesion';
import { $$, esc, icono, modal } from '../legacy/ui.js';
import { guiaBienvenida } from '../legacy/ayuda.js';
import { Icono } from '../components/Icono';

// En el celular la licorera vive de vender y despachar: Domicilios ocupa el cuarto lugar (o Compras si no lo ve).
const navMovil = (): string[] => ['inicio', 'inventario', 'vender', estado.tiene('domicilios.ver') ? 'domicilios' : 'compras', 'mas'];

function menuMas(seccion: string): void {
  const u = estado.usuario!;
  const grupos = modulosPorGrupo({ excluir: navMovil() });
  const apps = grupos.map((g) => `<section class="mas-grupo">${g.nombre ? `<h3 class="nav-seccion">${esc(g.nombre)}</h3>` : ''}${cuadriculaApps({ items: g.items, seccion })}</section>`).join('');
  const cuerpo = `${apps}<div class="lista mt">
    <a class="item" href="#/configuracion/cuenta">${icono('user')}<div class="cuerpo"><div class="titulo">Mi cuenta</div><div class="sub">${esc(u.nombre)} · ${esc(nombreRol(u.rol))}</div></div>${icono('chevron', 18)}</a>
    <a class="item" href="#" id="guia">${icono('help')}<div class="cuerpo"><div class="titulo">Guía de uso</div><div class="sub">Cómo está organizada la aplicación</div></div>${icono('chevron', 18)}</a>
    <a class="item" href="#" id="salir">${icono('logout')}<div class="cuerpo"><div class="titulo">Cerrar sesión</div></div></a></div>`;
  const m = modal({ titulo: 'Más opciones', cuerpo });
  ($$('a.item, a.app-tile', m.el) as HTMLAnchorElement[]).forEach((a) => a.addEventListener('click', (e) => {
    if (a.id === 'salir') { e.preventDefault(); void cerrarSesion(); }
    if (a.id === 'guia') { e.preventDefault(); setTimeout(() => guiaBienvenida({ forzar: true }), 50); }
    m.cerrar();
  }));
}

export function BarraInferior({ seccion }: { seccion: string }) {
  const lista = navMovil();
  return (
    <nav id="bottomnav" className="bottomnav">
      {lista.map((r) => {
        if (r === 'mas') {
          const activo = !lista.includes(seccion) && seccion !== 'ventas' && seccion !== 'documentos';
          return <a key="mas" href="#" className={activo ? 'activo' : ''} onClick={(e) => { e.preventDefault(); menuMas(seccion); }}><Icono nombre="more" /><span>Más</span></a>;
        }
        const m = MODULOS.find((x) => x.ruta === r)!;
        if (!moduloVisible(m)) return <a key={r} href="#/inicio" style={{ visibility: 'hidden' }} aria-hidden="true" tabIndex={-1} />;
        const activo = esActivo(m, seccion);
        if (r === 'vender') return <a key={r} href="#/vender" className={`principal ${activo ? 'activo' : ''}`}><span className="ico"><Icono nombre="cart" /></span><span>Vender</span></a>;
        return <a key={r} href={`#/${r}`} className={activo ? 'activo' : ''}><Icono nombre={m.icono} /><span>{m.nombre.split(' ')[0]}</span></a>;
      })}
    </nav>
  );
}
