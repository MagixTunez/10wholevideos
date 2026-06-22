FROM node:20-bookworm-slim

WORKDIR /app

# FFmpeg/ffprobe are required by client.ts for segment generation.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY client.ts ./
COPY tsconfig.json ./
COPY README.md ./

EXPOSE 5181

CMD ["node", "client.ts"]
