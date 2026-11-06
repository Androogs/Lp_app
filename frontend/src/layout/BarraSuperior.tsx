// Barra superior: botón Volver, título de la pantalla, acciones y ayuda contextual "?".
import type { Topbar } from '../lib/tipos';
import { navegar } from '../lib/estado';
import { abrirAyuda, tieneAyuda } from '../legacy/ayuda.js';
import { Icono } from '../components/Icono';

export function BarraSuperior({ topbar, seccion }: { topbar: Topbar; seccion: string }) {
  // Ocultar barra superior en el inicio de sesión y en la página de inicio
  if (seccion === 'login' || seccion === 'inicio') {
    return null;
  }

  const acciones = tieneAyuda(seccion)
    ? [...(topbar.acciones || []), { icono: 'help', titulo: 'Ayuda de esta sección', clase: 'icono ayuda-btn', alHacerClic: () => abrirAyuda(seccion) }]
    : topbar.acciones || [];
  const atras = topbar.atras;
  return (
    <header id="topbar" className="topbar">
      {atras && (
        <button className="btn icono fantasma" id="tb-atras" aria-label="Volver" onClick={() => (typeof atras === 'string' ? navegar(atras) : history.back())}>
          <Icono nombre="back" />
        </button>
      )}
      <h1>{topbar.titulo}</h1>
      <div className="acciones" id="tb-acciones">
        {acciones.map((a, i) => {
          const contenido = <>{a.icono && <Icono nombre={a.icono} />}{a.texto && <span>{a.texto}</span>}</>;
          const props = { className: `btn ${a.clase || 'icono'}`, title: a.titulo || a.texto || '', 'aria-label': a.titulo && !a.texto ? a.titulo : undefined };
          return a.href
            ? <a key={i} href={a.href} {...props} onClick={a.alHacerClic ? (e) => a.alHacerClic!(e.nativeEvent) : undefined}>{contenido}</a>
            : <button key={i} type="button" {...props} onClick={a.alHacerClic ? (e) => a.alHacerClic!(e.nativeEvent) : undefined}>{contenido}</button>;
        })}
      </div>
    </header>
  );
}
