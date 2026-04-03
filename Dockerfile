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

# Build deps - C++20 compiler + node-gyp deps
RUN apk add --no-cache --virtual .build-deps \
    python3 \
    py3-setuptools \
    make \
    g++ \
    gcc \
    pkgconfig \
    libstdc++

# Force C++20 standard for Node 24 V8 headers
ENV CXXFLAGS="-std=c++20"

COPY package.json package-lock.json* ./
ENV PYTHON=/usr/bin/python3
RUN npm install --omit=dev

# Clean build deps
RUN apk del .build-deps

# Copy source
COPY . .

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000
VOLUME ["/data"]

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/index.js"]