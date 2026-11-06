// Pantalla de acceso: usuario y contraseña, recuperación con código entregado por el administrador.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { Icono } from '../components/Icono';
import { estado } from '../lib/estado';
import { aplicarSesion } from '../lib/sesion';
import type { RespuestaSesion } from '../lib/tipos';
import { $, esc, modal, textoPolitica, toast, validarClave } from '../legacy/ui.js';

const valor = (m: HTMLElement, sel: string) => ($(sel, m) as HTMLInputElement).value;

function abrirRecuperar(e: React.MouseEvent) {
  e.preventDefault();
  modal({
    titulo: 'Recuperar contraseña',
    cuerpo: `<p class="small muted">Escribe tu usuario. Se generará un código de recuperación que el administrador podrá ver en Configuración › Usuarios y entregarte. Con ese código podrás crear una contraseña nueva.</p><div class="campo mt"><label>Usuario</label><input id="r-u" type="text" autocapitalize="none" maxlength="60"></div>`,
    acciones: [{ texto: 'Generar código', clase: 'primario', alHacerClic: async ({ modal: m }: { modal: HTMLElement }) => { const r = await api.post('/api/auth/recuperar', { usuario: valor(m, '#r-u').trim() }); toast(r.mensaje); } }],
  });
}

function abrirCodigo(e: React.MouseEvent) {
  e.preventDefault();
  modal({
    titulo: 'Crear nueva contraseña',
    cuerpo: `<div class="campo"><label>Usuario</label><input id="c-u" type="text" autocapitalize="none" maxlength="60"></div><div class="campo"><label>Código</label><input id="c-c" type="text" inputmode="numeric" maxlength="10" autocomplete="one-time-code"></div><div class="campo"><label>Nueva contraseña</label><input id="c-n" type="password" autocomplete="new-password" minlength="${Number(estado.config.clave_min) || 10}" maxlength="72"><p class="xs muted mt">${esc(textoPolitica())}</p></div>`,
    acciones: [{
      texto: 'Guardar', clase: 'primario', alHacerClic: async ({ modal: m }: { modal: HTMLElement }) => {
        const malo = validarClave(valor(m, '#c-n'), valor(m, '#c-u').trim());
        if (malo) { toast(malo, 'error'); return false; }
        await api.post('/api/auth/restablecer', { usuario: valor(m, '#c-u').trim(), codigo: valor(m, '#c-c').trim(), nueva: valor(m, '#c-n') });
        toast('Contraseña actualizada. Ya puedes iniciar sesión.', 'ok');
        return true;
      },
    }],
  });
}

export function Login() {
  const [usuario, setUsuario] = useState('');
  const [clave, setClave] = useState('');
  const [verClave, setVerClave] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const refUsuario = useRef<HTMLInputElement>(null);
  useEffect(() => { const t = setTimeout(() => refUsuario.current?.focus(), 50); return () => clearTimeout(t); }, []);
  
  // Ocultar barra lateral al iniciar sesión
  useEffect(() => {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.hidden = true;
    return () => {
      if (sidebar) sidebar.hidden = false;
    };
  }, []);

  async function entrar(e: FormEvent) {
    e.preventDefault();
    setEnviando(true);
    try {
      const d = await api.post<RespuestaSesion>('/api/auth/login', { usuario: usuario.trim(), clave }, { silencioso: true });
      aplicarSesion(d);
      // Mostrar barra lateral después del inicio de sesión
      setTimeout(() => {
        const sidebar = document.getElementById('sidebar');
        if (sidebar) sidebar.hidden = false;
      }, 100);
    } catch (err) {
      toast((err as Error).message, 'error');
      setEnviando(false);
    }
  }

  return (
    <div className="login">
      <section className="login-foto" aria-hidden="true">
        <img src="/img/bodega.webp" srcSet="/img/bodega-md.webp 960w, /img/bodega.webp 1600w" sizes="(min-width: 900px) 60vw, 100vw" alt="" fetchPriority="high" />
        <div className="login-foto-texto">
          <span className="login-sello">Palmira · Valle del Cauca · desde 1994</span>
          <p>Más que licores, somos parte de tus momentos.</p>
          <span className="login-lema">Calidad · Variedad · Tu confianza</span>
        </div>
      </section>
      <section className="login-panel">
        <div className="caja">
          <img className="logo" src="/icons/logo-palmira.webp" alt="Licores Palmira" width="220" height="172" />
          <div className="login-espectro" aria-hidden="true"><i /><i /><i /><i /><i /></div>
          <h1>Panel de gestión</h1>
          <p className="muted">Ventas, bodega, domicilios y caja. Inicia sesión para continuar.</p>
          <form id="f-login" className="mt-l" autoComplete="on" onSubmit={entrar}>
            <div className="campo"><label htmlFor="l-u">Usuario</label><input id="l-u" ref={refUsuario} name="usuario" type="text" autoComplete="username" autoCapitalize="none" maxLength={60} required value={usuario} onChange={(e) => setUsuario(e.target.value)} /></div>
            <div className="campo"><label htmlFor="l-c">Contraseña</label>
              <div className="campo-clave">
                <input id="l-c" name="clave" type={verClave ? 'text' : 'password'} autoComplete="current-password" maxLength={200} required value={clave} onChange={(e) => setClave(e.target.value)} />
                <button type="button" className="ver-clave" onClick={() => setVerClave((v) => !v)} aria-label={verClave ? 'Ocultar contraseña' : 'Mostrar contraseña'} title={verClave ? 'Ocultar contraseña' : 'Mostrar contraseña'}>
                  <Icono nombre={verClave ? 'eye_off' : 'eye'} tam={18} />
                </button>
              </div>
            </div>
            <button className="btn primario grande mt" type="submit" disabled={enviando}>{enviando ? 'Entrando…' : 'Entrar'}</button>
          </form>
          <div className="row between mt-l small login-enlaces"><a href="#" onClick={abrirRecuperar}>Olvidé mi contraseña</a><a href="#" onClick={abrirCodigo}>Tengo un código</a></div>
        </div>
        <p className="login-pie">El exceso de alcohol es perjudicial para la salud · Prohíbese el expendio de bebidas embriagantes a menores de edad.</p>
      </section>
    </div>
  );
}
