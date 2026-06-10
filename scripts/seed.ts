import 'dotenv/config';
import { db } from '../src/utils/db';
import { hashApiKey, generateApiKeyValue } from '../src/utils/credits';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';

async function seed() {
  console.log('Seeding database...');

  // Create test user
  const passwordHash = await bcrypt.hash('Scrape2026!', 12);
  const user = await db.user.upsert({
    where: { email: 'admin@scrapesuite.com' },
    update: {},
    create: {
      id: randomUUID(),
      email: 'admin@scrapesuite.com',
      name: 'Admin',
      passwordHash,
      plan: 'business',
    },
  });
  console.log(`User: ${user.email} (${user.plan})`);

  // Create API key
  const rawKey = generateApiKeyValue();
  const keyHash = hashApiKey(rawKey);
  const apiKey = await db.apiKey.upsert({
    where: { keyHash },
    update: {},
    create: {
      id: randomUUID(),
      userId: user.id,
      keyHash,
      plan: 'business',
      creditsRemaining: 5000000,
    },
  });
  console.log(`API Key: ${rawKey}`);
  console.log(`Key Hash: ${keyHash.substring(0, 16)}...`);
  console.log(`Credits: ${apiKey.creditsRemaining}`);

  // Add some seed proxies
  const proxyProviders = ['brightdata', 'oxylabs', 'iproyal', 'smartproxy'];
  const tiers = ['residential', 'datacenter', 'mobile'] as const;
  const countries = ['US', 'GB', 'DE', 'FR', 'JP'];

  for (let i = 0; i < 20; i++) {
    const tier = tiers[i % 3];
    const country = countries[i % 5];
    const provider = proxyProviders[i % 4];
    
    await db.proxy.upsert({
      where: { id: `proxy-${tier}-${i}` },
      update: {},
      create: {
        id: `proxy-${tier}-${i}`,
        url: `http://${provider}-${tier}-${i}.example.com:8080`,
        tier,
        country,
        provider,
        successRate: 0.8 + Math.random() * 0.2,
        p95Latency: 500 + Math.floor(Math.random() * 2000),
        failures: 0,
        retired: false,
      },
    });
  }
  console.log('Seed proxies: 20 added');

  console.log('Seed complete!');
  await db.$disconnect();
}

seed().catch(console.error);
