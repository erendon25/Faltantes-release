# Faltantes · Releases (público)

Repositorio **solo para publicar las versiones** del programa Faltantes. No contiene código fuente
ni credenciales: únicamente el número de versión y el instalable.

- **`version.txt`** → el número de la última versión disponible (ej. `1.0.0`).
- **Releases** → cada versión se publica como un *Release* con el archivo adjunto
  **`Faltantes-Delivery.zip`**.

El programa, al pulsar "Buscar actualizaciones", lee:
- la versión de: `https://raw.githubusercontent.com/<usuario>/<repo>/main/version.txt`
- el instalable de: `https://github.com/<usuario>/<repo>/releases/latest/download/Faltantes-Delivery.zip`

## Publicar una versión nueva
1. Actualiza `version.txt` con el nuevo número (debe ser mayor; ej. `1.0.1`).
2. Crea un *Release* y adjunta el zip con el nombre exacto `Faltantes-Delivery.zip`.

Ver pasos detallados en `SUBIR-A-GITHUB.txt`.
