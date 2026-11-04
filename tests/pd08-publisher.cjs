// Test-only deadline configuration using the existing PD-01 send contract.
// No changes to the publisher/PD-03 defaults are needed for the 2s + 10s test.
const { makeCommands } = require("../aggregator-service/src/commands");
function makeTestCommands(url, { ttlMs = 60000, replyTo, ...options } = {}) {
  const publisher = makeCommands(url, options);
  return {
    send(parkingId, type, body, opts = {}) {
      const issuedAt = opts.issuedAt ?? Date.now();
      const deadlineAt = opts.deadlineAt ?? issuedAt + ttlMs;
      return publisher.send(parkingId, type, body, {
        ...opts,
        issuedAt,
        deadlineAt,
        replyTo: opts.replyTo ?? replyTo,
        expiration: Math.max(1, deadlineAt - Date.now()),
      });
    },
    close: () => publisher.close(),
  };
}
module.exports = { makeTestCommands };
