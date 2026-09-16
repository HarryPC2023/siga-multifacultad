// js/avance-curricular-guardar.js — traduce el JSON que arma
// avance-curricular-parser.js a filas de la tabla avance_curricular y
// las guarda. Clave de upsert: (user_id, codigo_curso) — una fila por
// curso de toda la carrera, no por periodo (así lo definió la versión
// anterior de esta tabla, y así se mantiene).

import { supabase } from './auth-siga.js';
import { FACULTADES } from './facultades-datos.js';
import { periodoIngresoDesdeCodigo } from './avance-curricular-parser.js';

function normalizarTexto(s) {
    return (s || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita tildes
        .toUpperCase()
        .replace(/^FACULTAD DE\s+/, '')
        .trim();
}

/* Traduce "INGENIERÍA INDUSTRIAL Y DE SISTEMAS" (tal como lo trae el
   PDF) a "FIIS" (como lo espera la tabla), usando facultades-datos.js
   como fuente de verdad — no un mapeo escrito a mano aparte. */
function siglaDesdeFacultadPdf(facultadPdf) {
    const objetivo = normalizarTexto(facultadPdf);
    const encontrada = FACULTADES.find((f) => normalizarTexto(f.nombre) === objetivo);
    return encontrada ? encontrada.sigla : null;
}

/* Traduce "INGENIERÍA DE SISTEMAS" a "Ingeniería de Sistemas" (con el
   Título/tildes que usa la tabla), buscando dentro de las carreras de
   la facultad ya identificada. */
function carreraDesdeEspecialidadPdf(especialidadPdf, sigla) {
    const facultad = FACULTADES.find((f) => f.sigla === sigla);
    if (!facultad) return null;
    const objetivo = normalizarTexto(especialidadPdf);
    const encontrada = facultad.carreras.find((c) => normalizarTexto(c.nombre) === objetivo);
    return encontrada ? encontrada.nombre : null;
}

/* "232" -> "20232" (periodo normal). "24V" -> "20233" (verano: resta 1
   al año y usa tipo 3) — confirmado contra filas reales ya guardadas
   en avance_curricular por la versión anterior de este flujo. */
function periodoNormalizado(periodoPdf) {
    const p = (periodoPdf || '').trim().toUpperCase();
    const m = p.match(/^(\d{2})([12V])$/);
    if (!m) return null;
    const [, anioCorto, tipo] = m;
    let anioNum = parseInt(anioCorto, 10);
    let tipoFinal = tipo;
    if (tipo === 'V') { anioNum -= 1; tipoFinal = '3'; }
    return `20${String(anioNum).padStart(2, '0')}${tipoFinal}`;
}

function filaDesdeCurso(curso, ciclo, categoria, facultadSigla, carreraNombre) {
    return {
        facultad: facultadSigla,
        carrera: carreraNombre,
        codigo_curso: curso.codigo,
        nombre_curso: curso.nombre,
        creditos: curso.creditos,
        prerequisitos: curso.prerequisitos.length ? curso.prerequisitos.join(' ') : null,
        ciclo,
        periodo_pdf: curso.periodo,
        periodo_normalizado: curso.periodo ? periodoNormalizado(curso.periodo) : null,
        nota: curso.nota,
        veces_llevado: curso.veces,
        situacion: curso.matriculado,
        categoria,
    };
}

/* Punto de entrada. Recibe el userId de Supabase y el objeto que
   devuelve parsearAvanceCurricular(). Si la facultad o la especialidad
   del PDF no calzan con ninguna de las 11 conocidas, se detiene sin
   guardar nada (en vez de guardar con la sigla/carrera en blanco o
   adivinada). */
async function guardarAvanceCurricular(userId, estructurado) {
    const facultadSigla = siglaDesdeFacultadPdf(estructurado.facultad);
    if (!facultadSigla) {
        return {
            ok: false,
            motivo: 'facultad_no_reconocida',
            detalle: `No se reconoce la facultad "${estructurado.facultad}" contra las 11 de facultades-datos.js.`,
        };
    }

    const carreraNombre = carreraDesdeEspecialidadPdf(estructurado.especialidad, facultadSigla);
    if (!carreraNombre) {
        return {
            ok: false,
            motivo: 'especialidad_no_reconocida',
            detalle: `No se reconoce la especialidad "${estructurado.especialidad}" dentro de ${facultadSigla}.`,
        };
    }

    const filas = [];
    for (const ciclo of estructurado.ciclos) {
        for (const curso of ciclo.cursos) {
            filas.push(filaDesdeCurso(curso, ciclo.numero, 'obligatorio', facultadSigla, carreraNombre));
        }
    }
    for (const curso of estructurado.electivos) {
        filas.push(filaDesdeCurso(curso, null, 'electivo', facultadSigla, carreraNombre));
    }
    for (const curso of estructurado.electivosComplementarios) {
        filas.push(filaDesdeCurso(curso, null, 'electivo_complementario', facultadSigla, carreraNombre));
    }

    const filasConUsuario = filas.map((f) => ({
        ...f,
        user_id: userId,
        actualizado_en: new Date().toISOString(),
    }));

    const { error, count } = await supabase
        .from('avance_curricular')
        .upsert(filasConUsuario, { onConflict: 'user_id,codigo_curso', count: 'exact' });

    if (error) {
        return { ok: false, motivo: 'guardado_fallo', detalle: error.message };
    }
    if (!count) {
        return { ok: false, motivo: 'guardado_fallo', detalle: 'Se intentó guardar pero 0 filas se escribieron (revisar políticas RLS de avance_curricular).' };
    }

    return {
        ok: true,
        cursosGuardados: count,
        facultad: facultadSigla,
        carrera: carreraNombre,
        periodoIngresoSugerido: periodoIngresoDesdeCodigo(estructurado.codigo),
    };
}

export { guardarAvanceCurricular, siglaDesdeFacultadPdf, carreraDesdeEspecialidadPdf, periodoNormalizado };
