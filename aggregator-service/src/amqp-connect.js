// PT-03: RABBITMQ_URL có thể là DANH SÁCH cách nhau dấu phẩy (cụm nhiều nút). Thử lần lượt, bắt đầu từ nút
// vừa nối được lần trước; nút đó chết thì lần nối lại tự sang nút kế tiếp.
const amqp = require('amqplib');

function makeConnector(urls, connect = amqp.connect) {
  const list = String(urls).split(',').map((s) => s.trim()).filter(Boolean);
  let start = 0;
  return async function connectAny() {
    let last;
    for (let i = 0; i < list.length; i++) {
      const k = (start + i) % list.length;
      try {
        const conn = await connect(list[k]);
        start = k;
        return conn;
      } catch (e) { last = e; }
    }
    start = (start + 1) % list.length;   // lần sau bắt đầu ở nút khác
    throw last;
  };
}

module.exports = { makeConnector };
