# solo shorts — Render free (Docker, Node 20 + ffmpeg)
# No native modules: only pure-JS dependencies, so a single stage is enough.
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY assets ./assets
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
