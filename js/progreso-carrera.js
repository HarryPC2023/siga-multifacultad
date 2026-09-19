// progreso-carrera.js — Lógica de "Progreso de tu carrera" (y de "Ruta del Curso")
// para el sandbox multifacultad. Módulo PURO: no toca el DOM ni Supabase.
//
// A diferencia de producción (una malla escrita a mano por carrera, con el
// estado de cada curso INFERIDO del historial de notas), acá todo sale del
// Avance Curricular que INTRALU publica para cada alumno y que el sandbox ya
// guarda en la tabla avance_curricular: el plan completo por ciclos, con los
// prerrequisitos reales, los créditos y la nota de cada curso. Por eso sirve
// para cualquier facultad y carrera sin mantener archivos por carrera.
//
// Entrada: las filas de avance_curricular tal como están en la tabla
//   { categoria, ciclo, codigo_curso, nombre_curso, creditos, prerequisitos,
//     periodo_pdf, nota, veces_llevado, situacion }
//   categoria: 'obligatorio' | 'electivo' | 'electivo_complementario'
//   prerequisitos: texto con códigos separados por espacio ("SI806 SI807") o null.
//
// Estados de un curso (los mismos de producción):
//   aprobado   → nota >= 10
//   en_curso   → matriculado sin nota todavía (o indicado en `enCurso`)
//   disponible → no lo aprobó y ya cumple sus prerrequisitos (incluye los jalados:
//                jalar no bloquea volver a llevarlo; se marca `jalado`)
//   proximo    → "se abre pronto": sus prerrequisitos están aprobados o en curso
//   bloqueado  → todavía le falta algún prerrequisito

export const UMBRAL_APROBADO = 10;

const esNula = (v) => v === null || v === undefined || v === '';

/* "SI806 SI807" -> ['SI806', 'SI807'] (acepta también coma o punto y coma). */
function codigosDePrerrequisitos(texto) {
    if (esNula(texto)) return [];
    return String(texto).split(/[\s,;]+/).map((c) => c.trim().toUpperCase()).filter(Boolean);
}

function notaNumerica(valor) {
    if (esNula(valor)) return null;
    const n = parseFloat(valor);
    return Number.isNaN(n) ? null : n;
}

/* Estado que dice la fila por sí sola (antes de mirar los prerrequisitos). */
function estadoBase(fila, enCurso) {
    const nota = notaNumerica(fila.nota);
    if (nota !== null && nota >= UMBRAL_APROBADO) return 'aprobado';
    // Lo está llevando ahora (por ejemplo, repite un curso jalado): el Avance todavía
    // muestra la nota del intento anterior, pero lo que manda es que ya está matriculado.
    if (enCurso.has(fila.codigo_curso)) return 'en_curso';
    if (nota !== null) return 'jalado';
    if (!esNula(fila.periodo_pdf)) return 'en_curso'; // matriculado, todavía sin nota
    return 'pendiente';
}

/* Construye el progreso completo de la carrera.
   opciones.enCurso: códigos de curso que el alumno está llevando ahora aunque el
   Avance todavía no lo diga (por ejemplo, los del periodo abierto en notas_curso). */
export function construirProgresoCarrera(filas, opciones = {}) {
    const enCurso = new Set(opciones.enCurso || []);

    const cursos = (filas || []).map((f) => ({
        codigo: f.codigo_curso,
        nombre: f.nombre_curso,
        creditos: Number(f.creditos) || 0,
        categoria: f.categoria,
        ciclo: esNula(f.ciclo) ? null : Number(f.ciclo),
        prereq: codigosDePrerrequisitos(f.prerequisitos).map((code) => ({ tipo: 'curso', code })),
        nota: notaNumerica(f.nota),
        periodo: esNula(f.periodo_pdf) ? null : f.periodo_pdf,
        veces: esNula(f.veces_llevado) ? null : Number(f.veces_llevado),
        situacion: esNula(f.situacion) ? null : f.situacion,
        estado: estadoBase(f, enCurso),
        jalado: false,
        inferido: false,
    }));
    const porCodigo = Object.fromEntries(cursos.map((c) => [c.codigo, c]));

    // Si un curso está aprobado o en curso, sus prerrequisitos TUVIERON que estar
    // aprobados (la universidad no deja matricular sin cumplirlos). Rellena huecos
    // cuando el Avance no trae el dato (por ejemplo, una convalidación). Solo toca
    // lo que no tiene registro; un curso jalado se respeta.
    const pila = cursos.filter((c) => c.estado === 'aprobado' || c.estado === 'en_curso').map((c) => c.codigo);
    const visitados = new Set(pila);
    while (pila.length) {
        const actual = porCodigo[pila.pop()];
        if (!actual) continue;
        actual.prereq.forEach((p) => {
            const requerido = porCodigo[p.code];
            if (!requerido || visitados.has(p.code)) return;
            visitados.add(p.code);
            if (requerido.estado === 'pendiente') { requerido.estado = 'aprobado'; requerido.inferido = true; }
            pila.push(p.code);
        });
    }

    const creditosAprobadosTotal = cursos.filter((c) => c.estado === 'aprobado').reduce((s, c) => s + c.creditos, 0);

    // Un código de prerrequisito que no está en el plan del alumno no bloquea (se ignora).
    const cumplido = (p) => {
        const req = porCodigo[p.code];
        return !req || req.estado === 'aprobado';
    };
    const cumplidoOEnCurso = (p) => {
        const req = porCodigo[p.code];
        return !req || req.estado === 'aprobado' || req.estado === 'en_curso';
    };

    cursos.forEach((c) => {
        if (c.estado === 'aprobado' || c.estado === 'en_curso') return;
        c.jalado = c.estado === 'jalado';
        if (c.prereq.every(cumplido)) c.estado = 'disponible';
        else if (c.prereq.every(cumplidoOEnCurso)) c.estado = 'proximo';
        else c.estado = 'bloqueado';
    });

    const obligatorios = cursos.filter((c) => c.categoria === 'obligatorio');
    const numerosDeCiclo = [...new Set(obligatorios.map((c) => c.ciclo).filter((n) => n !== null))].sort((a, b) => a - b);
    const ciclos = numerosDeCiclo.map((numero) => ({
        numero,
        cursos: obligatorios.filter((c) => c.ciclo === numero).sort((a, b) => a.codigo.localeCompare(b.codigo)),
    }));

    const porCategoria = (cat) => cursos.filter((c) => c.categoria === cat).sort((a, b) => a.codigo.localeCompare(b.codigo));
    const aprobados = (lista) => lista.filter((c) => c.estado === 'aprobado');
    const suma = (lista) => lista.reduce((s, c) => s + c.creditos, 0);
    const electivos = porCategoria('electivo');
    const complementarios = porCategoria('electivo_complementario');

    const resumen = {
        obligatorios: {
            cursosAprobados: aprobados(obligatorios).length, cursosTotal: obligatorios.length,
            creditosAprobados: suma(aprobados(obligatorios)), creditosTotal: suma(obligatorios),
        },
        electivos: { cursosAprobados: aprobados(electivos).length, cursosTotal: electivos.length, creditosAprobados: suma(aprobados(electivos)) },
        complementarios: { cursosAprobados: aprobados(complementarios).length, cursosTotal: complementarios.length, creditosAprobados: suma(aprobados(complementarios)) },
        creditosAprobadosTotal,
        // Ciclo más avanzado en el que ya hay algo aprobado o en curso (referencia, no "el ciclo actual" oficial).
        cicloMasAvanzado: Math.max(0, ...obligatorios.filter((c) => c.estado === 'aprobado' || c.estado === 'en_curso').map((c) => c.ciclo || 0)),
    };
    resumen.porcentajeObligatorios = resumen.obligatorios.creditosTotal
        ? Math.round((resumen.obligatorios.creditosAprobados / resumen.obligatorios.creditosTotal) * 100) : 0;

    return { ciclos, electivos, complementarios, cursos, porCodigo, resumen };
}

export const ETIQUETA_ESTADO = {
    aprobado: 'Aprobado', en_curso: 'En curso', disponible: 'Disponible',
    proximo: 'Se abre pronto', bloqueado: 'Bloqueado',
};

/* Cursos (de cualquier categoría) que exigen `codigo` como prerrequisito. */
export function cursosQueDesbloquea(progreso, codigo) {
    return progreso.cursos.filter((c) => c.prereq.some((p) => p.code === codigo));
}

/* Datos puros para el detalle de un curso y para "Ruta del Curso": qué necesita
   y qué se le abre al aprobarlo (con un nivel más cuando hay una sola rama). */
export function datosRutaCurso(progreso, codigo) {
    const curso = progreso.porCodigo[codigo];
    if (!curso) return null;

    const mostrarNecesita = curso.estado !== 'aprobado' && curso.estado !== 'en_curso';
    const necesita = mostrarNecesita
        ? curso.prereq.map((p) => {
            const req = progreso.porCodigo[p.code];
            return {
                tipo: 'curso', code: p.code, name: req ? req.nombre : '',
                cumplido: !req || req.estado === 'aprobado',
                enCurso: !!req && req.estado === 'en_curso',
                fueraDelPlan: !req,
            };
        })
        : [];

    // Lo que le falta a un curso derivado, aparte del que se está mirando.
    const otrosFaltantes = (c, excluir) => c.prereq
        .filter((p) => p.code !== excluir)
        .filter((p) => { const r = progreso.porCodigo[p.code]; return r && r.estado !== 'aprobado'; })
        .map((p) => p.code);

    function nivel(lista, esRaiz) {
        return lista.map((c) => {
            const nietos = cursosQueDesbloquea(progreso, c.codigo);
            const expandir = esRaiz && lista.length <= 1 && nietos.length;
            return {
                code: c.codigo, name: c.nombre, credits: c.creditos, categoria: c.categoria,
                faltan: otrosFaltantes(c, esRaiz ? codigo : null),
                nietos: expandir ? nivel(nietos, false) : [],
            };
        });
    }

    return {
        code: curso.codigo, name: curso.nombre, credits: curso.creditos,
        categoria: curso.categoria, ciclo: curso.ciclo,
        estado: curso.estado, estadoLabel: ETIQUETA_ESTADO[curso.estado],
        nota: curso.nota, jalado: curso.jalado, inferido: curso.inferido, veces: curso.veces,
        necesita, desbloquea: nivel(cursosQueDesbloquea(progreso, codigo), true),
    };
}