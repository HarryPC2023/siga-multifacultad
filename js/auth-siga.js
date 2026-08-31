// js/auth-siga.js — Módulo de autenticación compartido para SIGA
// ⚠️ VERSIÓN SANDBOX (siga-multifacultad) — apunta al proyecto de
// Supabase de PRUEBA, aislado del SIGA real. No mezclar con el
// auth-siga.js de producción.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://msaarndfaficqcfexyzl.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_PitGqMtC7u9g_z3-YAQW4A_dQsoAVlh';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/** Devuelve la sesión actual (o null si no hay nadie logueado). */
export async function obtenerSesion() {
  const { data, error } = await supabase.auth.getSession();
  if (error) { console.error('Error al obtener sesión SIGA:', error); return null; }
  return data.session;
}

/** Crea una cuenta nueva con correo + contraseña. */
export async function registrarConCorreo(correo, contrasena) {
  const { data, error } = await supabase.auth.signUp({ email: correo, password: contrasena });
  return {
    ok: !error,
    error,
    // Si Supabase exige confirmar el correo, signUp devuelve usuario pero SIN sesión activa todavía.
    requiereConfirmacion: !error && data && !data.session,
  };
}

/** Inicia sesión con correo + contraseña ya existentes. */
export async function iniciarSesionConCorreo(correo, contrasena) {
  const { error } = await supabase.auth.signInWithPassword({ email: correo, password: contrasena });
  return { ok: !error, error };
}

/** Inicia sesión con Google. Redirige fuera de la página y vuelve ya logueado. */
export async function iniciarSesionConGoogle() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    // ⚠️ path corregido a /siga-multifacultad/ (en el real es /portal-siga/)
    options: { redirectTo: window.location.origin + '/siga-multifacultad/index.html?login=1' },
  });
  return { ok: !error, error };
}

/** Envía un correo con enlace para restablecer la contraseña. */
export async function recuperarContrasena(correo) {
  const { error } = await supabase.auth.resetPasswordForEmail(correo, {
    // ⚠️ path corregido a /siga-multifacultad/ (en el real es /portal-siga/)
    redirectTo: window.location.origin + '/siga-multifacultad/index.html?recuperar=1',
  });
  return { ok: !error, error };
}

/** Establece una nueva contraseña (se usa durante el flujo de recuperación). */
export async function establecerNuevaContrasena(nuevaContrasena) {
  const { error } = await supabase.auth.updateUser({ password: nuevaContrasena });
  return { ok: !error, error };
}

export async function cerrarSesion() {
  await supabase.auth.signOut();
}

const BUCKET_AVATARS = 'avatars';

/**
 * Convierte lo que haya guardado en `foto_url` en una URL que el navegador
 * pueda cargar de verdad. El bucket "avatars" es privado, así que no existe
 * una URL pública fija — hay que pedirle a Supabase una URL firmada (con
 * vencimiento) cada vez que se necesita mostrar la foto.
 *
 * Soporta 3 formatos posibles de `foto_url`, para no romper fotos ya
 * guardadas antes de este cambio:
 *  - Foto de Google (URL externa completa) -> se usa tal cual.
 *  - URL pública vieja de Supabase (de antes de hacer el bucket privado)
 *    -> se le extrae solo la ruta y se firma esa ruta.
 *  - Ruta nueva guardada directamente (formato actual) -> se firma tal cual.
 *
 * ⚠️ En el sandbox el bucket "avatars" probablemente NO existe todavía
 * (no lo creamos en el schema SQL) — si nadie sube foto de perfil en las
 * pruebas, esta función nunca se llama y no da problema. Si hace falta
 * fotos de perfil en el sandbox, avísame y lo agregamos.
 */
export async function resolverUrlFoto(fotoUrl) {
  if (!fotoUrl) return null;

  if (fotoUrl.includes('/storage/v1/object/public/avatars/')) {
    const ruta = fotoUrl.split('/avatars/')[1]?.split('?')[0];
    if (!ruta) return null;
    const { data, error } = await supabase.storage.from(BUCKET_AVATARS).createSignedUrl(ruta, 3600);
    return error ? null : data.signedUrl;
  }

  if (fotoUrl.startsWith('http')) {
    return fotoUrl; // foto externa (Google), no vive en nuestro Storage
  }

  const { data, error } = await supabase.storage.from(BUCKET_AVATARS).createSignedUrl(fotoUrl, 3600);
  return error ? null : data.signedUrl;
}

/** Eventos que NO representan un cambio real de sesión — se ignoran para
 * evitar que la interfaz "parpadee"/recargue solo por volver a la pestaña. */
const EVENTOS_SESION_IGNORADOS = new Set(['TOKEN_REFRESHED', 'INITIAL_SESSION']);

/** Suscribe una función a cambios de sesión (login/logout/recuperación). */
export function alCambiarSesion(callback) {
  const { data } = supabase.auth.onAuthStateChange((evento, sesion) => {
    if (EVENTOS_SESION_IGNORADOS.has(evento)) return;
    callback(sesion, evento)
  });
  return () => data.subscription.unsubscribe();
}

/**
 * Pinta el estado de sesión dentro de `.app-nav-user` (el mismo hueco que
 * ya existe en dashboard.css). Reutilizable en cualquier página.
 */
export function montarNavUsuario() {
  const cont = document.querySelector('.app-nav-account');
  if (!cont) return;

  async function pintar(sesion) {
    const raiz = window.location.pathname.includes('/intranotas/') || window.location.pathname.includes('/horarios/')
      ? '../' : '';

    if (sesion) {
      cont.innerHTML = `
        <button type="button" class="app-nav-avatar" id="avatarBtn" aria-haspopup="true" aria-expanded="false" aria-label="Cuenta">
          <svg id="avatarIconoDefault" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 4-6 8-6s8 2 8 6" />
          </svg>
          <img id="avatarFotoReal" src="" alt="" style="display:none; width:100%; height:100%; border-radius:50%; object-fit:cover;">
        </button>
        <div class="app-nav-user-menu" id="avatarMenu">
          <div class="app-nav-user-info">
            <span class="app-nav-user-correo">${sesion.user.email ?? ''}</span>
          </div>
          <a href="${raiz}perfil.html#info" class="app-nav-user-item">Mi perfil</a>
          <a href="${raiz}perfil.html#cuenta" class="app-nav-user-item">Configuración de la cuenta</a>
          <div class="app-nav-user-sep"></div>
          <button type="button" class="app-nav-user-item app-nav-user-salir" id="btnCerrarSesionSiga">Cerrar sesión</button>
        </div>`;

      const btn = document.getElementById('avatarBtn');
      const menu = document.getElementById('avatarMenu');
      btn.addEventListener('click', () => {
        const abierto = menu.classList.toggle('abierto');
        btn.setAttribute('aria-expanded', String(abierto));
      });
      document.addEventListener('click', (e) => {
        if (!cont.contains(e.target)) {
          menu.classList.remove('abierto');
          btn.setAttribute('aria-expanded', 'false');
        }
      });
      document.getElementById('btnCerrarSesionSiga').addEventListener('click', async () => {
        await cerrarSesion();
        window.location.href = `${raiz}index.html`;
      });

      // Si ya tiene foto de perfil guardada, mostrarla en vez del ícono genérico.
      const { data: perfil } = await supabase
        .from('perfiles_usuario')
        .select('foto_url')
        .eq('user_id', sesion.user.id)
        .maybeSingle();

      if (perfil?.foto_url) {
        const urlFoto = await resolverUrlFoto(perfil.foto_url);
        const img = document.getElementById('avatarFotoReal');
        const iconoDefault = document.getElementById('avatarIconoDefault');
        if (img && iconoDefault && urlFoto) {
          img.src = urlFoto;
          img.style.display = 'block';
          iconoDefault.style.display = 'none';
        }
      }
    } else {
      cont.innerHTML = `<button type="button" class="btn-login-siga" id="btnAbrirLoginSiga">Iniciar sesión</button>`;
      document.getElementById('btnAbrirLoginSiga').addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent('siga:abrir-login'));
      });
    }
  }

  obtenerSesion().then(pintar);
  alCambiarSesion(pintar);
}

/**
 * Protege una página interna: si no hay sesión, redirige a index.html con
 * el login listo para abrirse (?login=1). Llamar al inicio de cada página
 * que requiera cuenta (dashboard, asesorias, materiales, intranotas, horarios).
 *
 * @param {string} raiz - ruta relativa hacia la raíz del portal.
 *   '' si la página ya está en la raíz (dashboard.html, asesorias.html...).
 *   '../' si la página está en una subcarpeta (intranotas/, horarios/).
 */
export async function requerirSesion(raiz = '') {
  const sesion = await obtenerSesion();
  if (!sesion) {
    // Guarda a dónde se iba (ruta completa, con query si tenía) para que
    // login-siga.js pueda devolver ahí después de iniciar sesión, en vez
    // de dejar siempre al usuario en dashboard.html.
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `${raiz}index.html?login=1&next=${next}`;
    return null;
  }
  return sesion;
}