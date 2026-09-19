// ruta-curso-ui.js — Panel de "Ruta del Curso" para el sandbox multifacultad.
// Mismo diseño y textos que en SIGA producción: eliges un curso de tu periodo y ves
// qué necesitas para llevarlo y la cadena de lo que se abre al aprobarlo (con un nivel
// más cuando hay una sola rama). A diferencia de producción, no depende de una malla
// hecha a mano: usa el Avance Curricular del alumno (progreso-carrera.js), así que
// sirve para cualquier facultad y carrera, y también cubre los electivos.
//
// Es autocontenido: crea su propio DOM al abrirse por primera vez. Estilos en
// css/ruta-curso.css. Los datos se los da quien lo monta:
//   montarRutaCurso({ cargarFilas, obtenerCursosDelPeriodo, obtenerEnCurso })
//     cargarFilas():              async → filas de la tabla avance_curricular
//     obtenerCursosDelPeriodo():  → [{ codigo, nombre }] de los cursos en pantalla
//     obtenerEnCurso():           → códigos de curso que el alumno lleva ahora (opcional)
import { construirProgresoCarrera, datosRutaCurso } from './progreso-carrera.js';
import { nombreLindo, escaparHtml, soltarFocoDe } from './progreso-carrera-ui.js';

const ETIQUETA_CATEGORIA = { electivo: ' · Electivo', electivo_complementario: ' · Electivo complementario' };

/* ---------- HTML del resultado (función pura, fácil de probar) ---------- */
export function htmlRutaCurso(d) {
    const nombre = (texto) => escaparHtml(nombreLindo(texto));
    const categoria = (cat) => ETIQUETA_CATEGORIA[cat] || '';

    let notaHtml = '';
    if (d.estado === 'aprobado' && d.nota !== null) {
        notaHtml = `<p class="rc-detalle">Nota: <strong>${Number(d.nota).toFixed(1)}</strong>${d.veces > 1 ? ` · lo llevaste ${d.veces} veces` : ''}</p>`;
    } else if (d.jalado && d.nota !== null) {
        notaHtml = `<p class="rc-detalle rc-detalle--jalado">Desaprobado con <strong>${Number(d.nota).toFixed(1)}</strong> — puedes volver a llevarlo.</p>`;
    }
    const inferidoHtml = d.inferido
        ? '<p class="rc-detalle rc-detalle--inferido">Sin nota registrada en tu Avance — se infiere aprobado porque es prerrequisito de algo que sí llevas.</p>'
        : '';

    // "Necesitas" solo aporta algo si el curso todavía no está aprobado ni en curso.
    let necesitaHtml = '';
    if (d.estado !== 'aprobado' && d.estado !== 'en_curso') {
        necesitaHtml = d.necesita.length
            ? `
        <div class="rc-tarjeta">
            <div class="rc-tarjeta-nombre">Necesitas</div>
            ${d.necesita.map((n) => `
                <p class="rc-tarjeta-desc">${n.cumplido ? '✓' : '○'} ${escaparHtml(n.code)}${n.name ? ' · ' + nombre(n.name) : ''}${n.enCurso ? ' <em>(en curso)</em>' : ''}${n.fueraDelPlan ? ' <em>(no está en tu plan)</em>' : ''}</p>`).join('')}
        </div>`
            : `
        <div class="rc-tarjeta">
            <div class="rc-tarjeta-nombre">Necesitas</div>
            <p class="rc-tarjeta-desc">✓ Este curso no tiene prerrequisitos.</p>
        </div>`;
    }

    // Cada nivel de la cadena tiene su propio contenedor y color (lo que se abre directo
    // vs. lo que eso abre después), unidos por una flecha, para que no parezca que todo
    // se abre a la vez.
    function renderDesbloquea(lista, nivel) {
        if (!lista.length) return '<p class="rc-tarjeta-desc">Es el último de su línea por ahora.</p>';
        const clase = nivel === 1 ? 'rc-nodo-directo' : 'rc-nodo-siguiente';
        return lista.map((c) => `
            <div class="rc-flecha">↓ se abre al aprobarlo</div>
            <div class="rc-nodo ${clase}">
                <div class="rc-nodo-nombre">${escaparHtml(c.code)} · ${nombre(c.name)}</div>
                <p class="rc-nodo-creditos">${c.credits} créditos${categoria(c.categoria)}${c.faltan.length ? ' · te falta también ' + c.faltan.map(escaparHtml).join(', ') : ''}</p>
            </div>
            ${c.nietos.length ? `
                <p class="rc-nota">Si apruebas ${escaparHtml(c.code)}, se abre el curso de abajo:</p>
                ${renderDesbloquea(c.nietos, nivel + 1)}` : ''}`).join('');
    }

    return `
        <div class="rc-nodo rc-nodo-actual">
            <div class="rc-nodo-nombre">${escaparHtml(d.code)} · ${nombre(d.name)}</div>
            <p class="rc-nodo-creditos">${d.credits} créditos${categoria(d.categoria)}</p>
            <span class="rc-estado rc-estado-${d.estado}">${d.estadoLabel}</span>
        </div>
        ${notaHtml}
        ${inferidoHtml}
        ${necesitaHtml}
        ${renderDesbloquea(d.desbloquea, 1)}`;
}

const MENSAJE_SIN_AVANCE = `
    <p class="rc-mensaje">Todavía no tenemos tu Avance Curricular.<br>
    Vuelve a sincronizar con INTRALU (<strong>← Sincronizar otro periodo</strong>) y tu ruta aparecerá acá.</p>`;
const MENSAJE_SIN_CURSOS = `
    <p class="rc-mensaje">No hay cursos de este periodo para mostrar.<br>
    Sincroniza tus notas para ver la ruta de prerrequisitos de tus cursos.</p>`;
const MENSAJE_ERROR = `
    <p class="rc-mensaje">No pudimos leer tu Avance Curricular en este momento.<br>
    Revisa tu conexión y vuelve a intentarlo.</p>`;

/* ---------- Montaje en la página ---------- */
export function montarRutaCurso({ cargarFilas, obtenerCursosDelPeriodo, obtenerEnCurso = () => [] }) {
    let progreso = null;
    let seleccionado = null;
    let montado = false;
    let disparador = null;   // botón que abrió el panel: recupera el foco al cerrarlo

    const $ = (id) => document.getElementById(id);

    function montar() {
        if (montado) return;
        document.body.insertAdjacentHTML('beforeend', `
            <div id="rc-overlay" class="rc-overlay"></div>
            <aside id="rc-panel" class="rc-panel" aria-hidden="true" aria-label="Ruta del curso" inert>
                <div class="rc-cabecera">
                    <div class="rc-titulo-grupo">
                        <span class="rc-icono">🔗</span>
                        <div class="rc-titulo">Ruta del curso</div>
                    </div>
                    <button type="button" class="rc-cerrar" id="rc-cerrar" aria-label="Cerrar">✕</button>
                </div>
                <div class="rc-cuerpo" id="rc-cuerpo"></div>
            </aside>`);
        $('rc-overlay').addEventListener('click', cerrar);
        $('rc-cerrar').addEventListener('click', cerrar);
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrar(); });
        montado = true;
    }

    function cursosDisponibles() {
        // Los cursos del periodo que están en tu plan. Si alguno no aparece en el Avance
        // (por ejemplo una convalidación), se omite sin romper nada.
        return obtenerCursosDelPeriodo()
            .filter((c) => progreso.porCodigo[c.codigo])
            .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    }

    async function abrir() {
        disparador = document.activeElement;
        montar();
        $('rc-overlay').classList.add('rc-visible');
        $('rc-panel').classList.add('rc-abierto');
        $('rc-panel').removeAttribute('inert');
        $('rc-panel').setAttribute('aria-hidden', 'false');

        const cuerpo = $('rc-cuerpo');
        cuerpo.innerHTML = '<p class="rc-mensaje">Cargando tu avance…</p>';
        try {
            const filas = await cargarFilas();
            if (!filas || !filas.length) { cuerpo.innerHTML = MENSAJE_SIN_AVANCE; return; }
            progreso = construirProgresoCarrera(filas, { enCurso: obtenerEnCurso() });

            const cursos = cursosDisponibles();
            if (!cursos.length) { cuerpo.innerHTML = MENSAJE_SIN_CURSOS; return; }
            if (!cursos.some((c) => c.codigo === seleccionado)) seleccionado = cursos[0].codigo;
            const actual = cursos.find((c) => c.codigo === seleccionado);

            // El cuerpo se rearma cada vez que se abre, así el selector se inicializa
            // sobre elementos nuevos (mismo criterio que Meta del curso).
            cuerpo.innerHTML = `
                <div class="rc-campo">
                    <label for="rcCursoTrigger">Curso</label>
                    <div class="campo-select-custom" style="width:100%;">
                        <button type="button" class="select-custom-trigger" id="rcCursoTrigger"
                            aria-haspopup="listbox" aria-expanded="false">
                            <span id="rcCursoTexto"></span>
                            <span class="select-custom-chevron" aria-hidden="true">▾</span>
                        </button>
                        <ul class="select-custom-lista" id="rcCursoLista" role="listbox" hidden></ul>
                        <input type="hidden" id="rcCursoValor">
                    </div>
                </div>
                <div id="rc-resultado"></div>`;

            inicializarSelectPersonalizado({
                triggerId: 'rcCursoTrigger', textoId: 'rcCursoTexto',
                listaId: 'rcCursoLista', valorId: 'rcCursoValor',
                opciones: cursos.map((c) => ({ value: c.codigo, label: `${escaparHtml(c.codigo)} · ${escaparHtml(c.nombre)}` })),
                alElegir: (valor) => { seleccionado = valor; refrescar(); },
            })?.establecer(seleccionado, `${actual.codigo} · ${actual.nombre}`);

            refrescar();
        } catch (error) {
            console.error('Ruta del Curso:', error);
            cuerpo.innerHTML = MENSAJE_ERROR;
        }
    }

    function refrescar() {
        const contenedor = $('rc-resultado');
        if (!contenedor || !progreso) return;
        const datos = datosRutaCurso(progreso, seleccionado);
        contenedor.innerHTML = datos ? htmlRutaCurso(datos) : '';
    }

    function cerrar() {
        if (!montado) return;
        $('rc-overlay').classList.remove('rc-visible');
        $('rc-panel').classList.remove('rc-abierto');
        soltarFocoDe($('rc-panel'), disparador);
        $('rc-panel').setAttribute('inert', '');
        $('rc-panel').setAttribute('aria-hidden', 'true');
    }

    return { abrir, cerrar };
}