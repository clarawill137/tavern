FROM node:22-alpine
WORKDIR /app
# все серверные .js разом — чтобы новый модуль не забывался (как game.js в v3)
COPY *.js ./
COPY public ./public
ENV DATA_DIR=/data
ENV PORT=8080
EXPOSE 8080
VOLUME /data
CMD ["node", "server.js"]
