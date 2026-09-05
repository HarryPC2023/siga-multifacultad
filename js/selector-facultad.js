// js/selector-facultad.js
import { FACULTADES } from "./facultades-datos.js";

const CLAVE_SESSION = "siga_multifacultad_seleccion";

function crearIconoChevron() {
  return `<svg class="tarjeta-facultad__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
}

function crearTarjetaHTML(facultad) {
  const esCarreraUnica = facultad.carreras.length === 1;

  const chipsCarreras = facultad.carreras
    .map(
      (c) =>
        `<button type="button" class="chip-carrera" data-facultad="${facultad.id}" data-carrera="${c.id}">${c.nombre}</button>`
    )
    .join("");

  // Colapsada: solo ícono + sigla, siempre — incluidas las facultades de
  // carrera única (FIC), que nunca pasan por un estado expandido. El
  // nombre completo y las carreras solo aparecen al expandir.
  return `
    <div class="tarjeta-facultad" style="--color-facultad:${facultad.color};--color-chips:${facultad.colorAcento || facultad.color}" data-facultad-id="${facultad.id}" data-carrera-unica="${esCarreraUnica}" role="button" tabindex="0" aria-expanded="false">
      <div class="tarjeta-facultad__cabecera">
        <img class="tarjeta-facultad__icono" src="${facultad.icono}" alt="Ícono de ${facultad.sigla}" loading="lazy">
        <p class="tarjeta-facultad__sigla">${facultad.sigla}</p>
        ${esCarreraUnica ? "" : crearIconoChevron()}
      </div>
      ${esCarreraUnica
      ? ""
      : `<div class="tarjeta-facultad__detalle">
               <p class="tarjeta-facultad__nombre">${facultad.nombre}</p>
               <div class="tarjeta-facultad__carreras">${chipsCarreras}</div>
             </div>`
    }
    </div>
  `;
}

function alternarExpansion(tarjeta) {
  const yaExpandida = tarjeta.classList.contains("expandida");

  // Solo una tarjeta expandida a la vez: colapsa cualquier otra abierta
  // antes de expandir la nueva, para que el acordeón no crezca sin control.
  document.querySelectorAll(".tarjeta-facultad.expandida").forEach((t) => {
    if (t !== tarjeta) {
      t.classList.remove("expandida");
      t.setAttribute("aria-expanded", "false");
    }
  });

  tarjeta.classList.toggle("expandida", !yaExpandida);
  tarjeta.setAttribute("aria-expanded", String(!yaExpandida));
}

function manejarSeleccionCarrera(facultadId, carreraId) {
  const facultad = FACULTADES.find((f) => f.id === facultadId);
  const carrera = facultad?.carreras.find((c) => c.id === carreraId);
  if (!facultad || !carrera) return;

  // Guardamos la selección para que la pantalla de login/sync sepa qué
  // facultad+carrera eligió el alumno sin tener que volver a preguntarle.
  sessionStorage.setItem(
    CLAVE_SESSION,
    JSON.stringify({ facultadId: facultad.id, carreraId: carrera.id })
  );

  // Ya existe la pantalla de login/sync — saltamos directo, sin el aviso
  // temporal de antes (que era solo un stub mientras no existía nada más).
  window.location.href = "login.html";
}

export function inicializarSelectorFacultades(contenedorId = "gridFacultades") {
  const contenedor = document.getElementById(contenedorId);
  if (!contenedor) return;

  contenedor.innerHTML = FACULTADES.map(crearTarjetaHTML).join("");

  contenedor.addEventListener("click", (evento) => {
    const chip = evento.target.closest(".chip-carrera");
    if (chip) {
      manejarSeleccionCarrera(chip.dataset.facultad, chip.dataset.carrera);
      return;
    }

    const tarjeta = evento.target.closest(".tarjeta-facultad");
    if (!tarjeta) return;

    const esCarreraUnica = tarjeta.dataset.carreraUnica === "true";
    if (esCarreraUnica) {
      const facultad = FACULTADES.find((f) => f.id === tarjeta.dataset.facultadId);
      manejarSeleccionCarrera(facultad.id, facultad.carreras[0].id);
      return;
    }

    alternarExpansion(tarjeta);
  });

  // Soporte de teclado (Enter/Espacio) para accesibilidad, ya que las
  // tarjetas usan role="button" en vez de <button> nativo (por el layout).
  contenedor.addEventListener("keydown", (evento) => {
    if (evento.key !== "Enter" && evento.key !== " ") return;
    const tarjeta = evento.target.closest(".tarjeta-facultad");
    if (!tarjeta) return;
    evento.preventDefault();
    tarjeta.click();
  });
}