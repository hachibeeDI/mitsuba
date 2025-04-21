# Mitsuba E2Eテスト

このディレクトリには、Mitsubaの完全なEnd-to-Endテストが含まれています。
これらのテストは実際のRabbitMQサーバーと独立したワーカープロセスを使用して、実運用環境に近い形でMitsubaの機能を検証します。

## テスト環境

E2Eテスト環境は、以下のコンポーネントで構成されています：

1. **RabbitMQサーバー**: メッセージブローカーとしてのRabbitMQ
2. **独立したワーカープロセス**: 別コンテナとして実行される複数のワーカー
3. **テストクライアント**: テストを実行するプロセス（ローカルマシン上で実行）

## 環境構築と実行

### 1. 環境起動

以下のコマンドでE2Eテスト環境を起動します：

```bash
# E2Eテスト環境をセットアップ
npm run e2e:setup
```

これにより、RabbitMQサーバーと2つの独立したワーカープロセスがDockerコンテナ内で起動します。

### 2. 環境確認

環境が正常に起動したことを確認します：

```bash
# コンテナの状態確認
npm run e2e:status

# すべてのログを確認
npm run e2e:logs

# 特定のサービスのログを確認
npm run e2e:logs:worker
npm run e2e:logs:rabbitmq
```

RabbitMQ管理画面は http://localhost:15672 でアクセスできます（ユーザー名/パスワード: guest/guest）。

### 3. テスト実行

E2Eテストを実行する方法は複数あります：

```bash
# 方法1: 環境が既に起動している場合、テストのみ実行
npm run test:e2e

# 方法2: 特定のテストのみ実行
npm run test -- src/tests/e2e/basic.test.ts

# 方法3: 環境セットアップ＋テスト実行（一括実行）
npm run e2e:run

# 方法4: 環境セットアップ＋テスト実行＋環境クリーンアップ（フルサイクル）
npm run e2e:full
```

### 4. テスト終了と環境クリーンアップ

テスト完了後、環境をクリーンアップします：

```bash
# 環境停止（コンテナは保持）
npm run e2e:stop

# または完全にクリーンアップ（コンテナも削除）
npm run e2e:clean
```

## ワーカープロセスの更新

ワーカープロセスのコードを変更した場合は、再ビルドして再起動する必要があります：

```bash
# 1. ワーカーコンテナを再ビルド
npm run e2e:rebuild

# 2. 環境を再起動
npm run e2e:stop
npm run e2e:setup
```

## テスト構成

E2Eテストは以下のファイルで構成されています：

- `basic.test.ts` - 基本的な機能のテスト
- `advanced.test.ts` - 高度な機能（チェーン処理、優先度など）のテスト
- `error-handling.test.ts` - エラー処理に特化したテスト
- `workers/` - 独立したワーカープロセス関連ファイル
  - `test-worker.ts` - ワーカープロセスの実装
  - `Dockerfile` - ワーカーコンテナ用Dockerfile

## 環境変数

ワーカープロセスは以下の環境変数で設定できます（docker-compose.ymlで定義）：

- `RABBITMQ_URL` - RabbitMQの接続URL（デフォルト: `amqp://guest:guest@rabbitmq:5672`）
- `WORKER_ID` - ワーカーの識別子（デフォルト: `worker-1`）
- `CONCURRENCY` - 同時処理数（デフォルト: `3`）
- `APP_NAME` - アプリケーション名（デフォルト: `e2e-test-worker`）

## トラブルシューティング

### ワーカーが起動しない

```bash
# ワーカーのログを確認
npm run e2e:logs:worker

# イメージを再ビルド
npm run e2e:rebuild
```

### テストが失敗する

```bash
# RabbitMQの状態を確認
npm run e2e:logs:rabbitmq

# 環境をクリーンアップして再度セットアップ
npm run e2e:clean
npm run e2e:setup
```

### 注意点

- E2Eテストでは、テストクライアント（ローカルマシン）とワーカー（Dockerコンテナ）が別々のプロセスとして実行されます。
- テストクライアントは、RabbitMQサーバーにローカルからアクセスします。
- RabbitMQサーバーとワーカーは同じDockerネットワーク内で実行されるため、コンテナ間通信はホスト名で行われます。 