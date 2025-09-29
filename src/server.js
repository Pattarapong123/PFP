// src/server.js
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import cookieSession from 'cookie-session';
import morgan from 'morgan';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs';

// ==== new: prod hardening utils ====
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

// ===== QR helpers (ยังคงไว้ใช้ตรวจสลิป) =====
import { parseEMV, verifyCRC } from './utils/emvco.js';
import { decodeQR } from './utils/decode-qr.js';

// --- Load .env ก่อน แล้วบังคับใช้ WASM ก่อน import Prisma ---
dotenv.config();
// ถ้ายังไม่ได้ตั้งค่าใน .env ให้ตั้งค่าใน process ทันที (กันพลาด)
if (!process.env.PRISMA_CLIENT_ENGINE_TYPE) {
  process.env.PRISMA_CLIENT_ENGINE_TYPE = 'wasm';
}

// ✅ ใช้ dynamic import เพื่อให้ env ข้างบนมีผลทันก่อนโหลด Prisma Client
const { default: prismaModule } = await import('@prisma/client');
const { PrismaClient } = prismaModule;


// สร้าง Prisma client
const prisma = new PrismaClient();

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);



// ===== Ensure uploads dir exists =====
const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

// ===== Multer (รับไฟล์รูป/เอกสาร) =====
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const base = crypto.randomBytes(16).toString('hex');
    cb(null, `${base}${ext}`);
  },
});
const fileFilter = (_req, file, cb) => {
  const ok = /image\/(png|jpe?g|gif|webp|svg\+xml)|application\/pdf/i.test(file.mimetype);
  cb(ok ? null : new Error('Invalid image type'), ok);
};
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// ===== View Engine =====
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
if (process.env.NODE_ENV === 'production') {
  app.set('view cache', true);
}

// ===== Thai Status helpers =====
const STATUS = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  SHIPPED: 'SHIPPED',
  CANCELLED: 'CANCELLED',
};
function statusLabelTH(s) {
  switch (String(s || '').toUpperCase()) {
    case 'PAID': return 'ชำระแล้ว';
    case 'SHIPPED': return 'จัดส่งแล้ว';
    case 'CANCELLED': return 'ยกเลิก';
    case 'PENDING':
    default: return 'รอตรวจสลิป';
  }
}
function statusBadgeClass(s) {
  switch (String(s || '').toUpperCase()) {
    case 'PAID': return 'b-paid';
    case 'SHIPPED': return 'b-shipped';
    case 'CANCELLED': return 'b-cancel';
    case 'PENDING':
    default: return 'b-pending';
  }
}
const statusOptionsTH = [
  { v: STATUS.PENDING,   t: 'รอตรวจสลิป' },
  { v: STATUS.PAID,      t: 'ชำระแล้ว' },
  { v: STATUS.SHIPPED,   t: 'จัดส่งแล้ว' },
  { v: STATUS.CANCELLED, t: 'ยกเลิก' },
];
app.locals.STATUS = STATUS;
app.locals.statusLabelTH = statusLabelTH;
app.locals.statusBadgeClass = statusBadgeClass;
app.locals.statusOptionsTH = statusOptionsTH;

// ===== Global/Prod middlewares =====
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind proxy on shared/VPS

// Force HTTPS (ถ้าตั้งค่า)
if (process.env.FORCE_HTTPS === '1') {
  app.use((req, res, next) => {
    const xfProto = req.headers['x-forwarded-proto'];
    if (xfProto && xfProto !== 'https') {
      return res.redirect(`https://${req.headers.host}${req.originalUrl}`);
    }
    next();
  });
}

// Security headers (ปิด CSP เพื่อให้ง่ายกับ EJS/inline)
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// Compression + CORS
const ALLOW_ORIGIN = process.env.CORS_ORIGIN || process.env.APP_BASE_URL || '';
app.use(compression());
app.use(cors({
  origin: ALLOW_ORIGIN ? [ALLOW_ORIGIN] : true,
  credentials: true,
}));

// Logging
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Body parsers
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Rate limits (เบา ๆ สำหรับหน้าเสี่ยง)
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});
const checkoutLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(['/auth/login', '/admin/login'], authLimiter);
app.use(['/checkout'], checkoutLimiter);

// ====== Split sessions: customer vs admin (คนละคุกกี้) ======
app.use(
  cookieSession({
    name: process.env.CUST_SESSION_NAME || 'cust_session',
    keys: [process.env.CUST_SESSION_SECRET || 'cust-secret'],
    maxAge: 86400000,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  })
);
app.use(
  '/admin',
  cookieSession({
    name: process.env.ADMIN_SESSION_NAME || 'admin_session',
    keys: [process.env.ADMIN_SESSION_SECRET || 'admin-secret'],
    maxAge: 86400000,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/admin',
  })
);

// Static (cache นานสำหรับ asset)
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0,
  etag: true,
  lastModified: true,
}));

// favicon
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// robots
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send('User-agent: *\nAllow: /\n');
});

// ===== Helpers =====
const toBaht = (cents) => Number(cents || 0) / 100;
const toCents = (baht) => Math.round(Number(baht || 0) * 100);
const isAjax = (req) =>
  req.xhr || (req.get('accept') || '').toLowerCase().includes('application/json');

function getCart(req) {
  if (!req.session.cart) req.session.cart = [];
  return req.session.cart;
}
function cartTotal(cart) {
  return cart.reduce((s, i) => s + i.qty * i.price, 0);
}
function slugify(str = '') {
  return String(str)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9ก-๙\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}
async function addLog(type, action, refId, message) {
  try {
    await prisma.activityLog.create({ data: { type, action, refId, message } });
  } catch (err) {
    console.warn('ActivityLog error:', err?.message || err);
  }
}

// ===== Contact & Bank constants (แทน settings) =====
const SITE_NAME = process.env.SITE_NAME || 'PFP ENGINEERING';
const CONTACT_EMAILS = (process.env.CONTACT_EMAILS || 'pfp.service01@gmail.com,Pmeekit.pfp@gmail.com')
  .split(',').map(s => s.trim()).filter(Boolean);
const CONTACT_PHONES = (process.env.CONTACT_PHONES || '099-135-1328,087-536-2224,083-293-1396')
  .split(',').map(s => s.trim()).filter(Boolean);

const BANK = {
  bankName: process.env.BANK_NAME || 'ธนาคารตัวอย่าง',
  accountName: process.env.BANK_ACCOUNT_NAME || 'บริษัท พีเอฟพี จำกัด',
  accountNo: process.env.BANK_ACCOUNT_NO || '123-456-7890',
  qrImageUrl: process.env.BANK_QR_URL || '/images/sample-qr.png',
};
const CHECKOUT_NOTE = process.env.CHECKOUT_NOTE || '';
const PROMPTPAY_ID = (process.env.PROMPTPAY_ID || '').trim();

// ===== Real-time stock (SSE) =====
const sseClients = new Set();
function parseSlugsParam(q = '') {
  return String(q || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 200);
}
async function getStocksBySlugs(slugs) {
  if (!slugs?.length) return [];
  const rows = await prisma.product.findMany({
    where: { slug: { in: slugs } },
    select: { slug: true, stockQty: true },
  });
  return rows.map((r) => ({ slug: r.slug, stockQty: r.stockQty ?? 0 }));
}
async function getStocksByIds(ids) {
  if (!ids?.length) return [];
  const rows = await prisma.product.findMany({
    where: { id: { in: ids } },
    select: { slug: true, stockQty: true },
  });
  return rows.map((r) => ({ slug: r.slug, stockQty: r.stockQty ?? 0 }));
}
function sseSend(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
async function broadcastStocksForIds(ids) {
  const batch = await getStocksByIds(ids);
  if (!batch.length || !sseClients.size) return;
  for (const client of sseClients) {
    const filtered = batch.filter((d) => client.slugs.has(d.slug));
    if (filtered.length) {
      try { sseSend(client.res, filtered); } catch {}
    }
  }
}
setInterval(() => {
  for (const c of sseClients) {
    try { c.res.write(': ping\n\n'); } catch {}
  }
}, 25000);

// ===== Real-time order status (SSE) =====
const sseOrderClients = new Set(); // { res, orderIds:Set<number>, userId?: number }
async function getOrderStatusByIds(ids = []) {
  if (!ids.length) return [];
  const rows = await prisma.order.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true, paidAt: true, shippedAt: true, trackingCarrier: true, trackingNo: true },
  });
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    paidAt: r.paidAt ? new Date(r.paidAt).toISOString() : null,
    shippedAt: r.shippedAt ? new Date(r.shippedAt).toISOString() : null,
    trackingCarrier: r.trackingCarrier || null,
    trackingNo: r.trackingNo || null,
  }));
}
function sseSendOrders(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
async function broadcastOrdersForIds(ids) {
  if (!ids?.length || !sseOrderClients.size) return;
  const batch = await getOrderStatusByIds(ids);
  if (!batch.length) return;
  for (const client of sseOrderClients) {
    const filtered = batch.filter((d) => client.orderIds.has(d.id));
    if (filtered.length) {
      try { sseSendOrders(client.res, filtered); } catch {}
    }
  }
}
setInterval(() => {
  for (const c of sseOrderClients) {
    try { c.res.write(': ping\n\n'); } catch {}
  }
}, 25000);

// ===== Inject locals =====
app.use((req, res, next) => {
  const u = req.session?.user || null;
  res.locals.path = req.path;
  res.locals.cartCount = (req.session.cart || []).length;

  // แยกตัวแปรที่ใช้ใน view: user = ลูกค้า, admin = แอดมิน/สตาฟ
  res.locals.user  = u && u.role !== 'ADMIN' && u.role !== 'STAFF' ? u : null;
  res.locals.admin = u && (u.role === 'ADMIN' || u.role === 'STAFF') ? u : null;

  // defaults for pagination
  res.locals.page = 1; res.locals.pageSize = 10;
  res.locals.total = 0; res.locals.totalPages = 1; res.locals.from = 0; res.locals.to = 0;

  // CSRF placeholder
  res.locals.csrfToken = '';
  next();
});

// ===== Auth helpers =====
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

function requireUser(req, res, next) {
  if (req.session?.user?.id) return next();
  const nextUrl = encodeURIComponent(req.originalUrl || '/');
  return res.redirect(`/auth/login?next=${nextUrl}`);
}
function requireAdmin(req, res, next) {
  const user = req.session?.user;
  if (user && (user.role === 'ADMIN' || user.role === 'STAFF')) return next();
  const nextUrl = encodeURIComponent(req.originalUrl || '/admin');
  return res.redirect(`/admin/login?next=${nextUrl}`);
}

// ===== Public routes =====
app.get('/', (_req, res) => res.render('home'));

// Products (public list)
app.get('/products', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(60, Math.max(6, parseInt(req.query.size, 10) || 12));
    const skip = (page - 1) * pageSize;

    const q = (req.query.q || '').trim();
    const category = (req.query.category || '').trim(); // slug ของหมวด
    const sort = (req.query.sort || 'new').trim();      // new | price_asc | price_desc | name_asc
    const minPrice = req.query.min ? Number(req.query.min) : null; // THB
    const maxPrice = req.query.max ? Number(req.query.max) : null; // THB

    const where = {};
    if (q) {
      where.OR = [
        { name: { contains: q } },
        { slug: { contains: q } },
        { sku: { contains: q } },
      ];
    }
    if (category) {
      where.categories = { some: { category: { slug: category } } }; // explicit m2m
    }
    if (minPrice != null || maxPrice != null) {
      where.priceCents = {};
      if (minPrice != null) where.priceCents.gte = Math.max(0, Math.round(minPrice * 100));
      if (maxPrice != null) where.priceCents.lte = Math.max(0, Math.round(maxPrice * 100));
    }

    let orderBy = [{ id: 'desc' }];
    if (sort === 'price_asc') orderBy = [{ priceCents: 'asc' }, { id: 'desc' }];
    else if (sort === 'price_desc') orderBy = [{ priceCents: 'desc' }, { id: 'desc' }];
    else if (sort === 'name_asc') orderBy = [{ name: 'asc' }, { id: 'desc' }];

    const [total, rows, cats] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        skip,
        take: pageSize,
        orderBy,
        include: { images: true, unit: true },
      }),
      prisma.category.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true, slug: true },
      }),
    ]);

    const products = rows.map((p) => ({
      ...p,
      price: toBaht(p.priceCents),
      firstImage: p.images?.[0]?.url || null,
    }));

    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const from = total ? skip + 1 : 0;
    const to = Math.min(skip + products.length, total);

    res.render('products', {
      products,
      categories: cats,
      q,
      category,
      sort,
      minPrice,
      maxPrice,
      page,
      pageSize,
      total,
      totalPages,
      from,
      to,
    });
  } catch (e) { next(e); }
});

// (optional) list แบบอีกหน้าเก่า
app.get('/product', async (_req, res, next) => {
  try {
    const rows = await prisma.product.findMany({ include: { images: true, unit: true } });
    const products = rows.map((p) => ({
      ...p,
      price: toBaht(p.priceCents),
      firstImage: p.images?.[0]?.url || null,
    }));
    res.render('product', { products });
  } catch (e) { next(e); }
});

app.get('/products/:slug', async (req, res, next) => {
  try {
    const row = await prisma.product.findUnique({
      where: { slug: req.params.slug },
      include: { images: true, unit: true },
    });
    if (!row) return res.status(404).render('404');
    const product = { ...row, price: toBaht(row.priceCents) };
    const canBuy = (row.stockQty ?? 0) > 0;
    res.render('product-detail', { product, canBuy });
  } catch (e) { next(e); }
});

// Portfolio
app.get('/portfolio', async (_req, res, next) => {
  try {
    const posts = await prisma.portfolio.findMany({
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      include: { images: { orderBy: { sortOrder: 'asc' } } },
    });
    res.render('portfolio', { posts });
  } catch (e) { next(e); }
});
app.get('/portfolio/:slug', async (req, res, next) => {
  try {
    const post = await prisma.portfolio.findUnique({
      where: { slug: req.params.slug },
      include: { images: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!post) return res.status(404).render('404');
    res.render('portfolio-detail', { post });
  } catch (e) { next(e); }
});

// ===== User Auth (หน้าบ้าน) =====
app.get('/auth/register', (req, res) => {
  res.render('auth/register', { error: null, values: {}, next: req.query.next || '/' });
});
app.post('/auth/register', async (req, res, next) => {
  try {
    const { name, email, password, password2 } = req.body;
    const nextUrl = req.query.next || '/';
    if (!name || !email || !password || !password2)
      return res.status(400).render('auth/register', {
        error: 'กรอกข้อมูลให้ครบถ้วน',
        values: { name, email },
        next: nextUrl,
      });
    if (String(password).length < 6)
      return res.status(400).render('auth/register', {
        error: 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร',
        values: { name, email },
        next: nextUrl,
      });
    if (password !== password2)
      return res.status(400).render('auth/register', {
        error: 'รหัสผ่านและยืนยันรหัสผ่านไม่ตรงกัน',
        values: { name, email },
        next: nextUrl,
      });

    const exist = await prisma.user.findUnique({ where: { email } });
    if (exist)
      return res.status(400).render('auth/register', {
        error: 'อีเมลนี้มีอยู่แล้ว',
        values: { name, email },
        next: nextUrl,
      });

    let passwordHash = password;
    try {
      const bcrypt = await import('bcrypt');
      passwordHash = await bcrypt.default.hash(password, 10);
    } catch {}

    const user = await prisma.user.create({ data: { name, email, password: passwordHash, role: 'CUSTOMER' } });
    req.session.user = { id: user.id, email: user.email, name: user.name, role: user.role };
    res.redirect(nextUrl);
  } catch (e) { next(e); }
});
app.get('/auth/login', (req, res) => {
  res.render('auth/login', { error: null, next: req.query.next || '/' });
});
app.post('/auth/login', authLimiter, async (req, res, next) => {
  try {
    const { email, password, next: bodyNext } = req.body;
    const nextUrl = bodyNext || req.query.next || '/';

    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      let ok = false;
      try {
        const bcrypt = await import('bcrypt');
        ok = await bcrypt.default.compare(password, user.password);
      } catch {
        ok = user.password === password;
      }
      if (ok) {
        req.session.user = { id: user.id, email: user.email, name: user.name, role: user.role || 'CUSTOMER' };
        return res.redirect(nextUrl);
      }
    }

    if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
      req.session.user = { id: 0, email, name: 'Admin', role: 'ADMIN' };
      await addLog('admin', 'login', null, 'ผู้ดูแลระบบเข้าสู่ระบบ (ENV)');
      return res.redirect(nextUrl);
    }

    return res.status(401).render('auth/login', { error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง', next: nextUrl });
  } catch (e) { next(e); }
});
app.post('/auth/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

// ===== Cart =====
app.post('/cart/add', async (req, res, next) => {
  try {
    const productIdRaw = req.body.productId ?? req.query.productId;
    const qtyRaw = req.body.qty ?? req.query.qty;
    const productId = Number(productIdRaw);
    const addQty = Math.max(1, Number.isFinite(Number(qtyRaw)) ? Number(qtyRaw) : 1);

    if (!Number.isInteger(productId) || productId <= 0) {
      const msg = 'Invalid productId';
      return isAjax(req) ? res.status(400).json({ ok: false, message: msg }) : res.status(400).send(msg);
    }
    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: { images: { take: 1, orderBy: { id: 'asc' } } },
    });
    if (!product) {
      const msg = 'Product not found';
      return isAjax(req) ? res.status(404).json({ ok: false, message: msg }) : res.status(404).send(msg);
    }

    const inStock = product.stockQty ?? 0;
    const cart = getCart(req);
    const exist = cart.find((i) => i.id === product.id);
    const already = exist ? exist.qty : 0;
    const canAdd = inStock - already;

    if (canAdd <= 0) {
      const msg = 'สินค้าหมดสต๊อก หรือมีในตะกร้าครบตามคงเหลือแล้ว';
      return isAjax(req) ? res.status(400).json({ ok: false, message: msg }) : res.status(400).send(msg);
    }
    if (addQty > canAdd) {
      const msg = `คงเหลือ ${canAdd} ชิ้น ไม่สามารถเพิ่มเกินได้`;
      return isAjax(req) ? res.status(400).json({ ok: false, message: msg, canAdd }) : res.status(400).send(msg);
    }

    const priceBaht = toBaht(product.priceCents);
    const firstImage = product.images?.[0]?.url || null;

    if (exist) {
      exist.qty += addQty;
      if (!exist.imageUrl && firstImage) exist.imageUrl = firstImage;
      if (!exist.slug && product.slug) exist.slug = product.slug;
    } else {
      cart.push({
        id: product.id,
        name: product.name,
        price: priceBaht,
        qty: addQty,
        slug: product.slug,
        imageUrl: firstImage,
      });
    }

    if (isAjax(req)) {
      return res.json({ ok: true, cartCount: cart.length, item: { id: product.id, name: product.name, qty: addQty } });
    }

    const back = req.get('referer') || '/products';
    return res.redirect(back);
  } catch (err) { console.error('POST /cart/add error:', err); next(err); }
});

app.get('/cart', async (req, res, next) => {
  try {
    const cart = getCart(req);

    if (cart.length) {
      const need = cart.filter((i) => !i.imageUrl || !i.slug);
      if (need.length) {
        const ids = [...new Set(need.map((i) => i.id))];
        const rows = await prisma.product.findMany({
          where: { id: { in: ids } },
          select: { id: true, slug: true, images: { take: 1, orderBy: { id: 'asc' } } },
        });

        const map = new Map(
          rows.map((r) => [r.id, { url: r.images?.[0]?.url || null, slug: r.slug }])
        );

        let changed = false;
        cart.forEach((i) => {
          const info = map.get(i.id);
          if (!i.imageUrl && info?.url) { i.imageUrl = info.url; changed = true; }
          if (!i.slug && info?.slug) { i.slug = info.slug; changed = true; }
        });
        if (changed) req.session.cart = cart;
      }
    }

    res.render('cart', { cart, total: cartTotal(cart) });
  } catch (e) {
    next(e);
  }
});

app.post('/cart/remove', (req, res) => {
  const cart = getCart(req);
  const productId = Number(req.body.productId);
  if (!Number.isInteger(productId)) {
    const msg = 'Invalid productId';
    return isAjax(req) ? res.status(400).json({ ok: false, message: msg }) : res.status(400).send(msg);
  }
  req.session.cart = cart.filter((i) => i.id !== productId);
  return isAjax(req) ? res.json({ ok: true, cartCount: req.session.cart.length }) : res.redirect('/cart');
});
app.post('/cart/clear', (req, res) => {
  req.session.cart = [];
  return isAjax(req) ? res.json({ ok: true, cartCount: 0 }) : res.redirect('/cart');
});

// ===== Checkout =====
app.get('/checkout', requireUser, async (req, res, next) => {
  try {
    const cart = getCart(req);
    if (!cart.length) return res.redirect('/cart');

    const addresses = await prisma.address.findMany({
      where: { userId: req.session.user.id },
      orderBy: { id: 'desc' },
    });

    const bank = { ...BANK };
    const checkoutNote = CHECKOUT_NOTE;

    res.render('checkout', {
      cart,
      total: cartTotal(cart),
      addresses,
      values: {},
      error: null,
      bank,
      checkoutNote,
    });
  } catch (e) { next(e); }
});

app.post('/checkout', requireUser, checkoutLimiter, upload.single('paymentSlip'), async (req, res, next) => {
  try {
    const cart = getCart(req);
    if (!cart.length) return res.redirect('/cart');

    const userId = req.session.user.id;
    const total = cartTotal(cart);

    const { addressId, line1, line2, district, zone, province, postcode, country, phone, paymentMethod, paymentRef } =
      req.body;

    let shippingAddressId = null;

    if (addressId) {
      const addr = await prisma.address.findFirst({ where: { id: Number(addressId), userId } });
      if (!addr) return res.status(400).send('ไม่พบที่อยู่ที่เลือก');
      shippingAddressId = addr.id;
    } else {
      const phoneOk = !phone || /^0[0-9]{8,9}$/.test(String(phone));
      if (!line1 || !district || !zone || !province || !postcode || !phoneOk) {
        const addresses = await prisma.address.findMany({ where: { userId }, orderBy: { id: 'desc' } });
        return res.status(400).render('checkout', {
          cart,
          total,
          addresses,
          values: req.body,
          error:
            'กรุณากรอกที่อยู่ให้ครบถ้วน (ที่อยู่, ตำบล/แขวง, อำเภอ/เขต, จังหวัด, รหัสไปรษณีย์) และเบอร์โทรให้ถูกต้อง',
          bank: BANK,
          checkoutNote: CHECKOUT_NOTE,
        });
      }
      const newAddr = await prisma.address.create({
        data: {
          userId,
          type: 'SHIPPING',
          line1,
          line2: line2 || null,
          district,
          zone: zone || null,
          province,
          postcode,
          country: country || 'TH',
          phone: phone || null,
        },
      });
      shippingAddressId = newAddr.id;
    }

    const slipFile = req.file || null;
    const slipUrl = slipFile ? `/uploads/${slipFile.filename}` : null;

    let slipStatus = 'PENDING';
    let slipReason = null;

    if (!slipFile) {
      slipStatus = 'REVIEW';
      slipReason = 'No slip attached';
    } else {
      try {
        const payload = await decodeQR(slipFile.path).catch(() => null);
        if (payload && /^[0-9A-F]+$/i.test(payload)) {
          const crc = verifyCRC(payload);
          const tlv = parseEMV(payload);
          const expectedPromptpay = PROMPTPAY_ID;
          const m = tlv['29']?.sub || tlv['26']?.sub || null;
          const amount = tlv['54'] ? Number(tlv['54']) : null;
          const currency = (tlv['58'] || '').toString().toUpperCase();
          const accountMatches = expectedPromptpay
            ? (m && Object.values(m).some((v) => typeof v === 'string' && v.includes(expectedPromptpay)))
            : true;
          const amountMatches = amount == null ? true : Math.abs(amount - Number(total)) < 0.01;
          const currencyOK = !currency || currency === 'TH' || currency === 'THB' || currency === '764';

          if (crc.ok && accountMatches && amountMatches && currencyOK) {
            slipStatus = 'VERIFIED_PRELIM';
          } else {
            slipStatus = 'REVIEW';
            slipReason = JSON.stringify({ crc: crc.ok, accountMatches, amountMatches, currency });
          }
        } else {
          slipStatus = 'REVIEW';
          slipReason = 'QR not found or invalid';
        }
      } catch (_e) {
        slipStatus = 'REVIEW';
        slipReason = 'QR decode error';
      }
    }

    const created = await prisma.$transaction(async (tx) => {
      // ตรวจสต๊อก
      const ids = cart.map((i) => i.id);
      const products = await tx.product.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, stockQty: true, priceCents: true },
      });
      const stockMap = new Map(products.map((p) => [p.id, p]));
      for (const item of cart) {
        const p = stockMap.get(item.id);
        if (!p) throw new Error(`ไม่พบสินค้า ID ${item.id}`);
        if ((p.stockQty ?? 0) < item.qty) throw new Error(`สต๊อกไม่พอสำหรับ “${p.name}” (คงเหลือ ${p.stockQty ?? 0})`);
      }

      // สร้างออเดอร์ (ยังไม่ตัดสต๊อกจนกว่าจะอนุมัติ)
      const order = await tx.order.create({
        data: {
          status: 'PENDING',
          totalCents: toCents(total),
          paymentMethod: paymentMethod || 'TRANSFER',
          paymentRef: paymentRef || null,
          paymentSlipUrl: slipUrl,
          user: { connect: { id: userId } },
          ...(shippingAddressId ? { shippingAddress: { connect: { id: shippingAddressId } } } : {}),
          items: {
            create: cart.map((i) => ({
              productId: i.id,
              qty: i.qty,
              unitPriceCents: toCents(i.price),
            })),
          },
        },
        include: { items: true },
      });

      return order;
    });

    await addLog(
      'order',
      'created',
      created.id,
      `สร้างออเดอร์ #${created.id} (ยอด ${total.toLocaleString('th-TH')} ฿) [slip=${slipStatus}${slipReason ? `|${slipReason}` : ''}]`
    );

    req.session.cart = [];
    res.render('checkout-success', { orderId: created.id, total, cartCount: 0 });
  } catch (e) {
    console.error('Checkout error:', e?.message || e);
    const cart = getCart(req);
    const addresses = await prisma.address.findMany({
      where: { userId: req.session.user.id },
      orderBy: { id: 'desc' },
    }).catch(() => []);
    return res.status(400).render('checkout', {
      cart,
      total: cartTotal(cart),
      addresses,
      values: req.body,
      error: e?.message || 'ไม่สามารถทำรายการได้',
      bank: BANK,
      checkoutNote: CHECKOUT_NOTE,
    });
  }
});

// ===== Static pages =====
app.get('/about', (_req, res) => res.render('about'));

// ===== Contact =====
app.get('/contact', (_req, res) => {
  res.render('contact', {
    siteName: SITE_NAME,
    contactEmails: CONTACT_EMAILS,
    contactPhones: CONTACT_PHONES,
  });
});

// ===== Health =====
app.get('/health', (_req, res) => res.json({ ok: true }));

// ===================
// ===== Admin Auth Routes (หลังบ้าน) =====
// ===================
app.get('/admin/login', (req, res) => {
  if (req.session?.user?.role === 'ADMIN' || req.session?.user?.role === 'STAFF') {
    return res.redirect('/admin');
  }
  res.render('admin/login', {
    error: null,
    values: { email: req.query.email || '' },
    next: req.query.next || '/admin',
  });
});
app.post('/admin/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;

  // ENV admin
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    req.session.user = { id: 0, email, name: 'Admin', role: 'ADMIN' };
    await addLog('admin', 'login', null, 'ผู้ดูแลระบบเข้าสู่ระบบ');
    return res.redirect(req.body.next || '/admin');
  }

  // DB-based admin/staff
  const user = await prisma.user.findUnique({ where: { email } }).catch(() => null);
  if (user && (user.role === 'ADMIN' || user.role === 'STAFF')) {
    let ok = false;
    try {
      const bcrypt = await import('bcrypt');
      ok = await bcrypt.default.compare(password, user.password);
    } catch {
      ok = user.password === password; // fallback
    }

    if (ok) {
      req.session.user = { id: user.id, email: user.email, name: user.name, role: user.role };
      await addLog('admin', 'login', user.id, `ผู้ดูแลระบบเข้าสู่ระบบ (${user.email})`);
      return res.redirect(req.body.next || '/admin');
    }
  }

  return res.status(401).render('admin/login', {
    error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
    values: { email },
    next: req.body.next || '/admin',
  });
});
app.post('/admin/logout', (req, res) => {
  addLog('admin', 'logout', null, 'ผู้ดูแลระบบออกจากระบบ').catch(()=>{});
  req.session = null;
  res.redirect('/admin/login');
});

// ===================
// ===== Admin Protected Wrapper =====
// ===================
app.use('/admin', requireAdmin);

// ===================
// ===== Admin Dashboard =====
// ===================
app.get('/admin', async (_req, res, next) => {
  try {
    const now = new Date();
    const since7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const since30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      productCount,
      orderCount,
      portfolioCount,
      logs,
      pendingPaymentCount,
      toShipCount,
      lowStockRows,
      recentOrdersRows,
      revenue7Agg,
      revenue30Agg,
    ] = await Promise.all([
      prisma.product.count(),
      prisma.order.count().catch(() => 0),
      prisma.portfolio.count(),
      prisma.activityLog.findMany({ orderBy: { createdAt: 'desc' }, take: 8 }).catch(() => []),
      prisma.order.count({ where: { status: 'PENDING', paymentSlipUrl: { not: null } } }).catch(() => 0),
      prisma.order.count({ where: { status: 'PAID' } }).catch(() => 0),
      prisma.product.findMany({
        where: { stockQty: { lte: 5 } },
        orderBy: [{ stockQty: 'asc' }, { id: 'asc' }],
        take: 5,
        select: { id: true, name: true, stockQty: true, slug: true },
      }),
      prisma.order.findMany({ orderBy: { id: 'desc' }, take: 5, include: { user: true } }),
      prisma.order.aggregate({ _sum: { totalCents: true }, where: { status: 'PAID', paidAt: { gte: since7 } } }),
      prisma.order.aggregate({ _sum: { totalCents: true }, where: { status: 'PAID', paidAt: { gte: since30 } } }),
    ]);

    const lowStock = lowStockRows.map(p => ({ ...p, stockQty: p.stockQty ?? 0 }));
    const recentOrders = recentOrdersRows.map(o => ({
      id: o.id,
      email: o.user?.email || '-',
      status: o.status,
      totalBaht: toBaht(o.totalCents),
      createdAt: o.createdAt,
    }));
    const revenue7 = toBaht(revenue7Agg?._sum?.totalCents);
    const revenue30 = toBaht(revenue30Agg?._sum?.totalCents);

    res.render('admin/dashboard', {
      productCount,
      orderCount,
      portfolioCount,
      logs,
      pendingPaymentCount,
      toShipCount,
      lowStock,
      recentOrders,
      revenue7,
      revenue30,
    });
  } catch (e) { next(e); }
});

// ===== Utility: Categories loader for forms =====
async function loadAllCategoriesFlat() {
  const cats = await prisma.category.findMany({
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true },
  });
  return cats.map(c => ({ ...c, level: 0 }));
}
function toIdArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.map(x => Number(x)).filter(Number.isFinite);
  return [Number(val)].filter(Number.isFinite);
}

// ===== Admin: Products =====
app.get('/admin/products', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const where = q
      ? { OR: [{ name: { contains: q } }, { sku: { contains: q } }, { slug: { contains: q } }] }
      : {};
    const rows = await prisma.product.findMany({
      where,
      include: { images: true, unit: true },
      orderBy: { id: 'desc' },
    });
    const products = rows.map((p) => ({
      ...p,
      price: toBaht(p.priceCents),
      firstImage: p.images?.[0]?.url || null,
    }));
    res.render('admin/products/index', { products, q });
  } catch (e) { next(e); }
});

app.get('/admin/products/new', async (_req, res, next) => {
  try {
    const [units, categories] = await Promise.all([
      prisma.unit.findMany({ orderBy: { name: 'asc' } }),
      loadAllCategoriesFlat(),
    ]);
    res.render('admin/products/new', { errors: null, values: {}, units, categories });
  } catch (e) { next(e); }
});

app.post('/admin/products', upload.single('imageFile'), async (req, res, next) => {
  try {
    const { name, priceBaht, slug, description, sku, unitId } = req.body;

    // หมวดหมู่จากฟอร์ม (explicit m2m)
    const primaryCategoryId = toIdArray(req.body.primaryCategoryId)[0] || null;
    const categoryIds = [...new Set([
      ...toIdArray(req.body['categoryIds[]'] || req.body.categoryIds),
      primaryCategoryId
    ].filter(Boolean))];

    if (!name) {
      const [units, categories] = await Promise.all([
        prisma.unit.findMany({ orderBy: { name: 'asc' } }),
        loadAllCategoriesFlat(),
      ]);
      return res
        .status(400)
        .render('admin/products/new', { errors: 'ต้องใส่ชื่อสินค้า', values: req.body, units, categories });
    }

    const finalSlug = slug?.trim() ? slugify(slug) : slugify(name);
    const priceCents = toCents(priceBaht || 0);
    const finalSku = (sku || '').trim() || null;
    const uploadedUrl = req.file ? `/uploads/${req.file.filename}` : null;

    const created = await prisma.product.create({
      data: {
        name,
        slug: finalSlug,
        description: description || '',
        priceCents,
        sku: finalSku,
        unitId: unitId ? Number(unitId) : null,
        images: uploadedUrl ? { create: [{ url: uploadedUrl }] } : undefined,
        primaryCategoryId: primaryCategoryId || null,
      },
    });

    // explicit m2m (ลบ skipDuplicates ออก)
    if (categoryIds.length) {
      await prisma.productCategory.createMany({
        data: categoryIds.map(id => ({ productId: created.id, categoryId: id })),
      });
    }

    await addLog('product', 'created', created.id, `เพิ่มสินค้า: ${created.name}`);
    res.redirect('/admin/products');
  } catch (e) {
    if (String(e?.message || '').includes('Unique') || String(e).includes('unique')) {
      const [units, categories] = await Promise.all([
        prisma.unit.findMany({ orderBy: { name: 'asc' } }).catch(() => []),
        loadAllCategoriesFlat().catch(() => []),
      ]);
      return res
        .status(400)
        .render('admin/products/new', { errors: 'Slug ซ้ำกับสินค้าอื่น กรุณาเปลี่ยน', values: req.body, units, categories });
    }
    next(e);
  }
});

app.get('/admin/products/:id/edit', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const [p, units, categories, pCats] = await Promise.all([
      prisma.product.findUnique({
        where: { id },
        include: { images: true, unit: true },
      }),
      prisma.unit.findMany({ orderBy: { name: 'asc' } }),
      loadAllCategoriesFlat(),
      prisma.productCategory.findMany({ where: { productId: id }, select: { categoryId: true } }),
    ]);
    if (!p) return res.status(404).render('404');

    const categoryIds = pCats.map(c => c.categoryId);
    const primaryCategoryId = (p.primaryCategoryId ?? null);

    res.render('admin/products/edit', {
      product: p,
      values: {
        name: p.name,
        slug: p.slug,
        priceBaht: toBaht(p.priceCents),
        description: p.description || '',
        imageUrl: p.images?.[0]?.url || '',
        sku: p.sku || '',
        unitId: p.unitId || '',
        categoryIds,
        primaryCategoryId,
      },
      units,
      categories,
      errors: null,
    });
  } catch (e) { next(e); }
});

app.post('/admin/products/:id', upload.single('imageFile'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { name, priceBaht, slug, description, sku, unitId } = req.body;

    const primaryCategoryId = toIdArray(req.body.primaryCategoryId)[0] || null;
    const categoryIds = [...new Set([
      ...toIdArray(req.body['categoryIds[]'] || req.body.categoryIds),
      primaryCategoryId
    ].filter(Boolean))];

    const finalSlug = slug?.trim() ? slugify(slug) : slugify(name);
    const priceCents = toCents(priceBaht || 0);
    const finalSku = (sku || '').trim() || null;
    const uploadedUrl = req.file ? `/uploads/${req.file.filename}` : null;

    await prisma.product.update({
      where: { id },
      data: {
        name,
        slug: finalSlug,
        description: description || '',
        priceCents,
        sku: finalSku,
        unitId: unitId ? Number(unitId) : null,
        images: uploadedUrl
          ? { deleteMany: {}, create: [{ url: uploadedUrl }] }
          : undefined,
        primaryCategoryId: primaryCategoryId || null,
      },
    });

    // reset explicit m2m
    await prisma.productCategory.deleteMany({ where: { productId: id } });
    if (categoryIds.length) {
      await prisma.productCategory.createMany({
        data: categoryIds.map(cid => ({ productId: id, categoryId: cid })),
      });
    }

    await addLog('product', 'updated', id, `แก้ไขสินค้า: ${name}`);
    res.redirect('/admin/products');
  } catch (e) {
    if (String(e?.message || '').includes('Unique') || String(e).includes('unique')) {
      return res.status(400).send('Slug ซ้ำกับสินค้าอื่น');
    }
    next(e);
  }
});

app.post('/admin/products/:id/delete', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const found = await prisma.product.findUnique({ where: { id } });
    await prisma.productImage.deleteMany({ where: { productId: id } }).catch(() => {});
    await prisma.productCategory.deleteMany({ where: { productId: id } }).catch(()=>{});
    await prisma.product.delete({ where: { id } });
    await addLog('product', 'deleted', id, `ลบสินค้า: ${found?.name || `ID ${id}`}`);
    res.redirect('/admin/products');
  } catch (e) { next(e); }
});

// ===== Stock =====
app.get('/admin/stock', async (_req, res, next) => {
  try {
    const products = await prisma.product.findMany({ orderBy: { id: 'desc' }, include: { unit: true } });
    res.render('admin/stock/index', { products });
  } catch (e) { next(e); }
});
app.post('/admin/products/:id/stock', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { action, qty, reason } = req.body;
    const amount = Math.max(1, parseInt(qty || '1', 10));
    const delta = action === 'remove' ? -amount : amount;

    await prisma.$transaction(async (tx) => {
      await tx.product.update({ where: { id }, data: { stockQty: { increment: delta } } });
      await tx.stockMovement.create({ data: { productId: id, change: delta, reason: reason || null } });
    });

    await addLog('stock', delta > 0 ? 'increase' : 'decrease', id, `สต๊อก ${delta > 0 ? '+' : ''}${delta} (${reason || '-'})`);
    broadcastStocksForIds([id]).catch(() => {});
    res.redirect('/admin/stock');
  } catch (e) { next(e); }
});

// ===== Unit =====
app.get('/admin/units', async (_req, res, next) => {
  try {
    const units = await prisma.unit.findMany({ orderBy: { name: 'asc' } });
    res.render('admin/units/index', { units, errors: null, values: {} });
  } catch (e) { next(e); }
});
app.post('/admin/units', async (req, res, next) => {
  try {
    const { name, shortName } = req.body;
    if (!name?.trim()) {
      const units = await prisma.unit.findMany({ orderBy: { name: 'asc' } });
      return res.status(400).render('admin/units/index', { units, errors: 'กรุณากรอกชื่อหน่วย', values: req.body });
    }
    await prisma.unit.create({ data: { name: name.trim(), shortName: (shortName || '').trim() || null } });
    res.redirect('/admin/units');
  } catch (e) { next(e); }
});
app.post('/admin/units/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { name, shortName } = req.body;
    await prisma.unit.update({ where: { id }, data: { name: name.trim(), shortName: (shortName || '').trim() || null } });
    res.redirect('/admin/units');
  } catch (e) { next(e); }
});
app.post('/admin/units/:id/delete', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const used = await prisma.product.count({ where: { unitId: id } });
    if (used > 0) {
      const units = await prisma.unit.findMany({ orderBy: { name: 'asc' } });
      return res
        .status(400)
        .render('admin/units/index', { units, errors: 'ไม่สามารถลบหน่วยที่มีสินค้าใช้งานอยู่', values: {} });
    }
    await prisma.unit.delete({ where: { id } });
    res.redirect('/admin/units');
  } catch (e) { next(e); }
});
// ===== Admin: Categories =====
app.get('/admin/categories', async (_req, res, next) => {
  try {
    const categories = await prisma.category.findMany({
      orderBy: [{ id: 'desc' }],
      select: { id: true, name: true, slug: true },
    });
    res.render('admin/categories/index', { categories, errors: null });
  } catch (e) { next(e); }
});

app.get('/admin/categories/new', (_req, res) => {
  res.render('admin/categories/new', { errors: null, values: {} });
});

app.post('/admin/categories', async (req, res, next) => {
  try {
    const { name, slug } = req.body;
    if (!name?.trim()) {
      return res.status(400).render('admin/categories/new', {
        errors: 'กรุณากรอกชื่อหมวดหมู่',
        values: req.body,
      });
    }
    const finalSlug = slug?.trim() ? slugify(slug) : slugify(name);
    await prisma.category.create({
      data: { name: name.trim(), slug: finalSlug },
    });
    await addLog('category', 'created', null, `เพิ่มหมวดหมู่: ${name}`);
    res.redirect('/admin/categories');
  } catch (e) {
    if (String(e).includes('Unique')) {
      return res.status(400).render('admin/categories/new', {
        errors: 'Slug ซ้ำกับหมวดหมู่อื่น กรุณาเปลี่ยน',
        values: req.body,
      });
    }
    next(e);
  }
});

app.get('/admin/categories/:id/edit', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const category = await prisma.category.findUnique({ where: { id } });
    if (!category) return res.status(404).render('404');
    res.render('admin/categories/edit', { category, errors: null });
  } catch (e) { next(e); }
});

app.post('/admin/categories/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { name, slug } = req.body;
    if (!name?.trim()) {
      const category = await prisma.category.findUnique({ where: { id } });
      return res.status(400).render('admin/categories/edit', {
        category,
        errors: 'กรุณากรอกชื่อหมวดหมู่',
      });
    }
    const finalSlug = slug?.trim() ? slugify(slug) : slugify(name);
    await prisma.category.update({
      where: { id },
      data: { name: name.trim(), slug: finalSlug },
    });
    await addLog('category', 'updated', id, `แก้ไขหมวดหมู่ #${id}`);
    res.redirect('/admin/categories');
  } catch (e) {
    if (String(e).includes('Unique')) {
      const id = Number(req.params.id);
      const category = await prisma.category.findUnique({ where: { id } });
      return res.status(400).render('admin/categories/edit', {
        category,
        errors: 'Slug ซ้ำกับหมวดหมู่อื่น กรุณาเปลี่ยน',
      });
    }
    next(e);
  }
});

app.post('/admin/categories/:id/delete', async (req, res, next) => {
  try {
    const id = Number(req.params.id);

    // ทางเลือกที่ “ลบแบบปลอดภัย”: ตัดความสัมพันธ์กับสินค้า แล้วค่อยลบหมวด
    await prisma.$transaction(async (tx) => {
      await tx.product.updateMany({
        where: { primaryCategoryId: id },
        data: { primaryCategoryId: null },
      });
      await tx.productCategory.deleteMany({ where: { categoryId: id } });
      await tx.category.delete({ where: { id } });
    });

    await addLog('category', 'deleted', id, `ลบหมวดหมู่ #${id}`);
    res.redirect('/admin/categories');
  } catch (e) { next(e); }
});


// ===== Admin: Portfolio =====
app.get('/admin/portfolio', async (_req, res, next) => {
  try {
    const posts = await prisma.portfolio.findMany({
      orderBy: [{ id: 'desc' }],
      include: { images: { orderBy: { sortOrder: 'asc' } } },
    });
    res.render('admin/portfolio/index', { posts });
  } catch (e) { next(e); }
});
app.get('/admin/portfolio/new', (_req, res) => {
  res.render('admin/portfolio/new', { errors: null, values: {} });
});
app.post('/admin/portfolio', upload.array('images', 12), async (req, res, next) => {
  try {
    const { title, slug, body, publishedAt } = req.body;
    if (!title?.trim()) {
      return res.status(400).render('admin/portfolio/new', {
        errors: 'กรุณากรอกชื่อผลงาน',
        values: req.body,
      });
    }
    const finalSlug = slug?.trim() ? slugify(slug) : slugify(title);
    const images = (req.files || []).map((f, idx) => ({ url: `/uploads/${f.filename}`, sortOrder: idx + 1 }));

    const created = await prisma.portfolio.create({
      data: {
        title: title.trim(),
        slug: finalSlug,
        body: body || '',
        publishedAt: publishedAt ? new Date(publishedAt) : new Date(),
        images: images.length ? { create: images } : undefined,
      },
      include: { images: true },
    });

    await addLog('portfolio', 'created', created.id, `เพิ่มผลงาน: ${created.title}`);
    res.redirect('/admin/portfolio');
  } catch (e) {
    if (String(e).includes('Unique') || String(e?.message || '').includes('Unique')) {
      return res.status(400).render('admin/portfolio/new', {
        errors: 'Slug ซ้ำกับผลงานอื่น กรุณาเปลี่ยน',
        values: req.body,
      });
    }
    next(e);
  }
});
app.get('/admin/portfolio/:id/edit', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const post = await prisma.portfolio.findUnique({
      where: { id },
      include: { images: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!post) return res.status(404).render('404');
    res.render('admin/portfolio/edit', { post, errors: null });
  } catch (e) { next(e); }
});
// อัปเดตข้อมูลหลัก + เพิ่มรูปใหม่
app.post('/admin/portfolio/:id', upload.array('images', 12), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { title, slug, body, publishedAt } = req.body;
    const finalSlug = slug?.trim() ? slugify(slug) : slugify(title || '');
    const newImages = (req.files || []).map((f, idx) => ({ url: `/uploads/${f.filename}`, sortOrder: Date.now() + idx }));

    await prisma.$transaction(async (tx) => {
      await tx.portfolio.update({
        where: { id },
        data: {
          title: title?.trim() || undefined,
          slug: finalSlug || undefined,
          body: body ?? undefined,
          publishedAt: publishedAt ? new Date(publishedAt) : undefined,
          images: newImages.length ? { create: newImages } : undefined,
        },
      });
    });

    await addLog('portfolio', 'updated', id, `แก้ไขผลงาน #${id}`);
    res.redirect('/admin/portfolio');
  } catch (e) {
    if (String(e).includes('Unique') || String(e?.message || '').includes('Unique')) {
      return res.status(400).send('Slug ซ้ำกับผลงานอื่น');
    }
    next(e);
  }
});
app.post('/admin/portfolio/:id/images/:imageId/delete', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const imageId = Number(req.params.imageId);
    await prisma.portfolioImage.delete({ where: { id: imageId } });
    await addLog('portfolio', 'image_deleted', id, `ลบรูปแกลเลอรี #${imageId} ของผลงาน #${id}`);
    res.redirect(`/admin/portfolio/${id}/edit`);
  } catch (e) { next(e); }
});
app.post('/admin/portfolio/:id/delete', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await prisma.portfolioImage.deleteMany({ where: { portfolioId: id } }).catch(() => {});
    await prisma.portfolio.delete({ where: { id } });
    await addLog('portfolio', 'deleted', id, `ลบผลงาน #${id}`);
    res.redirect('/admin/portfolio');
  } catch (e) { next(e); }
});

// ===== Orders (Admin) =====
app.get('/admin/orders', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(10, parseInt(req.query.size, 10) || 10));
    const skip = (page - 1) * pageSize;

    const q = (req.query.q || '').trim();
    const status = (req.query.status || '').trim().toUpperCase();

    const where = {};
    if (status && ['PENDING', 'PAID', 'SHIPPED', 'CANCELLED'].includes(status)) where.status = status;
    if (q) {
      const qNum = Number(q);
      const ors = [];
      if (Number.isInteger(qNum)) ors.push({ id: qNum });
      ors.push({ paymentRef: { contains: q } });
      ors.push({ user: { is: { email: { contains: q } } } });
      where.OR = ors;
    }

    const [total, ordersRaw] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { id: 'desc' },
        include: {
          user: true,
          shippingAddress: true,
          items: { include: { product: true } },
        },
      }),
    ]);

    const orders = ordersRaw.map((o) => ({
      ...o,
      totalBaht: toBaht(o.totalCents),
      items: o.items.map((it) => ({ ...it, unitPriceBaht: toBaht(it.unitPriceCents) })),
    }));

    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const from = total ? skip + 1 : 0;
    const to = Math.min(skip + orders.length, total);

    res.render('admin/orders/index', { orders, page, pageSize, total, totalPages, from, to, q, status });
  } catch (e) { next(e); }
});
app.get('/admin/orders/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const o = await prisma.order.findUnique({
      where: { id },
      include: {
        user: true,
        shippingAddress: true,
        items: { include: { product: true } },
      },
    });
    if (!o) return res.status(404).render('404');
    const order = {
      ...o,
      totalBaht: toBaht(o.totalCents),
      items: o.items.map((it) => ({ ...it, unitPriceBaht: toBaht(it.unitPriceCents) })),
    };
    res.render('admin/orders/show', { order });
  } catch (e) { next(e); }
});
app.post('/admin/orders/:id/payment/approve', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const order = await prisma.order.findUnique({ where: { id }, include: { items: true } });
    if (!order) return res.status(404).render('404');

    if (order.status !== 'PAID') {
      await prisma.$transaction(async (tx) => {
        for (const it of order.items) {
          await tx.product.update({ where: { id: it.productId }, data: { stockQty: { decrement: it.qty } } });
          await tx.stockMovement.create({
            data: { productId: it.productId, change: -it.qty, reason: `ORDER #${id} (approve)` },
          });
        }
        await tx.order.update({ where: { id }, data: { status: 'PAID', paidAt: new Date() } });
      });

      const affectedIds = order.items.map((i) => i.productId);
      broadcastStocksForIds(affectedIds).catch(() => {});
    }

    await addLog('order', 'payment_approved', id, `อนุมัติชำระเงิน #${id}`);
    broadcastOrdersForIds([id]).catch(() => {});
    res.redirect(`/admin/orders/${id}`);
  } catch (e) { next(e); }
});
app.post('/admin/orders/:id/payment/reject', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await prisma.order.update({ where: { id }, data: { status: 'PENDING', paidAt: null } });
    await addLog('order', 'payment_rejected', id, `ปฏิเสธชำระเงิน #${id}`);
    broadcastOrdersForIds([id]).catch(() => {});
    res.redirect(`/admin/orders/${id}`);
  } catch (e) { next(e); }
});
app.post('/admin/orders/:id/delete', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await prisma.orderItem.deleteMany({ where: { orderId: id } });
    await prisma.order.delete({ where: { id } });
    await addLog('order', 'deleted', id, `ลบออเดอร์ #${id}`);
    broadcastOrdersForIds([id]).catch(() => {});
    res.redirect('/admin/orders');
  } catch (e) { next(e); }
});
app.post('/admin/orders/:id/status', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const status = String(req.body.status || '').toUpperCase();
    const allowed = ['PENDING','PAID','SHIPPED','CANCELLED'];
    if (!allowed.includes(status)) return res.status(400).send('Invalid status');

    const data = { status, paidAt: null, shippedAt: null };
    if (status === 'PAID') data.paidAt = new Date();
    if (status === 'SHIPPED') data.shippedAt = new Date();

    await prisma.order.update({ where: { id }, data });
    await addLog('order', 'status_changed', id, `เปลี่ยนสถานะเป็น ${status}`);
    broadcastOrdersForIds([id]).catch(() => {});
    return res.redirect(`/admin/orders/${id}`);
  } catch (e) { next(e); }
});
app.post('/admin/orders/:id/tracking', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { trackingCarrier, trackingNo } = req.body;
    await prisma.order.update({
      where: { id },
      data: {
        trackingCarrier: (trackingCarrier || '').trim() || null,
        trackingNo: (trackingNo || '').trim() || null,
        status: 'SHIPPED',
        shippedAt: new Date(),
      },
    });
    await addLog('order', 'tracking_updated', id, `อัปเดตเลขพัสดุ #${id} (${trackingCarrier || '-'}: ${trackingNo || '-'})`);
    broadcastOrdersForIds([id]).catch(() => {});
    res.redirect(`/admin/orders/${id}`);
  } catch (e) { next(e); }
});

// ===== Admin: Users =====
app.get('/admin/users', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(10, parseInt(req.query.size, 10) || 10));
    const skip = (page - 1) * pageSize;

    const q = (req.query.q || '').trim();
    const role = (req.query.role || '').trim().toUpperCase();

    const where = {};
    if (q) where.OR = [{ email: { contains: q } }, { name: { contains: q } }];
    if (role && ['ADMIN','STAFF','CUSTOMER'].includes(role)) where.role = role;

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({ where, skip, take: pageSize, orderBy: { id: 'desc' } }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const from = total ? skip + 1 : 0;
    const to = Math.min(skip + users.length, total);

    res.render('admin/users/index', { users, page, pageSize, total, totalPages, from, to, q, role });
  } catch (e) { next(e); }
});

app.get('/admin/users/new', (_req, res) =>
  res.render('admin/users/new', { errors:null, values:{} })
);

app.post('/admin/users', async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name?.trim() || !email?.trim() || !password?.trim())
      return res.status(400).render('admin/users/new', { errors:'กรอกข้อมูลให้ครบ', values:req.body });
    const up = (role || '').toUpperCase();
    if (!['ADMIN','STAFF','CUSTOMER'].includes(up))
      return res.status(400).render('admin/users/new', { errors:'ROLE ไม่ถูกต้อง', values:req.body });

    let passwordHash = password;
    try {
      const bcrypt = await import('bcrypt');
      passwordHash = await bcrypt.default.hash(password, 10);
    } catch {}

    await prisma.user.create({ data: { name, email, password: passwordHash, role: up } });
    await addLog('user','created',null,`เพิ่มผู้ใช้: ${email} (${up})`);
    res.redirect('/admin/users');
  } catch (e) { next(e); }
});

app.get('/admin/users/:id/edit', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return res.status(404).render('404');
    res.render('admin/users/edit', { user, errors:null });
  } catch (e) { next(e); }
});

app.post('/admin/users/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { name, email, role } = req.body;
    const up = (role || '').toUpperCase();
    if (!['ADMIN','STAFF','CUSTOMER'].includes(up))
      return res.status(400).send('ROLE ไม่ถูกต้อง');
    await prisma.user.update({ where: { id }, data: { name, email, role: up } });
    await addLog('user','updated',id,`อัปเดตผู้ใช้ #${id}`);
    res.redirect('/admin/users');
  } catch (e) { next(e); }
});

// รีเซ็ตรหัสผ่านผู้ใช้
app.post('/admin/users/:id/reset-password', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { password, password2 } = req.body;

    if (!password || password.length < 6) {
      const user = await prisma.user.findUnique({ where: { id } });
      return res.status(400).render('admin/users/edit', {
        user,
        errors: 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร',
      });
    }
    if (typeof password2 !== 'undefined' && password !== password2) {
      const user = await prisma.user.findUnique({ where: { id } });
      return res.status(400).render('admin/users/edit', {
        user,
        errors: 'รหัสผ่านและยืนยันรหัสผ่านไม่ตรงกัน',
      });
    }

    const bcrypt = (await import('bcrypt')).default;
    const hashed = await bcrypt.hash(password, 10);
    await prisma.user.update({ where: { id }, data: { password: hashed } });

    await addLog('user', 'password_reset', id, `รีเซ็ตรหัสผ่านผู้ใช้ #${id}`);
    res.redirect(`/admin/users/${id}/edit`);
  } catch (e) { next(e); }
});

app.post('/admin/users/:id/delete', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await prisma.user.delete({ where: { id } });
    await addLog('user','deleted',id,`ลบผู้ใช้ #${id}`);
    res.redirect('/admin/users');
  } catch (e) { next(e); }
});

// ===== Public Stock APIs =====
app.get('/api/products/stock', async (req, res, next) => {
  try {
    const slugs = parseSlugsParam(req.query.slugs);
    const data = await getStocksBySlugs(slugs);
    res.json(data);
  } catch (e) { next(e); }
});
app.get('/api/products/stock/stream', async (req, res, next) => {
  try {
    const slugs = parseSlugsParam(req.query.slugs);
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();

    const init = await getStocksBySlugs(slugs);
    sseSend(res, init);

    const client = { res, slugs: new Set(slugs) };
    sseClients.add(client);
    req.on('close', () => { sseClients.delete(client); });
  } catch (e) { next(e); }
});

// ===== Orders status APIs =====
app.get('/api/orders/status', requireUser, async (req, res, next) => {
  try {
    const ids = String(req.query.ids || '')
      .split(',')
      .map((s) => parseInt(s, 10))
      .filter(Number.isInteger);
    const data = await getOrderStatusByIds(ids);
    res.json(data);
  } catch (e) { next(e); }
});
app.get('/api/orders/status/stream', requireUser, async (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',')
    .map((s) => parseInt(s, 10))
    .filter(Number.isInteger);

  if (!ids.length) {
    return res.status(400).json({ ok: false, message: 'No order ids' });
  }

  let init;
  try {
    init = await getOrderStatusByIds(ids);
  } catch (e) {
    console.error('init status fetch error:', e);
    return res.status(500).json({ ok: false, message: 'Init fetch failed' });
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();

  sseSendOrders(res, init);

  const client = { res, orderIds: new Set(ids), userId: req.session?.user?.id || null };
  sseOrderClients.add(client);
  req.on('close', () => { sseOrderClients.delete(client); });
});

// ===== My Orders (ลูกค้า) =====
app.get('/orders/mine', requireUser, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(10, parseInt(req.query.size, 10) || 10));
    const skip = (page - 1) * pageSize;

    const userId = req.session.user.id;

    const [total, ordersRaw] = await Promise.all([
      prisma.order.count({ where: { userId } }),
      prisma.order.findMany({
        where: { userId },
        skip,
        take: pageSize,
        orderBy: { id: 'desc' },
        include: { items: { include: { product: true } } },
      }),
    ]);

    const mapped = ordersRaw.map((o) => ({
      ...o,
      totalBaht: toBaht(o.totalCents),
      items: o.items.map((it) => ({ ...it, unitPriceBaht: toBaht(it.unitPriceCents) })),
      slipUrl: o.paymentSlipUrl || null,
    }));

    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const from = total ? skip + 1 : 0;
    const to = Math.min(skip + mapped.length, total);

    res.render('orders-mine', { orders: mapped, page, pageSize, total, totalPages, from, to });
  } catch (e) { next(e); }
});
app.post('/orders/mine', requireUser, (_req, res) => res.redirect('/orders/mine'));

// ===== Customer: Order detail =====
app.get('/orders/:id', requireUser, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const o = await prisma.order.findFirst({
      where: { id, userId: req.session.user.id },
      include: { items: { include: { product: true } }, shippingAddress: true },
    });
    if (!o) return res.status(404).render('404');
    const order = {
      ...o,
      totalBaht: toBaht(o.totalCents),
      items: o.items.map(it => ({
        productId: it.productId,
        productName: it.product?.name || '',
        productSlug: it.product?.slug || '',
        qty: it.qty,
        unitPriceBaht: toBaht(it.unitPriceCents),
      })),
    };
    res.render('order-detail', { order });
  } catch (e) { next(e); }
});

// ===== Admin: Logs =====
app.get('/admin/logs', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(10, parseInt(req.query.size, 10) || 20));
    const skip = (page - 1) * pageSize;

    const q = (req.query.q || '').trim();
    const type = (req.query.type || '').trim();
    const action = (req.query.action || '').trim();

    const where = {};
    if (type) where.type = type;
    if (action) where.action = action;
    if (q) where.message = { contains: q };

    const [total, rows] = await Promise.all([
      prisma.activityLog.count({ where }),
      prisma.activityLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const from = total ? skip + 1 : 0;
    const to = Math.min(skip + rows.length, total);

    res.render('admin/logs/index', { logs: rows, page, pageSize, total, totalPages, from, to, q, type, action });
  } catch (e) { next(e); }
});
app.get('/admin/logs/export.csv', async (_req, res, next) => {
  try {
    const limit = Math.min(5000, 1000);
    const rows = await prisma.activityLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="activity_logs.csv"');
    res.write('id,type,action,refId,message,createdAt\n');
    for (const r of rows) {
      const line = [
        r.id,
        JSON.stringify(r.type ?? ''),
        JSON.stringify(r.action ?? ''),
        JSON.stringify(r.refId ?? ''),
        JSON.stringify(r.message ?? ''),
        JSON.stringify(r.createdAt?.toISOString() || r.createdAt),
      ].join(',');
      res.write(line + '\n');
    }
    res.end();
  } catch (e) { next(e); }
});

// ===== 404 =====
app.use((req, res) => res.status(404).render('404'));

// ===== Error handler =====
app.use((err, _req, res, _next) => {
  console.error(err);
  if (res.headersSent) {
    try { res.end(); } catch {}
    return;
  }
  res.status(500).send('Internal Server Error');
});

// Graceful shutdown
const shutdown = async () => {
  try { await prisma.$disconnect(); } catch {}
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
