// prisma/seed.js
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// แปลง "บาท" -> "สตางค์" (Int)
const toCents = (baht) => Math.round(Number(baht || 0) * 100);

async function main() {
  // --- Categories ---
  const webDev = await prisma.category.upsert({
    where: { slug: 'web-development' },
    update: {},
    create: { name: 'Web Development', slug: 'web-development' },
  });

  const network = await prisma.category.upsert({
    where: { slug: 'networking' },
    update: {},
    create: { name: 'Networking', slug: 'networking' },
  });

  // --- Products (ใช้ priceCents แทน price) ---
  await prisma.product.createMany({
    data: [
      {
        sku: 'SKU-001',
        name: 'Managed VPS Hosting (Basic)',
        slug: 'managed-vps-hosting-basic',
        description: 'VPS สำหรับเว็บธุรกิจเริ่มต้น พร้อมดูแลรายเดือน',
        priceCents: toCents(990.0),
        stockQty: 100,
        status: 'ACTIVE',
      },
      {
        sku: 'SKU-002',
        name: 'Network Audit Package',
        slug: 'network-audit-package',
        description: 'ตรวจสอบเครือข่ายและความปลอดภัยภายในองค์กร',
        priceCents: toCents(4990.0),
        stockQty: 50,
        status: 'ACTIVE',
      },
    ],
    skipDuplicates: true, // เผื่อรันซ้ำ
  });

  // อ่านสินค้าที่เพิ่งสร้าง เพื่อผูกหมวดหมู่และรูป
  const p1 = await prisma.product.findUnique({
    where: { slug: 'managed-vps-hosting-basic' },
  });
  const p2 = await prisma.product.findUnique({
    where: { slug: 'network-audit-package' },
  });

  if (p1) {
    await prisma.productCategory.upsert({
      where: { productId_categoryId: { productId: p1.id, categoryId: webDev.id } },
      update: {},
      create: { productId: p1.id, categoryId: webDev.id },
    });
    await prisma.productImage.create({
      data: { productId: p1.id, url: '/images/vps.jpg', altText: 'VPS' },
    });
  }

  if (p2) {
    await prisma.productCategory.upsert({
      where: { productId_categoryId: { productId: p2.id, categoryId: network.id } },
      update: {},
      create: { productId: p2.id, categoryId: network.id },
    });
    await prisma.productImage.create({
      data: { productId: p2.id, url: '/images/audit.jpg', altText: 'Audit' },
    });
  }

  // --- Admin user (เดโม่) ---
  await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {},
    create: {
      name: 'Admin',
      email: 'admin@example.com',
      password: 'admin', // โปรดเปลี่ยนเป็น hash จริงในโปรดักชัน
      role: 'ADMIN',
    },
  });

  // --- Portfolio tags & sample portfolio ---
  const tagWeb = await prisma.portfolioTag.upsert({
    where: { slug: 'web-app' },
    update: {},
    create: { name: 'Web App', slug: 'web-app' },
  });

  await prisma.portfolio.upsert({
    where: { slug: 'clinic-queue-system' },
    update: {},
    create: {
      title: 'ระบบจองคิวคลินิก',
      slug: 'clinic-queue-system',
      summary: 'พัฒนาด้วย Next.js + NestJS เชื่อมต่อฐานข้อมูล',
      content: 'รายละเอียดโปรเจกต์และผลลัพธ์จากลูกค้า',
      featuredImageUrl: '/images/portfolio1.jpg',
      publishedAt: new Date(),
      tags: { create: [{ tagId: tagWeb.id }] },
    },
  });

  console.log('✅ Seed data inserted successfully.');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
