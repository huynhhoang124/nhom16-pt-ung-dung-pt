if (process.env.OTEL_SDK_DISABLED === 'true') {
  module.exports = { shutdown: async () => {} };
} else {
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');

  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'parking-node',
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-amqplib': { enabled: false },
    })],
  });

  sdk.start();

  module.exports = { shutdown: () => sdk.shutdown() };
}
