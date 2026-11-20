FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.mjs lib.mjs ./
CMD ["node", "index.mjs"]
