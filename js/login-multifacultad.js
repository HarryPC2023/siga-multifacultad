// js/login-multifacultad.js — Pantalla de sync de siga-multifacultad.
// Flujo con BOOKMARKLET (reemplaza a la extensión SIGA Conector para
// este sandbox): SIGA abre INTRALU en una pestaña nueva guardando su
// referencia; el alumno ejecuta ahí el bookmarklet "Sincronizar SIGA"
// (bookmarklet-sync.js, cargado dinámicamente); esa pestaña hace los
// fetch() reales a INTRALU y reporta el resultado de vuelta a esta
// pestaña vía postMessage a window.opener. SIGA guarda con su propia
// sesión de Supabase — la pestaña de INTRALU nunca ve esas credenciales.
import { supabase, obtenerSesion } from './auth-siga.js';
import { FACULTADES } from './facultades-datos.js';
import { parsearAvanceCurricular } from './avance-curricular-parser.js';
import { guardarAvanceCurricular } from './avance-curricular-guardar.js';
import * as pdfjsLib from '../vendor-pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc =
    new URL('../vendor-pdfjs/pdf.worker.min.mjs', import.meta.url).href;

const CLAVE_SESSION = 'siga_multifacultad_seleccion';

// Dominio real de INTRALU, y el archivo que el bookmarklet inyecta ahí.
// El "?t=" al final evita que el navegador sirva una versión vieja del
// script cacheada — cada ejecución del bookmarklet pide la más reciente.
const BASE_INTRALU = 'https://alumnos.uni.edu.pe';
const URL_BOOKMARKLET_SYNC_JS = 'https://harrypc2023.github.io/siga-multifacultad/js/bookmarklet-sync.js';

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
    prepararEnlaceBookmarklet();

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
   BLOQUE — Enlace del bookmarklet (reemplaza al link de instalar
   la extensión). El href se arma en JS, no en el HTML, porque
   incluye una marca de tiempo para evitar caché del script.
   ============================================================ */
function prepararEnlaceBookmarklet() {
    const enlace = document.getElementById('bookmarkletLink');
    if (!enlace) return;
    enlace.href = urlBookmarklet();
    // Evita que un clic normal (en vez de arrastrar) navegue la propia
    // pestaña de SIGA con el script — el bookmarklet solo tiene sentido
    // ejecutado dentro de INTRALU.
    enlace.addEventListener('click', (e) => {
        e.preventDefault();
        mostrarBanner('advertencia', 'Arrastra este botón a tu barra de marcadores — no hace falta hacerle clic aquí.');
    });
}

function urlBookmarklet() {
    const codigo = `(function(){var s=document.createElement('script');s.src='${URL_BOOKMARKLET_SYNC_JS}?t='+Date.now();document.body.appendChild(s);})();`;
    return `javascript:${encodeURIComponent(codigo)}`;
}

/* ============================================================
   BLOQUE — Sync con Intralú (vía bookmarklet)
   ============================================================ */
let syncCancelada = false;
let pestanaIntralu = null;
let listenerActivo = null;

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

/* Abre INTRALU en una pestaña nueva (guardando la referencia) y espera
   el resultado del bookmarklet en dos tiempos:
     1) SIGA_BM_LISTO — el bookmarklet ya cargó, pide el periodo.
     2) SIGA_BM_RESULTADO — trajo notas (+ opcionalmente el Avance
        Curricular) y los manda de vuelta.
   Se valida siempre que el mensaje venga del origen real de INTRALU. */
function abrirIntraluYEsperarBookmarklet(periodo, timeoutMs = 240000) {
    return new Promise((resolve) => {
        pestanaIntralu = window.open(BASE_INTRALU, 'siga_bookmarklet_sync');
        if (!pestanaIntralu) {
            resolve({ ok: false, motivo: 'popup_bloqueado', detalle: 'El navegador bloqueó la ventana de INTRALU. Permite ventanas emergentes para este sitio e intenta de nuevo.' });
            return;
        }

        let resuelto = false;
        const idTimeout = setTimeout(() => {
            if (resuelto) return;
            resuelto = true;
            window.removeEventListener('message', onMessage);
            listenerActivo = null;
            resolve({ ok: false, motivo: 'timeout', detalle: 'No llegó ninguna respuesta desde INTRALU. Verifica que ejecutaste el bookmarklet "Sincronizar SIGA" estando en esa pestaña.' });
        }, timeoutMs);

        function onMessage(event) {
            if (event.origin !== BASE_INTRALU) return;
            if (!event.data || typeof event.data !== 'object') return;

            if (event.data.type === 'SIGA_BM_LISTO') {
                event.source.postMessage({ type: 'SIGA_BM_PERIODO', periodo }, BASE_INTRALU);
                return;
            }

            if (event.data.type === 'SIGA_BM_RESULTADO') {
                if (resuelto) return;
                resuelto = true;
                clearTimeout(idTimeout);
                window.removeEventListener('message', onMessage);
                listenerActivo = null;
                resolve({ ok: true, ...event.data });
            }
        }

        listenerActivo = onMessage;
        window.addEventListener('message', onMessage);
    });
}

function mensajeError(resultado) {
    const motivos = {
        popup_bloqueado: resultado.detalle,
        timeout: resultado.detalle,
        sin_cursos: resultado.detalle || 'No se encontró ningún curso matriculado en INTRALU.',
        periodo_no_coincide: resultado.detalle,
        cancelado: 'Sincronización cancelada.',
        sin_periodo: 'Elige un periodo para sincronizar.',
        error_inesperado: resultado.detalle,
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
    if (listenerActivo) {
        window.removeEventListener('message', listenerActivo);
        listenerActivo = null;
    }
    if (pestanaIntralu && !pestanaIntralu.closed) {
        pestanaIntralu.close();
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

    // Paso 1: ¿qué periodo se va a sincronizar?
    const periodoElegido = document.getElementById('syncPeriodoValor').value;
    if (!periodoElegido) {
        mostrarBanner('error', 'Elige un periodo para sincronizar.');
        return;
    }

    // Paso 2: abrir INTRALU y esperar al bookmarklet.
    btnSync.disabled = true;
    btnSync.textContent = 'Abriendo INTRALU...';
    btnCancelar.style.display = 'block';
    mostrarProgreso('Se abrió una pestaña de INTRALU. Haz clic en tu marcador "Sincronizar SIGA" estando ahí.');

    const resultado = await abrirIntraluYEsperarBookmarklet(periodoElegido);
    ocultarProgreso();
    btnCancelar.style.display = 'none';

    if (syncCancelada) return; // ya canceló y reseteó la UI, ignoramos esta respuesta tardía

    if (!resultado.ok) {
        mostrarBanner('error', mensajeError(resultado));
        btnSync.disabled = false;
        btnSync.textContent = 'Sincronizar';
        return;
    }

    const resultadoNotas = resultado.notas;
    if (!resultadoNotas || !resultadoNotas.ok) {
        mostrarBanner('error', mensajeError(resultadoNotas || { motivo: 'error_inesperado' }));
        btnSync.disabled = false;
        btnSync.textContent = 'Sincronizar';
        return;
    }

    // Paso 3: guardar notas + fórmulas, y el Avance Curricular si vino.
    try {
        mostrarProgreso('Guardando tus notas...');
        await guardarResultadoSync(userId, resultadoNotas);

        let textoAvance = '';
        if (resultado.avanceCurricularBase64) {
            mostrarProgreso('Guardando tu Avance Curricular...');
            try {
                const resultadoAvance = await guardarAvanceCurricularDesdeBase64(userId, resultado.avanceCurricularBase64);
                textoAvance = resultadoAvance.ok
                    ? ` Tu carrera (${resultadoAvance.facultad} / ${resultadoAvance.carrera}) quedó detectada automáticamente.`
                    : ` (No se pudo procesar tu Avance Curricular: ${resultadoAvance.detalle || resultadoAvance.motivo}.)`;
            } catch (errAvance) {
                textoAvance = ' (No se pudo procesar tu Avance Curricular, intenta sincronizar de nuevo más tarde.)';
                console.error('Error procesando Avance Curricular:', errAvance);
            }
        } else if (resultado.avanceCurricularError) {
            textoAvance = ' (No se pudo descargar tu Avance Curricular esta vez.)';
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