import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import multer from "multer";
import * as XLSX from "xlsx";
import { GoogleGenAI } from "@google/genai";
import mongoose, { Schema, model } from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

// ==========================================
// CONFIGURATION
// ==========================================
const MONGODB_URI =
  process.env.MONGODB_URI ||
  "mongodb+srv://trustspheretechnologiescom_db_user:AJ5kcyjdBJysJXpz@mri.max49nz.mongodb.net/mri_db";
const JWT_SECRET = process.env.SESSION_SECRET || "mri-jwt-secret-2024";
const UPLOAD_DIR = path.join(process.cwd(), "uploads");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ==========================================
// MONGOOSE MODELS
// ==========================================

const UserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true },
    password_hash: { type: String, required: true },
    full_name: { type: String, default: "" },
    role: { type: String, enum: ["admin", "editor", "user"], default: "user" },
    bio: { type: String, default: "" },
    profile_image_url: { type: String, default: "" },
    api_keys: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } }
);
// Helper to avoid "Cannot overwrite model once compiled" in hot-reload
function getModel(name: string, schema: Schema): mongoose.Model<any> {
  return (mongoose.models[name] as mongoose.Model<any>) || model(name, schema);
}

const User = getModel("User", UserSchema);

const AnalysisSchema = new Schema(
  {
    user_id: { type: String, required: true, index: true },
    title: { type: String, default: "" },
    content: { type: String, default: "" },
    content_type: { type: String, default: "service_page" },
    primary_keyword: { type: String, default: "" },
    secondary_keywords: { type: String, default: "" },
    target_language: { type: String, default: "English (US)" },
    country: { type: String, default: "United States" },
    meta_title: { type: String, default: "" },
    meta_description: { type: String, default: "" },
    meta_url: { type: String, default: "" },
    status: { type: String, default: "pending" },
    overall_score: { type: Number, default: 0 },
    module_scores: { type: Schema.Types.Mixed, default: {} },
    findings: { type: [Schema.Types.Mixed], default: [] },
    recommendations: { type: [Schema.Types.Mixed], default: [] },
    content_summary: { type: Schema.Types.Mixed, default: {} },
    top_strengths: { type: [String], default: [] },
    content_grade: { type: String, default: "" },
    publish_readiness: { type: String, default: "Pending Review" },
    estimated_improvement: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } }
);
const Analysis = getModel("Analysis", AnalysisSchema);

const ClientProfileSchema = new Schema(
  {
    user_id: { type: String, required: true, index: true },
    brand_name: { type: String, default: "" },
    website: { type: String, default: "" },
    industry: { type: String, default: "" },
    tone: { type: String, default: "" },
    primary_keywords: { type: String, default: "" },
    competitors: { type: String, default: "" },
    notes: { type: String, default: "" },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } }
);
const ClientProfile = getModel("ClientProfile", ClientProfileSchema);

const RulesSchema = new Schema({
  content_type: { type: String, required: true, unique: true },
  rules: { type: Schema.Types.Mixed, default: {} },
});
const Rules = getModel("Rules", RulesSchema);

const AppSettingsSchema = new Schema({
  key: { type: String, default: "global", unique: true },
  groq_api_key: { type: String, default: "" },
  gemini_api_key: { type: String, default: "" },
  ai_provider: { type: String, default: "groq" },
});
const AppSettings = getModel("AppSettings", AppSettingsSchema);

// ==========================================
// AUTH HELPERS
// ==========================================

function generateToken(userId: string): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: "30d" });
}

async function getUserFromRequest(req: express.Request): Promise<any | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
    const user = await User.findById(decoded.userId).lean();
    return user || null;
  } catch {
    return null;
  }
}

const requireAuth = async (req: any, res: express.Response, next: express.NextFunction) => {
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });
  req.user = user;
  next();
};

const requireAdmin = async (req: any, res: express.Response, next: express.NextFunction) => {
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });
  if ((user as any).role !== "admin") return res.status(403).json({ message: "Admin access required" });
  req.user = user;
  next();
};

function safeUser(user: any) {
  const { password_hash, __v, ...rest } = user;
  return { ...rest, id: rest._id?.toString() };
}

// ==========================================
// AI CLIENTS
// ==========================================

async function getAppSettings(): Promise<any> {
  try {
    const s = await AppSettings.findOne({ key: "global" }).lean();
    return s || {};
  } catch {
    return {};
  }
}

async function callGroqAPI(prompt: string): Promise<any> {
  const settings = await getAppSettings();
  const apiKey = (settings as any).groq_api_key || process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is missing. Set it in Admin Settings.");

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content:
            "You are a strict JSON output generator. Return ONLY valid JSON using EXACTLY the field names specified. Never rename, alias, or abbreviate fields. No markdown, no explanation outside the JSON.",
        },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq API Error: ${response.status} - ${err}`);
  }
  const data = await response.json();
  return JSON.parse(data.choices[0].message.content);
}

async function callGeminiAPI(prompt: string): Promise<any> {
  const settings = await getAppSettings();
  const apiKey = (settings as any).gemini_api_key || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Gemini API key is missing. Set it in Admin Settings.");

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      temperature: 0.1,
      systemInstruction:
        "You are a strict JSON output generator. Return ONLY valid JSON using EXACTLY the field names specified. Never rename, alias, or abbreviate fields. No markdown, no explanation outside the JSON.",
    },
  });

  const text = response.text;
  if (!text) throw new Error("Gemini returned an empty response.");
  return JSON.parse(text);
}

async function callAI(prompt: string): Promise<any> {
  const settings = await getAppSettings();
  const provider = (settings as any).ai_provider || "groq";
  return provider === "gemini" ? callGeminiAPI(prompt) : callGroqAPI(prompt);
}

// ==========================================
// FIELD NORMALIZER — fixes the "undefined" issue
// ==========================================
function normalizeIssue(issue: any, moduleName: string, index: number): any {
  const raw = issue || {};

  // Severity must be exactly one of these
  const validSeverities = ["Critical", "High", "Medium", "Low"];
  let severity = raw.severity;
  if (!validSeverities.includes(severity)) {
    if (severity === "Warning") severity = "Medium";
    else if (severity === "Notice") severity = "Low";
    else severity = "Medium";
  }

  return {
    rule_id: raw.rule_id || `${moduleName}-${Date.now()}-${index}`,
    module: moduleName,
    // problem — try many possible field names the AI might use
    problem:
      raw.problem ||
      raw.issue ||
      raw.issue_title ||
      raw.title ||
      raw.name ||
      raw.heading ||
      "Issue detected",
    // why_it_matters — try many possible field names
    why_it_matters:
      raw.why_it_matters ||
      raw.reason ||
      raw.impact ||
      raw.explanation ||
      raw.why ||
      raw.description ||
      raw.details ||
      "This affects content quality and SEO performance.",
    severity,
    location: raw.location || raw.where || raw.section || raw.position || "",
    // ready_to_paste_fix — the most commonly aliased field
    ready_to_paste_fix:
      raw.ready_to_paste_fix ||
      raw.fix_output ||
      raw.fix ||
      raw.suggested_fix ||
      raw.suggestion ||
      raw.replacement ||
      raw.recommended_fix ||
      raw.correction ||
      raw.rewrite ||
      "",
    highlighted_text:
      raw.highlighted_text ||
      raw.current_text ||
      raw.problematic_text ||
      raw.original_text ||
      raw.text ||
      raw.excerpt ||
      "",
    fix_type:
      raw.fix_type ||
      raw.fixType ||
      raw.apply_fix_type ||
      raw.type ||
      "replace_sentence",
    apply_fix: true,
    applied: false,
    recheck_modules: [moduleName],
  };
}

// ==========================================
// SEED DATA — Rules from Content Type Matrix
// ==========================================
const SEED_RULES: Record<string, Record<string, string>> = {
  on_page_blog: {
    "Primary Keyword in H1": "Required",
    "Primary Keyword in Meta Title": "Required",
    "Primary Keyword in First 100 Words": "Required",
    "Primary Keyword in at Least 1 H2": "Required",
    "Primary Keyword in Last 100 Words": "Required",
    "Secondary Keywords": "Required",
    "LSI / Semantic Keywords": "Required",
    "FAQ Required": "7-10 FAQs",
    "Internal Links": "Required",
    "External Authority Link": "Required",
    "CTA Required": "Recommended",
    "Brand Name in Introduction": "Required",
    "Brand Name Naturally Throughout Content": "2-4 Times",
    "Brand Mention in Conclusion": "Required",
    "EEAT Signals": "Required",
    "Content Length": "1000+ words",
  },
  guest_blog: {
    "Primary Keyword in First 100 Words": "Required",
    "Secondary Keywords": "Limited",
    "LSI / Semantic Keywords": "Required",
    "Client Anchor Text + Link": "1 Required",
    "Brand Name Naturally Throughout Content": "1-2 Times",
    "EEAT Signals": "Required",
    "Non-Promotional Tone": "Required",
    "Editorial Fit": "Required",
  },
  service_page: {
    "Primary Keyword in H1": "Required",
    "Primary Keyword in Meta Title": "Required",
    "Primary Keyword in First 100 Words": "Required",
    "Primary Keyword in at Least 1 H2": "Required",
    "Primary Keyword in Last 100 Words": "Required",
    "Secondary Keywords": "Required",
    "LSI / Semantic Keywords": "Required",
    "EEAT Signals": "Required",
    "CTA Required": "Required",
    "Brand Name in H1": "Required",
    "Brand Name in Introduction": "Required",
    "Brand Name Naturally Throughout Content": "3-5 Times",
    "Brand Mention in Conclusion": "Required",
    "Brand Mention in CTA": "Required",
    "Internal Links": "Required",
    "External Authority Link": "Required",
    "FAQ Required": "Optional",
    "Trust Signals (Reviews/Certifications)": "Required",
    "Service Description Clarity": "Required",
    "Process or Steps Section": "Recommended",
  },
  landing_page: {
    "Primary Keyword in H1": "Required",
    "Primary Keyword in Meta Title": "Required",
    "Primary Keyword in First 100 Words": "Required",
    "Primary Keyword in at Least 1 H2": "Required",
    "Primary Keyword in Last 100 Words": "Recommended",
    "Secondary Keywords": "Required",
    "CTA Required": "Critical",
    "EEAT Signals": "Required",
    "Brand Name in H1": "Required",
    "Brand Name in Introduction": "Required",
    "Brand Name Naturally Throughout Content": "3-5 Times",
    "Brand Mention in CTA": "Critical",
    "Internal Links": "Required",
    "Hero Section Clarity": "Required",
    "Value Proposition": "Required",
    "Social Proof / Trust Signals": "Required",
    "Objection Handling": "Recommended",
    "Urgency / Scarcity Element": "Recommended",
  },
  location_page: {
    "Primary Keyword in H1": "Required",
    "Primary Keyword in Meta Title": "Required",
    "Primary Keyword in First 100 Words": "Required",
    "Primary Keyword in at Least 1 H2": "Required",
    "Primary Keyword in Last 100 Words": "Required",
    "Secondary Keywords": "Required",
    "CTA Required": "Required",
    "Brand Name in H1": "Required",
    "Brand Name in Introduction": "Required",
    "Brand Name Naturally Throughout Content": "3-5 Times",
    "Internal Links": "Required",
    "FAQ Required": "5-7 FAQs",
    "Local SEO Elements": "Required",
    "City / Service Relevance": "Required",
    "Local Proof (Reviews/Testimonials)": "Required",
    "Nearby Areas Mention": "Recommended",
  },
  homepage: {
    "Primary Keyword in H1": "Required",
    "Primary Keyword in Meta Title": "Required",
    "Primary Keyword in First 100 Words": "Required",
    "Primary Keyword in at Least 1 H2": "Recommended",
    "Secondary Keywords": "Required",
    "CTA Required": "Required",
    "Brand Name in H1": "Required",
    "Brand Name in Introduction": "Required",
    "Brand Name Naturally Throughout Content": "3-5 Times",
    "Internal Links": "Required",
    "Trust Signals": "Required",
    "Value Proposition": "Required",
    "Service Overview": "Required",
    "User Journey Clarity": "Required",
  },
  about_page: {
    "Primary Keyword in H1": "Required",
    "Primary Keyword in Meta Title": "Required",
    "Primary Keyword in First 100 Words": "Required",
    "Primary Keyword in at Least 1 H2": "Recommended",
    "Secondary Keywords": "Required",
    "Brand Name in H1": "Required",
    "Brand Name in Introduction": "Required",
    "Brand Name Naturally Throughout Content": "3-5 Times",
    "EEAT Signals": "Required",
    "Company Story": "Required",
    "Credibility Signals": "Required",
    "Team / Mission Section": "Recommended",
    "Brand Mention in Conclusion": "Recommended",
  },
  product_page: {
    "Primary Keyword in H1": "Required",
    "Primary Keyword in Meta Title": "Required",
    "Primary Keyword in First 100 Words": "Recommended",
    "Primary Keyword in at Least 1 H2": "Recommended",
    "Secondary Keywords": "Required",
    "CTA Required": "Required",
    "Brand Mention in CTA": "Required",
    "Internal Links": "Recommended",
    "Product Description Clarity": "Required",
    "Features and Benefits": "Required",
    "Trust Signals (Reviews/Ratings)": "Required",
    "Shipping / Returns Info": "Recommended",
  },
  product_description: {
    "Primary Keyword in H1": "Recommended",
    "Primary Keyword in First 100 Words": "Recommended",
    "Secondary Keywords": "Limited",
    "CTA Required": "Required",
    "Brand Mention in CTA": "Required",
    "Benefit-Led Copy": "Required",
    "Feature-Benefit Clarity": "Required",
    "Scannability": "Required",
    "Brand Name Naturally Throughout Content": "1-2 Times",
  },
  category_page: {
    "Primary Keyword in H1": "Required",
    "Primary Keyword in Meta Title": "Required",
    "Primary Keyword in First 100 Words": "Required",
    "Primary Keyword in at Least 1 H2": "Recommended",
    "Secondary Keywords": "Required",
    "Internal Links": "Recommended",
    "Category Introduction": "Required",
    "Buying Guidance": "Required",
    "Category Navigation / Filters": "Required",
    "Brand Name Naturally Throughout Content": "2-4 Times",
  },
  category_description: {
    "Primary Keyword in H1": "Recommended",
    "Primary Keyword in First 100 Words": "Recommended",
    "Secondary Keywords": "Limited",
    "Category Benefits": "Required",
    "Brand Name Naturally Throughout Content": "1-2 Times",
  },
  gbp_description: {
    "Primary Keyword Density": "Natural",
    "Secondary Keywords": "Limited",
    "Brand Name in Introduction": "Required",
    "Brand Name Naturally Throughout Content": "1-2 Times",
    "CTA Required": "Call / Visit",
    "Local SEO Elements": "Required",
    "Service Clarity": "Required",
  },
  faq_page: {
    "Primary Keyword in H1": "Recommended",
    "Primary Keyword in First 100 Words": "Recommended",
    "Secondary Keywords": "Required",
    "LSI / Semantic Keywords": "Required",
    "FAQ as Primary Content": "Required",
    "FAQ Count": "10-20 Questions",
    "Schema Markup Ready": "Required",
  },
  press_release: {
    "Primary Keyword in H1": "Optional",
    "Primary Keyword in First 100 Words": "Optional",
    "Secondary Keywords": "Limited",
    "External Authority Link": "Required",
    "Client Anchor Text + Link": "Optional",
    "Brand Name in Introduction": "Optional",
    "Brand Name Naturally Throughout Content": "1-2 Times",
    "Journalistic Tone": "Required",
    "News Hook": "Required",
    "Quote Required": "Required",
  },
  case_study: {
    "Primary Keyword in H1": "Recommended",
    "Primary Keyword in First 100 Words": "Recommended",
    "Secondary Keywords": "Required",
    "EEAT Signals": "Required",
    "Brand Name in Introduction": "Required",
    "Brand Name Naturally Throughout Content": "2-4 Times",
    "Brand Mention in Conclusion": "Recommended",
    "Results / Data Section": "Required",
    "Client Proof / Testimonial": "Required",
    "Before / After Comparison": "Required",
    "CTA Required": "Recommended",
  },
};

async function seedDatabase() {
  try {
    // Admin user
    const userCount = await User.countDocuments();
    if (userCount === 0) {
      const password_hash = await bcrypt.hash("password", 10);
      await User.create({
        email: "trustsphereowner@gmail.com",
        password_hash,
        full_name: "TrustSphere Owner",
        role: "admin",
      });
      console.log("[Seed] Default admin created: trustsphereowner@gmail.com / password");
    }

    // Rules
    const rulesCount = await Rules.countDocuments();
    if (rulesCount === 0) {
      const ops = Object.entries(SEED_RULES).map(([content_type, rules]) => ({
        updateOne: { filter: { content_type }, update: { $set: { rules } }, upsert: true },
      }));
      await Rules.bulkWrite(ops);
      console.log(`[Seed] Rules seeded for ${Object.keys(SEED_RULES).length} content types.`);
    }

    // AppSettings
    const settingsCount = await AppSettings.countDocuments();
    if (settingsCount === 0) {
      await AppSettings.create({ key: "global", ai_provider: "groq" });
    }
  } catch (e) {
    console.error("[Seed] Error:", e);
  }
}

// ==========================================
// MODULE AGENT DEFINITIONS
// ==========================================
const MODULE_AGENTS: Record<string, string> = {
  IntentIQ: `You are IntentIQ, the Search Intent Analyst. Check:
1. Does the content type and body match the primary keyword's search intent (Informational/Commercial/Transactional/Local)?
2. Does the introduction answer the user's main query within the first 150 words?
3. Do all sections support the primary intent, or are there off-topic blocks?
4. Are common follow-up questions for this keyword answered?
5. Does the content match the correct funnel stage?`,

  ExpertProof: `You are ExpertProof, the EEAT Signals Analyst. Check:
1. Are claims backed by evidence, data, or citations?
2. Is real first-hand experience demonstrated (not just generic advice)?
3. Are credentials, case studies, certifications, or testimonials present?
4. Is the author/brand position of authority established?
5. Are there any unsupported superlative claims ("best", "only", "guaranteed")?`,

  SearchReady: `You are SearchReady, the SEO Technical Analyst. Check:
1. Does the H1 heading contain the primary keyword?
2. Do H2 headings include keyword variations?
3. Is the primary keyword in the first 100 words?
4. Is the primary keyword in the last 100 words?
5. Is keyword density appropriate (not too sparse, not keyword-stuffed)?
6. Are LSI/semantic keywords naturally present?
7. Are meta title and meta description optimized?`,

  HumanFlow: `You are HumanFlow, the Readability & Writing Quality Analyst. Check:
1. Is passive voice overused?
2. Are sentence lengths varied (mix of short and long sentences)?
3. Are there robotic, repetitive, or AI-generated patterns?
4. Are transition words used for flow?
5. Is the paragraph length appropriate (not walls of text)?
6. Is the readability level appropriate for the target audience?`,

  DepthIndex: `You are DepthIndex, the Topical Depth & Comprehensiveness Analyst. Check:
1. Is the topic covered thoroughly or is it surface-level?
2. Are important sub-topics or sections missing?
3. Are common reader questions answered?
4. Is the content length appropriate for this content type?
5. Are there FAQ sections where expected?
6. Are there content gaps that competitors would cover?`,

  ConvertIQ: `You are ConvertIQ, the Conversion Optimization Analyst. Check:
1. Is there a clear, compelling CTA (Call to Action)?
2. Are reader objections and pain points addressed?
3. Is copy benefit-led rather than feature-led?
4. Are urgency or scarcity elements present where appropriate?
5. Is the value proposition clearly stated?
6. Does the CTA stand out and appear at the right moments?`,

  TrustShield: `You are TrustShield, the Trust & Compliance Analyst. Check:
1. Are there any dangerous, misleading, or unverifiable claims?
2. Are superlatives ("best", "number 1", "guaranteed") substantiated?
3. Is the content free of spammy patterns or clickbait?
4. For YMYL (health/finance/legal) topics, are appropriate disclaimers present?
5. Is there consistency in facts throughout the content?
6. Are there any compliance or legal risks?`,

  OriginalityIQ: `You are OriginalityIQ, the Content Originality Analyst. Check:
1. Is the content generic, templated, or could apply to any similar business?
2. Are there unique insights, data, local angles, or proprietary information?
3. Is the content differentiated from what competitors likely publish?
4. Does it offer genuine value beyond surface-level information?
5. Are there specific examples, stories, or case studies?`,

  LanguageGuard: `You are LanguageGuard, the Language Quality Analyst. Check:
1. Are there spelling or grammar errors?
2. Is the language localized correctly for the target region (e.g., US vs UK English)?
3. Is brand voice consistent throughout?
4. Is the tone professional and appropriate for the content type?
5. Are punctuation and formatting consistent?`,
};

// ==========================================
// START SERVER
// ==========================================
async function startServer() {
  // Connect to MongoDB
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("[MongoDB] Connected successfully");
    await seedDatabase();
  } catch (e) {
    console.error("[MongoDB] Connection failed:", e);
    process.exit(1);
  }

  const app = express();
  const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

  app.use(cors({ origin: process.env.FRONTEND_URL || true, credentials: true }));
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: true, limit: "50mb" }));
  app.use("/uploads", express.static(UPLOAD_DIR));

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname);
      const name = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9]/g, "_");
      cb(null, `${name}_${Date.now()}${ext}`);
    },
  });
  const upload = multer({ storage });

  // ==========================================
  // ASYNC ERROR HANDLER
  // ==========================================
  const asyncHandler =
    (fn: (req: any, res: express.Response, next: express.NextFunction) => Promise<any>) =>
    (req: any, res: express.Response, next: express.NextFunction) => {
      Promise.resolve(fn(req, res, next)).catch(next);
    };

  // ==========================================
  // AUTH ROUTES
  // ==========================================

  app.get("/api/auth/me", async (req, res) => {
    const user = await getUserFromRequest(req);
    if (!user) return res.status(401).json({ message: "Unauthorized" });
    res.json(safeUser(user));
  });

  app.put("/api/auth/me", requireAuth, async (req: any, res) => {
    const { full_name, bio, profile_image_url, api_keys } = req.body;
    const update: any = {};
    if (full_name !== undefined) update.full_name = full_name;
    if (bio !== undefined) update.bio = bio;
    if (profile_image_url !== undefined) update.profile_image_url = profile_image_url;
    if (api_keys !== undefined) update.api_keys = api_keys;
    const updated = await User.findByIdAndUpdate(req.user._id, update, { new: true }).lean();
    if (!updated) return res.status(404).json({ message: "User not found" });
    res.json(safeUser(updated));
  });

  app.post("/api/auth/register", async (req, res) => {
    const { email, password, full_name } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: "Email and password are required." });

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(400).json({ message: "Email is already registered." });

    const password_hash = await bcrypt.hash(password, 10);
    const newUser = await User.create({
      email: email.toLowerCase(),
      password_hash,
      full_name: full_name || email.split("@")[0],
      role: "editor",
    });

    const token = generateToken(newUser._id.toString());
    res.json({ access_token: token, user: safeUser(newUser.toObject()) });
  });

  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findOne({ email: email?.toLowerCase() }).lean();
    if (!user) return res.status(400).json({ message: "Invalid credentials" });

    const valid = await bcrypt.compare(password, (user as any).password_hash);
    if (!valid) return res.status(400).json({ message: "Invalid credentials" });

    const token = generateToken((user as any)._id.toString());
    res.json({ access_token: token, user: safeUser(user) });
  });

  // OTP / password reset stubs (not fully implemented — email service not configured)
  app.post("/api/auth/verify-otp", (req, res) => {
    res.json({ success: true, message: "OTP verification not required." });
  });
  app.post("/api/auth/resend-otp", (req, res) => {
    res.json({ success: true, message: "OTP resent." });
  });
  app.post("/api/auth/reset-password-request", (req, res) => {
    res.json({ success: true, message: "If this email exists, a reset link has been sent." });
  });
  app.post("/api/auth/reset-password", (req, res) => {
    res.json({ success: true, message: "Password reset successful." });
  });

  // ==========================================
  // FILE UPLOAD
  // ==========================================

  app.post("/api/upload", requireAuth, upload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ message: "No file uploaded." });
    res.json({ file_url: `/uploads/${req.file.filename}`, filename: req.file.filename });
  });

  // ==========================================
  // USERS
  // ==========================================

  app.post("/api/users/invite", requireAdmin, async (req: any, res) => {
    const { email, role } = req.body;
    if (!email) return res.status(400).json({ message: "Email is required." });
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(400).json({ message: "User already exists." });
    const tempPassword = Math.random().toString(36).slice(-10) + "A1!";
    const password_hash = await bcrypt.hash(tempPassword, 10);
    await User.create({ email: email.toLowerCase(), password_hash, role: role || "user", full_name: email.split("@")[0] });
    res.json({ success: true, message: `User ${email} created with temporary password: ${tempPassword}` });
  });

  // ==========================================
  // ADMIN ROUTES (admin only)
  // ==========================================

  app.get("/api/admin/settings", requireAdmin, async (_req, res) => {
    const settings = await AppSettings.findOne({ key: "global" }).lean();
    const { __v, _id, ...safe } = (settings as any) || {};
    res.json(safe || {});
  });

  app.post("/api/admin/settings", requireAdmin, async (req: any, res) => {
    const { groq_api_key, gemini_api_key, ai_provider } = req.body;
    const update: any = {};
    if (groq_api_key !== undefined) update.groq_api_key = groq_api_key;
    if (gemini_api_key !== undefined) update.gemini_api_key = gemini_api_key;
    if (ai_provider !== undefined) update.ai_provider = ai_provider;
    const settings = await AppSettings.findOneAndUpdate(
      { key: "global" },
      { $set: update },
      { upsert: true, new: true }
    ).lean();
    res.json({ success: true, message: "Settings updated!", settings });
  });

  app.get("/api/admin/rules", requireAdmin, async (req, res) => {
    const ct = req.query.content_type as string;
    if (ct) {
      const ruleSet = await Rules.findOne({ content_type: ct }).lean();
      return res.json((ruleSet as any)?.rules || {});
    }
    const all = await Rules.find().lean();
    const result: Record<string, any> = {};
    all.forEach((r: any) => { result[r.content_type] = r.rules; });
    res.json(result);
  });

  app.post("/api/admin/rules", requireAdmin, async (req: any, res) => {
    const { content_type, rule_key, rule_value } = req.body;
    await Rules.findOneAndUpdate(
      { content_type },
      { $set: { [`rules.${rule_key}`]: rule_value } },
      { upsert: true }
    );
    res.json({ success: true, message: "Rule updated!" });
  });

  app.delete("/api/admin/rules", requireAdmin, async (req: any, res) => {
    const { content_type, rule_key } = req.body;
    await Rules.findOneAndUpdate({ content_type }, { $unset: { [`rules.${rule_key}`]: "" } });
    res.json({ success: true });
  });

  app.post("/api/admin/rules/bulk-upload", requireAdmin, upload.single("file"), async (req: any, res) => {
    if (!req.file) return res.status(400).json({ message: "No file uploaded." });
    try {
      const buf = fs.readFileSync(req.file.path);
      const wb = XLSX.read(buf, { type: "buffer" });
      let importedCount = 0;

      for (const sheetName of wb.SheetNames) {
        const rows: any[] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });
        for (const row of rows) {
          const norm: Record<string, any> = {};
          Object.keys(row).forEach((k) => { norm[k.trim().toLowerCase().replace(/[\s_]+/g, "_")] = row[k]; });

          const ct = String(
            norm["content_type"] || norm["contenttype"] || norm["page_type"] || sheetName || "default"
          ).trim().toLowerCase().replace(/[\s-]+/g, "_") || "default";

          const rk = String(
            norm["rule_key"] || norm["rule_name"] || norm["rule"] || norm["requirement"] || ""
          ).trim();

          const rv = String(norm["rule_value"] || norm["value"] || norm["status"] || "Required").trim();

          if (!rk) continue;
          await Rules.findOneAndUpdate({ content_type: ct }, { $set: { [`rules.${rk}`]: rv || "Required" } }, { upsert: true });
          importedCount++;
        }
      }

      if (importedCount === 0)
        return res.status(400).json({ message: "No valid rule rows found. Expected: content_type, rule_key, rule_value columns." });

      res.json({ success: true, message: `Imported ${importedCount} rule(s).`, imported: importedCount });
    } catch (e: any) {
      console.error("Bulk upload error:", e);
      res.status(500).json({ message: e.message || "Failed to parse file." });
    } finally {
      fs.unlink(req.file.path, () => {});
    }
  });

  // ==========================================
  // PUBLIC RULES READ (auth required, not admin-only)
  // Used by the analysis flow for non-admin users
  // ==========================================

  app.get("/api/rules", requireAuth, asyncHandler(async (req: any, res: express.Response) => {
    const ct = req.query.content_type as string;
    if (ct) {
      const ruleSet = await Rules.findOne({ content_type: ct }).lean();
      return res.json((ruleSet as any)?.rules || {});
    }
    const all = await Rules.find().lean();
    const result: Record<string, any> = {};
    all.forEach((r: any) => { result[r.content_type] = r.rules; });
    res.json(result);
  }));

  // ==========================================
  // ANALYSIS CRUD
  // ==========================================

  app.get("/api/analysis", requireAuth, async (req: any, res) => {
    const limit = parseInt(req.query.limit as string) || 100;
    const filter = req.user.role === "admin" ? {} : { user_id: req.user._id.toString() };
    const items = await Analysis.find(filter).sort({ created_at: -1 }).limit(limit).lean();
    res.json(items.map((a: any) => ({ ...a, id: a._id.toString() })));
  });

  app.get("/api/analysis/:id", requireAuth, async (req: any, res) => {
    const item = await Analysis.findById(req.params.id).lean();
    if (!item) return res.status(404).json({ message: "Analysis not found" });
    if (req.user.role !== "admin" && (item as any).user_id !== req.user._id.toString())
      return res.status(403).json({ message: "Forbidden" });
    res.json({ ...(item as any), id: (item as any)._id.toString() });
  });

  app.post("/api/analysis", requireAuth, async (req: any, res) => {
    const doc = await Analysis.create({ ...req.body, user_id: req.user._id.toString() });
    res.json({ ...doc.toObject(), id: doc._id.toString() });
  });

  app.put("/api/analysis/:id", requireAuth, async (req: any, res) => {
    const item = await Analysis.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Analysis not found" });
    if (req.user.role !== "admin" && (item as any).user_id !== req.user._id.toString())
      return res.status(403).json({ message: "Forbidden" });
    const { user_id: _u, _id: _i, ...body } = req.body;
    const updated = await Analysis.findByIdAndUpdate(req.params.id, body, { new: true }).lean();
    res.json({ ...(updated as any), id: (updated as any)._id.toString() });
  });

  app.delete("/api/analysis/:id", requireAuth, async (req: any, res) => {
    const item = await Analysis.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Analysis not found" });
    if (req.user.role !== "admin" && (item as any).user_id !== req.user._id.toString())
      return res.status(403).json({ message: "Forbidden" });
    await Analysis.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  });

  // ==========================================
  // CLIENT PROFILES
  // ==========================================

  app.get("/api/client-profiles", requireAuth, async (req: any, res) => {
    const filter = req.user.role === "admin" ? {} : { user_id: req.user._id.toString() };
    const profiles = await ClientProfile.find(filter).sort({ created_at: -1 }).lean();
    res.json(profiles.map((p: any) => ({ ...p, id: p._id.toString() })));
  });

  app.post("/api/client-profiles", requireAuth, async (req: any, res) => {
    const doc = await ClientProfile.create({ ...req.body, user_id: req.user._id.toString() });
    res.json({ ...doc.toObject(), id: doc._id.toString() });
  });

  app.put("/api/client-profiles/:id", requireAuth, async (req: any, res) => {
    const item = await ClientProfile.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Profile not found" });
    if (req.user.role !== "admin" && (item as any).user_id !== req.user._id.toString())
      return res.status(403).json({ message: "Forbidden" });
    const updated = await ClientProfile.findByIdAndUpdate(req.params.id, req.body, { new: true }).lean();
    res.json({ ...(updated as any), id: (updated as any)._id.toString() });
  });

  app.delete("/api/client-profiles/:id", requireAuth, async (req: any, res) => {
    const item = await ClientProfile.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Profile not found" });
    if (req.user.role !== "admin" && (item as any).user_id !== req.user._id.toString())
      return res.status(403).json({ message: "Forbidden" });
    await ClientProfile.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  });

  // ==========================================
  // CORE MRI ANALYSIS ENGINE
  // ==========================================

  app.post("/api/analyze", requireAuth, async (req: any, res) => {
    try {
      const { content, content_type, primary_keyword, enabled_modules, rulesText, country } = req.body;
      if (!content || !primary_keyword)
        return res.status(400).json({ message: "Content and Primary Keyword are required." });

      // Deterministic checks (always run, no AI needed)
      const deterministicIssues: any[] = [];
      if (!content.match(/^H1\s|^#\s/im)) {
        deterministicIssues.push({
          rule_id: "DET-H1-001",
          module: "SearchReady",
          severity: "Critical",
          highlighted_text: "",
          problem: `Missing H1 heading with primary keyword.`,
          why_it_matters:
            "The H1 is the most critical on-page SEO signal. Google uses it to understand the page's primary topic and keyword.",
          fix_type: "replace_heading",
          location: "Start of document",
          ready_to_paste_fix: `H1 ${primary_keyword.charAt(0).toUpperCase() + primary_keyword.slice(1)} — Professional Services`,
          apply_fix: true,
          applied: false,
          recheck_modules: ["SearchReady"],
        });
      }

      const modulesToRun =
        enabled_modules?.length > 0 ? enabled_modules : Object.keys(MODULE_AGENTS);

      const aiPromises = modulesToRun.map(async (moduleName: string) => {
        if (!MODULE_AGENTS[moduleName]) return null;

        const prompt = `
${MODULE_AGENTS[moduleName]}

--- CONTENT TO ANALYZE ---
${content.substring(0, 8000)}
--- END CONTENT ---

CONTEXT:
- Primary Keyword: "${primary_keyword}"
- Content Type: "${content_type || "Service Page"}"
- Country / Region: "${country || "United States"}"
- Dynamic Rules for this content type:
${rulesText || "Apply standard SEO and content best practices."}

INSTRUCTIONS:
- Find every distinct quality issue in the above content for the ${moduleName} dimension.
- Return 2–6 issues if problems exist; 0 issues only if content is genuinely excellent (score ≥ 95).
- Each issue MUST reference a different, specific part of the content.
- Do NOT repeat the same issue twice.

REQUIRED JSON OUTPUT — use EXACTLY these field names, no exceptions:
{
  "score": <integer 0-100>,
  "issues": [
    {
      "problem": "<short plain-English issue title>",
      "why_it_matters": "<1-2 sentences on SEO/UX/conversion impact>",
      "severity": "<EXACTLY one of: Critical, High, Medium, Low>",
      "location": "<e.g. H1 heading, Introduction paragraph, Second H2>",
      "highlighted_text": "<copy the exact problematic phrase/sentence from the content, or empty string if structural>",
      "ready_to_paste_fix": "<complete replacement text ready to paste — required, cannot be empty>",
      "fix_type": "<one of: replace_sentence, replace_heading, insert_paragraph, add_cta, rewrite_section, remove_text>"
    }
  ]
}
`.trim();

        try {
          const result = await callAI(prompt);
          if (!result.issues || !Array.isArray(result.issues)) result.issues = [];
          return { module: moduleName, data: result };
        } catch (err: any) {
          console.error(`[${moduleName}] AI call failed:`, err.message);
          return null;
        }
      });

      const aiResults = (await Promise.all(aiPromises)).filter(Boolean);

      const moduleScores: Record<string, number> = {};
      let allFindings = [...deterministicIssues];

      aiResults.forEach((result: any) => {
        if (!result?.data) return;
        const score = typeof result.data.score === "number" ? Math.max(0, Math.min(100, result.data.score)) : 70;
        moduleScores[result.module] = score;
        if (Array.isArray(result.data.issues)) {
          const normalized = result.data.issues
            .filter((i: any) => i && typeof i === "object")
            .map((i: any, idx: number) => normalizeIssue(i, result.module, idx));
          allFindings = [...allFindings, ...normalized];
        }
      });

      const validScores = Object.values(moduleScores).filter((s) => !isNaN(s));
      const overallScore =
        validScores.length > 0
          ? Math.round(validScores.reduce((a, b) => a + b, 0) / validScores.length)
          : 0;

      // Derived metrics
      const criticalCount = allFindings.filter((f) => f.severity === "Critical").length;
      const highCount = allFindings.filter((f) => f.severity === "High").length;
      const estimatedImprovement = Math.min(criticalCount * 5 + highCount * 3, 30);

      const publishReadiness =
        overallScore >= 85
          ? "Publish Ready"
          : overallScore >= 75
          ? "Almost Ready"
          : overallScore >= 60
          ? "Needs Review"
          : "Not Ready";

      const contentGrade =
        overallScore >= 95 ? "A+" :
        overallScore >= 90 ? "A" :
        overallScore >= 85 ? "B+" :
        overallScore >= 80 ? "B" :
        overallScore >= 70 ? "C" : "D";

      const moduleStrengthLabels: Record<string, string> = {
        IntentIQ: "Strong intent alignment",
        ExpertProof: "Good EEAT signals",
        DepthIndex: "Strong topical coverage",
        HumanFlow: "High readability",
        SearchReady: "Good keyword optimization",
        ConvertIQ: "Strong conversion elements",
        TrustShield: "Trusted, compliant content",
        OriginalityIQ: "Original unique content",
        LanguageGuard: "Clean professional language",
      };

      const topStrengths = Object.entries(moduleScores)
        .filter(([, s]) => s >= 80)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 4)
        .map(([mod]) => moduleStrengthLabels[mod] || mod);

      res.json({
        request_id: `req-${Date.now()}`,
        overall_score: overallScore,
        module_scores: moduleScores,
        findings: allFindings,
        estimated_improvement: estimatedImprovement,
        publish_readiness: publishReadiness,
        content_grade: contentGrade,
        top_strengths: topStrengths,
      });
    } catch (e: any) {
      console.error("[MRI] Analysis failed:", e);
      res.status(500).json({ message: e.message || "MRI Analysis Engine Failed." });
    }
  });

  app.post("/api/apply-fix", requireAuth, (req, res) => {
    const { content, start, end, replacement_text } = req.body;
    const updated = content.substring(0, start) + replacement_text + content.substring(end);
    res.json({ updated_content: updated });
  });

  // --- Gemini / LLM invoke ---
  app.post("/api/gemini/invoke", requireAuth, async (req: any, res) => {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ message: "Prompt is required." });
    try {
      const result = await callAI(prompt);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ==========================================
  // CENTRALIZED ERROR HANDLER
  // ==========================================
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[Error]", err.message);
    res.status(err.status || 500).json({ message: err.message || "Internal server error" });
  });

  // Health / root route so browser doesn't see "Cannot GET /"
  app.get("/", (_req, res) => res.json({ status: "ok", message: "MRI Backend API is running." }));

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Server] Running on port ${PORT}`);
  });
}

startServer();
