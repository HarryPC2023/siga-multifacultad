/* ============================================================
   SIGA — bookmarklet-sync.js
   Corre INYECTADO en la pestaña de INTRALU cuando el alumno
   ejecuta el bookmarklet. Reemplaza a la extensión SIGA Conector
   para este flujo: hace los mismos fetch() reales que hacía
   intralu_content_script.js, pero sin extensión de por medio —
   al correr en el mismo origen que INTRALU, el navegador adjunta
   la cookie de sesión sola en cada fetch (sea o no HttpOnly),
   igual que si el alumno navegara la página a mano.

   Reporta el resultado a la pestaña de SIGA que lo abrió, vía
   postMessage a window.opener — nunca guarda nada en Supabase
   directamente (no tiene forma de acceder a esa sesión, es otro
   origen). SIGA es quien guarda, con su propia sesión ya activa.
   ============================================================ */
(function () {
    'use strict';

    const BASE_INTRALU = 'https://alumnos.uni.edu.pe';
    // Mismo dominio que ORIGENES_PERMITIDOS en background.js de la
    // extensión — cubre tanto producción (/portal-siga/) como el
    // sandbox (/siga-multifacultad/), que viven bajo la misma cuenta
    // de GitHub Pages.
    const ORIGEN_SIGA = 'https://harrypc2023.github.io';

    if (!window.opener) {
        alert(
            'SIGA: no se encontró la pestaña que te trajo aquí.\n\n' +
            'Este bookmarklet solo funciona si INTRALU se abrió desde el botón ' +
            '"Sincronizar" dentro de SIGA — no lo ejecutes en una pestaña de INTRALU ' +
            'que ya tenías abierta por tu cuenta.'
        );
        return;
    }

    /* ------------------------------------------------------------
       Mismas funciones de fetch que intralu_content_script.js,
       trasplantadas tal cual (misma lógica, mismos headers).
       ------------------------------------------------------------ */
    function leerXsrfDeCookie() {
        const match = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
        return match ? decodeURIComponent(match[1]) : null;
    }

    function headersIntralu() {
        const xsrf = leerXsrfDeCookie();
        const headers = { 'X-Requested-With': 'XMLHttpRequest' };
        if (xsrf) headers['X-XSRF-TOKEN'] = xsrf;
        return headers;
    }

    // Mismo regex que background.js: código-sección viene suelto en el
    // botón "Ver curso" como data-codcur / data-seccion, no hay que
    // parsear texto tipo "GE605 -V".
    function parsearListaCursos(html) {
        const cursos = [];
        const reFila = /<tr>\s*<td>[^<]*<\/td>\s*<td>([^<]+)<\/td>\s*<td>([^<]+)<\/td>[\s\S]*?data-codper=['"](\d+)['"]\s+data-codcur=['"]([^'"]+)['"]\s+data-seccion=['"]([^'"]+)['"]/g;
        let m;
        while ((m = reFila.exec(html)) !== null) {
            const [, nombreCrudo, creditosCrudo, codper, codcur, seccion] = m;
            const creditos = parseInt(creditosCrudo.trim(), 10);
            cursos.push({
                codigo: codcur.trim(),
                seccion: seccion.trim(),
                nombre: nombreCrudo.trim().replace(/-+$/, ''),
                creditos: Number.isNaN(creditos) ? null : creditos,
                codper,
            });
        }
        return cursos;
    }

    async function fetchListaCursosUnaVez(periodo) {
        const resp = await fetch(`${BASE_INTRALU}/informacion-academica/cursos/${periodo}`, {
            method: 'GET',
            credentials: 'same-origin',
            headers: headersIntralu(),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} al cargar la lista de cursos`);
        return parsearListaCursos(await resp.text());
    }

    // Mismo reintento automático que background.js: la primera petición
    // a un periodo puede devolver el que estaba activo antes, no el
    // pedido (SPA de Angular) — se reintenta una vez antes de rendirse.
    async function fetchListaCursos(periodoSolicitado) {
        let lista = await fetchListaCursosUnaVez(periodoSolicitado);
        if (lista.length && lista[0].codper !== periodoSolicitado) {
            lista = await fetchListaCursosUnaVez(periodoSolicitado);
        }
        return lista;
    }

    async function fetchNotasCurso(curso) {
        const body = new URLSearchParams({
            codper: curso.codper,
            codcur: curso.codigo,
            seccion: curso.seccion,
        });
        const resp = await fetch(`${BASE_INTRALU}/informacion-academica/cursos/notas`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                ...headersIntralu(),
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: body.toString(),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json();
    }

    function arrayBufferABase64(buffer) {
        let binario = '';
        const bytes = new Uint8Array(buffer);
        const TAMANO_BLOQUE = 0x8000;
        for (let i = 0; i < bytes.length; i += TAMANO_BLOQUE) {
            binario += String.fromCharCode.apply(null, bytes.subarray(i, i + TAMANO_BLOQUE));
        }
        return btoa(binario);
    }

    // GET simple, sin X-XSRF-TOKEN (Laravel solo lo exige en POST/PUT/DELETE).
    async function fetchAvanceCurricularPdf() {
        const resp = await fetch(`${BASE_INTRALU}/informacion-academica/avance-curricular-pdf`, {
            method: 'GET',
            credentials: 'same-origin',
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} al descargar el Avance Curricular`);
        return arrayBufferABase64(await resp.arrayBuffer());
    }

    /* ------------------------------------------------------------
       Orquestador — mismo cuerpo que sincronizarPeriodo() en
       background.js, pero sin pasar por chrome.tabs.sendMessage:
       aquí todo corre en la misma página, así que son llamadas
       directas a las funciones de arriba.
       ------------------------------------------------------------ */
    async function sincronizarPeriodo(periodoSolicitado, onProgreso) {
        const listaCursos = await fetchListaCursos(periodoSolicitado);

        if (!listaCursos.length) {
            return {
                ok: false,
                motivo: 'sin_cursos',
                detalle: 'No se encontró ningún curso matriculado en la página de INTRALU.',
            };
        }

        if (listaCursos[0].codper !== periodoSolicitado) {
            return {
                ok: false,
                motivo: 'periodo_no_coincide',
                detalle: `INTRALU sigue devolviendo datos de otro periodo (recibido: ${listaCursos[0].codper}, esperado: ${periodoSolicitado}). Espera unos segundos e intenta de nuevo.`,
            };
        }

        const cursosResultado = [];
        const errores = [];
        let codfac = null;

        for (const curso of listaCursos) {
            if (onProgreso) onProgreso(curso);
            try {
                const datos = await fetchNotasCurso(curso);
                // Mismo bug ya corregido: las evaluaciones vienen bajo
                // "data", no "evaluaciones".
                const evaluaciones = Array.isArray(datos.data) ? datos.data : [];

                if (!codfac && evaluaciones[0] && evaluaciones[0].codfac) {
                    codfac = evaluaciones[0].codfac;
                }

                cursosResultado.push({
                    codigo: curso.codigo,
                    seccion: curso.seccion,
                    nombre: curso.nombre,
                    creditos: curso.creditos,
                    formula_practicas: (datos.formulas && datos.formulas.practicas) || null,
                    formula_nota_final: (datos.formulas && datos.formulas.teoria) || null,
                    promedio_practicas: (datos.promedios && datos.promedios.promedio_practicas) || null,
                    promedio_final: (datos.promedios && datos.promedios.promedio_final) || null,
                    nota_asistencia: (datos.promedios && datos.promedios.nota_asistencia) || null,
                    evaluaciones: evaluaciones.map((ev) => ({
                        camnot: ev.camnot ?? null,
                        descripcion: ev.descripcion || null,
                        nota: ev.nota ?? null,
                        fecha_registro_acta: ev.fecha_registro_acta || null,
                        es_examen: ev.examen !== null && ev.examen !== undefined,
                    })),
                });
            } catch (e) {
                errores.push({
                    codigo: curso.codigo,
                    seccion: curso.seccion,
                    motivo: String((e && e.message) || e),
                });
            }
        }

        return {
            ok: true,
            periodo: listaCursos[0].codper,
            codfac,
            cursos: cursosResultado,
            errores,
        };
    }

    /* ------------------------------------------------------------
       Overlay visual mínimo — el alumno necesita ver que algo está
       pasando mientras la pestaña de INTRALU trabaja sola.
       ------------------------------------------------------------ */
    function crearOverlay() {
        const div = document.createElement('div');
        div.id = 'siga-bookmarklet-overlay';
        div.style.cssText = [
            'position:fixed', 'top:16px', 'right:16px', 'z-index:2147483647',
            'background:#1a1a2e', 'color:#fff', 'font-family:sans-serif',
            'font-size:14px', 'line-height:1.4', 'padding:14px 18px',
            'border-radius:10px', 'box-shadow:0 4px 16px rgba(0,0,0,.35)',
            'max-width:280px',
        ].join(';');
        div.textContent = 'SIGA: conectando...';
        document.body.appendChild(div);
        return div;
    }

    /* Le pide a SIGA (window.opener) qué periodo sincronizar, antes de
       arrancar. Si SIGA no contesta en 10s, se rinde con un mensaje
       claro — puede pasar si el alumno abrió el bookmarklet en una
       pestaña de INTRALU que no fue abierta por SIGA (o si tapó el
       postMessage con un bloqueador). */
    function pedirPeriodoASiga() {
        return new Promise((resolve) => {
            let resuelto = false;
            function onMessage(event) {
                if (event.origin !== ORIGEN_SIGA) return;
                if (!event.data || event.data.type !== 'SIGA_BM_PERIODO') return;
                resuelto = true;
                window.removeEventListener('message', onMessage);
                resolve(event.data.periodo || null);
            }
            window.addEventListener('message', onMessage);
            window.opener.postMessage({ type: 'SIGA_BM_LISTO' }, ORIGEN_SIGA);
            setTimeout(() => {
                if (resuelto) return;
                window.removeEventListener('message', onMessage);
                resolve(null);
            }, 10000);
        });
    }

    function reportarResultado(payload) {
        window.opener.postMessage({ type: 'SIGA_BM_RESULTADO', ...payload }, ORIGEN_SIGA);
    }

    async function iniciar() {
        const overlay = crearOverlay();

        overlay.textContent = 'SIGA: esperando datos de sincronización...';
        const periodo = await pedirPeriodoASiga();

        if (!periodo) {
            overlay.textContent = '⚠️ SIGA no respondió. Cierra esta pestaña e inténtalo de nuevo desde el botón Sincronizar.';
            overlay.style.background = '#7a1f1f';
            return;
        }

        try {
            overlay.textContent = `Sincronizando ${periodo}...`;
            const resultadoNotas = await sincronizarPeriodo(periodo, (curso) => {
                overlay.textContent = `Sincronizando ${periodo}: ${curso.codigo}...`;
            });

            overlay.textContent = 'Descargando tu Avance Curricular...';
            let avanceCurricularBase64 = null;
            let avanceCurricularError = null;
            try {
                avanceCurricularBase64 = await fetchAvanceCurricularPdf();
            } catch (e) {
                // No abortamos todo el sync por esto — las notas ya se
                // trajeron bien; el Avance Curricular puede reintentarse
                // aparte más adelante si hiciera falta.
                avanceCurricularError = String((e && e.message) || e);
            }

            overlay.textContent = 'Enviando resultado a SIGA...';
            reportarResultado({ notas: resultadoNotas, avanceCurricularBase64, avanceCurricularError });

            overlay.textContent = '✅ Listo. Ya puedes volver a la pestaña de SIGA.';
            overlay.style.background = '#1f7a3f';
        } catch (e) {
            const detalle = String((e && e.message) || e);
            overlay.textContent = `⚠️ Error: ${detalle}`;
            overlay.style.background = '#7a1f1f';
            reportarResultado({
                notas: { ok: false, motivo: 'error_inesperado', detalle },
                avanceCurricularBase64: null,
                avanceCurricularError: null,
            });
        }
    }

    iniciar();
})();
