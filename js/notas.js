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
//
// "Guardar" conserva en este navegador (por usuario y periodo) las notas que
// el alumno escribió, para no volver a ponerlas cada vez. Lo oficial de
// INTRALU siempre gana: si INTRALU cambia una casilla, lo guardado de esa
// casilla se descarta solo (ver restaurarNotasGuardadas).
import { supabase, obtenerSesion } from './auth-siga.js';
import { evaluarFormula, aplicarSustitutorio, truncarNota } from './formula-engine.js';
import { calcularNecesito, conPendientesEnCero } from './escenarios.js';
import { generarEscenariosMeta, TECHO_MAXIMO_EXAMEN } from './escenarios-meta.js';
import { montarProgresoCarrera, nombreLindo, soltarFocoDe } from './progreso-carrera-ui.js';
import { montarRutaCurso } from './ruta-curso-ui.js';
import { construirValoresFormula, notaComoNumero, clasificarExamen } from './formula-mapper.js';
import { FACULTADES } from './facultades-datos.js';

const UMBRAL_APROBACION = 10;

let notasPorPeriodo = {};   // { "2023-2": [ {codigo_curso, seccion, nombre_curso, promedio_practicas, promedio_final, nota_asistencia, evaluaciones}, ... ] }
let formulasPorCurso = {};  // clave `${codigo_curso}|${seccion}|${periodo}` -> {formula_practicas, formula_nota_final, creditos}
let periodoActivo = null;
let valoresSimulados = {};  // clave `${codigo_curso}|${seccion}` -> { N1: 14, EP: 12, ... } (solo del periodo activo)
let usuarioActual = null;
let claveAlmacenUsuario = null; // huella estable del alumno (por su código de estudiante) para lo guardado en el navegador

document.addEventListener('DOMContentLoaded', async () => {
    const sesion = await obtenerSesion();
    if (!sesion) { window.location.href = 'index.html'; return; }
    usuarioActual = sesion.user;

    await pintarIdentidad(sesion);
    fijarHerramientasEnMovil();
    inicializarAnalisisAcademico();

    await cargarDatos(usuarioActual.id);
    inicializarSelectorPeriodo();
    inicializarModalEliminarPeriodo();
    inicializarGuardarLimpiar();

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

    // Lo que el alumno guarda en este navegador se identifica por su código de
    // estudiante (no por el user_id, que cambia con cada sesión anónima).
    claveAlmacenUsuario = await claveDeAlmacenamiento(perfil?.codigo_estudiante);
    migrarAlmacenAntiguo();

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

/* En celular el panel de identidad va arriba de las notas. Para que Meta, Progreso y Ruta
   no se pierdan al hacer scroll, se deja el panel "pegado" (position: sticky en el CSS)
   pero con un `top` negativo: la parte de arriba (foto, nombre, facultad) sale de la
   pantalla y solo queda visible la fila de herramientas. Como el panel no cambia de
   tamaño, no hay saltos. En escritorio el CSS ya lo pega entero y no se toca nada. */
function fijarHerramientasEnMovil() {
    const panel = document.getElementById('panelIdentidad');
    const fila = panel?.querySelector('.fila-herramientas');
    if (!panel || !fila) return;

    const ajustar = () => {
        const esEscritorio = window.matchMedia ? window.matchMedia('(min-width: 900px)').matches : true;
        if (esEscritorio) { panel.style.top = ''; return; }
        panel.style.top = `-${Math.max(0, fila.offsetTop - 8)}px`;
    };

    ajustar();
    window.addEventListener('resize', ajustar);
    // El panel crece cuando llega la facultad o cargan las fuentes: se vuelve a calcular.
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(ajustar).observe(panel);
}

/* ============================================================
   ANÁLISIS ACADÉMICO — las tres herramientas ya funcionan:
   - Meta del curso: panel lateral (más abajo), calculada con las
     fórmulas de INTRALU.
   - Progreso de tu carrera: ventana con el mapa por ciclos
     (progreso-carrera.js y progreso-carrera-ui.js).
   - Ruta del Curso: panel con lo que necesitas y lo que se abre al
     aprobarlo (ruta-curso-ui.js).
   Las dos últimas salen del Avance Curricular del propio alumno, así
   que sirven para cualquier facultad y carrera.
   ============================================================ */
let progresoCarrera = null;
let rutaCurso = null;

/* Filas del Avance Curricular del alumno. La tabla está protegida por RLS:
   cada usuario solo ve las suyas. */
async function cargarFilasAvance() {
    const { data, error } = await supabase
        .from('avance_curricular')
        .select('categoria, ciclo, codigo_curso, nombre_curso, creditos, prerequisitos, periodo_pdf, nota, veces_llevado, situacion');
    if (error) throw error;
    return data || [];
}

/* Cursos que el alumno lleva AHORA: los de los periodos que todavía están abiertos. */
function codigosEnCursoAhora() {
    const codigos = [];
    Object.keys(notasPorPeriodo).forEach((periodo) => {
        if (!periodoEstaAbierto(periodo)) return;
        (notasPorPeriodo[periodo] || []).forEach((curso) => codigos.push(curso.codigo_curso));
    });
    return codigos;
}

/* Cursos del periodo que el alumno tiene en pantalla (selector de Ruta del Curso). */
function cursosDelPeriodoActivo() {
    return (notasPorPeriodo[periodoActivo] || []).map((curso) => ({
        codigo: curso.codigo_curso,
        nombre: nombreCursoLindo(curso),
    }));
}

function inicializarAnalisisAcademico() {
    progresoCarrera = montarProgresoCarrera({ cargarFilas: cargarFilasAvance, obtenerEnCurso: codigosEnCursoAhora });
    rutaCurso = montarRutaCurso({
        cargarFilas: cargarFilasAvance,
        obtenerCursosDelPeriodo: cursosDelPeriodoActivo,
        obtenerEnCurso: codigosEnCursoAhora,
    });

    const herramientas = {
        meta: abrirMetaCurso,
        progreso: () => progresoCarrera.abrir(),
        ruta: () => rutaCurso.abrir(),
    };
    document.querySelectorAll('.chip-herramienta').forEach((chip) => {
        chip.addEventListener('click', () => herramientas[chip.dataset.aa]?.());
    });
    inicializarMetaCurso();
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
    restaurarNotasGuardadas(periodo);
    document.getElementById('selectorPeriodoTexto').textContent = periodo;
    document.getElementById('selectorPeriodoValor').value = periodo;
    renderizarCursos();
}

/* ============================================================
   META DEL CURSO — panel lateral (escritorio) / hoja inferior (celular),
   con el mismo diseño y textos que en SIGA producción.
   El cálculo vive en escenarios-meta.js (módulo puro, sobre las fórmulas
   de INTRALU); acá solo se arma el panel y se pinta el resultado. Usa lo
   que el alumno ve en pantalla: notas de INTRALU + las que escribió.
   ============================================================ */
let metaCursoClave = null;    // `codigo|seccion` del curso elegido en el panel
let metaValorTexto = '14';    // lo último que escribió el alumno (14 por defecto, como en SIGA)
let metaDisparador = null;    // botón que abrió el panel: recupera el foco al cerrarlo

/* Nombre legible del curso: INTRALU lo entrega en MAYÚSCULAS, sin tildes y con un guion
   al final ("ECONOMIA GENERAL-"); SIGA lo muestra como "Economía General". */
function nombreCursoLindo(curso) {
    const crudo = (curso.nombre_curso || '').replace(/-+\s*$/, '').trim();
    return crudo ? nombreLindo(crudo) : (curso.codigo_curso || '');
}

function nombreCursoMeta(curso) {
    return nombreCursoLindo(curso);
}

function inicializarMetaCurso() {
    document.getElementById('metaCerrar').addEventListener('click', cerrarMetaCurso);
    document.getElementById('metaOverlay').addEventListener('click', cerrarMetaCurso);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrarMetaCurso(); });
}

function abrirMetaCurso() {
    metaDisparador = document.activeElement;
    const cuerpo = document.getElementById('metaCuerpo');
    const cursos = [...(notasPorPeriodo[periodoActivo] || [])]
        .sort((a, b) => nombreCursoMeta(a).localeCompare(nombreCursoMeta(b), 'es'));

    if (!cursos.length) {
        cuerpo.innerHTML = '<p class="meta-vacio">Sincroniza un periodo para poder usar Meta del curso.</p>';
    } else {
        if (!cursos.some((c) => claveSimulacion(c) === metaCursoClave)) metaCursoClave = claveSimulacion(cursos[0]);
        // El cuerpo se rearma cada vez que se abre, así el selector se inicializa
        // sobre elementos nuevos (mismo criterio que producción).
        cuerpo.innerHTML = `
            <div class="meta-campo">
                <label for="metaCursoTrigger">Curso</label>
                <div class="campo-select-custom" style="width:100%;">
                    <button type="button" class="select-custom-trigger" id="metaCursoTrigger"
                        aria-haspopup="listbox" aria-expanded="false">
                        <span id="metaCursoTexto"></span>
                        <span class="select-custom-chevron" aria-hidden="true">▾</span>
                    </button>
                    <ul class="select-custom-lista" id="metaCursoLista" role="listbox" hidden></ul>
                    <input type="hidden" id="metaCursoValor">
                </div>
            </div>
            <div class="meta-campo">
                <label for="metaInput">¿Cuál es tu meta y cómo podrías alcanzarla?</label>
                <input type="number" id="metaInput" min="0" max="20" step="1" value="${escaparHtml(metaValorTexto)}">
            </div>
            <div id="metaResultado"></div>`;

        const cursoActual = cursos.find((c) => claveSimulacion(c) === metaCursoClave);
        inicializarSelectPersonalizado({
            triggerId: 'metaCursoTrigger', textoId: 'metaCursoTexto',
            listaId: 'metaCursoLista', valorId: 'metaCursoValor',
            opciones: cursos.map((c) => ({ value: claveSimulacion(c), label: escaparHtml(nombreCursoMeta(c)) })),
            alElegir: (valor) => { metaCursoClave = valor; refrescarMeta(); },
        })?.establecer(metaCursoClave, nombreCursoMeta(cursoActual));

        document.getElementById('metaInput').addEventListener('input', (e) => {
            metaValorTexto = e.target.value;
            refrescarMeta();
        });
        refrescarMeta();
    }

    document.getElementById('metaOverlay').classList.add('visible');
    const panel = document.getElementById('metaPanel');
    panel.classList.add('abierto');
    panel.removeAttribute('inert');
    panel.setAttribute('aria-hidden', 'false');
}

function cerrarMetaCurso() {
    document.getElementById('metaOverlay').classList.remove('visible');
    const panel = document.getElementById('metaPanel');
    panel.classList.remove('abierto');
    soltarFocoDe(panel, metaDisparador);
    panel.setAttribute('inert', '');
    panel.setAttribute('aria-hidden', 'true');
}

function refrescarMeta() {
    const cont = document.getElementById('metaResultado');
    if (!cont) return;

    const curso = (notasPorPeriodo[periodoActivo] || []).find((c) => claveSimulacion(c) === metaCursoClave);
    if (!curso) { cont.innerHTML = ''; return; }

    const meta = parseFloat(document.getElementById('metaInput').value);
    if (Number.isNaN(meta)) {
        cont.innerHTML = '<p class="meta-vacio">Escribe tu meta (por ejemplo 14) para ver cómo alcanzarla.</p>';
        return;
    }
    if (meta < 0 || meta > 20) {
        cont.innerHTML = '<div class="meta-inalcanzable">⚠️ Tu meta tiene que estar entre 0 y 20.</div>';
        return;
    }

    const formula = formulaDeCurso(curso);
    const grupos = {};
    const etiquetas = {};
    componentesVisibles(curso.evaluaciones).forEach((fila) => {
        grupos[fila.variable] = fila.grupo;
        etiquetas[fila.variable] = fila.label;
    });

    const resultado = generarEscenariosMeta({
        formulaPP: formula?.formula_practicas,
        formulaFinal: formula?.formula_nota_final,
        valores: valoresActualesDeCurso(curso),
        grupos,
        meta,
    });
    cont.innerHTML = htmlResultadoMeta(resultado, etiquetas);
}

/* ---------- Render (mismos textos que producción) ---------- */

function etiquetaMeta(variable, etiquetas) {
    if (['EP', 'EF', 'ES'].includes(variable)) return variable;
    if (etiquetas[variable]) return escaparHtml(etiquetas[variable]);
    const numero = variable.match(/^N(\d+)$/);
    return numero ? `PC${numero[1]}` : escaparHtml(variable);
}

function htmlValoresMeta(entradas, proyectados, etiquetas) {
    const yaCargadas = (entradas || []).map(({ variable, valor }) => `
        <div class="meta-valor meta-valor--actual" title="Ya la tienes cargada"><span>${etiquetaMeta(variable, etiquetas)} ✓</span><strong>${valor}</strong></div>`).join('');
    const proyectadas = Object.entries(proyectados || {}).map(([variable, valor]) => `
        <div class="meta-valor"><span>${etiquetaMeta(variable, etiquetas)}</span><strong>${valor}</strong></div>`).join('');
    return `<div class="meta-valores">${yaCargadas}${proyectadas}</div>`;
}

/* Solo se aclara cuando hizo falta asumir que el resto rinde bien (~15):
   con la banda conservadora (10) es el caso normal y no hay que decir más. */
function htmlNotaBandaMeta(alternativa, nombreFoco) {
    if (!alternativa || !alternativa.bandaAsumida) return '';
    return `<p class="meta-nota-banda">📌 Esto asume que tus otras evaluaciones (fuera de ${nombreFoco}) también tienen buen desempeño — la meta no depende solo de ${nombreFoco}, sino del conjunto del curso.</p>`;
}

function htmlAlternativaMeta(titulo, alternativa, entradas, nombreFoco, etiquetas) {
    return `
        <div class="meta-alternativa">
            <div class="meta-alternativa__titulo">${titulo}</div>
            ${htmlNotaBandaMeta(alternativa, nombreFoco)}
            ${htmlValoresMeta(entradas, alternativa.valores, etiquetas)}
            <div class="meta-pf">PF resultante: <strong>${alternativa.notaFinal.toFixed(1)}</strong></div>
        </div>`;
}

function htmlSeccionTipoMeta(r, nombreFoco, etiquetas) {
    if (r.sinPendientes) {
        return `<div class="meta-sin-pendientes">Ya tienes todas tus notas de ${nombreFoco} cargadas ✅</div>`;
    }
    if (!r.alta && !r.mixta) {
        return `<div class="meta-inalcanzable">⚠️ Ni siquiera asumiendo que el resto de tu curso rinde bien, esta meta es alcanzable solo con ${nombreFoco} (necesitarías más de 20).</div>`;
    }
    let html = '';
    if (r.alta) html += htmlAlternativaMeta('Alternativa alta', r.alta, r.entradas, nombreFoco, etiquetas);
    if (r.mixta) html += htmlAlternativaMeta('Alternativa mixta', r.mixta, r.entradas, nombreFoco, etiquetas);
    return html;
}

function htmlSustiMeta(s) {
    const actual = s.notaActual !== null ? s.notaActual.toFixed(1) : '—';

    if (s.yaAlcanzaMeta) {
        const conVeinte = s.notaConVeinte !== null
            ? ` Si igual quieres tomarlo para subir tu promedio: con un 20 en el susti (reemplazando tu nota más baja entre EP y EF) tu PF subiría a <strong>${s.notaConVeinte.toFixed(1)}</strong>.`
            : '';
        return `
            <div class="meta-tarjeta">
                <div class="meta-tarjeta__nombre">${s.nombre}</div>
                <div class="meta-sin-pendientes">Ya alcanzas tu meta con ${actual}, no necesitas el susti para esto ✅</div>
                <p class="meta-desc">${conVeinte}</p>
            </div>`;
    }

    const cuerpo = !s.resultado
        ? '<div class="meta-inalcanzable">⚠️ Ni con un 20 en el sustitutorio alcanzarías esta meta.</div>'
        : `
            <div class="meta-valores"><div class="meta-valor"><span>Susti</span><strong>${s.resultado.es}</strong></div></div>
            <div class="meta-pf">PF resultante: <strong>${s.resultado.notaFinal.toFixed(1)}</strong></div>`;
    return `
        <div class="meta-tarjeta">
            <div class="meta-tarjeta__nombre">${s.nombre}</div>
            <p class="meta-desc">Tu nota actual es ${actual}. Si tu curso todavía permite el sustitutorio, esto es lo que necesitarías para llegar a tu meta — reemplaza tu nota más baja entre EP y EF.</p>
            ${cuerpo}
        </div>`;
}

function htmlExamenMeta(s) {
    const minimo = s.minimo
        ? `
            <div class="meta-alternativa">
                <div class="meta-alternativa__titulo">Mínimo asequible</div>
                <p class="meta-desc">Si tu PC, LAB, Monografías y tu otro examen rinden bien.</p>
                <div class="meta-valores"><div class="meta-valor"><span>${s.foco}</span><strong>${s.minimo.valores[s.foco]}</strong></div></div>
                <div class="meta-pf">PF resultante: <strong>${s.minimo.notaFinal.toFixed(1)}</strong></div>
            </div>`
        : `
            <div class="meta-alternativa">
                <div class="meta-alternativa__titulo">Mínimo asequible</div>
                <div class="meta-inalcanzable">⚠️ Ni siquiera con todo lo demás rindiendo muy bien alcanzarías esta meta.</div>
            </div>`;
    const maximo = s.maximo
        ? `
            <div class="meta-alternativa">
                <div class="meta-alternativa__titulo">Máximo que te podría tocar</div>
                <p class="meta-desc">Si el resto de tu curso se queda solo en lo mínimo para pasar.</p>
                <div class="meta-valores"><div class="meta-valor"><span>${s.foco}</span><strong>${s.maximo.valor}</strong></div></div>
                <div class="meta-pf">PF resultante: <strong>${s.maximo.notaFinal.toFixed(1)}</strong></div>
            </div>`
        : `
            <div class="meta-alternativa">
                <div class="meta-alternativa__titulo">Máximo que te podría tocar</div>
                <div class="meta-inalcanzable">⚠️ Si el resto de tu curso se queda solo en lo mínimo, no alcanzarías esta meta ni con ${TECHO_MAXIMO_EXAMEN} en tu ${s.foco} — tus PC/LAB/Monografías también van a necesitar mejorar.</div>
            </div>`;
    return `
        <div class="meta-tarjeta">
            <div class="meta-tarjeta__nombre">${s.nombre}</div>
            ${minimo}
            ${maximo}
        </div>`;
}

function htmlLabMonoMeta(s, etiquetas) {
    if (s.noDisponible) {
        return `
            <div class="meta-tarjeta">
                <div class="meta-tarjeta__nombre">${s.nombre}</div>
                <p class="meta-no-disponible">Este curso no maneja Laboratorios ni Monografías, así que esta sección no aplica acá.</p>
            </div>`;
    }
    let contenido = '';
    if (s.lab) {
        contenido += `<div class="meta-subtitulo">Laboratorios (LAB)</div>${htmlSeccionTipoMeta(s.lab, 'LAB', etiquetas)}`;
    }
    if (s.mono) {
        contenido += '<div class="meta-subtitulo">Monografías</div>';
        if (s.mono.sinPendientes) {
            contenido += '<div class="meta-sin-pendientes">Ya tienes tus Monografías cargadas ✅</div>';
        } else if (!s.mono.alta) {
            contenido += '<div class="meta-inalcanzable">⚠️ Ni siquiera asumiendo que el resto de tu curso rinde bien, esta meta es alcanzable solo con Monografías.</div>';
        } else {
            contenido += `
                <p class="meta-desc">Referencial — la nota real depende bastante del criterio del profesor y si es grupal o individual.</p>
                ${htmlNotaBandaMeta(s.mono.alta, 'Monografías')}
                ${htmlValoresMeta(s.mono.entradas, s.mono.alta.valores, etiquetas)}
                <div class="meta-pf">PF resultante: <strong>${s.mono.alta.notaFinal.toFixed(1)}</strong></div>`;
        }
    }
    return `
        <div class="meta-tarjeta">
            <div class="meta-tarjeta__nombre">${s.nombre}</div>
            ${contenido}
        </div>`;
}

function htmlResultadoMeta(r, etiquetas) {
    if (r.tipo === 'sin-formula') {
        return '<p class="meta-vacio">INTRALU todavía no publica la fórmula de este curso. En cuanto la publique y vuelvas a sincronizar, aquí aparece tu meta.</p>';
    }
    if (r.tipo === 'error') {
        return '<div class="meta-inalcanzable">⚠️ No se pudo interpretar la fórmula de este curso.</div>';
    }
    if (r.tipo === 'completo') {
        const bloque = r.notaFinal === null ? '' : `
            <div class="meta-completo ${r.alcanzaMeta ? 'ok' : 'no'}">
                Ya tienes todas tus notas: tu PF es <strong>${r.notaFinal.toFixed(1)}</strong>.
                ${r.alcanzaMeta ? ' ✅ ¡Alcanzaste tu meta!' : ' ❌ No llegaste a la meta con estas notas.'}
            </div>`;
        return bloque + (r.seccionSusti ? htmlSustiMeta(r.seccionSusti) : '');
    }

    return r.secciones.map((s) => {
        if (s.id === 'pc') {
            return `
                <div class="meta-tarjeta">
                    <div class="meta-tarjeta__nombre">${s.nombre}</div>
                    <p class="meta-desc">${s.descripcion}</p>
                    ${htmlSeccionTipoMeta(s, 'PC', etiquetas)}
                </div>`;
        }
        if (s.id === 'labmono') return htmlLabMonoMeta(s, etiquetas);
        if (s.id === 'examen-EP' || s.id === 'examen-EF') return htmlExamenMeta(s);
        if (s.id === 'susti') return htmlSustiMeta(s);
        return '';
    }).join('');
}

/* ============================================================
   GUARDAR / LIMPIAR TODO
   Lo que el alumno escribe en las casillas (sus notas probables) se
   guarda en ESTE navegador, separado por alumno y por periodo — varios
   alumnos comparten PC en la UNI. Cada alumno se identifica por la huella
   de su CÓDIGO DE ESTUDIANTE: es estable, a diferencia del user_id, que
   cambia cada vez que se inicia sesión (sesión anónima). La huella (SHA-256)
   evita dejar el código a la vista en el nombre de la clave.

   Regla de seguridad: LO OFICIAL SIEMPRE GANA. Cada casilla guardada
   recuerda qué decía INTRALU en ese momento (`base`). Si al volver
   INTRALU dice otra cosa (por ejemplo publicó la nota real), esa casilla
   guardada se descarta sola — nunca tapa una nota oficial nueva.
   ============================================================ */
const CLAVE_ALMACEN_NOTAS = 'siga_mf_notas_guardadas_v1';

function claveAlmacenNotas() {
    return `${CLAVE_ALMACEN_NOTAS}_${claveAlmacenUsuario || usuarioActual?.id || 'anonimo'}`;
}

/* Clave estable por alumno: huella de su código de estudiante. Sin código (perfil
   incompleto) devuelve null y se usa el user_id como antes. */
async function claveDeAlmacenamiento(codigo) {
    const limpio = String(codigo || '').trim().toUpperCase();
    if (!limpio) return null;
    try {
        const bytes = new TextEncoder().encode(`siga-mf|${limpio}`);
        const huella = await crypto.subtle.digest('SHA-256', bytes);
        const hex = [...new Uint8Array(huella)].map((b) => b.toString(16).padStart(2, '0')).join('');
        return `c_${hex.slice(0, 24)}`;
    } catch {
        return `c_${limpio}`; // navegador sin crypto.subtle: se usa el código tal cual
    }
}

/* Lo guardado antes de este cambio quedó bajo el user_id de esa sesión. Si la sesión
   actual todavía tiene datos ahí, se pasan a la clave estable (sin pisar lo que ya haya). */
function migrarAlmacenAntiguo() {
    if (!usuarioActual || !claveAlmacenUsuario) return;
    const claveVieja = `${CLAVE_ALMACEN_NOTAS}_${usuarioActual.id}`;
    try {
        const viejo = JSON.parse(localStorage.getItem(claveVieja));
        if (!viejo) return;
        const actual = leerAlmacenNotas();
        Object.keys(viejo).forEach((periodo) => { if (!actual[periodo]) actual[periodo] = viejo[periodo]; });
        if (escribirAlmacenNotas(actual)) localStorage.removeItem(claveVieja);
    } catch { /* dato viejo dañado: se ignora */ }
}

function leerAlmacenNotas() {
    try {
        return JSON.parse(localStorage.getItem(claveAlmacenNotas())) || {};
    } catch {
        return {};
    }
}

/* Devuelve true si pudo escribir (puede fallar en modo privado o sin espacio). */
function escribirAlmacenNotas(almacen) {
    try {
        if (Object.keys(almacen).length) localStorage.setItem(claveAlmacenNotas(), JSON.stringify(almacen));
        else localStorage.removeItem(claveAlmacenNotas());
        return true;
    } catch {
        return false;
    }
}

/* Lo que INTRALU dice hoy de una casilla (null si todavía no hay dato). */
function valorOficial(curso, variable) {
    const valor = construirValoresFormula(curso.evaluaciones)[variable];
    return valor === undefined ? null : valor;
}

/* Pone en `valoresSimulados` lo guardado del periodo, descartando lo que
   INTRALU ya cambió. Llamar justo después de vaciar `valoresSimulados`. */
function restaurarNotasGuardadas(periodo) {
    const almacen = leerAlmacenNotas();
    const delPeriodo = almacen[periodo];
    if (!delPeriodo) return;

    const cursos = notasPorPeriodo[periodo] || [];
    let huboDescartes = false;

    Object.keys(delPeriodo).forEach((claveCurso) => {
        const curso = cursos.find((c) => claveSimulacion(c) === claveCurso);
        if (!curso) { delete delPeriodo[claveCurso]; huboDescartes = true; return; }

        const variables = delPeriodo[claveCurso];
        Object.keys(variables).forEach((variable) => {
            const guardado = variables[variable];
            if (valorOficial(curso, variable) !== guardado.base) {
                delete variables[variable];
                huboDescartes = true;
                return;
            }
            if (!valoresSimulados[claveCurso]) valoresSimulados[claveCurso] = {};
            valoresSimulados[claveCurso][variable] = guardado.v;
        });
        if (!Object.keys(variables).length) delete delPeriodo[claveCurso];
    });

    if (!Object.keys(delPeriodo).length) delete almacen[periodo];
    if (huboDescartes) escribirAlmacenNotas(almacen);
}

function inicializarGuardarLimpiar() {
    document.getElementById('btnGuardarNotas').addEventListener('click', guardarNotas);
    document.getElementById('btnLimpiarTodo').addEventListener('click', abrirModalLimpiarTodo);
    document.getElementById('btnCancelarLimpiarTodo').addEventListener('click', cerrarModalLimpiarTodo);
    document.getElementById('btnConfirmarLimpiarTodo').addEventListener('click', limpiarTodo);
}

function guardarNotas() {
    if (!periodoActivo) return;

    const delPeriodo = {};
    (notasPorPeriodo[periodoActivo] || []).forEach((curso) => {
        const claveCurso = claveSimulacion(curso);
        const escritas = valoresSimulados[claveCurso];
        if (!escritas) return;

        const guardadas = {};
        Object.keys(escritas).forEach((variable) => {
            const base = valorOficial(curso, variable);
            if (escritas[variable] === base) return; // igual a lo oficial: nada que guardar
            guardadas[variable] = { v: escritas[variable], base };
        });
        if (Object.keys(guardadas).length) delPeriodo[claveCurso] = guardadas;
    });

    const almacen = leerAlmacenNotas();
    if (Object.keys(delPeriodo).length) almacen[periodoActivo] = delPeriodo;
    else delete almacen[periodoActivo];

    const ok = escribirAlmacenNotas(almacen);
    mostrarToast(ok ? '✅ Notas guardadas correctamente' : '⚠️ No se pudo guardar en este navegador');
}

function abrirModalLimpiarTodo() {
    if (!periodoActivo) return;
    document.getElementById('modalLimpiarTodo').classList.add('visible');
}

function cerrarModalLimpiarTodo() {
    document.getElementById('modalLimpiarTodo').classList.remove('visible');
}

function limpiarTodo() {
    cerrarModalLimpiarTodo();
    if (!periodoActivo) return;

    valoresSimulados = {};
    const almacen = leerAlmacenNotas();
    delete almacen[periodoActivo];
    escribirAlmacenNotas(almacen);

    renderizarCursos();
    mostrarToast('🗑️ Notas borradas');
}

let temporizadorToast = null;
function mostrarToast(texto) {
    const toast = document.getElementById('toastNotas');
    toast.textContent = texto;
    toast.classList.add('visible');
    clearTimeout(temporizadorToast);
    temporizadorToast = setTimeout(() => toast.classList.remove('visible'), 2500);
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
        document.getElementById('accionesLista').style.display = 'none';
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

    // Si ya rindió EP y EF el curso terminó: lo que no tiene nota cuenta 0 (igual
    // que SIGA) y la nota final ya se puede mostrar, aunque falte alguna PC.
    // Mientras falte un examen no se completa nada: no hay nota final todavía.
    const { valores: paraCalcular } = conPendientesEnCero(formula.formula_practicas, formula.formula_nota_final, valores);

    let pp = null;
    try {
        pp = formula.formula_practicas ? evaluarFormula(formula.formula_practicas, paraCalcular) : null;
    } catch { pp = null; }

    let notaFinal = null;
    try {
        if (formula.formula_nota_final) {
            const conSustituto = aplicarSustitutorio({ ...paraCalcular, PP: pp });
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

/* Un periodo cerrado sí puede quedar con notas a medias: hay profesores
   que no publican todo (o publican el EF tarde). Eso NO es un error del
   alumno ni una alarma; se muestra como "En proceso" (ver estadoCurso).
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

/* ¿El curso ya tiene al menos una nota? (de INTRALU o escrita por el alumno) */
function hayAlgunaNota(curso) {
    const valores = valoresActualesDeCurso(curso);
    if (Object.values(valores).some((v) => v !== null && v !== undefined)) return true;
    return notaComoNumero(curso.promedio_practicas) !== null;
}

/* Sin nota final todavía (`notaFinal === null`) NUNCA es rojo ni "Sin datos":
     - con alguna nota ya publicada → "En proceso" (azul suave)
     - sin ninguna nota → "Pendiente" (amarillo): espera a que el profesor publique
   El rojo queda solo para desaprobado / crítico. */
function estadoCurso(notaFinal, periodoConGuion, hayNotas = false) {
    if (notaFinal === null) {
        return hayNotas
            ? { texto: 'En proceso', clase: 'badge-proceso' }
            : { texto: 'Pendiente', clase: 'badge-pendiente' };
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

    cursos.forEach((curso, idx) => {
        const { notaFinal: notaFinalCalculada } = calcularCurso(curso);
        const notaFinal = notaFinalMostrada(curso, notaFinalCalculada);
        const estado = estadoCurso(notaFinal, periodoActivo, hayAlgunaNota(curso));
        const creditos = formulaDeCurso(curso)?.creditos ?? null;

        const card = document.createElement('div');
        card.className = 'curso-card';
        card.innerHTML = `
            <div class="curso-card__promedio">
                <p class="curso-card__promedio-etiqueta">PROMEDIO</p>
                <p class="curso-card__promedio-valor">${notaFinal ?? '--'}</p>
            </div>
            <div class="curso-card__cuerpo-principal">
                <p class="curso-card__nombre">${escaparHtml(nombreCursoLindo(curso))}</p>
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

    actualizarResumenPeriodo();
    document.getElementById('accionesLista').style.display = cursos.length ? 'flex' : 'none';
}

/* Trunca (no redondea) a N decimales, como INTRALU y SIGA. El 1e-9 evita que un
   error de coma flotante (12.671 → 12.6709999…) le quite una milésima. */
function truncarDecimales(valor, decimales) {
    const f = 10 ** decimales;
    return Math.trunc(valor * f + 1e-9) / f;
}

/* Promedio ponderado del periodo (3 decimales, TRUNCADO igual que INTRALU y SIGA)
   y aviso de cursos en riesgo. Se recalcula al pintar la lista y también EN VIVO
   cada vez que el alumno escribe una nota. */
function actualizarResumenPeriodo() {
    const cursos = notasPorPeriodo[periodoActivo] || [];
    let sumaPonderada = 0, sumaCreditos = 0;
    const enRiesgo = [];

    cursos.forEach((curso) => {
        const { notaFinal: notaFinalCalculada } = calcularCurso(curso);
        const notaFinal = notaFinalMostrada(curso, notaFinalCalculada);
        const estado = estadoCurso(notaFinal, periodoActivo, hayAlgunaNota(curso));
        const creditos = formulaDeCurso(curso)?.creditos ?? null;

        if (notaFinal !== null && creditos) {
            sumaPonderada += notaFinal * creditos;
            sumaCreditos += creditos;
        }
        if (notaFinal !== null && (estado.clase === 'badge-riesgo' || estado.clase === 'badge-critico')) {
            enRiesgo.push(`${escaparHtml(nombreCursoLindo(curso))} — ${notaFinal}`);
        }
    });

    document.getElementById('promedioPonderado').textContent =
        sumaCreditos ? truncarDecimales(sumaPonderada / sumaCreditos, 3).toFixed(3) : '--';

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
    if (d.includes('LABORATORIO') || /(^|[^A-Z])LAB/.test(d)) return 'LAB';
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

const ETIQUETA_EXAMEN = { EP: 'EP', EF: 'EF', ES: 'ES' };
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
            filas.push({ variable: variableExamen, label: ETIQUETA_EXAMEN[variableExamen] || variableExamen, nota: notaComoNumero(ev.nota), camnot: null, grupo: 'EXAMEN' });
            continue;
        }
        if (ev.camnot === null || ev.camnot === undefined) continue;
        filas.push({ variable: `N${ev.camnot}`, label: etiquetaNoExamen(ev), nota: notaComoNumero(ev.nota), camnot: ev.camnot, grupo: claseEvaluacion(ev.descripcion) });
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

    // "Limpiar notas" de ESTE curso, arriba a la derecha, igual que en SIGA.
    const acciones = document.createElement('div');
    acciones.className = 'curso-card__acciones';
    acciones.innerHTML = '<button type="button" class="btn-limpiar-curso">🗑️ Limpiar notas</button>';
    acciones.querySelector('button').addEventListener('click', (e) => {
        e.stopPropagation();
        limpiarNotasDeCurso(cuerpo, curso, idx);
    });
    cuerpo.appendChild(acciones);

    // Mismo orden y columnas que SIGA producción: cada grupo en su propia
    // fila (o filas) — PC y LAB de a 4, monografías de a 2 y los exámenes
    // aparte — para que las etiquetas y casilleros queden alineados.
    const GRUPOS_COMPONENTES = [
        { id: 'PC', columnas: 4 },
        { id: 'LAB', columnas: 4 },
        { id: 'MONOGRAFIA', columnas: 2 },
        { id: 'EXAMEN', columnas: 4 },
    ];
    GRUPOS_COMPONENTES.forEach(({ id, columnas }) => {
        const filasGrupo = filas.filter((fila) => fila.grupo === id);
        if (!filasGrupo.length) return;

        const grid = document.createElement('div');
        grid.className = `grid-componentes grid-componentes--${columnas}`;
        filasGrupo.forEach((fila) => {
            const campo = document.createElement('div');
            campo.className = 'componente';
            // Si el alumno escribió (o restauramos) un valor para esta casilla,
            // manda ese; si no, la nota oficial de INTRALU.
            const simulado = valoresSimulados[claveSimulacion(curso)] || {};
            const valorInicial = fila.variable in simulado ? simulado[fila.variable] : fila.nota;
            campo.innerHTML = `
                <label>${fila.label}</label>
                <input type="number" step="0.1" min="0" max="20" value="${valorInicial ?? ''}" placeholder="--">
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
    });

    const promPC = document.createElement('p');
    promPC.className = 'prom-pc';
    cuerpo.appendChild(promPC);

    const cajaNecesito = document.createElement('div');
    cajaNecesito.className = 'caja-necesito';
    cuerpo.appendChild(cajaNecesito);

    actualizarCuerpoCurso(cuerpo, curso, idx);
}

/* Igual que en SIGA: sin confirmación, borra al instante lo que el alumno escribió en
   ESTE curso (también lo que tenía guardado de este curso) y avisa con un mensaje.
   Las notas oficiales de INTRALU no se tocan: al limpiar, vuelven a verse ellas. */
function limpiarNotasDeCurso(cuerpo, curso, idx) {
    const clave = claveSimulacion(curso);
    const habiaEscritas = !!valoresSimulados[clave] && Object.keys(valoresSimulados[clave]).length > 0;
    delete valoresSimulados[clave];

    let habiaGuardadas = false;
    const almacen = leerAlmacenNotas();
    const delPeriodo = almacen[periodoActivo];
    if (delPeriodo && delPeriodo[clave]) {
        habiaGuardadas = true;
        delete delPeriodo[clave];
        if (!Object.keys(delPeriodo).length) delete almacen[periodoActivo];
        escribirAlmacenNotas(almacen);
    }

    // Se vuelve a armar el cuerpo con lo oficial de INTRALU (casilleros, promedio y caja).
    cuerpo.innerHTML = '';
    armarCuerpoCurso(cuerpo, curso, idx);

    mostrarToast(habiaEscritas || habiaGuardadas
        ? '🗑️ Notas del curso borradas'
        : 'ℹ️ Este curso no tiene notas escritas por ti');
}

function actualizarCuerpoCurso(cuerpo, curso, idx) {
    const { pp, notaFinal: notaFinalCalculada, formula, valores } = calcularCurso(curso);
    const notaFinal = notaFinalMostrada(curso, notaFinalCalculada);

    cuerpo.querySelector('.prom-pc').innerHTML = pp !== null
        ? `Prom. PC: <strong>${truncarDecimales(pp, 3).toFixed(3)}</strong>`
        : '';

    // Actualiza también la cabecera de la card sin re-renderizar toda la lista
    const tarjeta = cuerpo.closest('.curso-card');
    const valorHeader = tarjeta?.querySelector('.curso-card__promedio-valor');
    if (valorHeader) valorHeader.textContent = notaFinal ?? '--';
    const badge = tarjeta?.querySelector('.curso-card__meta-fila .badge:last-child');
    if (badge) {
        const estado = estadoCurso(notaFinal, periodoActivo, hayAlgunaNota(curso));
        badge.textContent = estado.texto;
        badge.className = `badge ${estado.clase}`;
    }
    actualizarResumenPeriodo();

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

function filaCaja(etiqueta, valor) {
    return `<div class="caja-necesito__fila"><span class="caja-necesito__etiqueta">${etiqueta}</span><span class="caja-necesito__valor">${valor}</span></div>`;
}

/* Mismos estados y textos que la caja de SIGA producción:
   - EP y EF vacíos → sugerencias "Si sacas EP = 08: EF mínimo = X" (las 3 primeras viables)
   - solo un examen pendiente → "Para aprobar necesitas en EF mínimo: X"
   - EP y EF rendidos: aprueba → "¡Ya aprobaste con X!" (sin obligar a dar el ES);
     no llega → "Nota actual" + "Con ES necesitas mínimo: Y"
   - con el ES ya rendido → "¡Aprobaste con X!" o "Curso desaprobado con X" */
function htmlCajaNecesito(r, etiquetas) {
    const titulo = '<div class="caja-necesito__titulo">🎯 ¿QUÉ NOTA NECESITO PARA APROBAR?</div>';
    const nota = (x) => Number(x).toFixed(1);
    const alerta = (texto) => `<div class="caja-necesito__alerta">${texto}</div>`;
    let cuerpo = '';

    switch (r.tipo) {
        case 'hipotesis':
            cuerpo = r.filas.length
                ? r.filas.map((f) => filaCaja(
                    `Si sacas ${f.dado.variable} = ${String(f.dado.valor).padStart(2, '0')}:`,
                    `${r.incognita} mínimo = ${formatearMinimo(f.minimo)}`)).join('')
                : alerta('Necesitas mejorar tu Prom. PC para poder aprobar');
            break;

        case 'unico':
            if (r.estado === 'ok') cuerpo = filaCaja(`Para aprobar necesitas en ${r.incognita} mínimo:`, formatearMinimo(r.minimo));
            else if (r.estado === 'seguro') cuerpo = filaCaja(`¡Con cualquier nota en ${r.incognita} apruebas!`, '0+');
            else if (r.estado === 'imposible') cuerpo = alerta('Necesitarás el sustitutorio para aprobar');
            else cuerpo = '<p class="aviso-sin-formula">Aún faltan otros datos para calcularlo.</p>';
            break;

        case 'sustitutorio':
            cuerpo = `<div class="caja-necesito__aviso">⚠️ Nota actual: ${nota(r.notaFinal)} (desaprobado)</div>`;
            if (r.estado === 'ok') cuerpo += filaCaja('Con ES necesitas mínimo:', formatearMinimo(r.minimo));
            else if (r.estado === 'seguro') cuerpo += filaCaja('¡Con cualquier nota en ES apruebas!', '0+');
            else cuerpo += alerta('No es posible aprobar con sustitutorio');
            break;

        case 'completo':
            if (r.aprueba) {
                cuerpo = `<div class="caja-necesito__ok">✅ ¡${r.conES ? 'Aprobaste' : 'Ya aprobaste'} con ${nota(r.notaFinal)}!</div>`;
            } else if (r.conES) {
                cuerpo = `<div class="caja-necesito__mal">❌ Curso desaprobado con ${nota(r.notaFinal)}</div>`;
            } else {
                cuerpo = `<div class="caja-necesito__aviso">⚠️ Nota actual: ${nota(r.notaFinal)} (desaprobado)</div>`;
            }
            break;

        case 'faltan-datos':
        case 'error':
            cuerpo = '<p class="aviso-sin-formula">Aún faltan otros datos para calcularlo.</p>';
            break;

        default:
            return '';
    }

    // Se rotula lo que no tenía nota y hubo que contar: 10 si es una proyección,
    // 0 si el curso ya terminó (EP y EF rendidos).
    let supuestos = '';
    if (r.supuestos && r.supuestos.length) {
        const nombres = r.supuestos.map((v) => etiquetaCorta(v, etiquetas)).join(', ');
        supuestos = r.relleno === 0
            ? `<p class="caja-necesito__supuesto">Lo que aún no tiene nota cuenta como 0: ${nombres}.</p>`
            : `<p class="caja-necesito__supuesto">Asumiendo en ${r.relleno} tus notas pendientes: ${nombres}.</p>`;
    }

    return titulo + cuerpo + supuestos;
}