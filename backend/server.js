const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: true,
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Health check / landing route for deployment platforms
// (prevents "Cannot GET /" when opening the service root)
app.get("/", (_req, res) => {
  res.status(200).send("AI Resume Analyzer API is running");
});

const upload = multer({ dest: "uploads/" });

const USERS_FILE = path.join(__dirname, "data", "users.json");
const JWT_SECRET = process.env.JWT_SECRET || "dev_only_change_me";

const readUsers = () => {
  try {
    const raw = fs.readFileSync(USERS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
};

const writeUsers = (users) => {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
};

const signToken = (user) => {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, {
    expiresIn: "7d",
  });
};

const requireAuth = (req, res, next) => {
  const auth = req.headers.authorization || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const token = m?.[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch (_) {
    return res.status(401).json({ error: "Unauthorized" });
  }
};

const extractPdfTextStable = async (buffer) => {
  const data = await pdfParse(buffer, {
    pagerender: async (pageData) => {
      const textContent = await pageData.getTextContent({
        normalizeWhitespace: true,
        disableCombineTextItems: false,
      });

      const items = (textContent.items || [])
        .map((it) => {
          const tr = it.transform || [];
          const x = typeof tr[4] === "number" ? tr[4] : 0;
          const y = typeof tr[5] === "number" ? tr[5] : 0;
          return { str: it.str || "", x, y };
        })
        .filter((it) => it.str.trim().length > 0);

      // Sort top-to-bottom, then left-to-right (PDF coordinate space).
      items.sort((a, b) => {
        if (b.y !== a.y) return b.y - a.y;
        return a.x - b.x;
      });

      // Group into lines with a small y tolerance.
      const lines = [];
      const yTol = 2.0;
      for (const it of items) {
        const last = lines[lines.length - 1];
        if (!last || Math.abs(last.y - it.y) > yTol) {
          lines.push({ y: it.y, parts: [it.str] });
        } else {
          last.parts.push(it.str);
        }
      }

      return lines.map((l) => l.parts.join(" ")).join("\n");
    },
  });

  return data.text || "";
};

const extractDocxText = async (buffer) => {
  const result = await mammoth.extractRawText({ buffer });
  return String(result?.value || "");
};

const getExt = (file) => {
  const original = String(file?.originalname || "");
  const ext = path.extname(original).toLowerCase();
  return ext;
};

const extractResumeText = async ({ filePath, file }) => {
  const buffer = fs.readFileSync(filePath);
  const ext = getExt(file);
  const mime = String(file?.mimetype || "").toLowerCase();

  if (ext === ".pdf" || mime === "application/pdf") {
    return await extractPdfTextStable(buffer);
  }
  if (
    ext === ".docx" ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return await extractDocxText(buffer);
  }

  // .doc is not reliably supported without heavier tooling; guide user to save as .docx.
  if (ext === ".doc" || mime === "application/msword") {
    const err = new Error("DOC format not supported. Please upload DOCX or PDF.");
    err.statusCode = 415;
    throw err;
  }

  const err = new Error("Unsupported file type. Please upload PDF or DOCX.");
  err.statusCode = 415;
  throw err;
};

/* 🔥 STEP 1: CLEAN TEXT (VERY IMPORTANT) */
const cleanText = (text) => {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")        // remove extra spaces/newlines
    .replace(/[^a-z0-9 ]/g, "")  // remove symbols
    .trim();
};

/* 🔥 STEP 2: STABLE SCORE */
const generateScore = (text) => {
  const cleaned = cleanText(text);
  // Make score robust to small extraction order differences:
  // treat the resume as a bag-of-words (sorted tokens).
  const stable = cleaned.split(" ").filter(Boolean).sort().join(" ");

  let hash = 0;
  for (let i = 0; i < stable.length; i++) {
    hash = stable.charCodeAt(i) + ((hash << 5) - hash);
  }

  return Math.abs(hash % 100);
};

const buildImprovementTips = (rawText) => {
  const text = String(rawText || "");
  const lower = text.toLowerCase();

  const tips = [];
  const strengths = [];

  const hasEmail = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text);
  const hasPhone =
    /(\+?\d{1,3}[\s-]?)?(\(?\d{3}\)?[\s-]?)\d{3}[\s-]?\d{4}/.test(text) ||
    /\b\d{10}\b/.test(text);
  const hasLinkedIn = /linkedin\.com\/in\//i.test(text);
  const hasGitHub = /github\.com\//i.test(text);
  const hasPortfolio = /\b(portfolio|website)\b/i.test(text);

  const hasSkills = /\bskills?\b/i.test(text);
  const hasProjects = /\bprojects?\b/i.test(text);
  const hasExperience =
    /\b(experience|work experience|internship|employment)\b/i.test(text);
  const hasEducation = /\beducation\b/i.test(text);
  const hasCerts = /\b(certification|certifications|certified)\b/i.test(text);
  const hasSummary =
    /\b(summary|objective|profile)\b/i.test(text);

  const bullets = (text.match(/[•\u2022]/g) || []).length;
  const hasMetrics =
    /\b\d+%|\b\d+\s*(years?|yrs?)\b|\b\d+\s*(months?)\b|\b\d+\s*(users?|customers?|students?)\b/i.test(
      text
    );

  // Contact & links
  if (!hasEmail) tips.push("Add a professional email address in the header.");
  else strengths.push("Email present in header.");

  if (!hasPhone) tips.push("Add a phone number for recruiters to contact you.");
  else strengths.push("Phone number present.");

  if (!hasLinkedIn) tips.push("Add your LinkedIn profile link.");
  else strengths.push("LinkedIn link included.");

  if (!hasGitHub) tips.push("Add your GitHub link (especially for tech roles).");
  else strengths.push("GitHub link included.");

  if (!hasPortfolio) tips.push("If you have one, add a portfolio/website link.");

  // Sections
  if (!hasSummary) tips.push("Add a 2–3 line summary tailored to the role.");
  else strengths.push("Has a summary/profile section.");

  if (!hasSkills) tips.push("Add a dedicated Skills section with relevant keywords.");
  else strengths.push("Has a Skills section.");

  if (!hasProjects)
    tips.push("Add a Projects section with 2–4 impactful projects (stack + outcome).");
  else strengths.push("Has a Projects section.");

  if (!hasExperience)
    tips.push("Add Experience/Internship details (role, company, dates, bullets).");
  else strengths.push("Has an Experience/Internship section.");

  if (!hasEducation) tips.push("Add an Education section (degree, college, year, CGPA).");
  else strengths.push("Has an Education section.");

  if (!hasCerts) tips.push("Add Certifications (if any) that match the job.");

  // Quality signals
  if (bullets < 3)
    tips.push("Use bullet points for responsibilities and achievements (easier to scan).");
  else strengths.push("Uses bullet points (scanner-friendly).");

  if (!hasMetrics)
    tips.push("Add numbers/impact (e.g., “improved X by 25%”, “built for 500+ users”).");
  else strengths.push("Includes measurable impact/metrics.");

  // Keep the output concise and stable
  const uniq = (arr) => Array.from(new Set(arr));
  return {
    strengths: uniq(strengths).slice(0, 6),
    improvements: uniq(tips).slice(0, 10),
  };
};

app.post("/auth/signup", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    const users = readUsers();
    if (users.some((u) => u.email === email)) {
      return res.status(409).json({ error: "Email already registered" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = { id: `u_${Date.now()}_${Math.random().toString(16).slice(2)}`, email, passwordHash };
    users.push(user);
    writeUsers(users);

    const token = signToken(user);
    return res.json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ error: "Signup failed" });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const users = readUsers();
    const user = users.find((u) => u.email === email);
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const token = signToken(user);
    return res.json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ error: "Login failed" });
  }
});

app.get("/auth/me", requireAuth, async (req, res) => {
  return res.json({ user: { id: req.user.sub, email: req.user.email } });
});

app.post("/analyze", requireAuth, upload.single("resume"), async (req, res) => {
  const filePath = req?.file?.path;
  try {
    if (!filePath) {
      return res.status(400).json({ error: "No resume uploaded" });
    }

    const text = await extractResumeText({ filePath, file: req.file });

    /* 🔥 DEBUG (optional but useful) */
    console.log("RAW TEXT LENGTH:", text.length);

    const score = generateScore(text);
    const tips = buildImprovementTips(text);

    res.json({
      score,
      feedback:
        score > 70
          ? "Strong resume 💪"
          : score > 40
          ? "Good but can improve 👍"
          : "Needs improvement 🚀",
      strengths: tips.strengths,
      improvements: tips.improvements,
    });

  } catch (err) {
    console.log(err);
    const code = err?.statusCode || 500;
    res.status(code).json({ error: err?.message || "Failed to analyze" });
  } finally {
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (_) {
        // ignore cleanup errors
      }
    }
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
