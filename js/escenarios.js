// escenarios.js — Motor de escenarios de SIGA (sandbox multifacultad).
// Módulo PURO: no toca el DOM ni Supabase. Recibe la fórmula cruda de
// INTRALU y los valores actuales del curso, y devuelve un resultado
// estructurado que la interfaz solo tiene que pintar.
//
// Hoy lo usa la caja "¿Qué nota necesito para aprobar?". Meta del curso
// va a reutilizar este mismo módulo (mismas bandas, mismo motor), así
// las dos herramientas nunca se contradicen.
//
// Principio heredado de producción: NUNCA se reescribe el álgebra de un
// curso. Todo se calcula con evaluarFormula / calcularNotaMinimaNecesaria
// (formula-engine.js), que interpretan la fórmula tal cual la publica
// INTRALU.
import { evaluarFormula, calcularNotaMinimaNecesaria, aplicarSustitutorio, truncarNota } from './formula-engine.js';

/* Valor que se asume para una nota NO examen (PC, LAB, monografía) que
   todavía no existe. Es la misma idea que BANDA_APROBADO de Meta del
   curso. La interfaz SIEMPRE debe avisar que se asumió (ver `supuestos`):
   un supuesto nunca puede pasar por un dato real. */
export const BANDA_APROBADO = 10;

/* Hipótesis de EP cuando EP y EF están pendientes: "si sacas EP = 8,
   10 o 12, ¿cuánto necesito en EF?". Mismas tres filas de producción. */
export const HIPOTESIS_EP = [8, 10, 12];

const EXAMENES = ['EP', 'EF', 'ES'];

const esNula = (v) => v === null || v === undefined;

/* Variables que menciona una fórmula cruda (N1, EP, PP...). Ignora MIN y
   KnMIN. El orden de la regex importa: K2MIN antes del identificador
   genérico, igual que en el tokenizador de formula-engine.js. */
function variablesDeFormula(raw) {
    if (!raw) return [];
    const ids = String(raw).match(/K\d+MIN|[A-Za-z]+\d*/g) || [];
    return [...new Set(ids.filter((id) => id !== 'MIN' && !/^K\d+MIN$/.test(id)))];
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
   - valores: { N1: 15, N2: null, EP: 12, EF: null, ... } (ya con lo simulado en pantalla).
   - umbral: nota mínima para aprobar (10).
   Devuelve siempre un objeto con `tipo`:
     'sin-formula'  → INTRALU aún no publicó la fórmula.
     'error'        → la fórmula no se pudo interpretar.
     'faltan-datos' → aun asumiendo lo pendiente, no se puede calcular.
     'hipotesis'    → EP y EF pendientes: filas "si sacas EP = X → EF mínimo".
     'unico'        → un solo examen pendiente (EP o EF): su mínimo.
     'sustitutorio' → ambos exámenes rendidos, no llega al umbral y hay ES.
     'completo'     → todo rendido: nota final con estos valores.
   Y `supuestos`: variables NO examen que estaban vacías y se asumieron
   en BANDA_APROBADO (la interfaz debe rotularlas). */
export function calcularNecesito({ formulaPP, formulaFinal, valores, umbral = 10, hipotesisEP = HIPOTESIS_EP }) {
    if (!formulaFinal) return { tipo: 'sin-formula' };

    try {
        const usadas = new Set([...variablesDeFormula(formulaPP), ...variablesDeFormula(formulaFinal)]);
        usadas.delete('PP');

        // 1) Lo pendiente que NO es examen se asume en BANDA_APROBADO.
        const base = { ...valores };
        const supuestos = [];
        usadas.forEach((v) => {
            if (EXAMENES.includes(v)) return;
            if (esNula(base[v])) { base[v] = BANDA_APROBADO; supuestos.push(v); }
        });
        supuestos.sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));

        // Si no hay fórmula de prácticas, PP tiene que venir dado (o queda null).
        if (!formulaPP && !('PP' in base)) base.PP = null;

        const resolver = (valoresBase, variableIncognita) =>
            interpretar(calcularNotaMinimaNecesaria({ formulaPP, formulaFinal, valoresBase, variableIncognita, umbral }));

        // 2) ¿Qué exámenes (EP/EF) siguen pendientes?
        const pendEP = usadas.has('EP') && esNula(base.EP);
        const pendEF = usadas.has('EF') && esNula(base.EF);

        if (pendEP && pendEF) {
            const filas = hipotesisEP.map((ep) => ({
                dado: { variable: 'EP', valor: ep },
                ...resolver({ ...base, EP: ep, EF: null }, 'EF'),
            }));
            return { tipo: 'hipotesis', incognita: 'EF', filas, supuestos };
        }

        if (pendEP || pendEF) {
            const incognita = pendEP ? 'EP' : 'EF';
            return { tipo: 'unico', incognita, ...resolver({ ...base }, incognita), supuestos };
        }

        // 3) Ambos exámenes rendidos (o el curso no los usa): nota final actual.
        const pp = formulaPP ? evaluarFormula(formulaPP, base) : null;
        const cruda = evaluarFormula(formulaFinal, aplicarSustitutorio({ ...base, PP: pp }));
        const notaFinal = truncarNota(cruda);
        if (notaFinal === null) return { tipo: 'faltan-datos', supuestos };

        if (notaFinal >= umbral) return { tipo: 'completo', notaFinal, aprueba: true, supuestos };

        // No llega: si el curso tiene ES sin rendir, ¿cuánto necesita ahí?
        if ('ES' in base && esNula(base.ES)) {
            return { tipo: 'sustitutorio', notaFinal, incognita: 'ES', ...resolver({ ...base }, 'ES'), supuestos };
        }
        return { tipo: 'completo', notaFinal, aprueba: false, supuestos };
    } catch (error) {
        return { tipo: 'error', mensaje: error.message };
    }
}
