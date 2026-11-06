// Menú lateral (computador): marca, módulos agrupados por sección y pie con la cuenta del usuario.
import { estado } from '../lib/estado';
import { esActivo, modulosPorGrupo, nombreRol } from '../lib/modulos';
import { cerrarSesion } from '../lib/sesion';
import { guiaBienvenida } from '../legacy/ayuda.js';
import { Icono } from '../components/Icono';

export function BarraLateral({ seccion }: { seccion: string }) {
  const negocio = estado.config.negocio_nombre || 'Licores Palmira';
  const u = estado.usuario!;
  return (
    <aside id="sidebar" className="sidebar">
      <div className="marca">
        <a href="#/inicio" className="marca-logo" aria-label={`${negocio} · Inicio`}><img src="/icons/logo-palmira.webp" alt="Licores Palmira" width="150" height="117" /></a>
        <span className="negocio">{negocio.trim().toLowerCase() === 'licores palmira' ? 'Desde 1994' : negocio}</span>
      </div>
      <nav className="nav" aria-label="Secciones">
        {modulosPorGrupo().map((g) => (
          <div key={g.clave} className="nav-bloque" role="group" aria-labelledby={g.nombre ? `nav-sec-${g.clave}` : undefined}>
            {g.nombre && <div className="nav-seccion" id={`nav-sec-${g.clave}`}>{g.nombre}</div>}
            {g.items.map((m) => {
              const activo = esActivo(m, seccion);
              return (
                <a key={m.ruta} href={`#/${m.ruta}`} className={activo ? 'activo' : ''} aria-current={activo ? 'page' : undefined}>
                  <Icono nombre={m.icono} /><span>{m.nombre}</span>
                </a>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="pie">
        <div className="bold truncate">{u.nombre}</div>
        <div className="muted xs">{nombreRol(u.rol)}</div>
        <a href="#/configuracion/cuenta" className="row small mt" style={{ padding: 0 }}><Icono nombre="user" tam={16} /> Mi cuenta</a>
        <a href="#" className="row small mt" style={{ padding: 0 }} onClick={(e) => { e.preventDefault(); guiaBienvenida({ forzar: true }); }}><Icono nombre="help" tam={16} /> Guía de uso</a>
        <a href="#" className="row small mt" style={{ padding: 0 }} onClick={(e) => { e.preventDefault(); void cerrarSesion(); }}><Icono nombre="logout" tam={16} /> Cerrar sesión</a>
      </div>
    </aside>
  );
}
