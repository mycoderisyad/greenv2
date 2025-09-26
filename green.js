// ====== deps ======
import { Octokit } from "@octokit/rest";
import simpleGit from "simple-git";
import jsonfile from "jsonfile";
import moment from "moment";
import random from "random";
import readline from "readline";
import fs from "fs";

// ====== init ======
const git = simpleGit();
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// ====== helpers ======
async function ensureToken() {
  if (!process.env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN tidak ditemukan. export GITHUB_TOKEN terlebih dahulu.");
  }
}

async function getRepoInfoFromGit() {
  const remotes = await git.getRemotes(true);
  const origin = remotes.find((r) => r.name === "origin");
  if (!origin) throw new Error("Remote 'origin' tidak ditemukan.");

  const url = origin.refs.fetch || origin.refs.push;
  const httpsMatch = url.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/i);
  if (!httpsMatch) throw new Error(`Tidak bisa parse owner/repo dari: ${url}`);

  const owner = httpsMatch[1];
  const repo = httpsMatch[2].replace(/\.git$/i, "");
  return { owner, repo };
}

function logStep(title) {
  console.log(`\n──────────────── ${title} ────────────────`);
}

// ==== DELAY STRATEGY ====
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

// ====== 1) AUTO COMMIT ======
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
  const startInput = await ask("Start commit (format: MM-YYYY): ");
  const endInput = await ask("End commit (format: MM-YYYY): ");
  const commitCount = parseInt(await ask("Number of commits: "), 10);
  const delayStrategy = await getDelayStrategy(ask);

  const now = moment();
  const startDate = moment(startInput, "MM-YYYY");
  let endDate = moment(endInput, "MM-YYYY").endOf("month");

  if (!startDate.isValid() || !endDate.isValid() || startDate.isAfter(endDate)) {
    throw new Error("Range tanggal tidak valid.");
  }
  if (endDate.isAfter(now)) {
    endDate = now;
    console.log(`End date disesuaikan ke hari ini: ${endDate.format("DD-MM-YYYY")}`);
  }

  for (let i = 0; i < commitCount; i++) {
    const date = getRandomDate(startDate, endDate);
    await markCommit(date);
    await applyPacedDelay(delayStrategy);
  }

  await git.push("origin", "main");
  console.log("✓ All commits pushed.");
}

// ====== 2) AUTO PR ======
async function createPR({ owner, repo, headBranch, baseBranch, title, body }) {
  const pr = await octokit.pulls.create({ owner, repo, head: headBranch, base: baseBranch, title, body });
  return pr.data.html_url;
}

async function runAutoPRs() {
  await ensureToken();
  const { owner, repo } = await getRepoInfoFromGit();

  const baseBranch = (await ask('Base branch (default "main"): ')) || "main";
  const prCount = parseInt(await ask("Jumlah PR yang ingin dibuat: "), 10);
  const delayStrategy = await getDelayStrategy(ask);

  for (let i = 1; i <= prCount; i++) {
    logStep(`PR ${i}/${prCount}`);
    const headBranch = `feature/auto-pr-${Date.now()}-${i}`;

    await git.fetch("origin", baseBranch);
    await git.checkout(baseBranch);
    await git.pull("origin", baseBranch);

    const bumpFile = "./pr-bump.txt";
    const content = `auto-pr ${i} at ${new Date().toISOString()}\n`;
    fs.writeFileSync(bumpFile, content);

    await git.checkoutLocalBranch(headBranch);
    await git.add(bumpFile);
    await git.commit(`chore: auto PR bump ${i}`);
    await git.push("origin", headBranch);

    const prUrl = await createPR({
      owner,
      repo,
      headBranch,
      baseBranch,
      title: `Auto PR #${i}`,
      body: `This PR was automatically created at ${new Date().toISOString()}.`,
    });

    console.log(`✓ PR opened: ${prUrl}`);
    await git.checkout(baseBranch);
    await applyPacedDelay(delayStrategy);
  }
  console.log("✓ Selesai membuat PR.");
}

// ====== 3) AUTO ISSUE ======
async function runAutoIssues() {
  await ensureToken();
  const { owner, repo } = await getRepoInfoFromGit();
  const n = parseInt(await ask("Jumlah issue: "), 10);
  const prefix = (await ask('Prefix judul (default "Auto Issue"): ')) || "Auto Issue";
  const delayStrategy = await getDelayStrategy(ask);

  for (let i = 1; i <= n; i++) {
    const title = `${prefix} #${i}`;
    const body = `Auto generated on ${moment().format("DD-MM-YYYY HH:mm:ss")}`;
    try {
      const issue = await octokit.issues.create({ owner, repo, title, body });
      console.log(`✓ Issue #${issue.data.number} → ${issue.data.html_url}`);
    } catch (e) {
      console.error("x Gagal membuat issue:", e.message);
    }
    await applyPacedDelay(delayStrategy);
  }
  console.log("✓ Selesai membuat issues.");
}

// ====== 4) AUTO STAR ======
async function runAutoStarOwnRepos() {
  await ensureToken();

  const me = await octokit.users.getAuthenticated();
  const username = me.data.login;

  console.log(`Akan meng-star semua repo milik: ${username}`);
  const repos = await octokit.paginate(octokit.repos.listForAuthenticatedUser, {
    per_page: 100,
    visibility: "all",
    affiliation: "owner",
  });

  for (const r of repos) {
    try {
      await octokit.activity.starRepoForAuthenticatedUser({ owner: r.owner.login, repo: r.name });
      console.log(`⭐  ${r.full_name}`);
      await delay(random.int(250, 900));
    } catch (e) {
      console.error(`x Gagal star ${r.full_name}: ${e.message}`);
    }
  }
  console.log("✓ Selesai memberi star pada semua repo sendiri.");
}

// ====== MENU ======
async function main() {
  try {
    logStep("Menu");
    console.log("1) Auto Commit");
    console.log("2) Auto PR");
    console.log("3) Auto Issue");
    console.log("4) Auto Star (semua repo sendiri)");
    console.log("0) Keluar");

    const choice = (await ask("Pilih operasi: ")).trim();

    if (choice === "1") await runAutoCommits();
    else if (choice === "2") await runAutoPRs();
    else if (choice === "3") await runAutoIssues();
    else if (choice === "4") await runAutoStarOwnRepos();
    else console.log("Bye 👋");

  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    rl.close();
  }
}

main();
