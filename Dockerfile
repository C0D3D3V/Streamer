FROM node:lts-alpine

# Runtime deps
RUN apk add --no-cache \
    ffmpeg \
    su-exec \
    libva \
    libva-intel-driver \
    intel-media-driver \
    mesa-va-gallium

WORKDIR /app

# Build deps needed by node-gyp for native modules like better-sqlite3
RUN apk add --no-cache --virtual .build-deps \
    python3 \
    py3-setuptools \
    make \
    g++ \
    pkgconfig

COPY package.json package-lock.json* ./
ENV PYTHON=/usr/bin/python3
RUN npm install --omit=dev

# Remove build deps after native modules are compiled
RUN apk del .build-deps

# Copy source
COPY . .

# Entrypoint handles PUID/PGID/UMASK
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

VOLUME ["/data"]

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/index.js"]