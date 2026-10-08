# SupplyWok – infraestructura local

Entorno completo de SupplyWok con Docker Compose: PostgreSQL (un esquema y un usuario por microservicio), RabbitMQ (un usuario por microservicio en el vhost `supplywok`), los cuatro microservicios y el API Gateway.

## Requisitos

Clona este repositorio y los de cada servicio en la misma carpeta:

```
SupplyWok-infrastructure/
SupplyWok-api-gateway/
SupplyWok-iam-service/
SupplyWok-inventory-service/
SupplyWok-operations-service/
SupplyWok-purchasing-service/
```

Si los clonas en otra ruta, define `GATEWAY_SOURCE`, `IAM_SOURCE`, `INVENTORY_SOURCE`, `OPERATIONS_SOURCE` y `PURCHASING_SOURCE` en tu `.env`.

# SupplyWok – Plataforma de Microservicios

Este directorio contiene la arquitectura de microservicios de SupplyWok (Sprint 1), incluyendo el API Gateway, los microservicios de negocio (`iam-service`, `inventory-service`, `operations-service`, `purchasing-service`), la infraestructura compartida (PostgreSQL y RabbitMQ) y las herramientas de orquestación con Docker Compose.

---

## 1. Requisitos Previos

- **Docker y Docker Compose**: Docker Desktop o Docker Engine con Compose v2+.
- **Java 26**: OpenJDK 26 para ejecución y desarrollo local.
- **Maven**: Incluido a través del wrapper (`mvnw` / `mvnw.cmd`) en cada servicio.

---

## 2. Cómo Ejecutar Todo el Ecosistema

Para levantar todos los servicios e infraestructura en contenedores Docker:

1. **Crear el archivo de entorno**:
   Copiar la plantilla de variables de entorno:
   ```bash
   cp .env.example .env
   ```
   *(Asegurarse de definir contraseñas seguras y el `JWT_SECRET` en el archivo `.env`)*

2. **Construir y levantar los contenedores**:
   ```bash
   docker compose --env-file .env up --build
   ```
   Para ejecutarlo en segundo plano (modo daemon):
   ```bash
   docker compose --env-file .env up --build -d
   ```

3. **Detener los servicios**:
   ```bash
   docker compose down
   ```
   Para detener y borrar los volúmenes de datos asociados (reinicio limpio de PostgreSQL):
   ```bash
   docker compose down -v
   ```

---

## 3. Mapeo de Puertos

| Servicio / Contenedor | Puerto Host (Publicado) | Puerto Interno (Red Compose) | Descripción |
|---|---|---|---|
| **api-gateway** | `8080` | `8080` | Punto de entrada único y enrutador hacia los microservicios |
| **rabbitmq** (Management) | `15672` | `15672` | Consola web de administración de RabbitMQ |
| **rabbitmq** (AMQP) | *No publicado* | `5672` | Broker de mensajería asíncrona entre servicios |
| **postgres** | *No publicado* | `5432` | Base de datos PostgreSQL 17 (aislamiento por esquemas ADR-002) |
| **iam-service** | *No publicado* | `8081` | Gestión de identidad, perfiles de usuario y emisión de tokens |
| **inventory-service** | *No publicado* | `8082` | Gestión de inventario e insumos |
| **operations-service** | *No publicado* | `8083` | Gestión de mesas, comandas, sensores IoT y alertas |
| **purchasing-service** | *No publicado* | `8084` | Gestión de proveedores y órdenes de compra |

---

## 4. Tabla de Rutas del API Gateway

El API Gateway escucha en el puerto `8080` y enruta el tráfico HTTP según la ruta solicitada:

| Prefijo de Ruta Predicado | Servicio Destino | Variable de Entorno | Destino por Defecto |
|---|---|---|---|
| `/api/v1/authentication`, `/api/v1/authentication/**` | `iam-service` | `IAM_SERVICE_URL` | `http://localhost:8081` |
| `/api/v1/users`, `/api/v1/users/**` | `iam-service` | `IAM_SERVICE_URL` | `http://localhost:8081` |
| `/api/v1/profiles`, `/api/v1/profiles/**` | `iam-service` | `IAM_SERVICE_URL` | `http://localhost:8081` |
| `/api/v1/supplies`, `/api/v1/supplies/**` | `inventory-service` | `INVENTORY_SERVICE_URL` | `http://localhost:8082` |
| `/api/v1/tables`, `/api/v1/tables/**` | `operations-service` | `OPERATIONS_SERVICE_URL` | `http://localhost:8083` |
| `/api/v1/comandas`, `/api/v1/comandas/**` | `operations-service` | `OPERATIONS_SERVICE_URL` | `http://localhost:8083` |
| `/api/v1/sensors`, `/api/v1/sensors/**` | `operations-service` | `OPERATIONS_SERVICE_URL` | `http://localhost:8083` |
| `/api/v1/restaurant/alerts`, `/api/v1/restaurant/alerts/**` | `operations-service` | `OPERATIONS_SERVICE_URL` | `http://localhost:8083` |
| `/api/v1/supplier/alerts`, `/api/v1/supplier/alerts/**` | `operations-service` | `OPERATIONS_SERVICE_URL` | `http://localhost:8083` |
| `/api/v1/suppliers`, `/api/v1/suppliers/**` | `purchasing-service` | `PURCHASING_SERVICE_URL` | `http://localhost:8084` |
| `/api/v1/purchase-orders`, `/api/v1/purchase-orders/**` | `purchasing-service` | `PURCHASING_SERVICE_URL` | `http://localhost:8084` |

### Configuración CORS y Encabezados
- **Orígenes permitidos**: Configurable mediante `CORS_ALLOWED_ORIGINS` (por defecto `http://localhost:4200`).
- **Métodos HTTP**: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`.
- **Encabezados**: `*`.
- **Deduplicación de encabezados**: Filtro `DedupeResponseHeader=Access-Control-Allow-Origin Access-Control-Allow-Credentials, RETAIN_UNIQUE` aplicado a todas las respuestas.

---

## 5. Documentación Swagger / OpenAPI

Cada servicio de negocio expone su documentación interactiva OpenAPI/Swagger UI en su propio puerto local durante desarrollo:

| Microservicio | Swagger UI URL (Desarrollo Local) | OpenAPI Docs (JSON) |
|---|---|---|
| **iam-service** | `http://localhost:8081/swagger-ui.html` | `http://localhost:8081/v3/api-docs` |
| **inventory-service** | `http://localhost:8082/swagger-ui.html` | `http://localhost:8082/v3/api-docs` |
| **operations-service** | `http://localhost:8083/swagger-ui.html` | `http://localhost:8083/v3/api-docs` |
| **purchasing-service** | `http://localhost:8084/swagger-ui.html` | `http://localhost:8084/v3/api-docs` |

---

## 6. Seguridad y Permisos en RabbitMQ (ADR-008: Menor Privilegio)

Siguiendo el principio de mínimo privilegio estipulado en **ADR-008**, cada microservicio cuenta con credenciales exclusivas y permisos estrictamente acotados sobre el virtual host `supplywok`. Ya no se utiliza el usuario predeterminado `guest` para los servicios de negocio.

### Usuarios y Permisos por Servicio (vhost: `supplywok`)

| Microservicio | Usuario | Configurar (Configure Regex) | Escribir (Write Regex) | Leer (Read Regex) |
|---|---|---|---|---|
| **iam-service** | `iam_svc` | `^supplywok\.events$` | `^supplywok\.events$` | `^$` |
| **inventory-service** | `inventory_svc` | `^supplywok\.events$` | `^supplywok\.events$` | `^$` |
| **operations-service** | `operations_svc` | `^(supplywok\.events\|operations\.events)$` | `^operations\.events$` | `^(supplywok\.events\|operations\.events)$` |
| **purchasing-service** | `purchasing_svc` | `^(supplywok\.events\|purchasing\.events)$` | `^(supplywok\.events\|purchasing\.events)$` | `^(supplywok\.events\|purchasing\.events)$` |

### Inicialización y Configuración
1. **Virtual Host (`supplywok`)**: Lo crea el contenedor de un solo uso `rabbitmq-init` (`rabbitmq/init-users.sh`) mediante la API de administración de RabbitMQ, junto con los usuarios y permisos.
2. **Creación de Usuarios y Permisos**: El servicio one-shot `rabbitmq-init` se ejecuta tras comprobar el estado saludable del broker y utiliza la Management HTTP API (vía `rabbitmq/init-users.sh`) para aprovisionar los usuarios utilizando las variables de entorno `*_MQ_PASSWORD`.
3. **Arranque Seguro de Servicios**: Cada microservicio depende de que `rabbitmq-init` termine exitosamente (`condition: service_completed_successfully`) antes de inicializar sus conexiones AMQP.

---

## 7. Cómo Ejecutar un Servicio Localmente con `mvnw`

Cada microservicio es una aplicación Spring Boot independiente y puede ejecutarse directamente desde su carpeta utilizando el wrapper de Maven (`mvnw` / `mvnw.cmd`).

### 1. Preparar el entorno (Windows PowerShell)
Configurar la variable `JAVA_HOME` apuntando a Java 26:
```powershell
$env:JAVA_HOME = "$env:USERPROFILE\.jdks\openjdk-26.0.1"
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
```

### 2. Infraestructura previa
Para servicios que requieren base de datos o mensajería, asegurar que PostgreSQL y RabbitMQ estén iniciados (por ejemplo, ejecutando `docker compose up -d postgres rabbitmq`).

### 3. Ejecutar pruebas unitarias e integración
Navegar al directorio del microservicio:
```powershell
cd microservices\<service-folder>
.\mvnw.cmd test
```

### 4. Empaquetar el servicio
```powershell
.\mvnw.cmd -DskipTests package
```

### 5. Iniciar la aplicación
```powershell
.\mvnw.cmd spring-boot:run
```

Para `api-gateway`:
```powershell
cd microservices\api-gateway
.\mvnw.cmd test
.\mvnw.cmd spring-boot:run
```
Una vez iniciado, se puede comprobar el estado de salud en:
```
http://localhost:8080/actuator/health
```
El cual responderá con estado `{"status":"UP"}`.
