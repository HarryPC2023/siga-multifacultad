// js/login-multifacultad.js — Pantalla de sync de siga-multifacultad.
// Flujo por CÓDIGO+CONTRASEÑA (reemplaza al bookmarklet, que a su vez
// había reemplazado a la extensión SIGA Conector): el alumno escribe su
// código y contraseña de INTRALU aquí mismo; SIGA los manda una sola vez
// al backend propio (scraping_intralu.py en Render), que hace login con
// Playwright + stealth (pasa el reCAPTCHA) y trae notas+fórmulas por HTTP
// directo. El backend responde al instante con un job_id y el trabajo
// real corre en un hilo aparte — el frontend hace polling hasta que
// termina. Ni el código ni la contraseña se guardan en ningún lado.
import { supabase, obtenerSesion } from './auth-siga.js';
import { FACULTADES } from './facultades-datos.js';
import { parsearAvanceCurricular } from './avance-curricular-parser.js';
import { guardarAvanceCurricular } from './avance-curricular-guardar.js';
import * as pdfjsLib from '../vendor-pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc =
    new URL('../vendor-pdfjs/pdf.worker.min.mjs', import.meta.url).href;

// URL confirmada en vivo con Harry — servicio Render "siga-multifacultad".
const BACKEND_BASE_URL = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    ? 'http://localhost:8000'
    : 'https://siga-multifacultad.onrender.com';
const BACKEND_SYNC_URL = `${BACKEND_BASE_URL}/api/sync-intralu`;

// Cada cuántos ms se pregunta al backend si ya terminó, y cuánto se
// espera como máximo antes de rendirse (Render free tier + Playwright
// + varios cursos puede tardar 1-2 minutos reales).
const INTERVALO_POLLING_MS = 3000;
const TIMEOUT_POLLING_MS = 240000;

let hayCredencialGuardada = false;

document.addEventListener('DOMContentLoaded', async () => {
    prepararOjoPassword();

    // 1. Sesión anónima (sandbox de prueba, sin cuenta real).
    let user;
    try {
        const sesion = await asegurarSesionAnonima();
        user = sesion.user;
    } catch {
        return; // el banner de error ya quedó mostrado dentro de asegurarSesionAnonima()
    }

    // 2. ¿Ya sabemos su periodo de ingreso? (dato informativo del perfil,
    // no tiene relación con qué periodo se sincroniza ahora). Facultad y
    // carrera YA NO se piden ni se guardan acá — se autodetectan del
    // Avance Curricular apenas termina la primera sincronización (ver
    // guardarPerfilAcademicoDesdeAvance, más abajo).
    const { data: perfil } = await supabase
        .from('perfiles_usuario')
        .select('periodo_ingreso, codigo_estudiante')
        .eq('user_id', user.id)
        .maybeSingle();

    if (perfil?.periodo_ingreso) {
        mostrarBloqueSync(user.id, perfil.periodo_ingreso);
    } else if (perfil?.codigo_estudiante) {
        const derivado = await derivarYGuardarPeriodoDesdeCodigo(user.id, perfil.codigo_estudiante);
        if (derivado) {
            mostrarBloqueSync(user.id, derivado);
        } else {
            mostrarBloquePeriodoIngreso(user.id);
        }
    } else {
        mostrarBloquePeriodoIngreso(user.id);
    }
});

/* El código UNI empieza con el año de ingreso (ej. "20231059E" -> 2023).
   Si ya está guardado, no hace falta preguntar el periodo de ingreso —
   se deriva y se guarda solo. Si el código no calza, devuelve null. */
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

/* Guarda facultad/carrera en perfiles_usuario usando el resultado YA
   calculado por guardarAvanceCurricular() (ver avance-curricular-
   guardar.js) — nunca una elección manual. Solo se llama cuando ese
   guardado salió bien (resultadoAvance.ok); si el PDF no calzó con
   ninguna de las 11 facultades conocidas, no hay nada que guardar acá
   y el perfil simplemente se queda sin facultad hasta la próxima sync. */
async function guardarPerfilAcademicoDesdeAvance(userId, resultadoAvance) {
    await supabase.from('perfiles_usuario').upsert({
        user_id: userId,
        facultad: resultadoAvance.facultad,
        carrera: resultadoAvance.carrera,
    }, { onConflict: 'user_id' });
}

/* Pinta la insignia de facultad/carrera en la pantalla de éxito, con
   el ícono y el color REALES de esa facultad (mismos datos que usa el
   selector de index.html) — nunca un color genérico. */
function pintarInsigniaFacultad(siglaFacultad, nombreCarrera) {
    const cont = document.getElementById('insigniaFacultad');
    const facultad = FACULTADES.find((f) => f.sigla === siglaFacultad);
    if (!cont || !facultad) return;

    cont.style.borderColor = facultad.color;
    cont.innerHTML = `
        <img class="insignia-facultad__icono" src="${facultad.icono}" alt="Ícono de ${facultad.sigla}">
        <div>
            <div class="insignia-facultad__sigla" style="color:${facultad.color};">${facultad.sigla}</div>
            <div class="insignia-facultad__carrera">${nombreCarrera}</div>
        </div>
    `;
    cont.className = 'insignia-facultad';
    cont.style.display = 'inline-flex';
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

    inicializarSelectPersonalizado({
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
            periodo_ingreso: elegido,
        }, { onConflict: 'user_id' });

        if (error) {
            btn.disabled = false;
            btn.textContent = 'Continuar';
            mostrarBanner('error', 'No se pudo guardar tu periodo de ingreso. Intenta de nuevo.');
            return;
        }

        bloque.classList.remove('visible');
        mostrarBloqueSync(userId, elegido);
    });
}

/* ============================================================
   BLOQUE — Mostrar/ocultar la contraseña (mismo patrón que
   .btn-ojo en la producción real de SIGA, ver index.html).
   ============================================================ */
function prepararOjoPassword() {
    const boton = document.getElementById('btnOjoSync');
    const input = document.getElementById('syncPassword');
    if (!boton || !input) return;
    boton.addEventListener('click', () => {
        const mostrar = input.type === 'password';
        input.type = mostrar ? 'text' : 'password';
        boton.setAttribute('aria-label', mostrar ? 'Ocultar contraseña' : 'Mostrar contraseña');
    });
}

/* ============================================================
   BLOQUE — Sync con Intralú (vía backend propio, código+contraseña)
   ============================================================ */
let syncCancelada = false;
let jobIdActual = null;

/* Da el (anio, tipo) cronológicamente ANTERIOR a un (anio, tipo) dado.
   Orden real dentro de un año: tipo 1 (mar-jul) -> tipo 2 (ago-dic) ->
   tipo 3 = verano (ene-feb del año SIGUIENTE, pero etiquetado con el
   año que ya venía corriendo, ej. "24V" de Intralú = "20233", no
   "20243" -- confirmado en decisions-and-learnings). Por eso el paso
   anterior a un tipo 1 es el tipo 3 del año ANTERIOR, no el tipo 2. */
function pasoAnterior(anio, tipo) {
    if (tipo === 1) return { anio: anio - 1, tipo: 3 };
    if (tipo === 2) return { anio, tipo: 1 };
    return { anio, tipo: 2 }; // tipo === 3
}

/* Punto de partida del selector: el periodo "actual" aproximado según
   la fecha de hoy. Enero/febrero cae en verano (tipo 3, año anterior);
   marzo-julio es tipo 1; agosto-diciembre es tipo 2. */
function periodoActualAproximado() {
    const hoy = new Date();
    const mes = hoy.getMonth() + 1;
    const anio = hoy.getFullYear();
    if (mes <= 2) return { anio: anio - 1, tipo: 3 };
    if (mes <= 7) return { anio, tipo: 1 };
    return { anio, tipo: 2 };
}

/* Genera el dropdown de periodos (incluyendo verano) acotado por el
   año del periodo de ingreso guardado en el perfil. */
function prepararPeriodosSync(periodoIngreso) {
    const anioIngreso = parseInt((periodoIngreso || '').slice(0, 4), 10);
    const anioValido = !Number.isNaN(anioIngreso) && anioIngreso >= 2000 && anioIngreso <= new Date().getFullYear();
    const limiteInferior = anioValido ? anioIngreso : new Date().getFullYear() - 8;

    let actual = periodoActualAproximado();
    const opciones = [];
    while (actual.anio > limiteInferior || (actual.anio === limiteInferior && actual.tipo >= 1)) {
        opciones.push({ value: `${actual.anio}${actual.tipo}`, label: `${actual.anio}-${actual.tipo}` });
        actual = pasoAnterior(actual.anio, actual.tipo);
        if (opciones.length >= 60) break; // tope de seguridad (3 tipos por año, no 2 como antes)
    }

    inicializarSelectPersonalizado({
        triggerId: 'syncPeriodoTrigger', textoId: 'syncPeriodoTriggerTexto',
        listaId: 'syncPeriodoLista', valorId: 'syncPeriodoValor',
        opciones,
    });
}

async function mostrarBloqueSync(userId, periodoIngreso) {
    document.getElementById('bloqueSync').classList.add('visible');
    prepararPeriodosSync(periodoIngreso);
    document.getElementById('formSync').addEventListener('submit', (e) => manejarSync(e, userId));
    document.getElementById('btnCancelarSync').addEventListener('click', cancelarSyncEnCurso);
    document.getElementById('btnOlvidarCredencial').addEventListener('click', () => olvidarCredencial(userId));

    hayCredencialGuardada = await verificarCredencialGuardada(userId);
    aplicarEstadoCredencial();
}

/* Refleja hayCredencialGuardada en el formulario: si ya hay una
   contraseña guardada, el campo deja de ser obligatorio y se explica
   que puede dejarse vacío. */
function aplicarEstadoCredencial() {
    const passwordInput = document.getElementById('syncPassword');
    const aviso = document.getElementById('avisoCredencialGuardada');
    passwordInput.required = !hayCredencialGuardada;
    passwordInput.placeholder = hayCredencialGuardada
        ? 'Contraseña'
        : 'Contraseña de INTRALU';
    aviso.style.display = hayCredencialGuardada ? 'block' : 'none';
}

/* Le pregunta al backend si este alumno ya tiene una contraseña
   guardada — nunca trae la contraseña en sí, solo un true/false. Si
   la consulta falla (backend dormido, red, etc.), asumimos que no hay
   guardada y simplemente se pide como siempre: no es un error grave. */
async function verificarCredencialGuardada(userId) {
    try {
        const resp = await fetch(`${BACKEND_BASE_URL}/api/tiene-credencial/${userId}`);
        if (!resp.ok) return false;
        const data = await resp.json();
        return !!data.tiene;
    } catch {
        return false;
    }
}

/* El alumno pidió que SIGA olvide su contraseña guardada. */
async function olvidarCredencial(userId) {
    const confirmado = window.confirm('¿Seguro que quieres que SIGA olvide tu contraseña guardada? La próxima vez que sincronices tendrás que escribirla de nuevo.');
    if (!confirmado) return;

    try {
        await fetch(`${BACKEND_BASE_URL}/api/credencial/${userId}`, { method: 'DELETE' });
    } catch {
        // Best-effort: si falla, el peor caso es que siga guardada y
        // el alumno lo intente de nuevo — no rompemos el flujo por esto.
    }
    hayCredencialGuardada = false;
    aplicarEstadoCredencial();
    mostrarBanner('exito', 'Listo, ya no tenemos tu contraseña guardada.');
}

/* Espera a que pasen `ms` milisegundos, sin bloquear el hilo — usado
   entre cada intento de polling. */
function esperar(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/* Arranca el job en el backend (POST) y hace polling (GET) hasta que
   quede "listo", "cancelado", o el backend responda un error real
   (credenciales incorrectas, servidor ocupado, etc.). Nunca lanza: 
   siempre resuelve con { ok, motivo?, detalle?, ...datos }, para que
   manejarSync() decida qué mostrar sin try/catch anidados. */
async function sincronizarConBackend(codigo, password, periodo, userId, recordar) {
    let jobId;
    try {
        const body = { codigo, periodo, user_id: userId, recordar };
        if (password) body.password = password; // vacío = usar la guardada
        const respInicio = await fetch(BACKEND_SYNC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const dataInicio = await respInicio.json();
        if (!respInicio.ok) {
            return { ok: false, motivo: 'error_inesperado', detalle: dataInicio.detail || 'No se pudo iniciar la sincronización.' };
        }
        jobId = dataInicio.job_id;
    } catch {
        return { ok: false, motivo: 'error_inesperado', detalle: 'No se pudo conectar con el servidor de sincronización. Probablemente está caído o en mantenimiento ahora mismo — no es un error tuyo.' };
    }

    jobIdActual = jobId;
    const inicio = Date.now();

    while (Date.now() - inicio < TIMEOUT_POLLING_MS) {
        if (syncCancelada) {
            return { ok: false, motivo: 'cancelado' };
        }

        await esperar(INTERVALO_POLLING_MS);

        let data;
        try {
            const resp = await fetch(`${BACKEND_SYNC_URL}/${jobId}`);
            data = await resp.json();
            if (!resp.ok) {
                return { ok: false, motivo: 'error_backend', detalle: data.detail };
            }
        } catch {
            // Un fallo de red puntual durante el polling no es motivo
            // para rendirse — se reintenta en la siguiente vuelta.
            continue;
        }

        if (data.status === 'en_progreso') {
            mostrarProgreso(data.periodo_actual
                ? `Sincronizando ${data.periodo_actual} en INTRALU...`
                : 'Iniciando sesión en INTRALU...');
            continue;
        }

        if (data.status === 'cancelado') {
            return { ok: false, motivo: 'cancelado' };
        }

        if (data.status === 'listo') {
            const datosPeriodo = (data.periodos || {})[periodo];
            if (!datosPeriodo || !datosPeriodo.cursos.length) {
                return { ok: false, motivo: 'sin_cursos', detalle: 'No se encontró ningún curso matriculado en INTRALU para ese periodo.' };
            }
            return {
                ok: true,
                periodo,
                cursos: datosPeriodo.cursos,
                errores: datosPeriodo.errores || [],
                avancePdfBase64: data.avance_pdf_base64 || null,
            };
        }
    }

    return { ok: false, motivo: 'timeout', detalle: 'La sincronización está tardando más de lo esperado. Intenta de nuevo en un momento.' };
}

function mensajeError(resultado) {
    const motivos = {
        timeout: resultado.detalle,
        sin_cursos: resultado.detalle || 'No se encontró ningún curso matriculado en INTRALU.',
        cancelado: 'Sincronización cancelada.',
        sin_periodo: 'Elige un periodo para sincronizar.',
        error_inesperado: resultado.detalle,
        error_backend: resultado.detalle || 'No pudimos conectar con INTRALU. Probablemente está caído o en mantenimiento ahora mismo. No es un error de SIGA.',
    };
    return motivos[resultado.motivo]
        || resultado.detalle
        || 'No pudimos conectar con INTRALU. Probablemente está caído o en mantenimiento ahora mismo. No es un error de SIGA.';
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

function numeroOMulo(valor) {
    if (valor === null || valor === undefined || valor === '') return null;
    const n = parseFloat(valor);
    return Number.isNaN(n) ? null : n;
}

/* Guarda notas + fórmulas en las 2 tablas nuevas: formulas_curso
   (compartida por sección, no por alumno) y notas_curso (con las
   evaluaciones crudas en jsonb, sin mapear a N1/EP/etc. — eso lo hace
   formula-mapper.js al vuelo, cuando se necesita calcular algo, nunca
   al guardar). */
async function guardarResultadoSync(userId, resultado) {
    if (!resultado.cursos.length) return;

    const filasFormulas = resultado.cursos.map((c) => ({
        codigo_curso: c.codigo,
        seccion: c.seccion,
        periodo: resultado.periodo,
        formula_practicas: c.formula_practicas,
        formula_nota_final: c.formula_nota_final,
        creditos: c.creditos,
    }));
    const { error: errorFormulas } = await supabase
        .from('formulas_curso')
        .upsert(filasFormulas, { onConflict: 'codigo_curso,seccion,periodo' });
    if (errorFormulas) throw errorFormulas;

    const filasNotas = resultado.cursos.map((c) => ({
        user_id: userId,
        periodo: resultado.periodo,
        codigo_curso: c.codigo,
        seccion: c.seccion,
        nombre_curso: c.nombre,
        promedio_practicas: numeroOMulo(c.promedio_practicas),
        promedio_final: numeroOMulo(c.promedio_final),
        nota_asistencia: numeroOMulo(c.nota_asistencia),
        evaluaciones: c.evaluaciones,
    }));
    const { error: errorNotas } = await supabase
        .from('notas_curso')
        .upsert(filasNotas, { onConflict: 'user_id,periodo,codigo_curso' });
    if (errorNotas) throw errorNotas;

    await supabase.from('perfiles_usuario').upsert({
        user_id: userId,
        periodo_actual: resultado.periodo,
    }, { onConflict: 'user_id' });
}

/* Extrae el texto del PDF (pdf.js) y lo pasa por el parser + guardado
   ya validados — mismo patrón que usaba avance-curricular-debug.js,
   ahora conectado al flujo real en vez de a un botón de prueba suelto. */
function base64AArrayBuffer(base64) {
    const binario = atob(base64);
    const bytes = new Uint8Array(binario.length);
    for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
    return bytes;
}

async function extraerTextoPdf(bytes) {
    const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
    let textoCompleto = '';
    for (let numPagina = 1; numPagina <= doc.numPages; numPagina++) {
        const pagina = await doc.getPage(numPagina);
        const contenido = await pagina.getTextContent();
        const lineaPagina = contenido.items.map((item) => item.str).join(' ');
        textoCompleto += `\n\n===== PÁGINA ${numPagina} =====\n\n${lineaPagina}`;
    }
    return textoCompleto;
}

async function guardarAvanceCurricularDesdeBase64(userId, base64) {
    const bytes = base64AArrayBuffer(base64);
    const texto = await extraerTextoPdf(bytes);
    const estructurado = parsearAvanceCurricular(texto);
    return guardarAvanceCurricular(userId, estructurado);
}

function cancelarSyncEnCurso() {
    syncCancelada = true;
    if (jobIdActual) {
        // Best-effort: solo levanta la bandera en el backend, no hace
        // falta esperar la respuesta para reflejar la cancelación acá.
        fetch(`${BACKEND_SYNC_URL}/${jobIdActual}/cancelar`, { method: 'POST' }).catch(() => { });
        jobIdActual = null;
    }
    ocultarProgreso();
    mostrarBanner('advertencia', 'Sincronización cancelada.');
    document.getElementById('btnCancelarSync').style.display = 'none';
    const btnSync = document.getElementById('btnSync');
    btnSync.disabled = false;
    btnSync.textContent = 'Sincronizar';
}

async function manejarSync(e, userId) {
    e.preventDefault();
    ocultarBanner();
    document.getElementById('resumenFinal').classList.remove('visible');
    syncCancelada = false;

    const btnSync = document.getElementById('btnSync');
    const btnCancelar = document.getElementById('btnCancelarSync');

    // Paso 1: código, contraseña (opcional si ya hay una guardada) y periodo.
    const codigo = document.getElementById('syncCodigo').value.trim().toUpperCase();
    const password = document.getElementById('syncPassword').value;
    const periodoElegido = document.getElementById('syncPeriodoValor').value;
    const recordar = document.getElementById('syncRecordar').checked;

    if (!codigo) {
        mostrarBanner('error', 'Ingresa tu código de estudiante.');
        return;
    }
    if (!password && !hayCredencialGuardada) {
        mostrarBanner('error', 'Ingresa tu contraseña de INTRALU.');
        return;
    }
    if (!periodoElegido) {
        mostrarBanner('error', 'Elige un periodo para sincronizar.');
        return;
    }

    // Paso 2: mandar credenciales al backend (si escribió una nueva —
    // si no, el backend usa la guardada) y esperar a que termine, con
    // polling. La contraseña nunca se guarda en SIGA salvo que el
    // alumno haya marcado "Recordar mi contraseña".
    btnSync.disabled = true;
    btnSync.textContent = 'Conectando...';
    btnCancelar.style.display = 'block';
    mostrarProgreso('Iniciando sesión en INTRALU...');

    const resultadoNotas = await sincronizarConBackend(codigo, password, periodoElegido, userId, recordar);
    document.getElementById('syncPassword').value = '';
    ocultarProgreso();
    btnCancelar.style.display = 'none';

    // Si esta sync guardó una contraseña nueva con éxito, el formulario
    // ya puede tratarla como "hay credencial guardada" sin esperar a
    // que la página se recargue.
    if (resultadoNotas.ok && recordar) {
        hayCredencialGuardada = true;
        aplicarEstadoCredencial();
        document.getElementById('syncRecordar').checked = false;
    }

    if (syncCancelada) return; // ya canceló y reseteó la UI, ignoramos esta respuesta tardía

    if (!resultadoNotas.ok) {
        mostrarBanner('error', mensajeError(resultadoNotas));
        btnSync.disabled = false;
        btnSync.textContent = 'Sincronizar';
        return;
    }

    // Paso 3: guardar notas + fórmulas, y — si el backend trajo el PDF en
    // esta misma sincronización — también el Avance Curricular. Si eso
    // sale bien, ESA es la única fuente de verdad para facultad/carrera:
    // se guardan en el perfil y se pintan en la insignia, nunca elegidas
    // a mano.
    try {
        mostrarProgreso('Guardando tus notas...');
        await guardarResultadoSync(userId, resultadoNotas);

        let textoAvance = '';
        if (resultadoNotas.avancePdfBase64) {
            try {
                mostrarProgreso('Guardando tu Avance Curricular...');
                const resultadoAvance = await guardarAvanceCurricularDesdeBase64(userId, resultadoNotas.avancePdfBase64);
                if (resultadoAvance.ok) {
                    await guardarPerfilAcademicoDesdeAvance(userId, resultadoAvance);
                    pintarInsigniaFacultad(resultadoAvance.facultad, resultadoAvance.carrera);
                    textoAvance = ` Avance Curricular actualizado (${resultadoAvance.cursosGuardados} curso(s)).`;
                } else {
                    textoAvance = ' No se pudo guardar tu Avance Curricular esta vez, pero tus notas sí se guardaron.';
                }
            } catch (errAvance) {
                console.error('Error guardando Avance Curricular:', errAvance);
                textoAvance = ' No se pudo guardar tu Avance Curricular esta vez, pero tus notas sí se guardaron.';
            }
        }

        ocultarProgreso();

        let texto = `${resultadoNotas.cursos.length} curso(s) sincronizado(s) en ${resultadoNotas.periodo}.`;
        if (resultadoNotas.errores.length) {
            texto += ` (${resultadoNotas.errores.length} curso(s) no se pudieron traer, intenta de nuevo más tarde.)`;
        }
        texto += textoAvance;

        document.getElementById('resumenFinalTexto').textContent = texto;
        document.getElementById('resumenFinal').classList.add('visible');
    } catch (err) {
        ocultarProgreso();
        mostrarBanner('error', 'Se sincronizó con INTRALU pero no se pudo guardar en Supabase. Intenta de nuevo.');
        console.error('Error guardando sync en Supabase:', err);
    } finally {
        btnSync.disabled = false;
        btnSync.textContent = 'Sincronizar';
    }
}