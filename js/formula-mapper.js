// js/formula-mapper.js — Traduce las evaluaciones crudas de INTRALU
// (como las guarda SIGA en Supabase) al objeto `valores` que espera
// formula-engine.js, ej. { N1: 17, N2: 18, PP: 14.2, EP: 12 }.
//
// Regla de mapeo (confirmada con datos reales de INTRALU):
//   - es_examen === false -> es una práctica/laboratorio -> variable
//     "N" + camnot (camnot SÍ es el número correcto: PRACTICA 1 trae
//     camnot=1, PRACTICA 2 trae camnot=2, etc. — no se extrae el
//     número del texto de "descripcion", que podría variar).
//   - es_examen === true  -> se clasifica por palabra clave en
//     "descripcion": contiene "SUSTITUTORIO" -> ES, si no contiene
//     "PARCIAL" -> EP, si no contiene "FINAL" -> EF. Se usa palabra
//     clave (no el número fijo de camnot, ej. 13/14/15) porque ese
//     número podría no ser el mismo en otra facultad.
//
// PENDIENTE DE VERIFICAR: labs y monografías — hoy se asume que caen
// dentro de "es_examen === false" igual que las prácticas normales,
// pero esto no se ha confirmado todavía con un curso real que tenga
// alguno de los dos.

function notaComoNumero(nota) {
    if (nota === null || nota === undefined || nota === '') return null;
    const n = parseFloat(nota);
    return Number.isNaN(n) ? null : n;
}

function clasificarExamen(descripcion) {
    const desc = (descripcion || '').toUpperCase();
    if (desc.includes('SUSTITUTORIO')) return 'ES';
    if (desc.includes('PARCIAL')) return 'EP';
    if (desc.includes('FINAL')) return 'EF';
    return null; // examen de tipo no reconocido -> se ignora, no se inventa una variable
}

/* Convierte el arreglo crudo `evaluaciones` (tal como se guarda en
   Supabase) al objeto `valores` que necesita evaluarFormula(). */
function construirValoresFormula(evaluaciones) {
    // OJO: no se usa ev.es_examen — INTRALU lo manda mal a veces (ej.
    // BEG01 trae TODAS las prácticas marcadas como examen; SI501 trae
    // solo la PC3 así, sin patrón). clasificarExamen(descripcion) es
    // la única fuente confiable: si el texto no matchea un examen
    // conocido, es práctica/lab, punto.
    const valores = {};
    for (const ev of evaluaciones || []) {
        const nota = notaComoNumero(ev.nota);
        const variableExamen = clasificarExamen(ev.descripcion);
        if (variableExamen) {
            valores[variableExamen] = nota;
        } else if (ev.camnot !== null && ev.camnot !== undefined) {
            valores[`N${ev.camnot}`] = nota;
        }
    }
    return valores;
}

export { construirValoresFormula, notaComoNumero, clasificarExamen };
