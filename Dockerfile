FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY abi ./abi
COPY src ./src
COPY web ./web
ENV PORT=8787 HOST=0.0.0.0 CHECKPOINT_PATH=/data/checkpoint.json
VOLUME ["/data"]
EXPOSE 8787
USER node
CMD ["node", "src/server.js"]
