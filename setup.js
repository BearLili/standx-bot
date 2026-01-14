import readline from 'readline';
import redis from 'redis';
import { generateEd25519KeyPair } from './auth.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function setup() {
  console.log('\n=== StandX Bot Setup ===\n');

  try {
    // 获取 Redis 连接信息
    const redisHost = await question('Redis Host (default: localhost): ') || 'localhost';
    const redisPort = await question('Redis Port (default: 6379): ') || '6379';

    // 连接 Redis
    console.log('\nConnecting to Redis...');
    const client = redis.createClient({ host: redisHost, port: parseInt(redisPort) });
    client.on('error', (err) => console.error('Redis error:', err));
    await client.connect();
    console.log('Connected to Redis');

    // 获取账号信息
    console.log('\n=== Account Configuration ===\n');
    const chain = await question('Blockchain chain (bsc/solana): ');
    if (!['bsc', 'solana'].includes(chain)) {
      throw new Error('Invalid chain. Must be "bsc" or "solana"');
    }

    const walletAddress = await question('Wallet Address: ');
    const privateKey = await question('Private Key: ');
    const symbol = await question('Trading Symbol (default: BTC-USD): ') || 'BTC-USD';

    // 生成 Signing Key
    console.log('\nGenerating signing key...');
    const { privateKey: signingPrivateKey } = generateEd25519KeyPair();
    const signingKey = Buffer.from(signingPrivateKey).toString('base64');

    // 准备配置
    const config = {
      chain,
      walletAddress,
      privateKey,
      signingKey,
      symbol,
    };

    // 保存到 Redis
    const accountKey = await question('\nRedis key for this account (default: standx:account:1): ') || 'standx:account:1';
    console.log(`\nSaving configuration to Redis with key: ${accountKey}`);
    await client.set(accountKey, JSON.stringify(config));

    console.log('\n✓ Configuration saved successfully!');
    console.log(`\nTo run the bot with this configuration:`);
    console.log(`  ACCOUNT_KEY=${accountKey} npm start`);

    await client.quit();
    rl.close();
  } catch (error) {
    console.error('Setup failed:', error.message);
    rl.close();
    process.exit(1);
  }
}

setup();
