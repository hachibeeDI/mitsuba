# テスト

Mitsubaでは以下の3種類のテスト方法を用意しています：

1. **単体テスト**: 個々のコンポーネントをテスト
2. **結合テスト**: モックを使った複数コンポーネントの連携テスト
3. **E2Eテスト**: 実際のRabbitMQを使った完全統合テスト

## E2Eテストの実行方法

E2Eテストでは実際のRabbitMQサーバーと**独立したワーカープロセス**を使用して、タスクの登録、実行、結果取得の全フローをテストします。

### 準備

1. Docker と Docker Compose がインストールされていることを確認してください。

2. 以下のコマンドでE2Eテスト環境を起動します：

```bash
# E2Eテスト環境をセットアップ（RabbitMQとワーカープロセスを起動）
npm run e2e:setup
```

3. 環境の起動を確認します：

```bash
# コンテナの状態確認
npm run e2e:status

# ワーカーログの確認
npm run e2e:logs:worker

# RabbitMQのログ確認
npm run e2e:logs:rabbitmq
```

RabbitMQの管理画面は http://localhost:15672 でアクセスできます（ユーザー名/パスワード: guest/guest）。

### テストの実行

環境が起動したら、以下のコマンドでE2Eテストを実行します：

```bash
# すべてのE2Eテストを実行
npm run test:e2e

# 特定のE2Eテストのみを実行する場合
npm run test -- src/tests/e2e/basic.test.ts
```

または、環境のセットアップからテスト実行まで一括で行うこともできます：

```bash
# 環境セットアップ＋テスト実行
npm run e2e:run

# 環境セットアップ＋テスト実行＋環境クリーンアップの全フロー
npm run e2e:full
```

### テスト終了後

テスト完了後、以下のコマンドで環境をクリーンアップできます：

```bash
# 環境停止（コンテナは保持）
npm run e2e:stop

# または完全にクリーンアップ（コンテナも削除）
npm run e2e:clean
```

### ワーカープロセスの再ビルド

コードを変更した場合は、ワーカープロセスを再ビルドする必要があります：

```bash
# ワーカーコンテナを再ビルド
npm run e2e:rebuild
```

詳細なE2Eテスト手順は [src/tests/e2e/README.md](./src/tests/e2e/README.md) を参照してください。

## テスト開発ガイドライン

新しいE2Eテストを開発する際は以下の点に注意してください：

1. **実環境を想定**: 実際の運用環境に近い形でテストを設計する
2. **タイムアウト設定**: ネットワーク通信を伴うため、適切なタイムアウト値を設定する
3. **リソース管理**: テスト前後で確実にリソース（接続など）を解放する
4. **並行性考慮**: 複数テストの並行実行による干渉を防ぐため、ユニークな識別子を使用する
