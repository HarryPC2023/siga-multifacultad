// escenarios.js — Motor de escenarios de SIGA (sandbox multifacultad).
// Módulo PURO: no toca el DOM ni Supabase. Recibe la fórmula cruda de
// INTRALU y los valores actuales del curso, y devuelve un resultado
// estructurado que la interfaz solo tiene que pintar.
//
// Hoy lo usa la caja "¿Qué nota necesito para aprobar?" (mismos estados y
// mensajes que en SIGA producción). Meta del curso vive en escenarios-meta.js
// y reutiliza BANDA_APROBADO de acá.
//
// Principio heredado de producción: NUNCA se reescribe el álgebra de un
// curso. Todo se calcula con evaluarFormula / calcularNotaMinimaNecesaria
// (formula-engine.js), que interpretan la fórmula tal cual la publica INTRALU.
import { evaluarFormula, calcularNotaMinimaNecesaria, aplicarSustitutorio, truncarNota } from './formula-engine.js';

export const BANDA_APROBADO = 10;

/* Qué se cuenta para una nota NO examen (PC, LAB, monografía) que todavía no
   tiene valor: 0, IGUAL QUE EN SIGA producción. Es lo que realmente pasa si el
   alumno decide no dar una prueba o una monografía (por ejemplo, para priorizar
   otro curso), y así los dos sistemas dan los mismos números. La interfaz lo
   rotula ("Lo que aún no tiene nota cuenta como 0: ..."). Se dejan dos
   constantes por si algún día se quiere distinguir proyección de curso terminado. */
export const ASUMIDO_EN_PROYECCION = 0;
export const ASUMIDO_AL_TERMINAR = 0;

/* Candidatos para "Si sacas EP = X, ¿cuánto necesito en EF?". Igual que en
   SIGA: se muestran los 3 primeros que tengan sentido (EF entre 0 y 20). */
export const HIPOTESIS_EP = [8, 10, 12, 14, 16, 18, 20];
const MAX_HIPOTESIS = 3;

const EXAMENES = ['EP', 'EF', 'ES'];
const esNula = (v) => v === null || v === undefined;

/* Variables que menciona una fórmula cruda (N1, EP, PP...). Ignora MIN y
   KnMIN. El orden de la regex importa: K2MIN antes del identificador
   genérico, igual que en el tokenizador de formula-engine.js. */
export function variablesDeFormula(raw) {
    if (!raw) return [];
    const ids = String(raw).match(/K\d+MIN|[A-Za-z]+\d*/g) || [];
    return [...new Set(ids.filter((id) => id !== 'MIN' && !/^K\d+MIN$/.test(id)))];
}

function usadasEnFormulas(formulaPP, formulaFinal) {
    const usadas = new Set([...variablesDeFormula(formulaPP), ...variablesDeFormula(formulaFinal)]);
    usadas.delete('PP');
    return usadas;
}

/* ¿Ya tiene nota en TODOS los exámenes (EP/EF) que usa la fórmula? */
export function examenesRendidos(formulaPP, formulaFinal, valores) {
    const usadas = usadasEnFormulas(formulaPP, formulaFinal);
    const examenes = ['EP', 'EF'].filter((v) => usadas.has(v));
    return examenes.length > 0 && examenes.every((v) => !esNula(valores[v]));
}

/* Si ya rindió EP y EF, el curso terminó: lo que no tiene nota cuenta 0 para
   poder mostrar la nota final (igual que SIGA). Si todavía le falta algún
   examen, devuelve los valores tal cual. */
export function conPendientesEnCero(formulaPP, formulaFinal, valores) {
    if (!examenesRendidos(formulaPP, formulaFinal, valores)) return { valores, ceros: [] };
    const completados = { ...valores };
    const ceros = [];
    usadasEnFormulas(formulaPP, formulaFinal).forEach((v) => {
        if (EXAMENES.includes(v)) return;
        if (esNula(completados[v])) { completados[v] = ASUMIDO_AL_TERMINAR; ceros.push(v); }
    });
    return { valores: completados, ceros };
}

/* Traduce lo que devuelve calcularNotaMinimaNecesaria a un estado simple. */
function interpretar(res) {
    if (res.posible === null) return { estado: 'faltan-datos' };
    if (res.posible === false) return { estado: 'imposible', maximoPosible: res.notaMaximaPosible };
    const minimo = Math.max(0, res.notaMinima);
    // Si con 0 ya alcanza, no hay nada que "necesitar".
    if (minimo === 0) return { estado: 'seguro' };
    return { estado: 'ok', minimo };
}

/* Punto de entrada.
   - formulaPP / formulaFinal: strings crudos de INTRALU (formulaPP puede ser null).
   - valores: { N1: 15, N2: null, EP: 12, EF: null, ... } (ya con lo escrito en pantalla).
   - umbral: nota mínima para aprobar (10).
   Devuelve siempre un objeto con `tipo`:
     'sin-formula'  → INTRALU aún no publicó la fórmula.
     'error'        → la fórmula no se pudo interpretar.
     'faltan-datos' → aun asumiendo lo pendiente, no se puede calcular.
     'hipotesis'    → EP y EF pendientes: filas "si sacas EP = X → EF mínimo" (puede venir
                      vacío: ninguna hipótesis alcanza).
     'unico'        → un solo examen pendiente (EP o EF): su mínimo.
     'sustitutorio' → EP y EF rendidos, no llega al umbral y falta el ES: cuánto necesita en ES.
     'completo'     → nota final ya conocida: { notaFinal, aprueba, conES }.
   Y `supuestos` + `relleno`: variables NO examen que estaban vacías y qué valor
   se les asumió (10 en proyección, 0 si el curso ya terminó). La interfaz
   debe rotularlas. */
export function calcularNecesito({ formulaPP, formulaFinal, valores, umbral = 10, hipotesisEP = HIPOTESIS_EP }) {
    if (!formulaFinal) return { tipo: 'sin-formula' };

    try {
        const usadas = usadasEnFormulas(formulaPP, formulaFinal);
        const terminado = examenesRendidos(formulaPP, formulaFinal, valores);
        const sinExamenes = !usadas.has('EP') && !usadas.has('EF');
        const relleno = terminado ? ASUMIDO_AL_TERMINAR : ASUMIDO_EN_PROYECCION;

        // 1) Lo pendiente que NO es examen se asume (10 si es proyección, 0 si ya terminó).
        const base = { ...valores };
        const supuestos = [];
        usadas.forEach((v) => {
            if (EXAMENES.includes(v)) return;
            if (esNula(base[v])) { base[v] = relleno; supuestos.push(v); }
        });
        supuestos.sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));

        // Si no hay fórmula de prácticas, PP tiene que venir dado (o queda null).
        if (!formulaPP && !('PP' in base)) base.PP = null;

        const resolver = (valoresBase, variableIncognita) =>
            interpretar(calcularNotaMinimaNecesaria({ formulaPP, formulaFinal, valoresBase, variableIncognita, umbral }));

        // 2) Nota final ya conocida: rindió EP y EF (o el curso no tiene exámenes).
        if (terminado || sinExamenes) {
            const pp = formulaPP ? evaluarFormula(formulaPP, base) : null;
            const notaFinal = truncarNota(evaluarFormula(formulaFinal, aplicarSustitutorio({ ...base, PP: pp })));
            if (notaFinal === null) return { tipo: 'faltan-datos', supuestos, relleno };

            const conES = !esNula(base.ES);
            const aprueba = notaFinal >= umbral;
            if (aprueba || conES || sinExamenes) return { tipo: 'completo', notaFinal, aprueba, conES, supuestos, relleno };

            // No llega y todavía no rindió el ES: el susti siempre es una opción real
            // (INTRALU nunca lo menciona en la fórmula, pero reemplaza al menor de EP/EF).
            return { tipo: 'sustitutorio', notaFinal, incognita: 'ES', ...resolver({ ...base, ES: null }, 'ES'), supuestos, relleno };
        }

        // 3) Falta algún examen.
        const pendEP = usadas.has('EP') && esNula(base.EP);
        const pendEF = usadas.has('EF') && esNula(base.EF);

        if (pendEP && pendEF) {
            const filas = hipotesisEP
                .map((ep) => ({ dado: { variable: 'EP', valor: ep }, ...resolver({ ...base, EP: ep, EF: null }, 'EF') }))
                .filter((fila) => fila.estado === 'ok')
                .slice(0, MAX_HIPOTESIS);
            return { tipo: 'hipotesis', incognita: 'EF', filas, supuestos, relleno };
        }

        const incognita = pendEP ? 'EP' : 'EF';
        return { tipo: 'unico', incognita, ...resolver({ ...base }, incognita), supuestos, relleno };
    } catch (error) {
        return { tipo: 'error', mensaje: error.message };
    }
}