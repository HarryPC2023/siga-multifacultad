// SIGA — motor único de temas (Entrega 1)
// ------------------------------------------------------------
// Reemplaza a tema-horarios.js. Un solo localStorage, un solo
// mecanismo (atributo data-tema en <html>), un solo widget
// (.tema-selector) que ahora vive en el nav global (nav.html),
// no en franjas propias de cada módulo.
//
// Intranotas NO se toca acá: sigue con su propio sistema
// (body.tema-*, claves 'intranotas_tema') hasta la Entrega 2,
// que lo migra a este mismo motor.
(function () {
    const LS_TEMA = 'siga_tema';
    // Claves de motores viejos: si el usuario ya había elegido un
    // tono con el sistema anterior de Horarios, lo adoptamos una
    // sola vez para que no "pierda" su preferencia.
    const CLAVES_VIEJAS = ['horarioGen_tema'];
    const TEMA_POR_DEFECTO = 'claro';

    const TEMAS = [
        { id: 'claro', etiqueta: 'Claro', icono: '☀️' },
        { id: 'oscuro', etiqueta: 'Oscuro', icono: '🌙' },
        { id: 'ocean', etiqueta: 'Ocean', icono: '🌊' },
        { id: 'forest', etiqueta: 'Forest', icono: '🌲' },
    ];

    function temaGuardado() {
        try {
            const propio = localStorage.getItem(LS_TEMA);
            if (propio) return propio;

            for (const clave of CLAVES_VIEJAS) {
                const viejo = localStorage.getItem(clave);
                if (viejo) return viejo;
            }
            return TEMA_POR_DEFECTO;
        } catch (e) {
            return TEMA_POR_DEFECTO;
        }
    }

    function aplicarTema(id) {
        if (!TEMAS.some((t) => t.id === id)) id = TEMA_POR_DEFECTO;

        document.documentElement.setAttribute('data-tema', id);
        try {
            localStorage.setItem(LS_TEMA, id);
        } catch (e) {
            // Navegación privada u otro bloqueo: el tema igual se aplica,
            // solo no persiste entre pantallas/sesiones.
        }

        document.querySelectorAll('.tema-opcion').forEach((op) => {
            op.classList.toggle('activo', op.dataset.tema === id);
        });

        const meta = TEMAS.find((t) => t.id === id);
        if (meta) {
            document.querySelectorAll('.tema-boton-icono').forEach((ic) => {
                ic.textContent = meta.icono;
            });
        }
    }

    function inicializarSelector() {
        document.querySelectorAll('.tema-selector').forEach((selector) => {
            const boton = selector.querySelector('.tema-boton');
            const menu = selector.querySelector('.tema-menu');
            if (!boton || !menu) return;

            boton.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const abierto = menu.classList.toggle('abierto');
                boton.setAttribute('aria-expanded', abierto ? 'true' : 'false');
            });

            menu.querySelectorAll('.tema-opcion').forEach((op) => {
                op.addEventListener('click', () => {
                    aplicarTema(op.dataset.tema);
                    menu.classList.remove('abierto');
                    boton.setAttribute('aria-expanded', 'false');
                });
            });
        });

        document.addEventListener('click', () => {
            document.querySelectorAll('.tema-menu.abierto').forEach((m) => m.classList.remove('abierto'));
        });

        document.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape') {
                document.querySelectorAll('.tema-menu.abierto').forEach((m) => m.classList.remove('abierto'));
            }
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        aplicarTema(temaGuardado());
        inicializarSelector();
    });
})();