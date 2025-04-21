FROM node:20-alpine

# 作業ディレクトリを設定
WORKDIR /app

# パッケージ関連のファイルをコピー
COPY package*.json ./
COPY tsconfig*.json ./

# 依存関係をインストール (ビルドスクリプトを実行しない)
RUN npm ci --ignore-scripts --no-audit

# ソースファイルをコピー
COPY ./src ./src

# テスト用ワーカーファイルだけビルド
RUN mkdir -p dist/tests/e2e/workers
# より単純なアプローチ - TypeScriptをコンパイルせずにファイルをコピー
RUN mkdir -p dist/tests/e2e/workers
RUN cp src/tests/e2e/workers/test-worker.ts dist/tests/e2e/workers/test-worker.js
RUN cp -r src/* dist/

# ワーカー実行環境の設定
ENV NODE_ENV=production
ENV RABBITMQ_URL=amqp://guest:guest@rabbitmq:5672

# ポートは公開しない（ワーカープロセスは通信リスナーを持たない）

# E2Eテスト用ワーカープロセスを起動
CMD ["node", "--loader", "ts-node/esm", "dist/tests/e2e/workers/test-worker.js"] 