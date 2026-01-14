# StandX 自动化挂单机器人

一个简洁的 NodeJS 脚本，用于在 StandX Pre-DEX 平台上自动化执行 BTC 动态挂单策略，目的是获取积分同时避免订单成交。

## 功能特性

- **自动化挂单**：在 BTC-USD 交易对上自动挂 Bid（买入）订单
- **动态调仓**：监听价格变化，当价格偏离超过 1% 时自动取消并重新挂单
- **避免成交**：挂单价格设置为 `当前价格 * (1 - 1.5%)`，远离市场价格
- **Redis 配置**：从 Redis 读取账号信息和敏感数据
- **实时价格监听**：使用 WebSocket 实时获取价格数据

## 前置要求

- Node.js 14+
- Redis 服务器
- StandX 账号（BSC 或 Solana 链）
- 钱包私钥

## 安装

```bash
cd standx-bot
npm install
```

## 配置

### 1. 准备账号信息

首先，您需要准备以下信息：

- **chain**: 区块链网络，`bsc` 或 `solana`
- **walletAddress**: 您的钱包地址
- **privateKey**: 您的钱包私钥（用于签名）
- **signingKey**: 用于请求签名的 ed25519 私钥（Base64 编码）

### 2. 生成 Signing Key

如果您没有 signing key，可以使用以下 Node.js 代码生成：

```javascript
const { generateEd25519KeyPair } = require('./auth');

const { privateKey } = generateEd25519KeyPair();
const signingKeyBase64 = Buffer.from(privateKey).toString('base64');
console.log('Signing Key (Base64):', signingKeyBase64);
```

### 3. 将配置存储到 Redis

使用 Redis CLI 或任何 Redis 客户端，将配置存储为 JSON：

```bash
redis-cli
> SET standx:account:1 '{"chain":"bsc","walletAddress":"0x...","privateKey":"0x...","signingKey":"..."}'
```

或者使用 Node.js：

```javascript
const redis = require('redis');
const client = redis.createClient();
await client.connect();

const config = {
  chain: 'bsc',
  walletAddress: '0x...',
  privateKey: '0x...',
  signingKey: 'base64_encoded_key',
  symbol: 'BTC-USD'
};

await client.set('standx:account:1', JSON.stringify(config));
```

## 运行

### 基本运行

```bash
node main.js
```

### 使用环境变量

```bash
# 指定 Redis 连接
REDIS_HOST=localhost REDIS_PORT=6379 node main.js

# 指定账号配置 Key
ACCOUNT_KEY=standx:account:1 node main.js
```

### 完整示例

```bash
REDIS_HOST=localhost REDIS_PORT=6379 ACCOUNT_KEY=standx:account:1 node main.js
```

## 工作流程

1. **初始化**：连接 Redis，读取账号配置
2. **认证**：使用钱包私钥进行 StandX 认证，获取 JWT Token
3. **价格监听**：连接 WebSocket，订阅 BTC-USD 价格频道
4. **初始挂单**：根据当前价格计算并挂初始 Bid 订单
   - 挂单价格 = `当前价格 * (1 - 0.015)` = `当前价格 * 0.985`
5. **动态调仕**：监听价格变化
   - 如果 `当前价格 < (初始价格 * 0.99)` 或 `当前价格 > (初始价格 * 1.01)`
   - 则取消旧订单，按最新价格重新计算并挂新订单

## 配置参数说明

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `chain` | 区块链网络 | 必需 |
| `walletAddress` | 钱包地址 | 必需 |
| `privateKey` | 钱包私钥 | 必需 |
| `signingKey` | 签名密钥（Base64） | 必需 |
| `symbol` | 交易对 | `BTC-USD` |

## 策略参数

在 `strategy.js` 中可以调整以下参数：

```javascript
this.offsetPercentage = 0.015;      // 挂单价格偏移（1.5%）
this.priceChangeThreshold = 0.01;   // 价格变化触发阈值（1%）
```

## 日志输出

脚本会输出详细的日志，包括：

- Redis 连接状态
- 认证过程
- WebSocket 连接状态
- 订单创建和取消
- 价格变化和重新挂单

## 错误处理

脚本包含以下错误处理机制：

- **Redis 连接失败**：如果 Redis 不可用，脚本会立即退出
- **认证失败**：如果钱包签名失败或 API 返回错误，脚本会退出
- **WebSocket 连接失败**：自动重连，最多尝试 10 次
- **订单操作失败**：记录错误但继续运行

## 安全建议

1. **私钥保护**：不要在代码中硬编码私钥，始终使用环境变量或 Redis
2. **代理配置**：如果需要使用代理，可以在 axios 配置中添加
3. **Token 管理**：JWT Token 有效期为 7 天，脚本不会自动续期，需要重启以获取新 Token
4. **Redis 安全**：确保 Redis 服务器只允许本地访问或使用密码保护

## 故障排查

### 连接失败

```
Error: connect ECONNREFUSED 127.0.0.1:6379
```

**解决**：确保 Redis 服务器正在运行

```bash
redis-server
```

### 认证失败

```
Error: Authentication failed: Invalid signature
```

**解决**：检查钱包私钥和地址是否正确

### 订单创建失败

```
Error: Failed to place order: 400 Bad Request
```

**解决**：检查交易对是否正确，账户是否有足够的保证金

## 文件结构

```
standx-bot/
├── main.js           # 主程序入口
├── config.js         # Redis 配置管理
├── auth.js           # 认证和签名
├── api.js            # HTTP API 调用
├── ws.js             # WebSocket 价格监听
├── strategy.js       # 挂单策略
├── package.json      # 项目依赖
└── README.md         # 本文档
```

## 依赖包

- **axios**: HTTP 客户端
- **redis**: Redis 客户端
- **ws**: WebSocket 客户端
- **ethers**: 以太坊工具库
- **@noble/curves**: 加密曲线库
- **@scure/base**: Base58 编码
- **uuid**: UUID 生成
- **decimal.js**: 精确十进制计算

## 许可证

MIT

## 支持

如有问题或建议，请联系开发者。
