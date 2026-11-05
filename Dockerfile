FROM node:22-alpine
WORKDIR /app
COPY server.js db.js ai.js game.js ./
COPY public ./public
ENV DATA_DIR=/data
ENV PORT=8080
EXPOSE 8080
VOLUME /data
CMD ["node", "server.js"]
