import { createServer } from "node:http";
import {
  reviewWorkerHealthy,
  runReviewWorkerCycle,
  type ReviewWorkerState,
} from "./review-worker-runtime";
const origin = new URL(process.env.NEXT_PUBLIC_APP_URL ?? "");
if (
  origin.protocol !== "https:" ||
  origin.username ||
  origin.password ||
  origin.search ||
  origin.hash ||
  origin.pathname !== "/"
)
  throw new Error("A canonical HTTPS NEXT_PUBLIC_APP_URL is required");
const token = process.env.REVIEWS_WORKER_TOKEN ?? "";
if (token.length < 32)
  throw new Error("REVIEWS_WORKER_TOKEN must have at least 32 characters");
let stopping = false,
  running = false;
const state: ReviewWorkerState = {
  lastDeliverySuccess: Date.now(),
  lastLifecycleSuccess: Date.now(),
  lastLifecycleAttempt: 0,
};
const health = createServer((request, response) => {
  if (request.url !== "/health") {
    response.writeHead(404).end();
    return;
  }
  const ok = !stopping && reviewWorkerHealthy(state);
  response
    .writeHead(ok ? 200 : 503, { "content-type": "application/json" })
    .end(JSON.stringify({ ok }));
});
health.listen(Number(process.env.PORT ?? 8080));
async function tick() {
  if (stopping || running) return;
  running = true;
  try {
    const result = await runReviewWorkerCycle({ origin, token, state });
    for (const error of result.errors) console.error(error);
  } finally {
    running = false;
  }
}
const interval = setInterval(() => void tick(), 5000);
void tick();
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    stopping = true;
    clearInterval(interval);
    health.close();
    const exit = setInterval(() => {
      if (!running) {
        clearInterval(exit);
        process.exit(0);
      }
    }, 100);
    setTimeout(() => process.exit(1), 60000).unref();
  });
