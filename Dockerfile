FROM node:20-slim

# Add non-free components for Intel media driver
RUN sed -i 's/Components: main$/Components: main contrib non-free non-free-firmware/' \
        /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        intel-media-va-driver-non-free \
        libvpl2 \
        libmfx1 \
        gosu \
    && rm -rf /var/lib/apt/lists/*

# iHD is the correct VAAPI driver for Gen 9+ Intel (Skylake and newer)
ENV LIBVA_DRIVER_NAME=iHD

WORKDIR /app

COPY package.json package-lock.json* ./
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ \
    && npm ci --omit=dev \
    && apt-get purge -y python3 make g++ \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY . .

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000
VOLUME ["/data"]

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
