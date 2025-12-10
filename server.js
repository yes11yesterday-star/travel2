// ==========================================================
// 🛡️ خبير الهجرة - Server (Secure, Fast & Stable)
// ==========================================================
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const path = require("path");
const rateLimit = require("express-rate-limit");
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const app = express();

// 1. السماح بالوصول من أي مكان (لضمان عمل الموقع دون مشاكل اتصال)
app.use(cors());

// 2. زيادة حجم البيانات المسموح بها لتجنب أخطاء الصور أو النصوص الكبيرة
app.use(express.json({ limit: "10mb" }));

// 🛡️ الحماية الأولى: منع الإغراق (Rate Limiting)
// يحمي السيرفر من التعليق بسبب كثرة الطلبات الوهمية
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 300, // رفعنا الحد لضمان عدم حظر المستخدمين العاديين بالخطأ
  message: { error: "تم تجاوز الحد المسموح من الطلبات." }
});
app.use(generalLimiter);

// 🛡️ الحماية الثانية: حماية خاصة لتوليد الخطط (حفاظاً على رصيد Gemini)
const planLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // 10 محاولات كل ربع ساعة كافية جداً
  message: { error: "يرجى الانتظار قليلاً قبل توليد خطة جديدة." }
});

// التحقق من المفاتيح
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!GEMINI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ تحذير: مفاتيح الربط ناقصة في ملف .env");
}

// الاتصال بقاعدة البيانات
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ===============================================
// 🔐 تسجيل الدخول وإنشاء الحساب
// ===============================================

app.post("/api/signup", async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) throw error;
    
    // إنشاء بروفايل بشكل صامت (لا يوقف العملية إذا فشل)
    try { await supabase.from("profiles").insert([{ user_id: data.user.id, display_name: email }]); } catch (e) {}
    
    res.json({ success: true, userId: data.user.id });
  } catch (err) {
    res.status(400).json({ error: "فشل إنشاء الحساب" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    res.json({ success: true, user: data.user, session: data.session });
  } catch (err) {
    res.status(400).json({ error: "بيانات الدخول غير صحيحة" });
  }
});

app.get("/api/subscription", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace("Bearer ", "").trim();
    if (!token) return res.json({ subscription: null });

    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) return res.json({ subscription: null });

    const { data: subscription } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    return res.json({ subscription });
  } catch (err) {
    res.json({ subscription: null });
  }
});

// ===============================================
// 📥 استرجاع السجل (سريع ومحسن)
// ===============================================
app.post("/api/chat/history", async (req, res) => {
  try {
    const { userId, conversationId } = req.body;

    // تحسين: استرجاع البيانات وترتيبها مباشرة
    const { data, error } = await supabase
      .from("chat_history")
      .select("*")
      .eq("user_id", userId)
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true }); // القديم أولاً ثم الجديد

    if (error) throw error;

    // إرجاع مصفوفة فارغة إذا لم يوجد بيانات بدلاً من الخطأ
    res.json({ history: data || [] });

  } catch (err) {
    console.error("History Error:", err.message);
    res.json({ history: [] }); // عدم كسر الصفحة عند الخطأ
  }
});

// حذف السجل
app.post("/api/chat/clear", async (req, res) => {
    try {
        const { userId, conversationId } = req.body;
        await supabase.from("chat_history").delete().eq("user_id", userId).eq("conversation_id", conversationId);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "حدث خطأ أثناء الحذف" });
    }
});

// ===============================================
// 🧠 توليد الخطة (المنطق الأساسي)
// ===============================================
app.post("/api/generate-plan", planLimiter, async (req, res) => {
  try {
    const { userId, conversationId, country, qaList } = req.body;

    // تجهيز النص لـ Gemini
    let interviewText = "";
    if (qaList && Array.isArray(qaList)) {
        interviewText = qaList.map(item => `❓ ${item.question}\n🗣️ ${item.answer}`).join("\n\n");
    }

    const planPrompt = `
    بصفتك مستشار هجرة، أنشئ خطة استراتيجية للهجرة إلى (${country}) بناءً على:
    ${interviewText}
    
    المطلوب تقرير احترافي ومفصل يحتوي على:
    1. تحليل الملف الشخصي.
    2. أفضل مسار للهجرة (اسم الفيزا).
    3. التكاليف المالية التقديرية.
    4. قائمة المستندات المطلوبة.
    5. الجدول الزمني المتوقع.
    6. نصائح لزيادة فرص القبول.
    
    استخدم الرموز التعبيرية ونسق النص بشكل جيد.
    `;

    // طلب الخطة من Google Gemini
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ role: "user", parts: [{ text: planPrompt }] }] },
      { headers: { "Content-Type": "application/json" } }
    );

    const planText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!planText) throw new Error("لم يتم توليد نص من Gemini");

    // محاولة الحفظ في الخلفية (دون انتظار النتيجة لعدم تأخير المستخدم)
    // نستخدم then/catch لمنع توقف الكود في حال فشل الحفظ
    supabase.from("chat_history").insert([
      {
        user_id: userId,
        conversation_id: conversationId,
        role: "assistant",
        message: planText
      }
    ]).then(({ error }) => {
        if (error) console.error("⚠️ فشل حفظ الخطة في القاعدة:", error.message);
    });

    // إرسال الخطة للمستخدم فوراً
    res.json({ plan: planText });

  } catch (err) {
    console.error("❌ Generation Error:", err.message);
    res.status(500).json({ error: "حدث خطأ أثناء توليد الخطة." });
  }
});

// ===============================================
// 🛡️ الحماية القصوى (The Secure Zone)
// ===============================================

// هذا السطر هو الذي يمنع سرقة الأكواد
// يخبر السيرفر أن الملفات المسموح برؤيتها موجودة فقط داخل مجلد 'public'
app.use(express.static(path.join(__dirname, "public")));

// أي رابط آخر يوجه المستخدم للصفحة الرئيسية (يدعم التصفح داخل الموقع)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running securely on port ${PORT}`);
});
