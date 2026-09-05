FROM node:18-alpine

RUN apk add --no-cache sqlite

WORKDIR /app

COPY webhook/package*.json ./

RUN npm install --production

COPY webhook/server.js ./

EXPOSE 3001

CMD ["node", "server.js"]
