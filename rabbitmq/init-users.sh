#!/bin/sh
# Creates the vhost and one RabbitMQ user per microservice with least-privilege permissions (ADR-008).
# Runs once in a curl-based container against the RabbitMQ management HTTP API.
set -eu

API="http://${RABBITMQ_HOST:-rabbitmq}:${RABBITMQ_MANAGEMENT_PORT:-15672}/api"
AUTH="${RABBITMQ_ADMIN_USER}:${RABBITMQ_ADMIN_PASS}"
VHOST="supplywok"

echo "Waiting for the RabbitMQ management API..."
tries=0
until curl -sf -u "$AUTH" "$API/overview" > /dev/null; do
    tries=$((tries + 1))
    if [ "$tries" -ge 60 ]; then
        echo "RabbitMQ management API not reachable after 120 s" >&2
        exit 1
    fi
    sleep 2
done

curl -sf -u "$AUTH" -X PUT "$API/vhosts/$VHOST" -H "content-type: application/json" -d '{}'
echo "vhost '$VHOST' ready"

# $1 user, $2 password, $3 configure, $4 write, $5 read (regexes already JSON-escaped)
grant() {
    curl -sf -u "$AUTH" -X PUT "$API/users/$1" -H "content-type: application/json" \
        -d "{\"password\":\"$2\",\"tags\":\"\"}"
    curl -sf -u "$AUTH" -X PUT "$API/permissions/$VHOST/$1" -H "content-type: application/json" \
        -d "{\"configure\":\"$3\",\"write\":\"$4\",\"read\":\"$5\"}"
    echo "user '$1' configured"
}

EX='supplywok\\.events'
OPS='operations\\.events'
PUR='purchasing\\.events'
grant iam_svc        "$IAM_MQ_PASSWORD"        "^$EX\$" "^$EX\$" '^$'
grant inventory_svc  "$INVENTORY_MQ_PASSWORD"  "^$EX\$" "^$EX\$" '^$'
grant operations_svc "$OPERATIONS_MQ_PASSWORD" "^($EX|$OPS)\$" "^$OPS\$" "^($EX|$OPS)\$"
grant purchasing_svc "$PURCHASING_MQ_PASSWORD" "^($EX|$PUR)\$" "^($EX|$PUR)\$" "^($EX|$PUR)\$"

echo "RabbitMQ users and permissions initialized."

# Use policies so existing durable queues can be upgraded without redeclaring them.
if ! curl -fsS -u "$AUTH" "$API/permissions/$VHOST/$RABBITMQ_ADMIN_USER" >/dev/null 2>&1; then
    curl -fsS -u "$AUTH" -X PUT "$API/permissions/$VHOST/$RABBITMQ_ADMIN_USER" \
  -H 'content-type: application/json' -d '{"configure":"^(operations|purchasing)[.]events[.]dlq$","write":"^$","read":"^$"}' >/dev/null
fi
for queue in operations.events purchasing.events; do
    curl -fsS -u "$AUTH" -X PUT "$API/queues/$VHOST/$queue.dlq" \
      -H 'content-type: application/json' -d '{"durable":true,"auto_delete":false,"arguments":{}}' >/dev/null
    pattern=$(printf '%s' "$queue" | sed 's/\./[.]/g')
    curl -fsS -u "$AUTH" -X PUT "$API/policies/$VHOST/$queue-recovery" \
      -H 'content-type: application/json' \
      -d "{\"pattern\":\"^$pattern$\",\"apply-to\":\"queues\",\"definition\":{\"dead-letter-exchange\":\"\",\"dead-letter-routing-key\":\"$queue.dlq\"},\"priority\":1}" >/dev/null
done
