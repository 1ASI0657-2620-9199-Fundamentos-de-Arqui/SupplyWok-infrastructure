import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

function parseArgs() {
  const args = process.argv.slice(2);
  let port = 28080;
  let rmqPort = 25672;
  let rmqUser = process.env.RABBITMQ_USER || "guest";
  let rmqPass = process.env.RABBITMQ_PASSWORD || "guest";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port") port = Number(args[++i]);
    if (args[i] === "--rmq-port") rmqPort = Number(args[++i]);
    if (args[i] === "--rmq-user") rmqUser = args[++i];
    if (args[i] === "--rmq-pass") rmqPass = args[++i];
  }
  return { port, rmqPort, rmqUser, rmqPass };
}

function compose(...args) {
  return execFileSync("docker", ["compose", "-p", "supplywok-s3-qa", ...args], {
    encoding: "utf8",
  }).trim();
}

function sql(query) {
  const out = compose(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-XAt",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    "supplywok",
    "-c",
    query
  );
  return out.split(/\r?\n/)[0] ?? "";
}

async function waitUntil(fn, timeoutMs = 90000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch {
      // retry until timeout
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[idx];
}

async function main() {
  const { port, rmqPort, rmqUser, rmqPass } = parseArgs();
  const gateway = `http://127.0.0.1:${port}/api/v1`;
  const run = crypto.randomUUID().replace(/-/g, "").slice(0, 10);

  async function req(path, body = null, token = null) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const started = performance.now();
    const res = await fetch(gateway + path, {
      method: body === null ? "GET" : "POST",
      headers,
      body: body === null ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const elapsedSec = (performance.now() - started) / 1000;
    return { status: res.status, headers: res.headers, text, elapsedSec };
  }

  async function createAccount(role) {
    const creds = {
      email: `${role.toLowerCase()}-${crypto.randomBytes(4).toString("hex")}@example.test`,
      password: crypto.randomBytes(12).toString("base64url"),
    };
    const su = await req("/authentication/sign-up", { ...creds, role });
    assert(su.status === 200 || su.status === 201, `sign-up ${role} got ${su.status}: ${su.text}`);
    const si = await req("/authentication/sign-in", creds);
    assert(si.status === 200, `sign-in ${role} got ${si.status}`);
    return JSON.parse(si.text).token;
  }

  const owner = await createAccount("Restaurant");
  const other = await createAccount("Restaurant");
  const supplier = await createAccount("Supplier");

  // 1. QA-03 Security & Tenant Isolation
  const unauth = await req("/supplies");
  assert(unauth.status === 401 && unauth.headers.get("x-correlation-id"), "expected 401 + X-Correlation-Id");
  const forbidden = await req("/supplies", null, supplier);
  assert(forbidden.status === 403, `expected 403 for supplier, got ${forbidden.status}`);
  console.log("PASS | QA-03 Security | Unauthenticated 401, correlation ID present, supplier role 403");

  const createSupply = (name) =>
    req(
      "/supplies",
      {
        name,
        unitOfMeasure: "Units",
        currentStock: 1,
        minimumStockLevel: 2,
        category: "Sprint3",
      },
      owner
    );

  async function countAlerts(name) {
    const r = await req("/restaurant/alerts", null, owner);
    assert(r.status === 200, `alerts returned ${r.status}`);
    return JSON.parse(r.text).filter((item) => (item.detail || "").includes(name)).length;
  }

  // 2. QA-01 Concurrent REST Latency (30 concurrent requests across 5 waves of 6)
  const restLatencies = [];
  for (let w = 0; w < 5; w++) {
    const wave = await Promise.all([
      req("/supplies", null, owner),
      req("/restaurant/alerts", null, owner),
      req("/tables", null, owner),
      req("/sensors", null, owner),
      req("/purchase-orders", null, owner),
      req("/supplies", null, other),
    ]);
    for (const r of wave) {
      assert(r.status === 200, `concurrent REST status ${r.status}`);
      restLatencies.push(r.elapsedSec);
    }
  }
  restLatencies.sort((a, b) => a - b);
  const restP50 = percentile(restLatencies, 0.5);
  const restP95 = percentile(restLatencies, 0.95);
  const restMax = restLatencies[restLatencies.length - 1];
  console.log(
    `MEASURE | QA-01 Concurrent REST | 30 requests (5x6) | p50=${restP50.toFixed(3)}s p95=${restP95.toFixed(3)}s max=${restMax.toFixed(3)}s`
  );
  assert(restP95 < 2.0, `REST p95 ${restP95}s exceeded 2s`);

  // 3. QA-01 Event Propagation Latency (20 sequential stock-to-alert flows)
  const eventDurations = [];
  for (let i = 0; i < 20; i++) {
    const name = `S3-Timing-${run}-${String(i).padStart(2, "0")}.`;
    const t0 = performance.now();
    const res = await createSupply(name);
    assert(res.status === 201, `createSupply got ${res.status}`);
    await waitUntil(async () => (await countAlerts(name)) === 1, 30000, `alert ${name}`);
    eventDurations.push((performance.now() - t0) / 1000);
  }
  eventDurations.sort((a, b) => a - b);
  const evP95 = percentile(eventDurations, 0.95);
  console.log(`MEASURE | QA-01 Event Latency | 20 stock-to-alert flows | p95=${evP95.toFixed(3)}s`);
  assert(evP95 < 5.0, `Event p95 ${evP95}s exceeded 5s`);

  // 4. QA-02 & QA-04 Broker Outage + Recovery + Concurrent Duplicate Delivery (5x parallel)
  const label = `S3-QA-${run}`;
  compose("stop", "rabbitmq");
  let eventRow;
  try {
    const created = await createSupply(label);
    assert(created.status === 201, `createSupply while RMQ down got ${created.status}`);
    const supplyId = JSON.parse(created.text).id;
    const cross = await req(`/supplies/${supplyId}`, null, other);
    assert(cross.status === 404, `expected 404 cross-tenant, got ${cross.status}`);
    const raw = sql(
      `SELECT row_to_json(e) FROM inventory.outbox_events e WHERE payload::jsonb->>'name'='${label}'`
    );
    eventRow = JSON.parse(raw);
    assert((await countAlerts(label)) === 0, "expected 0 alerts while RMQ stopped");
    console.log("PASS | QA-02 Broker Down | Supply HTTP 201, event saved in outbox_events, other restaurant 404");
  } finally {
    compose("start", "rabbitmq");
  }

  const recStart = performance.now();
  await waitUntil(async () => (await countAlerts(label)) === 1, 120000, "broker recovery alert");
  const eventId = eventRow.event_id;
  assert(
    sql(`SELECT count(*) FROM operations.processed_events WHERE event_id='${eventId}'`) === "1",
    "expected 1 processed_events row"
  );
  console.log(
    `PASS | QA-02 Recovery | Automatic alert published after ${((performance.now() - recStart) / 1000).toFixed(2)}s | eventId=${eventId}`
  );

  // Publish 5 simultaneous concurrent copies of the exact same eventId via RabbitMQ Management API
  const rmqAuth = Buffer.from(`${rmqUser}:${rmqPass}`).toString("base64");
  const publishUrl = `http://127.0.0.1:${rmqPort}/api/exchanges/supplywok/supplywok.events/publish`;
  const publishBody = JSON.stringify({
    properties: {
      message_id: eventId,
      content_type: "application/json",
      delivery_mode: 2,
      headers: {
        eventType: eventRow.event_type,
        version: "1.0",
        __TypeId__: "aurora.supply_wok.platform.inventory.interfaces.events.SupplyMinimumStockReachedIntegrationEvent",
      },
    },
    routing_key: eventRow.routing_key,
    payload: eventRow.payload,
    payload_encoding: "string",
  });

  const concurrentPublishes = await Promise.all(
    Array.from({ length: 5 }, () =>
      fetch(publishUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${rmqAuth}`,
        },
        body: publishBody,
      })
    )
  );
  for (const p of concurrentPublishes) {
    assert(p.ok, `RMQ publish failed: ${p.status}`);
  }
  await new Promise((r) => setTimeout(r, 2500));
  assert((await countAlerts(label)) === 1, "concurrent duplicate redelivery created >1 alert!");
  assert(
    sql(`SELECT count(*) FROM operations.processed_events WHERE event_id='${eventId}'`) === "1",
    "processed_events row duplicated!"
  );
  console.log("PASS | QA-04 Concurrent Idempotency | 5 parallel redeliveries of same eventId produced 1 alert");

  // 5. Poison message -> DLQ
  const dlqBefore = Number(
    compose("exec", "-T", "rabbitmq", "rabbitmqctl", "-q", "list_queues", "-p", "supplywok", "name", "messages_ready")
      .split(/\r?\n/)
      .find((line) => line.startsWith("operations.events.dlq"))
      ?.split(/\s+/)[1] ?? 0
  );
  const poisonRes = await fetch(publishUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${rmqAuth}` },
    body: JSON.stringify({
      properties: { message_id: crypto.randomUUID(), content_type: "application/json", delivery_mode: 2 },
      routing_key: eventRow.routing_key,
      payload: "invalid JSON",
      payload_encoding: "string",
    }),
  });
  assert(poisonRes.ok, "poison publish failed");
  await waitUntil(async () => {
    const line = compose("exec", "-T", "rabbitmq", "rabbitmqctl", "-q", "list_queues", "-p", "supplywok", "name", "messages_ready")
      .split(/\r?\n/)
      .find((l) => l.startsWith("operations.events.dlq"));
    const now = Number(line?.split(/\s+/)[1] ?? 0);
    return now > dlqBefore;
  }, 45000, "DLQ increment");
  console.log("PASS | QA-02 Dead Letter Queue | Invalid payload routed to operations.events.dlq without loop");

  // 6. QA-02 Service Isolation & Circuit Breaker
  compose("stop", "inventory-service");
  try {
    for (let i = 0; i < 6; i++) {
      const r = await req("/supplies", null, owner);
      assert(r.status === 503, `expected 503 when inventory stopped, got ${r.status}`);
    }
    const alertsOk = await req("/restaurant/alerts", null, owner);
    assert(alertsOk.status === 200, `expected operations alerts 200, got ${alertsOk.status}`);
    console.log("PASS | QA-02 Circuit Breaker | Inventory returned HTTP 503 while Operations alerts stayed HTTP 200");
  } finally {
    compose("start", "inventory-service");
  }
  await waitUntil(async () => (await req("/supplies", null, owner)).status === 200, 120000, "inventory recovery");
  console.log("PASS | QA-02 Recovery | Inventory route recovered to HTTP 200 after container restart");
}

main().catch((err) => {
  console.error("FAIL |", err);
  process.exit(1);
});
