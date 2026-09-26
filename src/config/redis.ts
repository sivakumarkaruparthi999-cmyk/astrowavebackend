import { Redis } from 'ioredis';
import { logger } from '../utils/logger.js';

let redisClient: Redis | null = null;
let isRedisAvailable = false;

export function getRedisClient(): Redis | null {
  if (redisClient) return isRedisAvailable ? redisClient : null;

  const redisUrl = process.env.REDIS_URL;
  const redisHost = process.env.REDIS_HOST || '127.0.0.1';
  const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);
  const redisPassword = process.env.REDIS_PASSWORD || undefined;

  // In test or development without explicit REDIS_URL, check if local Redis is available
  try {
    const options = redisUrl
      ? {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          connectTimeout: 2000,
          retryStrategy: () => null, // Do not infinite-retry if unavailable
        }
      : {
          host: redisHost,
          port: redisPort,
          password: redisPassword,
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          connectTimeout: 2000,
          retryStrategy: () => null,
        };

    const client = redisUrl ? new Redis(redisUrl, options) : new Redis(options);

    client.on('connect', () => {
      isRedisAvailable = true;
      logger.info('Connected to Redis server for distributed rate limiting & caching');
    });

    client.on('error', (err) => {
      isRedisAvailable = false;
      logger.warn(`Redis connection error: ${err.message}. Using fallback in-memory store.`);
    });

    // Attempt non-blocking connection
    client.connect().catch((err) => {
      isRedisAvailable = false;
      logger.warn(`Redis failed initial connection: ${err.message}. Falling back to in-memory store.`);
    });

    redisClient = client;
    return redisClient;
  } catch (err) {
    logger.warn(`Could not initialize Redis client: ${(err as Error).message}`);
    return null;
  }
}

export async function checkRedisHealth(): Promise<boolean> {
  if (!redisClient) {
    // If not initialized, try initializing
    getRedisClient();
  }
  if (!redisClient) return false;

  try {
    const pong = await redisClient.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (redisClient) {
    try {
      await redisClient.quit();
      logger.info('Redis client disconnected cleanly');
    } catch {
      redisClient.disconnect();
    }
    redisClient = null;
    isRedisAvailable = false;
  }
}
