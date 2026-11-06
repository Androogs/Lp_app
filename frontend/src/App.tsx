// Raíz de la aplicación: carga la sesión, decide entre la pantalla de acceso y el panel, y enruta por hash.
import { useCallback, useEffect, useRef, useState } from 'react';
import { cuandoNoAutenticado } from './lib/api';
import { estado, navegar } from './lib/estado';
import { recargarSesion, limpiarSesion, useSesion } from './lib/sesion';
import { useRuta } from './lib/ruta';
import { VISTAS, esRutaMiCuenta } from './lib/vistas';
import { buscarModulo, moduloVisible } from './lib/modulos';
import type { Topbar } from './lib/tipos';
import { BarraLateral } from './layout/BarraLateral';
import { BarraSuperior } from './layout/BarraSuperior';
import { BarraInferior } from './layout/BarraInferior';
import { PantallaHeredada } from './components/PantallaHeredada';
import { Icono } from './components/Icono';
import { Login } from './views/Login';
import { Inicio } from './views/Inicio';
import { $$, toast } from './legacy/ui.js';
import { guiaBienvenida } from './legacy/ayuda.js';
import { montarAsistente, desmontarAsistente } from './legacy/asistente.js';

// Estructura base (misma que la versión anterior) con las barras ocultas: se usa mientras carga y en el acceso.
function Cascaron({ children }: { children?: React.ReactNode }) {
  return (
    <div id="app" className="app">
      <div className="main">
        <main id="vista" className="vista" aria-live="polite">{children}</main>
      </div>
    </div>
  );
}

function Panel() {
  const ruta = useRuta();
  const [topbar, setTopbarEstado] = useState<Topbar>({ titulo: estado.config.negocio_nombre || 'Licores Palmira' });
  const setTopbar = useCallback((t: Topbar) => setTopbarEstado(t), []);
  const { seccion, partes } = ruta;
  const vista = VISTAS[seccion];
  const modulo = buscarModulo(seccion);
  const sinAcceso = !!vista && !!modulo && !esRutaMiCuenta(seccion, partes) && !moduloVisible(modulo);

  // Título de la pestaña del navegador.
  useEffect(() => { document.title = topbar.titulo === 'Licores Palmira' ? 'Licores Palmira · Panel de gestión' : `${topbar.titulo} · Licores Palmira`; }, [topbar.titulo]);

  // Al cambiar de pantalla no queda ningún diálogo abierto y se vuelve arriba.
  useEffect(() => {
    $$('#modales .modal-fondo').forEach((m: Element) => m.remove());
    document.body.style.overflow = '';
    window.scrollTo(0, 0);
    if (seccion === 'login') navegar('#/inicio', true);
  }, [ruta.hash, seccion]);

  useEffect(() => {
    if (sinAcceso) { toast('No tienes acceso a esta sección. Pide el permiso al administrador.', 'error'); navegar('#/inicio', true); }
  }, [sinAcceso]);
  useEffect(() => { if (!vista) setTopbar({ titulo: 'Página no encontrada', atras: '#/inicio' }); }, [vista, setTopbar]);

  let contenido: React.ReactNode;
  if (!vista) {
    contenido = <main id="vista" className="vista" aria-live="polite"><div className="vacio"><Icono nombre="inbox" /><p>Esa dirección no existe en la aplicación.</p><a className="btn primario mt" href="#/inicio">Volver a Inicio</a></div></main>;
  } else if (sinAcceso) {
    contenido = <main id="vista" className="vista" aria-live="polite" />;
  } else if (vista.tipo === 'react') {
    contenido = <main id="vista" className="vista" aria-live="polite"><Inicio key={ruta.hash} setTopbar={setTopbar} /></main>;
  } else {
    contenido = <PantallaHeredada key={seccion} cargar={vista.cargar} ruta={ruta} setTopbar={setTopbar} />;
  }

  return (
    <div id="app" className="app">
      {seccion !== 'login' && <BarraLateral seccion={seccion} />}
      <div className="main">
        {seccion !== 'login' && <BarraSuperior topbar={topbar} seccion={seccion} />}
        {contenido}
      </div>
      {seccion !== 'login' && <BarraInferior seccion={seccion} />}
    </div>
  );
}

export function App() {
  useSesion();
  const [listo, setListo] = useState(false);
  const montado = useRef(false);

  useEffect(() => {
    // Sesión caducada o cerrada en otra pestaña (401): se quita el asistente y se vuelve al acceso.
    cuandoNoAutenticado(() => {
      if (!estado.usuario) return;
      limpiarSesion();
      try { desmontarAsistente(); } catch { /* sin asistente */ }
      toast('Tu sesión terminó. Vuelve a iniciar sesión.', 'error');
    });
    void recargarSesion().then(() => setListo(true));
  }, []);

  // Al entrar: guía de primer uso, asistente Tino y aviso de contraseña temporal.
  const usuarioId = estado.usuario?.id ?? null;
  useEffect(() => {
    if (!usuarioId) { montado.current = false; return; }
    if (montado.current) return;
    montado.current = true;
    if (estado.usuario?.debe_cambiar_clave) setTimeout(() => toast('Por seguridad, cambia tu contraseña en Configuración › Mi cuenta', 'error'), 600);
    const t = setTimeout(() => guiaBienvenida(), 700);
    try { montarAsistente(); } catch (e) { console.error('[asistente]', e); }
    return () => clearTimeout(t);
  }, [usuarioId]);

  if (!listo) return <Cascaron />;
  if (!estado.usuario) return <Cascaron><Login /></Cascaron>;
  return <Panel />;
}
