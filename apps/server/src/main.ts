// Imported first: validates the environment and exits with a readable message
// before anything else (the database pool, the session plugin) reads it.
import { config } from "./config.js";
import { buildApp } from "./app.js";

const app = buildApp();

app.listen({ port: config.port, host: "0.0.0.0" }).catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
