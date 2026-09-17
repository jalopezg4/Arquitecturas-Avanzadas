# Plan de trabajo — orden y reparto

## Reparto entre los 3 (≈42 pts c/u)

| Persona | Dominio | Historias |
|---|---|---|
| Julián | Identidad + Interoperabilidad + Seguridad | HU-01, HU-02, HU-11, HU-05a, HU-05b, HU-05c, HT-04, HT-07, HT-01 |
| Jennifer | Documentos | HU-03, HU-08, HU-09, HU-10, HU-06.1, HU-06.2, HT-02 |
| Tomás | Autenticación + Compartición + Premium/Analítica | HU-04, HU-06.3, HU-06.4, HU-07.1, HU-07.2, HU-07.3, HT-03, HT-05, HT-06 |

`HT-08` (CI/CD) es transversal, hacerlo entre los 3 al principio.

## Oleadas de dependencias (dentro de cada oleada se puede paralelizar)

**Oleada 0 — Infraestructura (día 1, en paralelo, no bloquea negocio)**
HT-08 (CI/CD) · HT-07 (secretos/TLS) · HT-06 (trazabilidad) · HT-01 (health checks) · HT-04 (bitácora auditoría)

**Oleada 1 — Bloqueante de negocio**
HU-11 (registro del operador en MinTIC) — nada de GovCarpeta real funciona sin esto.

**Oleada 2 — Identidad (secuencial)**
HU-01 (registro) → HU-02 (login)

**Oleada 3 — Entrega 2 restante (secuencial, depende de Oleada 2)**
HU-03 (carga documento) → HU-04 (autenticar documento)

*Con esto se cierra la Entrega 2. Camino crítico: `HU-11 ∥ (HU-01→HU-02)` → `HU-03` → `HU-04`.*

**Oleada 4 — Extensiones documentales (paralelas entre sí)**
HU-08 (consulta) · HU-09 (descarga) · HU-10 (recepción por entidad emisora)

**Oleada 5 — Interoperabilidad**
HU-05a (independiente, puede arrancar temprano) → HU-05b (necesita HU-11) → HU-05c (necesita 05a+05b+HU-01)

**Oleada 6 — Compartición**
HU-06.1 (independiente) · HU-06.3 (necesita HU-02, en paralelo con 06.1)
→ HU-06.2 (necesita 06.1+HU-08) · HU-06.4 (necesita HU-03+06.3)

**Oleada 7 — Premium/Analítica**
HU-07.1, 07.2, 07.3 — sin dependencias fuertes, prioridad baja.

**Oleada 8 — Verificación tardía (necesitan sistema real corriendo)**
HT-02 (backup/restore) · HT-03 (capacidad) · HT-05 (pruebas de contrato, necesita HU-05c)

## Estado actual

- [x] Oleada 0 — estructura de repo y docs creada; CI/CD real pendiente
- [ ] HU-11 — pendiente
- [x] HU-01 — en progreso
- [ ] Resto — por hacer, seguir este orden
