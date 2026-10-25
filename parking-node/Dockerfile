FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
CMD ["node", "--require", "./src/tracing.js", "src/index.js"]
