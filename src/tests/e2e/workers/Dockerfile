FROM node:23-alpine

# 作業ディレクトリを設定
WORKDIR /app

# パッケージ関連のファイルをコピー
COPY package*.json ./
COPY tsconfig*.json ./

# 依存関係をインストール (ビルドスクリプトを実行しない)
RUN npm ci --ignore-scripts --no-audit

# ソースファイルをコピー
COPY ./src ./src

# ポートは公開しない（ワーカープロセスは通信リスナーを持たない）

# E2Eテスト用ワーカープロセスを起動
CMD ["npx", "ts-node", "--project", "tsconfig.mjs.json", "src/tests/e2e/workers/test-worker.ts"]