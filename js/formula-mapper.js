// js/formula-mapper.js — Traduce las evaluaciones crudas de INTRALU
// (como las guarda SIGA en Supabase) al objeto `valores` que espera
// formula-engine.js, ej. { N1: 17, N2: 18, PP: 14.2, EP: 12 }.
//
// Regla de mapeo (confirmada con datos reales de INTRALU, incluyendo
// labs y monografías — ver notas_curso de BQU01/BRC01 del 2023-2):
//   - clasificarExamen(descripcion) reconoce EP/EF/ES por palabra
//     clave en el texto ("PARCIAL"/"FINAL"/"SUSTITUTORIO"). Si
//     reconoce algo, esa evaluación es un examen — punto.
//   - Todo lo demás (prácticas, laboratorios, monografías) usa
//     "N" + camnot como variable (camnot SÍ es el número correcto:
//     PRACTICA 1 trae camnot=1, LAB5 trae camnot=5, etc.).
//   - OJO: NO se usa el campo ev.es_examen que manda INTRALU — se
//     confirmó que viene mal en algunos cursos (ej. BEG01 marca TODAS
//     sus prácticas como examen; SI501 marca solo una práctica suelta
//     como examen, sin patrón). La única fuente confiable es el texto
//     de "descripcion".

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
