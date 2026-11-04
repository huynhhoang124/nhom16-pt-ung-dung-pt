FROM node:22-alpine
WORKDIR /app/parking-node
COPY parking-node/package*.json ./
RUN npm ci
COPY parking-node/src ./src
COPY parking-node/test ./test
# Existing node tests also verify producer signing/logging and replication configuration.
COPY aggregator-service/src/command-signature.js aggregator-service/src/log.js /app/aggregator-service/src/
COPY aggregator-service/src/command-transfer.js aggregator-service/src/retry-contract.js /app/aggregator-service/src/
COPY docker-compose.yml docker-compose.ha.yml /app/
# log.js của Aggregator dùng @opentelemetry/api (PD-24): dùng chung node_modules của parking-node.
RUN ln -s /app/parking-node/node_modules /app/aggregator-service/node_modules
CMD ["node", "--test", "--test-concurrency=2", "test/*.test.js"]
