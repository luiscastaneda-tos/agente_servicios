import cors from "cors";
import express from "express";
import { env } from "./config/env";
import { errorHandlerMiddleware } from "./middlewares/error.middleware";
import { chatRouter } from "./routes/chat.routes";

const app = express();

app.use(cors());
app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ extended: true, limit: "4mb" }));

app.get("/", (_req, res) => {
  res.status(200).json({
    ok: true,
    name: "MIA AI Multi-Agent & LangChain Service",
    version: "1.0.0",
    endpoints: {
      health: "GET /api/v1/health",
      ingestDocument: "POST /api/v1/documents/ingest (multipart/form-data: file, sessionId, userId, provider)",
      chat: "POST /api/v1/chat (JSON or multipart/form-data: sessionId, userId, message, provider, file?)",
      sessionState: "GET /api/v1/chat/session/:sessionId",
    },
  });
});

app.use("/api/v1", chatRouter);
app.use(errorHandlerMiddleware);

if (process.env.NODE_ENV !== "production" && !process.env.VERCEL) {
  app.listen(env.port, () => {
    console.log(
      `[MIA_AI] Servidor corriendo en http://localhost:${env.port} (Provider primario: ${env.defaultProvider}, Fallback: ${env.fallbackProvider})`
    );
  });
}

export default app;
