import { createServer } from 'node:http';
import { workerConfiguration, maintainBookingAlerts, recoverBookingAlerts } from './booking-alert-worker-runtime';

const config = workerConfiguration(process.env);
let stopping = false;
let lastSuccess = 0;
let lastRecovery = 0;
let lastRecoveryAttempt = 0;
let timer: NodeJS.Timeout | undefined;

async function poll() {
  if (stopping) return;
  if (await maintainBookingAlerts(config)) lastSuccess = Date.now();
  else console.warn('[booking-alerts] Maintenance requires retry');
  if (!stopping && Date.now() - lastRecoveryAttempt >= 60000) {
    lastRecoveryAttempt = Date.now();
    if (await recoverBookingAlerts(config)) lastRecovery = Date.now();
    else console.warn('[booking-alerts] Confirmation recovery requires retry');
  }
  if (!stopping) timer = setTimeout(() => void poll(), 5000);
}

const server = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json');
  if (request.url !== '/health' || request.method !== 'GET') {
    response.writeHead(404).end();
    return;
  }
  const healthy = !stopping && lastSuccess > Date.now() - 180000 && lastRecovery > Date.now() - 180000;
  response.writeHead(healthy ? 200 : 503).end(JSON.stringify({ ok: healthy }));
});
server.listen(Number(process.env.PORT || 8080), () => void poll());

function stop() {
  stopping = true;
  clearTimeout(timer);
  server.close();
  setTimeout(() => process.exit(0), 60000).unref();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
