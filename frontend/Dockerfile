FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.29-alpine
# Ảnh nginx chạy envsubst trên /etc/nginx/templates khi khởi động, chỉ thay biến môi trường đã đặt.
# PT-05: địa chỉ công khai các bãi để trình duyệt nhân viên gọi thẳng bãi khi Aggregator dừng.
ENV NODE_ORIGINS="http://localhost:8001 http://localhost:8002 http://localhost:8003 http://localhost:8004 http://localhost:8005 http://localhost:8006"
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
