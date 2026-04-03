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
    make \
    g++ \
    pkgconfig

# Make npm/node-gyp explicitly use Python 3
ENV PYTHON=/usr/bin/python3

COPY package.json package-lock.json* ./
RUN npm config set python /usr/bin/python3 \
    && npm install --omit=dev \
    && npm config delete python

# Remove build deps after native modules are compiled
RUN apk del .build-deps

COPY . .

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000
VOLUME ["/data"]

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/index.js"]