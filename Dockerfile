FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production DB_PATH=/app/data/scheduler.db
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
RUN mkdir data && chown node:node data
USER node
VOLUME /app/data
EXPOSE 3000
HEALTHCHECK CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Run node directly (not npm) so SIGTERM reaches the graceful-shutdown handler.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
