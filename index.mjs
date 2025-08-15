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
const CUTOFF = dayjs.tz('2025-08-15', TZ);

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const n2m = new NotionToMarkdown({ notionClient: notion });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// === Змінні з Secrets ===
const MODEL = process.env.OPENAI_MODEL || 'gpt-4';
const DB_ID = process.env.REFLECTION_DB_ID;
const DATE_PROP = process.env.REFLECTION_DATE_PROP || 'Дата';
const TITLE_PROP = process.env.REFLECTION_TITLE_PROP || 'Name';
const MENTEE_PAGE_ID = process.env.MENTEE_PAGE_ID || '';

const systemPrompt = `
Ти — ментор-аналітик користувача. 
Відповідь завжди має бути українською мовою та строго у форматі Markdown за такою схемою:

Розбір дня за анкетою:

1. Сильні сторони
- [3–5 пунктів, конкретні приклади з тексту анкети]

2. Слабкі місця (прожарка)
- [2–4 пункти, фактами, без образ]

3. Що можна покращити
- [рекомендації для покращення і 1–3 дії, які можна зробити одразу]

4. Проривна ідея
- [1 ідея з високим впливом, короткий план реалізації]

5. Психологічна підтримка
- [2–4 речення щирої підтримки, без кліше]

Правила:
- Не додавати вступу чи висновку поза цими пунктами.
- Кожен розділ починай з жирного заголовка (**...**).
- Використовуй списки для підпунктів.
- Пиши змістовно, дружній тон, орієнтуйся на 1500 символів.
- Звертайся до менті на "Ти" (його звати Діма)
- Читай "між рядків" учасника: не прив'язуйся до слів, будь тим, хто бачить суть
`;

// --- helpers ---
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
      { role: 'system', content: systemPrompt },
      { role: 'user', content: markdown }
    ],
    temperature: 0.35
  });
  return (res.output_text || '').trim();
}

// --- Пошук сьогоднішнього запису ---
async function findTodayPage() {
  const today = dayjs().tz(TZ);
  const todayISO = today.format('YYYY-MM-DD');
  const tomorrowISO = today.add(1, 'day').format('YYYY-MM-DD');

  const db = await notion.databases.retrieve({ database_id: DB_ID });
  const dateProp = db.properties[DATE_PROP];
  const type = dateProp?.type;

  let filter;
  if (type === 'date') {
    filter = { property: DATE_PROP, date: { equals: todayISO } };
  } else if (type === 'created_time') {
    filter = {
      and: [
        { timestamp: 'created_time', created_time: { on_or_after: todayISO } },
        { timestamp: 'created_time', created_time: { before: tomorrowISO } }
      ]
    };
  } else {
    throw new Error(`Поле ${DATE_PROP} має непідтримуваний тип: ${type}`);
  }

  const q = await notion.databases.query({
    database_id: DB_ID,
    filter,
    page_size: 1
  });

  return q.results[0] || null;
}

// --- Створення нового запису ---
async function createTodayPage() {
  const today = dayjs().tz(TZ);
  const db = await notion.databases.retrieve({ database_id: DB_ID });
  const dateProp = db.properties[DATE_PROP];
  const type = dateProp?.type;

  const properties = {
    [TITLE_PROP]: {
      title: [{ type: 'text', text: { content: `Анкета дня — ${today.format('D MMMM YYYY')}` } }]
    }
  };
  if (type === 'date') {
    properties[DATE_PROP] = { date: { start: today.format('YYYY-MM-DD') } };
  }

  const page = await notion.pages.create({
    parent: { database_id: DB_ID },
    properties
  });
  return page;
}

async function appendFeedback(pageId, text) {
  const stamp = dayjs().tz(TZ).format('YYYY-MM-DD HH:mm');
  const title = `Фідбек ментора — ${stamp}`;
  const children = [
    {
      object: 'block',
      type: 'toggle',
      toggle: {
        rich_text: [{ type: 'text', text: { content: title } }],
        children: chunk(text).map(part => ({
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: [{ type: 'text', text: { content: part } }] }
        }))
      }
    }
  ];
  await notion.blocks.children.append({ block_id: pageId, children });
}

// --- MAIN ---
(async () => {
  const now = dayjs().tz(TZ);
  if (now.isBefore(CUTOFF)) {
    console.log('⏭ До 2025-08-15 не пишемо фідбек.');
    return;
  }

  let page = await findTodayPage();
  if (!page) page = await createTodayPage();

  // Перевірка на дату
  try {
    const start = page.properties?.[DATE_PROP]?.date?.start;
    if (start && dayjs.tz(start, TZ).isBefore(CUTOFF)) {
      console.log('⏭ Сторінка до 2025-08-15 — не змінюємо.');
      return;
    }
  } catch {}

  const parts = [];
  const pageMd = await pageToMarkdown(page.id);
  if (pageMd) parts.push(`# Анкета дня\n${pageMd}`);

  if (MENTEE_PAGE_ID) {
    const menteeMd = await pageToMarkdown(MENTEE_PAGE_ID);
    if (menteeMd) parts.push(`# Менті (контекст)\n${menteeMd}`);
  }

  const source = parts.join('\n\n---\n\n').trim();
  if (!source) {
    console.log('⚠️ Порожнє джерело для аналізу — скасовано.');
    return;
  }

  const feedback = await analyze(source);
  if (!feedback) {
    console.log('⚠️ Порожня відповідь моделі — скасовано.');
    return;
  }

  await appendFeedback(page.id, feedback);
  console.log('✅ Фідбек додано.');
})().catch(e => {
  console.error('❌ Помилка:', e?.message || e);
  process.exit(1);
});
