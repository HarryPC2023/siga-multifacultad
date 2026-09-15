// js/login-multifacultad.js — Pantalla de sync de siga-multifacultad.
// REESCRITO DESDE CERO para el flujo nuevo (sin backend propio, sin
// Playwright, sin selección manual de periodo). La extensión "SIGA
// Conector" (intralu_content_script.js + background.js) trae directo
// de INTRALU los cursos, notas y fórmulas del periodo que el alumno
// tenga activo en su sesión — SIGA solo pide el sync y guarda el
// resultado en Supabase (RLS con el user_id anónimo de este sandbox).
import { supabase, obtenerSesion } from './auth-siga.js';
import { FACULTADES } from './facultades-datos.js';

const CLAVE_SESSION = 'siga_multifacultad_seleccion';
const EXTENSION_SIGA_URL = 'https://github.com/HarryPC2023/siga-conector/releases/download/v1.0.0/siga-conector-extension.zip';

let facultadElegida, carreraElegida;

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Recupera la elección de facultad/carrera hecha en index.html.
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

    // 2. Sesión anónima (sandbox de prueba, sin cuenta real).
    let user;
    try {
        const sesion = await asegurarSesionAnonima();
        user = sesion.user;
    } catch {
        return; // el banner de error ya quedó mostrado dentro de asegurarSesionAnonima()
    }

    // 3. ¿Ya sabemos su periodo de ingreso? (dato informativo del perfil,
    // no tiene relación con qué periodo se sincroniza ahora).
    const { data: perfil } = await supabase
        .from('perfiles_usuario')
        .select('periodo_ingreso, codigo_estudiante')
        .eq('user_id', user.id)
        .maybeSingle();

    if (perfil?.periodo_ingreso) {
        await guardarPerfilBase(user.id);
        mostrarBloqueSync(user.id, perfil.periodo_ingreso);
    } else if (perfil?.codigo_estudiante) {
        const derivado = await derivarYGuardarPeriodoDesdeCodigo(user.id, perfil.codigo_estudiante);
        await guardarPerfilBase(user.id);
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

async function guardarPerfilBase(userId) {
    await supabase.from('perfiles_usuario').upsert({
        user_id: userId,
        facultad: facultadElegida.sigla,
        carrera: carreraElegida.nombre,
    }, { onConflict: 'user_id' });
}

function pintarEleccion() {
    document.getElementById('eleccionIcono').src = facultadElegida.icono;
    document.getElementById('eleccionIcono').alt = `Ícono de ${facultadElegida.sigla}`;
    document.getElementById('eleccionSigla').textContent = facultadElegida.sigla;
    document.getElementById('eleccionCarrera').textContent = carreraElegida.nombre;
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
        mostrarBloqueSync(userId, elegido);
    });
}

/* ============================================================
   BLOQUE — Sync con Intralú (vía SIGA Conector, flujo directo)
   ============================================================ */
let syncCancelada = false;

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

function mostrarBloqueSync(userId, periodoIngreso) {
    document.getElementById('bloqueSync').classList.add('visible');
    prepararPeriodosSync(periodoIngreso);
    document.getElementById('formSync').addEventListener('submit', (e) => manejarSync(e, userId));
    document.getElementById('btnCancelarSync').addEventListener('click', cancelarSyncEnCurso);
}

/* Le pregunta a la extensión si está presente, vía postMessage — el
   content script contesta con SIGA_EXT_PONG casi al instante. Si no
   hay extensión instalada, nadie contesta y se resuelve false tras
   el timeout. */
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

/* Pide la sincronización real (cursos + notas + fórmulas del periodo
   activo en INTRALU). Puede tardar: la extensión pide curso por curso,
   uno a la vez, para no saturar a INTRALU — con 7-10 cursos, unos
   cuantos segundos es normal. */
function pedirSyncExtensionSiga(periodo, timeoutMs = 120000) {
    return new Promise((resolve) => {
        let resuelto = false;
        function onMessage(event) {
            if (event.source !== window || event.data?.type !== 'SIGA_EXT_SYNC_RESULT') return;
            resuelto = true;
            window.removeEventListener('message', onMessage);
            resolve(event.data);
        }
        window.addEventListener('message', onMessage);
        window.postMessage({ type: 'SIGA_EXT_REQUEST_SYNC', periodo }, window.location.origin);
        setTimeout(() => {
            if (resuelto) return;
            window.removeEventListener('message', onMessage);
            resolve({ ok: false, motivo: 'timeout', detalle: 'La sincronización está tardando demasiado. Intenta de nuevo.' });
        }, timeoutMs);
    });
}

function mensajeError(resultado) {
    const motivos = {
        sin_pestana_intralu: 'Abre INTRALU en otra pestaña, inicia sesión, y vuelve a intentar.',
        lista_cursos_fallo: resultado.detalle || 'No se pudo cargar la lista de cursos desde INTRALU.',
        sin_cursos: resultado.detalle || 'No se encontró ningún curso matriculado en INTRALU.',
        timeout: resultado.detalle,
        cancelado: 'Sincronización cancelada.',
        sin_periodo: 'Elige un periodo para sincronizar.',
    };
    return motivos[resultado.motivo]
        || resultado.detalle
        || 'No pudimos conectar con INTRALU. Probablemente está caído o en mantenimiento ahora mismo. No es un error de SIGA.';
}

function mostrarEstadoExtension(html) {
    const el = document.getElementById('sync-intralu-estado-extension');
    el.style.display = 'block';
    el.style.background = '#FBE1E1';
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

function numeroOMulo(valor) {
    if (valor === null || valor === undefined || valor === '') return null;
    const n = parseFloat(valor);
    return Number.isNaN(n) ? null : n;
}

/* Guarda el resultado completo de la extensión en las 2 tablas nuevas:
   formulas_curso (compartida por sección, no por alumno) y notas_curso
   (con las evaluaciones crudas en jsonb, sin mapear a N1/EP/etc. —
   eso lo hace formula-mapper.js al vuelo, cuando se necesita calcular
   algo, nunca al guardar). */
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

function pedirCancelarExtensionSiga() {
    window.postMessage({ type: 'SIGA_EXT_REQUEST_CANCELAR_SYNC' }, window.location.origin);
}

function cancelarSyncEnCurso() {
    syncCancelada = true;
    pedirCancelarExtensionSiga();
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
    ocultarEstadoExtension();
    document.getElementById('resumenFinal').classList.remove('visible');
    syncCancelada = false;

    const btnSync = document.getElementById('btnSync');
    const btnCancelar = document.getElementById('btnCancelarSync');
    btnSync.disabled = true;

    // Paso 1: ¿está instalado el conector?
    btnSync.textContent = 'Verificando conector...';
    const hayExtension = await pingExtensionSiga();
    if (!hayExtension) {
        mostrarEstadoExtension(
            `⚠️ No detectamos el conector de SIGA en tu navegador.
             <br><a href="${EXTENSION_SIGA_URL}" target="_blank" style="color:var(--brand-morado); font-weight:600;">Agrégalo aquí</a> y vuelve a presionar Sincronizar.`
        );
        btnSync.disabled = false;
        btnSync.textContent = 'Sincronizar';
        return;
    }

    // Paso 2: ¿qué periodo se va a sincronizar?
    const periodoElegido = document.getElementById('syncPeriodoValor').value;
    if (!periodoElegido) {
        mostrarBanner('error', 'Elige un periodo para sincronizar.');
        btnSync.disabled = false;
        btnSync.textContent = 'Sincronizar';
        return;
    }

    // Paso 3: sincronizar — ahora sí hay algo real que cancelar.
    btnSync.textContent = 'Sincronizando...';
    btnCancelar.style.display = 'block';
    mostrarProgreso(`Sincronizando tus cursos de ${periodoElegido.slice(0, 4)}-${periodoElegido.slice(4)}... esto puede tardar unos segundos.`);
    const resultado = await pedirSyncExtensionSiga(periodoElegido);
    ocultarProgreso();
    btnCancelar.style.display = 'none';

    if (syncCancelada) return; // ya canceló y reseteó la UI, ignoramos esta respuesta tardía

    if (!resultado.ok) {
        mostrarBanner('error', mensajeError(resultado));
        btnSync.disabled = false;
        btnSync.textContent = 'Sincronizar';
        return;
    }

    // Paso 3: guardar en Supabase.
    try {
        mostrarProgreso('Guardando...');
        await guardarResultadoSync(userId, resultado);
        ocultarProgreso();

        let texto = `${resultado.cursos.length} curso(s) sincronizado(s) en ${resultado.periodo}.`;
        if (resultado.errores.length) {
            texto += ` (${resultado.errores.length} curso(s) no se pudieron traer, intenta de nuevo más tarde.)`;
        }
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