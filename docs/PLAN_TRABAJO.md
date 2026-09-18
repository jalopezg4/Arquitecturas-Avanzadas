# Plan de Trabajo — Distribución de Historias de Usuario

## Modelo de ejecución

El trabajo se organiza en **fases secuenciales** (relevo), no en asignación 100% paralela. Cada fase agrupa un conjunto de historias que puede completarse sin depender de historias asignadas a una fase posterior. Al cierre de una fase, la siguiente puede iniciar utilizando lo ya construido, sin bloqueos.

## Estado de Oleada 0 (Infraestructura)

| Historia | Puntos | Estado |
|---|---|---|
| HT-01 — Health checks | 3 | ✅ Completado (`/health`, `/ready` en `ms-identidad`) |
| HT-08 — CI/CD | 5 | ✅ Completado (workflow de GitHub Actions activo, PR #73) |
| HT-07 — Secretos/TLS | 3 | 🟡 Parcial (implementado solo el manejo de `JWT_SECRET`) |
| HT-04 — Bitácora de auditoría | 3 | ❌ Pendiente |
| HT-06 — Trazabilidad distribuida | 5 | ❌ Pendiente |

**Subtotal Oleada 0: 19 puntos** (11 pendientes: HT-04, HT-06, HT-07 resto).

## Fase 1 — Responsable: Jennifer Andrea López Gómez

Completa la Oleada 0, cierra la ruta crítica de Entrega 2 (HU-02, HU-03) y adelanta el inicio de interoperabilidad y documentos.

| # | Historia | Puntos | Dependencia |
|---|---|---|---|
| 1 | HT-04 — Bitácora de auditoría | 3 | Ninguna |
| 2 | HT-06 — Trazabilidad distribuida | 5 | Ninguna |
| 3 | HT-07 (resto) — Secretos/TLS completo | 3 | Ninguna |
| 4 | HU-11 — Registro del operador en MinTIC | 2 | Ninguna |
| 5 | HU-02 — Login | 5 | HU-01 (completada) |
| 6 | HU-03 — Carga de documento | 8 | HU-02 (Fase 1) |
| 7 | HU-05a — Localización de operadores | 3 | Ninguna |
| 8 | HU-05b — Publicación de endpoint de transferencia | 2 | HU-11 (Fase 1) |
| 9 | HU-06.1 — Registro de entidad institucional | 5 | Ninguna |
| 10 | HU-08 — Consulta de documentos | 5 | HU-02, HU-03 (Fase 1) |

**Total Fase 1: 41 puntos.**

## Fase 2 — Responsable: Julián Giraldo Chica

Requiere la Fase 1 completada.

| # | Historia | Puntos | Dependencia |
|---|---|---|---|
| 1 | HU-07.1, HU-07.2, HU-07.3 — Servicios Premium/Analítica | 8 | Ninguna |
| 2 | HT-02 — Respaldo y restauración verificada | 5 | Ninguna |
| 3 | HT-03 — Pruebas de capacidad | 5 | Ninguna |
| 4 | HU-10 — Recepción de documento por entidad emisora | 8 | HU-01 (completada) |
| 5 | HU-06.3 — Solicitud y autorización de envío | 8 | HU-02 (Fase 1) |

**Total Fase 2: 34 puntos.**

## Fase 3 — Responsable: Tomás Echavarría Gil

Requiere las Fases 1 y 2 completadas.

| # | Historia | Puntos | Dependencia |
|---|---|---|---|
| 1 | HU-04 — Autenticación de documento vía GovCarpeta | 8 | HU-03 (Fase 1), HU-11 (Fase 1) |
| 2 | HU-05c — Transferencia con saga de dos fases | 8 | HU-05a, HU-05b (Fase 1) |
| 3 | HU-09 — Descarga de documentos | 3 | HU-02 (Fase 1), HU-04 (Fase 3) |
| 4 | HU-06.2 — Paquete documental y entrega | 8 | HU-06.1, HU-08 (Fase 1) |
| 5 | HU-06.4 — Solicitud de documento definitivo | 5 | HU-03 (Fase 1), HU-06.3 (Fase 2) |
| 6 | HT-05 — Suite de pruebas de contrato de interoperabilidad | 5 | HU-05c (Fase 3) |

**Total Fase 3: 37 puntos.**

## Resumen de puntos

| Fase | Responsable | Puntos |
|---|---|---|
| 1 | Jennifer Andrea López Gómez | 41 |
| 2 | Julián Giraldo Chica | 34 |
| 3 | Tomás Echavarría Gil | 37 |
| **Total pendiente** | | **112** |

Puntos ya completados (HU-01, HT-01, HT-08): 21. **Total del proyecto: 133 puntos.**

## Regla de ejecución

Antes de iniciar una fase, verificar en GitHub que las historias listadas como dependencia estén cerradas y mergeadas. Las historias marcadas con dependencia "Ninguna" pueden adelantarse en cualquier momento, incluso antes del inicio formal de su fase asignada, sin afectar el orden general.
