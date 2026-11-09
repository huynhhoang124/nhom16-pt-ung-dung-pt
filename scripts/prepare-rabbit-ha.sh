#!/usr/bin/env bash
# Existing streams do not gain replicas automatically when the other brokers join.
set -euo pipefail
broker() { docker compose exec -T rabbitmq "$@"; }
for node in rabbitmq rabbitmq-2 rabbitmq-3; do
  for attempt in {1..30}; do
    if docker compose exec -T "$node" rabbitmq-diagnostics -q check_running; then break; fi
    if [[ $attempt == 30 ]]; then exit 1; fi
    sleep 2
  done
done

for node in rabbit@rabbitmq-2 rabbit@rabbitmq-3; do
  for attempt in {1..30}; do
    status=$(broker rabbitmq-streams stream_status events.stream)
    if grep -Fq "$node" <<< "$status"; then break; fi
    broker rabbitmq-streams add_replica events.stream "$node" || true
    if [[ $attempt == 30 ]]; then
      broker rabbitmq-streams stream_status events.stream
      exit 1
    fi
    sleep 2
  done
done

for attempt in {1..30}; do
  if broker rabbitmq-diagnostics -q check_if_node_is_quorum_critical; then exit 0; fi
  sleep 2
done
exit 1
