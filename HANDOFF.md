# HANDOFF — MIA AI Multi-Agent Service (`agente_servicios`)

Documento de entrega técnica y guía de operación del microservicio de Inteligencia Artificial con **LangChain + TypeScript + Express (Serverless-ready para Vercel)**.

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

### D. 9 Agentes Especializados + Router Orquestador (`src/agents/`)
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
| `POST` | `/api/v1/chat` | Recibe JSON o `multipart/form-data` (`sessionId`, `userId`, `message`, `provider`, `file?`), ejecuta el agente especializado y devuelve `{ answer, uiPayload, suggestedActions, updatedTravelState, metadata }`. |
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
