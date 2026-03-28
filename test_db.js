const { PrismaClient } = require('@prisma/client');
async function test(url) {
  const p = new PrismaClient({ datasources: { db: { url } } });
  try {
    await p.$connect();
    console.log('SUCCESS:', url);
    await p.$disconnect();
    return true;
  } catch(e) {
    console.log('FAILED:', url, e.message.split('\n').join(' | ').substring(0, 100));
    return false;
  }
}
(async () => {
  const password = 'Ptproject%402025';
  const ref = 'qkcolltdqipancxdtzlt';
  const urls = [
    `postgresql://postgres.${ref}:${password}@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true`,
    `postgresql://postgres.${ref}:${password}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true`,
    `postgresql://postgres.${ref}:${password}@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true`,
    `postgresql://postgres:${password}@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`,
  ];
  for (let u of urls) {
    if (await test(u)) { process.exit(0); }
  }
})();
