# HANDOFF — MIA AI Multi-Agent Service (`agente_servicios`)

Documento de entrega técnica y guía de operación del microservicio de Inteligencia Artificial con **LangChain + TypeScript + Express (Serverless-ready para Vercel)**.

---

## 0. Estado actual (actualizado 27-oct-2026)

> Esta sección es la fuente de verdad de **dónde nos quedamos**. Las secciones 1–4 son la documentación base del servicio y siguen vigentes salvo donde se indica.

### 0.1 Lo que llevamos

1. **Agente de autobuses** (`BusAgent`): ya devuelve **marca/línea, terminal, clase de servicio y duración**, sin precios.
   - Pide la **fecha exacta** antes de buscar (`requiresExactDate`; parser en [`src/utils/date-parser.ts`](./src/utils/date-parser.ts): "mañana", "el viernes", "15 de noviembre", ISO…; rechaza fechas pasadas).
   - Horarios de salida: **no hay fuente confiable** (las páginas de ETN/ADO cargan las corridas con JavaScript y las APIs no son públicas). Decisión: la tarjeta dice "Horarios por confirmar en terminal o sitio oficial"; solo se muestran horas si aparecen en los resultados web, nunca se inventan.
   - Filtro de precios compartido: [`src/utils/price-filter.ts`](./src/utils/price-filter.ts) (`stripPrices`, `dropNulls`, `parseLenientJson`).
2. **Memoria entre recargas**: el front guarda el `sessionId` por usuario en `localStorage` y restaura la sesión con `GET /api/v1/chat/session/:id`. Botón **"Nueva conversación"** en el chat.
3. **Front (`mia`)**: el chat de MIA AI Studio **siempre está en modo cotización** (ya no hay toggle ni chat general) — se quitó la pestaña "Mi Selección / Itinerario" y sus componentes (`MiaSelectedItineraryPanel`, `MiaStudioStatusBar`), sin uso desde que no existe el chat general que los alimentaba.
4. **Supabase**: mia_ai usa el proyecto de MIA (`iyuom…`) y las tablas de [`sql/supabase_setup.sql`](./sql/supabase_setup.sql) ya están creadas ahí. `bacl` se alineó al mismo proyecto (la impersonación admin → mia funciona).
5. **Cotizaciones**: agente que convierte texto, PDF, imagen, CSV o Excel en una solicitud de cotización para Operaciones — **ya en producción, con opciones reales por ítem** (ver 0.2). SQL corrido, bucket creado, permiso otorgado: el flujo completo ya se probó de punta a punta.

### 0.2 Cotizaciones: cómo funciona

```
mia (chat siempre en modo cotización)
  → POST /api/v1/chat { mode:"quote", currentDraft?, files[0..3] }
  → QuoteAgent (src/agents/quote/): lee texto / PDF / CSV / .xlsx / imagen (visión),
    1 llamada LLM con esquema Zod, SIN precios, originales a Supabase Storage (bucket privado)
  → por cada item flight/car_rental/bus con datos suficientes: enrichWithFoundOptions()
    reutiliza FlightAgent/CarRentalAgent/BusAgent (los mismos de siempre, no se
    reinventa busqueda) para anexar hasta 3 opciones reales sin precio -- con
    carry-forward entre turnos si no cambian origen/destino/fecha
  → uiPayload { type:"quote_draft", quoteDraft }  → borrador editable en mia,
    cada item con boton "Elegir"/"Cambiar" que abre un modal (TransportOptionCard
    reusado) para marcar la preferida (preferredOptionId)
  → (usuario confirma) POST bacl /v2/mia/cotizaciones-ia
  → MySQL de bacl: cotizaciones_ia + cotizaciones_ia_archivos (incluye foundOptions
    y preferredOptionId dentro del JSON de items)
  → admin_mia /dashboard/cotizaciones-ia (permiso view.cotizaciones_ia), solo lectura,
    muestra las opciones encontradas y cual prefirio el cliente;
    "Abrir" pide a bacl una URL firmada de 300 s del archivo original
```

- **Opciones encontradas, solo flight/car_rental/bus** (nunca hotel -- mia ya tiene su propio catalogo de hoteles en otra parte, mezclar fue decision explicita de dejarlo fuera). Si el item es elegible (tiene origen/destino o lugar de recoleccion) pero no trae opciones, el borrador muestra "No se pudieron buscar opciones por ahora" en vez de quedarse mudo.
- **El LLM de extraccion no sabe nada de foundOptions/preferredOptionId** -- nunca los devuelve, por eso `quote.agent.ts` los repone a mano cada turno (`carryForwardFoundOptions`) y los quita del JSON que arma el prompt (`buildUserMessage`) para que el modelo no los altere al regenerar el item.
- **Archivos ya subidos en el chat (antes de confirmar)**: se muestran debajo de los mensajes, con boton para abrirlos. Usan un endpoint nuevo de bacl (`GET /cotizaciones-ia/archivos/url`) distinto al de Operaciones, porque antes de confirmar el archivo vive solo en Storage, sin fila en `cotizaciones_ia_archivos` todavia.
- **Por qué un camino separado**: el flujo antiguo (`POST /mia/solicitud` con `tradicional:false`) mete la solicitud al **carrito de pago** y exige `total`; Stripe suma esos totales. Una cotización sin precio no cabe ahí.
- **Tipos**: `flight`, `car_rental`, `hotel`, `bus`. El **autobús** es una cotización más: el sistema de reservas no lo soporta, Operaciones lo resuelve fuera del sistema.
- **Sin precios**: no se extraen, no se guardan, no se muestran (Operaciones los pone). bacl rechaza con 400 cualquier clave de precio. El mensaje cuando fallan los proveedores de IA tampoco dice cuales son (antes decia "Gemini y OpenAI" literal).
- **Sin correo**: la lectura de correos quedó fuera del alcance.
- **Dónde está cada cosa**:

| Repo | Qué | Ruta |
| :--- | :--- | :--- |
| `mia_ai` | Agente, enriquecimiento con opciones, esquema Zod, lectores, subida de originales, `zip-guard` | `src/agents/quote/` (incluye `quote-options.enricher.ts`), `src/repositories/quote-storage.repository.ts`, `src/utils/zip-guard.ts` |
| `bacl` | SQL + módulo (validación, repositorio, URL firmada, rate limit, archivo-pre-confirmación) | `sql/cotizaciones_ia.sql`, `api/modules/cotizacionesIa/`, `v2/router/mia.js` |
| `mia` | Modo cotización, borrador editable, modal de opciones, archivos en el chat, confirmación | `src/components/organism/mia-ai/QuoteDraftPanel.tsx`, `src/components/molecule/mia-ai/QuoteItemCard.tsx`, `src/services/CotizacionIaService.ts`, `src/utils/quoteDraft.ts` |
| `admin_mia` | Vista de cotizaciones (lista, detalle, archivos, opciones encontradas) | `app/dashboard/cotizaciones-ia/`, `angel/**` |

- **Campos requeridos para confirmar**: vuelo (origen, destino, salida) · renta de auto (lugar y fechas de recogida/entrega) · hotel (ciudad u hotel, entrada, salida) · autobús (origen, destino, salida). Fechas ISO `YYYY-MM-DD`.
- `mia_ai` **recorta** el borrador a los límites de validación de bacl (`cotizacionesIa.schema.js`) para no provocar 400 por longitud.

### 0.3 PASOS MANUALES -- estado real (27-oct-2026)

**Para que cotizaciones funcione:**
1. ✅ `bacl/sql/cotizaciones_ia.sql` corrido en MySQL (producción).
2. ✅ Bucket privado creado en Supabase Storage -- **ojo: se llamó `archivos_mia`, no el default `cotizaciones-mia`**. `COTIZACIONES_BUCKET=archivos_mia` ya está puesto en `bacl/.env` y `mia_ai/.env` -- si se despliega a otro entorno, hay que ponerlo ahí también o el borrador sale con `uploadError`.
3. ✅ Permiso `view.cotizaciones_ia` otorgado a `luis.castaneda@noktos.com`. Falta dárselo a PATY/Operaciones cuando se sepa su correo (bloque comentado al final del `.sql`).
4. ⏳ **Sigue pendiente**: llave de IA con cuota real. Gemini gratis sigue en 429 (20 solicitudes/día, límite duro) y `OPENAI_API_KEY` no está puesta -- decisión explícita de seguir con la actual por ahora.
5. ✅ `npm install` corrido (incluye `exceljs`).

**Validado de punta a punta (27-oct-2026):** cotización de vuelo real por curl → 3 opciones reales (Aeroméxico, Volaris, Viva Aerobus) sin precio; carry-forward confirmado entre turnos; bus y auto probados (ADO/Estrella Roja, Hertz/Avis/Enterprise); hotel confirmado que nunca trae opciones. UI revisada en navegador por el usuario: modal de opciones, archivos en el chat, aviso de "sin opciones", cabina en español, sin mención de Gemini/OpenAI -- todo confirmado funcionando.

**Pendiente de validar:**
- En desarrollo `usePermiso` da `true` a todos: falta comprobar el ocultamiento por permiso en un entorno con permisos reales.

**Hallazgos ajenos a cotizaciones (pendientes de arreglar):**
- Preguntar sobre un PDF/CSV ya subido falla: `text-embedding-004` responde 404 (actualizar `GEMINI_EMBEDDING_MODEL` o usar OpenAI) y a `mia_document_chunks` le faltan las columnas `file_name text`, `file_type text`, `chunk_index int`, `token_count int` (el código las inserta; hoy los vectores caen a memoria local).

### 0.4 Pendiente / siguientes pasos

- **Seguridad del POST de cotizaciones**: la `x-api-key` viaja en el bundle del frontend, así que `id_usuario` es declarativo (ya se valida que `storage_path` empiece con la carpeta del propio usuario, en los dos endpoints de archivo). Recomendado: validar la sesión de MIA en bacl, y registrar quién abre cada archivo. El rate limit (20 solicitudes/10 min por IP) es en memoria y **por instancia** (en Vercel no es exacto).
- **Idempotencia**: un reintento tras perder la respuesta puede duplicar la cotización (el front avisa en vez de reintentar a ciegas).
- **Hoteles en el chat con IA**: se investigó la integración candidata (Nemo/NEMU, repo `care_nemu` aparte) el 27-oct. Conclusión: **no conectarla directo a los agentes todavía** -- es una plataforma de reservas completa (orgs, créditos, trips reales), no una simple API de hoteles, y mezclar su complejidad con el patrón liviano de los agentes de transporte (solo búsqueda web, sin inventario real) es un salto demasiado grande. Se probaron 2 endpoints de solo lectura de Nemo directamente (fuera de mia_ai, en `care_nemu/pruebas_api`): el catálogo de hoteles (`/hotels/catalog`) funciona -- se le encontró y corrigió un bug real (el parser esperaba un contrato XML distinto al que Nemo realmente regresa, nunca se había probado contra producción) -- pero la búsqueda de disponibilidad (`/hotels/search`) falla con `NullPointerException` del lado de Nemo, aparentemente porque la cuenta/contrato no tiene proveedores habilitados para ese flujo (el catálogo es un sistema independiente, según su propia documentación). Reportado a soporte de Price Navigator vía el jefe del usuario, pendiente de respuesta. mia ya tiene su propio catálogo de hoteles en la parte de reservas, de cualquier forma.
- **Mejoras del agente de autobuses**: subir el historial que ven los agentes de transporte de 4 a 6 mensajes (`recentHistory.slice(-4)`); horarios reales solo con convenio/API de pago (Busbud/Reservamos), descartado por ahora.
- **Revisar aparte**: la rama de `classifyIntent` que continúa el servicio activo con fecha/pasajeros afecta el enrutado de transporte; errores conocidos de `createCartItem`/`createSolicitudes` en bacl `/v1` (tipo desconocido → 500, `catch` que usa `res` fuera de alcance) -- no tocado.
- **Deuda técnica de tipos recién visible**: el `tsc --noEmit` plano de `admin_mia` y de `mia` no estaba revisando nada en realidad (ver nota abajo) -- al correrlo bien salieron ~254 errores preexistentes en `admin_mia` y errores en ~50 archivos de `mia`. Es deuda vieja, no de hoy; no se tocó, queda como proyecto aparte si se decide atacarla.
- **Límites del lector de archivos**: sin OCR (PDF escaneado → subir como imagen); `.xls` antiguo no se lee (solo `.xlsx`); PDF limitado a 30 páginas; xlsx limitado a 20 MB descomprimido y 200 entradas.

### 0.4.1 Dos bugs de "el typecheck no revisaba nada" (lección para el equipo)

Encontrados y corregidos el 27-oct-2026, documentados aparte porque son del tipo que vuelve a pasar si no se sabe:

1. **`admin_mia/tsconfig.json`** tenía `"ignoreDeprecations": "6.0"`, un valor inválido para la versión de TypeScript instalada (5.2.2). `tsc` abortaba en el parseo del config **antes de revisar un solo archivo**, sin avisar claramente. Ya se quitó la línea.
2. **`mia/tsconfig.json`** (raíz) es un archivo "solución" (`"files": []` + `"references"`), pensado para `tsc -b`. Correr `npx tsc --noEmit` a secas en la raíz no revisa nada -- hay que usar `npx tsc --noEmit -p tsconfig.app.json`. Todo el "typecheck limpio" reportado durante la sesión de hoy antes de descubrir esto **no estaba verificando nada de verdad** -- al correr el comando correcto salieron 2 bugs reales de narrowing en `QuoteItemCard.tsx` (ya corregidos) y confirmó que `StayCalendar.tsx` (archivo huérfano, incompleto desde su único commit de mayo 2025, nunca importado en ningún lado) llevaba roto todo este tiempo -- se borró.

**Para cualquiera que use `tsc` en estos repos:** en `admin_mia`, `npx tsc --noEmit` ya funciona bien. En `mia`, usar siempre `npx tsc --noEmit -p tsconfig.app.json`, nunca el comando a secas en la raíz.

### 0.5 Variables de entorno nuevas o relevantes

| Variable | Uso |
| :--- | :--- |
| `COTIZACIONES_BUCKET` | Bucket privado de Storage, en `mia_ai` y `bacl`. **En este proyecto vale `archivos_mia`**, no el default `cotizaciones-mia` del código -- ya puesto en ambos `.env` locales. |
| `TAVILY_API_KEY` | Búsqueda web (opcional; sin ella cae a DuckDuckGo, que es frágil) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Si están vacías, sesiones y vectores viven en memoria y se pierden al reiniciar |

> Nunca subir `.env`. Si la `service_role` se expone, rotarla en Supabase (Settings → API) y actualizarla en `bacl` y `mia_ai`.

---

## 1. ¿Qué fue lo que construimos?

Diseñamos e implementamos una arquitectura **Multi-Agente con RAG (PDF/CSV) y Búsqueda Web en Tiempo Real**, siguiendo patrones de diseño limpios (**Strategy**, **Repository**, **Orchestrator/Router**) y **Guardrails de producción**:

### A. Patrón `Strategy` para Proveedores de IA (`src/strategies/`)
- **[`ILLMStrategy`](./src/strategies/llm.strategy.interface.ts)**: Interfaz común para desacoplar el proveedor de IA (`getChatModel()` y `getEmbeddings()`).
- **[`GeminiStrategy`](./src/strategies/gemini.strategy.ts)** y **[`OpenAIStrategy`](./src/strategies/openai.strategy.ts)**:
  - Modelos de Chat intercambiables por configuración o por petición (`"gemini"` | `"openai"`).
  - Embeddings estandarizados a **768 dimensiones** en ambos proveedores para garantizar compatibilidad total con la columna `vector(768)` de Supabase.
- **[`LLMStrategyContext`](./src/strategies/llm.context.ts)**:
  - **Fallback automático**: Si el proveedor primario falla (timeout, rate limit `429` o caída), reintenta automáticamente con el proveedor secundario (`fallbackTriggered: true`).
  - **Error controlado para UI**: Si ambos proveedores fallan, devuelve HTTP `503` con código `AI_PROVIDERS_UNAVAILABLE` y `retryable: true` para que el frontend muestre el botón de reintentar sin perder el mensaje del usuario.

### B. Patrón `Repository` para Tokenización, Persistencia y Búsqueda Web (`src/repositories/`)
1. **[`TokenizerRepository`](./src/repositories/tokenizer.repository.ts)**:
   - Carga archivos **PDF** con `PDFLoader` y archivos **CSV** con `CSVLoader` de `@langchain/community`.
   - Divide los documentos por **tokens reales** usando `TokenTextSplitter` (`cl100k_base`) y `js-tiktoken` (`500` tokens por fragmento con `50` tokens de *overlap*).
   - **Tratamiento especial para CSV**: Calcula automáticamente un **Chunk de Resumen Estadístico y Esquema Global** (`isSummaryChunk: true`) con conteo total de filas, columnas y sumas/promedios/mínimos/máximos numéricos para evitar alucinaciones en preguntas globales sobre tablas.
2. **[`SupabaseVectorRepository`](./src/repositories/supabase-vector.repository.ts)**:
   - Almacena y consulta los fragmentos tokenizados en Supabase (`mia_document_chunks` + RPC `match_mia_documents`) con aislamiento multi-tenant por `sessionId` y `userId`.
   - Incluye un *fallback* automático en memoria local únicamente para pruebas rápidas si aún no se configuran las llaves de Supabase en `.env`.
3. **[`ChatSessionRepository`](./src/repositories/chat-session.repository.ts)**:
   - Persiste el estado de la conversación en `mia_chat_sessions` y `mia_chat_messages`:
     - **`travelState` compartido**: `activeService`, `origin`, `destination`, `departureDate`, `returnDate`, `passengers`. Permite cambiar de un agente de transporte a otro conservando la ruta del usuario.
     - **Ventana deslizante (*Sliding Window*)**: Envía al LLM únicamente los últimos `6` mensajes de contexto para controlar el consumo de tokens.
4. **[`WebSearchRepository`](./src/repositories/web-search.repository.ts)** y **[`TransportRepositories`](./src/repositories/transport/transport.repositories.ts)**:
   - Búsqueda en internet en tiempo real (DuckDuckGo HTML parser con `cheerio` sin requerir API Key de pago, más soporte opcional para `TAVILY_API_KEY`).
   - 6 repositorios especializados por servicio: `FlightRepository`, `CarRentalRepository`, `ChauffeurRepository`, `FerryRepository`, `TrainRepository` y `BusRepository`.

### C. Guardrails de Seguridad y Control de Costos (`src/guardrails/`)
- **[`GuardrailsService`](./src/guardrails/guardrails.service.ts)**:
  - **Input Guardrail**: Límite de 2,000 caracteres por mensaje y detección de patrones de *Prompt Injection* / XSS.
  - **File Guardrail**: Validación estricta de formato (`.pdf`, `.csv`) y tamaño máximo de **4 MB** (compatible con el límite de payload de Vercel Serverless).
  - **Quota Guardrail**: Límite configurable por sesión (por defecto **25 mensajes** y **3 archivos** por sesión).
  - **Output Guardrail**: Validación de respuestas estructuradas con `Zod` (`uiPayload`, `suggestedActions`, `updatedTravelState`).

### D. 10 Agentes Especializados + Router Orquestador (`src/agents/`)
- **[`AgentRouterOrchestrator`](./src/agents/agent-router.orchestrator.ts)**: Clasifica la intención del usuario y delega al agente experto:
  1. **`FlightAgent`**: Aerolíneas que operan la ruta, aeropuertos IATA, escalas y duración estimada (sin precios en vivo).
  2. **`CarRentalAgent`**: Arrendadoras en el destino, categorías de autos, puntos de entrega y requisitos.
  3. **`ChauffeurAgent`**: Renta de auto con chofer / transporte ejecutivo privado (Sedán, SUV, Van) por traslado o por hora/día.
  4. **`FerryAgent`**: Rutas de ferry, navieras, puertos/muelles de salida y llegada, duración y modalidad (pasajeros/vehículos).
  5. **`TrainAgent`**: Rutas ferroviarias de pasajeros, estaciones, clases y tiempos de recorrido.
  6. **`BusAgent`**: Líneas de autobuses, terminales de origen/destino, clases de servicio y duración estimada.
  7. **`PdfSpecialistAgent`**: Temperatura `0.1`, lectura profunda de PDFs con etiquetas XML `<contexto_pdf>` y citas exactas de página (`[Página X]`).
  8. **`CsvAnalystAgent`**: Temperatura `0.0`, análisis tabular exacto combinando el chunk estadístico global + filas tokenizadas, devolviendo tablas (`uiPayload.type = "table"`) o tarjetas de KPIs.
  9. **`GeneralMiaAgent`**: Asistente general de viajes para saludos o aclaraciones.
  10. **`QuoteAgent`** ([`src/agents/quote/`](./src/agents/quote/quote.agent.ts)): no es un orquestador de los agentes de transporte; **lee y estructura** lo que el usuario ya sabe que quiere (texto, PDF, CSV, Excel, imagen) en un borrador de cotización sin precios. Ver sección 0.2.

---

## 2. ¿Cómo levantarlo paso a paso?

### Paso 1: Instalar dependencias
```bash
npm install
```
*(El archivo `.npmrc` ya incluye `legacy-peer-deps=true` para compatibilidad directa local y en Vercel).*

### Paso 2: Configurar variables de entorno (`.env`)
Copia el archivo de ejemplo y agrega tus llaves:
```bash
cp .env.example .env
```
Edita `.env`:
```env
PORT=4005
NODE_ENV=development

# Proveedor primario y secundario para el patrón Strategy
DEFAULT_LLM_PROVIDER=gemini
FALLBACK_LLM_PROVIDER=openai

# Llaves de los proveedores (al menos una es requerida; ambas habilitan el fallback cruzado)
GEMINI_API_KEY=tu_api_key_de_gemini
OPENAI_API_KEY=tu_api_key_de_openai

# Supabase (Para persistencia vectorial pgvector y estado de sesiones en Vercel)
SUPABASE_URL=https://tu-proyecto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=tu_service_role_key
```

### Paso 3: Configurar las tablas y `pgvector` en Supabase
1. Abre tu proyecto en **Supabase Dashboard** → **SQL Editor**.
2. Copia y ejecuta todo el contenido de **[`sql/supabase_setup.sql`](./sql/supabase_setup.sql)**.
   - Esto habilitará la extensión `vector` (100% gratuita en Supabase) y creará las tablas `mia_chat_sessions`, `mia_chat_messages`, `mia_document_chunks` y la función `match_mia_documents`.

### Paso 4: Correr el servidor en desarrollo
```bash
npm run dev
```
El servicio levantará en `http://localhost:4005`.

Para compilar a producción o verificar tipos:
```bash
npm run typecheck
npm run build
npm start
```

---

## 3. Endpoints Disponibles

| Método | Endpoint | Descripción |
| :--- | :--- | :--- |
| `GET` | `/api/v1/health` | Verifica el estado del servicio, proveedores activos, conexión a Supabase y cuotas. |
| `POST` | `/api/v1/documents/ingest` | Recibe `multipart/form-data` (`file`, `sessionId`, `userId`, `provider`), tokeniza el PDF o CSV con LangChain y almacena sus vectores. |
| `POST` | `/api/v1/chat` | Recibe JSON o `multipart/form-data` (`sessionId`, `userId`, `message`, `provider`, `file?`), ejecuta el agente especializado y devuelve `{ answer, uiPayload, suggestedActions, updatedTravelState, metadata }`. Para cotizaciones: `mode:"quote"`, `currentDraft?` y `files` (0–3, máx. 4 MB c/u: pdf, csv, xlsx, png, jpg, webp) → `uiPayload.type = "quote_draft"`. El campo `file` (uno solo) sigue siendo la ingesta RAG. |
| `GET` | `/api/v1/chat/session/:sessionId` | Devuelve el estado completo de la sesión (`travelState`, documentos tokenizados, cuota e historial de mensajes con sus `uiPayload`). |

---

## 4. Siguientes Pasos Recomendados

1. **Despliegue en Vercel**:
   - Importar este repositorio (`luiscastaneda-tos/agente_servicios`) en Vercel.
   - El archivo [`vercel.json`](./vercel.json) ya está configurado. Solo agrega las variables de entorno del `.env` en el panel de Vercel y copia la URL desplegada en la variable `VITE_MIA_AI_URL` del frontend de `mia`.
2. **Conexión con Proveedores de Precios / Inventario en Vivo (Fase 2)**:
   - Actualmente los 6 agentes de transporte (`flight`, `car_rental`, `chauffeur`, `ferry`, `train`, `bus`) buscan rutas, operadores, terminales y horarios reales en internet sin cotizar precios en vivo.
   - Gracias al patrón **Repository** (`src/repositories/transport/transport.repositories.ts`), cuando quieras conectar una API de tarifas reales (Amadeus, Sabre, Duffel o catálogo interno de Noktos), solo tendrás que actualizar el repositorio correspondiente sin cambiar la estructura del agente ni del frontend.
3. **Búsqueda Web Dedicada (Opcional)**:
   - Por defecto usa DuckDuckGo HTML sin costo. Si en producción deseas mayor volumen de búsqueda web, basta con agregar `TAVILY_API_KEY` en las variables de entorno y `WebSearchRepository` la usará automáticamente como motor primario.
