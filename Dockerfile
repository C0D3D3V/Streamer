FROM node:lts-alpine

# Install FFmpeg + Intel VA-API / QSV runtime libs
RUN apk add --no-cache \
    ffmpeg \
    su-exec \
    libva \
    libva-intel-driver \
    intel-media-driver \
    mesa-va-gallium

WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy source
COPY . .

# Entrypoint handles PUID/PGID/UMASK
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

VOLUME ["/data"]

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
