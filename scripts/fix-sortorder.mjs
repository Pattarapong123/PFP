// scripts/fix-sortorder.mjs
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const MAX_INT = 2147483647;

async function main() {
  const bad = await prisma.portfolioImage.findMany({
    where: { sortOrder: { gt: MAX_INT } },
    orderBy: { sortOrder: 'desc' },
    select: { id: true, sortOrder: true }
  });

  if (!bad.length) {
    console.log('✅ ไม่พบค่า sortOrder เกินช่วง INT');
    return;
  }

  console.log(`พบ ${bad.length} แถวที่ sortOrder เกินช่วง INT, เริ่มแก้...`);
  for (const row of bad) {
    await prisma.portfolioImage.update({
      where: { id: row.id },
      data: { sortOrder: row.id } // หรือจะกำหนด 1,2,3 … ก็ได้ตามต้องการ
    });
  }
  console.log('✅ แก้ไขเรียบร้อย');

  const left = await prisma.portfolioImage.count({
    where: { sortOrder: { gt: MAX_INT } }
  });
  console.log(left === 0 ? '✅ ไม่มีค่าเกินเหลืออยู่แล้ว' : `❌ ยังเหลือ ${left} แถว`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
