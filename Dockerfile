FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8787 \
    LISTEN_HOST=0.0.0.0 \
    CLAUDE_PROJECTS_DIR=/data/claude-projects

WORKDIR /app
# No runtime dependencies: copy the app as-is, owned by root and read-only to the app user.
COPY package.json ./
COPY src ./src
COPY public ./public
COPY config ./config
# Host checkouts may have restrictive modes (umask 077); make the app world-readable
# but not writable so the unprivileged user can run it without owning it.
RUN chmod -R a+rX,go-w /app

# The official image ships an unprivileged "node" user (uid 1000).
USER node

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
