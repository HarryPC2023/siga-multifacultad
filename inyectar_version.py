#!/usr/bin/env python3
"""
Recorre todo el sitio ya compilado por Jekyll (carpeta _site) e inyecta
un parámetro ?v=<hash-del-commit> en:

1. Referencias a .css/.js dentro de atributos href="" / src="" del HTML.
2. Imports de módulos ES dentro de archivos .js
   (ej. import { x } from './auth-siga.js?v=9';)

En ambos casos, si ya existe un ?v=N manual, se REEMPLAZA por el hash
nuevo (no se duplica). No toca URLs externas (http://, https://, //cdn...).
"""
import os
import re
import sys

# 1) href="....css" / src="....js" en HTML (comillas simples o dobles)
PATRON_HTML = re.compile(
    r'(href|src)=(["\'])((?!https?://|//)[^"\']+?\.(?:css|js))(\?[^"\']*)?\2'
)

# 2) import ... from '....js' (o dynamic import('....js')) dentro de .js
PATRON_JS_IMPORT = re.compile(
    r'((?:from|import)\s*\(?\s*)(["\'])((?!https?://|//)[^"\']+?\.js)(\?[^"\']*)?(\2\)?)'
)


def _reemplazar_html(m: re.Match, version: str) -> str:
    atributo, comilla, ruta, _query_vieja = m.groups()
    return f'{atributo}={comilla}{ruta}?v={version}{comilla}'


def _reemplazar_js(m: re.Match, version: str) -> str:
    prefijo, comilla, ruta, _query_vieja, cierre = m.groups()
    return f'{prefijo}{comilla}{ruta}?v={version}{cierre}'


def inyectar(site_dir: str, version: str) -> tuple[int, int]:
    total_archivos = 0
    total_reemplazos = 0

    for raiz, _dirs, archivos in os.walk(site_dir):
        for nombre in archivos:
            if not (nombre.endswith(".html") or nombre.endswith(".js")):
                continue

            ruta_archivo = os.path.join(raiz, nombre)
            with open(ruta_archivo, encoding="utf-8") as f:
                contenido = f.read()

            # Se aplican ambos patrones siempre: un HTML puede tener tanto
            # href="/src="  como un <script type="module"> inline con imports
            # (ej. index.html de Horarios), y un .js puede tener imports.
            contenido, n1 = PATRON_HTML.subn(
                lambda m: _reemplazar_html(m, version), contenido
            )
            contenido, n2 = PATRON_JS_IMPORT.subn(
                lambda m: _reemplazar_js(m, version), contenido
            )
            n = n1 + n2

            if n:
                with open(ruta_archivo, "w", encoding="utf-8") as f:
                    f.write(contenido)
                total_archivos += 1
                total_reemplazos += n

    return total_archivos, total_reemplazos


def main():
    if len(sys.argv) < 2:
        print("Uso: inyectar_version.py <carpeta_site> [version]")
        sys.exit(1)

    site_dir = sys.argv[1]
    version = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("GITHUB_SHA", "dev")[:7]

    archivos, reemplazos = inyectar(site_dir, version)
    print(f"Listo: {reemplazos} referencias actualizadas en {archivos} archivos HTML (versión {version}).")


if __name__ == "__main__":
    main()