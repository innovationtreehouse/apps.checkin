/**
 * Local entry point — `npm run run:once`. Runs one watchdog pass: reads the
 * `service_heartbeat` rows in the MONITORING_DATABASE_URL DB for the services listed in
 * MONITORING_SERVICES. It connects to no watched service's own database.
 */
import { handler } from "./handler.js";

handler()
  .then((result) => {
    console.log(JSON.stringify({ ok: true, ...result }));
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
