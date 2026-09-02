// js/facultades-datos.js
// Datos de las 11 facultades de la UNI para el selector de siga-multifacultad.
//
// `color` es el color REAL extraído del círculo de cada ícono PNG (no
// inventado a mano) — así el borde de la tarjeta siempre hace juego con
// su propio ícono, sin desajustes.
//
// `carreras` con un solo elemento = facultad de carrera única (FIC):
// el selector las trata distinto, saltándose el paso del acordeón y yendo
// directo al siguiente paso al tocar la tarjeta.

export const FACULTADES = [
  {
    id: "faua",
    sigla: "FAUA",
    nombre: "Facultad de Arquitectura, Urbanismo y Artes",
    color: "#FE9B01",
    icono: "assets/facultades/faua.png",
    carreras: [
      { id: "arquitectura", nombre: "Arquitectura" },
      { id: "urbanismo-artes", nombre: "Urbanismo y Artes" },
    ],
  },
  {
    id: "fc",
    sigla: "FC",
    nombre: "Facultad de Ciencias",
    color: "#460194",
    icono: "assets/facultades/fc.png",
    carreras: [
      { id: "ing-fisica", nombre: "Ingeniería Física" },
      { id: "fisica", nombre: "Física" },
      { id: "quimica", nombre: "Química" },
      { id: "matematicas", nombre: "Matemáticas" },
      { id: "ciencias-computacion", nombre: "Ciencias de la Computación" },
    ],
  },
  {
    id: "fia",
    sigla: "FIA",
    nombre: "Facultad de Ingeniería Ambiental",
    color: "#036E03",
    icono: "assets/facultades/fia.png",
    carreras: [
      { id: "sanitaria", nombre: "Ingeniería Sanitaria" },
      { id: "higiene-seguridad", nombre: "Higiene y Seguridad Industrial" },
      { id: "ambiental", nombre: "Ingeniería Ambiental" },
    ],
  },
  {
    id: "fic",
    sigla: "FIC",
    nombre: "Facultad de Ingeniería Civil",
    color: "#FE3E01",
    icono: "assets/facultades/fic.png",
    carreras: [{ id: "civil", nombre: "Ingeniería Civil" }],
  },
  {
    id: "fiee",
    sigla: "FIEE",
    nombre: "Facultad de Ingeniería Eléctrica y Electrónica",
    color: "#FEB000",
    icono: "assets/facultades/fiee.png",
    carreras: [
      { id: "electrica", nombre: "Ingeniería Eléctrica" },
      { id: "electronica", nombre: "Ingeniería Electrónica" },
      { id: "telecomunicaciones", nombre: "Ingeniería de Telecomunicaciones" },
    ],
  },
  {
    id: "fieecs",
    sigla: "FIEECS",
    nombre: "Facultad de Ingeniería Económica, Estadística y Ciencias Sociales",
    color: "#F80267",
    icono: "assets/facultades/fieecs.png",
    carreras: [
      { id: "economica", nombre: "Ingeniería Económica" },
      { id: "estadistica", nombre: "Ingeniería Estadística" },
    ],
  },
  {
    id: "figmm",
    sigla: "FIGMM",
    nombre: "Facultad de Ingeniería Geológica, Minera y Metalúrgica",
    color: "#782E02",
    icono: "assets/facultades/figmm.png",
    carreras: [
      { id: "minas", nombre: "Ingeniería de Minas" },
      { id: "geologia", nombre: "Ingeniería Geológica" },
      { id: "metalurgia", nombre: "Ingeniería Metalúrgica" },
    ],
  },
  {
    id: "fiis",
    sigla: "FIIS",
    nombre: "Facultad de Ingeniería Industrial y de Sistemas",
    color: "#09234A",
    icono: "assets/facultades/fiis.png",
    carreras: [
      { id: "industrial", nombre: "Ingeniería Industrial" },
      { id: "sistemas", nombre: "Ingeniería de Sistemas" },
      { id: "ia", nombre: "Ingeniería de Inteligencia Artificial" },
      { id: "software", nombre: "Ingeniería de Software" },
    ],
  },
  {
    id: "fim",
    sigla: "FIM",
    nombre: "Facultad de Ingeniería Mecánica",
    color: "#01A9BA",
    icono: "assets/facultades/fim.png",
    carreras: [
      { id: "mecanica", nombre: "Ingeniería Mecánica" },
      { id: "mecanica-electrica", nombre: "Ingeniería Mecánica-Eléctrica" },
      { id: "mecatronica", nombre: "Ingeniería Mecatrónica" },
      { id: "naval", nombre: "Ingeniería Naval" },
    ],
  },
  {
    id: "fip",
    sigla: "FIP",
    nombre: "Facultad de Ingeniería de Petróleo, Gas Natural y Petroquímica",
    color: "#FD5C03",
    icono: "assets/facultades/fip.png",
    carreras: [
      { id: "petroleo-gas", nombre: "Ingeniería de Petróleo y Gas Natural" },
      { id: "petroquimica", nombre: "Ingeniería Petroquímica" },
    ],
  },
  {
    id: "fiqt",
    sigla: "FIQT",
    nombre: "Facultad de Ingeniería Química y Textil",
    color: "#017D80",
    icono: "assets/facultades/fiqt.png",
    carreras: [
      { id: "quimica-ing", nombre: "Ingeniería Química" },
      { id: "textil", nombre: "Ingeniería Textil" },
    ],
  },
];