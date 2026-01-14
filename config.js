import redis from 'redis';

let redisClient;

export async function initRedis(host = 'localhost', port = 6379) {
  redisClient = redis.createClient({ host, port });
  redisClient.on('error', (err) => console.error('Redis error:', err));
  await redisClient.connect();
  console.log('Redis connected');
}

export async function getConfig(key) {
  if (!redisClient) throw new Error('Redis not initialized');
  const value = await redisClient.get(key);
  return value ? JSON.parse(value) : null;
}

export async function setConfig(key, value) {
  if (!redisClient) throw new Error('Redis not initialized');
  await redisClient.set(key, JSON.stringify(value));
}

export async function closeRedis() {
  if (redisClient) await redisClient.quit();
}
