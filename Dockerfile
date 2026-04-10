FROM node:20-alpine

RUN apk add --no-cache python3 py3-pip && \
    pip3 install --no-cache-dir --break-system-packages yt-dlp pycryptodomex

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

EXPOSE 3000

USER node

CMD ["node", "src/server.js"]
