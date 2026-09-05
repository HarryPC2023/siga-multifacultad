// js/login-multifacultad.js — Pantalla de login/sync de siga-multifacultad.
// Dos bloques secuenciales: 1) cuenta SIGA (correo/Google, vía Supabase
// sandbox), 2) sincronización con Intralú (notas del periodo elegido +
// avance curricular completo SOLO la primera vez que el alumno sincroniza
// algo — ver notas de diseño en la sesión de asesoría).
import {
    supabase, obtenerSesion, alCambiarSesion,
    registrarConCorreo, iniciarSesionConCorreo, iniciarSesionConGoogle,
    recuperarContrasena, establecerNuevaContrasena,
} from './auth-siga.js';
import { FACULTADES } from './facultades-datos.js';

const CLAVE_SESSION = 'siga_multifacultad_seleccion';

// Local en tu compu (Jekyll) usa el backend local; en cualquier otro caso
// (GitHub Pages) usa la URL real de Render — mismo patrón que ya usas en
// intranotas.js para el backend de producción.
const BACKEND_URL = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    ? 'http://localhost:8000'
    : 'https://siga-multifacultad.onrender.com';

let facultadElegida, carreraElegida;
let modoFormulario = 'entrar';

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Recupera la elección de facultad/carrera hecha en index.html. Sin
    // esto no hay nada que sincronizar, así que de vuelta al selector.
    const seleccionRaw = sessionStorage.getItem(CLAVE_SESSION);
    if (!seleccionRaw) {
        window.location.href = 'index.html';
        return;
    }
    const seleccion = JSON.parse(seleccionRaw);
    facultadElegida = FACULTADES.find((f) => f.id === seleccion.facultadId);
    carreraElegida = facultadElegida?.carreras.find((c) => c.id === seleccion.carreraId);
    if (!facultadElegida || !carreraElegida) {
        window.location.href = 'index.html';
        return;
    }
    pintarEleccion();

    // 2. Bloque de cuenta SIGA: si ya hay sesión, saltamos directo al sync.
    const sesion = await obtenerSesion();
    mostrarBloqueSegunSesion(sesion);

    alCambiarSesion((sesionNueva, evento) => {
        if (evento === 'PASSWORD_RECOVERY') {
            mostrarFormulario('nuevaContrasena');
            return;
        }
        if (sesionNueva) mostrarBloqueSegunSesion(sesionNueva);
    });

    inicializarFormularioCuenta();
    inicializarFormularioSync();
});

function pintarEleccion() {
    document.getElementById('eleccionIcono').src = facultadElegida.icono;
    document.getElementById('eleccionIcono').alt = `Ícono de ${facultadElegida.sigla}`;
    document.getElementById('eleccionSigla').textContent = facultadElegida.sigla;
    document.getElementById('eleccionCarrera').textContent = carreraElegida.nombre;
}

function mostrarBloqueSegunSesion(sesion) {
    document.getElementById('bloqueCuenta').classList.toggle('visible', !sesion);
    document.getElementById('bloqueSync').classList.toggle('visible', !!sesion);
    if (sesion) prepararPeriodos('');
}

/* ============================================================
   BLOQUE 1 — Cuenta SIGA
   ============================================================ */
function inicializarFormularioCuenta() {
    document.querySelectorAll('.login-tab').forEach((btn) => {
        btn.addEventListener('click', () => mostrarFormulario(btn.dataset.tab));
    });
    document.getElementById('btnOlvide').addEventListener('click', () => mostrarFormulario('recuperar'));

    document.getElementById('btnGoogle').addEventListener('click', async () => {
        const { error } = await iniciarSesionConGoogle();
        if (error) mostrarMsgCuenta('No se pudo iniciar con Google. Intenta de nuevo.');
    });

    document.getElementById('formEntrar').addEventListener('submit', manejarEntrar);
    document.getElementById('formCrear').addEventListener('submit', manejarCrear);
    document.getElementById('formRecuperar').addEventListener('submit', manejarRecuperar);
    document.getElementById('formNuevaContrasena').addEventListener('submit', manejarNuevaContrasena);

    document.querySelectorAll('.btn-ojo').forEach((btn) => {
        btn.addEventListener('click', () => {
            const input = btn.previousElementSibling;
            const mostrar = input.type === 'password';
            input.type = mostrar ? 'text' : 'password';
            btn.textContent = mostrar ? '🙈' : '👁';
        });
    });
}

function mostrarFormulario(cual) {
    modoFormulario = cual;
    ['entrar', 'crear', 'recuperar', 'nuevaContrasena'].forEach((id) => {
        document.getElementById(`form${id[0].toUpperCase()}${id.slice(1)}`).hidden = id !== cual;
    });
    document.querySelectorAll('.login-tab').forEach((btn) => {
        btn.classList.toggle('activo', btn.dataset.tab === cual);
    });
    const mostrarExtras = cual === 'entrar' || cual === 'crear';
    document.getElementById('loginTabs').style.display = mostrarExtras ? 'flex' : 'none';
    document.getElementById('btnGoogle').style.display = mostrarExtras ? 'flex' : 'none';
    document.querySelector('.login-separador').style.display = mostrarExtras ? 'flex' : 'none';
    mostrarMsgCuenta('');
}

async function manejarEntrar(e) {
    e.preventDefault();
    const datos = Object.fromEntries(new FormData(e.target).entries());
    const { ok, error } = await iniciarSesionConCorreo(datos.correo, datos.contrasena);
    mostrarMsgCuenta(ok
        ? '¡Listo! Entrando...'
        : (error?.message?.includes('Invalid') ? 'Correo o contraseña incorrectos.' : 'No se pudo iniciar sesión.'));
}

async function manejarCrear(e) {
    e.preventDefault();
    const datos = Object.fromEntries(new FormData(e.target).entries());
    if (datos.contrasena !== datos.confirmar) {
        mostrarMsgCuenta('Las contraseñas no coinciden.');
        return;
    }
    const { ok, error, requiereConfirmacion } = await registrarConCorreo(datos.correo, datos.contrasena);
    if (!ok) {
        mostrarMsgCuenta(error?.message?.toLowerCase().includes('already registered')
            ? 'Ese correo ya tiene una cuenta. Prueba iniciar sesión.'
            : 'No se pudo crear la cuenta.');
        return;
    }
    mostrarMsgCuenta(requiereConfirmacion
        ? 'Cuenta creada. Revisa tu correo para confirmarla.'
        : '¡Cuenta creada! Entrando...');
}

async function manejarRecuperar(e) {
    e.preventDefault();
    const datos = Object.fromEntries(new FormData(e.target).entries());
    const { ok } = await recuperarContrasena(datos.correo);
    mostrarMsgCuenta(ok ? 'Revisa tu correo y sigue el enlace.' : 'No se pudo enviar el enlace.');
}

async function manejarNuevaContrasena(e) {
    e.preventDefault();
    const datos = Object.fromEntries(new FormData(e.target).entries());
    const { ok } = await establecerNuevaContrasena(datos.nueva);
    mostrarMsgCuenta(ok ? '¡Contraseña actualizada!' : 'No se pudo actualizar.');
}

function mostrarMsgCuenta(texto) { document.getElementById('loginMsg').textContent = texto; }

/* ============================================================
   BLOQUE 2 — Sync con Intralú
   ============================================================ */
function inicializarFormularioSync() {
    document.getElementById('syncCodigo').addEventListener('input', (e) => prepararPeriodos(e.target.value));
    document.querySelectorAll('#formSync .btn-ojo').forEach((btn) => {
        btn.addEventListener('click', () => {
            const input = btn.previousElementSibling;
            const mostrar = input.type === 'password';
            input.type = mostrar ? 'text' : 'password';
            btn.textContent = mostrar ? '🙈' : '👁';
        });
    });
    document.getElementById('formSync').addEventListener('submit', manejarSync);
}

/* Genera el dropdown de periodos acotado por el año de ingreso que viene
   en el código UNI (ej. "2023XXXXX" -> no ofrece periodos antes de 2023-1).
   Si el código todavía no tiene 4 dígitos válidos al inicio, usa un rango
   genérico hacia atrás para que el selector nunca quede vacío mientras el
   alumno todavía está escribiendo. */
function prepararPeriodos(codigoParcial) {
    const anioIngreso = parseInt((codigoParcial || '').slice(0, 4), 10);
    const anioValido = !Number.isNaN(anioIngreso) && anioIngreso >= 2000 && anioIngreso <= new Date().getFullYear();

    const hoy = new Date();
    let anio = hoy.getFullYear();
    let periodo = hoy.getMonth() >= 7 ? 2 : 1; // agosto en adelante = periodo 2

    const opciones = [];
    const limiteInferior = anioValido ? anioIngreso : anio - 8;
    while (anio > limiteInferior || (anio === limiteInferior && periodo >= 1)) {
        opciones.push(`${anio}-${periodo}`);
        if (periodo === 1) { periodo = 2; anio -= 1; } else { periodo = 1; }
        if (opciones.length >= 30) break; // tope de seguridad
    }

    const select = document.getElementById('syncPeriodo');
    const valorPrevio = select.value;
    select.innerHTML = opciones.map((p) => `<option value="${p}">${p}</option>`).join('');
    if (opciones.includes(valorPrevio)) select.value = valorPrevio;
}

function mostrarBanner(tipo, texto) {
    const banner = document.getElementById('bannerSync');
    banner.className = `banner-estado visible ${tipo}`;
    banner.textContent = texto;
}
function ocultarBanner() {
    document.getElementById('bannerSync').className = 'banner-estado';
}
function mostrarProgreso(texto) {
    document.getElementById('progresoSync').classList.add('visible');
    document.getElementById('progresoSyncTexto').textContent = texto;
}
function ocultarProgreso() {
    document.getElementById('progresoSync').classList.remove('visible');
}

async function manejarSync(e) {
    e.preventDefault();
    ocultarBanner();
    document.getElementById('resumenFinal').classList.remove('visible');

    const codigo = document.getElementById('syncCodigo').value.trim();
    const password = document.getElementById('syncPassword').value;
    const periodoElegido = document.getElementById('syncPeriodo').value;
    const btnSync = document.getElementById('btnSync');

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { mostrarBanner('error', 'Tu sesión expiró. Recarga la página.'); return; }

    btnSync.disabled = true;
    btnSync.textContent = 'Sincronizando...';

    try {
        // Paso 1: notas del periodo elegido (siempre).
        mostrarProgreso(`Cargando notas de ${periodoElegido}...`);
        const periodoNormalizado = periodoElegido.replace('-', '');
        const resultadoNotas = await sincronizarNotas(codigo, password, periodoNormalizado);

        const datosDelPeriodo = resultadoNotas.periodos?.[periodoNormalizado];
        if (!datosDelPeriodo || !datosDelPeriodo.cursos?.length) {
            mostrarBanner('advertencia', `Este periodo aún no tiene datos en Intralú. Puede que todavía no se abra.`);
        }

        // Paso 2: avance curricular, SOLO si es la primera sincronización de
        // este alumno (evita repetir un scrape pesado que no cambia seguido).
        const { count } = await supabase
            .from('avance_curricular')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', user.id);

        let cursosAvance = null;
        if (!count) {
            mostrarProgreso('Cargando tu avance curricular...');
            cursosAvance = await sincronizarAvanceCurricular(codigo, password);
        }

        // Guardado en Supabase.
        mostrarProgreso('Guardando...');
        await guardarPerfil(user.id, codigo, periodoNormalizado);
        if (datosDelPeriodo?.cursos?.length) {
            await guardarNotasPeriodo(user.id, periodoNormalizado, datosDelPeriodo.cursos);
            await guardarFormulasCache(periodoNormalizado, datosDelPeriodo.cursos);
        }
        if (cursosAvance?.length) {
            await guardarAvanceCurricular(user.id, cursosAvance);
        }

        ocultarProgreso();
        if (datosDelPeriodo?.cursos?.length) {
            document.getElementById('resumenFinalTexto').textContent =
                `${datosDelPeriodo.cursos.length} curso(s) en ${periodoElegido}` +
                (cursosAvance?.length ? `, ${cursosAvance.length} cursos en tu avance curricular.` : '.');
            document.getElementById('resumenFinal').classList.add('visible');
        }
    } catch (err) {
        ocultarProgreso();
        mostrarBanner('error', err.message || 'No pudimos conectar con la página de Intralú. Probablemente está caída o en mantenimiento ahora mismo. No es un error de SIGA.');
    } finally {
        btnSync.disabled = false;
        btnSync.textContent = 'Sincronizar';
        document.getElementById('syncPassword').value = '';
    }
}

/* Inicia el job de /api/sync-intralu y espera (polling cada 3s) a que
   termine — mismo patrón que ya usas en intranotas.js. Pide un solo
   periodo (el elegido), no todo el historial. */
async function sincronizarNotas(codigo, password, periodoNormalizado) {
    const respInicio = await fetch(`${BACKEND_URL}/api/sync-intralu`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codigo, password, periodo: periodoNormalizado }),
    });
    const dataInicio = await respInicio.json();
    if (!respInicio.ok) throw new Error(dataInicio.detail || 'No se pudo conectar con Intralú.');

    const inicio = Date.now();
    const LIMITE_MS = 5 * 60 * 1000;
    while (true) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        if (Date.now() - inicio > LIMITE_MS) throw new Error('La sincronización está tardando demasiado. Intenta de nuevo.');

        const resp = await fetch(`${BACKEND_URL}/api/sync-intralu/${dataInicio.job_id}`);
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.detail || 'Ocurrió un error al sincronizar.');
        if (data.status === 'listo') return data;

        mostrarProgreso(`Cargando notas de ${periodoNormalizado}...`);
    }
}

/* /api/avance-curricular es síncrona (login + PDF en un solo request),
   no usa job_id. */
async function sincronizarAvanceCurricular(codigo, password) {
    const resp = await fetch(`${BACKEND_URL}/api/avance-curricular`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codigo, password }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || 'No se pudo traer tu avance curricular.');
    return Array.isArray(data) ? data : data.cursos || [];
}

async function guardarPerfil(userId, codigo, periodoNormalizado) {
    await supabase.from('perfiles_usuario').upsert({
        user_id: userId,
        codigo_estudiante: codigo,
        facultad: facultadElegida.sigla,
        carrera: carreraElegida.nombre,
        periodo_actual: periodoNormalizado,
    }, { onConflict: 'user_id' });
}

async function guardarNotasPeriodo(userId, periodoNormalizado, cursos) {
    const filas = cursos.map((c) => ({
        user_id: userId,
        codigo_curso: c.codigo,
        periodo: periodoNormalizado,
        seccion: c.seccion || null,
        componentes: (c.evaluaciones || []).reduce((acc, ev) => {
            if (ev.etiqueta) acc[ev.etiqueta] = ev.nota;
            return acc;
        }, {}),
        fuente: 'intralu',
    }));
    await supabase.from('notas_periodo').upsert(filas, { onConflict: 'user_id,codigo_curso,periodo' });
}

async function guardarFormulasCache(periodoNormalizado, cursos) {
    const filas = cursos
        .filter((c) => c.formula_practicas_raw || c.formula_final_raw)
        .map((c) => ({
            codigo_curso: c.codigo,
            seccion: c.seccion || '',
            periodo: periodoNormalizado,
            formula_practicas_raw: c.formula_practicas_raw || null,
            formula_final_raw: c.formula_final_raw || null,
        }));
    if (filas.length) {
        await supabase.from('formulas_curso_cache').upsert(filas, { onConflict: 'codigo_curso,seccion,periodo' });
    }
}

async function guardarAvanceCurricular(userId, cursos) {
    const filas = cursos.map((c) => ({
        user_id: userId,
        facultad: facultadElegida.sigla,
        carrera: carreraElegida.nombre,
        codigo_curso: c.codigo,
        nombre_curso: c.nombre,
        creditos: c.creditos ?? null,
        prerequisitos: c.prerequisitos || null,
        ciclo: c.ciclo ?? null,
        periodo_pdf: c.periodo_pdf || null,
        periodo_normalizado: c.periodo_normalizado || null,
        nota: c.nota ?? null,
        veces_llevado: c.veces_llevado ?? null,
        situacion: c.situacion || null,
        categoria: c.categoria || 'obligatorio',
    }));
    await supabase.from('avance_curricular').upsert(filas, { onConflict: 'user_id,codigo_curso' });
}