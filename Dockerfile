FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        ca-certificates \
        curl \
    && update-ca-certificates \
    && pip3 install --no-cache-dir -U yt-dlp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

USER node

EXPOSE 3000

CMD ["npm", "start"]
