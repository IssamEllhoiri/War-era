/**
 * WarEra -> Discord Webhook
 * ---------------------------------------------------------
 * يراقب هذا السكربت آخر مقالات لعبة WarEra، ولما تنزل مقالة
 * جديدة يرسلها تلقائياً إلى قناة ديسكورد عبر Webhook باسم
 * الكاتب (username الخاص به من اللعبة).
 *
 * يحتاج Node.js نسخة 18 أو أحدث (فيها fetch مدمج بدون تنصيب
 * أي مكتبة إضافية).
 *
 * التشغيل:
 *   1) عدّل قيمة DISCORD_WEBHOOK_URL بالأسفل بقيمة الرابط
 *      الخاص بك من إعدادات القناة في ديسكورد.
 *   2) شغّل: node warera-discord-webhook.js
 *   3) اتركه شغّال (أو ركّبه على سيرفر / VPS / pm2 ليبقى دائم).
 * ---------------------------------------------------------
 */

// ============ الإعدادات ============
const DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/1542910320341815370/o-OPZcFf53vzVwKsYJACOnwO9yPypxmCgMroTVmCDT7mqIEk8lowKVWBtSS9m3ZP1zp0";

// كل كم ثانية يتحقق من مقالات جديدة (60 ثانية افتراضياً)
const POLL_INTERVAL_SECONDS = 60;

// نوع المقالات المطلوب مراقبتها: "daily" أو غيره حسب ما رجع معك بالـ API
const ARTICLE_TYPE = "daily";

// كم مقالة يجيب في كل طلب (يكفي رقم صغير لأننا فقط نبحث عن الجديد)
const FETCH_LIMIT = 10;

// ملف صغير يحفظ فيه آخر مقالة تمت معالجتها (حتى لا يرسل نفس
// المقالة مرتين حتى لو أعدت تشغيل السكربت)
const STATE_FILE = "./warera-last-article.json";

// ====================================

const fs = require("fs");

const ARTICLES_URL = "https://api2.warera.io/trpc/article.getArticlesPaginated";
const USER_URL = "https://api2.warera.io/trpc/user.getUserLite";
const ARTICLE_LINK_BASE = "https://app.warera.io/article";

// --- تحميل/حفظ آخر مقالة شفناها ---
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { lastArticleId: null, seenIds: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- طلب قائمة المقالات ---
async function fetchArticles() {
  const res = await fetch(ARTICLES_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: ARTICLE_TYPE,
      limit: FETCH_LIMIT,
    }),
  });

  if (!res.ok) {
    throw new Error(`فشل جلب المقالات: HTTP ${res.status}`);
  }

  const json = await res.json();
  return json?.result?.data?.items ?? [];
}

// --- طلب بيانات المستخدم (لاسم الكاتب) ---
async function fetchUsername(userId) {
  try {
    const res = await fetch(USER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });

    if (!res.ok) return "Unknown";

    const json = await res.json();
    const data = json?.result?.data;
    return data?.username || "Unknown";
  } catch {
    return "Unknown";
  }
}

// --- تنظيف الـ HTML البسيط من المحتوى لعرض مقتطف ---
function stripHtml(html, maxLength = 300) {
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLength ? text.slice(0, maxLength) + "..." : text;
}

// --- إرسال المقالة إلى Discord ---
async function sendToDiscord(article, authorName) {
  const articleUrl = `${ARTICLE_LINK_BASE}/${article.slug}`;

  const payload = {
    username: authorName, // اسم الويب هوك يصير باسم الكاتب
    embeds: [
      {
        title: article.title,
        url: articleUrl,
        description: stripHtml(article.content),
        color: 0x5865f2,
        footer: { text: `بواسطة ${authorName} • ${article.category}` },
        timestamp: article.publishedAt,
      },
    ],
  };

  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error(`فشل الإرسال لديسكورد: HTTP ${res.status}`);
  } else {
    console.log(`✅ تم إرسال: "${article.title}" (${authorName})`);
  }
}

// --- الدورة الرئيسية: تفحص وترسل الجديد ---
async function checkForNewArticles() {
  const state = loadState();
  let articles;

  try {
    articles = await fetchArticles();
  } catch (err) {
    console.error("خطأ أثناء جلب المقالات:", err.message);
    return;
  }

  // نرتبها من الأقدم للأحدث حتى ترسل بالترتيب الصحيح
  const newOnes = articles
    .filter((a) => !state.seenIds.includes(a._id))
    .reverse();

  if (newOnes.length === 0) {
    console.log("لا توجد مقالات جديدة.");
    return;
  }

  for (const article of newOnes) {
    const authorName = await fetchUsername(article.author);
    await sendToDiscord(article, authorName);

    state.seenIds.push(article._id);
  }

  // نحتفظ فقط بآخر 200 id حتى لا يكبر الملف بلا داعٍ
  state.seenIds = state.seenIds.slice(-200);
  saveState(state);
}

// --- أول تشغيل: يسجل المقالات الحالية بدون إرسالها ---
// (حتى لا يرسل كل الأرشيف دفعة وحدة أول مرة تشغل السكربت)
async function firstRunSetup() {
  const state = loadState();
  if (state.seenIds.length > 0) return; // مو أول مرة

  console.log("أول تشغيل: تسجيل المقالات الحالية بدون إرسال...");
  const articles = await fetchArticles();
  state.seenIds = articles.map((a) => a._id);
  saveState(state);
  console.log(`تم تسجيل ${state.seenIds.length} مقالة كبداية.`);
}

// --- تشغيل السكربت ---
(async () => {
  if (DISCORD_WEBHOOK_URL.includes("ضع_رابط")) {
    console.error("⚠️ لازم تحط رابط الويب هوك الصحيح في DISCORD_WEBHOOK_URL أول.");
    process.exit(1);
  }

  await firstRunSetup();
  await checkForNewArticles();

  setInterval(checkForNewArticles, POLL_INTERVAL_SECONDS * 1000);
  console.log(`🚀 السكربت شغّال، يفحص كل ${POLL_INTERVAL_SECONDS} ثانية...`);
})();
                                              
