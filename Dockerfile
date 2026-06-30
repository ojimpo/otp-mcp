FROM node:22-slim AS builder
WORKDIR /app
COPY package.json ./
RUN npm install --ignore-scripts
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:22-slim
WORKDIR /app
# plan_route_map のタイムライン図に日本語を描くためのフォント（@napi-rs/canvasが参照）。
RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts
COPY --from=builder /app/build/ build/

ENV TRANSPORT=http
ENV PORT=3000
ENV OTP_BASE_URL=http://otp:8080

EXPOSE 3000
CMD ["node", "build/index.js"]
