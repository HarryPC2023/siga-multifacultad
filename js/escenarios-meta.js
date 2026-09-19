// escenarios-meta.js — Motor de "Meta del curso" para el sandbox multifacultad.
// Módulo PURO (sin DOM ni Supabase). Es el puerto del motor v2 de SIGA
// producción, con UN cambio de fondo: en vez de calcularPFCompleto() (un
// catálogo manual de formula_type por curso), calcula con las fórmulas
// crudas de INTRALU (formula-engine.js). Las bandas, los patrones y las
// secciones son los mismos que ya validaste en producción.
//
// Principio heredado: NUNCA se reescribe el álgebra de un curso. Todo pasa
// por calcular(), que solo evalúa la fórmula tal cual la publica INTRALU.
//
// Entrada:
//   formulaPP / formulaFinal: strings crudos de INTRALU (formulaPP puede ser null).
//   valores: { N1: 15, N2: null, EP: 12, EF: null, ES: null, ... }
//   grupos:  { N1: 'PC', N5: 'MONOGRAFIA', N6: 'LAB', ... } (EP/EF siempre son EXAMEN).
//            Una variable de la fórmula que no venga en `grupos` se trata como PC.
//   meta:    el PF que el alumno quiere alcanzar.
//
// Salida (siempre un objeto con `tipo`):
//   'sin-formula' | 'error' → no se puede proyectar.
//   'completo'  → el curso ya tiene todas sus notas: { notaFinal, alcanzaMeta, seccionSusti }.
//   'escenarios'→ { secciones: [...] } con las secciones PC, LAB/Mono, Tu EP, Tu EF y susti.
//   Las claves de `valores` de cada alternativa son las variables (N4, EP, EF...);
//   la interfaz les pone el rótulo (PC4, EP...).
import { evaluarFormula, aplicarSustitutorio, truncarNota } from './formula-engine.js';
import { BANDA_APROBADO } from './escenarios.js';

/* ---------- Constantes: las mismas de producción (ver notas ahí) ---------- */
const BANDA_RESTO_ALTA = 15;                       // si con 10 no alcanza, se reintenta con el resto en ~15
const BANDAS_RESTO = [BANDA_APROBADO, BANDA_RESTO_ALTA];

const BANDA_RESTO_MIN_ASEQUIBLE = 15;              // "Mínimo asequible": el resto rinde bien
export const TECHO_MAXIMO_EXAMEN = 18;                    // "Máximo que te podría tocar": techo realista
const BANDA_OTRO_EXAMEN_PEOR_CASO = 13;            // el otro examen NO se deja en 10 (pesaría doble)
const PATRON_PEOR_CASO_EXAMEN = [17, 10, 13, 10, 15, 10, 17, 10];

const PATRON_ALTA_VALORES = [17, 14, 16, 13, 17, 15, 16, 14];
const PATRON_MIXTA_VALORES = [13, 10, 11, 10, 12, 10, 13, 10];
// Solo para cursos SIN examen: ahí no hay nada que compense y el foco escala libremente.
const PATRON_ALTA_OFFSET = [1, 2, 0, 1, 2, 0, 1, 2];
const PATRON_MIXTA_OFFSET = [2, -2, 1, -3, 2, -1, 1, -2];

const ORDEN_GRUPO = { PC: 1, LAB: 2, MONOGRAFIA: 3, EXAMEN: 4 };
const ORDEN_EXAMEN = { EP: 1, EF: 2 };

const esNula = (v) => v === null || v === undefined;
const acotar = (v) => Math.max(0, Math.min(20, v));

/* Variables que menciona una fórmula cruda (igual que en escenarios.js). */
function variablesDeFormula(raw) {
    if (!raw) return [];
    const ids = String(raw).match(/K\d+MIN|[A-Za-z]+\d*/g) || [];
    return [...new Set(ids.filter((id) => id !== 'MIN' && !/^K\d+MIN$/.test(id)))];
}

/* ---------- Piezas del motor (todas reciben `ctx`) ---------- */

/* Menor BASE entera en [0,20] tal que, sumándole el patrón de offsets a cada
   componente de `comps`, se alcanza la meta. Con patron=[0] resuelve un
   solo valor plano (un examen, o varios exámenes iguales). */
function resolverPatronMinimo(ctx, fijosBase, comps, patron) {
    for (let base = 0; base <= 20; base++) {
        const valores = {};
        comps.forEach((c, i) => { valores[c] = acotar(base + patron[i % patron.length]); });
        const notaFinal = ctx.calcular({ ...fijosBase, ...valores });
        if (notaFinal !== null && notaFinal >= ctx.meta) return { valores, notaFinal };
    }
    return null;
}

function valoresPatronFijo(comps, patronValores) {
    const valores = {};
    comps.forEach((c, i) => { valores[c] = patronValores[i % patronValores.length]; });
    return valores;
}

/* UNA alternativa (alta o mixta) para un tipo de foco (PC o LAB): el foco se
   fija en el patrón realista y es el EXAMEN el que se resuelve libremente
   para cerrar la meta. Sin examen (solo prácticas), el foco escala solo. */
function generarAlternativaTipo(ctx, pendientesFoco, tipoFoco, patronValores, patronOffsetFallback) {
    const { todos, actuales, tipoDe, grupoExamen } = ctx;
    const valoresFoco = valoresPatronFijo(pendientesFoco, patronValores);

    if (grupoExamen.length) {
        for (const bandaResto of BANDAS_RESTO) {
            const base = {};
            todos.forEach((c) => {
                const tipo = tipoDe(c);
                if (tipo === tipoFoco) { base[c] = actuales[c] !== null ? actuales[c] : valoresFoco[c]; return; }
                if (tipo === 'EXAMEN') { if (actuales[c] !== null) base[c] = actuales[c]; return; } // pendiente: se resuelve
                base[c] = actuales[c] !== null ? actuales[c] : bandaResto;
            });
            const pendientesExamen = grupoExamen.filter((c) => base[c] === undefined);
            let res;
            if (pendientesExamen.length) {
                res = resolverPatronMinimo(ctx, base, pendientesExamen, [0]);
            } else {
                const notaFinal = ctx.calcular(base);
                res = (notaFinal !== null && notaFinal >= ctx.meta) ? { valores: {}, notaFinal } : null;
            }
            if (res) {
                return {
                    valores: { ...valoresFoco, ...res.valores }, notaFinal: res.notaFinal,
                    bandaAsumida: bandaResto === BANDA_APROBADO ? null : bandaResto,
                };
            }
        }
        return null;
    }

    for (const bandaResto of BANDAS_RESTO) {
        const base = {};
        todos.forEach((c) => {
            if (tipoDe(c) === tipoFoco) {
                // Las del propio foco que ya tienen nota real cuentan; solo las pendientes se resuelven.
                if (actuales[c] !== null) base[c] = actuales[c];
                return;
            }
            base[c] = actuales[c] !== null ? actuales[c] : bandaResto;
        });
        const res = resolverPatronMinimo(ctx, base, pendientesFoco, patronOffsetFallback);
        if (res) return { valores: res.valores, notaFinal: res.notaFinal, bandaAsumida: bandaResto === BANDA_APROBADO ? null : bandaResto };
    }
    return null;
}

/* "Alternativa alta" / "Alternativa mixta" para un tipo de componente. */
function generarAlternativasTipo(ctx, comps, tipoFoco, incluirMixta) {
    const { actuales } = ctx;
    const pendientes = comps.filter((c) => actuales[c] === null);
    const entradas = comps.filter((c) => actuales[c] !== null).map((c) => ({ variable: c, valor: actuales[c] }));
    if (!pendientes.length) return { sinPendientes: true, entradas };

    const alta = generarAlternativaTipo(ctx, pendientes, tipoFoco, PATRON_ALTA_VALORES, PATRON_ALTA_OFFSET);
    const mixtaCruda = incluirMixta ? generarAlternativaTipo(ctx, pendientes, tipoFoco, PATRON_MIXTA_VALORES, PATRON_MIXTA_OFFSET) : null;
    // Si alta y mixta piden exactamente lo mismo, la mixta no aporta nada.
    const mixta = (mixtaCruda && alta && JSON.stringify(mixtaCruda.valores) === JSON.stringify(alta.valores)) ? null : mixtaCruda;
    return { sinPendientes: false, entradas, alta, mixta };
}

function seccionPC(ctx, grupoPC) {
    if (!grupoPC.length) return null;
    return {
        id: 'pc', nombre: '📝 Estrategia en PCs',
        descripcion: 'Cómo repartir tus Prácticas Calificadas (PC) para llegar a tu meta.',
        ...generarAlternativasTipo(ctx, grupoPC, 'PC', true),
    };
}

function seccionLabMono(ctx, grupoLab, grupoMono) {
    if (!grupoLab.length && !grupoMono.length) {
        return { id: 'labmono', nombre: '🧪 Escenarios en LABs y Monografías', noDisponible: true };
    }
    // Monografías: 1-2 casilleros y dependen del criterio del profesor → un solo valor referencial.
    const lab = grupoLab.length ? generarAlternativasTipo(ctx, grupoLab, 'LAB', true) : null;
    const mono = grupoMono.length ? generarAlternativasTipo(ctx, grupoMono, 'MONOGRAFIA', false) : null;
    return { id: 'labmono', nombre: '🧪 Escenarios en LABs y Monografías', lab, mono };
}

/* Tarjeta de UN examen: su propio mínimo y máximo, independiente del otro
   examen, para que ninguno quede siempre como "el difícil". */
function seccionExamen(ctx, foco) {
    const { todos, actuales, tipoDe, grupoExamen } = ctx;
    if (!grupoExamen.includes(foco) || actuales[foco] !== null) return null;

    // Mínimo asequible: el resto (incluido el otro examen) en banda alta. Sin techo.
    const baseAlta = {};
    todos.forEach((c) => {
        if (c === foco) return;
        baseAlta[c] = actuales[c] !== null ? actuales[c] : BANDA_RESTO_MIN_ASEQUIBLE;
    });
    const minimo = resolverPatronMinimo(ctx, baseAlta, [foco], [0]);

    // Máximo que te podría tocar: PC/LAB/MONO pendientes en patrón variado y el
    // otro examen en 13. Techo realista de 18 para el foco.
    const pendientesNoExamen = todos.filter((c) => c !== foco && tipoDe(c) !== 'EXAMEN' && actuales[c] === null);
    const patronPeorCaso = valoresPatronFijo(pendientesNoExamen, PATRON_PEOR_CASO_EXAMEN);
    const baseBaja = {};
    todos.forEach((c) => {
        if (c === foco) return;
        if (actuales[c] !== null) { baseBaja[c] = actuales[c]; return; }
        baseBaja[c] = tipoDe(c) === 'EXAMEN' ? BANDA_OTRO_EXAMEN_PEOR_CASO : patronPeorCaso[c];
    });
    let maximo = null;
    for (let x = 0; x <= TECHO_MAXIMO_EXAMEN; x++) {
        const notaFinal = ctx.calcular({ ...baseBaja, [foco]: x });
        if (notaFinal !== null && notaFinal >= ctx.meta) { maximo = { valor: x, notaFinal }; break; }
    }

    return { id: `examen-${foco}`, nombre: foco === 'EP' ? '🎯 Tu EP' : '🎯 Tu EF', foco, minimo, maximo };
}

/* El susti REEMPLAZA la nota más baja entre EP y EF (y hereda su peso). Solo
   es una jugada real cuando ya rindió ambos exámenes. Se pasa `ES` directo a
   calcular(), que usa aplicarSustitutorio() — la misma regla de INTRALU. */
function seccionSustitutorio(ctx) {
    const { todos, actuales, grupoExamen } = ctx;
    if (!grupoExamen.includes('EP') || !grupoExamen.includes('EF')) return null;
    if (actuales.EP === null || actuales.EF === null) return null;

    const base = {};
    todos.forEach((c) => { base[c] = actuales[c] !== null ? actuales[c] : BANDA_APROBADO; });

    const notaActual = ctx.calcular(base);
    const nombre = '🔁 Jugada del susti';
    if (notaActual !== null && notaActual >= ctx.meta) {
        return { id: 'susti', nombre, yaAlcanzaMeta: true, notaActual, notaConVeinte: ctx.calcular({ ...base, ES: 20 }) };
    }
    let resultado = null;
    for (let es = 0; es <= 20; es++) {
        const notaFinal = ctx.calcular({ ...base, ES: es });
        if (notaFinal !== null && notaFinal >= ctx.meta) { resultado = { es, notaFinal }; break; }
    }
    return { id: 'susti', nombre, yaAlcanzaMeta: false, notaActual, resultado };
}

/* ---------- Punto de entrada ---------- */
export function generarEscenariosMeta({ formulaPP, formulaFinal, valores = {}, grupos = {}, meta }) {
    if (!formulaFinal) return { tipo: 'sin-formula' };

    try {
        // PF con un juego de valores. null si falta algún dato (no adivina nada).
        const calcular = (vals) => {
            const pp = formulaPP ? evaluarFormula(formulaPP, vals) : null;
            return truncarNota(evaluarFormula(formulaFinal, aplicarSustitutorio({ ...vals, PP: pp })));
        };

        // Componentes = las variables que la fórmula realmente usa (sin PP ni ES).
        const usadas = new Set([...variablesDeFormula(formulaPP), ...variablesDeFormula(formulaFinal)]);
        usadas.delete('PP');
        usadas.delete('ES');

        const tipoDe = (v) => ((v === 'EP' || v === 'EF') ? 'EXAMEN' : (grupos[v] || 'PC'));
        const numeroDe = (v) => (ORDEN_EXAMEN[v] ?? parseInt((v.match(/\d+/) || [0])[0], 10));
        const todos = [...usadas].sort((a, b) =>
            (ORDEN_GRUPO[tipoDe(a)] - ORDEN_GRUPO[tipoDe(b)]) || (numeroDe(a) - numeroDe(b)) || a.localeCompare(b));

        const actuales = {};
        todos.forEach((v) => { actuales[v] = esNula(valores[v]) ? null : valores[v]; });

        const grupoPC = todos.filter((c) => tipoDe(c) === 'PC');
        const grupoLab = todos.filter((c) => tipoDe(c) === 'LAB');
        const grupoMono = todos.filter((c) => tipoDe(c) === 'MONOGRAFIA');
        const grupoExamen = todos.filter((c) => tipoDe(c) === 'EXAMEN');

        const ctx = { calcular, meta, actuales, todos, tipoDe, grupoExamen };
        const seccionSusti = seccionSustitutorio(ctx);

        // Ya tiene TODAS sus notas: nada que proyectar, pero el susti sigue siendo relevante.
        if (todos.every((c) => actuales[c] !== null)) {
            // Si el alumno ya rindió el ES, cuenta para la nota real (regla de INTRALU).
            const notaFinal = calcular({ ...actuales, ES: esNula(valores.ES) ? null : valores.ES });
            return { tipo: 'completo', notaFinal, alcanzaMeta: notaFinal !== null && notaFinal >= meta, seccionSusti };
        }

        const secciones = [
            seccionPC(ctx, grupoPC),
            seccionLabMono(ctx, grupoLab, grupoMono),
            seccionExamen(ctx, 'EP'),
            seccionExamen(ctx, 'EF'),
            seccionSusti,
        ].filter(Boolean);

        return { tipo: 'escenarios', secciones };
    } catch (error) {
        return { tipo: 'error', mensaje: error.message };
    }
}