// js/login-multifacultad.js — Pantalla de sync de siga-multifacultad.
// Sandbox de prueba (solo Harry) — sin login visible: se usa una sesión
// anónima de Supabase para tener un user_id real donde guardar los datos,
// sin pedirle cuenta a nadie. Sincroniza con Intralú: notas del periodo
// elegido + avance curricular completo SOLO la primera vez.
//
// Desde que INTRALU exige reCAPTCHA en su login, ya no se piden código ni
// contraseña acá: se usa el "SIGA Conector" (extensión de Chrome, la misma
// que ya usa la producción real de SIGA) para tomar prestada la sesión que
// el alumno ya abrió manualmente en INTRALU. Ver pingExtensionSiga() /
// pedirCookiesExtensionSiga() más abajo — mismo contrato exacto que
// intranotas.js de producción.
import { supabase, obtenerSesion } from './auth-siga.js';
import { FACULTADES } from './facultades-datos.js';

const CLAVE_SESSION = 'siga_multifacultad_seleccion';
const EXTENSION_SIGA_URL = 'https://github.com/HarryPC2023/siga-conector/releases/download/v1.0.0/siga-conector-extension.zip';

// Local en tu compu (Jekyll) usa el backend local; en cualquier otro caso
// (GitHub Pages) usa la URL real de Render — mismo patrón que ya usas en
// intranotas.js para el backend de producción.
const BACKEND_URL = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    ? 'http://localhost:8000'
    : 'https://siga-multifacultad.onrender.com';

let facultadElegida, carreraElegida;

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

    // 2. Sesión: en este sandbox de prueba no se le pide cuenta a nadie —
    // se crea (o recupera) una sesión anónima sola, en silencio. Sigue
    // habiendo un user_id real para guardar los datos en Supabase, pero
    // nunca aparece pantalla de login.
    // El bloque se muestra YA (no después de lograr la sesión), para que
    // si signInAnonymously() falla, el banner de error sea visible en vez
    // de quedar escondido dentro de una sección oculta.
    document.getElementById('bloqueSync').classList.add('visible');

    let user;
    try {
        const sesion = await asegurarSesionAnonima();
        user = sesion.user;
    } catch {
        return; // el banner de error ya quedó mostrado dentro de asegurarSesionAnonima()
    }

    // 3. ¿Ya sabemos su periodo de ingreso? Orden de prioridad para no
    // preguntar de más:
    //    a) periodo_ingreso ya guardado -> se usa directo.
    //    b) codigo_estudiante ya guardado (ej. lo puso en el módulo Perfil,
    //       que hoy no existe en este sandbox pero podría en el futuro) ->
    //       se deriva el año de los primeros 4 dígitos, sin preguntar nada.
    //    c) ninguno de los dos -> se pregunta una sola vez.
    const { data: perfil } = await supabase
        .from('perfiles_usuario')
        .select('periodo_ingreso, codigo_estudiante')
        .eq('user_id', user.id)
        .maybeSingle();

    if (perfil?.periodo_ingreso) {
        arrancarBloqueSync(perfil.periodo_ingreso);
    } else if (perfil?.codigo_estudiante) {
        const periodoDerivado = await derivarYGuardarPeriodoDesdeCodigo(user.id, perfil.codigo_estudiante);
        if (periodoDerivado) {
            arrancarBloqueSync(periodoDerivado);
        } else {
            document.getElementById('bloqueSync').classList.remove('visible');
            mostrarBloquePeriodoIngreso(user.id);
        }
    } else {
        document.getElementById('bloqueSync').classList.remove('visible');
        mostrarBloquePeriodoIngreso(user.id);
    }
});

/* El código UNI empieza con el año de ingreso (ej. "20231059E" -> 2023).
   Si ya está guardado (puesto en otro módulo, ej. Perfil), no hace falta
   preguntar el periodo de ingreso — se deriva y se guarda solo. Se asume
   tipo "-1" porque para acotar el selector de periodos solo importa el
   año, nunca el tipo exacto (ver prepararPeriodosSync). Si el código no
   calza con el formato esperado, devuelve null para que el flujo caiga
   de vuelta a preguntar. */
async function derivarYGuardarPeriodoDesdeCodigo(userId, codigoEstudiante) {
    const anio = parseInt(String(codigoEstudiante).trim().slice(0, 4), 10);
    const anioValido = !Number.isNaN(anio) && anio >= 2000 && anio <= new Date().getFullYear();
    if (!anioValido) return null;

    const periodoDerivado = `${anio}-1`;
    await supabase.from('perfiles_usuario').upsert({
        user_id: userId,
        periodo_ingreso: periodoDerivado,
    }, { onConflict: 'user_id' });
    return periodoDerivado;
}

async function asegurarSesionAnonima() {
    const sesionExistente = await obtenerSesion();
    if (sesionExistente) return sesionExistente;

    const { data, error } = await supabase.auth.signInAnonymously();
    if (error) {
        mostrarBanner('error', 'No se pudo iniciar la sesión de prueba. Recarga la página.');
        throw error;
    }
    return data.session;
}

/* ============================================================
   BLOQUE — Periodo de ingreso (una sola vez por alumno)
   ============================================================ */
function mostrarBloquePeriodoIngreso(userId) {
    const bloque = document.getElementById('bloquePeriodoIngreso');
    bloque.classList.add('visible');

    const hoy = new Date();
    let anio = hoy.getFullYear();
    let periodo = hoy.getMonth() >= 7 ? 2 : 1;
    const opciones = [];
    for (let i = 0; i < 20; i++) {
        opciones.push({ value: `${anio}-${periodo}`, label: `${anio}-${periodo}` });
        if (periodo === 1) { periodo = 2; anio -= 1; } else { periodo = 1; }
    }

    const selector = inicializarSelectPersonalizado({
        triggerId: 'ingresoTrigger', textoId: 'ingresoTriggerTexto',
        listaId: 'ingresoLista', valorId: 'ingresoValor',
        opciones,
    });

    document.getElementById('btnContinuarIngreso').addEventListener('click', async () => {
        const elegido = document.getElementById('ingresoValor').value;
        if (!elegido) return;

        const btn = document.getElementById('btnContinuarIngreso');
        btn.disabled = true;
        btn.textContent = 'Guardando...';

        const { error } = await supabase.from('perfiles_usuario').upsert({
            user_id: userId,
            facultad: facultadElegida.sigla,
            carrera: carreraElegida.nombre,
            periodo_ingreso: elegido,
        }, { onConflict: 'user_id' });

        if (error) {
            btn.disabled = false;
            btn.textContent = 'Continuar';
            mostrarBanner('error', 'No se pudo guardar tu periodo de ingreso. Intenta de nuevo.');
            return;
        }

        bloque.classList.remove('visible');
        arrancarBloqueSync(elegido);
    });
}

function arrancarBloqueSync(periodoIngreso) {
    document.getElementById('bloqueSync').classList.add('visible');
    prepararPeriodosSync(periodoIngreso);
    inicializarFormularioSync();
}

function pintarEleccion() {
    document.getElementById('eleccionIcono').src = facultadElegida.icono;
    document.getElementById('eleccionIcono').alt = `Ícono de ${facultadElegida.sigla}`;
    document.getElementById('eleccionSigla').textContent = facultadElegida.sigla;
    document.getElementById('eleccionCarrera').textContent = carreraElegida.nombre;
}

let jobIdActual = null;
let syncCancelada = false;
let controladorAvance = null;

/* ============================================================
   BLOQUE — Sync con Intralú (vía SIGA Conector)
   ============================================================ */
function inicializarFormularioSync() {
    document.getElementById('formSync').addEventListener('submit', manejarSync);
    document.getElementById('btnCancelarSync').addEventListener('click', cancelarSyncEnCurso);
}

/* Genera el dropdown de periodos acotado por el año del periodo de
   ingreso guardado en el perfil (ej. "2023-1" -> no ofrece periodos
   antes de 2023-1). Usa selector-personalizado, igual que el resto de
   SIGA — nada de <select> nativo. */
function prepararPeriodosSync(periodoIngreso) {
    const anioIngreso = parseInt((periodoIngreso || '').slice(0, 4), 10);
    const anioValido = !Number.isNaN(anioIngreso) && anioIngreso >= 2000 && anioIngreso <= new Date().getFullYear();

    const hoy = new Date();
    let anio = hoy.getFullYear();
    let periodo = hoy.getMonth() >= 7 ? 2 : 1; // agosto en adelante = periodo 2

    const opciones = [];
    const limiteInferior = anioValido ? anioIngreso : anio - 8;
    while (anio > limiteInferior || (anio === limiteInferior && periodo >= 1)) {
        opciones.push({ value: `${anio}-${periodo}`, label: `${anio}-${periodo}` });
        if (periodo === 1) { periodo = 2; anio -= 1; } else { periodo = 1; }
        if (opciones.length >= 30) break; // tope de seguridad
    }

    inicializarSelectPersonalizado({
        triggerId: 'syncPeriodoTrigger', textoId: 'syncPeriodoTriggerTexto',
        listaId: 'syncPeriodoLista', valorId: 'syncPeriodoValor',
        opciones,
    });
}

/* Le pregunta a la extensión 'SIGA Conector' (si está instalada) si
   está presente, vía postMessage — el content script de la extensión
   contesta con SIGA_EXT_PONG casi al instante. Si no hay extensión
   instalada, nadie contesta y se resuelve false tras el timeout.
   Mismo contrato exacto que intranotas.js de producción. */
function pingExtensionSiga(timeoutMs = 700) {
    return new Promise((resolve) => {
        let resuelto = false;
        function onMessage(event) {
            if (event.source !== window || event.data?.type !== 'SIGA_EXT_PONG') return;
            resuelto = true;
            window.removeEventListener('message', onMessage);
            resolve(true);
        }
        window.addEventListener('message', onMessage);
        window.postMessage({ type: 'SIGA_EXT_PING' }, window.location.origin);
        setTimeout(() => {
            if (resuelto) return;
            window.removeEventListener('message', onMessage);
            resolve(false);
        }, timeoutMs);
    });
}

/* Le pide a la extensión las cookies de sesión de Intralú. Devuelve
   { ok:true, sessionCookie, xsrfToken } si el alumno tiene sesión
   activa, o { ok:false, motivo } si no. */
function pedirCookiesExtensionSiga(timeoutMs = 3000) {
    return new Promise((resolve) => {
        let resuelto = false;
        function onMessage(event) {
            if (event.source !== window || event.data?.type !== 'SIGA_EXT_COOKIES') return;
            resuelto = true;
            window.removeEventListener('message', onMessage);
            resolve(event.data);
        }
        window.addEventListener('message', onMessage);
        window.postMessage({ type: 'SIGA_EXT_REQUEST_COOKIES' }, window.location.origin);
        setTimeout(() => {
            if (resuelto) return;
            window.removeEventListener('message', onMessage);
            resolve({ ok: false, motivo: 'timeout' });
        }, timeoutMs);
    });
}

function mostrarEstadoExtension(html, tipo) {
    const el = document.getElementById('sync-intralu-estado-extension');
    el.style.display = 'block';
    el.style.background = tipo === 'error' ? '#FBE1E1' : '#e0f2fe';
    el.innerHTML = html;
}
function ocultarEstadoExtension() {
    document.getElementById('sync-intralu-estado-extension').style.display = 'none';
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
    ocultarEstadoExtension();
    document.getElementById('resumenFinal').classList.remove('visible');
    syncCancelada = false;
    jobIdActual = null;

    const periodoElegido = document.getElementById('syncPeriodoValor').value;
    if (!periodoElegido) { mostrarBanner('error', 'Elige un periodo para sincronizar.'); return; }

    const btnSync = document.getElementById('btnSync');
    const btnCancelar = document.getElementById('btnCancelarSync');

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { mostrarBanner('error', 'Tu sesión expiró. Recarga la página.'); return; }

    btnSync.disabled = true;

    // Paso 1: ¿está instalado el conector?
    btnSync.textContent = 'Verificando conector...';
    const hayExtension = await pingExtensionSiga();
    if (!hayExtension) {
        mostrarEstadoExtension(
            `⚠️ No detectamos el conector de SIGA en tu navegador.
             <br><a href="${EXTENSION_SIGA_URL}" target="_blank" style="color:var(--brand-morado); font-weight:600;">Agrégalo aquí</a> y vuelve a presionar Sincronizar.`,
            'error'
        );
        btnSync.disabled = false;
        btnSync.textContent = 'Sincronizar';
        return;
    }

    // Paso 2: ¿tiene sesión activa en Intralú?
    btnSync.textContent = 'Verificando sesión...';
    const cookies = await pedirCookiesExtensionSiga();
    if (!cookies.ok) {
        mostrarEstadoExtension(
            `⚠️ Abre INTRALU, inicia sesión y vuelve aquí para sincronizar.
             <br><a href="https://alumnos.uni.edu.pe/login" target="_blank" style="color:var(--brand-morado); font-weight:600;">Abrir INTRALU</a>`,
            'error'
        );
        btnSync.disabled = false;
        btnSync.textContent = 'Sincronizar';
        return;
    }

    btnSync.textContent = 'Sincronizando...';
    btnCancelar.style.display = 'block'; // recién ahora hay algo real que cancelar

    try {
        // Paso 3: notas del periodo elegido (siempre), con la sesión prestada.
        mostrarProgreso(`Cargando notas de ${periodoElegido}...`);
        const periodoNormalizado = periodoElegido.replace('-', '');
        const resultadoNotas = await sincronizarNotas(cookies, periodoNormalizado);

        const datosDelPeriodo = resultadoNotas.periodos?.[periodoNormalizado];
        if (!datosDelPeriodo || !datosDelPeriodo.cursos?.length) {
            mostrarBanner('advertencia', `Este periodo aún no tiene datos en Intralú. Puede que todavía no se abra.`);
        }

        // Paso 4: avance curricular, SOLO si es la primera sincronización de
        // este alumno (evita repetir un scrape pesado que no cambia seguido).
        if (syncCancelada) throw new Error('CANCELADO');

        const { count } = await supabase
            .from('avance_curricular')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', user.id);

        let cursosAvance = null;
        if (!count) {
            cursosAvance = await sincronizarAvanceCurricular(cookies);
        }

        // Guardado en Supabase.
        mostrarProgreso('Guardando...');
        await guardarPerfil(user.id, periodoNormalizado);
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
                `${datosDelPeriodo.cursos.length} curso(s) sincronizado(s) en ${periodoElegido}.`;
            document.getElementById('resumenFinal').classList.add('visible');
        }
    } catch (err) {
        ocultarProgreso();
        if (err.message === 'CANCELADO') {
            mostrarBanner('advertencia', 'Sincronización cancelada.');
        } else {
            mostrarBanner('error', err.message || 'No pudimos conectar con la página de Intralú. Probablemente está caída o en mantenimiento ahora mismo. No es un error de SIGA.');
        }
    } finally {
        btnSync.disabled = false;
        btnSync.textContent = 'Sincronizar';
        btnCancelar.style.display = 'none';
        jobIdActual = null;
        controladorAvance = null;
        syncCancelada = false;
    }
}

/* Cancela una sincronización en curso: avisa al backend (para que suelte
   el semáforo y no siga gastando el único slot de scraping del plan
   gratuito de Render) y corta cualquier fetch en curso del lado del
   cliente. El bucle de polling / el fetch de avance curricular recogen
   `syncCancelada` y terminan solos con el error especial 'CANCELADO',
   que el catch de arriba trata como cancelación, no como falla real. */
function cancelarSyncEnCurso() {
    syncCancelada = true;
    if (jobIdActual) {
        fetch(`${BACKEND_URL}/api/sync-intralu/${jobIdActual}/cancelar`, { method: 'POST' }).catch(() => { });
    }
    if (controladorAvance) {
        controladorAvance.abort();
    }
}

/* Inicia el job de /api/sync-intralu y espera (polling cada 3s) a que
   termine — mismo patrón que ya usas en intranotas.js. Pide un solo
   periodo (el elegido), no todo el historial. Ya no manda código ni
   contraseña: manda la sesión que prestó el conector. */
async function sincronizarNotas(cookies, periodoNormalizado) {
    const respInicio = await fetch(`${BACKEND_URL}/api/sync-intralu`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            session_cookie: cookies.sessionCookie,
            xsrf_token: cookies.xsrfToken,
            periodo: periodoNormalizado,
        }),
    });
    const dataInicio = await respInicio.json();
    if (!respInicio.ok) throw new Error(dataInicio.detail || 'No se pudo conectar con Intralú.');
    jobIdActual = dataInicio.job_id;

    const inicio = Date.now();
    const LIMITE_MS = 5 * 60 * 1000;
    while (true) {
        if (syncCancelada) throw new Error('CANCELADO');
        await new Promise((resolve) => setTimeout(resolve, 3000));
        if (syncCancelada) throw new Error('CANCELADO');
        if (Date.now() - inicio > LIMITE_MS) throw new Error('La sincronización está tardando demasiado. Intenta de nuevo.');

        const resp = await fetch(`${BACKEND_URL}/api/sync-intralu/${dataInicio.job_id}`);
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.detail || 'Ocurrió un error al sincronizar.');
        if (data.status === 'cancelado') throw new Error('CANCELADO');
        if (data.status === 'listo') return data;

        mostrarProgreso(`Cargando notas de ${periodoNormalizado}...`);
    }
}

/* /api/avance-curricular es síncrona (login + PDF en un solo request),
   no usa job_id. Usa AbortController porque, al no tener job/polling, es
   la única forma de cortarla del lado del cliente si se cancela — el
   scraping del lado del servidor puede seguir un rato más hasta que note
   que ya nadie espera la respuesta (limitación conocida, aceptable
   porque este endpoint es rápido: un login + una descarga de PDF). */
async function sincronizarAvanceCurricular(cookies) {
    controladorAvance = new AbortController();
    const resp = await fetch(`${BACKEND_URL}/api/avance-curricular`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            session_cookie: cookies.sessionCookie,
            xsrf_token: cookies.xsrfToken,
        }),
        signal: controladorAvance.signal,
    }).catch((err) => {
        if (err.name === 'AbortError') throw new Error('CANCELADO');
        throw err;
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || 'No se pudo traer tu avance curricular.');
    return Array.isArray(data) ? data : data.cursos || [];
}

async function guardarPerfil(userId, periodoNormalizado) {
    await supabase.from('perfiles_usuario').upsert({
        user_id: userId,
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