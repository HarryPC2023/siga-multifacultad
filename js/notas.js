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
import { evaluarFormula, calcularNotaMinimaNecesaria, aplicarSustitutorio, truncarNota } from './formula-engine.js';
import { construirValoresFormula, notaComoNumero, clasificarExamen } from './formula-mapper.js';

const UMBRAL_APROBACION = 10;

let notasPorPeriodo = {};   // { "2023-2": [ {codigo_curso, seccion, nombre_curso, promedio_practicas, promedio_final, nota_asistencia, evaluaciones}, ... ] }
let formulasPorCurso = {};  // clave `${codigo_curso}|${seccion}|${periodo}` -> {formula_practicas, formula_nota_final, creditos}
let periodoActivo = null;
let valoresSimulados = {};  // clave `${codigo_curso}|${seccion}` -> { N1: 14, EP: 12, ... } (solo del periodo activo)

document.addEventListener('DOMContentLoaded', async () => {
    const sesion = await obtenerSesion();
    if (!sesion) { window.location.href = 'index.html'; return; }

    await cargarDatos(sesion.user.id);
    inicializarSelectorPeriodo();

    const periodos = Object.keys(notasPorPeriodo).sort().reverse();
    if (!periodos.length) {
        document.getElementById('estadoVacio').style.display = 'block';
        return;
    }
    seleccionarPeriodo(periodos[0]);
});

async function cargarDatos(userId) {
    const { data: notas } = await supabase
        .from('notas_curso')
        .select('codigo_curso, seccion, periodo, nombre_curso, promedio_practicas, promedio_final, nota_asistencia, evaluaciones')
        .eq('user_id', userId);

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
            <div class="curso-card__cabecera" data-toggle="${idx}">
                <div>
                    <p class="curso-card__nombre">${curso.nombre_curso || curso.codigo_curso}<span class="badge ${estado.clase}">${estado.texto}</span></p>
                    <p class="curso-card__meta">${curso.codigo_curso}${creditos ? ` · ${creditos} cr` : ''}</p>
                </div>
                <div class="curso-card__promedio">
                    <p class="curso-card__promedio-etiqueta">Nota Final</p>
                    <p class="curso-card__promedio-valor">${notaFinal ?? '--'}</p>
                </div>
            </div>
            <div class="curso-card__cuerpo" id="cuerpo-${idx}"></div>
        `;
        card.querySelector('.curso-card__cabecera').addEventListener('click', () => toggleCurso(idx, curso));
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
        if (!ev.es_examen) {
            if (ev.camnot === null || ev.camnot === undefined) continue;
            filas.push({ variable: `N${ev.camnot}`, label: etiquetaNoExamen(ev), nota: notaComoNumero(ev.nota), camnot: ev.camnot });
        } else {
            const variable = clasificarExamen(ev.descripcion);
            if (!variable) continue;
            filas.push({ variable, label: ETIQUETA_EXAMEN[variable] || variable, nota: notaComoNumero(ev.nota), camnot: null });
        }
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

    const formulaVisible = document.createElement('p');
    formulaVisible.className = 'formula-visible';
    cuerpo.appendChild(formulaVisible);

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

    cuerpo.querySelector('.formula-visible').textContent = formula
        ? `Fórmula: ${formula.formula_nota_final || '—'}${formula.formula_practicas ? ` (PP: ${formula.formula_practicas})` : ''}`
        : '';

    // Actualiza también la cabecera de la card sin re-renderizar toda la lista
    const valorHeader = cuerpo.parentElement.querySelector('.curso-card__promedio-valor');
    if (valorHeader) valorHeader.textContent = notaFinal ?? '--';
    const badge = cuerpo.parentElement.querySelector('.badge');
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

    // La incógnita es el primer campo EF/ES que esté vacío en la simulación actual.
    const incognita = ['EF', 'ES'].find((k) => k in valores && (valores[k] === null || valores[k] === undefined));
    if (!incognita) {
        caja.innerHTML = notaFinalCalculada !== null
            ? `<p class="caja-necesito__titulo">🎯 Con estos valores</p>Nota Final: <span class="caja-necesito__valor">${notaFinalCalculada}</span>`
            : '';
        return;
    }

    const resultado = calcularNotaMinimaNecesaria({
        formulaPP: formula.formula_practicas,
        formulaFinal: formula.formula_nota_final,
        valoresBase: valores,
        variableIncognita: incognita,
        umbral: UMBRAL_APROBACION,
    });

    if (resultado.posible === null) {
        caja.innerHTML = `<p class="caja-necesito__titulo">🎯 ¿Qué nota necesito?</p><p class="aviso-sin-formula">Aún faltan otros datos para calcularlo.</p>`;
    } else if (resultado.posible === false) {
        caja.innerHTML = `<p class="caja-necesito__titulo">🎯 ¿Qué nota necesito?</p>Ya no alcanza — con 20 en ${incognita} el máximo posible es <span class="caja-necesito__valor">${resultado.notaMaximaPosible}</span>.`;
    } else {
        caja.innerHTML = `<p class="caja-necesito__titulo">🎯 ¿Qué nota necesito?</p>Necesitas al menos <span class="caja-necesito__valor">${resultado.notaMinima}</span> en ${incognita} para aprobar.`;
    }
}