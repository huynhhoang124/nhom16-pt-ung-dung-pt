#!/bin/sh
# Run inside the root broker after starting all three nodes.
set -eu

wait_for() {
  attempt=1
  until "$@"; do
    if [ "$attempt" -ge 30 ]; then
      echo "RabbitMQ HA readiness failed: $*" >&2
      return 1
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
}

for node in rabbit@rabbitmq rabbit@rabbitmq-2 rabbit@rabbitmq-3; do
  wait_for rabbitmq-diagnostics -n "$node" -q check_running
done

stream_member() {
  status=$(rabbitmq-streams stream_status events.stream) || return 1
  if printf '%s\n' "$status" | grep -Eq "(^|[^[:alnum:]@.-])$1([^[:alnum:]@.-]|$)"; then return 0; fi
  rabbitmq-streams add_replica events.stream "$1" || return 1
  return 1
}

# Queues and streams may be declared before the peer brokers join.
for node in rabbit@rabbitmq rabbit@rabbitmq-2 rabbit@rabbitmq-3; do
  rabbitmq-queues grow "$node" all
  wait_for stream_member "$node"
done

for node in rabbit@rabbitmq rabbit@rabbitmq-2 rabbit@rabbitmq-3; do
  wait_for rabbitmq-diagnostics -n "$node" -q check_if_node_is_quorum_critical
done
