# Plan de trabajo — orden y reparto final

Formato: **relevo**, no trabajo 100% paralelo. Cada persona hace su turno completo, de principio a fin, sin depender de nada que otro compañero todavía no haya terminado. Cuando termina, el siguiente arranca usando lo que ya quedó listo.

## Estado de Oleada 0 (infraestructura) — honesto, no optimista

| Historia | Estado |
|---|---|
| HT-01 (health checks) | ✅ Hecho (`/health`, `/ready` en ms-identidad) |
| HT-08 (CI/CD) | ✅ Hecho (workflow de GitHub Actions corriendo en el PR #73) |
| HT-07 (secretos/TLS) | 🟡 Parcial (solo `JWT_SECRET`) |
| HT-04 (bitácora de auditoría) | ❌ Pendiente |
| HT-06 (trazabilidad distribuida) | ❌ Pendiente |

## Turno 1 — Jennifer (hoy): solo Oleada 0

| # | Historia | Pts | Depende de |
|---|---|---|---|
| 1 | HT-04 — Bitácora de auditoría | 3 | nada |
| 2 | HT-06 — Trazabilidad distribuida | 5 | nada |
| 3 | HT-07 (resto) — Secretos/TLS completo | 3 | nada |

**Total: 11 pts.** Nada más — el resto (desde HU-11 en adelante) es de Julián y Tomás.

## Turno 2 — Julián (con Turno 1 ya terminado)

| # | Historia | Pts | Depende de |
|---|---|---|---|
| 1 | HU-11 — Registro del operador en MinTIC | 2 | nada |
| 2 | HU-02 — Login | 5 | HU-01 ✅ (ya está) |
| 3 | HU-03 — Carga de documento | 8 | HU-02 (mismo turno) |
| 4 | HU-05a — Localización de operadores | 3 | nada |
| 5 | HU-05b — Publicar endpoint de transferencia | 2 | HU-11 (mismo turno) |
| 6 | HU-06.1 — Registro de entidad institucional | 5 | nada |
| 7 | HU-08 — Consulta de documentos | 5 | HU-02, HU-03 (mismo turno) |
| 8 | HU-07.1, HU-07.2, HU-07.3 — Premium/Analítica | 8 | nada |
| 9 | HT-02 — Respaldo/restauración verificada | 5 | nada |
| 10 | HT-03 — Pruebas de capacidad | 5 | nada |

**Total: 48 pts.**

## Turno 3 — Tomás (con Turnos 1 y 2 ya terminados)

| # | Historia | Pts | Depende de |
|---|---|---|---|
| 1 | HU-04 — Autenticar documento vía GovCarpeta | 8 | HU-03, HU-11 (Turno 2) |
| 2 | HU-05c — Transferencia con saga de dos fases | 8 | HU-05a, HU-05b (Turno 2) |
| 3 | HU-09 — Descarga de documentos | 3 | HU-02 (Turno 2), HU-04 (mismo turno) |
| 4 | HU-06.2 — Paquete documental y entrega | 8 | HU-06.1, HU-08 (Turno 2) |
| 5 | HU-06.3 — Solicitud + autorización de envío | 8 | HU-02 (Turno 2) |
| 6 | HU-06.4 — Solicitud de documento definitivo | 5 | HU-03 (Turno 2), HU-06.3 (mismo turno) |
| 7 | HU-10 — Recepción por entidad emisora | 8 | HU-01 ✅ (ya está) |
| 8 | HT-05 — Suite de pruebas de contrato | 5 | HU-05c (mismo turno) |

**Total: 53 pts.**

## Verificación de balance

Jennifer 11 + Julián 48 + Tomás 53 = **112 pts**, más las 21 ya hechas (HU-01, HT-01, HT-08) = **133**, el proyecto completo.

## Regla del relevo

Antes de empezar tu turno, verifica en GitHub que las historias de las que dependes (columna "Depende de") ya estén cerradas/mergeadas. Si no lo están, adelanta algo de tu propio turno que no dependa de nada (los ítems marcados "nada" en cualquier turno se pueden hacer en cualquier momento, incluso antes de que te toque).
