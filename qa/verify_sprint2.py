"""Run with Python 3 against the disposable Compose project supplywok-s2-qa only."""
import argparse
import json
import secrets
import subprocess
import time
import uuid
from urllib.error import HTTPError
from urllib.request import Request, urlopen

PROJECT = ["docker", "compose", "-p", "supplywok-s2-qa"]


def compose(*args):
    return subprocess.check_output(PROJECT + list(args), text=True).strip()


def sql(query):
    return compose("exec", "-T", "postgres", "psql", "-XAt", "-v", "ON_ERROR_STOP=1",
                   "-U", "postgres", "-d", "supplywok", "-c", query).splitlines()[0]


def wait_until(check, seconds=75):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.3)
    raise AssertionError("Timed out waiting for " + check.__name__)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=28080)
    args = parser.parse_args()
    gateway = f"http://127.0.0.1:{args.port}/api/v1"
    run = uuid.uuid4().hex[:10]

    def request(path, body=None, token=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        req = Request(gateway + path, None if body is None else json.dumps(body).encode(), headers)
        try:
            response = urlopen(req, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            return response.status, response.headers, response.read().decode()

    def account(role):
        login = {"email": f"{role}-{secrets.token_hex(5)}@example.test", "password": secrets.token_urlsafe(16)}
        assert request("/authentication/sign-up", login | {"role": role})[0] in (200, 201)
        status, _, payload = request("/authentication/sign-in", login)
        assert status == 200
        return json.loads(payload)["token"]

    owner, other, supplier = account("Restaurant"), account("Restaurant"), account("Supplier")
    status, headers, _ = request("/supplies")
    assert status == 401 and headers.get("X-Correlation-Id")
    assert request("/supplies", token=supplier)[0] == 403
    print("PASS | Gateway | Missing JWT 401, supplier role 403, correlation ID returned", flush=True)
    def create(name):
        return request("/supplies", {"name": name, "unitOfMeasure": "Units", "currentStock": 1,
                                     "minimumStockLevel": 2, "category": "Sprint2"}, owner)
    def alerts(name):
        status, _, payload = request("/restaurant/alerts", token=owner)
        assert status == 200
        return sum(name in item.get("detail", "") for item in json.loads(payload))

    label = "QA-" + run
    compose("stop", "rabbitmq")
    try:
        status, _, payload = create(label)
        assert status == 201, (status, payload)
        supply_id = json.loads(payload)["id"]
        assert request(f"/supplies/{supply_id}", token=other)[0] == 404
        row = sql("SELECT row_to_json(e) FROM inventory.outbox_events e WHERE payload::jsonb->>'name'='"
                  + label + "'")
        event = json.loads(row)
        assert alerts(label) == 0
        print("PASS | Interrupt broker | Stock HTTP 201, event pending, alerts 0, other restaurant 404", flush=True)
    finally:
        compose("start", "rabbitmq")
    started = time.monotonic()
    wait_until(lambda: alerts(label) == 1, 120)
    event_id = str(uuid.UUID(event["event_id"]))
    assert sql(f"SELECT count(*) FROM operations.processed_events WHERE event_id='{event_id}'") == "1"
    print(f"PASS | Recover broker | One alert after {time.monotonic()-started:.2f}s | eventId={event_id}", flush=True)

    def replay(id_value, body):
        values = [id_value, event["routing_key"], event["event_type"], body]
        quoted = ",".join("'" + v.replace("'", "''") + "'" for v in values)
        sql("INSERT INTO inventory.outbox_events(event_id,routing_key,event_type,payload,occurred_at) VALUES ("
            + quoted + "," + str(event["occurred_at"]) + ")")
        wait_until(lambda: sql(f"SELECT count(*) FROM inventory.outbox_events WHERE event_id='{id_value}'") == "0")
    replay(event_id, event["payload"])
    def dlq_count():
        listing = compose("exec", "-T", "rabbitmq", "rabbitmqctl", "-q", "list_queues", "-p",
                          "supplywok", "name", "messages_ready")
        return next((int(row.split()[1]) for row in listing.splitlines()
                     if row.split() and row.split()[0] == "operations.events.dlq"), 0)
    before = dlq_count()
    poison_id = str(uuid.uuid4())
    replay(poison_id, "invalid JSON")
    wait_until(lambda: dlq_count() > before)
    assert alerts(label) == 1
    print("PASS | Redelivery | Original and duplicate share one event ID and produced one alert", flush=True)
    print("PASS | Dead letter | Unprocessable message isolated in operations.events.dlq", flush=True)
    # Reject only this synthetic event and verify that the stock write rolls back with it.
    rollback = "Rollback-" + run
    constraint = "qa_" + run
    sql(f"ALTER TABLE inventory.outbox_events ADD CONSTRAINT {constraint} CHECK (payload::jsonb->>'name' <> '{rollback}')")
    try:
        assert create(rollback)[0] >= 400
        assert sql(f"SELECT count(*) FROM inventory.supplies WHERE name='{rollback}'") == "0"
        print("PASS | Atomicity | Rejected event rolled back the inventory row", flush=True)
    finally:
        sql(f"ALTER TABLE inventory.outbox_events DROP CONSTRAINT {constraint}")
    durations = []
    for i in range(20):
        name = f"Timing-{run}-{i:02d}."
        started = time.monotonic()
        assert create(name)[0] == 201
        wait_until(lambda: alerts(name) == 1)
        durations.append(time.monotonic()-started)
    p95 = sorted(durations)[18]
    print(f"MEASURE | Healthy broker | 20 sequential stock-to-alert flows | p95={p95:.2f}s", flush=True)
    assert p95 < 5
    compose("stop", "inventory-service")
    try:
        for _ in range(6):
            assert request("/supplies", token=owner)[0] == 503
        assert request("/restaurant/alerts", token=owner)[0] == 200
        print("PASS | Failure isolation | Inventory returned 503, Operations alerts remained HTTP 200", flush=True)
    finally:
        compose("start", "inventory-service")
    wait_until(lambda: request("/supplies", token=owner)[0] == 200, 120)
    print("PASS | Recovery | Inventory route returned HTTP 200 after restart", flush=True)


if __name__ == "__main__":
    main()
