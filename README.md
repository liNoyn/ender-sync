# Ender Sync

Minecraft Bedrock Dedicated Server (BDS) 向けの、エンダーチェスト共有システムです。複数のサーバー(ワールド)間で、プレイヤーのエンダーチェストを持ち運べます。

[rometet/inventory-sync](https://github.com/rometet/inventory-sync) の仕組み(Behavior Pack + Node.js API、保存したらclear、読み込みは1回だけ)を参考にしています。元リポジトリにはライセンスの記載がなく、作者への確認は取れていません。ただし通常のインベントリ同期・DB方式・XP共有などの機能は含みません。

## 構成

```text
.
├─ behavior_packs/endersync_bp/   # Behavior Pack (TypeScript / Script API)
├─ endersync_vps/                 # 保存用 API (Node.js + Express)
├─ tools/prepare_endersync_bds_pack.ps1
└─ CHANGELOG.md
```

## コマンド

```mcfunction
/endersync:save     エンダーチェストを保存し、保存できたスロットだけclearする
/endersync:load     保存データを即時復元する(BDSの停止は不要)
/endersync:status   保存状況を確認する
```

### 動作

- 保存データは1プレイヤーにつき1つです。`load` に成功すると消費され、もう一度 `load` はできません。
- 未適用の保存データがある状態での `save` は拒否されます(API側でも拒否します)。
- `load` は、保存データのスロットがエンダーチェスト内で埋まっていると、何も変更せずに失敗します。それ以外のスロットには触りません。
- 復元に失敗した場合は、書き込んだスロットを空に戻し、保存データを未適用の状態に戻します。
- 読めないシュルカーボックスなど、安全に保存できないスロットは保存せずエンダーチェストに残します。
- 保存のたびに、API側の `_history/` に保存内容のコピーを残します。管理者が手作業で戻すための安全策で、ゲーム内コマンドはありません。
- 複数サーバーで共有するには、全サーバーで同じ API とトークンを使い、`serverId` / `worldId` / `worldName` だけを変えます。

## セットアップ

### 1. API

```bash
cd endersync_vps
npm install
npm run build

export ENDERSYNC_API_TOKEN=長いランダム文字列
export ENDERSYNC_DATA_DIR=/srv/endersync-data
export ENDERSYNC_BIND_HOST=127.0.0.1
export PORT=3000
npm start
```

HTTPS 化する場合のリバースプロキシ例は `endersync_vps/deploy/Caddyfile`、systemd の例は `endersync_vps/deploy/endersync-api.service` にあります。

### 2. Behavior Pack

```bash
cd behavior_packs/endersync_bp
npm install --legacy-peer-deps
npm run build
```

接続先とワールド情報は `scripts/util/config.ts` の `apiBaseUrl` / `apiToken` / `serverId` / `worldId` / `worldName` です。BDS用にまとめる場合は次のスクリプトが、設定を埋め込んだバンドルとZIPを作ります。

```powershell
pwsh -File .\tools\prepare_endersync_bds_pack.ps1 -ApiBaseUrl "https://your-endersync-api.example.com" -ApiToken "<token>" -ServerId survival -WorldId survival -WorldName "Survival"
```

生成物 `bds_ready/` には API トークンが入るため、共有や Git 管理はしないでください。

### 3. BDS

- `behavior_packs/endersync_bp` を BDS の `behavior_packs` に置き、ワールドに適用します。
- `config/<script-module-uuid>/permissions.json`(バンドルに含まれます)を BDS の `config` に置きます。`allowed_uris` に API の URL が必要です。
- `@minecraft/server-net` がベータAPIのため、ワールドで「Beta APIs」実験を有効にします。

## API

すべて Bearer トークン認証です。

| メソッド | パス | 内容 |
| --- | --- | --- |
| POST | `/api/ender/save` | 保存。未適用の別スナップショットがあれば 409 |
| GET | `/api/ender/load` | 取得して消費(2回目は `consumed: true`) |
| GET | `/api/ender/status` | 保存状況 |
| POST | `/api/ender/audit/load` | 復元の監査ログを記録 |

監査ログは `<dataDir>/_audit/<日付>.ndjson` に追記されます。

## 開発

```bash
cd endersync_vps && npm test          # 保存・消費・上書き拒否などのテスト
cd behavior_packs/endersync_bp && npm run check
```

## Credits

このプロジェクトは **rometet** さんの [inventory-sync](https://github.com/rometet/inventory-sync) を参考に作っています。Behavior Pack + Node.js API という全体の設計と、次のファイルの元になっているコードは rometet さんのものです(各ファイルの先頭にも出典を書いています)。

- `behavior_packs/endersync_bp/scripts/inventory/itemSerializer.ts`
- `behavior_packs/endersync_bp/scripts/inventory/itemDeserializer.ts`
- `behavior_packs/endersync_bp/scripts/net/apiClient.ts`
- `behavior_packs/endersync_bp/scripts/util/chat.ts`
- `behavior_packs/endersync_bp/scripts/util/logger.ts`
- `behavior_packs/endersync_bp/scripts/domain/playerIdentity.ts`

## 制限

- プレイヤーの識別は `player.name`(小文字化)です。改名すると別人扱いになります。
- 保存データは1人につき1つで、履歴を引き出すコマンドはありません。
- Script API が読めない携帯収納の中身は保存できません。
- API 層のテストと HTTP 経由の動作確認は行いましたが、実機の BDS での動作確認はまだ行っていません。
