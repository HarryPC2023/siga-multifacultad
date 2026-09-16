function esTokenFacultad(s) {
    return /^[A-ZÁÉÍÓÚÑ]{1,3}$/.test(s);
}
function esCodigoCurso(s) {
    return /^[A-Z]{2,4}\d{2,3}$/.test(s);
}

function limpiarTexto(textoCrudo) {
    return textoCrudo
        .replace(/=====\s*PÁGINA\s*\d+\s*=====/g, ' ')
        .replace(/UNIVERSIDAD NACIONAL DE INGENIERÍA[\s\S]*?Observación\s*/g, ' ');
}

function extraerEncabezado(textoCrudo) {
    const primerBloque = textoCrudo.split(/=====\s*PÁGINA\s*2\s*=====/)[0] || textoCrudo;
    const facultad = primerBloque.match(/FACULTAD\s*:\s*(.+?)\s{2,}ALUMNO/)?.[1]?.trim() || null;
    const especialidad = primerBloque.match(/ESPECIALIDAD\s*:\s*(.+?)\s{2,}C[OÓ]DIGO/)?.[1]?.trim() || null;
    const codigo = primerBloque.match(/C[OÓ]DIGO\s*:\s*(\S+)/)?.[1] || null;
    const cicloRelativo = primerBloque.match(/CICLO RELATIVO\s*:\s*(\d+)/)?.[1] || null;
    const planEstudio = primerBloque.match(/PLAN DE ESTUDIO\s*:\s*(\S+)/)?.[1] || null;
    return { facultad, especialidad, codigo, cicloRelativo, planEstudio };
}

/* El código de estudiante de la UNI codifica, en sus primeros 5 dígitos:
   - los 4 primeros: año de ingreso (ej. "2023")
   - el 5to: modalidad de ingreso — 0 = Ordinario examen de febrero
     (entra en el periodo 1, marzo-julio), 1 = Ordinario examen de
     agosto (entra en el periodo 2, agosto-diciembre), 2 = Cepre,
     4 = concurso nacional/Colegio Mayor, 5 = traslado externo.
   (Confirmado por Harry con su propio código, 20231059E: el "1" es
   justamente por haber ingresado en el examen de agosto de 2023, o
   sea periodo 2 — no periodo 1 como se asumía antes de esta corrección.)

   Solo 0 y 1 tienen un periodo de ingreso fijo y conocido. Cepre,
   concurso y traslado NO lo tienen (varían caso a caso) — para esos
   se devuelve null y el alumno debe confirmarlo él mismo, en vez de
   inventar un periodo que podría estar mal. */
function periodoIngresoDesdeCodigo(codigo) {
    const c = (codigo || '').trim();
    const anio = parseInt(c.slice(0, 4), 10);
    if (Number.isNaN(anio) || anio < 2000 || anio > new Date().getFullYear()) return null;

    const modalidad = c[4];
    if (modalidad === '0') return `${anio}1`;
    if (modalidad === '1') return `${anio}2`;
    return null; // Cepre, concurso/Colegio Mayor o traslado: sin periodo fijo conocido
}

function parsearFilasDeSegmento(segmento) {
    // El PDF deja un solo espacio entre "**" y el código de la fila
    // siguiente (a diferencia de las demás columnas, separadas por 2-3
    // espacios) — se fuerza el espacio extra para que quede como su
    // propia celda al dividir.
    const segmentoNormalizado = segmento.replace(/\*\*/g, '**   ');
    const celdas = segmentoNormalizado.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
    const filas = [];
    let i = 0;

    while (i < celdas.length) {
        const codigo = celdas[i];
        if (!esCodigoCurso(codigo)) { i++; continue; } // basura suelta entre secciones
        i++;

        const nombre = (celdas[i] || '').replace(/-+$/, '').trim();
        i++;

        const creditosCrudo = parseInt(celdas[i], 10);
        i++;

        let prerequisitos = [];
        if (celdas[i] && !esTokenFacultad(celdas[i])) {
            prerequisitos = celdas[i].split(/\s+/);
            i++;
        }

        const facultadFila = celdas[i] || null;
        i++;

        let periodo = null, nota = null, veces = null, matriculado = null, observacion = null;
        if (celdas[i] === '**') {
            i++;
        } else {
            periodo = celdas[i] ?? null; i++;
            nota = celdas[i] !== undefined ? parseFloat(celdas[i]) : null; i++;
            veces = celdas[i] !== undefined ? parseInt(celdas[i], 10) : null; i++;
            matriculado = celdas[i] || null; i++;
            // Si lo que sigue NO es un código de curso válido, es texto de
            // Observación (poco común, pero puede pasar) — se consume también.
            if (celdas[i] && !esCodigoCurso(celdas[i])) {
                observacion = celdas[i];
                i++;
            }
        }

        filas.push({
            codigo, nombre,
            creditos: Number.isNaN(creditosCrudo) ? null : creditosCrudo,
            prerequisitos, facultad: facultadFila,
            periodo, nota, veces, matriculado, observacion,
        });
    }

    return filas;
}

function parsearAvanceCurricular(textoCrudo) {
    const encabezado = extraerEncabezado(textoCrudo);
    const textoLimpio = limpiarTexto(textoCrudo);
    const [cuerpo] = textoLimpio.split(/Notas del periodo/);

    const marcador = /CICLO\s*:\s*(\d+)|CURSOS ELECTIVOS COMPLEMENTARIOS|CURSOS ELECTIVOS(?!\s*COMPLEMENTARIOS)/g;

    const secciones = [];
    let match;
    let ultimoFin = null;
    let etiquetaActual = null;
    while ((match = marcador.exec(cuerpo)) !== null) {
        if (etiquetaActual !== null) {
            secciones.push({ etiqueta: etiquetaActual, texto: cuerpo.slice(ultimoFin, match.index) });
        }
        etiquetaActual = match[1] ? { tipo: 'ciclo', numero: parseInt(match[1], 10) }
            : match[0].includes('COMPLEMENTARIOS') ? { tipo: 'electivo_complementario' }
                : { tipo: 'electivo' };
        ultimoFin = marcador.lastIndex;
    }
    if (etiquetaActual !== null) {
        secciones.push({ etiqueta: etiquetaActual, texto: cuerpo.slice(ultimoFin) });
    }

    const ciclos = secciones
        .filter((s) => s.etiqueta.tipo === 'ciclo')
        .map((s) => ({ numero: s.etiqueta.numero, cursos: parsearFilasDeSegmento(s.texto) }));

    const electivos = secciones
        .filter((s) => s.etiqueta.tipo === 'electivo')
        .flatMap((s) => parsearFilasDeSegmento(s.texto));

    const electivosComplementarios = secciones
        .filter((s) => s.etiqueta.tipo === 'electivo_complementario')
        .flatMap((s) => parsearFilasDeSegmento(s.texto));

    return { ...encabezado, ciclos, electivos, electivosComplementarios };
}

export { parsearAvanceCurricular, periodoIngresoDesdeCodigo };