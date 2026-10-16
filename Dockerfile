# CTD Overlay (the Stream Kit Platform) as a container (10 §10.3). No npm dependencies: Node's
# own runtime and node:sqlite. ffmpeg converts phone video for OBS (H12); tzdata so shows run on
# their own clocks. Runs as UID/GID 568, TrueNAS's "apps" user (docker run --user to change it).
FROM node:24-alpine

RUN apk add --no-cache ffmpeg tzdata \
 && mkdir -p /data /config \
 && chown 568:568 /data /config

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY templates ./templates
COPY scripts ./scripts
# The template manifest's schema, which the platform validates templates against.
COPY docs/standard/schemas ./docs/standard/schemas

ENV NODE_ENV=production \
    SKP_DATA_DIR=/data \
    SKP_CONFIG_DIR=/config \
    SKP_EXPOSURE=lan \
    SKP_PORT=4848 \
    TZ=America/Toronto

# /data (database, media, templates) and /config (the master key) are separate on purpose: a
# backup of the data never holds the key that decrypts its secrets (07 §7.7).
VOLUME ["/data", "/config"]
EXPOSE 4848
USER 568:568

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4848/healthz || exit 1

CMD ["node", "src/main.js"]
