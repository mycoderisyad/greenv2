//quick start
// npm install @octokit/rest simple-git jsonfile moment random readline fs child_process
// export GITHUB_TOKEN="ghp_xxx..."
// export GITHUB_USERNAME="usernamekamu"
//==============================================
// Auto Add Repo (manual, random, atau list dari file .txt/.json)
// Auto Commit (pakai random date, delay strategy manual/range/auto)
// Auto PR
// Auto Issue
// Auto Star (repo sendiri)
// Multi-Star (dari banyak akun → banyak repo)
// Delay Strategy lengkap (manual, range, auto dengan minimal 900ms)
//==============================================


// ====== deps ======
import { Octokit } from "@octokit/rest";
import simpleGit from "simple-git";
import jsonfile from "jsonfile";
import moment from "moment";
import random from "random";
import readline from "readline";
import fs from "fs";
import { execSync } from "child_process";

// ====== init ======
const git = simpleGit();
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const USERNAME = process.env.GITHUB_USERNAME;

// ====== helpers ======
async function ensureToken() {
  if (!process.env.GITHUB_TOKEN) {
    throw new Error("⚠️  GITHUB_TOKEN tidak ditemukan. export GITHUB_TOKEN=ghp_xxx");
  }
}

async function getRepoInfoFromGit() {
  const remotes = await git.getRemotes(true);
  const origin = remotes.find((r) => r.name === "origin");
  if (!origin) throw new Error("Remote 'origin' tidak ditemukan.");

  const url = origin.refs.fetch || origin.refs.push;
  const httpsMatch = url.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/i);
  if (!httpsMatch) throw new Error(`Tidak bisa parse owner/repo dari: ${url}`);

  return { owner: httpsMatch[1], repo: httpsMatch[2].replace(/\.git$/i, "") };
}
// ====== Helper: fetch repos dari username ======
async function fetchReposByUsername(username, { includeForks = false, includeArchived = false, sort = "updated", limit = 0 }) {
  const client = new Octokit(); // public endpoint, tidak perlu token
  const repos = await client.paginate(client.repos.listForUser, {
    username,
    per_page: 100,
    sort,         // "updated" | "pushed" | "full_name" | "created"
    direction: "desc",
  });

  let list = repos
    .filter(r => (includeForks ? true : !r.fork))
    .filter(r => (includeArchived ? true : !r.archived))
    .map(r => `${r.owner.login}/${r.name}`);

  if (limit && limit > 0) list = list.slice(0, limit);
  return list;
}

function logStep(title) {
  console.log(`\n──────────────── ${title} ────────────────`);
}

// ====== DELAY STRATEGY ======
const SAFE_MIN_INTERVAL_MS = 900;

function parseManualOrRange(input) {
  const parts = input.split("-").map((n) => parseInt(n.trim(), 10)).filter(n => !isNaN(n));
  if (parts.length === 2) {
    const [a, b] = parts[0] <= parts[1] ? parts : [parts[1], parts[0]];
    return { minMs: a * 1000, maxMs: b * 1000 };
  }
  return { minMs: parts[0] * 1000, maxMs: parts[0] * 1000 };
}

async function getDelayStrategy(ask) {
  const mode = (await ask("Mode delay? (manual/auto) [default: manual]: ")).trim().toLowerCase() || "manual";

  if (mode === "auto") {
    const totalOps = parseInt(await ask("Total operasi: "), 10);
    const windowSec = parseInt(await ask("Jendela waktu (detik): "), 10);
    if (!totalOps || !windowSec) throw new Error("Input auto tidak valid.");

    const rawIntervalMs = Math.floor((windowSec * 1000) / totalOps);
    const intervalMs = Math.max(rawIntervalMs, SAFE_MIN_INTERVAL_MS);

    if (intervalMs > rawIntervalMs) {
      const requiredWindowSec = Math.ceil((totalOps * SAFE_MIN_INTERVAL_MS) / 1000);
      console.log(`⚠️ Target terlalu cepat. Disesuaikan ke interval ${(intervalMs/1000).toFixed(2)}s`);
      console.log(`   Window minimal aman: ${requiredWindowSec} detik (~${Math.ceil(requiredWindowSec/60)} menit)`);
    }

    return { mode: "auto", baseMs: intervalMs, jitterPct: 0.2 };
  }

  const input = await ask("Delay (detik, contoh '3' atau '1-5'): ");
  const parsed = parseManualOrRange(input);

  const minMs = Math.max(parsed.minMs, SAFE_MIN_INTERVAL_MS);
  const maxMs = Math.max(parsed.maxMs, SAFE_MIN_INTERVAL_MS);
  return { mode: "manual", minMs, maxMs };
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function applyPacedDelay(strategy) {
  if (strategy.mode === "auto") {
    const jitter = Math.floor(strategy.baseMs * strategy.jitterPct);
    const actual = randInt(strategy.baseMs - jitter, strategy.baseMs + jitter);
    console.log(`⏳ Delay ${(actual/1000).toFixed(2)}s (auto)`);
    await delay(actual);
  } else {
    const actual = randInt(strategy.minMs, strategy.maxMs);
    console.log(`⏳ Delay ${(actual/1000).toFixed(2)}s`);
    await delay(actual);
  }
}

// ====== 1) AUTO ADD REPO ======
async function createRepo(repoName) {
  try {
    const { data } = await octokit.repos.createForAuthenticatedUser({
      name: repoName,
      private: false,
      description: `Repository for ${repoName}`,
    });
    console.log(`✓ Repo created: ${data.html_url}`);
  } catch (e) {
    console.error(`x Failed create repo ${repoName}:`, e.response?.data?.message || e.message);
  }
}

async function initializeAndPushRepo(repoName) {
  try {
    const sanitized = repoName.replace(/\s+/g, "-");
    const repoPath = `./${sanitized}`;
    const remoteURL = `https://${process.env.GITHUB_TOKEN}@github.com/${USERNAME}/${sanitized}.git`;

    if (!fs.existsSync(repoPath)) {
      fs.mkdirSync(repoPath);
    }

    execSync(`git init`, { cwd: repoPath });
    fs.writeFileSync(`${repoPath}/README.md`, `# ${repoName}\n`);
    execSync(`git add .`, { cwd: repoPath });
    execSync(`git commit -m "Initial commit"`, { cwd: repoPath });
    execSync(`git branch -M main`, { cwd: repoPath });
    execSync(`git remote add origin ${remoteURL}`, { cwd: repoPath });
    execSync(`git push -u origin main`, { cwd: repoPath });

    console.log(`✓ Repo pushed: ${repoName}`);
  } catch (e) {
    console.error(`x Failed push ${repoName}:`, e.message);
  }
}

async function runAutoAddRepos() {
  const mode = (await ask("Pakai list dari file? (y/n): ")).trim().toLowerCase();
  let repoNames = [];

  if (mode === "y") {
    const filePath = (await ask("Masukkan path file (.txt / .json): ")).trim();
    if (!fs.existsSync(filePath)) {
      console.log("❌ File tidak ditemukan.");
      return;
    }
    if (filePath.endsWith(".json")) {
      repoNames = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } else {
      repoNames = fs.readFileSync(filePath, "utf-8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    }
  } else {
    const randomMode = (await ask("Pakai nama random? (y/n): ")).trim().toLowerCase();
    let baseName = "";
    if (randomMode === "y") {
      baseName = `auto-repo-${Date.now().toString(36)}`;
      console.log(`Base name random: ${baseName}`);
    } else {
      baseName = (await ask("Masukkan base name repo: ")).trim();
      if (!baseName) return console.log("❌ Base name tidak boleh kosong.");
    }
    const count = parseInt(await ask("Berapa repo yang mau dibuat: "), 10);
    repoNames = Array.from({ length: count }, (_, i) =>
      count === 1 ? baseName : `${baseName}-${i + 1}`
    );
  }

  for (const repoName of repoNames) {
    await createRepo(repoName);
    await initializeAndPushRepo(repoName);
    await delay(1000);
  }
  console.log("✓ Selesai auto add repos.");
}

// ====== 2) AUTO COMMIT ======
const DATA_PATH = "./data.json";

const getRandomDate = (startDate, endDate) => {
  const diffDays = endDate.diff(startDate, "days");
  const randomDays = random.int(0, diffDays);
  return startDate.clone().add(randomDays, "days").format("YYYY-MM-DD HH:mm:ss");
};

async function markCommit(date) {
  const data = { date };
  await jsonfile.writeFile(DATA_PATH, data);
  await git.add(DATA_PATH);
  await git.commit(`Commit on ${date}`, { "--date": date });
  console.log(`✓ Commit made for date: ${date}`);
}

async function runAutoCommits() {
  const startInput = await ask("Start commit (MM-YYYY): ");
  const endInput = await ask("End commit (MM-YYYY): ");
  const commitCount = parseInt(await ask("Number of commits: "), 10);
  const delayStrategy = await getDelayStrategy(ask);

  const startDate = moment(startInput, "MM-YYYY");
  const endDate = moment(endInput, "MM-YYYY").endOf("month");

  for (let i = 0; i < commitCount; i++) {
    const date = getRandomDate(startDate, endDate);
    await markCommit(date);
    await applyPacedDelay(delayStrategy);
  }
  await git.push("origin", "main");
  console.log("✓ All commits pushed.");
}

// ====== 3) AUTO PR ======
async function createPR({ owner, repo, headBranch, baseBranch, title, body }) {
  const pr = await octokit.pulls.create({ owner, repo, head: headBranch, base: baseBranch, title, body });
  return pr.data.html_url;
}

async function runAutoPRs() {
  const { owner, repo } = await getRepoInfoFromGit();
  const baseBranch = (await ask('Base branch (default "main"): ')) || "main";
  const prCount = parseInt(await ask("Jumlah PR: "), 10);
  const delayStrategy = await getDelayStrategy(ask);

  for (let i = 1; i <= prCount; i++) {
    logStep(`PR ${i}/${prCount}`);
    const headBranch = `feature/auto-pr-${Date.now()}-${i}`;
    fs.writeFileSync("./pr-bump.txt", `auto-pr ${i} at ${new Date().toISOString()}\n`);
    await git.checkoutLocalBranch(headBranch);
    await git.add("./pr-bump.txt");
    await git.commit(`chore: auto PR bump ${i}`);
    await git.push("origin", headBranch);

    const prUrl = await createPR({ owner, repo, headBranch, baseBranch, title: `Auto PR #${i}`, body: "Auto generated" });
    console.log(`✓ PR opened: ${prUrl}`);

    await git.checkout(baseBranch);
    await applyPacedDelay(delayStrategy);
  }
}

// ====== 4) AUTO ISSUE ======
async function runAutoIssues() {
  const { owner, repo } = await getRepoInfoFromGit();
  const n = parseInt(await ask("Jumlah issue: "), 10);
  const prefix = (await ask('Prefix judul (default "Auto Issue"): ')) || "Auto Issue";
  const delayStrategy = await getDelayStrategy(ask);

  for (let i = 1; i <= n; i++) {
    const title = `${prefix} #${i}`;
    const body = `Auto generated on ${moment().format("DD-MM-YYYY HH:mm:ss")}`;
    try {
      const issue = await octokit.issues.create({ owner, repo, title, body });
      console.log(`✓ Issue #${issue.data.number}`);
    } catch (e) {
      console.error("x Gagal issue:", e.message);
    }
    await applyPacedDelay(delayStrategy);
  }
}

// ====== 5) AUTO STAR (repo sendiri) ======
async function runAutoStarOwnRepos() {
  const me = await octokit.users.getAuthenticated();
  const username = me.data.login;
  const repos = await octokit.paginate(octokit.repos.listForAuthenticatedUser, { per_page: 100, affiliation: "owner" });

  for (const r of repos) {
    try {
      await octokit.activity.starRepoForAuthenticatedUser({ owner: r.owner.login, repo: r.name });
      console.log(`⭐ ${r.full_name}`);
      await delay(random.int(500, 1000));
    } catch (e) {
      console.error(`x Gagal star ${r.full_name}: ${e.message}`);
    }
  }
  console.log("✓ Selesai memberi star.");
}

// ====== 6) MULTI-STAR (dari banyak akun) ======
async function runMultiStar() {
  const mode = (await ask("Target repos dari (1) file repos.txt atau (2) username? [1/2]: ")).trim();

  let repos = [];
  if (mode === "2") {
    const targetUser = (await ask("Masukkan username target: ")).trim();
    const limitStr = (await ask("Batasi jumlah repo? (angka, kosong = semua): ")).trim();
    const limit = limitStr ? parseInt(limitStr, 10) : 0;
    const skipForks = ((await ask("Skip repos fork? (y/n) [y]: ")).trim().toLowerCase() || "y") === "y";
    const skipArchived = ((await ask("Skip repos archived? (y/n) [y]: ")).trim().toLowerCase() || "y") === "y";
    const sort = (await ask("Sort by (updated/pushed/full_name/created) [updated]: ")).trim() || "updated";

    repos = await fetchReposByUsername(targetUser, {
      includeForks: !skipForks,
      includeArchived: !skipArchived,
      sort,
      limit,
    });

    if (repos.length === 0) {
      console.log("❌ Tidak ada repo yang ditemukan (mungkin semua terfilter).");
      return;
    }
    console.log(`✓ Target repos (${repos.length}):`);
    console.log(repos.slice(0, 10).join(", ") + (repos.length > 10 ? " ..." : ""));
  } else {
    const reposFile = (await ask("Masukkan path repos.txt: ")).trim();
    if (!fs.existsSync(reposFile)) return console.log("❌ File repos.txt tidak ditemukan.");
    repos = fs.readFileSync(reposFile, "utf-8").split("\n").map(l => l.trim()).filter(Boolean);
  }

  const tokensFile = (await ask("Masukkan path tokens.json: ")).trim();
  if (!fs.existsSync(tokensFile)) return console.log("❌ File tokens.json tidak ditemukan.");
  const accounts = JSON.parse(fs.readFileSync(tokensFile, "utf-8"));

  // Delay strategy
  console.log("Atur pacing untuk ANTAR REPO (per akun):");
  const perRepoStrategy = await getDelayStrategy(ask);
  console.log("Atur pacing untuk ANTAR AKUN:");
  const perAccountStrategy = await getDelayStrategy(ask);

  for (const acc of accounts) {
    const client = new Octokit({ auth: acc.token });
    console.log(`\n-- Account: ${acc.username}`);
    for (const full of repos) {
      const [owner, name] = full.split("/");
      try {
        await client.activity.starRepoForAuthenticatedUser({ owner, repo: name });
        console.log(`⭐ ${acc.username} → ${owner}/${name}`);
      } catch (e) {
        console.error(`x ${acc.username} gagal star ${full}: ${e.message}`);
      }
      await applyPacedDelay(perRepoStrategy);
    }
    await applyPacedDelay(perAccountStrategy);
  }

  console.log("✓ Multi-star selesai.");
}

// ====== MENU ======
async function main() {
  logStep("Menu");
  console.log("1) Auto Add Repo");
  console.log("2) Auto Commit");
  console.log("3) Auto PR");
  console.log("4) Auto Issue");
  console.log("5) Auto Star (repo sendiri)");
  console.log("6) Multi-Star (dari banyak akun)");
  console.log("0) Keluar");

  const choice = (await ask("Pilih operasi: ")).trim();
  if (choice === "1") await runAutoAddRepos();
  else if (choice === "2") await runAutoCommits();
  else if (choice === "3") await runAutoPRs();
  else if (choice === "4") await runAutoIssues();
  else if (choice === "5") await runAutoStarOwnRepos();
  else if (choice === "6") await runMultiStar();
  else console.log("Bye 👋");

  rl.close();
}

main();