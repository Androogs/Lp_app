// Puente para las pantallas que aún están en JavaScript (src/legacy/views). Cada una exporta render(root, contexto) y pinta
// su propio HTML dentro del contenedor principal; aquí se monta al entrar y se desmonta (destruir) al salir.
// Al migrar una pantalla a React basta con cambiar su entrada en lib/vistas.ts.
import { useEffect, useRef } from 'react';
import type { ModuloVista, Ruta, Topbar } from '../lib/tipos';
import { esc, mostrarError } from '../legacy/ui.js';

interface Props { cargar: () => Promise<ModuloVista>; ruta: Ruta; setTopbar: (t: Topbar) => void }

export function PantallaHeredada({ cargar, ruta, setTopbar }: Props) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current!;
    let vivo = true;
    let instancia: { destruir?: () => void } | null = null;
    el.innerHTML = '<div class="cargando">Cargando…</div>';
    (async () => {
      try {
        const mod = await cargar();
        if (!vivo) return;
        const r = await mod.render(el, { seccion: ruta.seccion, partes: ruta.partes.slice(1), query: ruta.query, setTopbar });
        if (vivo) instancia = r || null; else r?.destruir?.();
      } catch (e) {
        if (!vivo) return;
        mostrarError(e);
        el.innerHTML = `<div class="card"><h2>No se pudo cargar la pantalla</h2><p class="muted mt">${esc((e as Error)?.message || '')}</p><button class="btn suave mt" data-recargar>Recargar</button></div>`;
        el.querySelector('[data-recargar]')?.addEventListener('click', () => location.reload());
      }
    })();
    return () => {
      vivo = false;
      try { instancia?.destruir?.(); } catch { /* nada */ }
      el.innerHTML = '';
    };
    // Cada cambio de dirección vuelve a montar la pantalla, igual que la navegación original.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ruta.hash]);
  return <main id="vista" className="vista" aria-live="polite" ref={ref} />;
}
