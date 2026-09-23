import "dotenv/config";
import { createApp } from "./app.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const app = createApp();

const server = app.listen(port, () => {
  console.log(`Nansen Smart Money Rotation Radar API listening on http://localhost:${port}`);
});

function shutdown(signal) {
  console.log(`${signal} received; closing server.`);
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
