// GS-03: log có cấu trúc, mỗi dòng một JSON. requestId đi theo request nhờ AsyncLocalStorage (có sẵn trong Node),
// được gửi tiếp qua header X-Request-Id và vào bản tin RabbitMQ (correlationId)
// -> lần theo một request qua mọi dịch vụ:  docker compose logs | grep <requestId>
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');

const als = new AsyncLocalStorage();
const service = process.env.SERVICE_NAME ?? `aggregator-${process.env.INSTANCE_ID ?? '1'}`;
const silent = !!process.env.NODE_TEST_CONTEXT;   // chạy dưới node --test: không in log

const requestId = () => als.getStore()?.requestId;

function write(level, msg, fields) {
  if (silent) return;
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, service, requestId: requestId(), msg, ...fields }));
}
const log = { info: (msg, f) => write('info', msg, f), error: (msg, f) => write('error', msg, f) };
log.log = log.info;   // tương thích chỗ nhận đối tượng kiểu console

// Middleware Express: nhận X-Request-Id (hoặc tạo mới), trả lại trong response, log mỗi request khi xong.
function withRequestId(req, res, next) {
  const incoming = req.get('x-request-id');
  const id = /^[\w-]{1,64}$/.test(incoming ?? '') ? incoming : randomUUID();
  res.set('x-request-id', id);
  const t0 = performance.now();
  res.on('finish', () => {
    if (req.path === '/health' || req.path === '/metrics') return;
    als.run({ requestId: id }, () => log.info('http', {
      method: req.method, path: req.originalUrl, status: res.statusCode, ms: Math.round(performance.now() - t0),
    }));
  });
  als.run({ requestId: id }, next);
}

module.exports = { log, withRequestId, requestId };
