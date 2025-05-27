FROM node:23-alpine

# 作業ディレクトリを設定
WORKDIR /app

# パッケージ関連のファイルをコピー
COPY package*.json ./
COPY tsconfig*.json ./

# Monorepo構造に対応するため、packagesディレクトリもコピー
COPY ./packages ./packages

# ソースファイルをコピー
COPY ./src ./src

# 依存関係をインストール (ビルドスクリプトを実行しない)
RUN npm ci --ignore-scripts --no-audit

# ポートは公開しない（ワーカープロセスは通信リスナーを持たない）

# E2Eテスト用ワーカープロセスを起動
ENTRYPOINT ["npx", "ts-node", "--project", "tsconfig.mjs.json", "--require", "tsconfig-paths/register"]
CMD ["src/tests/e2e/workers/test-worker.ts"]