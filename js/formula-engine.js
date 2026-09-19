// formula-engine.js — Motor genérico para las fórmulas crudas que Intralú
// expone por curso ("Fórmula de Prácticas" y "Fórmula Nota Final"), ej:
//   "(N1 + N2 + N4 + N5 + N6 -MIN( N1, N2, N3, N4))/5"
//   "( PP + EP + 2.EF )/ 4"
//
// A diferencia de calcularPFCompleto() de producción (que depende de un
// catálogo manual formula_type por curso, solo armado para FIIS), esto
// interpreta la fórmula tal cual la entrega Intralú — funciona para
// cualquier curso de cualquier facultad, sin clasificar nada a mano.
//
// Soporta: +, -, *, /, paréntesis, MIN(a, b, ...), variables (N1, N2,
// PP, EP, EF, ES...), y la notación "2.EF" de Intralú como "2 por EF"
// (no como el decimal 2.0).

function normalizarFormula(raw) {
    // "2.EF" -> "2*EF" (coeficiente por variable). Ojo: NO toca "0.5"
    // (decimal real), porque ahí lo que sigue al punto es un dígito,
    // no una letra. (Ya NO insertamos "*" entre dígito y letra sueltos:
    // eso destrozaba "K2MIN" convirtiéndolo en "K2*MIN".)
    return String(raw).replace(/(\d+)\.(?=[A-Za-z])/g, '$1*');
}

function tokenizar(expr) {
    const tokens = [];
    // OJO con el orden: "K\d+MIN" debe probarse ANTES que el patrón
    // genérico de identificador, si no "K2MIN" se parte en "K2" + "MIN".
    const re = /\s*(K\d+MIN|MIN|[A-Za-z]+\d*|\d+(?:\.\d+)?|[()+\-*/,])\s*/g;
    let m;
    let pos = 0;
    while (pos < expr.length) {
        re.lastIndex = pos;
        m = re.exec(expr);
        if (!m || m.index !== pos) throw new Error(`No se pudo interpretar la fórmula cerca de: "${expr.slice(pos)}"`);
        tokens.push(m[1]);
        pos = re.lastIndex;
    }
    return tokens;
}

// Recursive descent: expresion -> termino (('+'|'-') termino)*
//                     termino  -> factor (('*'|'/') factor)*
//                     factor   -> numero | variable | MIN(args) | '(' expresion ')' | '-' factor
function crearParser(tokens, valores) {
    let i = 0;
    const ver = () => tokens[i];
    const tomar = () => tokens[i++];

    function factor() {
        const t = ver();
        if (t === '-') { tomar(); const v = factor(); return v === null ? null : -v; }
        if (t === '(') {
            tomar();
            const v = expresion();
            if (ver() !== ')') throw new Error("Falta un paréntesis de cierre en la fórmula.");
            tomar();
            return v;
        }
        if (t === 'MIN' || /^K\d+MIN$/.test(t)) {
            tomar();
            const esKMin = t !== 'MIN';
            const n = esKMin ? parseInt(t.match(/^K(\d+)MIN$/)[1], 10) : 1;
            if (tomar() !== '(') throw new Error(`${t}( mal formado en la fórmula.`);
            const args = [expresion()];
            while (ver() === ',') { tomar(); args.push(expresion()); }
            if (tomar() !== ')') throw new Error(`Falta cerrar ${t}(...) en la fórmula.`);
            if (args.some((a) => a === null)) return null; // falta algún dato aún
            const ordenados = [...args].sort((a, b) => a - b);
            // MIN normal = el más bajo (equivale a K1MIN). KnMIN = SUMA de
            // los n valores más bajos (así lo define Intralú: con 8 notas
            // de laboratorio y K2MIN, descarta las 2 peores sumándolas
            // para restarlas, no promedia ni toma una sola).
            return ordenados.slice(0, n).reduce((acc, v) => acc + v, 0);
        }
        if (/^\d/.test(t)) { tomar(); return parseFloat(t); }
        if (/^[A-Za-z]/.test(t)) {
            tomar();
            if (!(t in valores)) throw new Error(`La fórmula usa "${t}", pero no sé qué es esa variable.`);
            return valores[t]; // puede ser null: significa "todavía no hay ese dato"
        }
        throw new Error(`Token inesperado en la fórmula: "${t}"`);
    }

    function termino() {
        let v = factor();
        while (ver() === '*' || ver() === '/') {
            const op = tomar();
            const d = factor();
            if (v === null || d === null) { v = null; continue; }
            v = op === '*' ? v * d : v / d;
        }
        return v;
    }

    function expresion() {
        let v = termino();
        while (ver() === '+' || ver() === '-') {
            const op = tomar();
            const d = termino();
            if (v === null || d === null) { v = null; continue; }
            v = op === '+' ? v + d : v - d;
        }
        return v;
    }

    return { expresion, terminado: () => i >= tokens.length };
}

/* INTRALU nunca menciona el ES en el texto de la fórmula, pero SIEMPRE
   reemplaza al menor entre EP y EF si el alumno rindió el sustitutorio
   — es una regla no escrita, no algo que la fórmula exprese. Se aplica
   solo antes de evaluar la Nota Final, nunca afecta el cálculo de PP. */
function aplicarSustitutorio(valores) {
    if (valores.ES === null || valores.ES === undefined) return valores;
    const candidatos = ['EP', 'EF'].filter((k) => k in valores && valores[k] !== null && valores[k] !== undefined);
    if (!candidatos.length) return valores;
    const menor = candidatos.reduce((a, b) => (valores[a] <= valores[b] ? a : b));
    return { ...valores, [menor]: valores.ES };
}

/* INTRALU trunca a 1 decimal (no redondea) el resultado final — un
   9.861 calculado da 9.8, no 9.9. Confirmado contra un caso real. */
function truncarNota(valor) {
    return valor === null ? null : Math.floor(valor * 10) / 10;
}

/* Evalúa una fórmula cruda de Intralú con los valores disponibles.
   `valores` es un objeto ej. { N1: 17, N2: 18, N3: null, PP: 14.2, EP: 12 }.
   Si falta algún valor necesario, devuelve null (no "adivina" nada).
   Devuelve el valor completo sin redondear — quien llama decide cuándo
   truncar (la Nota Final se trunca, valores intermedios como PP no
   tienen por qué). */
function evaluarFormula(raw, valores) {
    const normalizada = normalizarFormula(raw);
    const tokens = tokenizar(normalizada);
    const parser = crearParser(tokens, valores);
    const resultado = parser.expresion();
    if (!parser.terminado()) throw new Error("Sobraron símbolos al final de la fórmula.");
    return resultado;
}

/* "¿Qué nota necesito?" — en vez de resolver la fórmula algebraicamente,
   prueba valores del EF (o ES) por búsqueda binaria hasta encontrar el
   mínimo que hace que la Nota Final llegue al umbral de aprobar. Funciona
   con CUALQUIER fórmula cruda, porque solo la evalúa, no la interpreta. */
function calcularNotaMinimaNecesaria({ formulaPP, formulaFinal, valoresBase, variableIncognita, umbral = 9.5 }) {
    function notaFinalCon(valorIncognita) {
        const valoresConIncognita = { ...valoresBase, [variableIncognita]: valorIncognita };
        const pp = formulaPP ? evaluarFormula(formulaPP, valoresConIncognita) : valoresBase.PP;
        const conSustituto = aplicarSustitutorio({ ...valoresConIncognita, PP: pp });
        const notaFinal = evaluarFormula(formulaFinal, conSustituto);
        return notaFinal === null ? null : truncarNota(notaFinal);
    }

    const notaCon20 = notaFinalCon(20);
    if (notaCon20 === null) return { posible: null, mensaje: 'Aún faltan datos para calcularlo.' };
    if (notaCon20 < umbral) return { posible: false, notaMaximaPosible: notaCon20 };

    let lo = 0, hi = 20;
    for (let iter = 0; iter < 40; iter++) {
        const mid = (lo + hi) / 2;
        const nota = notaFinalCon(mid);
        if (nota >= umbral) hi = mid; else lo = mid;
    }
    return { posible: true, notaMinima: Math.ceil(hi * 100 - 1e-6) / 100 };
}

export { evaluarFormula, calcularNotaMinimaNecesaria, normalizarFormula, aplicarSustitutorio, truncarNota };