// progreso-carrera-ui.js — Ventana de "Progreso de tu carrera" para el sandbox
// multifacultad. Mismo diseño e interacción que en SIGA producción (mapa por
// ciclos, modo enfoque con líneas de conexión y panel de detalle), pero
// alimentado por el Avance Curricular del propio alumno (progreso-carrera.js),
// así que funciona para cualquier facultad y carrera. Además del mapa de
// obligatorios, muestra debajo los electivos y los electivos complementarios.
//
// Es autocontenido: crea su propio DOM al abrirse por primera vez. Estilos en
// css/progreso-carrera.css. Los datos se los da quien lo monta:
//   montarProgresoCarrera({ cargarFilas, obtenerEnCurso })
//     cargarFilas():    async → filas de la tabla avance_curricular
//     obtenerEnCurso(): → códigos de curso que el alumno lleva ahora (opcional)
import { construirProgresoCarrera, datosRutaCurso } from './progreso-carrera.js';

const ROMANOS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/* Antes de esconder un panel (aria-hidden / inert) el foco tiene que salir de él; si no,
   el navegador avisa "Blocked aria-hidden on an element because its descendant retained
   focus". Se devuelve al botón que lo abrió (o se suelta si ya no existe). */
export function soltarFocoDe(panel, disparador) {
    const activo = document.activeElement;
    if (!activo || !panel.contains(activo)) return;
    if (disparador && disparador.isConnected && typeof disparador.focus === 'function') disparador.focus();
    else activo.blur();
}

export function escaparHtml(texto) {
    return String(texto ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- Nombres legibles ----------
   El Avance trae los nombres en MAYÚSCULAS, sin tildes y a veces cortados. Se
   pasan a "Título" y se restauran las tildes de las palabras más comunes de los
   planes de la UNI (lista cerrada: si una palabra no está, se deja como viene). */
const MINUSCULAS = new Set(['a', 'al', 'de', 'del', 'e', 'en', 'el', 'la', 'las', 'los', 'o', 'u', 'y', 'para', 'con', 'por', 'un', 'una']);
const SIGLAS = new Set(['SW', 'TI', 'PC', 'UNI']);
const ROMANO = /^(I|II|III|IV|V|VI|VII|VIII|IX|X)$/;
const CON_TILDE = {
    INGENIERIA: 'Ingeniería', FISICA: 'Física', MATEMATICA: 'Matemática', ESTADISTICA: 'Estadística', ALGEBRA: 'Álgebra',
    CALCULO: 'Cálculo', QUIMICA: 'Química', ETICA: 'Ética', PSICOLOGIA: 'Psicología', SISTEMICA: 'Sistémica',
    SISTEMICO: 'Sistémico', ANALISIS: 'Análisis', ANALITICA: 'Analítica', ANALITICOS: 'Analíticos', METODOLOGIA: 'Metodología',
    TEORIA: 'Teoría', ECONOMIA: 'Economía', ECONOMICA: 'Económica', GEOMETRIA: 'Geometría', PRACTICAS: 'Prácticas',
    PROBABILISTICOS: 'Probabilísticos', DINAMICA: 'Dinámica', BIOLOGICOS: 'Biológicos', ECOLOGICOS: 'Ecológicos',
    AUDITORIA: 'Auditoría', SEMIOTICA: 'Semiótica', CIBERNETICA: 'Cibernética', TECNOLOGICA: 'Tecnológica',
    PARAMETRICO: 'Paramétrico', ELECTRONICO: 'Electrónico', ELECTRONICOS: 'Electrónicos', ESTRATEGICA: 'Estratégica',
    GRAFICO: 'Gráfico', ICONOGRAFICO: 'Iconográfico', MOVILES: 'Móviles', NUMERICO: 'Numérico', POLITICA: 'Política',
    FILOSOFIA: 'Filosofía', SOCIOLOGIA: 'Sociología', GESTION: 'Gestión', ALGORITMIA: 'Algoritmia', TECNICA: 'Técnica',
    INFORMATICA: 'Informática', ARQUITECTURA: 'Arquitectura', CIBERSEGURIDAD: 'Ciberseguridad',
};

export function nombreLindo(texto) {
    if (!texto) return '';
    let indice = 0;
    return String(texto).trim().replace(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+/g, (palabra) => {
        const mayus = palabra.toUpperCase();
        const primera = indice === 0;
        indice += 1;
        if (ROMANO.test(mayus) || SIGLAS.has(mayus)) return mayus;
        if (CON_TILDE[mayus]) return CON_TILDE[mayus];
        const minus = palabra.toLowerCase();
        if (minus.length > 4 && minus.endsWith('cion')) return capitalizar(minus.slice(0, -4) + 'ción', true);
        if (minus.length > 4 && minus.endsWith('sion')) return capitalizar(minus.slice(0, -4) + 'sión', true);
        if (!primera && MINUSCULAS.has(minus)) return minus;
        return capitalizar(minus, true);
    });
}

function capitalizar(palabra, conMayuscula) {
    return conMayuscula ? palabra.charAt(0).toUpperCase() + palabra.slice(1) : palabra;
}

/* ---------- HTML del mapa (funciones puras, fáciles de probar) ---------- */

function htmlChip(curso) {
    const candado = curso.estado === 'bloqueado' ? '<span class="pc-chip-candado" aria-hidden="true">🔒</span>' : '';
    const clases = `pc-chip pc-estado-${curso.estado}${curso.jalado ? ' pc-jalado' : ''}`;
    return `<button type="button" class="${clases}" data-code="${escaparHtml(curso.codigo)}" title="${escaparHtml(nombreLindo(curso.nombre))}">${candado}${curso.inferido ? '~' : ''}${escaparHtml(curso.codigo)}</button>`;
}

function htmlBloque(titulo, detalle, lista) {
    if (!lista.length) return '';
    return `
        <div class="pc-bloque">
            <div class="pc-bloque-titulo">${titulo} <span class="pc-bloque-detalle">${detalle}</span></div>
            <div class="pc-ciclo-cursos">${lista.map(htmlChip).join('')}</div>
        </div>`;
}

export function htmlEstadisticas(progreso) {
    const { obligatorios, electivos, complementarios, porcentajeObligatorios } = progreso.resumen;
    return `
        <div class="pc-stats">
            <div class="pc-stat">
                <p class="pc-stat-label">Créditos obligatorios</p>
                <p class="pc-stat-valor">${obligatorios.creditosAprobados} <span class="pc-stat-de">/ ${obligatorios.creditosTotal} · ${porcentajeObligatorios}%</span></p>
            </div>
        </div>
        <p class="pc-stats-extra">Electivos aprobados: ${electivos.cursosAprobados} de ${electivos.cursosTotal} · Complementarios aprobados: ${complementarios.cursosAprobados} de ${complementarios.cursosTotal}</p>`;
}

export function htmlMapa(progreso) {
    const ciclos = progreso.ciclos.map(({ numero, cursos }) => `
        <div class="pc-ciclo">
            <div class="pc-ciclo-label">Ciclo ${ROMANOS[numero - 1] || numero}</div>
            <div class="pc-ciclo-cursos">${cursos.map(htmlChip).join('')}</div>
        </div>`).join('');
    const { electivos, complementarios } = progreso.resumen;
    return ciclos
        + htmlBloque('Electivos', `${electivos.cursosAprobados} de ${electivos.cursosTotal} aprobados`, progreso.electivos)
        + htmlBloque('Electivos complementarios', `${complementarios.cursosAprobados} de ${complementarios.cursosTotal} aprobados`, progreso.complementarios);
}

const LEYENDA = `
    <div class="pc-leyenda">
        <span><i class="pc-dot pc-estado-aprobado"></i> Aprobado</span>
        <span><i class="pc-dot pc-estado-en_curso"></i> En curso</span>
        <span><i class="pc-dot pc-estado-proximo"></i> Se abre pronto</span>
        <span><i class="pc-dot pc-estado-disponible"></i> Disponible</span>
        <span>🔒 Bloqueado</span>
    </div>
    <p class="pc-toque-aviso">👆 Toca cualquier curso del mapa para ver sus prerrequisitos y lo que desbloquea. Tócalo de nuevo para cerrar.</p>`;

export function htmlDetalle(progreso, codigo) {
    const d = datosRutaCurso(progreso, codigo);
    if (!d) return '';

    const donde = d.categoria === 'obligatorio'
        ? `Ciclo ${ROMANOS[d.ciclo - 1] || d.ciclo}`
        : (d.categoria === 'electivo' ? 'Electivo' : 'Electivo complementario');

    let notaHtml = '';
    if (d.estado === 'aprobado' && d.nota !== null) {
        notaHtml = `<p class="pc-detalle-nota">Nota: <strong>${Number(d.nota).toFixed(1)}</strong>${d.veces > 1 ? ` · lo llevaste ${d.veces} veces` : ''}</p>`;
    } else if (d.jalado && d.nota !== null) {
        notaHtml = `<p class="pc-detalle-nota pc-detalle-nota--jalado">Desaprobado con <strong>${Number(d.nota).toFixed(1)}</strong> — puedes volver a llevarlo.</p>`;
    }

    const necesitaHtml = d.necesita.length ? `
        <div class="pc-detalle-seccion">
            <p class="pc-detalle-seccion-titulo">Necesitas</p>
            ${d.necesita.map((n) => `<div class="pc-req-item">${n.cumplido ? '✓' : '○'} ${escaparHtml(n.code)}${n.name ? ' · ' + escaparHtml(nombreLindo(n.name)) : ''}${n.enCurso ? ' <em>(en curso)</em>' : ''}${n.fueraDelPlan ? ' <em>(no está en tu plan)</em>' : ''}</div>`).join('')}
        </div>` : '';

    function listaDesbloquea(lista, nivel) {
        if (!lista.length) return nivel === 0 ? '<p class="pc-req-item">Es el último de su línea por ahora.</p>' : '';
        return lista.map((c) => {
            const falta = c.faltan.length ? ` · te falta también ${c.faltan.join(', ')}` : '';
            return `
                <div class="pc-desbloquea-item">
                    <div><strong>${escaparHtml(c.code)}</strong> · ${escaparHtml(nombreLindo(c.name))} · ${c.credits} créditos${falta}</div>
                    ${c.nietos.length ? `<div class="pc-desbloquea-nivel2">${listaDesbloquea(c.nietos, 1)}</div>` : ''}
                </div>`;
        }).join('');
    }

    return `
        <div class="pc-detalle-header">
            <span class="pc-detalle-codigo">${escaparHtml(d.code)}</span> · ${escaparHtml(nombreLindo(d.name))}
            <span class="pc-detalle-estado pc-estado-${d.estado}">${d.estadoLabel}</span>
        </div>
        <p class="pc-detalle-creditos">${d.credits} créditos · ${donde}</p>
        ${notaHtml}
        ${d.inferido ? '<p class="pc-detalle-inferido">Sin nota registrada en tu Avance — se infiere aprobado porque es prerrequisito de algo que sí llevas.</p>' : ''}
        ${necesitaHtml}
        <div class="pc-detalle-seccion">
            <p class="pc-detalle-seccion-titulo">Se abre al aprobarlo</p>
            ${listaDesbloquea(d.desbloquea, 0)}
        </div>`;
}

const MENSAJE_SIN_AVANCE = `
    <p class="pc-mensaje">Todavía no tenemos tu Avance Curricular.<br>
    Vuelve a sincronizar con INTRALU (<strong>← Sincronizar otro periodo</strong>) y tu mapa aparecerá acá.</p>`;
const MENSAJE_ERROR = `
    <p class="pc-mensaje">No pudimos leer tu Avance Curricular en este momento.<br>
    Revisa tu conexión y vuelve a intentarlo.</p>`;

/* ---------- Montaje en la página ---------- */
export function montarProgresoCarrera({ cargarFilas, obtenerEnCurso = () => [] }) {
    let progreso = null;
    let seleccionado = null;
    let montado = false;
    let disparador = null;   // botón que abrió la ventana: recupera el foco al cerrarla

    const $ = (id) => document.getElementById(id);

    function montar() {
        if (montado) return;
        document.body.insertAdjacentHTML('beforeend', `
            <div id="pc-overlay" class="pc-overlay"></div>
            <div id="pc-modal" class="pc-modal" role="dialog" aria-label="Progreso de tu carrera" aria-hidden="true" inert>
                <div class="pc-modal-header">
                    <span class="pc-modal-titulo">🗺️ Progreso de tu carrera</span>
                    <button type="button" class="pc-cerrar" id="pc-cerrar" aria-label="Cerrar">✕</button>
                </div>
                <div class="pc-modal-body" id="pc-body"></div>
            </div>`);

        $('pc-overlay').addEventListener('click', cerrar);
        $('pc-cerrar').addEventListener('click', cerrar);
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrar(); });
        $('pc-body').addEventListener('click', (e) => {
            const chip = e.target.closest('.pc-chip');
            if (chip) seleccionar(chip.dataset.code);
        });
        window.addEventListener('resize', () => {
            if (seleccionado && $('pc-modal').classList.contains('pc-visible')) dibujarConexiones();
        });
        montado = true;
    }

    async function abrir() {
        disparador = document.activeElement;
        montar();
        seleccionado = null;
        $('pc-overlay').classList.add('pc-visible');
        $('pc-modal').classList.add('pc-visible');
        $('pc-modal').removeAttribute('inert');
        $('pc-modal').setAttribute('aria-hidden', 'false');

        const cuerpo = $('pc-body');
        cuerpo.innerHTML = '<p class="pc-mensaje">Cargando tu avance…</p>';
        try {
            const filas = await cargarFilas();
            if (!filas || !filas.length) { cuerpo.innerHTML = MENSAJE_SIN_AVANCE; return; }
            progreso = construirProgresoCarrera(filas, { enCurso: obtenerEnCurso() });
            renderizar();
        } catch (error) {
            console.error('Progreso de tu carrera:', error);
            cuerpo.innerHTML = MENSAJE_ERROR;
        }
    }

    function cerrar() {
        if (!montado) return;
        $('pc-overlay').classList.remove('pc-visible');
        $('pc-modal').classList.remove('pc-visible');
        soltarFocoDe($('pc-modal'), disparador);
        $('pc-modal').setAttribute('inert', '');
        $('pc-modal').setAttribute('aria-hidden', 'true');
    }

    function renderizar() {
        $('pc-body').innerHTML = `
            ${htmlEstadisticas(progreso)}
            ${LEYENDA}
            <div class="pc-mapa-wrap">
                <svg id="pc-svg" class="pc-svg-conexiones"></svg>
                <div class="pc-mapa" id="pc-mapa">${htmlMapa(progreso)}</div>
            </div>
            <div class="pc-detalle" id="pc-detalle"></div>`;
    }

    function deseleccionar() {
        seleccionado = null;
        document.querySelectorAll('#pc-mapa .pc-chip').forEach((chip) => chip.classList.remove('pc-atenuado', 'pc-seleccionado'));
        const svg = $('pc-svg');
        if (svg) svg.innerHTML = '';
        const detalle = $('pc-detalle');
        if (detalle) detalle.innerHTML = '';
    }

    function relacionadosDe(codigo) {
        const curso = progreso.porCodigo[codigo];
        const desbloquea = progreso.cursos.filter((c) => c.prereq.some((p) => p.code === codigo)).map((c) => c.codigo);
        return new Set([...curso.prereq.map((p) => p.code), ...desbloquea].filter((c) => progreso.porCodigo[c]));
    }

    function seleccionar(codigo) {
        if (!progreso || !progreso.porCodigo[codigo]) return;
        if (seleccionado === codigo) { deseleccionar(); return; }
        seleccionado = codigo;

        // Modo enfoque: atenúa todo salvo el curso y los que se relacionan con él.
        const visibles = new Set([codigo, ...relacionadosDe(codigo)]);
        document.querySelectorAll('#pc-mapa .pc-chip').forEach((chip) => {
            chip.classList.toggle('pc-atenuado', !visibles.has(chip.dataset.code));
            chip.classList.toggle('pc-seleccionado', chip.dataset.code === codigo);
        });

        dibujarConexiones();
        const detalle = $('pc-detalle');
        detalle.innerHTML = htmlDetalle(progreso, codigo);
        if (detalle.scrollIntoView) detalle.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function dibujarConexiones() {
        const svg = $('pc-svg');
        const cont = $('pc-mapa');
        if (!svg || !cont || !seleccionado) return;

        svg.setAttribute('width', cont.scrollWidth);
        svg.setAttribute('height', cont.scrollHeight);
        svg.innerHTML = '';

        const rectCont = cont.getBoundingClientRect();
        const centro = (el) => {
            const r = el.getBoundingClientRect();
            return { x: r.left - rectCont.left + r.width / 2, y: r.top - rectCont.top + r.height / 2 };
        };
        const chipSel = cont.querySelector(`[data-code="${seleccionado}"]`);
        if (!chipSel) return;
        const p0 = centro(chipSel);

        relacionadosDe(seleccionado).forEach((codigo) => {
            const chip = cont.querySelector(`[data-code="${codigo}"]`);
            if (!chip) return;
            const p1 = centro(chip);
            const linea = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            linea.setAttribute('x1', p0.x); linea.setAttribute('y1', p0.y);
            linea.setAttribute('x2', p1.x); linea.setAttribute('y2', p1.y);
            linea.setAttribute('class', 'pc-linea');
            svg.appendChild(linea);
        });
    }

    return { abrir, cerrar, obtenerProgreso: () => progreso };
}