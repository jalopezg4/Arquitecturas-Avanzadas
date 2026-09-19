# Carpeta Ciudadana — Operador

Implementación del Operador de Carpeta Ciudadana. Curso: Arquitecturas Avanzadas de Software, Universidad EAFIT.

**Equipo:** Julián Giraldo Chica, Jennifer Andrea López Gómez, Tomás Echavarría Gil

## Contexto (leer en este orden)

1. [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md) — resumen de la arquitectura de microservicios (fuente completa: `Arquitectura_Carpeta_Ciudadana.docx` en la carpeta del curso)
2. [`docs/HISTORIAS_DE_USUARIO.md`](docs/HISTORIAS_DE_USUARIO.md) — las 26 historias (Entrega 2 + backlog + técnicas), con AC y tests nombrados. Espejo de los [issues en GitHub](https://github.com/jalopezg4/Arquitecturas-Avanzadas/issues).
3. [`docs/GOVCARPETA_CONTRATO.md`](docs/GOVCARPETA_CONTRATO.md) — contrato real de la API de GovCarpeta (verificado contra el Swagger, no inferido)
4. [`docs/PLAN_TRABAJO.md`](docs/PLAN_TRABAJO.md) — orden de dependencias entre historias y reparto entre los 3
5. [`docs/BUENAS_PRACTICAS.md`](docs/BUENAS_PRACTICAS.md) — principios, SOLID y patrones, con ejemplos de dónde ya se usan en este código. Revisar antes de abrir un PR.

## Estilo arquitectónico

Microservicios (ADR-01 del expediente), cada uno dueño exclusivo de su base de datos, comunicación síncrona REST para el camino crítico y eventos (RabbitMQ) para el resto.

> **Nota de alcance de implementación:** el expediente documenta PostgreSQL + MongoDB políglota y un clúster de RabbitMQ de 3 nodos como arquitectura objetivo. Para el alcance de esta entrega académica, todos los servicios usan **MongoDB** (simplifica sin perder la garantía de unicidad — se logra con índices únicos) y **una sola instancia de RabbitMQ**, para que el equipo pueda desplegar y probar de verdad en el tiempo disponible. La arquitectura objetivo (documentada) no cambia; el despliegue de curso es un subconjunto reducido, igual que ya se hizo con Compartición/Analítica/Premium en el propio expediente.

## Servicios

| Servicio | Estado | Historias |
|---|---|---|
| `services/ms-gateway` | 🚧 Mínimo (validación de token y enrutamiento) | HU-02 |
| `services/ms-identidad` | 🚧 En progreso (HU-01) | HU-01, HU-02, HU-11 |
| `services/ms-documentos` | 🚧 En progreso (HU-03: carga) | HU-03, HU-08, HU-09, HU-10 |
| `services/ms-autenticacion` | ⏳ Por empezar | HU-04 |
| `services/ms-interoperabilidad` | 🚧 En progreso (HU-05a: directorio de operadores) | HU-05a, HU-05b, HU-05c |
| `services/ms-notificaciones` | 🚧 En progreso (correo: confirmación de carga y bienvenida) | consumidor de eventos |

## Cómo correr localmente

```bash
docker-compose up -d        # Mongo + RabbitMQ
cd services/ms-identidad
npm install
cp .env.example .env
npm test                    # corre los tests unitarios primero
npm run dev
```
