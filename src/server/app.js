import express from "express";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  app.get("/api/health", (_request, response) => {
    response.json({
      ok: true,
      service: "nansen-smart-money-rotation-radar",
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}
