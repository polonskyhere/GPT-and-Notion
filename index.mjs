import 'dotenv/config';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import tz from 'dayjs/plugin/timezone.js';
import { Client } from '@notionhq/client';
import { NotionToMarkdown } from 'notion-to-md';
import OpenAI from 'openai';

dayjs.extend(utc);
dayjs.extend(tz);

const TZ = 'Europe/Kyiv';
const CUTOFF = dayjs.tz('2025-08-15', TZ); // не чіпати записи до цієї дати (включно)

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const n2m = new NotionToMarkdown({ notionClient: notion });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// === НАЛАШТУВАННЯ З .env ===
const MODEL = process.env.OPENAI_MODEL || 'gpt-4';
const DB_ID = process.env.REFLECTION_DB_ID;            // база "Щоденник рефлексії"
const DATE_PROP = process.env.REFLECTION_DATE_PROP || 'Дата';
const TITLE_PROP = process.env.REFLECTION_TITLE_PROP || 'Name';

// (необов’язково) — якщо хочеш підмішувати контекст сторінки "Менті"
const MENTEE_RELATION_PROP = process.env.MENTEE_RELATION_PROP || ''; // назва relation-поля
const MENTEE_PAGE_ID = process.env.MENTEE_PAGE_ID || '';             // або прямий page_id

const systemPrompt = `
Ти — ментор-аналітик для барбера. Ти читаєш учасника між рядків, не прив'язуючись до слів. 
Пиши лаконічно, без води.
Завжди повертай 5 розділів у такому порядку й з чіткими підзаголовками:

1) Сильні сторони — 3–5 пунктів.
2) Слабкі місця (прожарка за потреби)
3) Рекомендації — до 5 кроків, максимально конкретно (що зробити завтра/цього тижня).
4) Проривна ідея — 1 ідея з високим впливом, короткий план реалізації.
5) Психологічна підтримка — 2–4 речення щирої підтримки, без кліше.

Фокус: сервіс у кріслі, додаткові послуги, продаж догляду, контент.
Мова — українська.
Тон — прямий, правдивий, без фільтрів. Не намагаєшся бути толерантним.
`;

// ---------- helpers ----------
function chunk(text, n = 1800) {
  const res = [];
  for (let i = 0; i < text.length; i += n) res.push(text.slice(i, i + n));
  return res;
}

async function pageToMarkdown(pageId) {
  const mdBlocks = await n2m.pageToMarkdown(pageId);
  const md = n2m.toMarkdownString(mdBlocks).parent || '';
  return md.trim();
}

async function analyze(markdown) {
  const res = await openai.responses.create({
    model: MODEL,
    input: [
