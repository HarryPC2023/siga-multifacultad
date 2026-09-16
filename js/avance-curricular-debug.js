// js/avance-curricular-debug.js — herramienta temporal para validar la
// extracción de texto del Avance Curricular ANTES de escribir el parser
// real. No guarda nada en Supabase, no toca ninguna tabla — solo pide el
// PDF, lo pasa por pdf.js, y muestra el texto crudo en pantalla.

import * as pdfjsLib from '../vendor-pdfjs/pdf.min.mjs';
import { parsearAvanceCurricular } from './avance-curricular-parser.js';
import { guardarAvanceCurricular } from './avance-curricular-guardar.js';
import { obtenerSesion } from './auth-siga.js';

pdfjsLib.GlobalWorkerOptions.workerSrc =
    new URL('../vendor-pdfjs/pdf.worker.min.mjs', import.meta.url).href;

const btnProbar = document.getElementById('btnProbar');
const btnCopiar = document.getElementById('btnCopiar');
const estado = document.getElementById('estado');
const salida = document.getElementById('salida');

function mostrarEstado(texto, esError = false) {
    estado.textContent = texto;
    estado.className = esError ? 'error' : '';
}

// Mismo patrón que login-multifacultad.js: postMessage hacia el content
// script de la extensión, que reenvía a background.js y devuelve la
// respuesta por otro postMessage.
function pedirAvanceCurricularExtension(timeoutMs = 60000) {
    return new Promise((resolve) => {
        let resuelto = false;
        function onMessage(event) {
            if (event.source !== window || event.data?.type !== 'SIGA_EXT_AVANCE_CURRICULAR_RESULT') return;
            resuelto = true;
            window.removeEventListener('message', onMessage);
            resolve(event.data);
        }
        window.addEventListener('message', onMessage);
        window.postMessage({ type: 'SIGA_EXT_REQUEST_AVANCE_CURRICULAR' }, window.location.origin);
        setTimeout(() => {
            if (resuelto) return;
            window.removeEventListener('message', onMessage);
            resolve({ ok: false, motivo: 'timeout', detalle: 'La extensión no respondió a tiempo.' });
        }, timeoutMs);
    });
}

function base64AArrayBuffer(base64) {
    const binario = atob(base64);
    const bytes = new Uint8Array(binario.length);
    for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
    return bytes;
}

async function extraerTextoPdf(bytes) {
    const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
    let textoCompleto = '';
    for (let numPagina = 1; numPagina <= doc.numPages; numPagina++) {
        const pagina = await doc.getPage(numPagina);
        const contenido = await pagina.getTextContent();
        const lineaPagina = contenido.items.map((item) => item.str).join(' ');
        textoCompleto += `\n\n===== PÁGINA ${numPagina} =====\n\n${lineaPagina}`;
    }
    return textoCompleto;
}

btnProbar.addEventListener('click', async () => {
    btnProbar.disabled = true;
    btnCopiar.style.display = 'none';
    salida.textContent = '';
    mostrarEstado('Verificando tu sesión de SIGA...');

    const sesion = await obtenerSesion();
    if (!sesion) {
        mostrarEstado('No hay sesión de SIGA activa — inicia sesión primero en login.html (con Google) y vuelve a esta página.', true);
        btnProbar.disabled = false;
        return;
    }

    mostrarEstado('Pidiéndole el PDF a la extensión...');

    const resultado = await pedirAvanceCurricularExtension();
    if (!resultado.ok) {
        mostrarEstado(`Error: ${resultado.detalle || resultado.motivo}`, true);
        btnProbar.disabled = false;
        return;
    }

    mostrarEstado('PDF recibido, extrayendo texto con pdf.js...');
    try {
        const bytes = base64AArrayBuffer(resultado.base64);
        const texto = await extraerTextoPdf(bytes);
        const estructurado = parsearAvanceCurricular(texto);

        const resumenCiclos = estructurado.ciclos
            .map((c) => `Ciclo ${c.numero}: ${c.cursos.length} cursos`)
            .join('\n');

        mostrarEstado('Texto parseado, guardando en avance_curricular...');
        const resultadoGuardado = await guardarAvanceCurricular(sesion.user.id, estructurado);

        salida.textContent =
            `===== RESULTADO DEL GUARDADO =====\n${JSON.stringify(resultadoGuardado, null, 2)}\n\n` +
            `===== ENCABEZADO =====\n${JSON.stringify({
                facultad: estructurado.facultad,
                especialidad: estructurado.especialidad,
                planEstudio: estructurado.planEstudio,
                cicloRelativo: estructurado.cicloRelativo,
            }, null, 2)}\n\n` +
            `===== RESUMEN =====\n${resumenCiclos}\n` +
            `Electivos: ${estructurado.electivos.length}\n` +
            `Electivos complementarios: ${estructurado.electivosComplementarios.length}\n\n` +
            `===== JSON COMPLETO =====\n${JSON.stringify(estructurado, null, 2)}\n\n` +
            `===== TEXTO CRUDO (pdf.js) =====\n${texto}`;

        mostrarEstado(
            resultadoGuardado.ok
                ? `Listo — ${resultadoGuardado.cursosGuardados} cursos guardados en avance_curricular (${resultadoGuardado.facultad} / ${resultadoGuardado.carrera}).`
                : `Se parseó bien, pero el guardado falló: ${resultadoGuardado.detalle || resultadoGuardado.motivo}`,
            !resultadoGuardado.ok
        );
        btnCopiar.style.display = 'inline-block';
    } catch (e) {
        mostrarEstado(`Error al procesar el PDF: ${e.message || e}`, true);
    }
    btnProbar.disabled = false;
});

btnCopiar.addEventListener('click', async () => {
    await navigator.clipboard.writeText(salida.textContent);
    btnCopiar.textContent = '✅ Copiado';
    setTimeout(() => { btnCopiar.textContent = '📋 Copiar todo el texto'; }, 1500);
});