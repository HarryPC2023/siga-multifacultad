// js/notas.js — Visor de notas del sandbox multifacultad. Lee directo de
// notas_curso (por alumno, evaluaciones crudas en jsonb) y formulas_curso
// (compartida por curso/sección/periodo, incluye créditos). Las evaluaciones
// crudas se traducen a variables de fórmula (N1, EP, EF...) al vuelo con
// formula-mapper.js — nunca se guarda un catálogo por curso.
//
// Editar los campos en pantalla es solo simulación (no reescribe Supabase):
// sirve para calcular "qué necesito sacar". Mientras no se edita nada, la
// Nota Final que se muestra es la oficial de INTRALU (promedio_final,
// guardada tal cual la trae la sync) — en cuanto el alumno toca un campo,
// se pasa a mostrar el cálculo en vivo con el motor de fórmulas, porque ya
// deja de tener sentido mostrar la oficial sobre una hipótesis.
import { supabase, obtenerSesion } from './auth-siga.js';
import { evaluarFormula, aplicarSustitutorio, truncarNota } from './formula-engine.js';
import { calcularNecesito, BANDA_APROBADO } from './escenarios.js';
import { construirValoresFormula, notaComoNumero, clasificarExamen } from './formula-mapper.js';
import { FACULTADES } from './facultades-datos.js';

const UMBRAL_APROBACION = 10;

let notasPorPeriodo = {};   // { "2023-2": [ {codigo_curso, seccion, nombre_curso, promedio_practicas, promedio_final, nota_asistencia, evaluaciones}, ... ] }
let formulasPorCurso = {};  // clave `${codigo_curso}|${seccion}|${periodo}` -> {formula_practicas, formula_nota_final, creditos}
let periodoActivo = null;
let valoresSimulados = {};  // clave `${codigo_curso}|${seccion}` -> { N1: 14, EP: 12, ... } (solo del periodo activo)
let usuarioActual = null;

document.addEventListener('DOMContentLoaded', async () => {
    const sesion = await obtenerSesion();
    if (!sesion) { window.location.href = 'index.html'; return; }
    usuarioActual = sesion.user;

    await pintarIdentidad(sesion);
    inicializarAnalisisAcademico();

    await cargarDatos(usuarioActual.id);
    inicializarSelectorPeriodo();
    inicializarModalEliminarPeriodo();

    const periodos = Object.keys(notasPorPeriodo).sort().reverse();
    if (!periodos.length) {
        document.getElementById('estadoVacio').style.display = 'block';
        return;
    }
    seleccionarPeriodo(periodos[0]);
});

/* ============================================================
   PANEL DE IDENTIDAD — nombre/foto vienen de la sesión (Google, si
   algún día este sandbox deja de ser anónimo); código/facultad/
   carrera/periodo vienen de perfiles_usuario, nunca elegidos a mano
   (facultad/carrera los guarda login-multifacultad.js apenas se
   autodetectan del Avance Curricular).
   ============================================================ */
async function pintarIdentidad(sesion) {
    const meta = sesion.user?.user_metadata || {};
    const { data: perfil } = await supabase
        .from('perfiles_usuario')
        .select('codigo_estudiante, facultad, carrera, periodo_actual')
        .eq('user_id', sesion.user.id)
        .maybeSingle();

    // Sesión anónima (como es hoy este sandbox): sin nombre/foto de
    // Google todavía — se usa el código de estudiante como identidad
    // visible mientras tanto, nunca un nombre inventado.
    const nombre = meta.full_name || meta.name || perfil?.codigo_estudiante || 'Alumno';
    const foto = meta.avatar_url || meta.picture || null;

    const avatar = document.getElementById('identidadAvatar');
    if (foto) {
        avatar.innerHTML = `<img src="${foto}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
    } else {
        avatar.textContent = nombre.trim().charAt(0).toUpperCase();
    }
    document.getElementById('identidadNombre').textContent = nombre;
    document.getElementById('identidadCodigo').textContent = perfil?.codigo_estudiante || '';

    const facultad = FACULTADES.find((f) => f.sigla === perfil?.facultad);
    if (facultad) {
        const chip = document.getElementById('chipFacultad');
        chip.style.display = 'flex';
        chip.style.borderLeftColor = facultad.color;
        document.getElementById('chipFacultadIcono').src = facultad.icono;
        document.getElementById('chipFacultadIcono').alt = `Ícono de ${facultad.sigla}`;
        document.getElementById('chipFacultadNombre').textContent = `${facultad.sigla} · ${perfil.carrera}`;
        document.getElementById('chipFacultadPeriodo').textContent = perfil.periodo_actual
            ? `Periodo ${periodoConGuion(perfil.periodo_actual)}`
            : '';
    }
}

/* ============================================================
   ANÁLISIS ACADÉMICO — 🚧 EN CAMINO en este sandbox.
   El motor real de estas 3 herramientas (Meta del curso, Progreso de
   tu carrera, Ruta del Curso) vive hoy solo en producción SIGA
   (intranotas.js + progreso-malla.js: calcularPFCompleto(), el grafo
   de prerrequisitos, etc.) — portarlo es trabajo aparte, todavía no
   hecho acá. Mientras tanto, cada chip abre un aviso honesto en vez
   de fingir un cálculo que no existe.
   ============================================================ */
const AA_INFO = {
    meta: {
        icono: '🎯',
        titulo: 'Meta del curso',
        desc: 'Calcula qué nota necesitas en lo que falta de un curso para alcanzar tu meta. Ya funciona en producción SIGA — se está portando a este sandbox.',
    },
    progreso: {
        icono: '🗺️',
        titulo: 'Progreso de tu carrera',
        desc: 'El mapa completo de tu malla por ciclos, con qué ya aprobaste y qué se te abre después. Ya funciona en producción SIGA — se está portando a este sandbox.',
    },
    ruta: {
        icono: '🔗',
        titulo: 'Ruta del Curso',
        desc: 'Qué necesitas para llevar un curso y qué se te desbloquea al aprobarlo. Ya funciona en producción SIGA — se está portando a este sandbox.',
    },
};

function inicializarAnalisisAcademico() {
    document.querySelectorAll('.chip-herramienta').forEach((chip) => {
        chip.addEventListener('click', () => abrirAvisoAnalisisAcademico(chip.dataset.aa));
    });
    document.getElementById('aaCerrar').addEventListener('click', cerrarAvisoAnalisisAcademico);
    document.getElementById('aaOverlay').addEventListener('click', (e) => {
        if (e.target.id === 'aaOverlay') cerrarAvisoAnalisisAcademico();
    });
}

function abrirAvisoAnalisisAcademico(id) {
    const info = AA_INFO[id];
    if (!info) return;
    document.getElementById('aaIcono').textContent = info.icono;
    document.getElementById('aaTitulo').textContent = info.titulo;
    document.getElementById('aaDesc').textContent = info.desc;
    document.getElementById('aaOverlay').classList.add('visible');
}

function cerrarAvisoAnalisisAcademico() {
    document.getElementById('aaOverlay').classList.remove('visible');
}

async function cargarDatos(userId) {
    const { data: notas } = await supabase
        .from('notas_curso')
        .select('codigo_curso, seccion, periodo, nombre_curso, promedio_practicas, promedio_final, nota_asistencia, evaluaciones')
        .eq('user_id', userId);

    notasPorPeriodo = {};
    (notas || []).forEach((fila) => {
        const etiqueta = periodoConGuion(fila.periodo);
        if (!notasPorPeriodo[etiqueta]) notasPorPeriodo[etiqueta] = [];
        notasPorPeriodo[etiqueta].push(fila);
    });

    const periodosNormalizados = [...new Set((notas || []).map((f) => f.periodo))];
    if (periodosNormalizados.length) {
        const { data: formulas } = await supabase
            .from('formulas_curso')
            .select('codigo_curso, seccion, periodo, formula_practicas, formula_nota_final, creditos')
            .in('periodo', periodosNormalizados);

        (formulas || []).forEach((f) => {
            formulasPorCurso[`${f.codigo_curso}|${f.seccion || ''}|${f.periodo}`] = f;
        });
    }
}

// "20232" -> "2023-2" (mismo criterio que usa el resto de SIGA)
function periodoConGuion(periodoRaw) {
    const p = String(periodoRaw);
    return p.length === 5 ? `${p.slice(0, 4)}-${p.slice(4)}` : p;
}

function inicializarSelectorPeriodo() {
    const periodos = Object.keys(notasPorPeriodo).sort().reverse();
    inicializarSelectPersonalizado({
        triggerId: 'selectorPeriodoTrigger', textoId: 'selectorPeriodoTexto',
        listaId: 'selectorPeriodoLista', valorId: 'selectorPeriodoValor',
        opciones: periodos.map((p) => ({ value: p, label: p })),
        alElegir: (valor) => seleccionarPeriodo(valor),
    });
}

function seleccionarPeriodo(periodo) {
    periodoActivo = periodo;
    valoresSimulados = {};
    document.getElementById('selectorPeriodoTexto').textContent = periodo;
    document.getElementById('selectorPeriodoValor').value = periodo;
    renderizarCursos();
}

/* ============================================================
   ELIMINAR EL PERIODO ACTIVO
   Borra solo lo de notas_curso para este alumno + este periodo.
   formulas_curso NO se toca — es compartida con otros alumnos que
   cursaron el mismo curso/sección, no le pertenece a este alumno.
   ============================================================ */
function inicializarModalEliminarPeriodo() {
    document.getElementById('btnEliminarPeriodo').addEventListener('click', abrirModalEliminarPeriodo);
    document.getElementById('btnCancelarEliminarPeriodo').addEventListener('click', cerrarModalEliminarPeriodo);
    document.getElementById('btnConfirmarEliminarPeriodo').addEventListener('click', confirmarEliminarPeriodo);
}

function abrirModalEliminarPeriodo() {
    if (!periodoActivo) return;
    document.getElementById('modalEliminarPeriodoTexto').textContent =
        `Se eliminará por completo el periodo ${periodoActivo}, con todos sus cursos y notas. No se puede deshacer.`;
    document.getElementById('modalEliminarPeriodo').classList.add('visible');
}

function cerrarModalEliminarPeriodo() {
    document.getElementById('modalEliminarPeriodo').classList.remove('visible');
}

async function confirmarEliminarPeriodo() {
    cerrarModalEliminarPeriodo();
    if (!periodoActivo || !usuarioActual) return;

    const periodoEliminado = periodoActivo;
    const periodoNormalizado = periodoEliminado.replace('-', '');

    const { error } = await supabase
        .from('notas_curso')
        .delete()
        .eq('user_id', usuarioActual.id)
        .eq('periodo', periodoNormalizado);

    if (error) {
        document.getElementById('modalEliminarPeriodoTexto').textContent =
            'No se pudo eliminar el periodo. Intenta de nuevo.';
        console.error('Error eliminando periodo:', error);
        return;
    }

    delete notasPorPeriodo[periodoEliminado];
    delete formulasPorCurso[periodoEliminado]; // no aplica (clave distinta), no-op seguro

    inicializarSelectorPeriodo();
    const periodosRestantes = Object.keys(notasPorPeriodo).sort().reverse();

    if (periodosRestantes.length) {
        seleccionarPeriodo(periodosRestantes[0]);
    } else {
        periodoActivo = null;
        document.getElementById('listaCursos').innerHTML = '';
        document.getElementById('promedioPonderado').textContent = '--';
        document.getElementById('bannerRiesgo').classList.remove('visible');
        document.getElementById('selectorPeriodoTexto').textContent = 'Elige un periodo';
        document.getElementById('estadoVacio').style.display = 'block';
    }
}

function claveSimulacion(curso) {
    return `${curso.codigo_curso}|${curso.seccion || ''}`;
}

function formulaDeCurso(curso) {
    const periodoNormalizado = periodoActivo.replace('-', '');
    return formulasPorCurso[`${curso.codigo_curso}|${curso.seccion || ''}|${periodoNormalizado}`] || null;
}

function haySimulacionActiva(curso) {
    const simulado = valoresSimulados[claveSimulacion(curso)];
    return !!simulado && Object.keys(simulado).length > 0;
}

/* Arma { N1: 14, N2: 12, EP: 10, EF: null, ... } para un curso, tomando
   primero lo simulado en pantalla y si no, lo sincronizado de Intralú
   (traducido desde las evaluaciones crudas por formula-mapper.js). */
function valoresActualesDeCurso(curso) {
    const clave = claveSimulacion(curso);
    const simulado = valoresSimulados[clave] || {};
    const base = construirValoresFormula(curso.evaluaciones);
    return { ...base, ...simulado };
}

function calcularCurso(curso) {
    const formula = formulaDeCurso(curso);
    const valores = valoresActualesDeCurso(curso);
    if (!formula) return { pp: null, notaFinal: null, formula: null, valores };

    let pp = null;
    try {
        pp = formula.formula_practicas ? evaluarFormula(formula.formula_practicas, valores) : null;
    } catch { pp = null; }

    let notaFinal = null;
    try {
        if (formula.formula_nota_final) {
            const conSustituto = aplicarSustitutorio({ ...valores, PP: pp });
            const notaFinalCruda = evaluarFormula(formula.formula_nota_final, conSustituto);
            notaFinal = truncarNota(notaFinalCruda);
        }
    } catch { notaFinal = null; }

    return { pp, notaFinal, formula, valores };
}

/* La Nota Final que se muestra: mientras no hay simulación, la oficial de
   INTRALU (promedio_final, tal cual la trajo la sync); en cuanto el alumno
   edita algo, pasa a ser el cálculo en vivo con el motor de fórmulas. */
function notaFinalMostrada(curso, notaFinalCalculada) {
    if (haySimulacionActiva(curso)) return notaFinalCalculada;
    return curso.promedio_final ?? notaFinalCalculada;
}

/* Un periodo pasado NUNCA debería quedar con notas a medias — si eso
   pasa, es señal de un problema de sync, no de que "todavía no suben
   notas". Solo el periodo actual puede estar legítimamente incompleto.
   Reglas de cierre real de UNI: el periodo 1 (marzo-julio) cierra fin de
   julio; el periodo 2 (agosto-diciembre) cierra fin de diciembre. */
function periodoEstaAbierto(periodoConGuion) {
    const [anioStr, tipoStr] = periodoConGuion.split('-');
    const anio = parseInt(anioStr, 10);
    const tipo = parseInt(tipoStr, 10);
    const hoy = new Date();
    const anioActual = hoy.getFullYear();
    const mesActual = hoy.getMonth() + 1; // 1-12

    if (anio > anioActual) return true; // no debería pasar, pero no lo tratamos como "vencido"
    if (anio < anioActual) return false;

    if (tipo === 1) return mesActual <= 7;   // marzo-julio
    if (tipo === 2) return mesActual >= 8;   // agosto-diciembre
    return true; // verano (tipo 3): caso borde, no lo bloqueamos por ahora
}

function estadoCurso(notaFinal, periodoConGuion) {
    if (notaFinal === null) {
        return periodoEstaAbierto(periodoConGuion)
            ? { texto: 'Pendiente', clase: 'badge-pendiente' }
            : { texto: 'Sin datos', clase: 'badge-critico' };
    }

    // Ciclo ya cerrado: la respuesta es definitiva, no hay "en riesgo"
    // ni "crítico" — o pasó o no pasó.
    if (!periodoEstaAbierto(periodoConGuion)) {
        return notaFinal >= UMBRAL_APROBACION
            ? { texto: 'Aprobado', clase: 'badge-aprobado' }
            : { texto: 'Desaprobado', clase: 'badge-critico' };
    }
    if (notaFinal >= UMBRAL_APROBACION) return { texto: 'Aprobado', clase: 'badge-aprobado' };
    if (notaFinal >= 7) return { texto: 'En riesgo', clase: 'badge-riesgo' };
    return { texto: 'Crítico', clase: 'badge-critico' };
}

function renderizarCursos() {
    const cursos = notasPorPeriodo[periodoActivo] || [];
    const contenedor = document.getElementById('listaCursos');
    contenedor.innerHTML = '';

    let sumaPonderada = 0, sumaCreditos = 0;
    const enRiesgo = [];

    cursos.forEach((curso, idx) => {
        const { notaFinal: notaFinalCalculada } = calcularCurso(curso);
        const notaFinal = notaFinalMostrada(curso, notaFinalCalculada);
        const estado = estadoCurso(notaFinal, periodoActivo);
        const creditos = formulaDeCurso(curso)?.creditos ?? null;

        if (notaFinal !== null && creditos) {
            sumaPonderada += notaFinal * creditos;
            sumaCreditos += creditos;
        }
        if (notaFinal !== null && (estado.clase === 'badge-riesgo' || estado.clase === 'badge-critico')) {
            enRiesgo.push(`${curso.nombre_curso || curso.codigo_curso} — ${notaFinal}`);
        }

        const card = document.createElement('div');
        card.className = 'curso-card';
        card.innerHTML = `
            <div class="curso-card__promedio">
                <p class="curso-card__promedio-etiqueta">PROMEDIO</p>
                <p class="curso-card__promedio-valor">${notaFinal ?? '--'}</p>
            </div>
            <div class="curso-card__cuerpo-principal">
                <p class="curso-card__nombre">${curso.nombre_curso || curso.codigo_curso}</p>
                <div class="curso-card__meta-fila">
                    <span class="curso-card__codigo">${curso.codigo_curso}</span>
                    ${creditos ? `<span class="badge badge-creditos">${creditos} créditos</span>` : ''}
                    <span class="badge ${estado.clase}">${estado.texto}</span>
                </div>
                <button type="button" class="btn-ingresar-notas" data-toggle="${idx}">Ingresar notas</button>
                <div class="curso-card__cuerpo" id="cuerpo-${idx}"></div>
            </div>
        `;
        card.querySelector('.btn-ingresar-notas').addEventListener('click', () => toggleCurso(idx, curso));
        contenedor.appendChild(card);
    });

    document.getElementById('promedioPonderado').textContent =
        sumaCreditos ? (sumaPonderada / sumaCreditos).toFixed(2) : '--';

    const banner = document.getElementById('bannerRiesgo');
    if (enRiesgo.length) {
        banner.classList.add('visible');
        document.querySelector('.banner-riesgo__titulo').textContent =
            periodoEstaAbierto(periodoActivo) ? '⚠ Cursos en riesgo' : '❌ Cursos desaprobados';
        document.getElementById('bannerRiesgoLista').innerHTML =
            enRiesgo.map((t) => `<p class="banner-riesgo__item">${t}</p>`).join('');
    } else {
        banner.classList.remove('visible');
    }
}

function toggleCurso(idx, curso) {
    const cuerpo = document.getElementById(`cuerpo-${idx}`);
    const yaAbierto = cuerpo.classList.contains('visible');
    if (yaAbierto) { cuerpo.classList.remove('visible'); return; }
    cuerpo.classList.add('visible');
    if (!cuerpo.dataset.armado) {
        armarCuerpoCurso(cuerpo, curso, idx);
        cuerpo.dataset.armado = '1';
    }
}

/* Clasifica una evaluación NO examen (es_examen === false) por lo que dice
   su descripción real de INTRALU — no por camnot, que solo numera para la
   fórmula y no distingue tipo. PENDIENTE DE VERIFICAR con un curso real
   que tenga labs o monografía (ver nota en formula-mapper.js). */
function claseEvaluacion(descripcion) {
    const d = (descripcion || '').toUpperCase();
    if (d.includes('LABORATORIO') || d.includes(' LAB')) return 'LAB';
    if (d.includes('MONOGRAF')) return 'MONOGRAFIA';
    return 'PC';
}

/* Etiqueta visible para una evaluación NO examen: PC1/PC2 para prácticas
   calificadas, LAB1/LAB2 para laboratorios (así las conocen los alumnos),
   y la descripción tal cual de INTRALU para monografías (sin renombrar). */
function etiquetaNoExamen(ev) {
    const clase = claseEvaluacion(ev.descripcion);
    if (clase === 'MONOGRAFIA') return (ev.descripcion || 'Monografía').trim();
    if (clase === 'LAB') return `LAB${ev.camnot ?? ''}`;
    return `PC${ev.camnot ?? ''}`;
}

const ETIQUETA_EXAMEN = { EP: 'Examen Parcial', EF: 'Examen Final', ES: 'Sustitutorio' };
const ORDEN_EXAMEN = { EP: 1, EF: 2, ES: 3 };

/* Traduce el arreglo crudo de evaluaciones a filas listas para pintar:
   { variable, label, nota }, en el mismo orden en que INTRALU las muestra
   (prácticas/labs por camnot, luego EP, EF, ES). Evaluaciones que
   formula-mapper.js no sabe clasificar (examen de tipo no reconocido) se
   omiten — no se inventa una variable para ellas. */
function componentesVisibles(evaluaciones) {
    const filas = [];
    for (const ev of evaluaciones || []) {
        // OJO: no se usa ev.es_examen — ver la nota en formula-mapper.js.
        // clasificarExamen(descripcion) es la única fuente confiable.
        const variableExamen = clasificarExamen(ev.descripcion);
        if (variableExamen) {
            filas.push({ variable: variableExamen, label: ETIQUETA_EXAMEN[variableExamen] || variableExamen, nota: notaComoNumero(ev.nota), camnot: null });
            continue;
        }
        if (ev.camnot === null || ev.camnot === undefined) continue;
        filas.push({ variable: `N${ev.camnot}`, label: etiquetaNoExamen(ev), nota: notaComoNumero(ev.nota), camnot: ev.camnot });
    }
    filas.sort((a, b) => {
        const oa = ORDEN_EXAMEN[a.variable] ?? 0, ob = ORDEN_EXAMEN[b.variable] ?? 0;
        if (oa !== ob) return oa - ob;
        return (a.camnot ?? 0) - (b.camnot ?? 0);
    });
    return filas;
}

function armarCuerpoCurso(cuerpo, curso, idx) {
    const filas = componentesVisibles(curso.evaluaciones);

    const grid = document.createElement('div');
    grid.className = 'grid-componentes';
    filas.forEach((fila) => {
        const campo = document.createElement('div');
        campo.className = 'componente';
        campo.innerHTML = `
            <label>${fila.label}</label>
            <input type="number" step="0.1" min="0" max="20" value="${fila.nota ?? ''}" placeholder="--">
        `;
        campo.querySelector('input').addEventListener('input', (e) => {
            const clave = claveSimulacion(curso);
            if (!valoresSimulados[clave]) valoresSimulados[clave] = {};
            const v = e.target.value === '' ? null : parseFloat(e.target.value);
            valoresSimulados[clave][fila.variable] = v;
            actualizarCuerpoCurso(cuerpo, curso, idx);
        });
        grid.appendChild(campo);
    });
    cuerpo.appendChild(grid);

    const promPC = document.createElement('p');
    promPC.className = 'prom-pc';
    cuerpo.appendChild(promPC);

    const cajaNecesito = document.createElement('div');
    cajaNecesito.className = 'caja-necesito';
    cuerpo.appendChild(cajaNecesito);

    actualizarCuerpoCurso(cuerpo, curso, idx);
}

function actualizarCuerpoCurso(cuerpo, curso, idx) {
    const { pp, notaFinal: notaFinalCalculada, formula, valores } = calcularCurso(curso);
    const notaFinal = notaFinalMostrada(curso, notaFinalCalculada);

    cuerpo.querySelector('.prom-pc').innerHTML = pp !== null
        ? `Prom. PC: <strong>${pp.toFixed(2)}</strong>`
        : '';

    // Actualiza también la cabecera de la card sin re-renderizar toda la lista
    const tarjeta = cuerpo.closest('.curso-card');
    const valorHeader = tarjeta?.querySelector('.curso-card__promedio-valor');
    if (valorHeader) valorHeader.textContent = notaFinal ?? '--';
    const badge = tarjeta?.querySelector('.curso-card__meta-fila .badge:last-child');
    if (badge) {
        const estado = estadoCurso(notaFinal, periodoActivo);
        badge.textContent = estado.texto;
        badge.className = `badge ${estado.clase}`;
    }

    const caja = cuerpo.querySelector('.caja-necesito');
    if (!formula || !formula.formula_nota_final) {
        caja.innerHTML = periodoEstaAbierto(periodoActivo)
            ? `<p class="aviso-sin-formula">INTRALU todavía no publica la fórmula de este curso. En cuanto la publique y vuelvas a sincronizar, aparece acá el cálculo de "qué nota necesito".</p>`
            : `<p class="aviso-sin-formula">Este periodo ya cerró pero no se guardó la fórmula de este curso. Vuelve a sincronizar este periodo — si sigue igual, avísale a Harry.</p>`;
        return;
    }

    const necesito = calcularNecesito({
        formulaPP: formula.formula_practicas,
        formulaFinal: formula.formula_nota_final,
        valores,
        umbral: UMBRAL_APROBACION,
    });
    const etiquetas = Object.fromEntries(componentesVisibles(curso.evaluaciones).map((f) => [f.variable, f.label]));
    caja.innerHTML = htmlCajaNecesito(necesito, etiquetas);
}

/* ---------- Caja "¿Qué nota necesito para aprobar?" ----------
   El cálculo vive en escenarios.js (módulo puro). Acá solo se pinta. */

function escaparHtml(texto) {
    return String(texto).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* El mínimo siempre se sube a 1 decimal, nunca se baja: mostrar 7.2
   cuando hacen falta 7.25 le haría creer al alumno que le alcanza. */
function formatearMinimo(valor) {
    return (Math.ceil(valor * 10 - 1e-9) / 10).toFixed(1);
}

function etiquetaCorta(variable, etiquetas) {
    return ['EP', 'EF', 'ES'].includes(variable) ? variable : escaparHtml(etiquetas[variable] || variable);
}

function textoResultado(r, incognita) {
    if (r.estado === 'ok') return `${incognita} mínimo = ${formatearMinimo(r.minimo)}`;
    if (r.estado === 'seguro') return 'ya aprobarías';
    if (r.estado === 'imposible') return `no alcanza (máx. ${r.maximoPosible})`;
    return 'faltan datos';
}

function htmlCajaNecesito(r, etiquetas) {
    const titulo = '<p class="caja-necesito__titulo">🎯 ¿Qué nota necesito para aprobar?</p>';
    const valor = (x) => `<span class="caja-necesito__valor">${x}</span>`;
    let cuerpo = '';

    switch (r.tipo) {
        case 'hipotesis':
            cuerpo = r.filas.map((f) => `
                <div class="caja-necesito__fila">
                    <span>Si sacas ${f.dado.variable} = ${String(f.dado.valor).padStart(2, '0')}:</span>
                    <span class="caja-necesito__chip">${textoResultado(f, r.incognita)}</span>
                </div>`).join('');
            break;

        case 'unico':
            if (r.estado === 'ok') cuerpo = `Necesitas al menos ${valor(formatearMinimo(r.minimo))} en ${r.incognita} para aprobar.`;
            else if (r.estado === 'seguro') cuerpo = `Con lo que tienes ya apruebas, incluso sacando 0 en ${r.incognita}.`;
            else if (r.estado === 'imposible') cuerpo = `Ya no alcanza — con 20 en ${r.incognita} el máximo posible es ${valor(r.maximoPosible)}.`;
            else cuerpo = '<p class="aviso-sin-formula">Aún faltan otros datos para calcularlo.</p>';
            break;

        case 'sustitutorio':
            cuerpo = `Con estos valores tu Nota Final es ${valor(r.notaFinal)}, no llega a ${UMBRAL_APROBACION}.<br>`;
            if (r.estado === 'ok') cuerpo += `Si rindes el sustitutorio, necesitas al menos ${valor(formatearMinimo(r.minimo))} en ES.`;
            else if (r.estado === 'imposible') cuerpo += `Ni con 20 en ES alcanzaría: el máximo posible sería ${valor(r.maximoPosible)}.`;
            break;

        case 'completo':
            cuerpo = r.aprueba
                ? `Con estos valores tu Nota Final es ${valor(r.notaFinal)}.`
                : `Con estos valores tu Nota Final es ${valor(r.notaFinal)}, no llega a ${UMBRAL_APROBACION}.`;
            break;

        case 'faltan-datos':
        case 'error':
            cuerpo = '<p class="aviso-sin-formula">Aún faltan otros datos para calcularlo.</p>';
            break;

        default:
            return '';
    }

    const supuestos = r.supuestos && r.supuestos.length
        ? `<p class="caja-necesito__supuesto">Asumiendo en ${BANDA_APROBADO} tus notas pendientes: ${r.supuestos.map((v) => etiquetaCorta(v, etiquetas)).join(', ')}.</p>`
        : '';

    return titulo + cuerpo + supuestos;
}